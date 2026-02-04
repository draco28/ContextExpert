/**
 * Chat Command
 *
 * Interactive multi-turn chat REPL with RAG-powered Q&A.
 * Maintains conversation history within a session and supports
 * REPL commands for project switching, indexing, history clearing, etc.
 *
 *   ctx chat                     # Start chat (uses most recent project)
 *   ctx chat --project my-app    # Start focused on specific project
 *
 * REPL Commands:
 *   /help      - Show available commands
 *   /index X   - Index directory X for RAG search
 *   /focus X   - Switch to project X
 *   /unfocus   - Clear project scope
 *   /projects  - List available projects
 *   /describe  - Add description/tags to project for smart routing
 *   /clear     - Clear conversation history
 *   exit       - Exit the chat
 */

import * as readline from 'node:readline';
import { basename } from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync } from 'node:fs';
import type { CommandContext } from '../types.js';
import {
  ConversationContext,
  type ChatMessage,
  type StreamChunk,
  type TokenUsage,
} from '@contextaisdk/core';
import { getDb, runMigrations, getDatabase } from '../../database/index.js';
import { loadConfig, type Config } from '../../config/loader.js';
import { createRAGEngine, type ContextExpertRAGEngine } from '../../agent/rag-engine.js';
import {
  RAGEngineError,
  RAGErrorCodes,
  type RAGSource,
  type RoutingRAGResult,
} from '../../agent/types.js';
import { formatCitations } from '../../agent/citations.js';
import {
  createProjectRouter,
  type LLMProjectRouter,
  type ProjectMetadata,
} from '../../agent/query-router.js';
import {
  RoutingRAGEngine,
  createRoutingRAGEngine,
} from '../../agent/routing-rag-engine.js';
import { createLLMProvider } from '../../providers/llm.js';
import { CLIError } from '../../errors/index.js';
import { validateProjectPath } from '../../utils/path-validation.js';
import { getBackgroundIndexingCoordinator } from '../utils/background-indexing.js';
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
} from '../../indexer/index.js';
import {
  getMultiProjectFusionService,
  type MultiProjectSearchResult,
  EmbeddingMismatchError,
} from '../../search/index.js';
import type { Project } from '../../database/schema.js';
import { handleProviderCommand, createProviderFromConfig } from './provider-repl.js';
import { getDefaultProvider } from '../../config/providers.js';
import { completeDirectoryPath } from '../utils/path-completer.js';
import { completeFileNames } from '../utils/file-completer.js';
import {
  parseFileReferences,
  stripFileReferences,
  resolveFileReferences,
  formatReferencesAsContext,
  getReferenceSummary,
  type ResolvedReference,
} from '../../search/file-reference.js';
import { handleShareCommand } from './share-handler.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Command-specific options parsed from CLI arguments.
 */
interface ChatCommandOptions {
  /** Start focused on a specific project name */
  project?: string;
}

/**
 * Mutable state for the chat REPL session.
 * Persists across user inputs within a single session.
 * Exported for use by provider-repl.ts handlers.
 */
export interface ChatState {
  /** Currently focused project (null = no RAG, pure LLM mode) */
  currentProject: Project | null;
  /** Conversation history with automatic truncation (from @contextaisdk/core) */
  conversationContext: ConversationContext;
  /**
   * RAG engine for current project (null if unfocused).
   * @deprecated Use routingEngine instead. Kept for backward compatibility
   * with /focus command and cases where routing is not available.
   */
  ragEngine: ContextExpertRAGEngine | null;
  /** LLM provider (cached for session) */
  llmProvider: {
    streamChat: (
      messages: ChatMessage[],
      options?: { maxTokens?: number; temperature?: number }
    ) => AsyncGenerator<StreamChunk>;
  };
  /** Provider metadata for display */
  providerInfo: { name: string; model: string };
  /** Loaded config (cached) */
  config: Config;
  /** Readline interface for prompt updates (set after REPL starts) */
  rl?: readline.Interface;
  /**
   * Query router for smart project selection (null if no projects).
   * @deprecated Use routingEngine instead. Router is now internal to RoutingRAGEngine.
   */
  queryRouter: LLMProjectRouter | null;
  /** All indexed projects (cached for routing) */
  allProjects: ProjectMetadata[];
  /** Embedding provider for multi-project search (lazy-loaded) */
  embeddingProvider?: EmbeddingProvider;
  /** Embedding dimensions (from config, for multi-project search) */
  embeddingDimensions?: number;
  /**
   * Unified routing + RAG engine (new in ticket #88).
   * Handles both single-project and multi-project search with automatic routing.
   * When available, this is the preferred way to search.
   */
  routingEngine?: RoutingRAGEngine | null;
}

/**
 * REPL command definition.
 * Handler returns true to continue REPL, false to exit.
 */
interface REPLCommand {
  name: string;
  aliases: string[];
  description: string;
  usage?: string;
  handler: (
    args: string[],
    state: ChatState,
    ctx: CommandContext
  ) => Promise<boolean>;
}

/**
 * Clean up resources held by the chat state.
 *
 * Call on all exit paths to prevent memory leaks:
 * - SIGINT (Ctrl+C)
 * - exit/quit command
 * - Normal REPL loop exit
 *
 * Releases:
 * - RAG engine (which clears vector store and BM25 caches)
 * - Conversation context
 */
function cleanupChatState(state: ChatState): void {
  // Dispose routing engine (clears all cached single-project engines)
  if (state.routingEngine) {
    state.routingEngine.dispose();
    state.routingEngine = null;
  }

  // Dispose legacy RAG engine (for backward compatibility)
  if (state.ragEngine) {
    state.ragEngine.dispose();
    state.ragEngine = null;
  }

  // Clear conversation context
  state.conversationContext.clear();
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum tokens to retain in conversation context.
 * When exceeded, oldest messages are automatically removed by ConversationContext.
 */
const MAX_CONTEXT_TOKENS = 8000;

/**
 * System prompt template for the chat assistant.
 * Context is injected dynamically based on current project focus.
 */
const SYSTEM_PROMPT_BASE = `You are an expert code assistant helping developers understand their codebase.

## Your Role
- Answer questions accurately using the provided context (if any)
- If no context is provided, you can still have general conversations
- If context doesn't contain enough information, say so clearly
- Remember the conversation history for multi-turn discussions

## Citation Requirements (when context is provided)
- Reference sources using [1], [2], etc. when citing specific code
- Only cite sources that directly support your answer

## Response Style
- Be concise but thorough
- Use code examples when helpful
- Format code blocks with appropriate language tags`;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate the REPL prompt based on current focus state.
 * Shows [project-name]> when focused, just > when unfocused.
 */
function getPrompt(state: ChatState): string {
  return state.currentProject
    ? chalk.green(`[${state.currentProject.name}]> `)
    : chalk.green('> ');
}

/**
 * Get all project names for tab completion.
 */
function getAllProjectNames(): string[] {
  try {
    runMigrations();
    const db = getDb();
    const projects = db
      .prepare('SELECT name FROM projects ORDER BY name')
      .all() as Array<{ name: string }>;
    return projects.map((p) => p.name);
  } catch {
    return [];
  }
}

/**
 * Update the readline prompt to reflect current state.
 */
function updatePrompt(state: ChatState): void {
  if (state.rl) {
    state.rl.setPrompt(getPrompt(state));
  }
}

// ============================================================================
// Index Command Handler
// ============================================================================

/**
 * Format a path with ~ for home directory.
 * Matches the pattern used in status.ts for consistency.
 */
function formatPath(filePath: string): string {
  const homeDir = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
  if (homeDir && filePath.startsWith(homeDir)) {
    return '~' + filePath.slice(homeDir.length);
  }
  return filePath;
}

/**
 * Format a date as relative time (e.g., "2 hours ago", "yesterday").
 * Used by /index status to show when projects were last indexed.
 */
function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;

  // For older dates, show the actual date
  return date.toLocaleDateString();
}

