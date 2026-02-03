/**
 * Share Command Handler
 *
 * Exports the current conversation to a shareable markdown file.
 *
 * Usage:
 *   /share           - Export to ~/.ctx/exports/conversation-<timestamp>.md
 *   /share <path>    - Export to custom path
 *
 * @example
 * ```
 * > /share
 * Conversation saved to: ~/.ctx/exports/conversation-2026-02-03-093000.md
 * ```
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import type { ChatState } from './chat.js';
import type { CommandContext } from '../types.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Default export directory under ~/.ctx/
 */
const DEFAULT_EXPORT_DIR = join(homedir(), '.ctx', 'exports');

// ============================================================================
// Types
// ============================================================================

/**
 * Options for the share command.
 */
interface ShareOptions {
  /** Custom output path (optional) */
  outputPath?: string;
  /** Whether to copy path to clipboard */
  copyToClipboard?: boolean;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Handle the /share command.
 *
 * Exports the current conversation to a markdown file and optionally
 * copies the path to the clipboard.
 *
 * @param args - Command arguments (optional custom path)
 * @param state - Current chat state with conversation history
 * @param ctx - Command context for logging
 * @returns true to continue REPL
 */
export async function handleShareCommand(
  args: string[],
  state: ChatState,
  ctx: CommandContext
): Promise<boolean> {
  // Parse optional custom path from args
  const customPath = args.length > 0 ? args.join(' ').trim() : undefined;

  const options: ShareOptions = {
    outputPath: customPath,
    copyToClipboard: true,
  };

  try {
    const result = await exportConversation(state, options);

    // Show success message
    ctx.log('');
    ctx.log(chalk.green('✓ ') + chalk.bold('Conversation exported'));
    ctx.log(chalk.dim('  Path: ') + chalk.cyan(result.path));
    ctx.log(chalk.dim('  Messages: ') + `${result.messageCount}`);

    if (result.copiedToClipboard) {
      ctx.log(chalk.dim('  Clipboard: ') + chalk.green('Path copied'));
    }

    ctx.log('');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.error(`Failed to export conversation: ${message}`);
  }

  return true;
}

// ============================================================================
// Core Export Logic
// ============================================================================

/**
 * Result of exporting a conversation.
 */
interface ExportResult {
  /** Full path to the exported file */
  path: string;
  /** Number of messages exported */
  messageCount: number;
  /** Whether the path was copied to clipboard */
  copiedToClipboard: boolean;
}

/**
 * Export the conversation to a markdown file.
 *
 * @param state - Chat state with conversation history
 * @param options - Export options
 * @returns Export result with path and stats
 */
async function exportConversation(
  state: ChatState,
  options: ShareOptions
): Promise<ExportResult> {
  // Get messages from conversation context
  const messages = state.conversationContext.getMessages();

  if (messages.length === 0) {
    throw new Error('No messages to export. Start a conversation first.');
  }

  // Generate markdown content
  const markdown = formatConversationAsMarkdown(state, messages);

  // Determine output path
  const outputPath = options.outputPath ?? generateDefaultPath();

  // Ensure directory exists
  const dir = dirname(outputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Write file
  writeFileSync(outputPath, markdown, 'utf-8');

  // Try to copy to clipboard
  let copiedToClipboard = false;
  if (options.copyToClipboard) {
    copiedToClipboard = copyToClipboard(outputPath);
  }

  return {
    path: outputPath,
    messageCount: messages.length,
    copiedToClipboard,
  };
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format conversation as markdown.
 */
function formatConversationAsMarkdown(
  state: ChatState,
  messages: Array<{ role: string; content: string }>
): string {
  const lines: string[] = [];

  // Header
  lines.push('# Context Expert Conversation');
  lines.push('');

  // Metadata
  const now = new Date();
  lines.push(`**Date**: ${formatDate(now)}`);

  if (state.currentProject) {
    lines.push(`**Project**: ${state.currentProject.name}`);
  } else {
    lines.push('**Project**: No project focused');
  }

  lines.push(`**Provider**: ${state.providerInfo.name}/${state.providerInfo.model}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Messages
  for (const message of messages) {
    // Skip system messages (they're internal context)
    if (message.role === 'system') {
      continue;
    }

    const roleLabel = message.role === 'user' ? 'User' : 'Assistant';
    lines.push(`## ${roleLabel}`);
    lines.push('');
    lines.push(message.content);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Footer
  lines.push('');
  lines.push(`*Exported from [Context Expert](https://github.com/contextexpert/cli) on ${formatDate(now)}*`);

  return lines.join('\n');
}

/**
 * Format date as human-readable string.
 */
function formatDate(date: Date): string {
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Generate timestamp string for filename.
 */
function formatTimestamp(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

/**
 * Generate default output path with timestamp.
 */
function generateDefaultPath(): string {
  const timestamp = formatTimestamp(new Date());
  return join(DEFAULT_EXPORT_DIR, `conversation-${timestamp}.md`);
}

// ============================================================================
// Clipboard
// ============================================================================

/**
 * Copy text to system clipboard.
 *
 * Uses platform-specific commands:
 * - macOS: pbcopy
 * - Linux: xclip or xsel
 * - Windows: clip
 *
 * @param text - Text to copy
 * @returns true if successful, false if clipboard unavailable
 */
function copyToClipboard(text: string): boolean {
  try {
    const platform = process.platform;

    if (platform === 'darwin') {
      // macOS
      execSync('pbcopy', { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
      return true;
    } else if (platform === 'linux') {
      // Try xclip first, then xsel
      try {
        execSync('xclip -selection clipboard', {
          input: text,
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        return true;
      } catch {
        try {
          execSync('xsel --clipboard --input', {
            input: text,
            stdio: ['pipe', 'ignore', 'ignore'],
          });
          return true;
        } catch {
          return false;
        }
      }
    } else if (platform === 'win32') {
      // Windows
      execSync('clip', { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
      return true;
    }

    return false;
  } catch {
    // Clipboard not available
    return false;
  }
}

/**
 * Contract home directory to ~ for display.
 */
export function contractPath(path: string): string {
  const home = homedir();
  if (path.startsWith(home)) {
    return '~' + path.slice(home.length);
  }
  return path;
}
