/**
 * Chat Area Manager Tests
 *
 * Tests for the ChatAreaManager component.
 * Verifies ANSI stripping (security), message formatting, and streaming lifecycle.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChatAreaManager } from '../chat-area.js';
import type { TerminalRegionManager } from '../terminal-regions.js';

// Create a mock TerminalRegionManager with captured output
function createMockRegionManager() {
  const output: string[] = [];

  const mock = {
    writeToChatArea: vi.fn((content: string) => {
      output.push(content);
    }),
    streamToChatArea: vi.fn((chunk: string) => {
      output.push(chunk);
    }),
    beginChatStream: vi.fn(),
    endChatStream: vi.fn(),
    clearChatArea: vi.fn(),
    focusInputArea: vi.fn(),
    getOutput: () => output.join(''),
    clearOutput: () => { output.length = 0; },
  } as unknown as TerminalRegionManager & {
    getOutput: () => string;
    clearOutput: () => void;
  };

  return mock;
}

// Helper to strip chalk ANSI color codes for text assertions
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('ChatAreaManager', () => {
  let regionManager: ReturnType<typeof createMockRegionManager>;
  let chatArea: ChatAreaManager;

  beforeEach(() => {
    vi.clearAllMocks();
    regionManager = createMockRegionManager();
    chatArea = new ChatAreaManager(regionManager, {
      enableMarkdown: true,
    });
  });

  describe('ANSI stripping (security)', () => {
    it('should strip clear screen sequences from assistant messages', () => {
      chatArea.addAssistantMessage('Hello \x1b[2J world');

      const output = regionManager.getOutput();
      expect(output).not.toContain('\x1b[2J');
      expect(stripAnsi(output)).toContain('Hello  world');
    });

    it('should strip cursor move sequences from assistant messages', () => {
      chatArea.addAssistantMessage('Hello \x1b[999;999H world');

      const output = regionManager.getOutput();
      expect(output).not.toContain('\x1b[999;999H');
    });

    it('should strip DEC save/restore from assistant messages', () => {
      chatArea.addAssistantMessage('Hello \x1b7\x1b8 world');

      const output = regionManager.getOutput();
      expect(output).not.toContain('\x1b7');
      expect(output).not.toContain('\x1b8');
    });

    it('should preserve markdown formatting in sanitized output', () => {
      chatArea.addAssistantMessage('This is **bold** text');

      const output = regionManager.getOutput();
      // Bold should be rendered via chalk (ANSI color codes)
      // The raw ** should be removed by the markdown renderer
      expect(output).not.toContain('**bold**');
      expect(stripAnsi(output)).toContain('bold');
    });

    it('should not strip ANSI from non-assistant messages', () => {
      // User messages don't go through renderMarkdown, so they pass through as-is
      chatArea.addUserMessage('plain text');

      const output = regionManager.getOutput();
      expect(stripAnsi(output)).toContain('You:');
      expect(stripAnsi(output)).toContain('plain text');
    });
  });

  describe('message types', () => {
    it('should display user message with correct role prefix', () => {
      chatArea.addUserMessage('How does auth work?');

      const output = stripAnsi(regionManager.getOutput());
      expect(output).toContain('You:');
      expect(output).toContain('How does auth work?');
    });

    it('should display info message', () => {
      chatArea.addInfoMessage('TUI mode enabled. Type /help for commands.');

      const output = stripAnsi(regionManager.getOutput());
      expect(output).toContain('TUI mode enabled');
    });

    it('should display info message with compact option (single newline)', () => {
      chatArea.addInfoMessage('Line 1', { compact: true });
      chatArea.addInfoMessage('Line 2', { compact: true });

      // Compact uses '\n' trailing vs default '\n\n'
      const calls = (regionManager.writeToChatArea as ReturnType<typeof vi.fn>).mock.calls;
      // Each compact message should end with \n (not \n\n)
      for (const [content] of calls) {
        const text = content as string;
        // Messages end with content + trailing newline(s)
        if (text.includes('Line 1') || text.includes('Line 2')) {
          expect(text).toMatch(/\n$/);
          expect(text).not.toMatch(/\n\n$/);
        }
      }
    });

    it('should display system message with correct prefix', () => {
      chatArea.addSystemMessage('Context window updated');

      const output = stripAnsi(regionManager.getOutput());
      expect(output).toContain('System:');
      expect(output).toContain('Context window updated');
    });

    it('should store messages in history', () => {
      chatArea.addUserMessage('Q1');
      chatArea.addInfoMessage('Info');
      chatArea.addSystemMessage('System msg');

      const messages = chatArea.getMessages();
      expect(messages).toHaveLength(3);
      expect(messages[0].role).toBe('user');
      expect(messages[1].role).toBe('info');
      expect(messages[2].role).toBe('system');
    });
  });

  describe('streaming lifecycle', () => {
    it('should start and end stream correctly', () => {
      chatArea.startStream();

      expect(regionManager.beginChatStream).toHaveBeenCalled();
      expect(regionManager.streamToChatArea).toHaveBeenCalled(); // prefix

      chatArea.endStream();

      expect(regionManager.endChatStream).toHaveBeenCalled();
    });

    it('should accumulate stream chunks in buffer', () => {
      chatArea.startStream();
      chatArea.streamChunk('Hello ');
      chatArea.streamChunk('world!');
      chatArea.endStream();

      // The message should be recorded with full content
      const messages = chatArea.getMessages();
      const assistantMsg = messages.find(m => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.content).toBe('Hello world!');
    });

    it('should end previous stream if startStream called while streaming', () => {
      chatArea.startStream();
      chatArea.streamChunk('first');

      // Start a new stream without ending previous
      chatArea.startStream();
      chatArea.streamChunk('second');
      chatArea.endStream();

      // Should have two assistant messages (first auto-ended, second manually ended)
      const messages = chatArea.getMessages();
      const assistantMsgs = messages.filter(m => m.role === 'assistant');
      expect(assistantMsgs).toHaveLength(2);
    });

    it('should be a no-op if endStream called without active stream', () => {
      // Should not throw
      chatArea.endStream();

      expect(regionManager.endChatStream).not.toHaveBeenCalled();
    });

    it('should auto-start stream if streamChunk called without startStream', () => {
      chatArea.streamChunk('auto-start');

      expect(regionManager.beginChatStream).toHaveBeenCalled();
    });

    it('should write chunks to region manager', () => {
      chatArea.startStream();
      chatArea.streamChunk('test chunk');

      expect(regionManager.streamToChatArea).toHaveBeenCalledWith('test chunk');
    });

    it('should clear messages and chat area on clear()', () => {
      chatArea.addUserMessage('msg1');
      chatArea.addUserMessage('msg2');

      chatArea.clear();

      expect(chatArea.getMessages()).toHaveLength(0);
      expect(regionManager.clearChatArea).toHaveBeenCalled();
    });
  });

  describe('getRecentMessages', () => {
    it('should return the last N messages', () => {
      chatArea.addUserMessage('msg1');
      chatArea.addUserMessage('msg2');
      chatArea.addUserMessage('msg3');

      const recent = chatArea.getRecentMessages(2);
      expect(recent).toHaveLength(2);
      expect(recent[0].content).toBe('msg2');
      expect(recent[1].content).toBe('msg3');
    });
  });
});
