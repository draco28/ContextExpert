/**
 * Agent Event Renderers
 *
 * Adapters that consume ChatAgentEvent streams and render them
 * for different display modes (REPL and TUI).
 *
 * ARCHITECTURE:
 * ```
 * ChatAgent.streamQuestion()
 *     │
 *     ├── renderAgentEventsREPL()    → process.stdout (chalk-styled)
 *     │
 *     └── adaptAgentEventsForTUI()   → TUI StreamChunk + setActivity()
 * ```
 *
 * DISPLAY LOGIC:
 * - Intermediate iterations (agent thinks then calls a tool):
 *   thinking_delta → dimmed text (reasoning visible but subtle)
 * - Final iteration (agent produces the answer):
 *   thinking_delta → normal text (this IS the response)
 * - Detection: We stream thinking_delta immediately. If tool_start follows,
 *   it was reasoning. If response_complete follows, it was the answer.
 *   Since we can't know in advance, we use a "pending style" approach:
 *   start a new line dimmed, switch to normal when we detect final iteration.
 *
 * DATA SHAPE NOTE:
 * ReActLoop.executeTool() unwraps ToolResult.data before storing in
 * observation.result, so event.result IS the RetrieveKnowledgeOutput
 * directly — { sourceCount, sources, ... } — not { data: { ... } }.
 */

import chalk from 'chalk';
import type { ChatAgentEvent } from '../../agent/chat-agent.js';
import type { RAGSource } from '../../agent/types.js';
import type { RetrieveKnowledgeOutput } from '../../agent/tools/index.js';
import { formatCitations } from '../../agent/citations.js';
import type { CommandContext } from '../types.js';
import {
  type TUIController,
  AgentPhase,
  type StreamChunk as TUIStreamChunk,
} from '../tui/index.js';

// ============================================================================
// REPL Renderer
// ============================================================================

/**
 * Result from rendering agent events in REPL mode.
 */
export interface REPLRenderResult {
  /** The complete response content */
  content: string;
  /** Sources collected from RAG tool calls */
  sources: RAGSource[];
  /** Langfuse trace ID for cross-referencing with local SQLite traces */
  langfuseTraceId?: string;
}

/**
 * Render ChatAgentEvents to the classic REPL (process.stdout).
 *
 * Handles the full event lifecycle:
 * - thinking_delta: Streamed to stdout (dimmed for reasoning, normal for final answer)
 * - tool_start: Shows "Searching..." indicator
 * - tool_result: Shows "Found N sources (Xms)"
 * - response_complete: Shows citations
 * - error: Shows error via ctx.error()
 *
 * @param events - Async generator of ChatAgentEvents
 * @param ctx - Command context for logging
 * @returns The complete response content and collected sources
 */
export async function renderAgentEventsREPL(
  events: AsyncGenerator<ChatAgentEvent, void, unknown>,
  ctx: CommandContext
): Promise<REPLRenderResult> {
  const chunks: string[] = [];
  let sources: RAGSource[] = [];
  let langfuseTraceId: string | undefined;
  let lastIteration = 0;
  let hasToolCalls = false;
  let isInThinkingPhase = false;

  for await (const event of events) {
    switch (event.type) {
      case 'thinking_delta': {
        // Track iteration changes to detect reasoning vs final answer
        if (event.iteration > lastIteration) {
          // New iteration starting
          if (isInThinkingPhase) {
            // Previous iteration's thinking ended (no explicit newline needed
            // since tool_start handles the transition)
          }
          lastIteration = event.iteration;
          hasToolCalls = false;
          isInThinkingPhase = true;
        }

        // Always stream the content — dimmed for intermediate, normal for final
        // We'll know it's "intermediate" retroactively when tool_start follows
        // For now, write it. The visual difference is handled by context:
        // If this is iteration > 1 (meaning tools were used before), show dimmed
        // Otherwise show normal
        if (event.iteration > 1 && !hasToolCalls) {
          // This could be reasoning before another tool call, or the final answer
          // after tool results. We stream as normal text — the agent's final
          // response after searching IS the answer.
          process.stdout.write(event.content);
          chunks.push(event.content);
        } else if (hasToolCalls) {
          // We already had tool calls this iteration — this shouldn't happen
          // in normal ReAct flow, but handle gracefully
          process.stdout.write(event.content);
          chunks.push(event.content);
        } else {
          // First iteration, no tool calls yet
          // Could be reasoning (if tools follow) or direct answer (if done follows)
          // Stream as normal — if tools follow, the reasoning is still informative
          process.stdout.write(event.content);
          chunks.push(event.content);
        }
        break;
      }

      case 'thinking_complete':
        // The complete thought — no additional display needed since
        // thinking_delta already streamed every token
        isInThinkingPhase = false;
        break;

      case 'tool_start': {
        hasToolCalls = true;
        isInThinkingPhase = false;

        // Clear the line and show tool activity
        const query = typeof event.input?.query === 'string'
          ? event.input.query.slice(0, 60)
          : 'codebase';
        process.stdout.write('\n' + chalk.cyan(`Searching: "${query}"...`));
        break;
      }

      case 'tool_result': {
        // ReActLoop unwraps ToolResult.data, so event.result is the
        // RetrieveKnowledgeOutput directly (no .data wrapper)
        const resultData = event.result as RetrieveKnowledgeOutput | undefined;
        const sourceCount = resultData?.sourceCount ?? 0;
        const timeMs = Math.round(event.durationMs);

        // Build display string with optional classification tag
        const classTag = resultData?.classification
          ? chalk.dim(` [${resultData.classification.type}]`)
          : '';

        // \x1b[2K clears the entire current line, then \r moves to column 0
        // This prevents remnants of the longer "Searching: ..." text leaking through
        if (resultData?.classification?.skippedRetrieval) {
          process.stdout.write(
            '\x1b[2K\r' + chalk.dim(`Retrieval skipped${classTag} (${timeMs}ms)`) + '\n\n'
          );
        } else {
          process.stdout.write(
            '\x1b[2K\r' + chalk.dim(`Found ${sourceCount} source${sourceCount !== 1 ? 's' : ''}${classTag} (${timeMs}ms)`) + '\n\n'
          );
        }

        // Collect sources for citation display
        if (resultData?.sources) {
          sources = [...sources, ...resultData.sources];
        }
        break;
      }

      case 'response_complete':
        // Final newline after streamed response
        process.stdout.write('\n');

        // Use sources from the event (already collected by ChatAgent)
        if (event.sources.length > 0) {
          sources = event.sources;
          ctx.log('');
          ctx.log(chalk.bold('Sources:'));
          ctx.log(formatCitations(sources, { style: 'compact' }));
        }
        langfuseTraceId = event.langfuseTraceId;
        break;

      case 'error':
        if (isInThinkingPhase) {
          process.stdout.write('\n');
        }
        ctx.error(event.message);
        break;
    }
  }

  return {
    content: chunks.join(''),
    sources,
    langfuseTraceId,
  };
}

