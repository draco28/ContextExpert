/**
 * Progress Reporter
 *
 * Manages progress display for long-running indexing operations.
 * Supports multiple output modes:
 * - Interactive: ora spinners with real-time updates
 * - JSON: NDJSON event stream for CI/CD integration
 * - Text: Simple text output for non-TTY environments
 *
 * Design decisions:
 * - Throttles spinner updates to prevent flickering (100ms minimum)
 * - Truncates file paths to fit terminal width
 * - Respects NO_COLOR environment variable
 * - Detects TTY automatically for appropriate output mode
 */

import ora, { type Ora } from 'ora';
import chalk from 'chalk';

/**
 * Stages in the indexing pipeline.
 * Order matters - this is the sequence they occur in.
 */
export type IndexingStage = 'scanning' | 'chunking' | 'embedding' | 'storing';

/**
 * Human-readable labels for each stage.
 */
const STAGE_LABELS: Record<IndexingStage, string> = {
  scanning: 'Scanning',
  chunking: 'Chunking',
  embedding: 'Embedding',
  storing: 'Storing',
};

/**
 * Configuration options for the ProgressReporter.
 */
export interface ProgressReporterOptions {
  /** Output as JSON events instead of human-readable text */
  json: boolean;

  /** Show detailed per-file output */
  verbose: boolean;

  /** Disable colors (respects NO_COLOR env) */
  noColor: boolean;

  /** Whether stdout is a TTY (for spinner support) */
  isInteractive: boolean;
}

/**
 * Statistics for a completed stage.
 */
export interface StageStats {
  /** Which stage completed */
  stage: IndexingStage;

  /** Number of items processed */
  processed: number;

  /** Total items in this stage */
  total: number;

  /** Time taken in milliseconds */
  durationMs: number;

  /** Additional stage-specific details */
  details?: Record<string, unknown>;
}

/**
 * Final result of the indexing pipeline.
 */
export interface IndexPipelineResult {
  /** UUID of the indexed project */
  projectId: string;

  /** Project name */
  projectName: string;

  /** Number of files that were indexed */
  filesIndexed: number;

  /** Number of chunks created from files */
  chunksCreated: number;

  /** Number of chunks stored in database */
  chunksStored: number;

  /** Total time in milliseconds */
  totalDurationMs: number;

  /** Time breakdown by stage */
  stageDurations: Partial<Record<IndexingStage, number>>;

  /** Database size increase in bytes */
  databaseSizeIncrease: number;

  /** Any warnings encountered */
  warnings: string[];

  /** Any non-fatal errors encountered */
  errors: string[];
}

/**
 * JSON event types for NDJSON output.
 */
export type ProgressEventType =
  | 'stage_start'
  | 'stage_progress'
  | 'stage_complete'
  | 'warning'
  | 'error'
  | 'complete';

/**
 * JSON event emitted in --json mode.
 */
export interface ProgressEvent {
  type: ProgressEventType;
  timestamp: string;
  stage?: IndexingStage;
  data: Record<string, unknown>;
}

/**
 * ProgressReporter manages all progress display during indexing.
 *
 * Usage:
 * ```typescript
 * const reporter = new ProgressReporter({ json: false, verbose: false, ... });
 *
 * reporter.startStage('scanning', 0); // Unknown total
 * reporter.updateProgress(10, 'src/file.ts');
 * reporter.updateProgress(20, 'src/other.ts');
 * reporter.completeStage({ stage: 'scanning', processed: 100, total: 100, durationMs: 500 });
 *
 * reporter.showSummary(result);
 * ```
 */
export class ProgressReporter {
  private options: ProgressReporterOptions;
  private spinner: Ora | null = null;
  private currentStage: IndexingStage | null = null;
  private currentTotal: number = 0;
  private lastUpdateTime: number = 0;
  private verboseLines: string[] = [];

  /** Minimum time between spinner updates to prevent flickering */
  private static readonly UPDATE_THROTTLE_MS = 100;

  /** Maximum length for file path display */
  private static readonly MAX_PATH_LENGTH = 40;

  constructor(options: ProgressReporterOptions) {
    this.options = options;

    // Apply NO_COLOR if set
    if (options.noColor) {
      chalk.level = 0;
    }
  }

