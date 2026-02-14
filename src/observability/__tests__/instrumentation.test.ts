/**
 * Observability Instrumentation Tests
 *
 * Verifies that the tracing instrumentation in chat-agent correctly:
 * - Creates per-question traces
 * - Creates tool call spans with action→observation lifecycle
 * - Ends traces on completion, error, and max-iterations
 * - Passes correct metadata (iterations, tokens, sources)
 *
 * Uses a spy tracer that records every call for assertion.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMProvider, ChatMessage, StreamChunk, ChatResponse, GenerateOptions } from '@contextaisdk/core';
import { ChatAgent, type ChatAgentEvent, type ChatAgentConfig } from '../../agent/chat-agent.js';
import type { RoutingRAGEngine } from '../../agent/routing-rag-engine.js';
import type { ProjectMetadata } from '../../agent/query-router.js';
import type { Project } from '../../database/schema.js';
import type {
  Tracer,
  TraceHandle,
  SpanHandle,
  GenerationHandle,
  TraceOptions,
  SpanOptions,
  GenerationOptions,
  UpdateData,
} from '../types.js';

// ============================================================================
// Spy Tracer: Records all calls for assertion
// ============================================================================

interface SpyCall {
  method: string;
  args: unknown[];
}

function createSpyTracer() {
  const calls: SpyCall[] = [];

  const spySpanHandle: SpanHandle = {
    update: vi.fn((data: UpdateData) => {
      calls.push({ method: 'span.update', args: [data] });
      return spySpanHandle;
    }),
    end: vi.fn(() => {
      calls.push({ method: 'span.end', args: [] });
    }),
  };

  const spyGenerationHandle: GenerationHandle = {
    update: vi.fn((data: UpdateData) => {
      calls.push({ method: 'generation.update', args: [data] });
      return spyGenerationHandle;
    }),
    end: vi.fn(() => {
      calls.push({ method: 'generation.end', args: [] });
    }),
  };

  const spyTraceHandle: TraceHandle = {
    span: vi.fn((options: SpanOptions) => {
      calls.push({ method: 'trace.span', args: [options] });
      return spySpanHandle;
    }),
    generation: vi.fn((options: GenerationOptions) => {
      calls.push({ method: 'trace.generation', args: [options] });
      return spyGenerationHandle;
    }),
    update: vi.fn((data: UpdateData) => {
      calls.push({ method: 'trace.update', args: [data] });
      return spyTraceHandle;
    }),
    end: vi.fn(() => {
      calls.push({ method: 'trace.end', args: [] });
    }),
  };

  const tracer: Tracer = {
    trace: vi.fn((options: TraceOptions) => {
      calls.push({ method: 'tracer.trace', args: [options] });
      return spyTraceHandle;
    }),
    flush: vi.fn(async () => {
      calls.push({ method: 'tracer.flush', args: [] });
    }),
    shutdown: vi.fn(async () => {
      calls.push({ method: 'tracer.shutdown', args: [] });
    }),
    isRemote: false,
  };

  return { tracer, calls, spyTraceHandle, spySpanHandle };
}

// ============================================================================
// Mock helpers (same pattern as chat-agent.test.ts)
// ============================================================================

function createMockLLMProvider(
  responses: Array<{ textChunks: string[]; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }>
): LLMProvider {
  let callIndex = 0;

  return {
    name: 'test-provider',
    model: 'test-model',
    chat: vi.fn().mockResolvedValue({
      content: 'test response',
      finishReason: 'stop',
    } as ChatResponse),
    isAvailable: vi.fn().mockResolvedValue(true),
    streamChat: vi.fn(async function* (_messages: ChatMessage[], _options?: GenerateOptions) {
      const response = responses[callIndex % responses.length];
      callIndex++;

      for (const text of response.textChunks) {
        yield { type: 'text' as const, content: text } as StreamChunk;
      }

      if (response.toolCalls) {
        for (const tc of response.toolCalls) {
          yield {
            type: 'tool_call' as const,
            toolCall: { id: tc.id, name: tc.name, arguments: JSON.stringify(tc.arguments) },
          } as StreamChunk;
        }
      }

      yield { type: 'usage' as const, usage: { totalTokens: 100 } } as StreamChunk;
      yield { type: 'done' as const } as StreamChunk;
    }),
  };
}

function createMockRoutingEngine(): RoutingRAGEngine {
  return {
    search: vi.fn().mockResolvedValue({
      content: '<sources>test context</sources>',
      estimatedTokens: 50,
      sources: [{
        index: 1,
        filePath: 'src/auth.ts',
        lineRange: { start: 1, end: 10 },
        score: 0.9,
        language: 'typescript',
        fileType: 'code',
      }],
      rawResults: [],
      metadata: {
        retrievalMs: 30,
        assemblyMs: 5,
        totalMs: 35,
        resultsRetrieved: 5,
        resultsAssembled: 1,
        fromCache: false,
      },
      routing: {
        method: 'heuristic',
        projectIds: ['project-1'],
        confidence: 0.9,
        reason: 'test',
      },
    }),
    dispose: vi.fn(),
  } as unknown as RoutingRAGEngine;
}

function createMockProject(): Project {
  return {
    id: 'project-1',
    name: 'my-app',
    path: '/tmp/my-app',
    description: 'Test project',
    tags: '["test"]',
    file_count: 10,
    chunk_count: 50,
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
  } as Project;
}

function createMockProjects(): ProjectMetadata[] {
  return [{
    id: 'project-1',
    name: 'my-app',
    description: 'Test project',
    tags: ['test'],
    fileCount: 10,
    chunkCount: 50,
  }];
}

async function collectEvents(
  gen: AsyncGenerator<ChatAgentEvent, void, unknown>
): Promise<ChatAgentEvent[]> {
  const events: ChatAgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

// ============================================================================
// Tests
// ============================================================================

describe('ChatAgent Observability Instrumentation', () => {
  let spy: ReturnType<typeof createSpyTracer>;

  beforeEach(() => {
    spy = createSpyTracer();
  });

  it('creates a trace per streamQuestion call', async () => {
    const llm = createMockLLMProvider([{ textChunks: ['Hello'] }]);
    const agent = new ChatAgent({
      llmProvider: llm,
      routingEngine: createMockRoutingEngine(),
      allProjects: createMockProjects(),
      currentProject: createMockProject(),
      tracer: spy.tracer,
    });

    await collectEvents(agent.streamQuestion('test question'));

    // Should have created exactly one trace
    const traceCreations = spy.calls.filter((c) => c.method === 'tracer.trace');
    expect(traceCreations).toHaveLength(1);
    expect(traceCreations[0].args[0]).toMatchObject({
      name: 'ctx-chat-turn',
      input: 'test question',
    });
  });

  it('ends trace on successful completion with metadata', async () => {
    const llm = createMockLLMProvider([{ textChunks: ['Hello world'] }]);
    const agent = new ChatAgent({
      llmProvider: llm,
      routingEngine: createMockRoutingEngine(),
      allProjects: createMockProjects(),
      currentProject: createMockProject(),
      tracer: spy.tracer,
    });

    await collectEvents(agent.streamQuestion('test question'));

    // Should have updated and ended the trace
    const traceUpdates = spy.calls.filter((c) => c.method === 'trace.update');
    const traceEnds = spy.calls.filter((c) => c.method === 'trace.end');

    expect(traceUpdates.length).toBeGreaterThanOrEqual(1);
    expect(traceEnds).toHaveLength(1);

    // The final update should contain output
    const lastUpdate = traceUpdates[traceUpdates.length - 1];
    expect((lastUpdate.args[0] as UpdateData).output).toBeDefined();
  });

  it('creates tool spans for action→observation lifecycle', async () => {
    const llm = createMockLLMProvider([
      // First iteration: agent decides to search
      {
        textChunks: ['Let me search'],
        toolCalls: [{ id: 'tc-1', name: 'retrieve_knowledge', arguments: { query: 'auth' } }],
      },
      // Second iteration: agent answers with results
      { textChunks: ['Auth uses JWT'] },
    ]);

    const agent = new ChatAgent({
      llmProvider: llm,
      routingEngine: createMockRoutingEngine(),
      allProjects: createMockProjects(),
      currentProject: createMockProject(),
      tracer: spy.tracer,
    });

    await collectEvents(agent.streamQuestion('How does auth work?'));

    // Should have created a tool span
    const spanCreations = spy.calls.filter((c) => c.method === 'trace.span');
    expect(spanCreations.length).toBeGreaterThanOrEqual(1);
    expect(spanCreations[0].args[0]).toMatchObject({
      name: 'tool:retrieve_knowledge',
    });

    // Span should have been updated and ended
    const spanUpdates = spy.calls.filter((c) => c.method === 'span.update');
    const spanEnds = spy.calls.filter((c) => c.method === 'span.end');
    expect(spanUpdates.length).toBeGreaterThanOrEqual(1);
    expect(spanEnds.length).toBeGreaterThanOrEqual(1);
  });

  it('works without tracer (optional field)', async () => {
    const llm = createMockLLMProvider([{ textChunks: ['Hello'] }]);
    const agent = new ChatAgent({
      llmProvider: llm,
      routingEngine: createMockRoutingEngine(),
      allProjects: createMockProjects(),
      currentProject: createMockProject(),
      // No tracer provided
    });

    // Should not throw
    const events = await collectEvents(agent.streamQuestion('test'));
    const complete = events.find((e) => e.type === 'response_complete');
    expect(complete).toBeDefined();
  });

  it('ends trace on error', async () => {
    // Provider that throws
    const llm: LLMProvider = {
      name: 'error-provider',
      model: 'error-model',
      chat: vi.fn().mockRejectedValue(new Error('LLM error')),
      isAvailable: vi.fn().mockResolvedValue(true),
      streamChat: vi.fn(async function* () {
        throw new Error('Stream error');
      }),
    };

    const agent = new ChatAgent({
      llmProvider: llm,
      routingEngine: createMockRoutingEngine(),
      allProjects: createMockProjects(),
      currentProject: createMockProject(),
      tracer: spy.tracer,
    });

    const events = await collectEvents(agent.streamQuestion('trigger error'));

    // Should have an error event
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();

    // Trace should still be ended (cleanup)
    const traceEnds = spy.calls.filter((c) => c.method === 'trace.end');
    expect(traceEnds).toHaveLength(1);
  });

  it('includes project metadata in trace', async () => {
    const llm = createMockLLMProvider([{ textChunks: ['Hello'] }]);
    const agent = new ChatAgent({
      llmProvider: llm,
      routingEngine: createMockRoutingEngine(),
      allProjects: createMockProjects(),
      currentProject: createMockProject(),
      tracer: spy.tracer,
    });

    await collectEvents(agent.streamQuestion('test'));

    const traceCreation = spy.calls.find((c) => c.method === 'tracer.trace');
    const options = traceCreation!.args[0] as TraceOptions;
    expect(options.metadata).toMatchObject({
      project: 'my-app',
    });
  });

  it('creates separate traces for multiple questions', async () => {
    const llm = createMockLLMProvider([
      { textChunks: ['Answer 1'] },
      { textChunks: ['Answer 2'] },
    ]);
    const agent = new ChatAgent({
      llmProvider: llm,
      routingEngine: createMockRoutingEngine(),
      allProjects: createMockProjects(),
      currentProject: createMockProject(),
      tracer: spy.tracer,
    });

    await collectEvents(agent.streamQuestion('question 1'));
    await collectEvents(agent.streamQuestion('question 2'));

    const traceCreations = spy.calls.filter((c) => c.method === 'tracer.trace');
    expect(traceCreations).toHaveLength(2);
    expect(traceCreations[0].args[0]).toMatchObject({ input: 'question 1' });
    expect(traceCreations[1].args[0]).toMatchObject({ input: 'question 2' });

    // Both traces should be ended
    const traceEnds = spy.calls.filter((c) => c.method === 'trace.end');
    expect(traceEnds).toHaveLength(2);
  });
});
