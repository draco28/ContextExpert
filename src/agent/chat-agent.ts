/**
 * Chat Agent
 *
 * ReAct-based conversational agent for the CLI chat experience.
 * Wraps @contextaisdk/core's ReActLoop with ConversationContext
 * to provide:
 *
 * 1. Token-by-token streaming via thought_delta events
 * 2. Autonomous tool use (agent decides when to search)
 * 3. Multi-turn conversation memory with truncation
 * 4. Dynamic tool reconfiguration (for /focus project switch)
 *
 * ARCHITECTURE:
 * ```
 * ChatAgent
 *   ├── ReActLoop (from SDK) — think → act → observe cycle
 *   ├── ConversationContext (from SDK) — sliding window memory
 *   └── Tools (retrieve_knowledge) — RAG as an agent tool
 *
 * streamQuestion(input)
 *   ├── Add user message to context
 *   ├── Build messages: [system, ...history, ?fileCtx]
 *   ├── ReActLoop.executeStream(messages)
 *   │   ├── thought_delta → yield thinking_delta (token-by-token)
 *   │   ├── thought       → yield thinking_complete
 *   │   ├── action        → yield tool_start
 *   │   ├── observation   → yield tool_result + collect sources
 *   │   ├── done          → yield response_complete
 *   │   └── error         → rollback + yield error
 *   └── Add assistant response to context
 * ```
 *
 * WHY ReActLoop DIRECTLY (not Agent.stream()):
 * Agent.stream() only yields complete thoughts (no thought_delta).
 * The final answer arrives all at once via { type: 'text', content }.
 * ReActLoop.executeStream() yields thought_delta per token — essential
 * for the Claude Code-like streaming experience.
 */

import {
  ReActLoop,
  ConversationContext,
  type ChatMessage,
  type LLMProvider,
  type ReActTrace,
  type Tool,
} from '@contextaisdk/core';
import type { RoutingRAGEngine } from './routing-rag-engine.js';
import type { ProjectMetadata } from './query-router.js';
import type { RAGSource } from './types.js';
import type { Project } from '../database/schema.js';
import { createRetrieveKnowledgeTool, type RetrieveKnowledgeOutput } from './tools/index.js';
import type { Tracer, TraceHandle, SpanHandle } from '../observability/types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for creating a ChatAgent.
 */
export interface ChatAgentConfig {
  /** Full LLMProvider instance (must implement both chat() and streamChat()) */
  llmProvider: LLMProvider;

  /** Routing RAG engine for knowledge retrieval (null if no projects indexed) */
  routingEngine?: RoutingRAGEngine | null;

  /** All indexed projects (for routing engine) */
  allProjects: ProjectMetadata[];

  /** Currently focused project (null = unfocused mode) */
  currentProject: Project | null;

  /** Maximum tokens in conversation context. Default: 8000 */
  maxContextTokens?: number;

  /** Maximum ReAct iterations per question. Default: 5 */
  maxIterations?: number;

  /** Tracer for observability (NoopTracer if not configured). Creates per-turn traces. */
  tracer?: Tracer;
}

/**
 * Events yielded by ChatAgent.streamQuestion().
 *
 * Designed for UI consumption — each event type maps to a specific
 * display action in both REPL and TUI modes.
 *
 * Also carries enough data for future observability (Langfuse tracing).
 */
export type ChatAgentEvent =
  | {
      /** Token-by-token streaming of agent's reasoning or answer */
      type: 'thinking_delta';
      content: string;
      iteration: number;
    }
  | {
      /** Complete thought after streaming finishes for an iteration */
      type: 'thinking_complete';
      content: string;
      iteration: number;
    }
  | {
      /** Agent decided to call a tool */
      type: 'tool_start';
      tool: string;
      input: Record<string, unknown>;
      iteration: number;
    }
  | {
      /** Tool execution completed */
      type: 'tool_result';
      tool: string;
      result: unknown;
      success: boolean;
      durationMs: number;
      iteration: number;
    }
  | {
      /** Final response complete with trace and sources */
      type: 'response_complete';
      content: string;
      trace: ReActTrace;
      sources: RAGSource[];
    }
  | {
      /** Error during agent execution */
      type: 'error';
      message: string;
      code?: string;
    };

