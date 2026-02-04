/**
 * Indexing Session
 *
 * EventEmitter-based wrapper around the indexing pipeline that enables:
 * - Background execution with event-driven progress updates
 * - Graceful cancellation via AbortController
 * - Rate calculation (chunks/sec) with exponential moving average
 * - ETA estimation based on remaining work and current rate
 *
 * This class is designed for chat mode where indexing runs in the background
 * while the user continues interacting with the REPL.
 */

import { EventEmitter } from 'node:events';
import { runIndexPipeline, type IndexPipelineOptions } from './pipeline.js';
import type {
  IndexingStage,
  StageStats,
  IndexPipelineResult,
} from '../cli/utils/progress.js';

/**
 * Progress data emitted during indexing.
 * Includes rate and ETA calculations for UI display.
 */
export interface ProgressData {
  /** Current indexing stage */
  stage: IndexingStage;

  /** Number of items processed so far */
  processed: number;

  /** Total items to process in this stage */
  total: number;

  /** Processing rate in items/second (exponential moving average) */
  rate?: number;

  /** Estimated time remaining in seconds */
  eta?: number;

  /** Current file being processed (if applicable) */
  currentFile?: string;

  /** True during first embedding batch when model may be warming up */
  warmingUp?: boolean;
}

/**
 * Status of the indexing session.
 */
export type IndexingSessionStatus =
  | 'idle'
  | 'running'
  | 'cancelled'
  | 'complete'
  | 'error';

/**
 * Type-safe event map for IndexingSession.
 */
export interface IndexingSessionEvents {
  'stage:start': [stage: IndexingStage, total: number];
  progress: [data: ProgressData];
  'stage:complete': [stage: IndexingStage, stats: StageStats];
  complete: [result: IndexPipelineResult];
  error: [error: Error];
  cancelled: [];
}

/**
 * IndexingSession wraps the indexing pipeline with event-driven progress
 * reporting and cancellation support.
 *
 * @example
 * ```typescript
 * const session = new IndexingSession();
 *
 * session.on('progress', (data) => {
 *   console.log(`${data.stage}: ${data.processed}/${data.total}`);
 *   if (data.rate) console.log(`Rate: ${data.rate.toFixed(1)} chunks/sec`);
 *   if (data.eta) console.log(`ETA: ${data.eta}s`);
 * });
 *
 * session.on('complete', (result) => {
 *   console.log(`Indexed ${result.chunksStored} chunks`);
 * });
 *
 * // Start indexing (returns promise)
 * const result = await session.run(pipelineOptions);
 *
 * // Or cancel if needed
 * session.cancel();
 * ```
 */
export class IndexingSession extends EventEmitter<IndexingSessionEvents> {
  private status: IndexingSessionStatus = 'idle';
  private abortController: AbortController | null = null;

  // Rate calculation state
  private rateHistory: number[] = [];
  private lastProgressTime: number = 0;
  private lastProcessedCount: number = 0;
  private currentStage: IndexingStage | null = null;
  private stageStartTime: number = 0;
  private isFirstBatch: boolean = true;

  // EMA smoothing factor (0.3 = 30% weight to new value)
  private static readonly RATE_ALPHA = 0.3;
  private static readonly RATE_HISTORY_SIZE = 10;

  /**
   * Get the current session status.
   */
  getStatus(): IndexingSessionStatus {
    return this.status;
  }

  /**
   * Check if the session is currently running.
   */
  isRunning(): boolean {
    return this.status === 'running';
  }

  /**
   * Start the indexing session.
   *
   * @param options - Pipeline options (same as runIndexPipeline)
   * @returns Promise that resolves with the result, or rejects on error/cancel
   * @throws Error if session is already running
   */
  async run(options: IndexPipelineOptions): Promise<IndexPipelineResult> {
    if (this.status === 'running') {
      throw new Error('IndexingSession is already running');
    }

    // Reset state
    this.status = 'running';
    this.abortController = new AbortController();
    this.rateHistory = [];
    this.lastProgressTime = 0;
    this.lastProcessedCount = 0;
    this.currentStage = null;
    this.isFirstBatch = true;

    try {
      const result = await runIndexPipeline({
        ...options,
        signal: this.abortController.signal,

        onStageStart: (stage, total) => {
          this.handleStageStart(stage, total);
          options.onStageStart?.(stage, total);
        },

        onProgress: (stage, processed, total, currentFile) => {
          this.handleProgress(stage, processed, total, currentFile);
          options.onProgress?.(stage, processed, total, currentFile);
        },

        onStageComplete: (stage, stats) => {
          this.handleStageComplete(stage, stats);
          options.onStageComplete?.(stage, stats);
        },

        onWarning: (message, context) => {
          options.onWarning?.(message, context);
        },

        onError: (error, context) => {
          options.onError?.(error, context);
        },
      });

      this.status = 'complete';
      this.emit('complete', result);
      return result;
    } catch (error) {
      if (this.status === 'cancelled') {
        this.emit('cancelled');
        throw new Error('Indexing cancelled by user');
      }

      this.status = 'error';
      this.emit('error', error as Error);
      throw error;
    }
  }

