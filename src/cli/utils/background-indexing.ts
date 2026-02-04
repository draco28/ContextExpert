/**
 * Background Indexing Coordinator
 *
 * Manages background indexing operations for chat mode. This is the bridge
 * between the IndexingSession (which does the work) and the StatusBarRenderer
 * (which shows progress).
 *
 * Key responsibilities:
 * - Ensure only one indexing operation runs at a time
 * - Wire up IndexingSession events to StatusBarRenderer
 * - Provide cancellation API for /index cancel command
 * - Track status for /index status queries
 *
 * Uses singleton pattern since there should only be one coordinator per CLI.
 */

import {
  IndexingSession,
  createIndexingSession,
  type ProgressData,
} from '../../indexer/session.js';
import type { IndexPipelineOptions } from '../../indexer/pipeline.js';
import type { IndexPipelineResult, IndexingStage } from './progress.js';
import { StatusBarRenderer, createStatusBar, type StatusBarOptions } from './status-bar.js';

/**
 * Status information returned by getStatus().
 */
export interface BackgroundIndexingStatus {
  /** Whether indexing is currently running */
  running: boolean;

  /** Current stage if running */
  stage?: IndexingStage;

  /** Current progress data if running */
  progress?: ProgressData;

  /** Project being indexed if running */
  projectName?: string;

  /** When indexing started (ms since epoch) */
  startedAt?: number;
}

/**
 * Options for starting a background indexing operation.
 */
export interface BackgroundIndexingOptions {
  /** Pipeline options (same as runIndexPipeline) */
  pipelineOptions: IndexPipelineOptions;

  /** Status bar configuration options (omit to skip StatusBarRenderer, e.g. in TUI mode) */
  statusBarOptions?: StatusBarOptions;

  /** Readline interface to attach status bar to */
  readline?: import('node:readline').Interface;

  /** Progress callback (for TUI integration) */
  onProgress?: (data: { stage: string; processed: number; total: number; projectName: string }) => void;

  /** Callback when indexing completes successfully */
  onComplete?: (result: IndexPipelineResult) => void;

  /** Callback when indexing fails */
  onError?: (error: Error) => void;

  /** Callback when indexing is cancelled */
  onCancelled?: () => void;
}

/**
 * BackgroundIndexingCoordinator manages background indexing operations.
 *
 * @example
 * ```typescript
 * const coordinator = getBackgroundIndexingCoordinator();
 *
 * // Start background indexing
 * coordinator.start({
 *   pipelineOptions: { projectPath, projectName, embeddingProvider },
 *   readline: rl,
 *   onComplete: (result) => console.log(`Indexed ${result.chunksStored} chunks`),
 * });
 *
 * // Later, check status
 * const status = coordinator.getStatus();
 * if (status.running) {
 *   console.log(`Indexing ${status.projectName}: ${status.progress?.processed}/${status.progress?.total}`);
 * }
 *
 * // Or cancel
 * coordinator.cancel();
 * ```
 */
export class BackgroundIndexingCoordinator {
  private activeSession: IndexingSession | null = null;
  private statusBar: StatusBarRenderer | null = null;
  private currentProjectName: string | null = null;
  private startedAt: number | null = null;
  private lastProgress: ProgressData | null = null;
  private currentStage: IndexingStage | null = null;

  /**
   * Start a background indexing operation.
   *
   * This method returns immediately (does not await completion).
   * Use the callbacks to handle completion, errors, and cancellation.
   *
   * @throws Error if indexing is already in progress
   */
  start(options: BackgroundIndexingOptions): void {
    const {
      pipelineOptions,
      statusBarOptions,
      readline,
      onProgress,
      onComplete,
      onError,
      onCancelled,
    } = options;

    // Check if already running
    if (this.isRunning()) {
      throw new Error(
        'Indexing already in progress. Use /index cancel to stop it first.'
      );
    }

    // Create new session and status bar (skip StatusBarRenderer when no options, e.g. TUI mode)
    this.activeSession = createIndexingSession();
    this.statusBar = statusBarOptions ? createStatusBar(statusBarOptions) : null;
    this.currentProjectName = pipelineOptions.projectName;
    this.startedAt = Date.now();
    this.lastProgress = null;
    this.currentStage = null;

    // Attach status bar to readline if provided
    if (readline && this.statusBar) {
      this.statusBar.attach(readline);
    }

    // Wire up session events to status bar
    this.activeSession.on('stage:start', (stage, total) => {
      this.currentStage = stage;
      this.statusBar?.setStage(stage, total);
    });

    this.activeSession.on('progress', (data) => {
      this.lastProgress = data;
      this.statusBar?.update(data);
      onProgress?.({
        stage: data.stage,
        processed: data.processed,
        total: data.total,
        projectName: pipelineOptions.projectName,
      });
    });

    this.activeSession.on('complete', (result) => {
      this.statusBar?.showSuccess(`Indexed ${result.projectName}`);
      this.cleanup();
      onComplete?.(result);
    });

    this.activeSession.on('error', (error) => {
      this.statusBar?.showError(error.message);
      this.cleanup();
      onError?.(error);
    });

    this.activeSession.on('cancelled', () => {
      this.statusBar?.showCancelled();
      this.cleanup();
      onCancelled?.();
    });

    // Start the session (fire-and-forget - callbacks handle results)
    this.activeSession.run(pipelineOptions).catch((error) => {
      // Handle unexpected errors that bypass the event system
      if (error.message !== 'Indexing cancelled by user') {
        this.statusBar?.showError(error.message);
        this.cleanup();
        onError?.(error);
      }
    });
  }

  /**
   * Cancel the active indexing operation.
   *
   * @returns true if cancellation was triggered, false if nothing was running
   */
  cancel(): boolean {
    if (this.activeSession?.isRunning()) {
      this.activeSession.cancel();
      return true;
    }
    return false;
  }

  /**
   * Check if indexing is currently running.
   */
  isRunning(): boolean {
    return this.activeSession?.isRunning() ?? false;
  }

  /**
   * Get current status for /index status command.
   */
  getStatus(): BackgroundIndexingStatus {
    if (!this.isRunning()) {
      return { running: false };
    }

    return {
      running: true,
      stage: this.currentStage ?? undefined,
      progress: this.lastProgress ?? undefined,
      projectName: this.currentProjectName ?? undefined,
      startedAt: this.startedAt ?? undefined,
    };
  }

  /**
   * Clean up after indexing completes/fails/cancels.
   */
  private cleanup(): void {
    this.activeSession = null;
    this.statusBar = null;
    this.currentProjectName = null;
    this.startedAt = null;
    this.lastProgress = null;
    this.currentStage = null;
  }
}

// Singleton instance
let coordinatorInstance: BackgroundIndexingCoordinator | null = null;

/**
 * Get the singleton BackgroundIndexingCoordinator instance.
 *
 * Using a singleton ensures only one indexing operation runs at a time
 * across the entire CLI process.
 */
export function getBackgroundIndexingCoordinator(): BackgroundIndexingCoordinator {
  if (!coordinatorInstance) {
    coordinatorInstance = new BackgroundIndexingCoordinator();
  }
  return coordinatorInstance;
}

/**
 * Reset the coordinator instance (for testing).
 * @internal
 */
export function resetBackgroundIndexingCoordinator(): void {
  coordinatorInstance = null;
}
