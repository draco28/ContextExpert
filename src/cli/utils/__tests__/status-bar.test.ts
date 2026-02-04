/**
 * StatusBarRenderer Tests
 *
 * Tests the ANSI-based status bar for background indexing:
 * - Progress bar rendering
 * - Rate and ETA display
 * - ANSI escape code output
 * - Throttling behavior
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  StatusBarRenderer,
  createStatusBar,
  type StatusBarOptions,
} from '../status-bar.js';
import type { ProgressData } from '../../../indexer/session.js';

describe('StatusBarRenderer', () => {
  let statusBar: StatusBarRenderer;
  let writeOutput: string[] = [];
  const originalWrite = process.stdout.write;
  const originalIsTTY = process.stdout.isTTY;
  const originalColumns = process.stdout.columns;

  beforeEach(() => {
    writeOutput = [];

    // Mock stdout.write
    process.stdout.write = vi.fn((data: string | Uint8Array) => {
      writeOutput.push(data.toString());
      return true;
    }) as any;

    // Mock TTY
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    Object.defineProperty(process.stdout, 'columns', {
      value: 100,
      configurable: true,
    });

    statusBar = createStatusBar({ terminalWidth: 100 });
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'columns', {
      value: originalColumns,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  describe('show/hide', () => {
    it('should add newline when showing status bar', () => {
      statusBar.show();
      expect(writeOutput.some((s) => s.includes('\n'))).toBe(true);
    });

    it('should only show once (idempotent)', () => {
      statusBar.show();
      const countAfterFirst = writeOutput.filter((s) => s.includes('\n')).length;

      statusBar.show();
      const countAfterSecond = writeOutput.filter((s) => s.includes('\n')).length;

      expect(countAfterSecond).toBe(countAfterFirst);
    });

    it('should clear line when hiding', () => {
      statusBar.show();
      statusBar.hide();

      // Should contain clear line escape code
      expect(writeOutput.some((s) => s.includes('\x1b[2K'))).toBe(true);
    });
  });

  describe('setStage', () => {
    it('should show status bar and render initial state', () => {
      statusBar.setStage('embedding', 100);

      // Should have rendered something
      expect(writeOutput.length).toBeGreaterThan(0);

      // Should contain the stage name
      expect(writeOutput.some((s) => s.includes('Embedding'))).toBe(true);
    });

    it('should update current stage', () => {
      statusBar.setStage('scanning', 50);
      expect(statusBar.getCurrentStage()).toBe('scanning');

      statusBar.setStage('embedding', 100);
      expect(statusBar.getCurrentStage()).toBe('embedding');
    });
  });

  describe('update', () => {
    it('should update progress data', () => {
      statusBar.setStage('embedding', 100);

      const progressData: ProgressData = {
        stage: 'embedding',
        processed: 50,
        total: 100,
        rate: 10.5,
        eta: 5,
      };

      statusBar.update(progressData);

      expect(statusBar.getCurrentProgress()).toEqual(progressData);
    });

    it('should throttle updates', async () => {
      statusBar.setStage('embedding', 100);
      writeOutput = []; // Clear initial render

      // Rapid updates
      for (let i = 0; i < 10; i++) {
        statusBar.update({
          stage: 'embedding',
          processed: i * 10,
          total: 100,
        });
      }

      // Should have been throttled (not all 10 rendered)
      // First update goes through, subsequent ones within throttle window are skipped
      expect(writeOutput.length).toBeLessThan(10);
    });

    it('should show rate and ETA for embedding stage', async () => {
      statusBar.setStage('embedding', 100);

      // Wait for throttle
      await new Promise((resolve) => setTimeout(resolve, 150));

      statusBar.update({
        stage: 'embedding',
        processed: 50,
        total: 100,
        rate: 2.5,
        eta: 20,
      });

      // Should contain rate
      expect(writeOutput.some((s) => s.includes('chunks/sec'))).toBe(true);

      // Should contain ETA
      expect(writeOutput.some((s) => s.includes('ETA'))).toBe(true);
    });

    it('should show warmup message during first batch', async () => {
      statusBar.setStage('embedding', 100);

      // Wait for throttle
      await new Promise((resolve) => setTimeout(resolve, 150));

      statusBar.update({
        stage: 'embedding',
        processed: 0,
        total: 100,
        warmingUp: true,
      });

      expect(writeOutput.some((s) => s.includes('Warming up'))).toBe(true);
    });
  });

  describe('progress bar rendering', () => {
    it('should render filled and empty blocks', async () => {
      statusBar.setStage('embedding', 100);

      // Wait for throttle
      await new Promise((resolve) => setTimeout(resolve, 150));

      statusBar.update({
        stage: 'embedding',
        processed: 50,
        total: 100,
      });

      // Should contain progress bar characters
      expect(writeOutput.some((s) => s.includes('█') || s.includes('░'))).toBe(true);
    });

    it('should show percentage', async () => {
      statusBar.setStage('embedding', 100);

      // Wait for throttle
      await new Promise((resolve) => setTimeout(resolve, 150));

      statusBar.update({
        stage: 'embedding',
        processed: 25,
        total: 100,
      });

      expect(writeOutput.some((s) => s.includes('25%'))).toBe(true);
    });
  });

  describe('ANSI escape codes', () => {
    it('should use cursor save/restore', () => {
      statusBar.setStage('embedding', 100);

      // Save cursor: \x1b[s
      expect(writeOutput.some((s) => s.includes('\x1b[s'))).toBe(true);

      // Restore cursor: \x1b[u
      expect(writeOutput.some((s) => s.includes('\x1b[u'))).toBe(true);
    });

    it('should use clear line', () => {
      statusBar.setStage('embedding', 100);

      // Clear line: \x1b[2K
      expect(writeOutput.some((s) => s.includes('\x1b[2K'))).toBe(true);
    });
  });

  describe('non-TTY mode', () => {
    beforeEach(() => {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        configurable: true,
      });
      statusBar = createStatusBar({ terminalWidth: 100 });
    });

    it('should not output anything in non-TTY mode', () => {
      writeOutput = [];

      statusBar.show();
      statusBar.setStage('embedding', 100);
      statusBar.update({
        stage: 'embedding',
        processed: 50,
        total: 100,
      });

      // Should not have written anything
      expect(writeOutput.length).toBe(0);
    });
  });

  describe('status messages', () => {
    it('should show success message', () => {
      statusBar.show();
      statusBar.showSuccess('Project indexed');

      expect(writeOutput.some((s) => s.includes('✓'))).toBe(true);
      expect(writeOutput.some((s) => s.includes('Project indexed'))).toBe(true);
    });

    it('should show error message', () => {
      statusBar.show();
      statusBar.showError('Failed to index');

      expect(writeOutput.some((s) => s.includes('✗'))).toBe(true);
      expect(writeOutput.some((s) => s.includes('Failed to index'))).toBe(true);
    });

    it('should show cancelled message', () => {
      statusBar.show();
      statusBar.showCancelled();

      expect(writeOutput.some((s) => s.includes('⚠'))).toBe(true);
      expect(writeOutput.some((s) => s.includes('cancelled'))).toBe(true);
    });
  });

  describe('ETA formatting', () => {
    it('should format seconds correctly', async () => {
      statusBar.setStage('embedding', 100);
      await new Promise((resolve) => setTimeout(resolve, 150));

      statusBar.update({
        stage: 'embedding',
        processed: 50,
        total: 100,
        rate: 2,
        eta: 45,
      });

      expect(writeOutput.some((s) => s.includes('45s'))).toBe(true);
    });

    it('should format minutes and seconds correctly', async () => {
      statusBar.setStage('embedding', 100);
      await new Promise((resolve) => setTimeout(resolve, 150));

      statusBar.update({
        stage: 'embedding',
        processed: 50,
        total: 100,
        rate: 1,
        eta: 125, // 2 minutes 5 seconds
      });

      expect(writeOutput.some((s) => s.includes('2m') && s.includes('5s'))).toBe(true);
    });
  });

  describe('createStatusBar factory', () => {
    it('should create a new StatusBarRenderer instance', () => {
      const bar1 = createStatusBar();
      const bar2 = createStatusBar();

      expect(bar1).toBeInstanceOf(StatusBarRenderer);
      expect(bar2).toBeInstanceOf(StatusBarRenderer);
      expect(bar1).not.toBe(bar2); // Different instances
    });

    it('should respect options', () => {
      const bar = createStatusBar({ terminalWidth: 50 });
      expect(bar).toBeInstanceOf(StatusBarRenderer);
    });
  });
});
