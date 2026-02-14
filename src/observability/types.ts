/**
 * Observability Types
 *
 * Tracer abstraction for Langfuse v4 (OpenTelemetry-based) observability.
 * Follows the null-object pattern: NoopTracer when not configured, real
 * LangfuseTracer when keys are present. Commands create and use tracers
 * without knowing which implementation they have.
 *
 * Maps to Langfuse v4 SDK:
 *   tracer.trace()           → startObservation(name, attrs)
 *   traceHandle.span()       → parent.startObservation(name, attrs)
 *   traceHandle.generation() → parent.startObservation(name, attrs, { asType: 'generation' })
 *   handle.update()          → obs.update({ output, usageDetails })
 *   handle.end()             → obs.end()
 *   tracer.flush()           → processor.forceFlush()
 *   tracer.shutdown()        → sdk.shutdown()
 */

// ============================================================================
// Input Options
// ============================================================================

/** Options for creating a new trace (root observation). */
export interface TraceOptions {
  /** Unique name for the trace (e.g., 'ctx-ask', 'ctx-search', 'ctx-chat-turn') */
  name: string;
  /** User-provided input (the query/question) */
  input?: unknown;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
  /** Session ID for grouping related traces (e.g., chat session) */
  sessionId?: string;
  /** User identifier */
  userId?: string;
}

/** Options for creating a span within a trace. */
export interface SpanOptions {
  /** Span name (e.g., 'rag-search', 'embedding', 'reranking') */
  name: string;
  /** Input data */
  input?: unknown;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

/** Options for creating a generation (LLM call) within a trace. */
export interface GenerationOptions {
  /** Generation name (e.g., 'answer-generation') */
  name: string;
  /** Model name (e.g., 'claude-sonnet-4-20250514') */
  model?: string;
  /** Input messages/prompt */
  input?: unknown;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

/** Data to update a handle with before ending. */
export interface UpdateData {
  /** Output data */
  output?: unknown;
  /** Token usage for LLM generations */
  usage?: {
    input?: number;
    output?: number;
    total?: number;
  };
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Handles (returned by trace/span/generation creation)
// ============================================================================

/**
 * Handle for a span observation.
 * Returned by TraceHandle.span(). Call end() when the span completes.
 */
export interface SpanHandle {
  /** Update the span with output/metadata */
  update(data: UpdateData): SpanHandle;
  /** End the span */
  end(): void;
}

/**
 * Handle for a generation (LLM call) observation.
 * Returned by TraceHandle.generation(). Call end() when the generation completes.
 */
export interface GenerationHandle {
  /** Update the generation with output, token usage, and metadata */
  update(data: UpdateData): GenerationHandle;
  /** End the generation */
  end(): void;
}

/**
 * Handle for a trace (root observation).
 * Returned by Tracer.trace(). Use to create child spans and generations.
 */
export interface TraceHandle {
  /** The trace ID (Langfuse trace ID when remote, undefined for noop) */
  readonly traceId?: string;
  /** Create a child span within this trace */
  span(options: SpanOptions): SpanHandle;
  /** Create a child generation (LLM call) within this trace */
  generation(options: GenerationOptions): GenerationHandle;
  /** Update the trace with output/metadata */
  update(data: UpdateData): TraceHandle;
  /** End the trace */
  end(): void;
}

// ============================================================================
// Core Tracer Interface
// ============================================================================

/**
 * Core tracer interface for observability.
 *
 * Commands receive this and use it to create traces for their operations.
 * Implementations: NoopTracer (zero overhead) or LangfuseTracer (real tracing).
 */
export interface Tracer {
  /** Create a new trace for a command invocation */
  trace(options: TraceOptions): TraceHandle;
  /** Flush all pending events to the backend */
  flush(): Promise<void>;
  /** Shut down the tracer (flushes and prevents further events) */
  shutdown(): Promise<void>;
  /** Whether this tracer sends data to a remote service */
  readonly isRemote: boolean;
}
