/**
 * Chat Command
 *
 * Interactive multi-turn chat REPL with RAG-powered Q&A.
 * Maintains conversation history within a session and supports
 * REPL commands for project switching, history clearing, etc.
 *
 *   ctx chat                     # Start chat (uses most recent project)
 *   ctx chat --project my-app    # Start focused on specific project
 *
 * REPL Commands:
 *   /help      - Show available commands
 *   /focus X   - Switch to project X
 *   /unfocus   - Clear project scope
 *   /projects  - List available projects
 *   /clear     - Clear conversation history
 *   exit       - Exit the chat
 */

import * as readline from 'node:readline';
import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import type { CommandContext } from '../types.js';
import {
  ConversationContext,
  type ChatMessage,
  type StreamChunk,
  type TokenUsage,
} from '@contextaisdk/core';
import { getDb, runMigrations } from '../../database/index.js';
import { loadConfig, type Config } from '../../config/loader.js';
import { createRAGEngine, type ContextExpertRAGEngine } from '../../agent/rag-engine.js';
import { formatCitations } from '../../agent/citations.js';
import { createLLMProvider } from '../../providers/llm.js';
import { CLIError } from '../../errors/index.js';
import type { Project } from '../../database/schema.js';

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
 */
interface ChatState {
  /** Currently focused project (null = no RAG, pure LLM mode) */
  currentProject: Project | null;
  /** Conversation history with automatic truncation (from @contextaisdk/core) */
  conversationContext: ConversationContext;
  /** RAG engine for current project (null if unfocused) */
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
      const newRagEngine = await createRAGEngine(
        state.config,
        String(project.id)
      );
      state.currentProject = project;
      state.ragEngine = newRagEngine;

      ctx.log(chalk.blue(`Focused on: ${project.name}`));
      if (!existsSync(project.path)) {
        ctx.log(
          chalk.yellow(`Warning: Project path no longer exists: ${project.path}`)
        );
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
    name: 'exit',
    aliases: ['quit', 'q'],
    description: 'Exit the chat',
    handler: async (_args, _state, ctx) => {
      ctx.log(chalk.dim('Goodbye!'));
      return false; // Signal to exit REPL
    },
  },
];

// ============================================================================
// Helper Functions
// ============================================================================

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
 * Parse user input to detect REPL commands.
 * Returns null if it's a regular question.
 */
function parseREPLCommand(
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

  for await (const chunk of stream) {
    if (chunk.type === 'text' && chunk.content) {
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
 * Handle a user question: RAG search (if focused) + LLM generation.
 */
async function handleQuestion(
  question: string,
  state: ChatState,
  ctx: CommandContext
): Promise<void> {
  let ragContext = '';
  let sources: Array<{
    id: number;
    filePath: string;
    startLine?: number;
    endLine?: number;
    score: number;
  }> = [];

  // 1. RAG search if focused on a project
  if (state.ragEngine && state.currentProject) {
    ctx.log(chalk.dim(`Searching ${state.currentProject.name}...`));

    try {
      const ragResult = await state.ragEngine.search(question, { finalK: 5 });
      ragContext = ragResult.content;
      sources = ragResult.sources;
      ctx.debug(`Retrieved ${sources.length} sources`);
    } catch (error) {
      ctx.debug(`RAG search failed: ${error}`);
      // Continue without context
    }
  }

  // 2. Build messages for LLM
  const systemPrompt = buildSystemPrompt(ragContext);
  const conversationMessages = state.conversationContext.getMessages();

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...conversationMessages,
    { role: 'user', content: question },
  ];

  // 3. Stream response
  ctx.log(''); // Blank line before response
  const { content } = await streamResponse(state, messages, ctx);

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
    ctx.log(chalk.dim('No project focused (pure LLM mode)'));
    ctx.log(chalk.dim('Use /focus <project> to enable RAG search'));
  }

  ctx.log('');
  ctx.log(chalk.dim('Type /help for commands, "exit" to quit'));
  ctx.log('');
}

/**
 * Main REPL loop using readline.
 */
async function runChatREPL(
  state: ChatState,
  ctx: CommandContext
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.green('> '),
  });

  // Handle Ctrl+C gracefully
  rl.on('SIGINT', () => {
    ctx.log('');
    ctx.log(chalk.dim('Goodbye!'));
    rl.close();
  });

  displayWelcome(state, ctx);
  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();

    // Skip empty input
    if (!input) {
      rl.prompt();
      continue;
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
          rl.close();
          return;
        }
      } catch (error) {
        ctx.error(`Command failed: ${error}`);
      }
      rl.prompt();
      continue;
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
  }
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
      ctx.debug(`LLM: ${config.llm?.model ?? 'default'}`);

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
          currentProject = recent;
          ragEngine = await createRAGEngine(config, String(recent.id));
          ctx.debug(`Using most recent project: ${recent.name}`);
        }
      }

      // ─────────────────────────────────────────────────────────────────────
      // 3. Create LLM provider (cached for session)
      // ─────────────────────────────────────────────────────────────────────
      ctx.debug('Creating LLM provider...');
      const {
        provider,
        name: providerName,
        model,
      } = await createLLMProvider(config, {
        fallback: {
          onFallback: (from, to, reason) => {
            ctx.debug(`LLM fallback: ${from} → ${to} (${reason})`);
          },
        },
      });

      ctx.debug(`Using: ${providerName}/${model}`);

      // ─────────────────────────────────────────────────────────────────────
      // 4. Initialize conversation context (from @contextaisdk/core)
      // ─────────────────────────────────────────────────────────────────────
      const conversationContext = new ConversationContext({
        maxTokens: MAX_CONTEXT_TOKENS,
      });

      // ─────────────────────────────────────────────────────────────────────
      // 5. Build state and start REPL
      // ─────────────────────────────────────────────────────────────────────
      const state: ChatState = {
        currentProject,
        conversationContext,
        ragEngine,
        llmProvider: provider,
        providerInfo: { name: providerName, model },
        config,
      };

      await runChatREPL(state, ctx);
    });
}