  /**
   * Start a new stage of the indexing pipeline.
   *
   * @param stage - Which stage is starting
   * @param total - Expected total items (0 if unknown, like during scanning)
   */
  startStage(stage: IndexingStage, total: number = 0): void {
    this.currentStage = stage;
    this.currentTotal = total;
    this.verboseLines = [];

    if (this.options.json) {
      this.emitJson({
        type: 'stage_start',
        timestamp: new Date().toISOString(),
        stage,
        data: { total },
      });
      return;
    }

    if (this.options.isInteractive) {
      // Stop any existing spinner
      this.spinner?.stop();

      // Start new spinner
      const label = STAGE_LABELS[stage];
      this.spinner = ora({
        text: `${label}...`,
        prefixText: chalk.cyan(label.padEnd(12)),
      }).start();
    } else {
      // Non-TTY: simple text output
      console.log(`${STAGE_LABELS[stage]}...`);
    }
  }

  /**
   * Update progress within the current stage.
   *
   * @param processed - Number of items processed so far
   * @param currentFile - Current file being processed (optional)
   */
  updateProgress(processed: number, currentFile?: string): void {
    if (!this.currentStage) return;

    // Throttle updates to prevent flickering
    const now = performance.now();
    if (now - this.lastUpdateTime < ProgressReporter.UPDATE_THROTTLE_MS) {
      return;
    }
    this.lastUpdateTime = now;

    if (this.options.json) {
      this.emitJson({
        type: 'stage_progress',
        timestamp: new Date().toISOString(),
        stage: this.currentStage,
        data: {
          processed,
          total: this.currentTotal,
          currentFile,
        },
      });
      return;
    }

    // Build progress text
    let progressText: string;
    if (this.currentTotal > 0) {
      const percentage = Math.round((processed / this.currentTotal) * 100);
      progressText = `${processed}/${this.currentTotal} (${percentage}%)`;
    } else {
      // Unknown total (scanning stage)
      progressText = `Found ${processed} files`;
    }

    // Truncate file path if needed
    const truncatedPath = currentFile
      ? this.truncatePath(currentFile)
      : '';

    if (this.options.isInteractive && this.spinner) {
      // Update spinner text
      this.spinner.text = truncatedPath
        ? `${progressText.padEnd(25)} ${chalk.dim(truncatedPath)}`
        : progressText;
    }

    // Verbose mode: collect file details for later display
    if (this.options.verbose && currentFile) {
      this.verboseLines.push(`  → ${currentFile}`);
    }
  }

  /**
   * Mark the current stage as complete.
   *
   * @param stats - Statistics about the completed stage
   */
  completeStage(stats: StageStats): void {
    if (this.options.json) {
      this.emitJson({
        type: 'stage_complete',
        timestamp: new Date().toISOString(),
        stage: stats.stage,
        data: {
          processed: stats.processed,
          total: stats.total,
          durationMs: stats.durationMs,
          details: stats.details,
        },
      });
    } else if (this.options.isInteractive && this.spinner) {
      // Show success with final count
      const label = STAGE_LABELS[stats.stage];
      this.spinner.succeed(
        `${stats.processed.toLocaleString()} ${this.getStageUnit(stats.stage)}`
      );

      // In verbose mode, show the collected file details
      if (this.options.verbose && this.verboseLines.length > 0) {
        // Show first 10 and indicate if more
        const linesToShow = this.verboseLines.slice(0, 10);
        for (const line of linesToShow) {
          console.log(chalk.dim(line));
        }
        if (this.verboseLines.length > 10) {
          console.log(chalk.dim(`  ... and ${this.verboseLines.length - 10} more`));
        }
      }
    } else {
      // Non-TTY
      console.log(
        `${STAGE_LABELS[stats.stage]} complete: ${stats.processed.toLocaleString()} ${this.getStageUnit(stats.stage)}`
      );
    }

    this.currentStage = null;
    this.spinner = null;
  }

  /**
   * Display a warning message.
   *
   * @param message - Warning message
   * @param context - Optional context (e.g., file path)
   */
  warn(message: string, context?: string): void {
    if (this.options.json) {
      this.emitJson({
        type: 'warning',
        timestamp: new Date().toISOString(),
        stage: this.currentStage ?? undefined,
        data: { message, context },
      });
      return;
    }

    // In interactive mode, warnings are only shown in verbose mode
    // (to not clutter the spinner output)
    if (this.options.verbose || !this.options.isInteractive) {
      const contextStr = context ? ` (${context})` : '';
      console.warn(chalk.yellow(`Warning: ${message}${contextStr}`));
    }
  }

