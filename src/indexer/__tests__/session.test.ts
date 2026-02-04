/**
 * IndexingSession Tests
 *
 * Tests the EventEmitter-based indexing session for background indexing:
 * - Event emission (stage:start, progress, complete, error, cancelled)
 * - Rate calculation with exponential moving average
 * - ETA estimation
 * - Cancellation support
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  IndexingSession,
  createIndexingSession,
  type ProgressData,
  type IndexingSessionStatus,
} from '../session.js';
import type { IndexPipelineOptions } from '../pipeline.js';
import type { IndexPipelineResult, IndexingStage } from '../../cli/utils/progress.js';

// Mock the pipeline module, but preserve IndexingCancelledError
vi.mock('../pipeline.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../pipeline.js')>();
  return {
    ...original,
    runIndexPipeline: vi.fn(),
  };
});

import { runIndexPipeline, IndexingCancelledError } from '../pipeline.js';

describe('IndexingSession', () => {
  let session: IndexingSession;

  beforeEach(() => {
    session = createIndexingSession();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('status management', () => {
    it('should start with idle status', () => {
      expect(session.getStatus()).toBe('idle');
      expect(session.isRunning()).toBe(false);
    });

    it('should transition to running when run() is called', async () => {
      const mockResult: IndexPipelineResult = {
        projectId: 'test-123',
        projectName: 'test-project',
        filesIndexed: 10,
        chunksCreated: 100,
        chunksStored: 100,
        totalDurationMs: 1000,
        stageDurations: {},
        databaseSizeIncrease: 1024,
        warnings: [],
        errors: [],
      };

      vi.mocked(runIndexPipeline).mockResolvedValue(mockResult);

      const runPromise = session.run({
        projectPath: '/test',
        projectName: 'test-project',
        embeddingProvider: {} as any,
      });

      // Status should be running immediately after calling run()
      expect(session.isRunning()).toBe(true);
      expect(session.getStatus()).toBe('running');

      await runPromise;

      expect(session.getStatus()).toBe('complete');
      expect(session.isRunning()).toBe(false);
    });

    it('should throw if run() is called while already running', async () => {
      vi.mocked(runIndexPipeline).mockImplementation(
        () => new Promise(() => {}) // Never resolves
      );

      // Start first run
      session.run({
        projectPath: '/test',
        projectName: 'test-project',
        embeddingProvider: {} as any,
      });

      // Try to start second run
      await expect(
        session.run({
          projectPath: '/test2',
          projectName: 'test-project-2',
          embeddingProvider: {} as any,
        })
      ).rejects.toThrow('already running');
    });
  });

  describe('event emission', () => {
    it('should emit stage:start event', async () => {
      const stageStartHandler = vi.fn();
      session.on('stage:start', stageStartHandler);

      vi.mocked(runIndexPipeline).mockImplementation(async (options) => {
        options.onStageStart?.('scanning', 50);
        return {
          projectId: 'test-123',
          projectName: 'test-project',
          filesIndexed: 10,
          chunksCreated: 100,
          chunksStored: 100,
          totalDurationMs: 1000,
          stageDurations: {},
          databaseSizeIncrease: 1024,
          warnings: [],
          errors: [],
        };
      });

      await session.run({
        projectPath: '/test',
        projectName: 'test-project',
        embeddingProvider: {} as any,
      });

      expect(stageStartHandler).toHaveBeenCalledWith('scanning', 50);
    });

    it('should emit progress event with calculated rate', async () => {
      const progressHandler = vi.fn();
      session.on('progress', progressHandler);

      vi.mocked(runIndexPipeline).mockImplementation(async (options) => {
        options.onStageStart?.('embedding', 100);

        // Simulate progress updates with time delay
        for (let i = 1; i <= 3; i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          options.onProgress?.('embedding', i * 10, 100);
        }

        return {
          projectId: 'test-123',
          projectName: 'test-project',
          filesIndexed: 10,
          chunksCreated: 100,
          chunksStored: 100,
          totalDurationMs: 1000,
          stageDurations: {},
          databaseSizeIncrease: 1024,
          warnings: [],
          errors: [],
        };
      });

      await session.run({
        projectPath: '/test',
        projectName: 'test-project',
        embeddingProvider: {} as any,
      });

      expect(progressHandler).toHaveBeenCalled();

      // Check that later calls have rate calculated
      const lastCall = progressHandler.mock.calls[progressHandler.mock.calls.length - 1];
      const progressData = lastCall[0] as ProgressData;

      expect(progressData.stage).toBe('embedding');
      expect(progressData.processed).toBe(30);
      expect(progressData.total).toBe(100);
      // Rate should be calculated after multiple updates
      if (progressHandler.mock.calls.length > 1) {
        expect(progressData.rate).toBeGreaterThan(0);
      }
    });

    it('should emit complete event on success', async () => {
      const completeHandler = vi.fn();
      session.on('complete', completeHandler);

      const mockResult: IndexPipelineResult = {
        projectId: 'test-123',
        projectName: 'test-project',
        filesIndexed: 10,
        chunksCreated: 100,
        chunksStored: 100,
        totalDurationMs: 1000,
        stageDurations: {},
        databaseSizeIncrease: 1024,
        warnings: [],
        errors: [],
      };

      vi.mocked(runIndexPipeline).mockResolvedValue(mockResult);

      await session.run({
        projectPath: '/test',
        projectName: 'test-project',
        embeddingProvider: {} as any,
      });

      expect(completeHandler).toHaveBeenCalledWith(mockResult);
    });

    it('should emit error event on failure', async () => {
      const errorHandler = vi.fn();
      session.on('error', errorHandler);

      const testError = new Error('Test error');
      vi.mocked(runIndexPipeline).mockRejectedValue(testError);

      await expect(
        session.run({
          projectPath: '/test',
          projectName: 'test-project',
          embeddingProvider: {} as any,
        })
      ).rejects.toThrow('Test error');

      expect(errorHandler).toHaveBeenCalledWith(testError);
      expect(session.getStatus()).toBe('error');
    });
  });

  describe('cancellation', () => {
    it('should emit cancelled event when cancel() is called', async () => {
      const cancelledHandler = vi.fn();
      session.on('cancelled', cancelledHandler);

      vi.mocked(runIndexPipeline).mockImplementation(async (options) => {
        // Check for signal abort
        await new Promise((resolve) => setTimeout(resolve, 100));

        if (options.signal?.aborted) {
          throw new Error('Indexing cancelled');
        }

        return {
          projectId: 'test-123',
          projectName: 'test-project',
          filesIndexed: 10,
          chunksCreated: 100,
          chunksStored: 100,
          totalDurationMs: 1000,
          stageDurations: {},
          databaseSizeIncrease: 1024,
          warnings: [],
          errors: [],
        };
      });

      const runPromise = session.run({
        projectPath: '/test',
        projectName: 'test-project',
        embeddingProvider: {} as any,
      });

      // Cancel after a short delay
      setTimeout(() => session.cancel(), 50);

      await expect(runPromise).rejects.toThrow('cancelled');
      expect(cancelledHandler).toHaveBeenCalled();
      expect(session.getStatus()).toBe('cancelled');
    });

    it('should not emit cancelled if not running', () => {
      const cancelledHandler = vi.fn();
      session.on('cancelled', cancelledHandler);

      session.cancel(); // Should do nothing

      expect(cancelledHandler).not.toHaveBeenCalled();
      expect(session.getStatus()).toBe('idle');
    });
  });

  describe('rate calculation', () => {
    it('should indicate warmup during first embedding batch', async () => {
      const progressHandler = vi.fn();
      session.on('progress', progressHandler);

      vi.mocked(runIndexPipeline).mockImplementation(async (options) => {
        options.onStageStart?.('embedding', 100);
        options.onProgress?.('embedding', 0, 100); // First batch starting

        return {
          projectId: 'test-123',
          projectName: 'test-project',
          filesIndexed: 10,
          chunksCreated: 100,
          chunksStored: 100,
          totalDurationMs: 1000,
          stageDurations: {},
          databaseSizeIncrease: 1024,
          warnings: [],
          errors: [],
        };
      });

      await session.run({
        projectPath: '/test',
        projectName: 'test-project',
        embeddingProvider: {} as any,
      });

      const firstProgress = progressHandler.mock.calls[0][0] as ProgressData;
      expect(firstProgress.warmingUp).toBe(true);
    });
  });

  describe('createIndexingSession factory', () => {
    it('should create a new IndexingSession instance', () => {
      const session1 = createIndexingSession();
      const session2 = createIndexingSession();

      expect(session1).toBeInstanceOf(IndexingSession);
      expect(session2).toBeInstanceOf(IndexingSession);
      expect(session1).not.toBe(session2); // Different instances
    });
  });
});
