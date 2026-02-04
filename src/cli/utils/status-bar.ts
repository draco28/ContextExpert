/**
 * Status Bar Renderer
 *
 * Renders progress updates during background indexing using readline-safe methods.
 * Instead of trying to maintain a persistent status line (which conflicts with
 * readline's line editing), this approach:
 *
 * 1. Clears the current readline prompt
 * 2. Prints the status update
 * 3. Re-displays the prompt
 *
 * This ensures user input is never corrupted and commands work properly.
 */

import * as readline from 'node:readline';
import chalk from 'chalk';
import type { ProgressData } from '../../indexer/session.js';
import type { IndexingStage } from './progress.js';

/**
 * Human-readable labels for each indexing stage.
 */
const STAGE_LABELS: Record<IndexingStage, string> = {
  scanning: 'Scanning',
  chunking: 'Chunking',
  embedding: 'Embedding',
  storing: 'Storing',
};

/**
 * Options for StatusBarRenderer.
 */
export interface StatusBarOptions {
  /** Terminal width for progress bar sizing (defaults to process.stdout.columns) */
  terminalWidth?: number;

  /** Disable colors (for NO_COLOR env) */
  noColor?: boolean;

  /** Minimum time between updates in ms (default: 2000 for less disruption) */
  throttleMs?: number;
}

/**
 * StatusBarRenderer displays progress updates during background indexing.
 *
 * Uses readline-safe output methods to avoid corrupting user input.
 * Progress updates are printed above the prompt, then the prompt is restored.
 *
 * @example
 * ```typescript
 * const statusBar = new StatusBarRenderer({ terminalWidth: 80 });
 * statusBar.attach(rl);
 *
 * session.on('stage:start', (stage, total) => {
 *   statusBar.setStage(stage, total);
 * });
 *
 * session.on('progress', (data) => {
 *   statusBar.update(data);
 * });
 *
 * session.on('complete', () => {
 *   statusBar.hide();
 * });
 * ```
 */
export class StatusBarRenderer {
  private currentStage: IndexingStage = 'scanning';
  private currentTotal: number = 0;
  private currentProgress: ProgressData | null = null;
  private lastRenderTime: number = 0;
  private lastRenderedPercent: number = -1;
  private readonly throttleMs: number;
  private readonly terminalWidth: number;
  private active: boolean = false;

  // Reference to readline for safe output
  private rl: readline.Interface | null = null;

  constructor(options: StatusBarOptions = {}) {
    // Use longer throttle (2s) to reduce disruption to user input
    this.throttleMs = options.throttleMs ?? 2000;
    this.terminalWidth = options.terminalWidth ?? process.stdout.columns ?? 80;

    if (options.noColor) {
      chalk.level = 0;
    }
  }

  /**
   * Attach to a readline interface for safe output coordination.
   */
  attach(rl: readline.Interface): void {
    this.rl = rl;
  }

  /**
   * Set the current stage being processed.
   */
  setStage(stage: IndexingStage, total: number): void {
    this.currentStage = stage;
    this.currentTotal = total;
    this.currentProgress = {
      stage,
      processed: 0,
      total,
    };
    this.active = true;
    this.lastRenderedPercent = -1;

    // Always print stage changes
    this.printStatus(`${chalk.cyan(STAGE_LABELS[stage])} starting (${total.toLocaleString()} items)`);
  }

  /**
   * Update progress within current stage.
   * Only renders on significant progress changes or after throttle period.
   */
  update(data: ProgressData): void {
    this.currentProgress = data;
    this.currentStage = data.stage;
    this.currentTotal = data.total;

    if (!this.active) return;

    const now = performance.now();
    const percent = data.total > 0 ? Math.round((data.processed / data.total) * 100) : 0;

    // Only update on significant progress (every 10%) or after throttle period
    const significantProgress = percent >= this.lastRenderedPercent + 10;
    const throttleExpired = now - this.lastRenderTime >= this.throttleMs;

    if (significantProgress || throttleExpired) {
      this.lastRenderTime = now;
      this.lastRenderedPercent = percent;
      this.render();
    }
  }