  /**
   * Display an error message (non-fatal).
   *
   * @param message - Error message
   * @param context - Optional context (e.g., chunk ID)
   */
  error(message: string, context?: string): void {
    if (this.options.json) {
      this.emitJson({
        type: 'error',
        timestamp: new Date().toISOString(),
        stage: this.currentStage ?? undefined,
        data: { message, context },
      });
      return;
    }

    // Errors are always shown
    const contextStr = context ? ` (${context})` : '';
    console.error(chalk.red(`Error: ${message}${contextStr}`));
  }

  /**
   * Display the final summary after indexing completes.
   *
   * @param result - The complete pipeline result
   */
  showSummary(result: IndexPipelineResult): void {
    if (this.options.json) {
      this.emitJson({
        type: 'complete',
        timestamp: new Date().toISOString(),
        data: { result },
      });
      return;
    }

    // Format duration
    const duration = this.formatDuration(result.totalDurationMs);

    // Format database size
    const sizeIncrease = this.formatBytes(result.databaseSizeIncrease);

    console.log('');
    console.log(chalk.green.bold('Index Complete ✓'));
    console.log('');
    console.log(`  ${chalk.dim('Files indexed:')}    ${result.filesIndexed.toLocaleString()}`);
    console.log(`  ${chalk.dim('Chunks created:')}   ${result.chunksCreated.toLocaleString()}`);
    console.log(`  ${chalk.dim('Time elapsed:')}     ${duration}`);
    console.log(`  ${chalk.dim('Database size:')}    +${sizeIncrease}`);

    // Show stage breakdown in verbose mode
    if (this.options.verbose && Object.keys(result.stageDurations).length > 0) {
      console.log('');
      console.log(chalk.dim('  Breakdown:'));
      for (const [stage, durationMs] of Object.entries(result.stageDurations)) {
        const stageLabel = STAGE_LABELS[stage as IndexingStage];
        const stageDuration = this.formatDuration(durationMs);
        console.log(`    ${chalk.dim(stageLabel + ':')}${' '.repeat(12 - stageLabel.length)}${stageDuration}`);
      }
    }

    // Show warnings if any
    if (result.warnings.length > 0) {
      console.log('');
      console.log(chalk.yellow(`  ${result.warnings.length} warning(s) during indexing`));
      if (this.options.verbose) {
        for (const warning of result.warnings.slice(0, 5)) {
          console.log(chalk.dim(`    - ${warning}`));
        }
        if (result.warnings.length > 5) {
          console.log(chalk.dim(`    ... and ${result.warnings.length - 5} more`));
        }
      }
    }

    console.log('');
  }

  /**
   * Emit a JSON event to stdout.
   */
  private emitJson(event: ProgressEvent): void {
    console.log(JSON.stringify(event));
  }

  /**
   * Get the unit name for a stage (files, chunks, etc.).
   */
  private getStageUnit(stage: IndexingStage): string {
    switch (stage) {
      case 'scanning':
        return 'files';
      case 'chunking':
        return 'chunks';
      case 'embedding':
        return 'chunks embedded';
      case 'storing':
        return 'chunks stored';
    }
  }

  /**
   * Truncate a file path to fit display width.
   */
  private truncatePath(path: string): string {
    if (path.length <= ProgressReporter.MAX_PATH_LENGTH) {
      return path;
    }

    // Take the last MAX_PATH_LENGTH - 3 characters and prefix with ...
    return '...' + path.slice(-(ProgressReporter.MAX_PATH_LENGTH - 3));
  }

  /**
   * Format milliseconds as human-readable duration.
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    }
    if (ms < 60000) {
      return `${(ms / 1000).toFixed(1)}s`;
    }
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(0);
    return `${minutes}m ${seconds}s`;
  }

  /**
   * Format bytes as human-readable size.
   */
  private formatBytes(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}

/**
 * Create a ProgressReporter with sensible defaults.
 *
 * @param options - Partial options (defaults will be applied)
 * @returns Configured ProgressReporter instance
 */
export function createProgressReporter(
  options: Partial<ProgressReporterOptions> = {}
): ProgressReporter {
  return new ProgressReporter({
    json: options.json ?? false,
    verbose: options.verbose ?? false,
    noColor: options.noColor ?? !!process.env.NO_COLOR,
    isInteractive: options.isInteractive ?? (process.stdout.isTTY ?? false),
  });
}