/**
 * Options for streamQuestion().
 */
export interface StreamQuestionOptions {
  /** Additional context from @file references, injected as a system message */
  fileReferenceContext?: string;

  /** Abort signal for cancellation (e.g., Ctrl+C) */
  signal?: AbortSignal;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_CONTEXT_TOKENS = 8000;
const DEFAULT_MAX_ITERATIONS = 5;

/**
 * System prompt that teaches the agent when and how to use tools.
 *
 * Key design decisions:
 * - Agent decides when to search (not forced)
 * - Explicit guidance on when NOT to search (saves tokens + latency)
 * - Citation instructions for grounding responses
 */
const SYSTEM_PROMPT = `You are an expert code assistant with access to a knowledge base of indexed codebases.

## Available Tool: retrieve_knowledge
Search indexed codebases for relevant code, documentation, and configuration.

## When to Search
- Questions about how specific code works, architecture, or implementation
- Questions about specific files, functions, classes, or APIs
- Debugging or troubleshooting questions about the codebase
- Looking for code examples or patterns in the project

## When NOT to Search
- Simple greetings, thanks, or conversational responses
- General programming concepts you already know well
- Follow-up questions where you already have sufficient context from previous searches
- Opinions, recommendations, or explanations not tied to specific code

## Response Guidelines
- Be concise but thorough
- When citing retrieved code, reference sources using [1], [2], etc.
- Use code blocks with appropriate language tags
- If search returns no relevant results, say so honestly and suggest alternatives`;

// ============================================================================
// ChatAgent Class
// ============================================================================

/**
 * ReAct-based chat agent for the CLI.
 *
 * Manages the conversation loop, tool execution, and streaming output.
 * Use streamQuestion() for real-time token-by-token streaming.
 */
export class ChatAgent {
  private reactLoop: ReActLoop;
  private conversationContext: ConversationContext;
  private readonly systemPrompt: string;
  private readonly maxIterations: number;
  private readonly tracer?: Tracer;

  // Mutable state for dynamic reconfiguration via /focus
  private routingEngine: RoutingRAGEngine | null | undefined;
  private allProjects: ProjectMetadata[];
  private currentProject: Project | null;

  // Collected sources from tool results during a question
  private pendingSources: RAGSource[] = [];

  // Per-question trace state (set in streamQuestion, used by event handlers)
  private currentTrace?: TraceHandle;
  private activeToolSpan?: SpanHandle;

  constructor(config: ChatAgentConfig) {
    this.routingEngine = config.routingEngine;
    this.allProjects = config.allProjects;
    this.currentProject = config.currentProject;
    this.systemPrompt = SYSTEM_PROMPT;
    this.maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.tracer = config.tracer;

    // Create conversation context with sliding window
    this.conversationContext = new ConversationContext({
      maxTokens: config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
    });

    // Build tools using getter closures for dynamic state
    const tools = this.buildTools();

    // Create ReActLoop directly for token-by-token streaming
    this.reactLoop = new ReActLoop(
      config.llmProvider,
      tools,
      this.maxIterations
    );
  }