  /**
   * Show a message (backward compatibility - just activates the renderer).
   */
  show(): void {
    this.active = true;
  }

  /**
   * Hide the status bar (stop rendering).
   */
  hide(): void {
    this.active = false;
    this.currentProgress = null;
  }

  /**
   * Show success state.
   */
  showSuccess(message?: string): void {
    const text = message ?? 'Indexing complete';
    this.printStatus(chalk.green(`✓ ${text}`));
    this.hide();
  }

  /**
   * Show error state.
   */
  showError(message?: string): void {
    const text = message ?? 'Indexing failed';
    this.printStatus(chalk.red(`✗ ${text}`));
    this.hide();
  }

  /**
   * Show cancelled state.
   */
  showCancelled(): void {
    this.printStatus(chalk.yellow('⚠ Indexing cancelled'));
    this.hide();
  }

  /**
   * Get current stage for status queries.
   */
  getCurrentStage(): IndexingStage {
    return this.currentStage;
  }

  /**
   * Get current progress data for status queries.
   */
  getCurrentProgress(): ProgressData | null {
    return this.currentProgress;
  }

  /**
   * Check if status bar is active.
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Render the current progress.
   */
  private render(): void {
    if (!this.active || !this.currentProgress) return;

    const { processed, total, rate, eta, warmingUp } = this.currentProgress;
    const width = this.getTerminalWidth();

    // Build components
    const stageLabel = chalk.cyan(STAGE_LABELS[this.currentStage].padEnd(10));
    const progressBar = this.buildProgressBar(processed, total, width);
    const counts = `${this.formatNumber(processed)}/${this.formatNumber(total)}`;
    const percent = total > 0 ? Math.round((processed / total) * 100) : 0;

    let statusLine = `${stageLabel} ${progressBar} ${counts} (${percent}%)`;

    // Add rate and ETA for embedding stage
    if (this.currentStage === 'embedding') {
      if (warmingUp) {
        statusLine += chalk.dim(' • Warming up...');
      } else if (rate !== undefined && rate > 0) {
        statusLine += chalk.dim(` • ${rate.toFixed(1)}/s`);
        if (eta !== undefined && eta > 0) {
          statusLine += chalk.dim(` • ETA ${this.formatEta(eta)}`);
        }
      }
    }

    this.printStatus(statusLine);
  }

  /**
   * Print a status message safely, preserving readline state.
   *
   * This method:
   * 1. Clears the current readline line
   * 2. Prints the status
   * 3. Re-prompts readline
   */
  private printStatus(message: string): void {
    if (!process.stdout.isTTY) {
      // Non-TTY: just print
      console.log(message);
      return;
    }

    if (this.rl) {
      // Clear current line, print message, re-prompt
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      console.log(message);
      this.rl.prompt(true); // true = preserve existing input
    } else {
      // No readline attached, just print
      console.log(message);
    }
  }

  /**
   * Build ASCII progress bar.
   */
  private buildProgressBar(current: number, total: number, termWidth: number): string {
    // Reserve space for other content
    const reservedWidth = 60;
    const barWidth = Math.max(10, Math.min(20, termWidth - reservedWidth));

    const progress = total > 0 ? current / total : 0;
    const filled = Math.round(barWidth * progress);
    const empty = barWidth - filled;

    const filledBar = chalk.green('█'.repeat(filled));
    const emptyBar = chalk.dim('░'.repeat(empty));

    return filledBar + emptyBar;
  }

  /**
   * Format a number with thousand separators.
   */
  private formatNumber(n: number): string {
    return n.toLocaleString();
  }

  /**
   * Format ETA as human-readable string.
   */
  private formatEta(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;

    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;

    if (minutes < 60) {
      return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
    }

    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  }

  /**
   * Get current terminal width.
   */
  private getTerminalWidth(): number {
    return process.stdout.columns ?? this.terminalWidth;
  }
}

/**
 * Create a new StatusBarRenderer instance.
 */
export function createStatusBar(options?: StatusBarOptions): StatusBarRenderer {
  return new StatusBarRenderer(options);
}