/**
 * Result of parsing /index command arguments.
 */
interface IndexArgs {
  path: string;
  name?: string;
  force: boolean;
  /** Subcommand: 'status' for /index status */
  subcommand?: 'status';
}

/**
 * Parse /index command arguments.
 *
 * Supports:
 *   /index <path>                 - Basic usage
 *   /index <path> -n <name>       - Custom project name
 *   /index <path> --force         - Re-index existing project
 *   /index status                 - Show indexing status
 *
 * @internal Exported for testing
 */
export function parseIndexArgs(args: string[]): IndexArgs {
  // Check for 'status' subcommand first (case-insensitive)
  if (args.length > 0 && args[0]?.toLowerCase() === 'status') {
    return { path: '', name: undefined, force: false, subcommand: 'status' };
  }

  let path = '';
  let name: string | undefined;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-n' || arg === '--name') {
      // Bounds check: only consume next arg if it exists
      if (i + 1 < args.length) {
        name = args[++i];
      }
    } else if (arg === '--force' || arg === '-f') {
      force = true;
    } else if (!path && arg && !arg.startsWith('-')) {
      path = arg;
    }
  }

  return { path, name, force };
}

/**
 * Handle /index status command to show indexing status.
 *
 * Since /index runs synchronously and blocks the REPL, this command
 * can only show historical information (last indexed project).
 * Real-time progress is displayed during the /index command itself.
 *
 * @returns true to continue REPL
 */
async function handleIndexStatusCommand(
  _state: ChatState,
  ctx: CommandContext
): Promise<boolean> {
  runMigrations();
  const db = getDb();

  // Check if background indexing is running
  const coordinator = getBackgroundIndexingCoordinator();
  const bgStatus = coordinator.getStatus();

  ctx.log('');
  ctx.log(chalk.bold('Index Status'));
  ctx.log(chalk.dim('─'.repeat(35)));

  if (bgStatus.running) {
    // Show live progress for background indexing
    ctx.log(`${chalk.cyan('State:')}          ${chalk.yellow('indexing')}`);
    ctx.log('');
    ctx.log(chalk.bold('Currently Indexing:'));
    ctx.log(`  ${chalk.cyan('Project:')}     ${bgStatus.projectName}`);

    if (bgStatus.stage) {
      const stageLabels: Record<string, string> = {
        scanning: 'Scanning files',
        chunking: 'Chunking files',
        embedding: 'Computing embeddings',
        storing: 'Storing chunks',
      };
      ctx.log(`  ${chalk.cyan('Stage:')}       ${stageLabels[bgStatus.stage] ?? bgStatus.stage}`);
    }

    if (bgStatus.progress) {
      const { processed, total, rate, eta } = bgStatus.progress;
      const percent = total > 0 ? Math.round((processed / total) * 100) : 0;
      ctx.log(`  ${chalk.cyan('Progress:')}    ${processed.toLocaleString()}/${total.toLocaleString()} (${percent}%)`);

      if (rate !== undefined && rate > 0) {
        ctx.log(`  ${chalk.cyan('Rate:')}        ${rate.toFixed(1)} chunks/sec`);
      }

      if (eta !== undefined && eta > 0) {
        const etaStr = eta < 60 ? `${eta}s` : `${Math.floor(eta / 60)}m ${eta % 60}s`;
        ctx.log(`  ${chalk.cyan('ETA:')}         ${etaStr}`);
      }
    }

    if (bgStatus.startedAt) {
      const elapsed = Math.round((Date.now() - bgStatus.startedAt) / 1000);
      const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
      ctx.log(`  ${chalk.cyan('Elapsed:')}     ${elapsedStr}`);
    }

    ctx.log('');
    ctx.log(chalk.dim(`Use ${chalk.cyan('/index cancel')} to stop indexing.`));
    ctx.log('');
    return true;
  }

  // Not currently indexing - show idle state
  ctx.log(`${chalk.cyan('State:')}          ${chalk.green('idle')}`);

  // Get the most recently indexed project (by indexed_at timestamp)
  const lastIndexed = db
    .prepare(
      'SELECT * FROM projects WHERE indexed_at IS NOT NULL ORDER BY indexed_at DESC LIMIT 1'
    )
    .get() as Project | undefined;

  if (lastIndexed) {
    const indexedAt = new Date(lastIndexed.indexed_at!);
    const relativeTime = formatRelativeTime(indexedAt);

    ctx.log('');
    ctx.log(chalk.bold('Last Indexed Project:'));
    ctx.log(`  ${chalk.cyan('Name:')}        ${lastIndexed.name}`);
    ctx.log(`  ${chalk.cyan('Path:')}        ${formatPath(lastIndexed.path)}`);
    ctx.log(`  ${chalk.cyan('Indexed:')}     ${relativeTime}`);
    ctx.log(`  ${chalk.cyan('Files:')}       ${lastIndexed.file_count.toLocaleString()}`);
    ctx.log(`  ${chalk.cyan('Chunks:')}      ${lastIndexed.chunk_count.toLocaleString()}`);

    if (lastIndexed.embedding_model) {
      ctx.log(`  ${chalk.cyan('Model:')}       ${lastIndexed.embedding_model}`);
    }

    // Warn if the project path no longer exists
    if (!existsSync(lastIndexed.path)) {
      ctx.log(`  ${chalk.yellow('(path no longer exists)')}`);
    }
  } else {
    ctx.log('');
    ctx.log(chalk.dim('No projects have been indexed yet.'));
    ctx.log(chalk.dim(`Run ${chalk.cyan('/index <path>')} to index a project.`));
  }

  ctx.log('');
  return true;
}

/**
 * Handle /index command to index a project from within the REPL.
 *
 * This reuses the same indexing pipeline as `ctx index`, providing:
 * - Path validation with helpful error messages
 * - Progress display with spinners (in TTY mode)
 * - Auto-focus on the newly indexed project
 *
 * @returns true to continue REPL
 */