  /**
   * Stream a response to a user question.
   *
   * Yields ChatAgentEvent as they occur — token by token for text,
   * with tool start/result events for RAG searches.
   *
   * The caller (REPL or TUI renderer) decides how to display each event.
   */
  async *streamQuestion(
    question: string,
    options: StreamQuestionOptions = {}
  ): AsyncGenerator<ChatAgentEvent, void, unknown> {
    // Reset per-question state
    this.pendingSources = [];
    this.activeToolSpan = undefined;

    // Create per-question trace (no-op if tracer not provided)
    this.currentTrace = this.tracer?.trace({
      name: 'ctx-chat-turn',
      input: question,
      metadata: {
        project: this.currentProject?.name ?? 'unfocused',
        maxIterations: this.maxIterations,
      },
    });

    // Add user message to conversation context
    const userMessage: ChatMessage = { role: 'user', content: question };
    this.conversationContext.addMessage(userMessage);

    // Build messages: system + history + optional file context
    const messages = this.buildMessages(options.fileReferenceContext);

    try {
      let finalOutput = '';
      // Track the last complete thought — used for graceful degradation
      // when max iterations are exceeded (we return the last thinking as the response)
      let lastThoughtContent = '';

      for await (const event of this.reactLoop.executeStream(messages, {
        signal: options.signal,
      })) {
        switch (event.type) {
          // Token-by-token text from LLM (reasoning or final answer)
          case 'thought_delta':
            yield {
              type: 'thinking_delta',
              content: event.content,
              iteration: event.iteration,
            };
            break;

          // Complete thought for an iteration
          case 'thought':
            lastThoughtContent = event.content;
            yield {
              type: 'thinking_complete',
              content: event.content,
              iteration: event.iteration,
            };
            break;

          // Agent decided to call a tool — start a span
          case 'action':
            this.activeToolSpan = this.currentTrace?.span({
              name: `tool:${event.tool}`,
              input: event.input,
              metadata: { iteration: event.iteration },
            });
            yield {
              type: 'tool_start',
              tool: event.tool,
              input: event.input as Record<string, unknown>,
              iteration: event.iteration,
            };
            break;

          // Tool execution completed — end span, collect sources
          case 'observation':
            this.activeToolSpan?.update({
              output: event.result,
              metadata: { success: event.success, durationMs: event.durationMs },
            });
            this.activeToolSpan?.end();
            this.activeToolSpan = undefined;

            this.collectSources(event);
            yield {
              type: 'tool_result',
              tool: event.tool,
              result: event.result,
              success: event.success,
              durationMs: event.durationMs,
              iteration: event.iteration,
            };
            break;

          // toolCall event — we don't need this for UI (action already covers it)
          case 'toolCall':
            break;

          // Final answer — end trace, update conversation context
          case 'done':
            finalOutput = event.output;

            // End trace with final output and ReAct metadata
            this.currentTrace?.update({
              output: finalOutput,
              metadata: {
                iterations: event.trace.iterations,
                totalTokens: event.trace.totalTokens,
                durationMs: event.trace.durationMs,
                sourceCount: this.pendingSources.length,
              },
            });
            this.currentTrace?.end();
            this.currentTrace = undefined;

            // Add assistant response to conversation
            this.conversationContext.addMessage({
              role: 'assistant',
              content: finalOutput,
            });

            // Truncate if over token limit
            await this.conversationContext.truncate();

            yield {
              type: 'response_complete',
              content: finalOutput,
              trace: event.trace,
              sources: [...this.pendingSources],
            };
            break;

          // Error during execution
          case 'error':
            // End any in-flight tool span
            this.activeToolSpan?.end();
            this.activeToolSpan = undefined;

            if (event.code === 'MAX_ITERATIONS' && lastThoughtContent) {
              // Graceful degradation: the agent exhausted iterations but has
              // accumulated thinking. Use the last thought as the response
              // rather than showing an error — the text was already streamed.
              this.currentTrace?.update({
                output: lastThoughtContent,
                metadata: { maxIterationsExceeded: true },
              });
              this.currentTrace?.end();
              this.currentTrace = undefined;

              this.conversationContext.addMessage({
                role: 'assistant',
                content: lastThoughtContent,
              });
              await this.conversationContext.truncate();

              yield {
                type: 'response_complete',
                content: lastThoughtContent,
                trace: { steps: [], iterations: 0, totalTokens: 0, durationMs: 0 },
                sources: [...this.pendingSources],
              };
            } else {
              // Other errors: end trace with error metadata, rollback
              this.currentTrace?.update({
                metadata: { error: event.error, errorCode: event.code },
              });
              this.currentTrace?.end();
              this.currentTrace = undefined;

              this.rollbackUserMessage();

              yield {
                type: 'error',
                message: event.error,
                code: event.code,
              };
            }
            break;
        }
      }
    } catch (error) {
      // End trace on unexpected errors
      this.activeToolSpan?.end();
      this.currentTrace?.update({
        metadata: { error: error instanceof Error ? error.message : String(error) },
      });
      this.currentTrace?.end();
      this.currentTrace = undefined;

      // Rollback on unexpected errors
      this.rollbackUserMessage();

      yield {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Reconfigure agent when user runs /focus to switch projects.
   *
   * Updates the mutable state that tool getter closures read from.
   * The ReActLoop doesn't need to be recreated because the tools
   * use getter functions that read from these fields.
   */
  updateProject(
    project: Project | null,
    allProjects: ProjectMetadata[],
    routingEngine?: RoutingRAGEngine | null
  ): void {
    this.currentProject = project;
    this.allProjects = allProjects;
    this.routingEngine = routingEngine;
  }

  /**
   * Clear conversation history (/clear command).
   */
  clearHistory(): void {
    this.conversationContext.clear();
  }

  /**
   * Get the conversation context for inspection (token counting, etc.).
   */
  getContext(): ConversationContext {
    return this.conversationContext;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Build tools with getter closures for dynamic state access.
   */
  private buildTools(): Tool[] {
    const tools: Tool[] = [];

    // Always register retrieve_knowledge — the execute function
    // checks at runtime if a routing engine is available
    tools.push(
      createRetrieveKnowledgeTool(
        () => this.routingEngine,
        () => this.allProjects,
        () => this.currentProject?.id
      )
    );

    return tools;
  }

  /**
   * Build the message array for the ReActLoop.
   *
   * Structure: [system, ...conversationHistory, ?fileContext]
   */
  private buildMessages(fileReferenceContext?: string): ChatMessage[] {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt },
    ];

    // Add conversation history (excluding any system messages in context)
    for (const msg of this.conversationContext.getMessages()) {
      if (msg.role !== 'system') {
        messages.push(msg);
      }
    }

    // Inject @file reference context as additional system message
    // This goes after history so it's "close" to the current question
    if (fileReferenceContext) {
      messages.push({
        role: 'system',
        content: `## File References\nThe user referenced these files:\n\n${fileReferenceContext}`,
      });
    }

    return messages;
  }

  /**
   * Extract RAG sources from tool observation results.
   *
   * When the retrieve_knowledge tool succeeds, its result data
   * contains sources that we collect for citation display.
   */
  private collectSources(event: {
    tool: string;
    result: unknown;
    success: boolean;
  }): void {
    if (
      event.tool === 'retrieve_knowledge' &&
      event.success &&
      event.result &&
      typeof event.result === 'object'
    ) {
      // ReActLoop.executeTool() unwraps ToolResult.data, so event.result
      // IS the RetrieveKnowledgeOutput directly (no .data wrapper)
      const data = event.result as RetrieveKnowledgeOutput;
      if (data.sources) {
        this.pendingSources.push(...data.sources);
      }
    }
  }

  /**
   * Remove the last user message from conversation context on error.
   *
   * Prevents partial state from persisting — if the agent fails,
   * the user's question shouldn't be in the history as if it was
   * answered successfully.
   */
  private rollbackUserMessage(): void {
    const messages = this.conversationContext.getMessages();
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && lastMessage.role === 'user') {
      this.conversationContext.clear();
      this.conversationContext.addMessages(messages.slice(0, -1));
    }
  }
}
