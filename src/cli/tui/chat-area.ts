/**
 * Chat Area Manager
 *
 * Manages the scrollable chat region:
 * - Renders user messages and assistant responses
 * - Handles streaming output (character by character)
 * - Formats markdown for terminal display
 * - Shows citations/sources
 *
 * The chat area lives in the scroll region managed by TerminalRegionManager.
 * Content written here scrolls within the region; status/input stay fixed.
 */

import chalk from 'chalk';
import type { TerminalRegionManager } from './terminal-regions.js';

/**
 * Pattern matching ANSI escape sequences: CSI, DEC save/restore, and OSC.
 * Used to strip raw sequences from untrusted content (e.g. LLM output)
 * before rendering, preventing terminal injection attacks.
 */
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\x1b[78]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
import type {
  DisplayMessage,
  MessageRole,
  SourceReference,
} from './types.js';

/**
 * Options for ChatAreaManager.
 */
export interface ChatAreaManagerOptions {
  /** Enable markdown rendering (default: true) */
  enableMarkdown?: boolean;
  /** Show timestamps (default: false) */
  showTimestamps?: boolean;
  /** Timestamp format if enabled */
  timestampFormat?: string;
  /** Max width for message wrapping */
  maxWidth?: number;
}

/**
 * Role prefixes and colors for message display.
 */
const ROLE_STYLES: Record<MessageRole, { prefix: string; color: typeof chalk }> = {
  user: { prefix: 'You:', color: chalk.green },
  assistant: { prefix: 'Assistant:', color: chalk.cyan },
  system: { prefix: 'System:', color: chalk.yellow },
  info: { prefix: 'ℹ', color: chalk.dim },
};

/**
 * Manages the chat message display area.
 *
 * Usage:
 * ```typescript
 * const chat = new ChatAreaManager(regionManager);
 *
 * // Add a user message
 * chat.addUserMessage('How does authentication work?');
 *
 * // Stream an assistant response
 * chat.startStream();
 * for await (const chunk of llmStream) {
 *   chat.streamChunk(chunk);
 * }
 * chat.endStream(sources);
 * ```
 */
export class ChatAreaManager {
  private regionManager: TerminalRegionManager;
  private messages: DisplayMessage[] = [];
  private isStreaming: boolean = false;
  private streamBuffer: string = '';
  private enableMarkdown: boolean;
  private showTimestamps: boolean;
  /** Max width for future word-wrapping implementation */
  readonly maxWidth: number;

  // Track if we need a newline before next message
  private needsNewline: boolean = false;

  constructor(
    regionManager: TerminalRegionManager,
    options: ChatAreaManagerOptions = {}
  ) {
    this.regionManager = regionManager;
    this.enableMarkdown = options.enableMarkdown ?? true;
    this.showTimestamps = options.showTimestamps ?? false;
    this.maxWidth = options.maxWidth ?? 80;
  }

  /**
   * Add a user message and display it.
   *
   * @param content - The user's input
   */
  addUserMessage(content: string): void {
    const message = this.createMessage('user', content);
    this.messages.push(message);
    this.displayMessage(message);
  }

  /**
   * Add an info message (system notifications, hints, etc.)
   *
   * @param content - The info text
   * @param options - Display options (compact: reduce vertical spacing)
   */
  addInfoMessage(content: string, options?: { compact?: boolean }): void {
    const message = this.createMessage('info', content);
    this.messages.push(message);
    this.displayMessage(message, options);
  }

  /**
   * Add a system message.
   *
   * @param content - The system text
   */
  addSystemMessage(content: string): void {
    const message = this.createMessage('system', content);
    this.messages.push(message);
    this.displayMessage(message);
  }

  /**
   * Start streaming an assistant response.
   * Call streamChunk() for each token, then endStream().
   *
   * Uses beginChatStream() to position cursor in the chat area
   * via CUP (not SAVE/RESTORE), so streaming chunks write at
   * the correct position without conflicting with status bar updates.
   */
  startStream(): void {
    if (this.isStreaming) {
      // Already streaming - end previous stream first
      this.endStream();
    }

    this.isStreaming = true;
    this.streamBuffer = '';

    // Position cursor in chat area (leaves cursor there for streaming)
    this.regionManager.beginChatStream();

    // Write assistant prefix directly in the chat area
    const style = ROLE_STYLES.assistant;
    this.regionManager.streamToChatArea(`${style.color(style.prefix)} `);
  }

  /**
   * Stream a chunk of text to the chat area.
   * Call this for each token from the LLM.
   *
   * @param chunk - A chunk of text to append
   */
  streamChunk(chunk: string): void {
    if (!this.isStreaming) {
      // Not in streaming mode - start a stream
      this.startStream();
    }

    this.streamBuffer += chunk;

    // Write directly to output for real-time display
    this.regionManager.streamToChatArea(chunk);
  }