async function handleIndexCommand(
  args: string[],
  state: ChatState,
  ctx: CommandContext
): Promise<boolean> {
  // 1. Parse arguments
  const { path: inputPath, name, force, subcommand } = parseIndexArgs(args);

  // Handle /index status subcommand
  if (subcommand === 'status') {
    return handleIndexStatusCommand(state, ctx);
  }

  // Handle /index cancel subcommand
  if (subcommand === 'cancel') {
    const coordinator = getBackgroundIndexingCoordinator();
    if (coordinator.cancel()) {
      ctx.log(chalk.yellow('Cancelling indexing...'));
    } else {
      ctx.log(chalk.dim('No indexing operation in progress.'));
    }
    return true;
  }

  if (!inputPath) {
    ctx.log(chalk.yellow('Usage: /index <path> [-n name] [--force] | status | cancel'));
    ctx.log(chalk.dim('Example: /index ./my-project'));
    ctx.log(chalk.dim('         /index ../other-repo -n my-app'));
    ctx.log(chalk.dim('         /index status'));
    ctx.log(chalk.dim('         /index cancel'));
    return true;
  }

  // Check if indexing is already running
  const coordinator = getBackgroundIndexingCoordinator();
  if (coordinator.isRunning()) {
    const status = coordinator.getStatus();
    ctx.log(chalk.yellow(`Indexing already in progress: ${status.projectName}`));
    ctx.log(chalk.dim('Use /index status to check progress, /index cancel to stop.'));
    return true;
  }

  // 2. Validate path (same validation as `ctx index`)
  const validation = validateProjectPath(inputPath);
  if (!validation.valid) {
    ctx.error(validation.error);
    if (validation.hint) ctx.log(chalk.dim(validation.hint));
    return true;
  }

  const projectPath = validation.normalizedPath;
  for (const warning of validation.warnings) {
    ctx.log(chalk.yellow(`Warning: ${warning}`));
  }

  // 3. Determine project name (default to directory name)
  const projectName = name ?? basename(projectPath);

  // 4. Check for existing project
  runMigrations();
  const db = getDatabase();
  const existingProject = db.getProjectByPath(projectPath);

  if (existingProject && !force) {
    ctx.error(`Project already indexed: ${existingProject.name}`);
    ctx.log(chalk.dim('Use /index <path> --force to re-index'));
    return true;
  }

  if (existingProject && force) {
    ctx.log(chalk.dim(`Re-indexing: clearing ${existingProject.chunk_count} existing chunks`));
    db.deleteProjectChunks(existingProject.id);
  }

  // 5. Create embedding provider with progress display
  ctx.log('');
  let modelLoadingSpinner: ReturnType<typeof ora> | null = null;
  if (process.stdout.isTTY) {
    modelLoadingSpinner = ora({
      text: 'Loading embedding model...',
      prefixText: chalk.cyan('Setup'.padEnd(12)),
    }).start();
  }

  let embeddingProvider: EmbeddingProvider;
  let embeddingModel: string;
  let embeddingDimensions: number;
  try {
    const result = await createEmbeddingProvider(state.config.embedding, {
      onProgress: (progress) => {
        if (modelLoadingSpinner) {
          const pct = progress.progress ? ` (${progress.progress}%)` : '';
          modelLoadingSpinner.text = `${progress.status}${pct}`;
        }
      },
    });
    embeddingProvider = result.provider;
    embeddingModel = result.model;
    embeddingDimensions = result.dimensions;
    modelLoadingSpinner?.succeed(
      `Embedding model ready (${embeddingModel}, ${embeddingDimensions}d)`
    );
  } catch (error) {
    modelLoadingSpinner?.fail('Failed to load embedding model');
    ctx.error(`Embedding setup failed: ${(error as Error).message}`);
    ctx.log(chalk.dim('Check your embedding configuration: ctx config list'));
    return true;
  }

  // 6. Start background indexing (non-blocking)
  // The status bar will show progress below the chat input
  coordinator.start({
    pipelineOptions: {
      projectPath,
      projectName,
      projectId: existingProject?.id,
      embeddingProvider,
      embeddingModel,
      embeddingDimensions,
      embeddingTimeout: state.config.embedding.timeout_ms,
      chunkerConfig: { embeddingProvider },
    },
    statusBarOptions: {
      terminalWidth: process.stdout.columns,
      noColor: !!process.env.NO_COLOR,
    },
    readline: state.rl,

    // Handle successful completion
    onComplete: async (result) => {
      ctx.log('');
      ctx.log(chalk.green(`✓ Indexed ${result.projectName}`));
      ctx.log(
        chalk.dim(
          `  ${result.filesIndexed} files, ${result.chunksStored.toLocaleString()} chunks`
        )
      );

      // Auto-focus on the newly indexed project
      try {
        const newProject = db.getProjectById(result.projectId);
        if (newProject) {
          const newRagEngine = await createRAGEngine(state.config, result.projectId);

          // Dispose old RAG engine if exists (releases memory)
          state.ragEngine?.dispose();

          state.currentProject = newProject;
          state.ragEngine = newRagEngine;
          updatePrompt(state);

          // Update router's project list with newly indexed project
          if (state.queryRouter) {
            const rawDb = getDb();
            const allProjectsRaw = rawDb
              .prepare(
                'SELECT id, name, description, tags, file_count, chunk_count FROM projects'
              )
              .all() as Array<{
                id: string;
                name: string;
                description: string | null;
                tags: string | null;
                file_count: number;
                chunk_count: number;
              }>;

            state.allProjects = allProjectsRaw.map((p) => ({
              id: p.id,
              name: p.name,
              description: p.description,
              tags: safeParseJsonArray(p.tags),
              fileCount: p.file_count,
              chunkCount: p.chunk_count,
            }));

            state.queryRouter.updateProjects(state.allProjects);
            ctx.debug(`Updated router with ${state.allProjects.length} projects`);
          }

          ctx.log(chalk.blue(`Now focused on: ${result.projectName}`));
          ctx.log(chalk.dim('Ask questions about your code, or use /unfocus to clear focus'));
        }
      } catch (error) {
        // Non-fatal: indexing succeeded, just couldn't auto-focus
        ctx.log(
          chalk.yellow(
            `Indexed successfully, but auto-focus failed: ${(error as Error).message}`
          )
        );
        ctx.log(chalk.dim(`Use /focus ${result.projectName} to focus manually`));
      }

      ctx.log('');
      state.rl?.prompt();
    },

    // Handle errors
    onError: (error) => {
      ctx.error(`Indexing failed: ${error.message}`);
      ctx.log(chalk.dim('Try running: ctx index <path> for detailed diagnostics'));
      state.rl?.prompt();
    },

    // Handle cancellation
    onCancelled: () => {
      ctx.log(chalk.yellow('Indexing cancelled.'));
      state.rl?.prompt();
    },
  });

  // Return immediately - indexing continues in background
  ctx.log(chalk.blue(`Started indexing: ${projectName}`));
  ctx.log(chalk.dim('Chat is available. Use /index status or /index cancel.'));
  ctx.log('');
  return true;
}

// ============================================================================
// REPL Commands Registry
// ============================================================================

/**
 * Registry of all available REPL commands.
 * Commands start with "/" except for exit/quit.
 */
