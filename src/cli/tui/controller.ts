/**
 * TUI Controller
 *
 * Orchestrates all TUI components:
 * - TerminalRegionManager (layout)
 * - StatusLineRenderer (status bar)
 * - ChatAreaManager (messages)
 * - InputManager (user input)
 *
 * Handles lifecycle events (start, resize, cleanup) and provides
 * a unified API for the chat command to use.
 *
 * This is the main integration point between the existing chat.ts
 * and the new TUI system.
 */

import chalk from 'chalk';
import { TerminalRegionManager, createTerminalRegionManager } from './terminal-regions.js';
import {
  StatusLineRenderer,
  createStatusLineRenderer,
  toolToDescription,
} from './status-line.js';
import { ChatAreaManager, createChatAreaManager } from './chat-area.js';
import { InputManager, createInputManager, type Completer } from './input-manager.js';
import {
  AgentMode,
  AgentPhase,
  type StatusLineState,
  type SourceReference,
  type TUIConfig,
  DEFAULT_TUI_CONFIG,
} from './types.js';

/**
 * Stream chunk type (compatible with existing StreamChunk).
 */
export interface StreamChunk {
  type: 'text' | 'thinking' | 'tool_use' | 'usage' | 'error';
  content?: string;
  tool?: string;
  args?: Record<string, unknown>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

/**
 * Options for TUIController.
 */
export interface TUIControllerOptions {
  /** TUI configuration */
  config?: Partial<TUIConfig>;
  /** Tab completion function */
  completer?: Completer;
  /** Initial model info */
  model?: { name: string; provider: string };
  /** Initial project name */
  project?: string | null;
  /** Initial git branch */
  gitBranch?: string | null;
  /** Context window size (for token tracking) */
  contextWindowSize?: number;
  /** Use alternate screen buffer */
  useAlternateScreen?: boolean;
  /** Enable markdown in chat */
  enableMarkdown?: boolean;
}

/**
 * Events that can be listened to on the controller.
 */
export interface TUIControllerEvents {
  /** User submitted a line of input */
  line: [string];
  /** User pressed Ctrl+C */
  sigint: [];
  /** TUI is closing */
  close: [];
  /** Terminal was resized */
  resize: [{ rows: number; cols: number }];
}

/**
 * Orchestrates the TUI components.
 *
 * Usage:
 * ```typescript
 * const tui = new TUIController({
 *   model: { name: 'Claude 3.5 Sonnet', provider: 'anthropic' },
 *   project: 'my-project',
 *   completer: myTabCompleter,
 * });
 *
 * tui.onLine(async (line) => {
 *   if (line === 'exit') {
 *     tui.shutdown();
 *     return;
 *   }
 *
 *   tui.addUserMessage(line);
 *   const stream = await getLLMStream(line);
 *   await tui.streamResponse(stream);
 * });
 *
 * tui.start();
 * ```
 */
export class TUIController {
  private regionManager: TerminalRegionManager;
  private statusLine: StatusLineRenderer;
  private chatArea: ChatAreaManager;
  private inputManager!: InputManager;

  private config: TUIConfig;
  private isRunning: boolean = false;
  private lineHandler: ((line: string) => Promise<void> | void) | null = null;
  private sigintHandler: (() => void) | null = null;
  private closeHandler: (() => void) | null = null;

  // State tracking
  private currentTokens: number = 0;
  private totalCost: number = 0;

  constructor(options: TUIControllerOptions = {}) {
    // Merge config with defaults
    this.config = {
      ...DEFAULT_TUI_CONFIG,
      ...options.config,
      statusBar: { ...DEFAULT_TUI_CONFIG.statusBar, ...options.config?.statusBar },
      chatArea: { ...DEFAULT_TUI_CONFIG.chatArea, ...options.config?.chatArea },
      inputArea: { ...DEFAULT_TUI_CONFIG.inputArea, ...options.config?.inputArea },
    };

    // Create terminal region manager
    this.regionManager = createTerminalRegionManager({
      statusBarHeight: this.config.statusBar.height,
      inputAreaHeight: this.config.inputArea.height,
      useAlternateScreen: options.useAlternateScreen ?? false,
    });

    // Create status line renderer with initial state
    this.statusLine = createStatusLineRenderer(
      {
        mode: AgentMode.PLANNING,
        phase: AgentPhase.IDLE,
        model: options.model ?? { name: 'Unknown', provider: 'unknown' },
        project: options.project ?? null,
        gitBranch: options.gitBranch ?? null,
        tokens: {
          used: 0,
          total: options.contextWindowSize ?? 200000,
          warningThreshold: 0.8,
          dangerThreshold: 0.95,
        },
        cost: { totalUsd: 0 },
      },
      {
        terminalWidth: process.stdout.columns ?? 80,
      }
    );

    // Create chat area manager
    this.chatArea = createChatAreaManager(this.regionManager, {
      enableMarkdown: options.enableMarkdown ?? this.config.chatArea.enableMarkdown,
    });

    // Listen for resize to update status line width
    this.regionManager.on('resize', ({ cols }) => {
      this.statusLine.setTerminalWidth(cols);
      this.updateStatusBar();
    });
  }

