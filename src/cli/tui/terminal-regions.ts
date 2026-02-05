/**
 * Terminal Region Manager
 *
 * Manages three fixed regions in the terminal using ANSI escape sequences:
 * 1. Chat area (top, scrollable) - Where messages are displayed
 * 2. Status bar (bottom-2, fixed) - Mode, context, cost info
 * 3. Input area (bottom, fixed) - Where user types (readline)
 *
 * This uses DECSTBM (Set Top and Bottom Margins) to create a scroll region
 * for the chat area while keeping status and input fixed.
 *
 * Key ANSI sequences:
 * - CSI n;m r  (DECSTBM) - Set scroll region between rows n and m
 * - CSI n;m H  (CUP) - Cursor position to row n, column m
 * - CSI 2K     (EL2) - Erase entire line
 * - CSI ?2026h/l - Synchronized output (prevents flickering)
 *
 * @see https://gist.github.com/christianparpart/d8a62cc1ab659194337d73e399004036
 */

import { EventEmitter } from 'node:events';
import type { RegionBounds } from './types.js';

/** Pattern matching ANSI escape sequences (CSI, DEC save/restore, OSC). */
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\x1b[78]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * ANSI escape sequence constants.
 * Using named constants makes the code more readable and maintainable.
 */
export const ANSI = {
  // Escape sequence prefix
  ESC: '\x1b',
  CSI: '\x1b[',

  // Cursor save/restore (DEC private)
  SAVE_CURSOR: '\x1b7',
  RESTORE_CURSOR: '\x1b8',

  // Cursor positioning
  cursorTo: (row: number, col: number = 1): string => `\x1b[${row};${col}H`,
  cursorUp: (n: number = 1): string => `\x1b[${n}A`,
  cursorDown: (n: number = 1): string => `\x1b[${n}B`,

  // Scroll region (DECSTBM - Set Top and Bottom Margins)
  // This is the key sequence for creating fixed regions
  setScrollRegion: (top: number, bottom: number): string => `\x1b[${top};${bottom}r`,
  resetScrollRegion: '\x1b[r', // Reset to full screen

  // Erase operations
  CLEAR_LINE: '\x1b[2K', // Erase entire line
  CLEAR_TO_END: '\x1b[K', // Erase from cursor to end of line
  CLEAR_SCREEN: '\x1b[2J', // Erase entire screen
  CLEAR_SCROLLBACK: '\x1b[3J', // Clear scrollback buffer

  // Synchronized output (DEC mode 2026)
  // Prevents flickering by buffering output until END_SYNC
  BEGIN_SYNC: '\x1b[?2026h',
  END_SYNC: '\x1b[?2026l',

  // Alternate screen buffer (like vim/less use)
  ENTER_ALT_SCREEN: '\x1b[?1049h',
  EXIT_ALT_SCREEN: '\x1b[?1049l',

  // Text attributes
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  REVERSE: '\x1b[7m',
} as const;

/**
 * Options for TerminalRegionManager initialization.
 */
/** Minimum rows needed for 3-region layout (chat + status + input). */
const MIN_TERMINAL_ROWS = 3;

export interface TerminalRegionManagerOptions {
  /** Height of status bar in lines (default: 1) */
  statusBarHeight?: number;
  /** Height of input area in lines (default: 1) */
  inputAreaHeight?: number;
  /** Use alternate screen buffer (default: false) */
  useAlternateScreen?: boolean;
  /** Enable synchronized output to prevent flickering (default: true) */
  useSynchronizedOutput?: boolean;
  /** stdout stream (default: process.stdout) */
  stdout?: NodeJS.WriteStream;
}

/**
 * Events emitted by TerminalRegionManager.
 */
export interface TerminalRegionManagerEvents {
  resize: [{ rows: number; cols: number }];
  initialized: [];
  cleanup: [];
}

/**
 * Manages terminal screen regions for the TUI.
 *
 * Layout (status bar at bottom):
 * ```
 * Row 1     ┌─────────────────────────────┐
 *           │                             │
 *           │     Chat Area (scrolls)     │  <- Scroll region
 *           │                             │
 * Row N-2   └─────────────────────────────┘
 * Row N-1   │ Status Bar (fixed)          │  <- Fixed
 * Row N     │ Input Area (fixed)          │  <- Fixed (readline)
 * ```
 *
 * The scroll region is set to rows 1 through (height - statusBarHeight - inputAreaHeight).
 * Content written to the chat area scrolls within this region.
 * Status bar and input area stay fixed at the bottom.
 */
export class TerminalRegionManager extends EventEmitter<TerminalRegionManagerEvents> {
  private stdout: NodeJS.WriteStream;
  private rows: number = 24; // Terminal height
  private cols: number = 80; // Terminal width
  private statusBarHeight: number;
  private inputAreaHeight: number;
  private useAlternateScreen: boolean;
  private useSynchronizedOutput: boolean;
  private isInitialized: boolean = false;
  private resizeHandler: (() => void) | null = null;
  private _isStreaming: boolean = false;

