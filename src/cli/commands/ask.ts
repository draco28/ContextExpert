/**
 * Ask Command
 *
 * Natural language Q&A over indexed projects using RAG + LLM streaming.
 * Combines hybrid search (dense + BM25 + RRF) with LLM generation to
 * answer questions about code with cited sources.
 *
 *   ctx ask "How does authentication work?"
 *   ctx ask "Explain the login flow" --project my-app
 *   ctx ask "What patterns are used here?" --top-k 10 --json
 *
 * Uses the existing infrastructure:
 * - createRAGEngine for context retrieval (hybrid search + XML assembly)
 * - createLLMProvider for answer generation (with automatic fallback)
 * - formatCitations for source display
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import type { CommandContext } from '../types.js';
import type { ChatMessage, StreamChunk, TokenUsage } from '@contextaisdk/core';
import { getDb, runMigrations } from '../../database/index.js';
import { loadConfig } from '../../config/loader.js';
import { createRAGEngine } from '../../agent/rag-engine.js';
import {
  formatCitations,
  formatCitationsJSON,
  type CitationJSON,
} from '../../agent/citations.js';
import { createLLMProvider } from '../../providers/llm.js';
import { CLIError } from '../../errors/index.js';
import type { Project } from '../../database/schema.js';
import type { RAGSearchResult } from '../../agent/types.js';
import { createTracer, shouldRecord } from '../../observability/index.js';
import { getDatabase } from '../../database/index.js';
import type { TraceInput } from '../../eval/types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Command-specific options parsed from CLI arguments.
 */
interface AskCommandOptions {
  /** Limit search to specific project name */
  project?: string;
  /** Number of context chunks to retrieve (default: 5, max: 20) */
  topK: string;
  /** Return retrieved context without LLM generation */
  contextOnly?: boolean;
}

/**
 * JSON output format for the ask command.
 */
interface AskOutputJSON {
  question: string;
  answer: string;
  sources: CitationJSON[];
  metadata: {
    projectSearched: string;
    retrievalMs: number;
    assemblyMs: number;
    generationMs: number;
    totalMs: number;
    tokensUsed?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    model: string;
    provider: string;
  };
}

/**
 * JSON output format for --context-only mode.
 * Returns RAG context without LLM generation.
 */
