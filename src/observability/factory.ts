/**
 * Tracer Factory
 *
 * Creates the appropriate Tracer based on configuration.
 *
 * Decision tree:
 *   1. observability.enabled === false    → NoopTracer
 *   2. No Langfuse keys (config or env)  → NoopTracer (local-only mode)
 *   3. Keys present                      → LangfuseTracer (OTel + Langfuse cloud)
 *
 * Environment variables (LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY) take
 * precedence over config.toml values, matching existing API key patterns
 * in src/config/env.ts.
 */

import type { Config } from '../config/schema.js';
import type { Tracer } from './types.js';
import { createNoopTracer } from './noop-tracer.js';
import { createLangfuseTracer } from './langfuse-tracer.js';

/**
 * Create a tracer based on the application configuration.
 *
 * Returns NoopTracer (zero overhead) when observability is disabled or
 * Langfuse keys are not configured. Returns LangfuseTracer when keys
 * are available, initializing the OpenTelemetry SDK with a Langfuse
 * span processor.
 *
 * @param config - Full application config (reads observability section)
 * @returns Tracer instance — NoopTracer or LangfuseTracer
 */
export function createTracer(config: Config): Tracer {
  const obsConfig = config.observability;

  // Path 1: Observability disabled entirely
  if (!obsConfig?.enabled) {
    return createNoopTracer();
  }

  // Resolve Langfuse keys: env vars take precedence over config.toml
  const publicKey =
    process.env['LANGFUSE_PUBLIC_KEY'] ?? obsConfig.langfuse_public_key;
  const secretKey =
    process.env['LANGFUSE_SECRET_KEY'] ?? obsConfig.langfuse_secret_key;

  // Path 2: No keys configured — local-only mode
  if (!publicKey || !secretKey) {
    return createNoopTracer();
  }

  // Path 3: Keys present — initialize Langfuse cloud tracing
  const baseUrl =
    process.env['LANGFUSE_BASE_URL'] ??
    obsConfig.langfuse_host ??
    'https://cloud.langfuse.com';

  return createLangfuseTracer({
    publicKey,
    secretKey,
    baseUrl,
  });
}