  // Computed region bounds
  private chatRegion!: RegionBounds;
  private statusRegion!: RegionBounds;
  private inputRegion!: RegionBounds;

  constructor(options: TerminalRegionManagerOptions = {}) {
    super();
    this.stdout = options.stdout ?? process.stdout;
    this.statusBarHeight = options.statusBarHeight ?? 1;
    this.inputAreaHeight = options.inputAreaHeight ?? 1;
    this.useAlternateScreen = options.useAlternateScreen ?? false;
    this.useSynchronizedOutput = options.useSynchronizedOutput ?? true;
  }

  /**
   * Initialize the terminal layout.
   * Sets up scroll regions, clears the screen, and positions cursor.
   */
  initialize(): void {
    if (this.isInitialized) {
      return;
    }

    // Get terminal dimensions
    this.updateDimensions();

    // Enter alternate screen buffer if requested
    // This preserves the user's scrollback when they exit
    if (this.useAlternateScreen) {
      this.write(ANSI.ENTER_ALT_SCREEN);
    }

    // Clear screen and set up regions
    this.write(ANSI.CLEAR_SCREEN);
    this.computeRegions();
    this.applyScrollRegion();

    // Position cursor in input area
    this.focusInputArea();

    // Listen for terminal resize
    this.resizeHandler = this.handleResize.bind(this);
    this.stdout.on('resize', this.resizeHandler);

    this.isInitialized = true;
    this.emit('initialized');
  }

  /**
   * Update terminal dimensions from stdout.
   */
  private updateDimensions(): void {
    this.rows = this.stdout.rows || 24;   // || catches both null/undefined and 0
    this.cols = this.stdout.columns || 80;
  }

  /**
   * Compute region bounds based on current terminal size.
   */
  private computeRegions(): void {
    // Clamp rows to minimum to prevent negative region bounds
    const rows = Math.max(this.rows, MIN_TERMINAL_ROWS);

    // Input area is at the very bottom
    const inputEnd = rows;
    const inputStart = inputEnd - this.inputAreaHeight + 1;

    // Status bar is just above input
    const statusEnd = inputStart - 1;
    const statusStart = statusEnd - this.statusBarHeight + 1;

    // Chat area fills the rest (from top to just above status)
    const chatStart = 1;
    const chatEnd = Math.max(chatStart, statusStart - 1);

    this.chatRegion = { startRow: chatStart, endRow: chatEnd };
    this.statusRegion = { startRow: statusStart, endRow: statusEnd };
    this.inputRegion = { startRow: inputStart, endRow: inputEnd };
  }

  /**
   * Apply the scroll region setting to the terminal.
   */
  private applyScrollRegion(): void {
    // Set scroll region to chat area only
    // Content written here will scroll; status/input won't
    this.write(ANSI.setScrollRegion(this.chatRegion.startRow, this.chatRegion.endRow));
  }

  /**
   * Handle terminal resize events.
   */
  private handleResize(): void {
    try {
      const oldRows = this.rows;
      const oldCols = this.cols;

      this.updateDimensions();

      // Only recompute if dimensions actually changed
      if (this.rows !== oldRows || this.cols !== oldCols) {
        this.computeRegions();
        this.applyScrollRegion();

        // If streaming, reposition cursor to end of new chat region —
        // the old cursor position may now be outside the updated region
        if (this._isStreaming) {
          this.write(ANSI.cursorTo(this.chatRegion.endRow));
        }

        this.emit('resize', { rows: this.rows, cols: this.cols });
      }
    } catch {
      // Resize failures are non-fatal — layout may be stale but TUI continues
    }
  }

  /**
   * Write content to the status bar region.
   * Saves cursor, moves to status bar, writes, restores cursor.
   *
   * @param content - The content to display (will be truncated to fit)
   */
  writeStatusBar(content: string): void {
    if (!this.isInitialized) return;

    // Truncate content to terminal width
    const truncated = this.truncateToWidth(content);

    // Use synchronized output to prevent flickering
    const output = this.useSynchronizedOutput
      ? [
          ANSI.BEGIN_SYNC,
          ANSI.SAVE_CURSOR,
          ANSI.cursorTo(this.statusRegion.startRow),
          ANSI.CLEAR_LINE,
          truncated,
          ANSI.RESTORE_CURSOR,
          ANSI.END_SYNC,
        ].join('')
      : [
          ANSI.SAVE_CURSOR,
          ANSI.cursorTo(this.statusRegion.startRow),
          ANSI.CLEAR_LINE,
          truncated,
          ANSI.RESTORE_CURSOR,
        ].join('');

    this.write(output);
  }

  /**
   * Write content to the chat area (within scroll region).
   * Content will scroll naturally within the defined region.
   *
   * @param content - The content to display
   */
  writeToChatArea(content: string): void {
    if (!this.isInitialized) return;

    // Save cursor, move to end of chat region, write content
    // The scroll region will handle scrolling automatically
    const output = [
      ANSI.SAVE_CURSOR,
      ANSI.cursorTo(this.chatRegion.endRow),
      '\n', // This triggers scroll within the region
      content,
      ANSI.RESTORE_CURSOR,
    ].join('');

    this.write(output);
  }

