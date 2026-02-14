import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted() so mock variables are available to vi.mock factories (which are hoisted)
const {
  mockForceFlush,
  mockSdkStart,
  mockSdkShutdown,
  mockObsEnd,
  mockObsUpdate,
  mockObsUpdateTrace,
  mockChildEnd,
  mockChildUpdate,
  mockChildStartObservation,
  mockStartObservation,
} = vi.hoisted(() => {
  const mockForceFlush = vi.fn(async () => {});
  const mockSdkStart = vi.fn();
  const mockSdkShutdown = vi.fn(async () => {});
  const mockObsEnd = vi.fn();
  const mockObsUpdate = vi.fn();
  const mockObsUpdateTrace = vi.fn();
  const mockChildEnd = vi.fn();
  const mockChildUpdate = vi.fn();
  const mockChildStartObservation = vi.fn();

  const mockStartObservation = vi.fn(() => ({
    end: mockObsEnd,
    update: mockObsUpdate,
    updateTrace: mockObsUpdateTrace,
    startObservation: vi.fn((_name: string, _attrs: unknown, _opts?: unknown) => ({
      end: mockChildEnd,
      update: mockChildUpdate,
      startObservation: mockChildStartObservation,
    })),
  }));

  return {
    mockForceFlush,
    mockSdkStart,
    mockSdkShutdown,
    mockObsEnd,
    mockObsUpdate,
    mockObsUpdateTrace,
    mockChildEnd,
    mockChildUpdate,
    mockChildStartObservation,
    mockStartObservation,
  };
});

// Mock the external dependencies to avoid real OTel/Langfuse initialization
vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: vi.fn(() => ({
    start: mockSdkStart,
    shutdown: mockSdkShutdown,
  })),
}));

vi.mock('@langfuse/otel', () => ({
  LangfuseSpanProcessor: vi.fn(() => ({
    forceFlush: mockForceFlush,
  })),
}));

vi.mock('@langfuse/tracing', () => ({
  startObservation: mockStartObservation,
}));

import { createLangfuseTracer } from '../langfuse-tracer.js';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';

