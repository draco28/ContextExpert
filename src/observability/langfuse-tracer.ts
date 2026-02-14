/**
 * LangfuseTracer — Langfuse v4 (OpenTelemetry-based) implementation.
 *
 * Wraps the Langfuse v4 SDK to implement our Tracer interface.
 * Initializes an OpenTelemetry NodeSDK with a LangfuseSpanProcessor
 * that exports spans to Langfuse cloud.
 *
 * Uses startObservation() (handle-based API) from @langfuse/tracing
 * rather than the callback-based startActiveObservation().
 *
 * Lifecycle:
 *   createLangfuseTracer(config) → Tracer
 *     tracer.trace() → creates root observation
 *       handle.span() → creates child span observation
 *       handle.generation() → creates child generation observation
 *     tracer.flush() → processor.forceFlush()
 *     tracer.shutdown() → sdk.shutdown() (flushes + closes)
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { startObservation } from '@langfuse/tracing';
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
// Config
// ============================================================================

/** Configuration required to create a LangfuseTracer. */
export interface LangfuseTracerConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

// ============================================================================
// Handle wrappers (adapt Langfuse observations to our interface)
// ============================================================================

/**
 * Wraps a Langfuse observation as a SpanHandle.
 * The observation object from startObservation() has .update() and .end().
 */
function wrapSpan(obs: ReturnType<typeof startObservation>): SpanHandle {
  return {
    update(data: UpdateData): SpanHandle {
      obs.update({
        output: data.output,
        metadata: data.metadata,
      });
      return this;
    },
    end(): void {
      obs.end();
    },
  };
}

/**
 * Wraps a Langfuse observation as a GenerationHandle.
 * Includes usageDetails mapping for LLM token tracking.
 */
function wrapGeneration(obs: ReturnType<typeof startObservation>): GenerationHandle {
  return {
    update(data: UpdateData): GenerationHandle {
      obs.update({
        output: data.output,
        metadata: data.metadata,
        ...(data.usage && {
          usageDetails: {
            input: data.usage.input,
            output: data.usage.output,
            total: data.usage.total,
          },
        }),
      });
      return this;
    },
    end(): void {
      obs.end();
    },
  };
}

/**
 * Wraps a root Langfuse observation as a TraceHandle.
 * Can create child spans and generations via parent.startObservation().
 */
function wrapTrace(obs: ReturnType<typeof startObservation>): TraceHandle {
  return {
    span(options: SpanOptions): SpanHandle {
      const child = obs.startObservation(options.name, {
        input: options.input,
        metadata: options.metadata,
      });
      return wrapSpan(child);
    },
    generation(options: GenerationOptions): GenerationHandle {
      const child = obs.startObservation(
        options.name,
        {
          model: options.model,
          input: options.input,
          metadata: options.metadata,
        },
        { asType: 'generation' },
      );
      return wrapGeneration(child);
    },
    update(data: UpdateData): TraceHandle {
      obs.update({
        output: data.output,
        metadata: data.metadata,
      });
      return this;
    },
    end(): void {
      obs.end();
    },
  };
}

// ============================================================================
// LangfuseTracer factory
// ============================================================================

/**
 * Create a Langfuse-backed tracer using the v4 OpenTelemetry SDK.
 *
 * Initializes a NodeSDK with a LangfuseSpanProcessor that exports
 * all OpenTelemetry spans to Langfuse cloud. The SDK must be started
 * before any tracing occurs and shut down on process exit.
 *
 * @param config - Langfuse connection config (keys, host)
 * @returns Tracer instance that exports spans to Langfuse
 */
export function createLangfuseTracer(config: LangfuseTracerConfig): Tracer {
  const processor = new LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
  });

  const sdk = new NodeSDK({
    spanProcessors: [processor],
  });

  sdk.start();

  return {
    trace(options: TraceOptions): TraceHandle {
      const obs = startObservation(options.name, {
        input: options.input,
        metadata: options.metadata,
      });

      // sessionId and userId are trace-level attributes in Langfuse v4,
      // not span attributes. Set them via updateTrace() on the root observation.
      if (options.sessionId || options.userId) {
        obs.updateTrace({
          ...(options.sessionId && { sessionId: options.sessionId }),
          ...(options.userId && { userId: options.userId }),
        });
      }

      return wrapTrace(obs);
    },

    async flush(): Promise<void> {
      await processor.forceFlush();
    },

    async shutdown(): Promise<void> {
      await sdk.shutdown();
    },

    isRemote: true,
  };
}