  /**
   * Cancel the running session.
   *
   * The session will stop at the next safe checkpoint (between batches).
   * Partial data may be discarded depending on the stage.
   */
  cancel(): void {
    if (this.status === 'running') {
      this.status = 'cancelled';
      this.abortController?.abort();
    }
  }

  /**
   * Handle stage start event.
   */
  private handleStageStart(stage: IndexingStage, total: number): void {
    this.currentStage = stage;
    this.stageStartTime = performance.now();
    this.lastProgressTime = 0;
    this.lastProcessedCount = 0;
    this.rateHistory = [];

    // Reset first batch flag for embedding stage
    if (stage === 'embedding') {
      this.isFirstBatch = true;
    }

    this.emit('stage:start', stage, total);
  }

  /**
   * Handle progress update event.
   */
  private handleProgress(
    stage: IndexingStage,
    processed: number,
    total: number,
    currentFile?: string
  ): void {
    const rate = this.calculateRate(processed);
    const eta = this.calculateEta(total - processed, rate);

    // Determine if this is first batch (for warmup indicator)
    const warmingUp = stage === 'embedding' && this.isFirstBatch && processed === 0;

    // After first progress update in embedding, no longer first batch
    if (stage === 'embedding' && processed > 0) {
      this.isFirstBatch = false;
    }

    const progressData: ProgressData = {
      stage,
      processed,
      total,
      rate: rate > 0 ? rate : undefined,
      eta: eta !== undefined && eta > 0 ? eta : undefined,
      currentFile,
      warmingUp,
    };

    this.emit('progress', progressData);
  }

  /**
   * Handle stage complete event.
   */
  private handleStageComplete(stage: IndexingStage, stats: StageStats): void {
    this.emit('stage:complete', stage, stats);
  }

  /**
   * Calculate processing rate using exponential moving average.
   *
   * @param processed - Current number of items processed
   * @returns Rate in items/second (smoothed)
   */
  private calculateRate(processed: number): number {
    const now = performance.now();

    if (this.lastProgressTime > 0) {
      const elapsedSec = (now - this.lastProgressTime) / 1000;
      const delta = processed - this.lastProcessedCount;

      if (elapsedSec > 0 && delta > 0) {
        const instantRate = delta / elapsedSec;

        // Add to history with EMA smoothing
        this.rateHistory.push(instantRate);
        if (this.rateHistory.length > IndexingSession.RATE_HISTORY_SIZE) {
          this.rateHistory.shift();
        }
      }
    }

    this.lastProgressTime = now;
    this.lastProcessedCount = processed;

    // Calculate EMA from history
    if (this.rateHistory.length === 0) return 0;

    let ema = this.rateHistory[0];
    for (let i = 1; i < this.rateHistory.length; i++) {
      ema =
        IndexingSession.RATE_ALPHA * this.rateHistory[i] +
        (1 - IndexingSession.RATE_ALPHA) * ema;
    }

    return ema;
  }

  /**
   * Calculate estimated time remaining.
   *
   * @param remaining - Number of items remaining to process
   * @param rate - Current processing rate (items/sec)
   * @returns Estimated seconds remaining, or undefined if rate is 0
   */
  private calculateEta(remaining: number, rate: number): number | undefined {
    if (rate <= 0 || remaining <= 0) return undefined;
    return Math.ceil(remaining / rate);
  }
}

/**
 * Create a new IndexingSession instance.
 *
 * @example
 * ```typescript
 * const session = createIndexingSession();
 * session.on('progress', handleProgress);
 * await session.run(options);
 * ```
 */
export function createIndexingSession(): IndexingSession {
  return new IndexingSession();
}
