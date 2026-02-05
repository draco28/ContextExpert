/**
 * Agent Event Renderer Tests
 *
 * Tests for the REPL and TUI rendering adapters that consume
 * ChatAgentEvent streams and produce display output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatAgentEvent } from '../../../agent/chat-agent.js';
import {
  renderAgentEventsREPL,
  adaptAgentEventsForTUI,
} from '../agent-event-renderer.js';
import type { CommandContext } from '../../types.js';
import type { TUIController } from '../../tui/controller.js';
import { AgentPhase } from '../../tui/types.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a mock async generator from an array of events.
 */
async function* mockEventStream(
  events: ChatAgentEvent[]
): AsyncGenerator<ChatAgentEvent, void, unknown> {
  for (const event of events) {
    yield event;
  }
}

/**
 * Create a mock CommandContext for REPL testing.
 */
function createMockCtx(): CommandContext {
  return {
    options: {},
    log: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as CommandContext;
}

/**
 * Create a mock TUIController for TUI testing.
 */
function createMockTUI(): TUIController {
  return {
    setActivity: vi.fn(),
    addInfoMessage: vi.fn(),
    streamResponse: vi.fn(),
  } as unknown as TUIController;
}

/**
 * Collect all chunks from a TUI stream adapter.
 */
async function collectTUIChunks(
  gen: AsyncGenerator<{ type: string; content?: string; tool?: string; args?: Record<string, unknown>; usage?: unknown }, void, unknown>
): Promise<Array<{ type: string; content?: string }>> {
  const chunks: Array<{ type: string; content?: string }> = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

// ============================================================================
// REPL Renderer Tests
// ============================================================================

describe('renderAgentEventsREPL', () => {
  let originalWrite: typeof process.stdout.write;
  let writtenOutput: string;

  beforeEach(() => {
    writtenOutput = '';
    originalWrite = process.stdout.write;
    process.stdout.write = vi.fn((chunk: string | Uint8Array) => {
      writtenOutput += typeof chunk === 'string' ? chunk : '';
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it('streams thinking_delta content to stdout', async () => {
    const ctx = createMockCtx();
    const events = mockEventStream([
      { type: 'thinking_delta', content: 'Hello', iteration: 1 },
      { type: 'thinking_delta', content: ' world', iteration: 1 },
      { type: 'thinking_complete', content: 'Hello world', iteration: 1 },
      { type: 'response_complete', content: 'Hello world', trace: { steps: [], iterations: 1, totalTokens: 100, durationMs: 500 }, sources: [] },
    ]);

    const result = await renderAgentEventsREPL(events, ctx);

    expect(result.content).toBe('Hello world');
    expect(writtenOutput).toContain('Hello');
    expect(writtenOutput).toContain(' world');
  });

  it('shows tool activity for tool_start and tool_result', async () => {
    const ctx = createMockCtx();
    const events = mockEventStream([
      { type: 'thinking_delta', content: 'Let me search', iteration: 1 },
      { type: 'thinking_complete', content: 'Let me search', iteration: 1 },
      { type: 'tool_start', tool: 'retrieve_knowledge', input: { query: 'auth' }, iteration: 1 },
      // ReActLoop unwraps ToolResult.data — result IS RetrieveKnowledgeOutput directly
      { type: 'tool_result', tool: 'retrieve_knowledge', result: { sourceCount: 3, searchTimeMs: 45 }, success: true, durationMs: 50, iteration: 1 },
      { type: 'thinking_delta', content: 'Auth uses JWT', iteration: 2 },
      { type: 'thinking_complete', content: 'Auth uses JWT', iteration: 2 },
      { type: 'response_complete', content: 'Auth uses JWT', trace: { steps: [], iterations: 2, totalTokens: 200, durationMs: 1000 }, sources: [] },
    ]);

    await renderAgentEventsREPL(events, ctx);

    expect(writtenOutput).toContain('Searching: "auth"');
    expect(writtenOutput).toContain('Found 3 sources');
  });

  it('uses ANSI clear-line before writing tool result', async () => {
    const ctx = createMockCtx();
    const events = mockEventStream([
      { type: 'tool_start', tool: 'retrieve_knowledge', input: { query: 'long query text that is very long' }, iteration: 1 },
      { type: 'tool_result', tool: 'retrieve_knowledge', result: { sourceCount: 2 }, success: true, durationMs: 100, iteration: 1 },
      { type: 'response_complete', content: '', trace: { steps: [], iterations: 1, totalTokens: 100, durationMs: 500 }, sources: [] },
    ]);

    await renderAgentEventsREPL(events, ctx);

    // \x1b[2K clears the line to prevent remnants of the "Searching:" text
    expect(writtenOutput).toContain('\x1b[2K\r');
  });

  it('collects sources from tool_result for citation display', async () => {
    const ctx = createMockCtx();
    const mockSources = [{
      index: 1,
      filePath: 'src/auth.ts',
      lineRange: { start: 1, end: 10 },
      score: 0.95,
      language: 'typescript',
      fileType: 'code' as const,
    }];
    const events = mockEventStream([
      { type: 'tool_start', tool: 'retrieve_knowledge', input: { query: 'auth' }, iteration: 1 },
      { type: 'tool_result', tool: 'retrieve_knowledge', result: { sourceCount: 1, sources: mockSources }, success: true, durationMs: 50, iteration: 1 },
      { type: 'thinking_delta', content: 'Answer', iteration: 2 },
      { type: 'thinking_complete', content: 'Answer', iteration: 2 },
      { type: 'response_complete', content: 'Answer', trace: { steps: [], iterations: 2, totalTokens: 200, durationMs: 1000 }, sources: mockSources },
    ]);

    const result = await renderAgentEventsREPL(events, ctx);

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].filePath).toBe('src/auth.ts');
    // Should also show "Sources:" via ctx.log
    const logCalls = vi.mocked(ctx.log).mock.calls.flat().join(' ');
    expect(logCalls).toContain('Sources');
  });

  it('shows citations from response_complete', async () => {
    const ctx = createMockCtx();
    const events = mockEventStream([
      { type: 'thinking_delta', content: 'Answer', iteration: 1 },
      { type: 'thinking_complete', content: 'Answer', iteration: 1 },
      {
        type: 'response_complete',
        content: 'Answer',
        trace: { steps: [], iterations: 1, totalTokens: 100, durationMs: 500 },
        sources: [{
          index: 1,
          filePath: 'src/auth.ts',
          lineRange: { start: 1, end: 10 },
          score: 0.95,
          language: 'typescript',
          fileType: 'code' as const,
        }],
      },
    ]);

    await renderAgentEventsREPL(events, ctx);

    // Should log sources via ctx.log
    const logCalls = vi.mocked(ctx.log).mock.calls.flat().join(' ');
    expect(logCalls).toContain('Sources');
  });

  it('reports errors via ctx.error', async () => {
    const ctx = createMockCtx();
    const events = mockEventStream([
      { type: 'error', message: 'Something went wrong', code: 'STREAM_ERROR' },
    ]);

    await renderAgentEventsREPL(events, ctx);

    expect(ctx.error).toHaveBeenCalledWith('Something went wrong');
  });

  it('returns empty content and sources on error-only stream', async () => {
    const ctx = createMockCtx();
    const events = mockEventStream([
      { type: 'error', message: 'Failed' },
    ]);

    const result = await renderAgentEventsREPL(events, ctx);

    expect(result.content).toBe('');
    expect(result.sources).toEqual([]);
  });
});

// ============================================================================
// TUI Adapter Tests
// ============================================================================

describe('adaptAgentEventsForTUI', () => {
  it('yields thinking chunks for first iteration', async () => {
    const tui = createMockTUI();
    const events = mockEventStream([
      { type: 'thinking_delta', content: 'Hello', iteration: 1 },
      { type: 'thinking_complete', content: 'Hello', iteration: 1 },
      { type: 'response_complete', content: 'Hello', trace: { steps: [], iterations: 1, totalTokens: 100, durationMs: 500 }, sources: [] },
    ]);

    const { stream } = adaptAgentEventsForTUI(events, tui);
    const chunks = await collectTUIChunks(stream);

    expect(chunks).toContainEqual({ type: 'thinking', content: 'Hello' });
    expect(tui.setActivity).toHaveBeenCalledWith(AgentPhase.THINKING);
  });

  it('yields text chunks after tool calls (iteration > 1)', async () => {
    const tui = createMockTUI();
    const events = mockEventStream([
      { type: 'thinking_delta', content: 'Reasoning', iteration: 1 },
      { type: 'thinking_complete', content: 'Reasoning', iteration: 1 },
      { type: 'tool_start', tool: 'retrieve_knowledge', input: { query: 'test' }, iteration: 1 },
      { type: 'tool_result', tool: 'retrieve_knowledge', result: { sourceCount: 2 }, success: true, durationMs: 30, iteration: 1 },
      { type: 'thinking_delta', content: 'Answer', iteration: 2 },
      { type: 'thinking_complete', content: 'Answer', iteration: 2 },
      { type: 'response_complete', content: 'Answer', trace: { steps: [], iterations: 2, totalTokens: 200, durationMs: 1000 }, sources: [] },
    ]);

    const { stream } = adaptAgentEventsForTUI(events, tui);
    const chunks = await collectTUIChunks(stream);

    // First iteration should be thinking
    expect(chunks[0]).toEqual({ type: 'thinking', content: 'Reasoning' });

    // After tool calls, should be text (streaming phase)
    const textChunks = chunks.filter(c => c.type === 'text');
    expect(textChunks).toContainEqual({ type: 'text', content: 'Answer' });
  });

  it('calls setActivity with TOOL_USE for tool_start', async () => {
    const tui = createMockTUI();
    const events = mockEventStream([
      { type: 'tool_start', tool: 'retrieve_knowledge', input: { query: 'authentication' }, iteration: 1 },
      { type: 'tool_result', tool: 'retrieve_knowledge', result: { sourceCount: 1 }, success: true, durationMs: 20, iteration: 1 },
      { type: 'response_complete', content: '', trace: { steps: [], iterations: 1, totalTokens: 100, durationMs: 500 }, sources: [] },
    ]);

    const { stream } = adaptAgentEventsForTUI(events, tui);
    await collectTUIChunks(stream);

    expect(tui.setActivity).toHaveBeenCalledWith(
      AgentPhase.TOOL_USE,
      'retrieve_knowledge',
      'Searching: "authentication"'
    );
  });

  it('shows info message for tool_result with correct source count', async () => {
    const tui = createMockTUI();
    const events = mockEventStream([
      // ReActLoop unwraps ToolResult.data — result IS RetrieveKnowledgeOutput directly
      { type: 'tool_result', tool: 'retrieve_knowledge', result: { sourceCount: 5 }, success: true, durationMs: 42, iteration: 1 },
      { type: 'response_complete', content: '', trace: { steps: [], iterations: 1, totalTokens: 100, durationMs: 500 }, sources: [] },
    ]);

    const { stream } = adaptAgentEventsForTUI(events, tui);
    await collectTUIChunks(stream);

    const infoCall = vi.mocked(tui.addInfoMessage).mock.calls[0]?.[0] ?? '';
    expect(infoCall).toContain('5 sources');
    expect(infoCall).toContain('42ms');
  });

  it('transitions to IDLE on response_complete', async () => {
    const tui = createMockTUI();
    const events = mockEventStream([
      { type: 'response_complete', content: 'done', trace: { steps: [], iterations: 1, totalTokens: 100, durationMs: 500 }, sources: [] },
    ]);

    const { stream } = adaptAgentEventsForTUI(events, tui);
    await collectTUIChunks(stream);

    expect(tui.setActivity).toHaveBeenCalledWith(AgentPhase.IDLE);
  });

  it('yields error chunks', async () => {
    const tui = createMockTUI();
    const events = mockEventStream([
      { type: 'error', message: 'Stream failed' },
    ]);

    const { stream } = adaptAgentEventsForTUI(events, tui);
    const chunks = await collectTUIChunks(stream);

    expect(chunks).toContainEqual({ type: 'error', content: 'Stream failed' });
  });

  it('collects sources via getSources() after stream completes', async () => {
    const tui = createMockTUI();
    const mockSources = [{
      index: 1,
      filePath: 'src/auth.ts',
      lineRange: { start: 42, end: 67 },
      score: 0.95,
      language: 'typescript',
      fileType: 'code' as const,
    }];
    const events = mockEventStream([
      { type: 'thinking_delta', content: 'Answer', iteration: 1 },
      { type: 'thinking_complete', content: 'Answer', iteration: 1 },
      { type: 'response_complete', content: 'Answer', trace: { steps: [], iterations: 1, totalTokens: 100, durationMs: 500 }, sources: mockSources },
    ]);

    const { stream, getSources } = adaptAgentEventsForTUI(events, tui);

    // Before stream completes, sources should be empty
    expect(getSources()).toEqual([]);

    // After consuming stream, sources should be populated
    await collectTUIChunks(stream);
    expect(getSources()).toHaveLength(1);
    expect(getSources()[0].filePath).toBe('src/auth.ts');
  });
});
