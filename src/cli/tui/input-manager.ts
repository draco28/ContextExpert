/**
 * Input Manager
 *
 * Wraps Node.js readline with TUI-aware features:
 * - Coordinates with TerminalRegionManager for cursor positioning
 * - Preserves tab completion for commands and @file references
 * - Handles multi-line input for pasting
 * - Manages prompt updates based on state
 *
 * The key insight is that we DON'T replace readline - we wrap it.
 * This preserves all the existing features (completion, history, editing)
 * while adding TUI coordination.
 */

import * as readline from 'node:readline';
import chalk from 'chalk';
import type { TerminalRegionManager } from './terminal-regions.js';

/**
 * Completer function signature (matches readline.Completer).
 */
export type Completer = (
  line: string
) => [string[], string] | Promise<[string[], string]>;

/**
 * Options for InputManager.
 */
export interface InputManagerOptions {
  /** Tab completion function */
  completer?: Completer;
  /** Handler for line input */
  onLine: (line: string) => Promise<void> | void;
  /** Handler for Ctrl+C */
  onSIGINT?: () => void;
  /** Handler for close event */
  onClose?: () => void;
  /** Terminal region manager for cursor coordination */
  regionManager: TerminalRegionManager;
  /** Initial prompt string */
  prompt?: string;
  /** Input stream (default: process.stdin) */
  input?: NodeJS.ReadableStream;
  /** Output stream (default: process.stdout) */
  output?: NodeJS.WritableStream;
}

/**
 * Manages the input area of the TUI.
 *
 * This is a thin wrapper around readline that:
 * 1. Positions the cursor correctly within the TUI layout
 * 2. Pauses/resumes during output to prevent conflicts
 * 3. Preserves all readline features (completion, history, etc.)
 *
 * Usage:
 * ```typescript
 * const input = new InputManager({
 *   regionManager,
 *   completer: myCompleter,
 *   onLine: async (line) => { ... },
 *   onSIGINT: () => { ... },
 * });
 *
 * input.setPrompt('[my-project]> ');
 * input.prompt();
 * ```
 */
export class InputManager {
  private rl: readline.Interface;
  private regionManager: TerminalRegionManager;
  private currentPrompt: string;
  private isPaused: boolean = false;
  private pendingPrompt: boolean = false;
  private onLineHandler: (line: string) => Promise<void> | void;
  private isProcessing: boolean = false;
  private _closed: boolean = false;

  constructor(options: InputManagerOptions) {
    this.regionManager = options.regionManager;
    this.currentPrompt = options.prompt ?? '> ';
    this.onLineHandler = options.onLine;

    // Create readline interface with TUI-aware settings
    this.rl = readline.createInterface({
      input: options.input ?? process.stdin,
      output: options.output ?? process.stdout,
      prompt: this.currentPrompt,
      completer: options.completer,
      terminal: true,
    });

    // Wire up event handlers
    this.setupEventHandlers(options);
  }

  /**
   * Set up readline event handlers.
   */
  private setupEventHandlers(options: InputManagerOptions): void {
    // Handle line input
    // We use 'line' event instead of async iterator to prevent
    // readline from closing during async operations
    this.rl.on('line', async (line) => {
      // Prevent concurrent processing
      if (this.isProcessing) {
        return;
      }

      this.isProcessing = true;

      try {
        await this.onLineHandler(line);
      } catch (error) {
        // Let the caller handle errors - just log for debugging
        console.error('Input handler error:', error);
      } finally {
        this.isProcessing = false;

        // Re-prompt if not paused
        if (!this.isPaused) {
          this.prompt();
        }
      }
    });

    // Handle Ctrl+C
    this.rl.on('SIGINT', () => {
      if (options.onSIGINT) {
        options.onSIGINT();
      } else {
        // Default: exit gracefully
        this.rl.close();
      }
    });

    // Handle close event
    this.rl.on('close', () => {
      if (options.onClose) {
        options.onClose();
      }
    });
  }

  /**
   * Set the prompt text.
   * This doesn't immediately display - call prompt() to show it.
   *
   * @param promptText - The new prompt string
   */
  setPrompt(promptText: string): void {
    this.currentPrompt = promptText;
    this.rl.setPrompt(promptText);
  }

  /**
   * Create a prompt string for a project.
   * Follows the existing Context_Expert convention.
   *
   * @param projectName - Optional project name
   * @returns Formatted prompt string
   */
  static createProjectPrompt(projectName?: string | null): string {
    if (projectName) {
      return `${chalk.green(`[${projectName}]`)}> `;
    }
    return '> ';
  }

  /**
   * Display the prompt and wait for input.
   * Positions cursor in the input area first.
   */
  prompt(): void {
    if (this.isPaused) {
      // Remember that we want to prompt when resumed
      this.pendingPrompt = true;
      return;
    }

    // Position cursor in input area
    this.regionManager.focusInputArea();

    // Clear the input line before showing prompt
    // This prevents artifacts from previous content
    if (process.stdout.isTTY) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }

    this.rl.prompt();
  }

  /**
   * Temporarily hide input area (during output).
   * Call this before writing to the chat area to prevent
   * the prompt from getting mixed with output.
   */
  pause(): void {
    if (this.isPaused) return;

    this.isPaused = true;

    // Clear the current input line
    if (process.stdout.isTTY) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }
  }

  /**
   * Restore input area after output.
   * Re-displays the prompt if we had a pending prompt request.
   */
  resume(): void {
    if (!this.isPaused) return;

    this.isPaused = false;

    if (this.pendingPrompt) {
      this.pendingPrompt = false;
      this.prompt();
    }
  }

  /**
   * Check if input is currently paused.
   */
  get paused(): boolean {
    return this.isPaused;
  }

  /**
   * Get the underlying readline interface.
   * Use with caution - prefer the wrapper methods.
   */
  getReadlineInterface(): readline.Interface {
    return this.rl;
  }

  /**
   * Write text to the output (usually for debugging).
   * Pauses input, writes, then resumes.
   *
   * @param text - Text to write
   */
  write(text: string): void {
    const wasPaused = this.isPaused;
    if (!wasPaused) {
      this.pause();
    }

    process.stdout.write(text);

    if (!wasPaused) {
      this.resume();
    }
  }

  /**
   * Close the input manager.
   * Closes the underlying readline interface.
   */
  close(): void {
    this._closed = true;
    this.rl.close();
  }

  /**
   * Check if the readline interface is closed.
   */
  get closed(): boolean {
    return this._closed;
  }
}

/**
 * Create a pre-configured input manager.
 */
export function createInputManager(
  options: InputManagerOptions
): InputManager {
  return new InputManager(options);
}