const REPL_COMMANDS: REPLCommand[] = [
  {
    name: 'help',
    aliases: ['h', '?'],
    description: 'Show available commands',
    handler: async (_args, _state, ctx) => {
      ctx.log('');
      ctx.log(chalk.bold('Available Commands:'));
      ctx.log('');
      for (const cmd of REPL_COMMANDS) {
        const aliasStr =
          cmd.aliases.length > 0
            ? chalk.dim(` (${cmd.aliases.map((a) => '/' + a).join(', ')})`)
            : '';
        const usageStr = cmd.usage ? ` ${chalk.cyan(cmd.usage)}` : '';
        ctx.log(`  ${chalk.green('/' + cmd.name)}${usageStr}${aliasStr}`);
        ctx.log(`    ${chalk.dim(cmd.description)}`);
      }
      ctx.log('');
      ctx.log(chalk.dim('Type any other text to ask a question.'));
      ctx.log('');
      return true;
    },
  },
  {
    name: 'focus',
    aliases: ['f'],
    description: 'Focus on a specific project for RAG search',
    usage: '<project-name>',
    handler: async (args, state, ctx) => {
      if (args.length === 0) {
        ctx.log(chalk.yellow('Usage: /focus <project-name>'));
        ctx.log(chalk.dim('Run /projects to see available projects'));
        return true;
      }

      const projectName = args.join(' ');
      const project = findProject(projectName);

      if (!project) {
        ctx.log(chalk.red(`Project not found: ${projectName}`));
        ctx.log(chalk.dim('Run /projects to see available projects'));
        return true;
      }

      // Create RAG engine first, then update state atomically
      // (If createRAGEngine throws, state remains unchanged)
      try {
        const newRagEngine = await createRAGEngine(
          state.config,
          String(project.id)
        );
        state.currentProject = project;
        state.ragEngine = newRagEngine;
        updatePrompt(state);

        ctx.log(chalk.blue(`Focused on: ${project.name}`));
        if (!existsSync(project.path)) {
          ctx.log(
            chalk.yellow(`Warning: Project path no longer exists: ${project.path}`)
          );
        }
      } catch (error) {
        // Provide user-friendly error messages based on error type
        if (error instanceof RAGEngineError) {
          ctx.log(chalk.red(`Failed to focus on ${project.name}:`));
          ctx.log(chalk.red(`  ${error.message}`));

          // Add actionable hints based on error code
          switch (error.code) {
            case RAGErrorCodes.EMBEDDING_UNAVAILABLE:
              ctx.log(chalk.dim('Hint: Check your API keys with: ctx config get embedding.provider'));
              ctx.log(chalk.dim('      Run: ctx config set embedding.provider ollama  for local embeddings'));
              break;
            case RAGErrorCodes.PROJECT_NOT_INDEXED:
              ctx.log(chalk.dim(`Hint: Run: ctx index "${project.path}"  to index this project`));
              break;
            case RAGErrorCodes.CONFIG_ERROR:
              ctx.log(chalk.dim('Hint: Check your config with: ctx config list'));
              ctx.log(chalk.dim('      Reset to defaults with: ctx config reset'));
              break;
            default:
              ctx.log(chalk.dim('Hint: Try /unfocus to clear state, then /focus again'));
          }
        } else {
          // Unknown error - still show something useful
          ctx.log(chalk.red(`Failed to focus on ${project.name}:`));
          ctx.log(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
          ctx.log(chalk.dim('Hint: Try /unfocus to clear state, then /focus again'));
        }
        ctx.debug(`Focus error details: ${error}`);
      }
      return true;
    },
  },
  {
    name: 'unfocus',
    aliases: ['u'],
    description: 'Clear project focus (disable RAG search)',
    handler: async (_args, state, ctx) => {
      if (state.currentProject) {
        ctx.log(chalk.blue(`Unfocused from: ${state.currentProject.name}`));
        state.currentProject = null;
        state.ragEngine = null;
        updatePrompt(state);
      } else {
        ctx.log(chalk.dim('No project is currently focused'));
      }
      return true;
    },
  },
  {
    name: 'projects',
    aliases: ['p', 'list'],
    description: 'List all indexed projects',
    handler: async (_args, state, ctx) => {
      runMigrations();
      const db = getDb();
      const projects = db
        .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
        .all() as Project[];

      if (projects.length === 0) {
        ctx.log(chalk.yellow('No projects indexed'));
        ctx.log(chalk.dim('Run: ctx index <path>  to index a project'));
        return true;
      }

      ctx.log('');
      ctx.log(chalk.bold('Indexed Projects:'));
      ctx.log('');
      for (const project of projects) {
        const isFocused = state.currentProject?.id === project.id;
        const marker = isFocused ? chalk.green(' *') : '';
        const pathExists = existsSync(project.path);
        const pathStatus = pathExists ? '' : chalk.yellow(' (path missing)');
        ctx.log(`  ${chalk.cyan(project.name)}${marker}${pathStatus}`);
        ctx.log(`    ${chalk.dim(project.path)}`);
      }
      ctx.log('');
      if (state.currentProject) {
        ctx.log(chalk.dim(`* = currently focused`));
      }
      ctx.log('');
      return true;
    },
  },
  {
    name: 'describe',
    aliases: ['desc'],
    description: 'Add description and tags to a project for smart routing',
    usage: '<project-name> ["description"] [--tags tag1,tag2]',
    handler: async (args, _state, ctx) => {
      // No arguments - show usage
      if (args.length === 0 || !args[0]) {
        ctx.log(chalk.yellow('Usage: /describe <project-name> ["description"] [--tags tag1,tag2]'));
        ctx.log('');
        ctx.log(chalk.dim('Examples:'));
        ctx.log(chalk.dim('  /describe my-api "Main REST API server"'));
        ctx.log(chalk.dim('  /describe my-api --tags backend,auth,payments'));
        ctx.log(chalk.dim('  /describe my-api "REST API" --tags backend,api'));
        ctx.log(chalk.dim('  /describe my-api                (show current values)'));
        return true;
      }

      // First arg is always the project name
      const projectName = args[0];
      const project = findProject(projectName);

      if (!project) {
        ctx.log(chalk.red(`Project not found: ${projectName}`));
        ctx.log(chalk.dim('Run /projects to see available projects'));
        return true;
      }

      // Join remaining args for parsing
      const remaining = args.slice(1).join(' ');

      // Extract description (text in quotes)
      let description: string | undefined;
      const descMatch = remaining.match(/"([^"]+)"|'([^']+)'/);
      if (descMatch) {
        description = descMatch[1] ?? descMatch[2];
      }

      // Extract tags (--tags tag1,tag2,tag3 or --tags "tag1, tag2, tag3")
      let tags: string[] | undefined;
      const tagsMatch = remaining.match(/--tags?\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
      if (tagsMatch) {
        const tagsValue = tagsMatch[1] ?? tagsMatch[2] ?? tagsMatch[3] ?? '';
        tags = tagsValue.split(',').map((t) => t.trim()).filter(Boolean);
      }

      // Show-only mode (no description or tags provided)
      if (!description && !tags) {
        const existingTags = safeParseJsonArray(project.tags);
        ctx.log('');
        ctx.log(chalk.bold(`Project: ${project.name}`));
        ctx.log(`  ${chalk.cyan('Path:')}        ${project.path}`);
        ctx.log(`  ${chalk.cyan('Description:')} ${project.description ?? chalk.dim('(none)')}`);
        ctx.log(`  ${chalk.cyan('Tags:')}        ${existingTags.length > 0 ? existingTags.join(', ') : chalk.dim('(none)')}`);
        ctx.log(`  ${chalk.cyan('Files:')}       ${project.file_count}`);
        ctx.log(`  ${chalk.cyan('Chunks:')}      ${project.chunk_count}`);
        ctx.log('');
        return true;
      }

      // Update project metadata
      const db = getDatabase();
      db.updateProjectMetadata(project.id, { description, tags });

      ctx.log(chalk.green(`✓ Updated project: ${project.name}`));
      if (description) {
        ctx.log(`  ${chalk.cyan('Description:')} ${description}`);
      }
      if (tags && tags.length > 0) {
        ctx.log(`  ${chalk.cyan('Tags:')}        ${tags.join(', ')}`);
      }
      ctx.log('');

      return true;
    },
  },
  {
    name: 'clear',
    aliases: ['c'],
    description: 'Clear conversation history',
    handler: async (_args, state, ctx) => {
      state.conversationContext.clear();
      ctx.log(chalk.blue('Conversation history cleared'));
      return true;
    },
  },
  {
    name: 'share',
    aliases: [],
    description: 'Export conversation to markdown file',
    usage: '[path]',
    handler: handleShareCommand,
  },
  {
    name: 'index',
    aliases: ['i'],
    description: 'Index a project directory for RAG search',
    usage: '<path> [-n name] [--force] | status',
    handler: async (args, state, ctx) => {
      return handleIndexCommand(args, state, ctx);
    },
  },
  {
    name: 'provider',
    aliases: ['prov'],
    description: 'Manage LLM providers (add, list, use, remove, test)',
    usage: '<subcommand>',
    handler: async (args, state, ctx) => {
      return handleProviderCommand(args, state, ctx);
    },
  },
  {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: 'Exit the chat',
    handler: async (_args, state, ctx) => {
      ctx.log(chalk.dim('Goodbye!'));
      cleanupChatState(state);
      return false; // Signal to exit REPL
    },
  },
];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Safely parse a JSON array from database, returning empty array on error.
 * Handles null, undefined, and malformed JSON gracefully.
 */
function safeParseJsonArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Get project name from ID using cached allProjects.
 */
function getProjectName(projectId: string, projects: ProjectMetadata[]): string {
  return projects.find((p) => p.id === projectId)?.name ?? projectId;
}

/**
 * Format multi-project search results as XML context for LLM.
 * Groups results by project and includes attribution metadata.
 */
function formatMultiProjectContext(results: MultiProjectSearchResult[]): string {
  return results
    .map(
      (r, i) =>
        `<source id="${i + 1}" project="${r.projectName}" file="${r.filePath}" lines="${r.lineRange.start}-${r.lineRange.end}">\n${r.content}\n</source>`
    )
    .join('\n\n');
}

/**
 * Convert MultiProjectSearchResult to RAGSource for citation display.
 */
function toRAGSources(results: MultiProjectSearchResult[]): RAGSource[] {
  return results.map((r, i) => ({
    index: i + 1,
    filePath: `${r.projectName}/${r.filePath}`,
    lineRange: r.lineRange,
    content: r.content,
    score: r.score,
    language: r.language,
    fileType: r.fileType,
  }));
}

/**
 * Get or create embedding provider for multi-project search.
 * Lazily initializes on first use to avoid startup cost.
 */
async function getOrCreateEmbeddingProvider(
  state: ChatState,
  ctx: CommandContext
): Promise<{ provider: EmbeddingProvider; dimensions: number }> {
  // Return cached provider if available
  if (state.embeddingProvider && state.embeddingDimensions) {
    return { provider: state.embeddingProvider, dimensions: state.embeddingDimensions };
  }

  // Create new provider from config
  ctx.debug('Initializing embedding provider for multi-project search...');
  const { provider, dimensions } = await createEmbeddingProvider(state.config.embedding, {
    onProgress: (p) => ctx.debug(`Embedding init: ${p.status}`),
  });

  // Cache for future use
  state.embeddingProvider = provider;
  state.embeddingDimensions = dimensions;

  return { provider, dimensions };
}

/**
 * Find a project by name (case-insensitive).
 */
function findProject(name: string): Project | undefined {
  runMigrations();
  const db = getDb();
  return db
    .prepare('SELECT * FROM projects WHERE LOWER(name) = LOWER(?)')
    .get(name) as Project | undefined;
}

/**
 * Get the most recently updated project.
 */
function getMostRecentProject(): Project | undefined {
  runMigrations();
  const db = getDb();
  return db
    .prepare('SELECT * FROM projects ORDER BY updated_at DESC LIMIT 1')
    .get() as Project | undefined;
}

/**
 * Check if any projects exist in the database.
 * Used to differentiate "no projects indexed" from "projects exist but none valid".
 */
function hasAnyProjects(): boolean {
  runMigrations();
  const db = getDb();
  const result = db
    .prepare('SELECT COUNT(*) as count FROM projects')
    .get() as { count: number } | undefined;
  return (result?.count ?? 0) > 0;
}

/**
 * Parse user input to detect REPL commands.
 * Returns null if it's a regular question.
 *
 * @internal Exported for testing purposes
 */
export function parseREPLCommand(
  input: string
): { command: REPLCommand; args: string[] } | null {
  const trimmed = input.trim();

  // Check for "exit" or "quit" without slash
  if (/^(exit|quit)$/i.test(trimmed)) {
    const exitCmd = REPL_COMMANDS.find((c) => c.name === 'exit')!;
    return { command: exitCmd, args: [] };
  }

  // Must start with "/" for other commands
  if (!trimmed.startsWith('/')) {
    return null;
  }

  // Parse "/command arg1 arg2"
  const parts = trimmed.slice(1).split(/\s+/);
  const cmdName = parts[0]?.toLowerCase() ?? '';
  const args = parts.slice(1);

  // Find matching command by name or alias
  const command = REPL_COMMANDS.find(
    (c) => c.name === cmdName || c.aliases.includes(cmdName)
  );

  if (!command) {
    return null; // Unknown command, treat as question
  }

  return { command, args };
}

/**
 * Build the complete system prompt with optional RAG context.
 */
function buildSystemPrompt(ragContext?: string): string {
  if (!ragContext) {
    return SYSTEM_PROMPT_BASE;
  }

  return `${SYSTEM_PROMPT_BASE}

## Context
${ragContext}`;
}

/**
 * Stream LLM response with color-coded output.
 * Collects chunks for adding to conversation history.
 */
async function streamResponse(
  state: ChatState,
  messages: ChatMessage[],
  ctx: CommandContext
): Promise<{ content: string; usage?: TokenUsage }> {
  const chunks: string[] = [];
  let usage: TokenUsage | undefined;

  const stream = state.llmProvider.streamChat(messages, {
    maxTokens: 2048,
    temperature: 0.3,
  });

  let inThinking = false;

  for await (const chunk of stream) {
    if (chunk.type === 'thinking' && chunk.content) {
      // Show thinking in dim color (not added to history)
      if (!inThinking) {
        process.stdout.write(chalk.dim('[thinking] '));
        inThinking = true;
      }
      process.stdout.write(chalk.dim(chunk.content));
    } else if (chunk.type === 'text' && chunk.content) {
      // End thinking block with newline if we were thinking
      if (inThinking) {
        console.log();
        inThinking = false;
      }
      // Answer in default terminal color (white)
      process.stdout.write(chunk.content);
      chunks.push(chunk.content);
    } else if (chunk.type === 'usage' && chunk.usage) {
      usage = chunk.usage;
    }
  }

  // Ensure newline after streaming
  console.log();

  ctx.debug(`Tokens: ${usage?.totalTokens ?? 'unknown'}`);

  return { content: chunks.join(''), usage };
}

/**
 * Handle a user question: Smart routing + RAG search + LLM generation.
 *
 * Query routing flow:
 * 1. If router available: classify intent and route to appropriate project(s)
 * 2. For single project: use ragEngine (existing or create new)
 * 3. For multiple projects: use MultiProjectFusionService
 * 4. Fallback: use focused project's ragEngine if available
 */
async function handleQuestion(
  question: string,
  state: ChatState,
  ctx: CommandContext
): Promise<void> {
  let ragContext = '';
  let sources: RAGSource[] = [];

  // ─────────────────────────────────────────────────────────────────────────
  // 0. Handle @file references (inject explicit file context)
  // ─────────────────────────────────────────────────────────────────────────
  let fileReferenceContext = '';
  let resolvedReferences: ResolvedReference[] = [];
  const filePatterns = parseFileReferences(question);

  if (filePatterns.length > 0) {
    // Need a project to resolve file references
    if (state.currentProject) {
      resolvedReferences = resolveFileReferences(state.currentProject.id, filePatterns);
      fileReferenceContext = formatReferencesAsContext(resolvedReferences);

      // Show user what files were matched
      const summary = getReferenceSummary(resolvedReferences);
      const hasMatches = resolvedReferences.some((r) => r.matches.length > 0);

      if (hasMatches) {
        ctx.log(chalk.cyan('Using: ') + chalk.dim(summary));
      } else {
        ctx.log(chalk.yellow('No files found matching: ') + filePatterns.join(', '));
      }

      // Strip @-references from question for cleaner RAG/LLM processing
      question = stripFileReferences(question);
      ctx.debug(`Stripped question: "${question}"`);
    } else {
      ctx.log(
        chalk.yellow('Cannot resolve @file references: ') +
          chalk.dim('No project focused. Use /focus <project> first.')
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Smart Query Routing via RoutingRAGEngine (preferred path)
  // ─────────────────────────────────────────────────────────────────────────
  if (state.routingEngine && state.allProjects.length > 0) {
    const spinner = ora({
      text: 'Searching...',
      color: 'cyan',
    }).start();

    try {
      // Delegate routing + search to RoutingRAGEngine
      const result: RoutingRAGResult = await state.routingEngine.search(
        question,
        state.allProjects,
        state.currentProject?.id,
        { finalK: 5 }
      );

      ragContext = result.content;
      sources = result.sources;

      // Build spinner message based on routing result
      const { routing } = result;
      const projectCount = routing.projectIds.length;
      const timeMs = result.metadata?.totalMs ?? 0;

      if (projectCount === 0) {
        spinner.info(chalk.dim('No projects matched query'));
      } else if (projectCount === 1) {
        const projectName = getProjectName(routing.projectIds[0]!, state.allProjects);
        spinner.succeed(
          chalk.dim(`Found ${sources.length} sources in ${projectName} (${timeMs.toFixed(0)}ms)`)
        );
      } else {
        spinner.succeed(
          chalk.dim(`Found ${sources.length} sources across ${projectCount} projects (${timeMs.toFixed(0)}ms)`)
        );
      }

      // Debug logging for routing decision
      ctx.debug(`Routing: ${routing.method} → ${projectCount} project(s): ${routing.reason}`);
    } catch (error) {
      // Handle embedding mismatch errors specially
      if (error instanceof EmbeddingMismatchError) {
        const validation = error.validation;
        const mismatchedProjects =
          validation.errors
            ?.map((e) => `${e.projectName} (${e.embeddingModel ?? 'unknown'})`)
            .join(', ') ?? 'unknown projects';

        spinner.warn(
          chalk.yellow('Embedding mismatch: ') +
            'Cannot search across projects with different embedding models'
        );
        ctx.log(chalk.yellow('  Affected: ') + mismatchedProjects);
        ctx.log(
          chalk.dim('  Tip: Re-index with ') +
            chalk.cyan('cx index <project>') +
            chalk.dim(' to use the same model')
        );
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        spinner.fail(chalk.dim(`Search failed: ${errorMessage}`));
        ctx.debug(`RoutingRAGEngine search failed: ${error}`);
        if (error instanceof Error && error.stack) {
          ctx.debug(error.stack);
        }
      }
      // ragContext and sources remain empty
    }
  }
  // ─────────────────────────────────────────────────────────────────────────
  // 1b. Legacy path: Direct queryRouter + manual engine management
  // (Fallback when RoutingRAGEngine is not available)
  // ─────────────────────────────────────────────────────────────────────────
  else if (state.queryRouter && state.allProjects.length > 0) {
    // Route the query to determine target project(s)
    const routing = await state.queryRouter.route(
      question,
      state.allProjects,
      state.currentProject?.id
    );

    ctx.debug(`Routing (legacy): ${routing.method} → ${routing.projectIds.length} project(s): ${routing.reason}`);

    if (routing.projectIds.length > 0) {
      // Single Project Search (legacy)
      if (routing.projectIds.length === 1) {
        const targetProjectId = routing.projectIds[0]!;
        const targetProjectName = getProjectName(targetProjectId, state.allProjects);

        const spinner = ora({
          text: `Searching ${targetProjectName}...`,
          color: 'cyan',
        }).start();

        try {
          // Determine if we need a new RAG engine
          const needNewEngine = !state.ragEngine || state.currentProject?.id !== targetProjectId;

          if (needNewEngine) {
            ctx.debug(`Creating RAG engine for project: ${targetProjectName}`);

            // Dispose old engine if switching projects
            if (state.ragEngine && state.currentProject?.id !== targetProjectId) {
              state.ragEngine.dispose();
            }

            // Create and STORE the new engine (prevents resource leak)
            state.ragEngine = await createRAGEngine(state.config, targetProjectId);

            // Update current project to match the engine (implicit focus)
            const fullProject = getDb()
              .prepare('SELECT * FROM projects WHERE id = ?')
              .get(targetProjectId) as Project | undefined;
            if (fullProject) {
              state.currentProject = fullProject;
              updatePrompt(state);
            }
          }

          const ragResult = await state.ragEngine!.search(question, { finalK: 5 });
          ragContext = ragResult.content;
          sources = ragResult.sources;
          const timeMs = ragResult.metadata?.retrievalMs ?? 0;
          spinner.succeed(chalk.dim(`Found ${sources.length} sources in ${targetProjectName} (${timeMs}ms)`));
        } catch (error) {
          spinner.fail(chalk.dim('Search failed, continuing without context'));
          ctx.debug(`RAG search failed: ${error}`);
        }
      }
      // Multi-Project Search (legacy)
      else {
        const projectNames = routing.projectIds
          .map((id) => getProjectName(id, state.allProjects))
          .join(', ');

        const spinner = ora({
          text: `Searching ${routing.projectIds.length} projects: ${projectNames}...`,
          color: 'cyan',
        }).start();

        try {
          // Get or create embedding provider
          const { provider: embeddingProvider, dimensions } =
            await getOrCreateEmbeddingProvider(state, ctx);

          // Get multi-project fusion service
          const fusionService = getMultiProjectFusionService({
            rerank: state.config.search.rerank,
          });

          // Validate embedding compatibility across projects
          const validation = fusionService.validateProjects(routing.projectIds);
          if (!validation.valid) {
            // Build user-friendly error with project details
            const mismatchedProjects =
              validation.errors
                ?.map((e) => `${e.projectName} (${e.embeddingModel ?? 'unknown'})`)
                .join(', ') ?? 'unknown projects';

            spinner.warn(
              chalk.yellow('Embedding mismatch: ') +
                'Cannot search across projects with different embedding models'
            );
            ctx.log(chalk.yellow('  Affected: ') + mismatchedProjects);
            ctx.log(
              chalk.dim('  Tip: Re-index with ') +
                chalk.cyan('cx index <project>') +
                chalk.dim(' to use the same model')
            );
            ctx.debug(`Full validation: ${JSON.stringify(validation)}`);
            // ragContext and sources remain empty (initialized above)
          } else {
            // Load project stores
            await fusionService.loadProjects(
              { projectIds: routing.projectIds, dimensions },
              (progress) => ctx.debug(`${progress.projectName}: ${progress.phase}`)
            );

            // Generate query embedding
            const embeddingResult = await embeddingProvider.embed(question);

            // Execute multi-project search
            const results = await fusionService.search(question, embeddingResult.embedding, {
              topK: 10,
            });

            // Format results for LLM and citations
            ragContext = formatMultiProjectContext(results);
            sources = toRAGSources(results);

            spinner.succeed(
              chalk.dim(`Found ${sources.length} sources across ${routing.projectIds.length} projects`)
            );
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          spinner.fail(chalk.dim(`Multi-project search failed: ${errorMessage}`));
          ctx.debug(`Multi-project search failed: ${error}`);
          if (error instanceof Error && error.stack) {
            ctx.debug(error.stack);
          }
        }
      }
    }
  }
  // ─────────────────────────────────────────────────────────────────────────
  // 2. Fallback: Original single-project behavior (no router or empty allProjects)
  // ─────────────────────────────────────────────────────────────────────────
  else if (state.ragEngine && state.currentProject) {
    const spinner = ora({
      text: `Searching ${state.currentProject.name}...`,
      color: 'cyan',
    }).start();

    try {
      const ragResult = await state.ragEngine.search(question, { finalK: 5 });
      ragContext = ragResult.content;
      sources = ragResult.sources;
      const timeMs = ragResult.metadata?.retrievalMs ?? 0;
      spinner.succeed(
        chalk.dim(`Found ${sources.length} sources (${timeMs}ms)`)
      );
    } catch (error) {
      spinner.fail(chalk.dim('Search failed, continuing without context'));
      ctx.debug(`RAG search failed: ${error}`);
    }
  }

  // 2. Build messages for LLM
  // Combine file reference context (explicit @file) with RAG context (search results)
  const combinedContext = [fileReferenceContext, ragContext].filter(Boolean).join('\n\n');
  const systemPrompt = buildSystemPrompt(combinedContext || undefined);
  const conversationMessages = state.conversationContext.getMessages();

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...conversationMessages,
    { role: 'user', content: question },
  ];

  // 3. Stream response (with explicit error handling)
  ctx.log(''); // Blank line before response
  let content: string;
  try {
    const result = await streamResponse(state, messages, ctx);
    content = result.content;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.error(`Response failed: ${message}`);
    ctx.debug(`Stream error details: ${error}`);
    return; // Exit gracefully without updating conversation history
  }

  // 4. Update conversation history
  state.conversationContext.addMessage({ role: 'user', content: question });
  state.conversationContext.addMessage({ role: 'assistant', content });

  // 5. Truncate if needed (automatic sliding window from SDK)
  const removed = await state.conversationContext.truncate();
  if (removed > 0) {
    ctx.debug(`Truncated ${removed} old messages to stay within token limit`);
  }

  // 6. Show sources if available
  if (sources.length > 0) {
    ctx.log('');
    ctx.log(chalk.bold('Sources:'));
    ctx.log(formatCitations(sources, { style: 'compact' }));
  }

  ctx.log('');
}

/**
 * Display welcome message with current state.
 */
function displayWelcome(state: ChatState, ctx: CommandContext): void {
  ctx.log('');
  ctx.log(chalk.bold('Context Expert Chat'));
  ctx.log(chalk.dim(`Model: ${state.providerInfo.name}/${state.providerInfo.model}`));
  ctx.log('');

  if (state.currentProject) {
    ctx.log(chalk.blue(`Focused on: ${state.currentProject.name}`));
  } else {
    // Check if there are ANY projects in the database
    if (hasAnyProjects()) {
      // Projects exist but none are focused (maybe paths missing)
      ctx.log(chalk.dim('No project focused (pure LLM mode)'));
      ctx.log(chalk.dim('Use /focus <project> to enable RAG search'));
    } else {
      // No projects at all - show helpful onboarding message
      ctx.log(chalk.yellow('No projects indexed.'));
      ctx.log(chalk.dim('Use /index <path> to get started.'));
    }
  }

  ctx.log('');
  ctx.log(chalk.dim('Type /help for commands, "exit" to quit'));
  ctx.log('');
}

/**
 * Tab completion handler for REPL commands.
 *
 * Supports:
 * - /focus <TAB> → project names
 * - /provider <TAB> → subcommands
 * - /index <TAB> → directory paths
 * - @<TAB> → file names from focused project
 *
 * @internal Exported for testing purposes
 * @param getProjectNames - Function to retrieve project names (injected for testability)
 * @param getCurrentProjectId - Function to get current project ID for @file completion
 * @returns Tuple of [completions, originalLine] as per Node.js readline spec
 */
export function createCompleter(
  getProjectNames: () => string[] = getAllProjectNames,
  getCurrentProjectId: () => string | null = () => null
): (line: string) => [string[], string] {
  return (line: string): [string[], string] => {
    // Check for /focus or /f command with at least one space after
    const focusMatch = line.match(/^\/(focus|f)\s+(.*)$/i);
    if (focusMatch) {
      const prefix = focusMatch[1] ?? 'focus'; // 'focus' or 'f'
      const partial = (focusMatch[2] ?? '').toLowerCase();
      const projectNames = getProjectNames();
      const matches = projectNames
        .filter((name) => name.toLowerCase().startsWith(partial))
        .map((name) => `/${prefix} ${name}`);
      return [matches, line];
    }

    // Check for /provider or /prov command with at least one space after
    const providerMatch = line.match(/^\/(provider|prov)\s+(.*)$/i);
    if (providerMatch) {
      const prefix = providerMatch[1] ?? 'provider';
      const partial = (providerMatch[2] ?? '').toLowerCase();
      const subcommands = ['add', 'list', 'use', 'remove', 'test', 'help'];
      const matches = subcommands
        .filter((cmd) => cmd.startsWith(partial))
        .map((cmd) => `/${prefix} ${cmd}`);
      return [matches, line];
    }

    // Check for /index command with at least one space after
    const indexMatch = line.match(/^\/(index)\s+(.*)$/i);
    if (indexMatch) {
      const partial = indexMatch[2] ?? '';

      // Don't complete if user is typing flags (-n, --force, etc.)
      if (partial.startsWith('-')) {
        return [[], line];
      }

      // Don't complete if partial is 'status' (subcommand)
      if (partial.toLowerCase() === 'status' || partial.toLowerCase().startsWith('status')) {
        return [['/index status'], line];
      }

      // Complete directory paths
      const matches = completeDirectoryPath(partial);
      return [matches.map((m) => `/index ${m}`), line];
    }

    // Check for @ file reference (anywhere in the line)
    // Match @partial at the end of the line or before a space
    const atMatch = line.match(/@([^\s@]*)$/);
    if (atMatch) {
      const projectId = getCurrentProjectId();
      if (projectId !== null) {
        const partial = atMatch[1] ?? '';
        const fileNames = completeFileNames(projectId, partial);

        // Replace the @partial with @filename in the completions
        const linePrefix = line.slice(0, line.length - atMatch[0].length);
        const matches = fileNames.map((name) => `${linePrefix}@${name}`);
        return [matches, line];
      }
      // No project focused - can't complete files
      return [[], line];
    }

    // No completion for other input
    return [[], line];
  };
}

/**
 * Main REPL loop using readline.
 *
 * Uses event-based pattern (rl.on('line', ...)) instead of async iterator
 * (for await) for robustness. The async iterator pattern can exit prematurely
 * when combined with other async operations like streaming LLM responses.
 */
async function runChatREPL(
  state: ChatState,
  ctx: CommandContext
): Promise<void> {
  return new Promise((resolve) => {
    // Create completer with state-aware project ID getter for @file completion
    const completer = createCompleter(
      getAllProjectNames,
      () => (state.currentProject ? state.currentProject.id : null)
    );

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: getPrompt(state),
      completer,
    });

    // Store rl in state so handlers can update prompt
    state.rl = rl;

    // Track if we've already cleaned up to prevent double-cleanup
    let cleanedUp = false;
    const cleanup = () => {
      if (!cleanedUp) {
        cleanedUp = true;
        cleanupChatState(state);
      }
    };

    // ─────────────────────────────────────────────────────────────────────
    // Register all event handlers BEFORE calling prompt()
    // This ensures no input is lost to unregistered handlers
    // ─────────────────────────────────────────────────────────────────────

    // Handle each line of input
    rl.on('line', async (line) => {
      const input = line.trim();

      // Skip empty input
      if (!input) {
        rl.prompt();
        return;
      }

      // Check for REPL commands
      const replCmd = parseREPLCommand(input);
      if (replCmd) {
        try {
          const shouldContinue = await replCmd.command.handler(
            replCmd.args,
            state,
            ctx
          );
          if (!shouldContinue) {
            cleanup();
            rl.close();
            resolve();
            return;
          }
        } catch (error) {
          ctx.error(`Command failed: ${error}`);
        }
        rl.prompt();
        return;
      }

      // Handle as question
      try {
        await handleQuestion(input, state, ctx);
      } catch (error) {
        if (error instanceof CLIError) {
          ctx.error(error.message);
          if (error.hint) {
            ctx.log(chalk.dim(error.hint));
          }
        } else {
          ctx.error(`Failed to process question: ${error}`);
        }
      }

      rl.prompt();
    });

    // Handle Ctrl+C gracefully
    // First Ctrl+C cancels background indexing if running
    // Second Ctrl+C (or first if no indexing) exits chat
    rl.on('SIGINT', () => {
      const coordinator = getBackgroundIndexingCoordinator();

      // If indexing is running, first Ctrl+C cancels it
      if (coordinator.isRunning()) {
        coordinator.cancel();
        ctx.log('');
        ctx.log(chalk.yellow('Indexing cancelled.'));
        rl.prompt();
        return;
      }

      // No indexing running - exit chat
      ctx.log('');
      ctx.log(chalk.dim('Goodbye!'));
      cleanup();
      rl.close();
      resolve();
    });

    // Handle stream close (EOF, pipe closed, etc.)
    // This is a safety net for unexpected closures
    rl.on('close', () => {
      cleanup();
      resolve();
    });

    // All handlers registered - now safe to start accepting input
    displayWelcome(state, ctx);
    rl.prompt();
  });
}

// ============================================================================
// Command Factory
// ============================================================================

/**
 * Create the chat command.
 *
 * @param getContext - Factory to get command context with global options
 * @returns Configured Commander command
 */
export function createChatCommand(getContext: () => CommandContext): Command {
  return new Command('chat')
    .description('Interactive multi-turn chat with RAG-powered Q&A')
    .option('-p, --project <name>', 'Start focused on a specific project')
    .action(async (cmdOptions: ChatCommandOptions) => {
      const ctx = getContext();

      ctx.debug('Starting chat session...');

      // ─────────────────────────────────────────────────────────────────────
      // 1. Load config
      // ─────────────────────────────────────────────────────────────────────
      const config = loadConfig();
      ctx.debug(`LLM: ${config.default_model ?? 'default'}`);

      // ─────────────────────────────────────────────────────────────────────
      // 2. Resolve initial project (optional)
      // ─────────────────────────────────────────────────────────────────────
      let currentProject: Project | null = null;
      let ragEngine: ContextExpertRAGEngine | null = null;

      if (cmdOptions.project) {
        const project = findProject(cmdOptions.project);
        if (!project) {
          throw new CLIError(
            `Project not found: ${cmdOptions.project}`,
            'Run: ctx list  to see available projects'
          );
        }
        currentProject = project;
        ctx.debug(`Initial project: ${project.name}`);

        // Create RAG engine for the project
        ragEngine = await createRAGEngine(config, String(project.id));
      } else {
        // Try to use the most recent project as default
        const recent = getMostRecentProject();
        if (recent) {
          // Validate that the project path still exists on disk
          if (!existsSync(recent.path)) {
            // Path no longer exists - don't auto-focus on stale project
            ctx.debug(`Skipping stale project: ${recent.name} (path missing: ${recent.path})`);
          } else {
            currentProject = recent;
            ragEngine = await createRAGEngine(config, String(recent.id));
            ctx.debug(`Using most recent project: ${recent.name}`);
          }
        }
      }

      // ─────────────────────────────────────────────────────────────────────
      // 3. Create LLM provider (cached for session)
      // ─────────────────────────────────────────────────────────────────────
      ctx.debug('Creating LLM provider...');

      let provider: ChatState['llmProvider'];
      let providerName: string;
      let model: string;

      // First, check for a stored default provider from /provider add
      const storedProvider = getDefaultProvider();
      if (storedProvider) {
        ctx.debug(`Using stored provider: ${storedProvider.name}`);
        try {
          const result = await createProviderFromConfig(
            storedProvider.name,
            storedProvider.config
          );
          provider = result.provider;
          providerName = result.displayName;
          model = result.model;
        } catch (error) {
          // If stored provider fails, fall back to config-based
          ctx.debug(
            `Stored provider failed, falling back: ${error instanceof Error ? error.message : String(error)}`
          );
          const result = await createLLMProvider(config, {
            fallback: {
              onFallback: (from, to, reason) => {
                ctx.debug(`LLM fallback: ${from} → ${to} (${reason})`);
              },
            },
          });
          provider = result.provider;
          providerName = result.name;
          model = result.model;
        }
      } else {
        // No stored provider, use config-based with fallback chain
        const result = await createLLMProvider(config, {
          fallback: {
            onFallback: (from, to, reason) => {
              ctx.debug(`LLM fallback: ${from} → ${to} (${reason})`);
            },
          },
        });
        provider = result.provider;
        providerName = result.name;
        model = result.model;
      }

      ctx.debug(`Using: ${providerName}/${model}`);

      // ─────────────────────────────────────────────────────────────────────
      // 4. Initialize conversation context (from @contextaisdk/core)
      // ─────────────────────────────────────────────────────────────────────
      const conversationContext = new ConversationContext({
        maxTokens: MAX_CONTEXT_TOKENS,
      });

      // ─────────────────────────────────────────────────────────────────────
      // 5. Initialize query router for smart project selection
      // ─────────────────────────────────────────────────────────────────────
      const db = getDb();
      const allProjectsRaw = db
        .prepare('SELECT id, name, description, tags, file_count, chunk_count FROM projects')
        .all() as Array<{
          id: string;
          name: string;
          description: string | null;
          tags: string | null;
          file_count: number;
          chunk_count: number;
        }>;

      const allProjects: ProjectMetadata[] = allProjectsRaw.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        tags: safeParseJsonArray(p.tags),
        fileCount: p.file_count,
        chunkCount: p.chunk_count,
      }));

      // Create router for query intent classification (heuristic-only)
      // Note: Passing null disables LLM-based routing, uses heuristics instead
      const queryRouter = allProjects.length > 0
        ? createProjectRouter(null)
        : null;

      if (queryRouter) {
        queryRouter.updateProjects(allProjects);
      }

      // ─────────────────────────────────────────────────────────────────────
      // 5b. Create RoutingRAGEngine (unified routing + search)
      // ─────────────────────────────────────────────────────────────────────
      let routingEngine: RoutingRAGEngine | null = null;

      if (allProjects.length > 0) {
        ctx.debug('Creating RoutingRAGEngine...');
        try {
          // Create embedding provider for multi-project search
          const { provider: embeddingProvider, dimensions } = await createEmbeddingProvider(
            config.embedding,
            { onProgress: (p) => ctx.debug(`Embedding init: ${p.status}`) }
          );

          routingEngine = createRoutingRAGEngine({
            config,
            embeddingProvider,
            dimensions,
            forceRAG: true, // Always search when projects exist
            llmProvider: null, // Heuristic-only routing for now
          });

          ctx.debug('RoutingRAGEngine created successfully');
        } catch (error) {
          ctx.debug(`Failed to create RoutingRAGEngine: ${error}`);
          // Fall back to legacy ragEngine + queryRouter approach
        }
      }

      // ─────────────────────────────────────────────────────────────────────
      // 6. Build state and start REPL
      // ─────────────────────────────────────────────────────────────────────
      const state: ChatState = {
        currentProject,
        conversationContext,
        ragEngine,
        llmProvider: provider,
        providerInfo: { name: providerName, model },
        config,
        queryRouter,
        allProjects,
        routingEngine,
      };

      await runChatREPL(state, ctx);
    });
}