interface AskContextOnlyJSON {
  question: string;
  context: string;
  estimatedTokens: number;
  sources: CitationJSON[];
  metadata: {
    projectSearched: string;
    retrievalMs: number;
    assemblyMs: number;
    totalMs: number;
  };
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;

/**
 * System prompt template for the LLM.
 *
 * Key design decisions:
 * - Instructs to use ONLY provided context (prevents hallucination)
 * - Citation format matches our [1], [2] output style
 * - Low-key style for code assistant (factual, not chatty)
 */
const SYSTEM_PROMPT = `You are an expert code assistant helping developers understand their codebase.

## Your Role
- Answer questions accurately using ONLY the provided context
- If the context doesn't contain enough information, say so clearly
- Be concise but thorough

## Context Format
The context is provided as XML with source references:
<sources>
  <source id="1" file="path/to/file.ts" lines="10-25" score="0.95">
    // Code content here
  </source>
</sources>

## Citation Requirements
- Reference sources using [1], [2], etc. when citing specific code
- Only cite sources that directly support your answer
- If multiple sources are relevant, cite all of them

## Response Style
- Start with a direct answer to the question
- Use code examples from the context when helpful
- Format code blocks with appropriate language tags
- Keep explanations clear and practical`;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Resolve a single project to search.
 *
 * Unlike the search command which can theoretically search multiple projects,
 * the ask command focuses on single-project Q&A for clearer answers.
 *
 * @param projectName - Optional project name filter
 * @returns The project to search
 * @throws CLIError if project not found or no projects indexed
 */
function resolveProject(projectName?: string): Project {
  runMigrations();
  const db = getDb();

  if (projectName) {
    // Single project lookup by name
    const project = db
      .prepare('SELECT * FROM projects WHERE name = ?')
      .get(projectName) as Project | undefined;

    if (!project) {
      throw new CLIError(
        `Project not found: ${projectName}`,
        'Run: ctx list  to see available projects'
      );
    }

    // Warn if project path no longer exists on disk
    warnIfPathStale(project);

    return project;
  }

  // No project specified - use the most recently updated project
  const projects = db
    .prepare('SELECT * FROM projects ORDER BY updated_at DESC LIMIT 1')
    .all() as Project[];

  if (projects.length === 0) {
    throw new CLIError(
      'No projects indexed',
      'Run: ctx index <path>  to index a project first'
    );
  }

  const project = projects[0]!;
  warnIfPathStale(project);

  return project;
}

/**
 * Warn if a project's stored path no longer exists on disk.
 */
function warnIfPathStale(project: Project): void {
  if (!existsSync(project.path)) {
    console.warn(
      chalk.yellow(
        `Warning: Project '${project.name}' path no longer exists: ${project.path}`
      )
    );
    console.warn(
      chalk.yellow(
        `  Consider re-indexing at the new location or running: ctx remove ${project.name}`
      )
    );
  }
}

/**
 * Parse and validate the --top-k option.
 *
 * @param topKStr - String value from CLI
 * @returns Validated top-k number
 * @throws CLIError if invalid
 */
function parseTopK(topKStr: string): number {
  const topK = parseInt(topKStr, 10);

  if (isNaN(topK) || topK < 1) {
    throw new CLIError(
      `Invalid --top-k value: "${topKStr}"`,
      `Must be a positive integer (1-${MAX_TOP_K})`
    );
  }

  if (topK > MAX_TOP_K) {
    throw new CLIError(
      `--top-k value too large: ${topK}`,
      `Maximum allowed is ${MAX_TOP_K} for ask command`
    );
  }

  return topK;
}

/**
 * Build the complete system prompt with context embedded.
 *
 * @param context - XML-formatted context from RAG engine
 * @returns Complete system prompt for LLM
 */
function buildSystemPrompt(context: string): string {
  return `${SYSTEM_PROMPT}

## Context
${context}`;
}

/**
 * Stream LLM response to stdout in real-time.
 *
 * Used in text mode for interactive terminal experience.
 * Chunks are written directly to stdout as they arrive.
 *
 * @param provider - LLM provider instance
 * @param messages - Chat messages to send
 * @param ctx - Command context for debug logging
 * @returns Collected content and token usage
 */
async function streamResponse(
  provider: { streamChat: (messages: ChatMessage[], options?: { maxTokens?: number; temperature?: number }) => AsyncGenerator<StreamChunk> },
  messages: ChatMessage[],
  ctx: CommandContext
): Promise<{ content: string; usage?: TokenUsage }> {
  const chunks: string[] = [];
  let usage: TokenUsage | undefined;

  ctx.debug('Starting LLM stream...');

  const stream = provider.streamChat(messages, {
    maxTokens: 2048,
    temperature: 0.2, // Low temperature for factual, consistent answers
  });

  for await (const chunk of stream) {
    if (chunk.type === 'text' && chunk.content) {
      process.stdout.write(chunk.content);
      chunks.push(chunk.content);
    } else if (chunk.type === 'usage' && chunk.usage) {
      usage = chunk.usage;
    } else if (chunk.type === 'done') {
      ctx.debug('LLM stream complete');
    }
  }

  // Ensure newline after streaming completes
  console.log();

  return { content: chunks.join(''), usage };
}

/**
 * Collect LLM response without streaming.
 *
 * Used in JSON mode where we need the complete response before outputting.
 *
 * @param provider - LLM provider instance
 * @param messages - Chat messages to send
 * @returns Complete content and token usage
 */
async function collectResponse(
  provider: { chat: (messages: ChatMessage[], options?: { maxTokens?: number; temperature?: number }) => Promise<{ content: string; usage?: TokenUsage }> },
  messages: ChatMessage[]
): Promise<{ content: string; usage?: TokenUsage }> {
  const response = await provider.chat(messages, {
    maxTokens: 2048,
    temperature: 0.2,
  });

  return {
    content: response.content,
    usage: response.usage,
  };
}

/**
 * Display "no results" message with helpful tips.
 */
function displayNoResults(ctx: CommandContext, question: string): void {
  ctx.log(chalk.yellow(`No relevant context found for: "${question}"`));
  ctx.log('');
  ctx.log(chalk.dim('Tips:'));
  ctx.log(chalk.dim('  - Try different keywords or phrasing'));
  ctx.log(chalk.dim('  - Check if the relevant code is indexed'));
  ctx.log(chalk.dim('  - Use --top-k to retrieve more context'));
}

// ============================================================================
// Command Factory
// ============================================================================

/**
 * Create the ask command.
 *
 * @param getContext - Factory to get command context with global options
 * @returns Configured Commander command
 */
export function createAskCommand(getContext: () => CommandContext): Command {
  return new Command('ask')
    .argument('<question>', 'Natural language question about your code')
    .description('Ask a question about your indexed codebase using RAG + LLM')
    .option('-p, --project <name>', 'Limit search to specific project')
    .option(
      '-k, --top-k <number>',
      'Number of context chunks to retrieve',
      String(DEFAULT_TOP_K)
    )
    .option('--context-only', 'Return retrieved context without LLM generation')
    .action(async (question: string, cmdOptions: AskCommandOptions) => {
      const ctx = getContext();
      const startTime = performance.now();

      ctx.debug(`Question: "${question}"`);
      ctx.debug(`Options: ${JSON.stringify(cmdOptions)}`);

      // ─────────────────────────────────────────────────────────────────────
      // 1. Validate question
      // ─────────────────────────────────────────────────────────────────────
      const trimmedQuestion = question.trim();
      if (!trimmedQuestion) {
        throw new CLIError(
          'Question cannot be empty',
          'Provide a question, e.g.: ctx ask "How does authentication work?"'
        );
      }

      // ─────────────────────────────────────────────────────────────────────
      // 2. Parse options
      // ─────────────────────────────────────────────────────────────────────
      const topK = parseTopK(cmdOptions.topK);
      ctx.debug(`Top-K: ${topK}`);

      // ─────────────────────────────────────────────────────────────────────
      // 3. Resolve project
      // ─────────────────────────────────────────────────────────────────────
      const project = resolveProject(cmdOptions.project);
      ctx.debug(`Project: ${project.name} (ID: ${project.id})`);

      if (!ctx.options.json) {
        ctx.log(chalk.dim(`Searching ${project.name}...`));
        ctx.log('');
      }

      // ─────────────────────────────────────────────────────────────────────
      // 4. Load config and create RAG engine
      // ─────────────────────────────────────────────────────────────────────
      const config = loadConfig();
      ctx.debug(`Embedding: ${config.embedding.model} (${config.embedding.provider})`);

      // Create tracer (NoopTracer if Langfuse not configured)
      const tracer = createTracer(config);
      const trace = tracer.trace({
        name: 'ctx-ask',
        input: trimmedQuestion,
        metadata: { project: project.name, topK },
      });
      ctx.debug(`Tracer: ${tracer.isRemote ? 'Langfuse' : 'noop'}`);

      let traceEnded = false;
      try {
        ctx.debug('Creating RAG engine...');
      const ragEngine = await createRAGEngine(config, String(project.id));

      // ─────────────────────────────────────────────────────────────────────
      // 5. Execute RAG search (with retrieval span)
      // ─────────────────────────────────────────────────────────────────────
      ctx.debug('Executing RAG search...');
      const retrievalSpan = trace.span({
        name: 'rag-retrieval',
        input: { query: trimmedQuestion, topK },
      });

      const ragResult: RAGSearchResult = await ragEngine.search(trimmedQuestion, {
        finalK: topK,
        trace,
      });

      retrievalSpan.update({
        output: {
          sourceCount: ragResult.sources.length,
          estimatedTokens: ragResult.estimatedTokens,
        },
        metadata: {
          retrievalMs: ragResult.metadata.retrievalMs,
          assemblyMs: ragResult.metadata.assemblyMs,
          resultsRetrieved: ragResult.metadata.resultsRetrieved,
          resultsAssembled: ragResult.metadata.resultsAssembled,
          fromCache: ragResult.metadata.fromCache,
        },
      });
      retrievalSpan.end();

      ctx.debug(`Retrieved ${ragResult.sources.length} sources`);
      ctx.debug(`Context tokens: ~${ragResult.estimatedTokens}`);

      // ─────────────────────────────────────────────────────────────────────
      // 5b. Context-only mode: return context without LLM generation
      // ─────────────────────────────────────────────────────────────────────
      if (cmdOptions.contextOnly) {
        const totalMs = performance.now() - startTime;
        ctx.debug(`Context-only mode: skipping LLM generation`);

        if (ctx.options.json) {
          const output: AskContextOnlyJSON = {
            question: trimmedQuestion,
            context: ragResult.content,
            estimatedTokens: ragResult.estimatedTokens,
            sources: formatCitationsJSON(ragResult.sources).citations,
            metadata: {
              projectSearched: project.name,
              retrievalMs: ragResult.metadata.retrievalMs,
              assemblyMs: ragResult.metadata.assemblyMs,
              totalMs,
            },
          };
          console.log(JSON.stringify(output, null, 2));
        } else if (ragResult.sources.length === 0) {
          displayNoResults(ctx, trimmedQuestion);
        } else {
          ctx.log(chalk.bold('Context:'));
          ctx.log(ragResult.content);
          ctx.log('');
          ctx.log(chalk.bold('Sources:'));
          ctx.log(formatCitations(ragResult.sources, { style: 'compact' }));

          if (ctx.options.verbose) {
            ctx.log('');
            ctx.log(chalk.dim('─'.repeat(50)));
            ctx.log(chalk.dim(`Retrieval: ${ragResult.metadata.retrievalMs.toFixed(0)}ms`));
            ctx.log(chalk.dim(`Assembly: ${ragResult.metadata.assemblyMs.toFixed(0)}ms`));
            ctx.log(chalk.dim(`Total: ${totalMs.toFixed(0)}ms`));
            ctx.log(chalk.dim(`Estimated tokens: ${ragResult.estimatedTokens}`));
          }
        }

        // End trace and record for context-only mode
        trace.update({ output: { contextOnly: true, sourceCount: ragResult.sources.length } });
        traceEnded = true;
        trace.end();
        if (shouldRecord(config.observability?.sample_rate ?? 1.0)) {
          try {
            const dbOps = getDatabase();
            dbOps.insertTrace({
              project_id: String(project.id),
              query: trimmedQuestion,
              retrieved_files: ragResult.sources.map((s) => s.filePath),
              top_k: topK,
              latency_ms: Math.round(totalMs),
              retrieval_method: 'fusion',
              langfuse_trace_id: trace.traceId,
              trace_type: 'ask',
            });
          } catch (err) {
            ctx.debug(`Trace recording failed: ${err}`);
          }
        }
        return;
      }

      // Check if we got any results
      if (ragResult.sources.length === 0) {
        const totalMs = performance.now() - startTime;
        if (ctx.options.json) {
          console.log(
            JSON.stringify(
              {
                question: trimmedQuestion,
                answer: null,
                sources: [],
                metadata: {
                  projectSearched: project.name,
                  retrievalMs: ragResult.metadata.retrievalMs,
                  assemblyMs: ragResult.metadata.assemblyMs,
                  generationMs: 0,
                  totalMs,
                  model: null,
                  provider: null,
                },
              },
              null,
              2
            )
          );
        } else {
          displayNoResults(ctx, trimmedQuestion);
        }

        // End trace and record for no-results case
        trace.update({ output: { noResults: true }, metadata: { totalMs } });
        traceEnded = true;
        trace.end();
        if (shouldRecord(config.observability?.sample_rate ?? 1.0)) {
          try {
            const dbOps = getDatabase();
            dbOps.insertTrace({
              project_id: String(project.id),
              query: trimmedQuestion,
              retrieved_files: [],
              top_k: topK,
              latency_ms: Math.round(totalMs),
              retrieval_method: 'fusion',
              langfuse_trace_id: trace.traceId,
              trace_type: 'ask',
            });
          } catch (err) {
            ctx.debug(`Trace recording failed: ${err}`);
          }
        }
        return;
      }

      // ─────────────────────────────────────────────────────────────────────
      // 6. Create LLM provider
      // ─────────────────────────────────────────────────────────────────────
      ctx.debug('Creating LLM provider...');
      const { provider, name: providerName, model } = await createLLMProvider(config, {
        fallback: {
          onFallback: (from, to, reason) => {
            ctx.debug(`LLM fallback: ${from} → ${to} (${reason})`);
          },
        },
      });

      ctx.debug(`Using LLM: ${providerName}/${model}`);

      // ─────────────────────────────────────────────────────────────────────
      // 7. Build prompt and generate answer
      // ─────────────────────────────────────────────────────────────────────
      const systemPrompt = buildSystemPrompt(ragResult.content);
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: trimmedQuestion },
      ];

      ctx.debug(`System prompt tokens: ~${Math.ceil(systemPrompt.length / 4)}`);

      // Create generation span for LLM call (captures model + token usage)
      const generationSpan = trace.generation({
        name: 'llm-answer',
        model: `${providerName}/${model}`,
        input: { systemPromptLength: systemPrompt.length, question: trimmedQuestion },
      });

      const generationStart = performance.now();
      let answer: string;
      let usage: TokenUsage | undefined;

      if (ctx.options.json) {
        // JSON mode: collect full response
        const result = await collectResponse(provider, messages);
        answer = result.content;
        usage = result.usage;
      } else {
        // Text mode: stream to stdout
        const result = await streamResponse(provider, messages, ctx);
        answer = result.content;
        usage = result.usage;
      }

      const generationMs = performance.now() - generationStart;

      generationSpan.update({
        output: answer,
        usage: usage
          ? {
              input: usage.promptTokens,
              output: usage.completionTokens,
              total: usage.totalTokens,
            }
          : undefined,
        metadata: { generationMs },
      });
      generationSpan.end();
      const totalMs = performance.now() - startTime;

      ctx.debug(`Generation time: ${generationMs.toFixed(0)}ms`);

      // ─────────────────────────────────────────────────────────────────────
      // 8. Output results
      // ─────────────────────────────────────────────────────────────────────
      if (ctx.options.json) {
        const output: AskOutputJSON = {
          question: trimmedQuestion,
          answer,
          sources: formatCitationsJSON(ragResult.sources).citations,
          metadata: {
            projectSearched: project.name,
            retrievalMs: ragResult.metadata.retrievalMs,
            assemblyMs: ragResult.metadata.assemblyMs,
            generationMs,
            totalMs,
            tokensUsed: usage
              ? {
                  promptTokens: usage.promptTokens,
                  completionTokens: usage.completionTokens,
                  totalTokens: usage.totalTokens,
                }
              : undefined,
            model,
            provider: providerName,
          },
        };
        console.log(JSON.stringify(output, null, 2));
      } else {
        // Display citations after the streamed answer
        ctx.log('');
        ctx.log(chalk.bold('Sources:'));
        ctx.log(formatCitations(ragResult.sources, { style: 'compact' }));

        // Verbose mode: show timing details
        if (ctx.options.verbose) {
          ctx.log('');
          ctx.log(chalk.dim('─'.repeat(50)));
          ctx.log(chalk.dim(`Retrieval: ${ragResult.metadata.retrievalMs.toFixed(0)}ms`));
          ctx.log(chalk.dim(`Assembly: ${ragResult.metadata.assemblyMs.toFixed(0)}ms`));
          ctx.log(chalk.dim(`Generation: ${generationMs.toFixed(0)}ms`));
          ctx.log(chalk.dim(`Total: ${totalMs.toFixed(0)}ms`));
          if (usage) {
            ctx.log(
              chalk.dim(
                `Tokens: ${usage.promptTokens} prompt + ${usage.completionTokens} completion = ${usage.totalTokens} total`
              )
            );
          }
          ctx.log(chalk.dim(`Model: ${providerName}/${model}`));
        }
      }

      // Update root trace with final output and end
      trace.update({
        output: answer,
        metadata: {
          retrievalMs: ragResult.metadata.retrievalMs,
          assemblyMs: ragResult.metadata.assemblyMs,
          generationMs,
          totalMs,
          model: `${providerName}/${model}`,
          sourceCount: ragResult.sources.length,
        },
      });
      traceEnded = true;
      trace.end();

      // Always-on local trace recording (fire-and-forget, respects sample_rate)
      // Records ask interactions to eval_traces for retrospective
      // analysis, trend tracking, and golden dataset capture.
      if (shouldRecord(config.observability?.sample_rate ?? 1.0)) {
        try {
          const dbOps = getDatabase();
          const traceInput: TraceInput = {
            project_id: String(project.id),
            query: trimmedQuestion,
            retrieved_files: ragResult.sources.map((s) => s.filePath),
            top_k: topK,
            latency_ms: Math.round(totalMs),
            answer,
            retrieval_method: 'fusion',
            langfuse_trace_id: trace.traceId,
            trace_type: 'ask',
            metadata: {
              model: `${providerName}/${model}`,
              retrievalMs: ragResult.metadata.retrievalMs,
              assemblyMs: ragResult.metadata.assemblyMs,
              generationMs,
              tokensUsed: usage
                ? {
                    prompt: usage.promptTokens,
                    completion: usage.completionTokens,
                    total: usage.totalTokens,
                  }
                : undefined,
            },
          };
          dbOps.insertTrace(traceInput);
          ctx.debug('Trace recorded to eval_traces');
        } catch (err) {
          // Non-blocking: trace recording should never break the command
          ctx.debug(`Trace recording failed: ${err}`);
        }
      }
      } finally {
        if (!traceEnded) {
          trace.end();
        }
        await tracer.shutdown().catch((err) => ctx.debug(`Tracer shutdown error: ${err}`));
      }
    });
}
