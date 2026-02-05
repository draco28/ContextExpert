/**
 * TUI Controller Tests
 *
 * Tests for the TUIController orchestration layer.
 * Mocks all sub-components to verify integration logic.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TUIController, type StreamChunk } from '../controller.js';
import { AgentPhase } from '../types.js';

// Mock sub-components
vi.mock('../terminal-regions.js', () => {
  const EventEmitter = require('node:events').EventEmitter;

  class MockTerminalRegionManager extends EventEmitter {
    initialize = vi.fn();
    cleanup = vi.fn();
    writeStatusBar = vi.fn();
    writeToChatArea = vi.fn();
    streamToChatArea = vi.fn();
    beginChatStream = vi.fn();
    endChatStream = vi.fn();
    focusInputArea = vi.fn();
    clearChatArea = vi.fn();
    clearStatusBar = vi.fn();
    getDimensions = vi.fn().mockReturnValue({ rows: 24, cols: 80 });
    getRegions = vi.fn().mockReturnValue({
      chat: { startRow: 1, endRow: 22 },
      status: { startRow: 23, endRow: 23 },
      input: { startRow: 24, endRow: 24 },
    });
    getChatAreaHeight = vi.fn().mockReturnValue(22);
    isTTY = vi.fn().mockReturnValue(true);
    streaming = false;
  }

  return {
    TerminalRegionManager: MockTerminalRegionManager,
    createTerminalRegionManager: vi.fn(
      () => new MockTerminalRegionManager()
    ),
    ANSI: {
      ESC: '\x1b',
      CSI: '\x1b[',
      SAVE_CURSOR: '\x1b7',
      RESTORE_CURSOR: '\x1b8',
      cursorTo: (row: number, col: number = 1) => `\x1b[${row};${col}H`,
      setScrollRegion: (top: number, bottom: number) =>
        `\x1b[${top};${bottom}r`,
      resetScrollRegion: '\x1b[r',
      CLEAR_LINE: '\x1b[2K',
      CLEAR_TO_END: '\x1b[K',
      CLEAR_SCREEN: '\x1b[2J',
      BEGIN_SYNC: '\x1b[?2026h',
      END_SYNC: '\x1b[?2026l',
      ENTER_ALT_SCREEN: '\x1b[?1049h',
      EXIT_ALT_SCREEN: '\x1b[?1049l',
      RESET: '\x1b[0m',
    },
  };
});

vi.mock('../status-line.js', () => {
  class MockStatusLineRenderer {
    private state: Record<string, unknown> = {
      tokens: { used: 0, total: 200000, warningThreshold: 0.8, dangerThreshold: 0.95 },
      cost: { totalUsd: 0 },
    };
    render = vi.fn().mockReturnValue('[PLAN] Context: 0% | $0.0000');
    update = vi.fn((partial: Record<string, unknown>) => {
      Object.assign(this.state, partial);
    });
    getState = vi.fn(() => ({ ...this.state }));
    setTerminalWidth = vi.fn();
  }

  return {
    StatusLineRenderer: MockStatusLineRenderer,
    createStatusLineRenderer: vi.fn(() => new MockStatusLineRenderer()),
    toolToDescription: vi.fn(
      (tool: string) => `Using ${tool}`
    ),
  };
});

vi.mock('../chat-area.js', () => {
  class MockChatAreaManager {
    addUserMessage = vi.fn();
    addInfoMessage = vi.fn();
    addSystemMessage = vi.fn();
    addAssistantMessage = vi.fn();
    startStream = vi.fn();
    streamChunk = vi.fn();
    endStream = vi.fn();
    clear = vi.fn();
    getMessages = vi.fn().mockReturnValue([]);
  }

  return {
    ChatAreaManager: MockChatAreaManager,
    createChatAreaManager: vi.fn(() => new MockChatAreaManager()),
  };
});

vi.mock('../input-manager.js', () => {
  class MockInputManager {
    pause = vi.fn();
    resume = vi.fn();
    prompt = vi.fn();
    setPrompt = vi.fn();
    close = vi.fn();
    write = vi.fn();
    getReadlineInterface = vi.fn();
    static createProjectPrompt = vi.fn(
      (name?: string | null) => (name ? `[${name}]> ` : '> ')
    );
    get paused() { return false; }
    get closed() { return false; }
  }

  return {
    InputManager: MockInputManager,
    createInputManager: vi.fn(() => new MockInputManager()),
  };
});

// Helper to create an async iterable from an array of chunks
async function* makeStream(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe('TUIController', () => {
  let tui: TUIController;

  beforeEach(() => {
    vi.clearAllMocks();
    tui = new TUIController({
      model: { name: 'Claude 3.5 Sonnet', provider: 'anthropic' },
      project: 'test-project',
    });
  });

  describe('lifecycle', () => {
    it('should start and initialize regions', () => {
      tui.start();

      // Region manager should be initialized
      const regionManager = tui.getRegionManager();
      expect(regionManager.initialize).toHaveBeenCalled();
    });

    it('should render status bar on start', () => {
      tui.start();

      const regionManager = tui.getRegionManager();
      expect(regionManager.writeStatusBar).toHaveBeenCalled();
    });

    it('should be running after start', () => {
      tui.start();
      expect(tui.running).toBe(true);
    });

    it('should not start twice', () => {
      tui.start();
      const regionManager = tui.getRegionManager();
      const callCount = (regionManager.initialize as ReturnType<typeof vi.fn>).mock.calls.length;

      tui.start();
      expect(regionManager.initialize).toHaveBeenCalledTimes(callCount);
    });

    it('should cleanup on shutdown', () => {
      tui.start();
      tui.shutdown();

      const regionManager = tui.getRegionManager();
      expect(regionManager.cleanup).toHaveBeenCalled();
      expect(tui.running).toBe(false);
    });

    it('should close input manager on shutdown', () => {
      tui.start();
      const inputManager = tui.getInputManager();
      tui.shutdown();

      expect(inputManager.close).toHaveBeenCalled();
    });
  });

  describe('streamResponse()', () => {
    beforeEach(() => {
      tui.start();
    });

    it('should return concatenated text from stream', async () => {
      const stream = makeStream([
        { type: 'text', content: 'Hello ' },
        { type: 'text', content: 'world!' },
      ]);

      const result = await tui.streamResponse(stream);

      expect(result).toBe('Hello world!');
    });

    it('should call startStream and endStream', async () => {
      const stream = makeStream([
        { type: 'text', content: 'test' },
      ]);

      await tui.streamResponse(stream);

      // Access the private chatArea through the mock
      const { createChatAreaManager } = await import('../chat-area.js');
      const mockChatArea = (createChatAreaManager as ReturnType<typeof vi.fn>).mock.results[0].value;

      expect(mockChatArea.startStream).toHaveBeenCalled();
      expect(mockChatArea.endStream).toHaveBeenCalled();
    });

    it('should call endStream even on error (finally)', async () => {
      const error = new Error('Stream failed');
      async function* failingStream(): AsyncIterable<StreamChunk> {
        yield { type: 'text', content: 'start' };
        throw error;
      }

      const { createChatAreaManager } = await import('../chat-area.js');
      const mockChatArea = (createChatAreaManager as ReturnType<typeof vi.fn>).mock.results[0].value;

      await expect(tui.streamResponse(failingStream())).rejects.toThrow('Stream failed');
      expect(mockChatArea.endStream).toHaveBeenCalled();
    });

    it('should return empty string for empty stream', async () => {
      const stream = makeStream([]);

      const result = await tui.streamResponse(stream);

      expect(result).toBe('');
    });

    it('should update activity on tool_use chunks', async () => {
      const stream = makeStream([
        { type: 'tool_use', tool: 'read_file', args: { path: 'src/index.ts' } },
      ]);

      const { createStatusLineRenderer } = await import('../status-line.js');
      const mockStatusLine = (createStatusLineRenderer as ReturnType<typeof vi.fn>).mock.results[0].value;

      await tui.streamResponse(stream);

      expect(mockStatusLine.update).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: AgentPhase.TOOL_USE,
        })
      );
    });

    it('should update tokens on usage chunks', async () => {
      const stream = makeStream([
        { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } },
      ]);

      const { createStatusLineRenderer } = await import('../status-line.js');
      const mockStatusLine = (createStatusLineRenderer as ReturnType<typeof vi.fn>).mock.results[0].value;

      await tui.streamResponse(stream);

      // Should have called update with token info
      expect(mockStatusLine.update).toHaveBeenCalledWith(
        expect.objectContaining({
          tokens: expect.objectContaining({
            used: 150, // 100 + 50
          }),
        })
      );
    });

    it('should pause input during streaming and resume after', async () => {
      const stream = makeStream([
        { type: 'text', content: 'test' },
      ]);

      const inputManager = tui.getInputManager();

      await tui.streamResponse(stream);

      expect(inputManager.pause).toHaveBeenCalled();
      expect(inputManager.resume).toHaveBeenCalled();
    });

    it('should resume input even on error', async () => {
      async function* failingStream(): AsyncIterable<StreamChunk> {
        throw new Error('fail');
      }

      const inputManager = tui.getInputManager();

      await expect(tui.streamResponse(failingStream())).rejects.toThrow();
      expect(inputManager.resume).toHaveBeenCalled();
    });
  });

  describe('message methods', () => {
    beforeEach(() => {
      tui.start();
    });

    it('should pause/resume input around addUserMessage', () => {
      const inputManager = tui.getInputManager();
      tui.addUserMessage('hello');
      expect(inputManager.pause).toHaveBeenCalled();
      expect(inputManager.resume).toHaveBeenCalled();
    });

    it('should pause/resume input around addInfoMessage', () => {
      const inputManager = tui.getInputManager();
      tui.addInfoMessage('info');
      expect(inputManager.pause).toHaveBeenCalled();
      expect(inputManager.resume).toHaveBeenCalled();
    });

    it('should pause/resume input around addSystemMessage', () => {
      const inputManager = tui.getInputManager();
      tui.addSystemMessage('system');
      expect(inputManager.pause).toHaveBeenCalled();
      expect(inputManager.resume).toHaveBeenCalled();
    });
  });
});