describe('LangfuseTracer', () => {
  const config = {
    publicKey: 'pk-lf-test',
    secretKey: 'sk-lf-test',
    baseUrl: 'https://test.langfuse.com',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('creates LangfuseSpanProcessor with correct config', () => {
      createLangfuseTracer(config);
      expect(LangfuseSpanProcessor).toHaveBeenCalledWith({
        publicKey: 'pk-lf-test',
        secretKey: 'sk-lf-test',
        baseUrl: 'https://test.langfuse.com',
      });
    });

    it('creates NodeSDK with the processor', () => {
      createLangfuseTracer(config);
      expect(NodeSDK).toHaveBeenCalledWith({
        spanProcessors: [expect.any(Object)],
      });
    });

    it('starts the SDK', () => {
      createLangfuseTracer(config);
      expect(mockSdkStart).toHaveBeenCalled();
    });

    it('reports isRemote = true', () => {
      const tracer = createLangfuseTracer(config);
      expect(tracer.isRemote).toBe(true);
    });
  });

  describe('trace()', () => {
    it('calls startObservation with name and attributes', () => {
      const tracer = createLangfuseTracer(config);
      tracer.trace({
        name: 'ctx-ask',
        input: 'What is X?',
        metadata: { project: 'my-app' },
      });
      expect(mockStartObservation).toHaveBeenCalledWith('ctx-ask', {
        input: 'What is X?',
        metadata: { project: 'my-app' },
      });
    });

    it('sets trace-level attributes via updateTrace for sessionId and userId', () => {
      const tracer = createLangfuseTracer(config);
      tracer.trace({
        name: 'ctx-chat-turn',
        sessionId: 'session-123',
        userId: 'user-456',
      });
      expect(mockObsUpdateTrace).toHaveBeenCalledWith({
        sessionId: 'session-123',
        userId: 'user-456',
      });
    });

    it('does not call updateTrace when no sessionId or userId', () => {
      const tracer = createLangfuseTracer(config);
      tracer.trace({ name: 'ctx-search' });
      expect(mockObsUpdateTrace).not.toHaveBeenCalled();
    });

    it('returns a TraceHandle with span, generation, update, end methods', () => {
      const tracer = createLangfuseTracer(config);
      const trace = tracer.trace({ name: 'test' });
      expect(typeof trace.span).toBe('function');
      expect(typeof trace.generation).toBe('function');
      expect(typeof trace.update).toBe('function');
      expect(typeof trace.end).toBe('function');
    });
  });

  describe('TraceHandle.span()', () => {
    it('creates a child observation via parent.startObservation', () => {
      const tracer = createLangfuseTracer(config);
      const trace = tracer.trace({ name: 'test' });
      trace.span({ name: 'rag-search', input: 'query', metadata: { k: 5 } });
      const obs = mockStartObservation.mock.results[0].value;
      expect(obs.startObservation).toHaveBeenCalledWith('rag-search', {
        input: 'query',
        metadata: { k: 5 },
      });
    });
  });

  describe('TraceHandle.generation()', () => {
    it('creates a child observation with asType: generation', () => {
      const tracer = createLangfuseTracer(config);
      const trace = tracer.trace({ name: 'test' });
      trace.generation({
        name: 'llm-call',
        model: 'claude-sonnet',
        input: 'prompt',
        metadata: { temperature: 0.7 },
      });
      const obs = mockStartObservation.mock.results[0].value;
      expect(obs.startObservation).toHaveBeenCalledWith(
        'llm-call',
        {
          model: 'claude-sonnet',
          input: 'prompt',
          metadata: { temperature: 0.7 },
        },
        { asType: 'generation' },
      );
    });
  });

  describe('TraceHandle.update()', () => {
    it('calls obs.update with output and metadata', () => {
      const tracer = createLangfuseTracer(config);
      const trace = tracer.trace({ name: 'test' });
      trace.update({ output: 'answer', metadata: { ms: 500 } });
      expect(mockObsUpdate).toHaveBeenCalledWith({
        output: 'answer',
        metadata: { ms: 500 },
      });
    });

    it('returns the handle for chaining', () => {
      const tracer = createLangfuseTracer(config);
      const trace = tracer.trace({ name: 'test' });
      const returned = trace.update({ output: 'done' });
      expect(returned).toBe(trace);
    });
  });

  describe('TraceHandle.end()', () => {
    it('calls obs.end()', () => {
      const tracer = createLangfuseTracer(config);
      const trace = tracer.trace({ name: 'test' });
      trace.end();
      expect(mockObsEnd).toHaveBeenCalled();
    });
  });

  describe('SpanHandle.update()', () => {
    it('calls child obs.update with output and metadata', () => {
      const tracer = createLangfuseTracer(config);
      const trace = tracer.trace({ name: 'test' });
      const span = trace.span({ name: 'span' });
      span.update({ output: 'result', metadata: { count: 10 } });
      expect(mockChildUpdate).toHaveBeenCalledWith({
        output: 'result',
        metadata: { count: 10 },
      });
    });
  });

  describe('GenerationHandle.update()', () => {
    it('includes usageDetails when usage is provided', () => {
      const tracer = createLangfuseTracer(config);
      const trace = tracer.trace({ name: 'test' });
      const gen = trace.generation({ name: 'gen', model: 'gpt-4' });
      gen.update({
        output: 'answer',
        usage: { input: 100, output: 50, total: 150 },
      });
      expect(mockChildUpdate).toHaveBeenCalledWith({
        output: 'answer',
        metadata: undefined,
        usageDetails: { input: 100, output: 50, total: 150 },
      });
    });

    it('omits usageDetails when usage is not provided', () => {
      const tracer = createLangfuseTracer(config);
      const trace = tracer.trace({ name: 'test' });
      const gen = trace.generation({ name: 'gen' });
      gen.update({ output: 'answer' });
      expect(mockChildUpdate).toHaveBeenCalledWith({
        output: 'answer',
        metadata: undefined,
      });
    });
  });

  describe('flush()', () => {
    it('calls processor.forceFlush()', async () => {
      const tracer = createLangfuseTracer(config);
      await tracer.flush();
      expect(mockForceFlush).toHaveBeenCalled();
    });
  });

  describe('shutdown()', () => {
    it('calls sdk.shutdown()', async () => {
      const tracer = createLangfuseTracer(config);
      await tracer.shutdown();
      expect(mockSdkShutdown).toHaveBeenCalled();
    });
  });
});
