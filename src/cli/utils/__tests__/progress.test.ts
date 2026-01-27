/**
 * ProgressReporter Tests
 *
 * Tests the progress display system for different output modes:
 * - Interactive (TTY with spinners)
 * - JSON (NDJSON events)
 * - Non-interactive (simple text)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ProgressReporter,
  createProgressReporter,
  type ProgressReporterOptions,
  type StageStats,
  type IndexPipelineResult,
} from '../progress.js';

describe('ProgressReporter', () => {
  // Capture console output
  let consoleOutput: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  beforeEach(() => {
    consoleOutput = [];
    console.log = vi.fn((...args) => {
      consoleOutput.push(args.map(String).join(' '));
    });
    console.error = vi.fn((...args) => {
      consoleOutput.push(args.map(String).join(' '));
    });
    console.warn = vi.fn((...args) => {
      consoleOutput.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    vi.restoreAllMocks();
  });

  describe('JSON mode', () => {
    const jsonOptions: ProgressReporterOptions = {
      json: true,
      verbose: false,
      noColor: false,
      isInteractive: false,
    };

    it('should emit stage_start event', () => {
      const reporter = new ProgressReporter(jsonOptions);
      reporter.startStage('scanning', 100);

      expect(consoleOutput).toHaveLength(1);
      const event = JSON.parse(consoleOutput[0]!);
      expect(event.type).toBe('stage_start');
      expect(event.stage).toBe('scanning');
      expect(event.data.total).toBe(100);
      expect(event.timestamp).toBeDefined();
    });

    it('should emit stage_progress event', async () => {
      const reporter = new ProgressReporter(jsonOptions);
      reporter.startStage('chunking', 50);

      // Wait for throttle to pass
      await new Promise((resolve) => setTimeout(resolve, 150));

      reporter.updateProgress(25, 'src/file.ts');

      expect(consoleOutput).toHaveLength(2); // start + progress
      const event = JSON.parse(consoleOutput[1]!);
      expect(event.type).toBe('stage_progress');
      expect(event.stage).toBe('chunking');
      expect(event.data.processed).toBe(25);
      expect(event.data.total).toBe(50);
      expect(event.data.currentFile).toBe('src/file.ts');
    });

    it('should emit stage_complete event', () => {
      const reporter = new ProgressReporter(jsonOptions);
      const stats: StageStats = {
        stage: 'embedding',
        processed: 100,
        total: 100,
        durationMs: 5000,
        details: { successRate: '98%' },
      };

      reporter.completeStage(stats);

      expect(consoleOutput).toHaveLength(1);
      const event = JSON.parse(consoleOutput[0]!);
      expect(event.type).toBe('stage_complete');
      expect(event.stage).toBe('embedding');
      expect(event.data.processed).toBe(100);
      expect(event.data.durationMs).toBe(5000);
      expect(event.data.details?.successRate).toBe('98%');
    });

    it('should emit warning event', () => {
      const reporter = new ProgressReporter(jsonOptions);
      reporter.warn('File too large', 'src/big.ts');

      expect(consoleOutput).toHaveLength(1);
      const event = JSON.parse(consoleOutput[0]!);
      expect(event.type).toBe('warning');
      expect(event.data.message).toBe('File too large');
      expect(event.data.context).toBe('src/big.ts');
    });

    it('should emit error event', () => {
      const reporter = new ProgressReporter(jsonOptions);
      reporter.error('Embedding failed', 'chunk-123');

      expect(consoleOutput).toHaveLength(1);
      const event = JSON.parse(consoleOutput[0]!);
      expect(event.type).toBe('error');
      expect(event.data.message).toBe('Embedding failed');
      expect(event.data.context).toBe('chunk-123');
    });

    it('should emit complete event on summary', () => {
      const reporter = new ProgressReporter(jsonOptions);
      const result: IndexPipelineResult = {
        projectId: 'test-123',
        projectName: 'my-project',
        filesIndexed: 50,
        chunksCreated: 200,
        chunksStored: 200,
        totalDurationMs: 30000,
        stageDurations: { scanning: 1000, chunking: 5000 },
        databaseSizeIncrease: 1024 * 1024,
        warnings: [],
        errors: [],
      };

      reporter.showSummary(result);

      expect(consoleOutput).toHaveLength(1);
      const event = JSON.parse(consoleOutput[0]!);
      expect(event.type).toBe('complete');
      expect(event.data.result.filesIndexed).toBe(50);
      expect(event.data.result.chunksCreated).toBe(200);
    });
  });

  describe('Non-interactive mode', () => {
    const textOptions: ProgressReporterOptions = {
      json: false,
      verbose: false,
      noColor: true, // Disable colors for predictable output
      isInteractive: false,
    };

    it('should output text for stage start', () => {
      const reporter = new ProgressReporter(textOptions);
      reporter.startStage('scanning', 0);

      expect(consoleOutput).toHaveLength(1);
      expect(consoleOutput[0]).toContain('Scanning');
    });

    it('should output text for stage complete', () => {
      const reporter = new ProgressReporter(textOptions);
      const stats: StageStats = {
        stage: 'scanning',
        processed: 100,
        total: 100,
        durationMs: 1000,
      };

      reporter.completeStage(stats);

      expect(consoleOutput).toHaveLength(1);
      expect(consoleOutput[0]).toContain('Scanning complete');
      expect(consoleOutput[0]).toContain('100');
    });

    it('should always show errors', () => {
      const reporter = new ProgressReporter(textOptions);
      reporter.error('Something went wrong', 'file.ts');

      expect(consoleOutput).toHaveLength(1);
      expect(consoleOutput[0]).toContain('Error');
      expect(consoleOutput[0]).toContain('Something went wrong');
    });
  });

  describe('createProgressReporter factory', () => {
    it('should create reporter with defaults', () => {
      const reporter = createProgressReporter();
      expect(reporter).toBeInstanceOf(ProgressReporter);
    });

    it('should create reporter with custom options', () => {
      const reporter = createProgressReporter({
        json: true,
        verbose: true,
      });
      expect(reporter).toBeInstanceOf(ProgressReporter);
    });
  });

  describe('update throttling', () => {
    const jsonOptions: ProgressReporterOptions = {
      json: true,
      verbose: false,
      noColor: false,
      isInteractive: false,
    };

    it('should throttle rapid updates', async () => {
      const reporter = new ProgressReporter(jsonOptions);
      reporter.startStage('scanning', 100);

      // First update goes through (no previous time)
      reporter.updateProgress(1);

      // These should be throttled (too fast)
      reporter.updateProgress(2);
      reporter.updateProgress(3);
      reporter.updateProgress(4);

      // Should have start + first progress = 2
      expect(consoleOutput).toHaveLength(2);
    });

    it('should emit after throttle delay', async () => {
      const reporter = new ProgressReporter(jsonOptions);
      reporter.startStage('scanning', 100);
      reporter.updateProgress(5); // First update

      // Wait for throttle to pass
      await new Promise((resolve) => setTimeout(resolve, 150));
      reporter.updateProgress(10);

      expect(consoleOutput).toHaveLength(3); // start + first + delayed
    });
  });
});
