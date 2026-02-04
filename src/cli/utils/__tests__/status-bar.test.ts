/**
 * StatusBarRenderer Tests
 *
 * Tests the readline-safe status bar for background indexing:
 * - Progress bar rendering via console.log
 * - Rate and ETA display
 * - Throttling behavior
 * - State management
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  StatusBarRenderer,
  createStatusBar,
} from '../status-bar.js';
import type { ProgressData } from '../../../indexer/session.js';

describe('StatusBarRenderer', () => {
  let statusBar: StatusBarRenderer;
  let consoleOutput: string[] = [];
  const originalIsTTY = process.stdout.isTTY;
  const originalColumns = process.stdout.columns;

  beforeEach(() => {
    consoleOutput = [];

    // Mock console.log (implementation uses console.log for output)
    vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      consoleOutput.push(msg);
    });

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
    it('should activate the status bar when show is called', () => {
      statusBar.show();
      expect(statusBar.isActive()).toBe(true);
    });

    it('should deactivate when hide is called', () => {
      statusBar.show();
      statusBar.hide();
      expect(statusBar.isActive()).toBe(false);
    });
  });

  describe('setStage', () => {
    it('should show status bar and render initial state', () => {
      statusBar.setStage('embedding', 100);

      // Should have rendered something
      expect(consoleOutput.length).toBeGreaterThan(0);

      // Should contain the stage name
      expect(consoleOutput.some((s) => s.includes('Embedding'))).toBe(true);
    });

    it('should update current stage', () => {
      statusBar.setStage('scanning', 50);
      expect(statusBar.getCurrentStage()).toBe('scanning');

      statusBar.setStage('embedding', 100);
      expect(statusBar.getCurrentStage()).toBe('embedding');
    });

    it('should activate the status bar', () => {
      statusBar.setStage('embedding', 100);
      expect(statusBar.isActive()).toBe(true);
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

    it('should throttle updates', () => {
      statusBar.setStage('embedding', 1000);
      consoleOutput = []; // Clear initial render

      // Rapid updates with small increments (1% each, below 10% threshold)
      for (let i = 0; i < 10; i++) {
        statusBar.update({
          stage: 'embedding',
          processed: i * 10, // 1%, 2%, 3%... (all small changes)
          total: 1000,
        });
      }

      // Should have been throttled (not all 10 rendered)
      // Updates within throttle window are skipped unless significant progress (>=10%)
      expect(consoleOutput.length).toBeLessThan(10);
    });

    it('should render on significant progress even within throttle window', () => {
      statusBar.setStage('embedding', 100);
      consoleOutput = []; // Clear initial render

      // Update with 0% progress
      statusBar.update({
        stage: 'embedding',
        processed: 0,
        total: 100,
      });

      // Jump to 50% - significant progress (>= 10% jump)
      statusBar.update({
        stage: 'embedding',
        processed: 50,
        total: 100,
      });

      // Should have rendered at least once for significant progress
      expect(consoleOutput.length).toBeGreaterThan(0);
    });

    it('should show warmup message during first batch', async () => {
      statusBar.setStage('embedding', 100);

      // Wait for throttle to expire
      await new Promise((resolve) => setTimeout(resolve, 2100));

      statusBar.update({
        stage: 'embedding',
        processed: 0,
        total: 100,
        warmingUp: true,
      });

      expect(consoleOutput.some((s) => s.includes('Warming up'))).toBe(true);
    });
  });

  describe('progress bar rendering', () => {
    it('should render filled and empty blocks', async () => {
      statusBar.setStage('embedding', 100);

      // Wait for throttle to expire
      await new Promise((resolve) => setTimeout(resolve, 2100));

      statusBar.update({
        stage: 'embedding',
        processed: 50,
        total: 100,
      });

      // Should contain progress bar characters
      expect(consoleOutput.some((s) => s.includes('█') || s.includes('░'))).toBe(true);
    });

    it('should show percentage', async () => {
      statusBar.setStage('embedding', 100);

      // Wait for throttle to expire
      await new Promise((resolve) => setTimeout(resolve, 2100));

      statusBar.update({
        stage: 'embedding',
        processed: 25,
        total: 100,
      });

      expect(consoleOutput.some((s) => s.includes('25%'))).toBe(true);
    });

    it('should show rate for embedding stage', async () => {
      statusBar.setStage('embedding', 100);

      // Wait for throttle to expire
      await new Promise((resolve) => setTimeout(resolve, 2100));

      statusBar.update({
        stage: 'embedding',
        processed: 50,
        total: 100,
        rate: 2.5,
        eta: 20,
      });

      // Should contain rate (e.g., "2.5/s")
      expect(consoleOutput.some((s) => s.includes('/s'))).toBe(true);
    });

    it('should show ETA for embedding stage', async () => {
      statusBar.setStage('embedding', 100);

      // Wait for throttle to expire
      await new Promise((resolve) => setTimeout(resolve, 2100));

      statusBar.update({
        stage: 'embedding',
        processed: 50,
        total: 100,
        rate: 2.5,
        eta: 20,
      });

      // Should contain ETA
      expect(consoleOutput.some((s) => s.includes('ETA'))).toBe(true);
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

    it('should still output in non-TTY mode via console.log', () => {
      consoleOutput = [];

      statusBar.setStage('embedding', 100);

      // In non-TTY mode, implementation still logs via console.log
      expect(consoleOutput.length).toBeGreaterThan(0);
    });
  });

  describe('status messages', () => {
    it('should show success message', () => {
      statusBar.show();
      statusBar.showSuccess('Project indexed');

      expect(consoleOutput.some((s) => s.includes('✓'))).toBe(true);
      expect(consoleOutput.some((s) => s.includes('Project indexed'))).toBe(true);
    });

    it('should show error message', () => {
      statusBar.show();
      statusBar.showError('Failed to index');

      expect(consoleOutput.some((s) => s.includes('✗'))).toBe(true);
      expect(consoleOutput.some((s) => s.includes('Failed to index'))).toBe(true);
    });

    it('should show cancelled message', () => {
      statusBar.show();
      statusBar.showCancelled();

      expect(consoleOutput.some((s) => s.includes('⚠'))).toBe(true);
      expect(consoleOutput.some((s) => s.includes('cancelled'))).toBe(true);
    });

    it('should deactivate after showing status message', () => {
      statusBar.show();
      expect(statusBar.isActive()).toBe(true);

      statusBar.showSuccess('Done');
      expect(statusBar.isActive()).toBe(false);
    });
  });

  describe('ETA formatting', () => {
    it('should format seconds correctly', async () => {
      statusBar.setStage('embedding', 100);
      await new Promise((resolve) => setTimeout(resolve, 2100));

      statusBar.update({
        stage: 'embedding',
        processed: 50,
        total: 100,
        rate: 2,
        eta: 45,
      });

      expect(consoleOutput.some((s) => s.includes('45s'))).toBe(true);
    });

    it('should format minutes and seconds correctly', async () => {
      statusBar.setStage('embedding', 100);
      await new Promise((resolve) => setTimeout(resolve, 2100));

      statusBar.update({
        stage: 'embedding',
        processed: 50,
        total: 100,
        rate: 1,
        eta: 125, // 2 minutes 5 seconds
      });

      expect(consoleOutput.some((s) => s.includes('2m') && s.includes('5s'))).toBe(true);
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
