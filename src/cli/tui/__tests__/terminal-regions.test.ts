/**
 * Terminal Regions Tests
 *
 * Tests for the TerminalRegionManager component.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TerminalRegionManager, ANSI } from '../terminal-regions.js';
import { Writable } from 'node:stream';

// Mock writable stream for capturing output
class MockWritableStream extends Writable {
  chunks: string[] = [];
  rows: number = 24;
  columns: number = 80;
  isTTY: boolean = true;

  _write(chunk: Buffer, encoding: string, callback: () => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  getOutput(): string {
    return this.chunks.join('');
  }

  clear(): void {
    this.chunks = [];
  }
}

describe('TerminalRegionManager', () => {
  let mockStdout: MockWritableStream;
  let regionManager: TerminalRegionManager;

  beforeEach(() => {
    mockStdout = new MockWritableStream();
    regionManager = new TerminalRegionManager({
      stdout: mockStdout as any,
      statusBarHeight: 1,
      inputAreaHeight: 1,
      useSynchronizedOutput: false, // Disable for easier testing
    });
  });

  afterEach(() => {
    regionManager.cleanup();
  });

  describe('ANSI constants', () => {
    it('should have correct escape sequences', () => {
      expect(ANSI.ESC).toBe('\x1b');
      expect(ANSI.CSI).toBe('\x1b[');
      expect(ANSI.SAVE_CURSOR).toBe('\x1b7');
      expect(ANSI.RESTORE_CURSOR).toBe('\x1b8');
      expect(ANSI.CLEAR_LINE).toBe('\x1b[2K');
    });

    it('should generate correct cursor positioning', () => {
      expect(ANSI.cursorTo(5, 10)).toBe('\x1b[5;10H');
      expect(ANSI.cursorTo(1)).toBe('\x1b[1;1H');
    });

    it('should generate correct scroll region sequence', () => {
      expect(ANSI.setScrollRegion(1, 20)).toBe('\x1b[1;20r');
    });
  });

  describe('initialization', () => {
    it('should initialize regions correctly', () => {
      regionManager.initialize();

      const regions = regionManager.getRegions();

      // With 24 rows, status at 1, input at 1:
      // Chat: 1-22, Status: 23, Input: 24
      expect(regions.chat.startRow).toBe(1);
      expect(regions.chat.endRow).toBe(22);
      expect(regions.status.startRow).toBe(23);
      expect(regions.status.endRow).toBe(23);
      expect(regions.input.startRow).toBe(24);
      expect(regions.input.endRow).toBe(24);
    });

    it('should set scroll region on initialization', () => {
      regionManager.initialize();

      const output = mockStdout.getOutput();

      // Should contain scroll region command for chat area (1-22)
      expect(output).toContain(ANSI.setScrollRegion(1, 22));
    });

    it('should emit initialized event', () => {
      const handler = vi.fn();
      regionManager.on('initialized', handler);

      regionManager.initialize();

      expect(handler).toHaveBeenCalled();
    });
  });

  describe('getDimensions', () => {
    it('should return terminal dimensions', () => {
      regionManager.initialize();

      const dims = regionManager.getDimensions();

      expect(dims.rows).toBe(24);
      expect(dims.cols).toBe(80);
    });
  });

  describe('getChatAreaHeight', () => {
    it('should calculate chat area height correctly', () => {
      regionManager.initialize();

      // 24 rows - 1 status - 1 input = 22 rows for chat
      expect(regionManager.getChatAreaHeight()).toBe(22);
    });
  });

  describe('writeStatusBar', () => {
    it('should write to status bar region', () => {
      regionManager.initialize();
      mockStdout.clear();

      regionManager.writeStatusBar('Test Status');

      const output = mockStdout.getOutput();

      // Should position cursor to status row (23)
      expect(output).toContain(ANSI.cursorTo(23));
      // Should clear the line
      expect(output).toContain(ANSI.CLEAR_LINE);
      // Should contain the content
      expect(output).toContain('Test Status');
      // Should save/restore cursor
      expect(output).toContain(ANSI.SAVE_CURSOR);
      expect(output).toContain(ANSI.RESTORE_CURSOR);
    });
  });

  describe('cleanup', () => {
    it('should reset scroll region', () => {
      regionManager.initialize();
      mockStdout.clear();

      regionManager.cleanup();

      const output = mockStdout.getOutput();
      expect(output).toContain(ANSI.resetScrollRegion);
    });

    it('should emit cleanup event', () => {
      regionManager.initialize();
      const handler = vi.fn();
      regionManager.on('cleanup', handler);

      regionManager.cleanup();

      expect(handler).toHaveBeenCalled();
    });
  });

  describe('resize during streaming', () => {
    it('should write newline after cursorTo when streaming', () => {
      regionManager.initialize();

      // Start streaming
      regionManager.beginChatStream();
      mockStdout.clear();

      // Trigger resize
      mockStdout.rows = 30;
      mockStdout.emit('resize');

      const output = mockStdout.getOutput();

      // Should contain cursorTo for the new chat end row (30 - 2 = 28)
      expect(output).toContain(ANSI.cursorTo(28));
      // Should contain a newline to scroll within the region
      expect(output).toContain('\n');
    });
  });

  describe('dimension clamping', () => {
    it('should clamp getDimensions rows to minimum for tiny terminals', () => {
      mockStdout.rows = 2;
      regionManager = new TerminalRegionManager({
        stdout: mockStdout as any,
        statusBarHeight: 1,
        inputAreaHeight: 1,
        useSynchronizedOutput: false,
      });
      regionManager.initialize();

      const dims = regionManager.getDimensions();

      // Should be clamped to 3 (MIN_TERMINAL_ROWS), not raw 2
      expect(dims.rows).toBe(3);
    });

    it('should produce valid regions for tiny terminals', () => {
      mockStdout.rows = 1;
      regionManager = new TerminalRegionManager({
        stdout: mockStdout as any,
        statusBarHeight: 1,
        inputAreaHeight: 1,
        useSynchronizedOutput: false,
      });
      regionManager.initialize();

      const regions = regionManager.getRegions();

      // chatEnd should never be less than chatStart
      expect(regions.chat.endRow).toBeGreaterThanOrEqual(regions.chat.startRow);
    });
  });

  describe('isTTY', () => {
    it('should return true for TTY stream', () => {
      regionManager.initialize();
      expect(regionManager.isTTY()).toBe(true);
    });

    it('should return false for non-TTY stream', () => {
      mockStdout.isTTY = false;
      regionManager = new TerminalRegionManager({
        stdout: mockStdout as any,
      });
      regionManager.initialize();
      expect(regionManager.isTTY()).toBe(false);
    });
  });
});