  /**
   * Stream content to the chat area chunk by chunk.
   * Used for LLM streaming responses.
   * Does NOT save/restore cursor - expects continuous streaming.
   *
   * @param chunk - A chunk of text to append
   */
  streamToChatArea(chunk: string): void {
    if (!this.isInitialized) return;

    // Just write the chunk - let the scroll region handle it
    this.write(chunk);
  }

  /**
   * Begin streaming in the chat area.
   * Positions cursor at the end of the chat region and leaves it there.
   * Uses CUP (absolute positioning), NOT SAVE_CURSOR — this avoids
   * conflicts with writeStatusBar() which uses SAVE/RESTORE.
   */
  beginChatStream(): void {
    if (!this.isInitialized) return;
    this._isStreaming = true;
    this.write(ANSI.cursorTo(this.chatRegion.endRow));
    this.write('\n'); // Scroll within region to make room
  }

  /**
   * End streaming in the chat area.
   * Returns cursor to the input area using CUP (absolute positioning).
   */
  endChatStream(): void {
    if (!this.isInitialized) return;
    this._isStreaming = false;
    this.write(ANSI.cursorTo(this.inputRegion.startRow));
  }

  /** Whether streaming is active. */
  get streaming(): boolean {
    return this._isStreaming;
  }

  /**
   * Move cursor to the input area for readline.
   * Call this before displaying the prompt.
   */
  focusInputArea(): void {
    if (!this.isInitialized) return;

    this.write(ANSI.cursorTo(this.inputRegion.startRow));
  }

  /**
   * Clear the chat area.
   */
  clearChatArea(): void {
    if (!this.isInitialized) return;

    // Clear each line in the chat region
    const output: string[] = [ANSI.SAVE_CURSOR];
    for (let row = this.chatRegion.startRow; row <= this.chatRegion.endRow; row++) {
      output.push(ANSI.cursorTo(row), ANSI.CLEAR_LINE);
    }
    output.push(ANSI.RESTORE_CURSOR);

    this.write(output.join(''));
  }

  /**
   * Clear the status bar.
   */
  clearStatusBar(): void {
    if (!this.isInitialized) return;

    this.write([
      ANSI.SAVE_CURSOR,
      ANSI.cursorTo(this.statusRegion.startRow),
      ANSI.CLEAR_LINE,
      ANSI.RESTORE_CURSOR,
    ].join(''));
  }

  /**
   * Get the current terminal dimensions.
   */
  getDimensions(): { rows: number; cols: number } {
    return { rows: this.rows, cols: this.cols };
  }

  /**
   * Get the bounds of each region.
   */
  getRegions(): { chat: RegionBounds; status: RegionBounds; input: RegionBounds } {
    return {
      chat: { ...this.chatRegion },
      status: { ...this.statusRegion },
      input: { ...this.inputRegion },
    };
  }

  /**
   * Get the height of the chat area in lines.
   */
  getChatAreaHeight(): number {
    return this.chatRegion.endRow - this.chatRegion.startRow + 1;
  }

  /**
   * Check if the terminal is a TTY (supports ANSI sequences).
   */
  isTTY(): boolean {
    return this.stdout.isTTY ?? false;
  }

  /**
   * Clean up: restore normal terminal mode.
   * Call this before exiting.
   */
  cleanup(): void {
    if (!this.isInitialized) return;

    // Remove resize listener
    if (this.resizeHandler) {
      this.stdout.off('resize', this.resizeHandler);
      this.resizeHandler = null;
    }

    // Reset scroll region to full screen
    this.write(ANSI.resetScrollRegion);

    // Exit alternate screen if we entered it
    if (this.useAlternateScreen) {
      this.write(ANSI.EXIT_ALT_SCREEN);
    }

    // Move cursor to bottom of screen
    this.write(ANSI.cursorTo(this.rows));

    this.isInitialized = false;
    this.emit('cleanup');
  }

  /**
   * Write output to stdout.
   */
  private write(data: string): void {
    try {
      this.stdout.write(data);
    } catch (error: unknown) {
      // EPIPE is expected when stdout is piped to a closed consumer (e.g., | head)
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
        throw error;
      }
    }
  }

  /**
   * Truncate a string to fit terminal width.
   * Handles ANSI escape sequences correctly.
   *
   * @param str - The string to truncate
   * @param maxWidth - Maximum width (default: terminal width)
   */
  private truncateToWidth(str: string, maxWidth?: number): string {
    const width = maxWidth ?? this.cols;
    const visible = str.replace(ANSI_ESCAPE_PATTERN, '');
    if (visible.length <= width) return str;
    // Strip ANSI and truncate plain text (status bar is rebuilt every render)
    return visible.slice(0, width - 1) + '…';
  }
}

/**
 * Create a pre-configured terminal region manager.
 * Factory function for common use cases.
 */
export function createTerminalRegionManager(
  options?: TerminalRegionManagerOptions
): TerminalRegionManager {
  return new TerminalRegionManager(options);
}