// ============================================================================
// TUI Adapter
// ============================================================================

/**
 * Result from the TUI adapter — provides both the stream and source access.
 */
export interface TUIAdapterResult {
  /** Async generator of TUI-compatible StreamChunks */
  stream: AsyncGenerator<TUIStreamChunk, void, unknown>;
  /** Get sources collected during the stream (available after stream completes) */
  getSources: () => RAGSource[];
  /** Get Langfuse trace ID (available after stream completes) */
  getLangfuseTraceId: () => string | undefined;
}

/**
 * Adapt ChatAgentEvents into TUI StreamChunks with activity phase management.
 *
 * Converts the agent event stream into the format expected by
 * TUIController.streamResponse(), while managing AgentPhase transitions
 * via tui.setActivity().
 *
 * Returns both the stream and a getSources() function for citation display
 * after the stream completes.
 *
 * @param events - Async generator of ChatAgentEvents
 * @param tui - TUIController instance for phase management and info messages
 * @returns Object with stream generator and getSources accessor
 */
export function adaptAgentEventsForTUI(
  events: AsyncGenerator<ChatAgentEvent, void, unknown>,
  tui: TUIController
): TUIAdapterResult {
  let collectedSources: RAGSource[] = [];
  let collectedTraceId: string | undefined;

  async function* stream(): AsyncGenerator<TUIStreamChunk, void, unknown> {
    let lastIteration = 0;
    let hasToolCallsThisIteration = false;

    for await (const event of events) {
      switch (event.type) {
        case 'thinking_delta': {
          // Track iteration transitions
          if (event.iteration > lastIteration) {
            lastIteration = event.iteration;
            hasToolCallsThisIteration = false;
          }

          if (event.iteration === 1 && !hasToolCallsThisIteration) {
            // First iteration, no tools yet — could be reasoning or direct answer
            // Start as thinking phase, will switch to streaming if it's the answer
            tui.setActivity(AgentPhase.THINKING);
            yield { type: 'thinking', content: event.content };
          } else {
            // After tool calls (iteration > 1) — this is the response
            tui.setActivity(AgentPhase.STREAMING);
            yield { type: 'text', content: event.content };
          }
          break;
        }

        case 'thinking_complete':
          // No additional display needed — deltas already streamed
          break;

        case 'tool_start': {
          hasToolCallsThisIteration = true;

          const query = typeof event.input?.query === 'string'
            ? event.input.query.slice(0, 40)
            : undefined;
          const description = query ? `Searching: "${query}"` : undefined;
          tui.setActivity(AgentPhase.TOOL_USE, event.tool, description);
          break;
        }

        case 'tool_result': {
          // ReActLoop unwraps ToolResult.data, so event.result is the
          // RetrieveKnowledgeOutput directly (no .data wrapper)
          const resultData = event.result as RetrieveKnowledgeOutput | undefined;
          const sourceCount = resultData?.sourceCount ?? 0;
          const timeMs = Math.round(event.durationMs);
          const classTag = resultData?.classification
            ? ` [${resultData.classification.type}]`
            : '';

          if (resultData?.classification?.skippedRetrieval) {
            tui.addInfoMessage(
              chalk.dim(`Retrieval skipped${classTag} (${timeMs}ms)`)
            );
          } else {
            tui.addInfoMessage(
              chalk.dim(`Found ${sourceCount} source${sourceCount !== 1 ? 's' : ''}${classTag} (${timeMs}ms)`)
            );
          }
          break;
        }

        case 'response_complete':
          // Collect sources for the caller to display after streamResponse()
          collectedSources = event.sources;
          collectedTraceId = event.langfuseTraceId;
          tui.setActivity(AgentPhase.IDLE);
          break;

        case 'error':
          yield { type: 'error', content: event.message };
          break;
      }
    }
  }

  return {
    stream: stream(),
    getSources: () => collectedSources,
    getLangfuseTraceId: () => collectedTraceId,
  };
}
