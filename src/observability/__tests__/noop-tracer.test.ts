import { describe, it, expect } from 'vitest';
import { createNoopTracer } from '../noop-tracer.js';

describe('NoopTracer', () => {
  it('creates a tracer with isRemote = false', () => {
    const tracer = createNoopTracer();
    expect(tracer.isRemote).toBe(false);
  });

  it('trace() returns a valid TraceHandle', () => {
    const tracer = createNoopTracer();
    const trace = tracer.trace({ name: 'test-trace' });
    expect(trace).toBeDefined();
    expect(typeof trace.span).toBe('function');
    expect(typeof trace.generation).toBe('function');
    expect(typeof trace.update).toBe('function');
    expect(typeof trace.end).toBe('function');
  });

  it('span() returns a valid SpanHandle', () => {
    const tracer = createNoopTracer();
    const trace = tracer.trace({ name: 'test' });
    const span = trace.span({ name: 'test-span' });
    expect(span).toBeDefined();
    expect(typeof span.update).toBe('function');
    expect(typeof span.end).toBe('function');
  });

  it('generation() returns a valid GenerationHandle', () => {
    const tracer = createNoopTracer();
    const trace = tracer.trace({ name: 'test' });
    const gen = trace.generation({ name: 'test-gen', model: 'gpt-4' });
    expect(gen).toBeDefined();
    expect(typeof gen.update).toBe('function');
    expect(typeof gen.end).toBe('function');
  });

  it('all methods are callable without error', () => {
    const tracer = createNoopTracer();
    const trace = tracer.trace({
      name: 'test',
      input: 'question',
      metadata: { key: 'value' },
      sessionId: 'session-1',
      userId: 'user-1',
    });

    // Span lifecycle
    const span = trace.span({ name: 'span', input: 'data', metadata: { x: 1 } });
    span.update({ output: 'result', metadata: { y: 2 } });
    span.end();

    // Generation lifecycle
    const gen = trace.generation({ name: 'gen', model: 'claude', input: 'prompt' });
    gen.update({ output: 'answer', usage: { input: 100, output: 50, total: 150 } });
    gen.end();

    // Trace update and end
    trace.update({ output: 'final', metadata: { done: true } });
    trace.end();
  });

  it('update() returns the handle for chaining', () => {
    const tracer = createNoopTracer();
    const trace = tracer.trace({ name: 'test' });

    // Fluent API: update().end()
    const span = trace.span({ name: 'span' });
    const returned = span.update({ output: 'result' });
    expect(returned).toBe(span);

    const gen = trace.generation({ name: 'gen' });
    const genReturned = gen.update({ output: 'answer' });
    expect(genReturned).toBe(gen);

    const traceReturned = trace.update({ output: 'done' });
    expect(traceReturned).toBe(trace);
  });

  it('reuses shared singleton handles (zero allocation)', () => {
    const tracer = createNoopTracer();
    const trace1 = tracer.trace({ name: 'trace-1' });
    const trace2 = tracer.trace({ name: 'trace-2' });

    // Same object returned for every trace (singleton pattern)
    expect(trace1).toBe(trace2);

    const span1 = trace1.span({ name: 'span-1' });
    const span2 = trace2.span({ name: 'span-2' });
    expect(span1).toBe(span2);

    const gen1 = trace1.generation({ name: 'gen-1' });
    const gen2 = trace2.generation({ name: 'gen-2' });
    expect(gen1).toBe(gen2);
  });

  it('flush() resolves immediately', async () => {
    const tracer = createNoopTracer();
    await expect(tracer.flush()).resolves.toBeUndefined();
  });

  it('shutdown() resolves immediately', async () => {
    const tracer = createNoopTracer();
    await expect(tracer.shutdown()).resolves.toBeUndefined();
  });
});
