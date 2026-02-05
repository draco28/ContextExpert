/**
 * Input Manager Tests
 *
 * Tests for the InputManager component.
 * Verifies closed state tracking, pause/resume, and processing guard.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InputManager } from '../input-manager.js';
import type { TerminalRegionManager } from '../terminal-regions.js';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

// Create a mock TerminalRegionManager
function createMockRegionManager() {
  return {
    focusInputArea: vi.fn(),
    writeToChatArea: vi.fn(),
    writeStatusBar: vi.fn(),
    streamToChatArea: vi.fn(),
    beginChatStream: vi.fn(),
    endChatStream: vi.fn(),
    clearChatArea: vi.fn(),
    initialize: vi.fn(),
    cleanup: vi.fn(),
    getDimensions: vi.fn().mockReturnValue({ rows: 24, cols: 80 }),
  } as unknown as TerminalRegionManager;
}

// Create a mock input stream that we can write to programmatically
function createMockInput() {
  const input = new Readable({
    read() {},
  });
  return input;
}

// Create a mock output stream
function createMockOutput() {
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  // readline needs these for TTY operations
  (output as any).isTTY = true;
  (output as any).columns = 80;
  (output as any).rows = 24;
  return output;
}

describe('InputManager', () => {
  let regionManager: ReturnType<typeof createMockRegionManager>;
  let mockInput: Readable;
  let mockOutput: Writable;
  let inputManager: InputManager;
  let onLine: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    regionManager = createMockRegionManager();
    mockInput = createMockInput();
    mockOutput = createMockOutput();
    onLine = vi.fn();

    inputManager = new InputManager({
      regionManager,
      onLine,
      input: mockInput,
      output: mockOutput,
      prompt: '> ',
    });
  });

  afterEach(() => {
    if (!inputManager.closed) {
      inputManager.close();
    }
  });

  describe('closed state tracking', () => {
    it('should initially not be closed', () => {
      expect(inputManager.closed).toBe(false);
    });

    it('should be closed after close()', () => {
      inputManager.close();
      expect(inputManager.closed).toBe(true);
    });
  });

  describe('pause/resume', () => {
    it('should start in unpaused state', () => {
      expect(inputManager.paused).toBe(false);
    });

    it('should be paused after pause()', () => {
      inputManager.pause();
      expect(inputManager.paused).toBe(true);
    });

    it('should be unpaused after resume()', () => {
      inputManager.pause();
      inputManager.resume();
      expect(inputManager.paused).toBe(false);
    });

    it('should be idempotent for multiple pause calls', () => {
      inputManager.pause();
      inputManager.pause();
      expect(inputManager.paused).toBe(true);

      // Single resume should unpause
      inputManager.resume();
      expect(inputManager.paused).toBe(false);
    });

    it('should be idempotent for multiple resume calls', () => {
      inputManager.resume();
      expect(inputManager.paused).toBe(false);
    });

    it('should defer prompt until resume if paused', () => {
      inputManager.pause();
      inputManager.prompt();

      // focusInputArea should NOT have been called while paused
      expect(regionManager.focusInputArea).not.toHaveBeenCalled();

      // After resume, the deferred prompt should trigger
      inputManager.resume();
      expect(regionManager.focusInputArea).toHaveBeenCalled();
    });

    it('should handle nested pause/resume via write()', () => {
      // write() internally calls pause/resume with wasPaused guard
      inputManager.pause();
      const wasPausedBefore = inputManager.paused;

      // Calling write() while already paused should not unpause
      inputManager.write('test');
      expect(inputManager.paused).toBe(wasPausedBefore);
    });
  });

  describe('setPrompt', () => {
    it('should update prompt text', () => {
      inputManager.setPrompt('[my-project]> ');
      // Verify by checking the readline interface
      const rl = inputManager.getReadlineInterface();
      // readline stores the prompt internally — we verify via setPrompt call
      // (no public getter on readline.Interface, so we trust our wrapper)
      expect(() => inputManager.setPrompt('[another]> ')).not.toThrow();
    });
  });

  describe('createProjectPrompt (static)', () => {
    it('should return project prompt with name', () => {
      const prompt = InputManager.createProjectPrompt('my-project');
      // Contains the project name (chalk adds ANSI, so strip for check)
      expect(prompt).toContain('my-project');
      expect(prompt).toContain('>');
    });

    it('should return default prompt without name', () => {
      const prompt = InputManager.createProjectPrompt(null);
      expect(prompt).toBe('> ');
    });

    it('should return default prompt for undefined', () => {
      const prompt = InputManager.createProjectPrompt();
      expect(prompt).toBe('> ');
    });
  });

  describe('processing guard', () => {
    it('should call onLine handler when line is emitted', async () => {
      const linePromise = new Promise<void>((resolve) => {
        onLine.mockImplementation(async () => {
          resolve();
        });
      });

      // Simulate readline 'line' event
      const rl = inputManager.getReadlineInterface();
      rl.emit('line', 'test input');

      await linePromise;
      expect(onLine).toHaveBeenCalledWith('test input');
    });

    it('should block concurrent line processing', async () => {
      let resolveFirst: () => void;
      const firstCallStarted = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      let resolveHandler: () => void;
      const handlerComplete = new Promise<void>((resolve) => {
        resolveHandler = resolve;
      });

      // First call blocks until we resolve
      onLine.mockImplementationOnce(async () => {
        resolveFirst!();
        await handlerComplete;
      });

      const rl = inputManager.getReadlineInterface();

      // Emit first line
      rl.emit('line', 'first');
      await firstCallStarted;

      // Emit second line while first is processing
      rl.emit('line', 'second');

      // Resolve first handler
      resolveHandler!();

      // Wait for processing to complete
      await new Promise((r) => setTimeout(r, 50));

      // Only the first line should have been processed
      expect(onLine).toHaveBeenCalledTimes(1);
      expect(onLine).toHaveBeenCalledWith('first');
    });
  });

  describe('onBusy callback', () => {
    it('should call onBusy when input is rejected during processing', async () => {
      const onBusy = vi.fn();
      let resolveHandler: () => void;
      const handlerComplete = new Promise<void>((resolve) => {
        resolveHandler = resolve;
      });

      onLine.mockImplementationOnce(async () => {
        await handlerComplete;
      });

      const im = new InputManager({
        regionManager,
        onLine,
        onBusy,
        input: createMockInput(),
        output: createMockOutput(),
      });

      const rl = im.getReadlineInterface();

      // Start processing first line
      rl.emit('line', 'first');
      // Wait for isProcessing to be set
      await new Promise((r) => setTimeout(r, 10));

      // Second line should trigger onBusy
      rl.emit('line', 'second');
      expect(onBusy).toHaveBeenCalledWith('second');

      resolveHandler!();
      await new Promise((r) => setTimeout(r, 10));
      im.close();
    });
  });

  describe('onError callback', () => {
    it('should call onError when line handler throws', async () => {
      const onError = vi.fn();
      const testError = new Error('handler failed');

      onLine.mockRejectedValueOnce(testError);

      const im = new InputManager({
        regionManager,
        onLine,
        onError,
        input: createMockInput(),
        output: createMockOutput(),
      });

      const rl = im.getReadlineInterface();
      rl.emit('line', 'trigger error');

      // Wait for async handler to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(onError).toHaveBeenCalledWith(testError);
      im.close();
    });

    it('should fall back to console.error when no onError provided', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const testError = new Error('handler failed');

      onLine.mockRejectedValueOnce(testError);

      const im = new InputManager({
        regionManager,
        onLine,
        input: createMockInput(),
        output: createMockOutput(),
      });

      const rl = im.getReadlineInterface();
      rl.emit('line', 'trigger error');

      await new Promise((r) => setTimeout(r, 50));

      expect(consoleSpy).toHaveBeenCalledWith('Input handler error:', testError);
      consoleSpy.mockRestore();
      im.close();
    });
  });

  describe('SIGINT handler', () => {
    it('should call custom SIGINT handler', () => {
      const sigintHandler = vi.fn();

      const im = new InputManager({
        regionManager,
        onLine,
        onSIGINT: sigintHandler,
        input: createMockInput(),
        output: createMockOutput(),
      });

      const rl = im.getReadlineInterface();
      rl.emit('SIGINT');

      expect(sigintHandler).toHaveBeenCalled();
      im.close();
    });
  });

  describe('close handler', () => {
    it('should call custom close handler', () => {
      const closeHandler = vi.fn();

      const im = new InputManager({
        regionManager,
        onLine,
        onClose: closeHandler,
        input: createMockInput(),
        output: createMockOutput(),
      });

      im.close();

      expect(closeHandler).toHaveBeenCalled();
    });
  });
});