  /**
   * Register handler for line input.
   */
  onLine(handler: (line: string) => Promise<void> | void): this {
    this.lineHandler = handler;
    return this;
  }

  /**
   * Register handler for Ctrl+C.
   */
  onSIGINT(handler: () => void): this {
    this.sigintHandler = handler;
    return this;
  }

  /**
   * Register handler for close event.
   */
  onClose(handler: () => void): this {
    this.closeHandler = handler;
    return this;
  }

  /**
   * Start the TUI.
   * Initializes regions, creates input manager, and begins the REPL loop.
   *
   * @param completer - Optional tab completer function
   * @param initialPrompt - Initial prompt string
   */
  start(completer?: Completer, initialPrompt?: string): void {
    if (this.isRunning) {
      return;
    }

    // Initialize terminal regions
    this.regionManager.initialize();

    // Create input manager
    this.inputManager = createInputManager({
      regionManager: this.regionManager,
      completer,
      prompt: initialPrompt ?? '> ',
      onLine: async (line) => {
        if (this.lineHandler) {
          await this.lineHandler(line);
        }
      },
      onSIGINT: () => {
        if (this.sigintHandler) {
          this.sigintHandler();
        } else {
          this.shutdown();
        }
      },
      onClose: () => {
        if (this.closeHandler) {
          this.closeHandler();
        }
      },
      onBusy: () => {
        this.chatArea.addInfoMessage(
          chalk.yellow('Processing previous input...'), { compact: true }
        );
      },
      onError: (error) => {
        this.chatArea.addInfoMessage(
          chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`),
          { compact: true }
        );
      },
    });

    // Render initial status bar
    this.updateStatusBar();

    // Show welcome message
    this.chatArea.addInfoMessage(
      chalk.dim('TUI mode enabled. Type /help for commands.')
    );

    // Start the prompt
    this.isRunning = true;
    this.inputManager.prompt();
  }

  /**
   * Update the status bar state and re-render.
   */
  updateStatus(update: Partial<StatusLineState>): void {
    this.statusLine.update(update);
    this.updateStatusBar();
  }

  /**
   * Update just the activity indicator.
   */
  setActivity(phase: AgentPhase, tool?: string, description?: string): void {
    this.updateStatus({
      phase,
      activity: { tool, description },
    });
  }

  /**
   * Set the agent mode.
   */
  setMode(mode: AgentMode): void {
    this.updateStatus({ mode });
  }

  /**
   * Update token usage.
   */
  updateTokens(used: number, total?: number): void {
    this.currentTokens = used;
    const state = this.statusLine.getState();
    this.updateStatus({
      tokens: {
        ...state.tokens,
        used,
        ...(total !== undefined ? { total } : {}),
      },
    });
  }

  /**
   * Add tokens to the running total.
   */
  addTokens(inputTokens: number, outputTokens: number): void {
    this.currentTokens += inputTokens + outputTokens;
    this.updateTokens(this.currentTokens);
  }

  /**
   * Update session cost.
   */
  updateCost(totalUsd: number): void {
    this.totalCost = totalUsd;
    this.updateStatus({ cost: { totalUsd } });
  }

  /**
   * Add to session cost.
   */
  addCost(amountUsd: number): void {
    this.totalCost += amountUsd;
    this.updateCost(this.totalCost);
  }

  /**
   * Set current project.
   */
  setProject(project: string | null): void {
    this.updateStatus({ project });
    if (!this.isRunning) return;

    // Update prompt to reflect project
    const prompt = InputManager.createProjectPrompt(project);
    this.inputManager.setPrompt(prompt);
  }

  /**
   * Set background indexing status.
   */
  setIndexingStatus(
    status: { projectName: string; progress: number; stage: string } | undefined
  ): void {
    this.updateStatus({ indexingStatus: status });
  }

  /**
   * Add a user message to the chat area.
   */
  addUserMessage(content: string): void {
    if (!this.isRunning) return;
    this.inputManager.pause();
    this.chatArea.addUserMessage(content);
    this.inputManager.resume();
  }

  /**
   * Add an info message to the chat area.
   *
   * @param content - The info text
   * @param options - Display options (compact: reduce vertical spacing)
   */
  addInfoMessage(content: string, options?: { compact?: boolean }): void {
    if (!this.isRunning) return;
    this.inputManager.pause();
    this.chatArea.addInfoMessage(content, options);
    this.inputManager.resume();
  }

  /**
   * Add a system message to the chat area.
   */
  addSystemMessage(content: string): void {
    if (!this.isRunning) return;
    this.inputManager.pause();
    this.chatArea.addSystemMessage(content);
    this.inputManager.resume();
  }

  /**
   * Stream an LLM response to the chat area.
   * Handles tool use updates in the status bar.
   *
   * @param stream - AsyncIterable of StreamChunks
   * @returns The complete response text
   */
  async streamResponse(stream: AsyncIterable<StreamChunk>): Promise<string> {
    if (!this.isRunning) return '';
    this.inputManager.pause();
    this.setActivity(AgentPhase.THINKING);

    let responseText = '';
    let isStreaming = false;
    let sources: SourceReference[] | undefined;

    try {
      for await (const chunk of stream) {
        switch (chunk.type) {
          case 'thinking':
            // Thinking content shown dimmed
            if (!isStreaming) {
              this.chatArea.startStream();
              isStreaming = true;
              this.setActivity(AgentPhase.STREAMING);
            }
            if (chunk.content) {
              this.chatArea.streamChunk(chalk.dim(chunk.content));
            }
            break;

          case 'text':
            // Regular text content
            if (!isStreaming) {
              this.chatArea.startStream();
              isStreaming = true;
              this.setActivity(AgentPhase.STREAMING);
            }
            if (chunk.content) {
              responseText += chunk.content;
              this.chatArea.streamChunk(chunk.content);
            }
            break;

          case 'tool_use':
            // Update status bar with tool activity
            if (chunk.tool) {
              const description = toolToDescription(chunk.tool, chunk.args);
              this.setActivity(AgentPhase.TOOL_USE, chunk.tool, description);
            }
            break;

          case 'usage':
            // Update token/cost tracking
            if (chunk.usage) {
              const input = chunk.usage.inputTokens ?? 0;
              const output = chunk.usage.outputTokens ?? 0;
              this.addTokens(input, output);
            }
            break;

          case 'error':
            // Display error in chat
            if (chunk.content) {
              this.chatArea.addInfoMessage(chalk.red(`Error: ${chunk.content}`));
            }
            break;
        }
      }
    } finally {
      // End streaming
      if (isStreaming) {
        this.chatArea.endStream(sources);
      }

      // Return to idle
      this.setActivity(AgentPhase.IDLE);
      this.inputManager.resume();
    }

    return responseText;
  }

  /**
   * Clear the chat area.
   */
  clearChat(): void {
    if (!this.isRunning) return;
    this.inputManager.pause();
    this.chatArea.clear();
    this.inputManager.resume();
  }

  /**
   * Show the prompt.
   */
  prompt(): void {
    if (!this.isRunning) return;
    this.inputManager.prompt();
  }

  /**
   * Set the prompt text.
   */
  setPrompt(prompt: string): void {
    if (!this.isRunning) return;
    this.inputManager.setPrompt(prompt);
  }

  /**
   * Get the underlying input manager.
   */
  getInputManager(): InputManager {
    return this.inputManager;
  }

  /**
   * Get the underlying region manager.
   */
  getRegionManager(): TerminalRegionManager {
    return this.regionManager;
  }

  /**
   * Check if TUI is running.
   */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Shutdown the TUI gracefully.
   */
  shutdown(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    // Close input manager — don't let errors prevent terminal cleanup
    try {
      if (this.inputManager) {
        this.inputManager.close();
      }
    } catch {
      // Input manager cleanup failed — continue with terminal reset
    }

    // Always cleanup terminal regions (reset scroll, exit alt screen)
    try {
      this.regionManager.cleanup();
    } catch {
      // Terminal cleanup failed — nothing more we can do
    }

    // Print session summary
    console.log(''); // Newline after cleanup
    console.log(chalk.dim('─'.repeat(40)));
    console.log(chalk.dim('Session ended'));
    console.log(chalk.dim(`Total tokens: ${this.currentTokens.toLocaleString()}`));
    console.log(chalk.dim(`Total cost: $${this.totalCost.toFixed(4)}`));
    console.log(chalk.dim('─'.repeat(40)));
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Re-render the status bar.
   */
  private updateStatusBar(): void {
    const rendered = this.statusLine.render();
    this.regionManager.writeStatusBar(rendered);
  }
}

/**
 * Create and start a TUI controller.
 * Convenience function for simple usage.
 */
export async function startTUI(
  options: TUIControllerOptions & {
    completer?: Completer;
    onLine: (line: string) => Promise<void> | void;
    onSIGINT?: () => void;
    onClose?: () => void;
  }
): Promise<TUIController> {
  const tui = new TUIController(options);

  tui.onLine(options.onLine);

  if (options.onSIGINT) {
    tui.onSIGINT(options.onSIGINT);
  }

  if (options.onClose) {
    tui.onClose(options.onClose);
  }

  tui.start(options.completer, InputManager.createProjectPrompt(options.project));

  return tui;
}
