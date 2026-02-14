/**
 * NoopTracer — Null-object pattern implementation.
 *
 * Used when observability is disabled or Langfuse keys are not configured.
 * All methods are zero-cost no-ops. Shared singleton handles eliminate
 * per-trace object allocation — every call returns the same frozen objects.
 */

import type {
  Tracer,
  TraceHandle,
  SpanHandle,
  GenerationHandle,
  TraceOptions,
  SpanOptions,
  GenerationOptions,
  UpdateData,
} from './types.js';

// ============================================================================
// Shared singleton handles (zero allocation per trace)
// ============================================================================

/** No-op span — update() returns self, end() does nothing. */
const NOOP_SPAN: SpanHandle = {
  update(_data: UpdateData): SpanHandle {
    return NOOP_SPAN;
  },
  end(): void {},
};

/** No-op generation — update() returns self, end() does nothing. */
const NOOP_GENERATION: GenerationHandle = {
  update(_data: UpdateData): GenerationHandle {
    return NOOP_GENERATION;
  },
  end(): void {},
};

/** No-op trace — span/generation return noop handles, end() does nothing. */
const NOOP_TRACE: TraceHandle = {
  span(_options: SpanOptions): SpanHandle {
    return NOOP_SPAN;
  },
  generation(_options: GenerationOptions): GenerationHandle {
    return NOOP_GENERATION;
  },
  update(_data: UpdateData): TraceHandle {
    return NOOP_TRACE;
  },
  end(): void {},
};

// ============================================================================
// NoopTracer factory
// ============================================================================

/**
 * Create a no-operation tracer.
 *
 * Returns a tracer where every method is a zero-cost no-op.
 * Safe to call from any command — no side effects, no allocations.
 */
export function createNoopTracer(): Tracer {
  return {
    trace(_options: TraceOptions): TraceHandle {
      return NOOP_TRACE;
    },
    async flush(): Promise<void> {},
    async shutdown(): Promise<void> {},
    isRemote: false,
  };
}
