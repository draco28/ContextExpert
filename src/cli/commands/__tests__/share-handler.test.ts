/**
 * Tests for share-handler.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleShareCommand, contractPath } from '../share-handler.js';
import type { ChatState } from '../chat.js';
import type { CommandContext } from '../../types.js';

// Mock execSync to prevent actual clipboard operations
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

describe('share-handler', () => {
  // Test directory
  const testDir = join(tmpdir(), 'ctx-share-test');
  let mockState: ChatState;
  let mockCtx: CommandContext;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    // Create test directory
    mkdirSync(testDir, { recursive: true });

    // Reset logs
    logs = [];
    errors = [];

    // Create mock context
    mockCtx = {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => errors.push(msg),
      debug: vi.fn(),
      options: { verbose: false, json: false },
    } as unknown as CommandContext;

    // Create mock state with conversation history
    mockState = {
      currentProject: { id: 1, name: 'test-project', path: '/test/path' },
      providerInfo: { name: 'anthropic', model: 'claude-3-5-sonnet' },
      conversationContext: {
        getMessages: () => [
          { role: 'user', content: 'Hello, how does auth work?' },
          { role: 'assistant', content: 'Authentication uses JWT tokens...' },
          { role: 'user', content: 'Can you show me an example?' },
          { role: 'assistant', content: 'Here is an example:\n```typescript\nconst token = jwt.sign(payload, secret);\n```' },
        ],
        clear: vi.fn(),
      },
      config: {},
    } as unknown as ChatState;
  });

  afterEach(() => {
    // Clean up test directory
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('handleShareCommand', () => {
    it('exports conversation to specified path', async () => {
      const outputPath = join(testDir, 'test-export.md');

      const result = await handleShareCommand([outputPath], mockState, mockCtx);

      expect(result).toBe(true);
      expect(existsSync(outputPath)).toBe(true);

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('# Context Expert Conversation');
      expect(content).toContain('test-project');
      expect(content).toContain('anthropic/claude-3-5-sonnet');
    });

    it('includes all messages in export', async () => {
      const outputPath = join(testDir, 'messages-export.md');

      await handleShareCommand([outputPath], mockState, mockCtx);

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('Hello, how does auth work?');
      expect(content).toContain('Authentication uses JWT tokens');
      expect(content).toContain('Can you show me an example?');
      expect(content).toContain('jwt.sign(payload, secret)');
    });

    it('shows success message with message count', async () => {
      const outputPath = join(testDir, 'success-export.md');

      await handleShareCommand([outputPath], mockState, mockCtx);

      const successLog = logs.find((l) => l.includes('Conversation exported'));
      expect(successLog).toBeDefined();

      const countLog = logs.find((l) => l.includes('Messages:'));
      expect(countLog).toContain('4');
    });

    it('handles empty conversation', async () => {
      mockState.conversationContext.getMessages = () => [];
      const outputPath = join(testDir, 'empty-export.md');

      await handleShareCommand([outputPath], mockState, mockCtx);

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('No messages to export');
    });

    it('handles missing project gracefully', async () => {
      mockState.currentProject = null;
      const outputPath = join(testDir, 'no-project-export.md');

      await handleShareCommand([outputPath], mockState, mockCtx);

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('No project focused');
    });

    it('creates directory if it does not exist', async () => {
      const nestedPath = join(testDir, 'nested', 'dir', 'export.md');

      await handleShareCommand([nestedPath], mockState, mockCtx);

      expect(existsSync(nestedPath)).toBe(true);
    });

    it('skips system messages in export', async () => {
      mockState.conversationContext.getMessages = () => [
        { role: 'system', content: 'You are an assistant...' },
        { role: 'user', content: 'Hello!' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      const outputPath = join(testDir, 'no-system-export.md');
      await handleShareCommand([outputPath], mockState, mockCtx);

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).not.toContain('You are an assistant');
      expect(content).toContain('Hello!');
      expect(content).toContain('Hi there!');
    });
  });

  describe('contractPath', () => {
    it('contracts home directory to ~', () => {
      const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
      const result = contractPath(`${home}/projects/test`);
      expect(result).toBe('~/projects/test');
    });

    it('leaves non-home paths unchanged', () => {
      const result = contractPath('/usr/local/bin');
      expect(result).toBe('/usr/local/bin');
    });
  });
});
