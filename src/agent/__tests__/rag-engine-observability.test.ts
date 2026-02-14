/**
 * RAG Engine Observability Tests
 *
 * Tests that ContextExpertRAGEngine.search() creates child spans
 * when a TraceHandle is provided, and works correctly without one.
 * Uses spy objects implementing TraceHandle/SpanHandle interfaces
 * to capture calls without requiring a Langfuse connection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TraceHandle, SpanHandle, SpanOptions, UpdateData } from '../../observability/types.js';

// We test via the ContextExpertRAGEngine class, but need to mock the SDK engine
// that it wraps. We'll create a minimal mock of RAGEngineImpl.
import { ContextExpertRAGEngine } from '../rag-engine.js';

// ============================================================================
// Spy Helpers
// ============================================================================

/** Creates a SpanHandle spy that records update() and end() calls. */
function createSpanSpy(): SpanHandle & {
  updates: UpdateData[];
  ended: boolean;
} {
  const spy = {
    updates: [] as UpdateData[],
    ended: false,
    update(data: UpdateData): SpanHandle {
      spy.updates.push(data);
      return spy;
    },
    end(): void {
      spy.ended = true;
    },
  };
  return spy;
}

/** Creates a TraceHandle spy that records span() calls. */
function createTraceSpy(): TraceHandle & {
  spans: Array<{ options: SpanOptions; handle: ReturnType<typeof createSpanSpy> }>;
} {
  const trace: TraceHandle & {
    spans: Array<{ options: SpanOptions; handle: ReturnType<typeof createSpanSpy> }>;
  } = {
    traceId: 'test-trace-id',
    spans: [],
    span(options: SpanOptions): SpanHandle {
      const handle = createSpanSpy();
      trace.spans.push({ options, handle });
      return handle;
    },
    generation() {
      return { update: () => ({ update: vi.fn(), end: vi.fn() }), end: vi.fn() } as never;
    },
    update() {
      return trace;
    },
    end: vi.fn(),
  };
  return trace;
}

// ============================================================================
// Mock SDK Engine
// ============================================================================

/** Minimal mock of RAGEngineImpl that returns canned results. */
function createMockSDKEngine() {
  return {
    search: vi.fn().mockResolvedValue({
      content: '<context>test</context>',
      estimatedTokens: 100,
      sources: [
        {
          source: 'src/auth.ts',
          score: 0.9,
          metadata: { filePath: 'src/auth.ts', startLine: 1, endLine: 10 },
        },
      ],
      retrievalResults: [
        {
          id: 'chunk-1',
          chunk: {
            id: 'chunk-1',
            content: 'test content',
            metadata: {
              filePath: 'src/auth.ts',
              fileType: 'code',
              language: 'typescript',
              startLine: 1,
              endLine: 10,
            },
          },
          score: 0.9,
        },
      ],
      metadata: {
        timings: { retrievalMs: 50, assemblyMs: 10 },
        retrievedCount: 1,
        assembledCount: 1,
        fromCache: false,
      },
    }),
    warmUp: vi.fn().mockResolvedValue(undefined),
  };
}

/** Minimal mock FusionService. */
function createMockFusionService() {
  return {
    search: vi.fn(),
    ensureInitialized: vi.fn(),
    getProjectId: () => 'test-project',
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('RAG Engine Observability', () => {
  let engine: ContextExpertRAGEngine;
  let mockSDKEngine: ReturnType<typeof createMockSDKEngine>;

  beforeEach(() => {
    mockSDKEngine = createMockSDKEngine();

    engine = new ContextExpertRAGEngine(
      mockSDKEngine as never, // RAGEngineImpl mock
      createMockFusionService() as never, // FusionService mock
      {
        max_tokens: 4000,
        retrieve_k: 20,
        final_k: 5,
        enhance_query: false,
        ordering: 'sandwich',
      }
    );
  });

  it('creates a child span when trace handle is provided', async () => {
    const traceSpy = createTraceSpy();

    await engine.search('How does auth work?', { trace: traceSpy });

    // Should have created exactly one span
    expect(traceSpy.spans).toHaveLength(1);

    // Span should be named 'rag-engine-search'
    const span = traceSpy.spans[0];
    expect(span.options.name).toBe('rag-engine-search');
    expect(span.options.input).toEqual({
      query: 'How does auth work?',
      topK: 5,
      maxTokens: 4000,
    });
  });

  it('updates span with result metadata on success', async () => {
    const traceSpy = createTraceSpy();

    await engine.search('test query', { trace: traceSpy });

    const spanHandle = traceSpy.spans[0].handle;

    // Should have called update with output metadata
    expect(spanHandle.updates).toHaveLength(1);
    const updateData = spanHandle.updates[0];
    expect(updateData.output).toEqual({
      sourceCount: 1,
      estimatedTokens: 100,
      fromCache: false,
    });
    expect(updateData.metadata).toBeDefined();
    expect(updateData.metadata!.retrievalMs).toBe(50);
  });

  it('ends span on success', async () => {
    const traceSpy = createTraceSpy();

    await engine.search('test query', { trace: traceSpy });

    const spanHandle = traceSpy.spans[0].handle;
    expect(spanHandle.ended).toBe(true);
  });

  it('ends span on error', async () => {
    mockSDKEngine.search.mockRejectedValueOnce(new Error('Search failed'));
    const traceSpy = createTraceSpy();

    await expect(
      engine.search('test query', { trace: traceSpy })
    ).rejects.toThrow('Search failed');

    const spanHandle = traceSpy.spans[0].handle;

    // Span should have error metadata
    expect(spanHandle.updates).toHaveLength(1);
    expect(spanHandle.updates[0].metadata).toEqual({ error: 'Search failed' });

    // Span should still be ended
    expect(spanHandle.ended).toBe(true);
  });

  it('works without a trace handle (backward compatible)', async () => {
    // No trace passed — should not throw
    const result = await engine.search('test query');

    expect(result).toBeDefined();
    expect(result.content).toBe('<context>test</context>');
    expect(result.sources).toHaveLength(1);
  });

  it('works with undefined trace handle', async () => {
    const result = await engine.search('test query', { trace: undefined });

    expect(result).toBeDefined();
    expect(result.content).toBe('<context>test</context>');
  });
});
