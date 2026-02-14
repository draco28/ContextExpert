/**
 * Observability Module
 *
 * Provides tracer abstraction for Langfuse v4 (OpenTelemetry-based) observability.
 * Commands use createTracer(config) to get a Tracer instance, then create
 * traces for their operations.
 *
 * @example
 * ```typescript
 * import { createTracer } from '../observability/index.js';
 *
 * const tracer = createTracer(config);
 * const trace = tracer.trace({ name: 'ctx-ask', input: question });
 * // ... do work ...
 * trace.end();
 * await tracer.shutdown();
 * ```
 */

// Types
export type {
  Tracer,
  TraceHandle,
  SpanHandle,
  GenerationHandle,
  TraceOptions,
  SpanOptions,
  GenerationOptions,
  UpdateData,
} from './types.js';

// Factory (primary API)
export { createTracer } from './factory.js';

// Implementations (for testing or direct use)
export { createNoopTracer } from './noop-tracer.js';
export { createLangfuseTracer, type LangfuseTracerConfig } from './langfuse-tracer.js';