  /**
   * End the current stream and finalize the message.
   *
   * Writes trailing content while still in streaming mode (cursor in chat area),
   * then calls endChatStream() to return cursor to the input area.
   * Sources and trailing blank line use writeToChatArea (cursor save/restore).
   *
   * @param sources - Optional RAG sources to display
   */
  endStream(sources?: SourceReference[]): void {
    if (!this.isStreaming) {
      return;
    }

    // Create the complete message record
    const message = this.createMessage('assistant', this.streamBuffer);
    message.sources = sources;
    this.messages.push(message);

    // Trailing newline while still in streaming mode
    this.regionManager.streamToChatArea('\n');

    // Exit streaming mode — cursor returns to input area
    this.regionManager.endChatStream();

    // Sources and trailing blank line use writeToChatArea (cursor save/restore)
    if (sources && sources.length > 0) {
      this.displaySources(sources);
    }
    this.write('\n');

    this.isStreaming = false;
    this.streamBuffer = '';
    this.needsNewline = false;
  }

  /**
   * Add a complete assistant message (non-streaming).
   *
   * @param content - The full message content
   * @param sources - Optional RAG sources
   */
  addAssistantMessage(content: string, sources?: SourceReference[]): void {
    const message = this.createMessage('assistant', content);
    message.sources = sources;
    this.messages.push(message);
    this.displayMessage(message);

    if (sources && sources.length > 0) {
      this.displaySources(sources);
    }
  }

  /**
   * Clear all messages from display and memory.
   */
  clear(): void {
    this.messages = [];
    this.regionManager.clearChatArea();
    this.needsNewline = false;
  }

  /**
   * Get all stored messages.
   */
  getMessages(): DisplayMessage[] {
    return [...this.messages];
  }

  /**
   * Get the last N messages.
   */
  getRecentMessages(count: number): DisplayMessage[] {
    return this.messages.slice(-count);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Create a new message object.
   */
  private createMessage(role: MessageRole, content: string): DisplayMessage {
    return {
      id: this.generateId(),
      role,
      content,
      timestamp: new Date(),
    };
  }

  /**
   * Generate a unique message ID.
   */
  private generateId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * Display a complete message to the chat area.
   *
   * @param message - The message to display
   * @param options - Display options (compact: use single newline instead of double)
   */
  private displayMessage(
    message: DisplayMessage,
    options?: { compact?: boolean }
  ): void {
    this.ensureNewline();

    const style = ROLE_STYLES[message.role];
    const prefix = style.color(style.prefix);

    // Format the content
    let content = message.content;

    // Apply markdown rendering if enabled (for assistant messages)
    if (this.enableMarkdown && message.role === 'assistant') {
      content = this.renderMarkdown(content);
    }

    // Build the display line
    let display = `${prefix} ${content}`;

    // Add timestamp if enabled
    if (this.showTimestamps) {
      const time = this.formatTimestamp(message.timestamp);
      display = `${chalk.dim(time)} ${display}`;
    }

    // Single write call: avoids extra scroll trigger from separate write('\n\n').
    // Compact mode uses '\n' for tighter spacing (e.g. indexing stage messages).
    const trailing = options?.compact ? '\n' : '\n\n';
    this.write(display + trailing);
    this.needsNewline = false;
  }

  /**
   * Display RAG sources/citations.
   */
  private displaySources(sources: SourceReference[]): void {
    if (sources.length === 0) return;

    this.write(chalk.dim('\nSources:\n'));

    sources.forEach((source, index) => {
      const num = `[${index + 1}]`;
      let line = `  ${chalk.cyan(num)} ${source.path}`;

      if (source.lines) {
        line += chalk.dim(` (lines ${source.lines.start}-${source.lines.end})`);
      }

      if (source.score !== undefined) {
        const scorePercent = Math.round(source.score * 100);
        line += chalk.dim(` - ${scorePercent}% relevant`);
      }

      this.write(line + '\n');
    });
  }

  /**
   * Render markdown content for terminal display.
   *
   * This is a simplified markdown renderer. For production,
   * consider using `marked` + `marked-terminal` for full support.
   */
  private renderMarkdown(content: string): string {
    // Strip raw ANSI escape sequences from LLM output to prevent terminal injection
    // (cursor manipulation, screen clearing, color corruption)
    const sanitized = content.replace(ANSI_ESCAPE_PATTERN, '');

    return sanitized
      // Bold: **text** or __text__
      .replace(/\*\*(.+?)\*\*/g, chalk.bold('$1'))
      .replace(/__(.+?)__/g, chalk.bold('$1'))
      // Italic: *text* or _text_ (not inside bold)
      .replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, chalk.italic('$1'))
      // Code: `code`
      .replace(/`([^`]+?)`/g, chalk.yellow('$1'))
      // Links: [text](url) -> text (url)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, `$1 ${chalk.dim('($2)')}`);
  }

  /**
   * Format a timestamp for display.
   */
  private formatTimestamp(date: Date): string {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  /**
   * Ensure there's a newline before writing (for message separation).
   */
  private ensureNewline(): void {
    if (this.needsNewline) {
      this.write('\n');
      this.needsNewline = false;
    }
  }

  /**
   * Write content to the chat area.
   */
  private write(content: string): void {
    this.regionManager.writeToChatArea(content);
  }
}

/**
 * Create a pre-configured chat area manager.
 */
export function createChatAreaManager(
  regionManager: TerminalRegionManager,
  options?: ChatAreaManagerOptions
): ChatAreaManager {
  return new ChatAreaManager(regionManager, options);
}
