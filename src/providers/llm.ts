/**
 * LLM Provider Factory
 *
 * Central entry point for creating LLM providers based on configuration.
 * This is the "factory of factories" that dispatches to the appropriate
 * provider-specific factory based on config.default_provider.
 *
 * USAGE:
 * ```typescript
 * import { loadConfig } from '../config';
 * import { createLLMProvider } from '../providers';
 *
 * const config = await loadConfig();
 * const { provider, name, model } = await createLLMProvider(config);
 *
 * const response = await provider.chat([
 *   { role: 'user', content: 'Hello!' }
 * ]);
 * ```
 */

import type { LLMProvider } from '@contextaisdk/core';
import type { Config } from '../config/schema.js';
import {
  isOpenAICompatibleConfigured,
  getOpenAICompatibleConfig,
} from '../config/env.js';

import {
  createAnthropicProvider,
  type AnthropicProviderOptions,
  DEFAULT_ANTHROPIC_MODEL,
} from './anthropic.js';
import {
  createOpenAIProvider,
  type OpenAIProviderOptions,
  DEFAULT_OPENAI_MODEL,
} from './openai.js';
import {
  createOllamaProvider,
  type OllamaProviderOptions,
  DEFAULT_OLLAMA_MODEL,
} from './ollama.js';

// ============================================================================
// TYPES
// ============================================================================

/** Supported LLM provider types */
export type ProviderType = 'anthropic' | 'openai' | 'ollama' | 'openai-compatible';

/**
 * Result of creating an LLM provider.
 * Includes the provider instance plus metadata for logging and debugging.
 */
export interface LLMProviderResult {
  /** The configured provider instance (implements LLMProvider interface) */
  provider: LLMProvider;
  /** Provider name for identification in logs */
  name: ProviderType;
  /** Model being used (e.g., 'claude-sonnet-4-20250514', 'gpt-4o', 'llama3.2') */
  model: string;
}

/**
 * Record of a failed provider creation attempt.
 * Used for diagnostics when multiple providers fail.
 */
export interface ProviderAttempt {
  /** Which provider was attempted */
  provider: ProviderType;
  /** The error that caused the failure */
  error: Error;
  /** When the attempt was made */
  timestamp: Date;
}

/**
 * Extended result that includes fallback metadata.
 * Returned by createLLMProvider when fallback is enabled.
 */
export interface LLMProviderResultWithFallback extends LLMProviderResult {
  /** True if a fallback provider was used instead of the primary */
  usedFallback: boolean;
  /** The provider that was originally requested (from config) */
  requestedProvider: ProviderType;
  /** All failed attempts before success (empty if primary succeeded) */
  failedAttempts: ProviderAttempt[];
}

/**
 * Warning about lost capabilities when falling back to a different provider.
 */
export interface CapabilityWarning {
  /** Provider we're falling back from */
  fromProvider: ProviderType;
  /** Provider we're falling back to */
  toProvider: ProviderType;
  /** Capabilities available in fromProvider but not in toProvider */
  lostCapabilities: string[];
}

/**
 * Callbacks for monitoring fallback behavior.
 */
export interface FallbackOptions {
  /** Called when falling back from one provider to another */
  onFallback?: (from: ProviderType, to: ProviderType, reason: string) => void;
  /** Called when a provider attempt fails */
  onProviderFailed?: (provider: ProviderType, error: Error) => void;
  /** Called when falling back to a provider with fewer capabilities */
  onCapabilityWarning?: (warning: CapabilityWarning) => void;
  /** If true, fail immediately without trying fallback providers */
  disableFallback?: boolean;
}

/**
 * Error thrown when all providers in the fallback chain fail.
 * Contains detailed information about each failed attempt.
 */
export class AllProvidersFailedError extends Error {
  public readonly name = 'AllProvidersFailedError';

  constructor(
    /** All failed provider attempts in order */
    public readonly attempts: ProviderAttempt[],
    message?: string
  ) {
    const providers = attempts.map((a) => a.provider).join(' → ');
    super(message ?? `All LLM providers failed. Tried: ${providers}`);
  }

  /**
   * Get the last error in the chain (most recent failure).
   */
  get lastError(): Error | undefined {
    return this.attempts[this.attempts.length - 1]?.error;
  }
}

/**
 * Options for creating an LLM provider.
 * Provider-specific options can be passed through.
 */
export interface LLMProviderOptions {
  /**
   * Override the model from config.
   * Takes precedence over config.default_model.
   */
  model?: string;

  /**
   * Skip availability check for faster initialization.
   * Use when you're confident the provider is available.
   * @default false
   */
  skipAvailabilityCheck?: boolean;

  /** Anthropic-specific options */
  anthropic?: Omit<AnthropicProviderOptions, 'model' | 'skipAvailabilityCheck'>;

  /** OpenAI-specific options */
  openai?: Omit<OpenAIProviderOptions, 'model' | 'skipAvailabilityCheck'>;

  /** Ollama-specific options */
  ollama?: Omit<OllamaProviderOptions, 'model' | 'skipAvailabilityCheck'>;

  /** Fallback behavior options */
  fallback?: FallbackOptions;
}

// ============================================================================
// FALLBACK CONSTANTS
// ============================================================================

/**
 * Get default fallback chain for a provider.
 * Dynamically includes openai-compatible if configured via env vars.
 */
function getDefaultFallbackChain(primary: ProviderType): ProviderType[] {
  const hasOpenAICompatible = isOpenAICompatibleConfigured();

  // Base chains without openai-compatible
  const baseChains: Record<ProviderType, ProviderType[]> = {
    anthropic: ['openai', 'ollama'],
    openai: ['anthropic', 'ollama'],
    ollama: ['anthropic', 'openai'],
    'openai-compatible': ['anthropic', 'openai', 'ollama'],
  };

  const chain = baseChains[primary];

  // If openai-compatible is configured and not the primary, add it as first fallback
  if (hasOpenAICompatible && primary !== 'openai-compatible') {
    return ['openai-compatible', ...chain];
  }

  return chain;
}

/**
 * Get default model for openai-compatible provider from env vars.
 */
function getOpenAICompatibleModel(): string {
  const config = getOpenAICompatibleConfig();
  return config.model ?? 'gpt-4o'; // Fallback to gpt-4o format
}

/**
 * Default model to use when falling back to a different provider.
 * Maps fromProvider -> toProvider -> model.
 */
function getModelEquivalent(fromProvider: ProviderType, toProvider: ProviderType): string {
  if (toProvider === 'openai-compatible') {
    return getOpenAICompatibleModel();
  }

  const equivalents: Record<ProviderType, Record<Exclude<ProviderType, 'openai-compatible'>, string>> = {
    anthropic: {
      anthropic: DEFAULT_ANTHROPIC_MODEL,
      openai: DEFAULT_OPENAI_MODEL,
      ollama: DEFAULT_OLLAMA_MODEL,
    },
    openai: {
      anthropic: DEFAULT_ANTHROPIC_MODEL,
      openai: DEFAULT_OPENAI_MODEL,
      ollama: DEFAULT_OLLAMA_MODEL,
    },
    ollama: {
      anthropic: DEFAULT_ANTHROPIC_MODEL,
      openai: DEFAULT_OPENAI_MODEL,
      ollama: DEFAULT_OLLAMA_MODEL,
    },
    'openai-compatible': {
      anthropic: DEFAULT_ANTHROPIC_MODEL,
      openai: DEFAULT_OPENAI_MODEL,
      ollama: DEFAULT_OLLAMA_MODEL,
    },
  };

  return equivalents[fromProvider][toProvider as Exclude<ProviderType, 'openai-compatible'>];
}

/**
 * Known capabilities per provider.
 * Used to warn when falling back to a less capable provider.
 */
const PROVIDER_CAPABILITIES: Record<ProviderType, Set<string>> = {
  anthropic: new Set(['vision', 'extended-thinking', 'streaming', 'tool-use']),
  openai: new Set(['vision', 'streaming', 'tool-use', 'json-mode']),
  ollama: new Set(['streaming', 'tool-use']), // Most local models lack vision
  'openai-compatible': new Set(['streaming', 'tool-use']), // Varies by provider
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get the fallback chain for a provider.
 * Uses config if specified, otherwise uses defaults.
 * Dynamically includes openai-compatible if configured via env vars.
 */
function getFallbackChain(config: Config, primary: ProviderType): ProviderType[] {
  // If config specifies fallback_providers, use those (filtering out primary)
  if (config.llm?.fallback_providers) {
    return config.llm.fallback_providers.filter((p) => p !== primary);
  }
  // Otherwise use dynamic default chain
  return getDefaultFallbackChain(primary);
}

/**
 * Get the appropriate model for a fallback provider.
 */
function getFallbackModel(
  config: Config,
  fromProvider: ProviderType,
  toProvider: ProviderType
): string {
  // Check config for explicit mapping first
  const configModel = config.llm?.fallback_models?.[toProvider];
  if (configModel) {
    return configModel;
  }
  // Use default model for the target provider
  return getModelEquivalent(fromProvider, toProvider);
}

/**
 * Compute capabilities lost when falling back from one provider to another.
 */
function getLostCapabilities(
  fromProvider: ProviderType,
  toProvider: ProviderType
): string[] {
  const fromCaps = PROVIDER_CAPABILITIES[fromProvider];
  const toCaps = PROVIDER_CAPABILITIES[toProvider];

  const lost: string[] = [];
  for (const cap of fromCaps) {
    if (!toCaps.has(cap)) {
      lost.push(cap);
    }
  }
  return lost;
}

/**
 * Try to create a single provider. Throws on failure.
 * This is the core creation logic extracted for reuse.
 */
async function tryCreateProvider(
  providerType: ProviderType,
  model: string,
  options: LLMProviderOptions
): Promise<LLMProviderResult> {
  const skipAvailabilityCheck = options.skipAvailabilityCheck ?? false;

  switch (providerType) {
    case 'anthropic': {
      const result = await createAnthropicProvider({
        model,
        skipAvailabilityCheck,
        ...options.anthropic,
      });
      return {
        provider: result.provider,
        name: result.name,
        model: result.model,
      };
    }

    case 'openai': {
      const result = await createOpenAIProvider({
        model,
        skipAvailabilityCheck,
        ...options.openai,
      });
      return {
        provider: result.provider,
        name: result.name,
        model: result.model,
      };
    }

    case 'ollama': {
      const result = await createOllamaProvider({
        model,
        skipAvailabilityCheck,
        ...options.ollama,
      });
      return {
        provider: result.provider,
        name: result.name,
        model: result.model,
      };
    }

    case 'openai-compatible': {
      // Use OpenAI provider factory with custom baseURL from env vars
      const compatConfig = getOpenAICompatibleConfig();
      if (!compatConfig.apiKey || !compatConfig.baseUrl) {
        throw new Error(
          'OpenAI-compatible provider not configured. Set OPENAI_COMPATIBLE_API_KEY and OPENAI_COMPATIBLE_BASE_URL in .env'
        );
      }

      const result = await createOpenAIProvider({
        model: model || compatConfig.model || 'gpt-4o',
        apiKey: compatConfig.apiKey,
        baseURL: compatConfig.baseUrl,
        skipAvailabilityCheck,
        ...options.openai, // Allow additional OpenAI options
      });

      return {
        provider: result.provider,
        name: 'openai-compatible',
        model: result.model,
      };
    }

    default: {
      // TypeScript exhaustiveness check
      const _exhaustiveCheck: never = providerType;
      throw new Error(`Unknown provider type: ${_exhaustiveCheck}`);
    }
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create an LLM provider based on configuration with automatic fallback.
 *
 * This is the main entry point for getting an LLM provider in the CLI.
 * It reads config.default_provider and config.default_model to determine
 * which provider to create and how to configure it.
 *
 * If the primary provider fails (invalid API key, unavailable, etc.),
 * it automatically tries fallback providers in order until one succeeds.
 *
 * @param config - Application configuration (from loadConfig())
 * @param options - Optional overrides and provider-specific options
 * @returns Provider instance with metadata (includes fallback info)
 * @throws AllProvidersFailedError if all providers fail
 *
 * @example
 * ```typescript
 * // Basic usage - uses config defaults with automatic fallback
 * const { provider, name, model, usedFallback } = await createLLMProvider(config);
 * if (usedFallback) {
 *   console.log(`Fell back to ${name}`);
 * }
 *
 * // With fallback callbacks for logging
 * const { provider } = await createLLMProvider(config, {
 *   fallback: {
 *     onFallback: (from, to, reason) => {
 *       console.log(`Falling back from ${from} to ${to}: ${reason}`);
 *     },
 *     onCapabilityWarning: ({ lostCapabilities }) => {
 *       console.warn(`Lost capabilities: ${lostCapabilities.join(', ')}`);
 *     },
 *   },
 * });
 *
 * // Disable fallback - fail immediately if primary unavailable
 * const { provider } = await createLLMProvider(config, {
 *   fallback: { disableFallback: true },
 * });
 * ```
 */
export async function createLLMProvider(
  config: Config,
  options: LLMProviderOptions = {}
): Promise<LLMProviderResultWithFallback> {
  const primaryProvider = config.default_provider;
  const primaryModel = options.model ?? config.default_model;
  const failedAttempts: ProviderAttempt[] = [];

  // Try primary provider first
  try {
    const result = await tryCreateProvider(primaryProvider, primaryModel, options);
    return {
      ...result,
      usedFallback: false,
      requestedProvider: primaryProvider,
      failedAttempts: [],
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    failedAttempts.push({
      provider: primaryProvider,
      error: err,
      timestamp: new Date(),
    });
    options.fallback?.onProviderFailed?.(primaryProvider, err);
  }

  // If fallback is disabled, fail immediately
  if (options.fallback?.disableFallback) {
    throw new AllProvidersFailedError(failedAttempts);
  }

  // Try fallback providers in order
  const fallbackChain = getFallbackChain(config, primaryProvider);

  for (const fallbackProvider of fallbackChain) {
    const fallbackModel = getFallbackModel(config, primaryProvider, fallbackProvider);
    const lastError = failedAttempts[failedAttempts.length - 1]?.error;

    // Notify about fallback attempt
    options.fallback?.onFallback?.(
      primaryProvider,
      fallbackProvider,
      lastError?.message ?? 'Unknown error'
    );

    // Check for capability loss and warn
    const lostCapabilities = getLostCapabilities(primaryProvider, fallbackProvider);
    if (lostCapabilities.length > 0 && options.fallback?.onCapabilityWarning) {
      options.fallback.onCapabilityWarning({
        fromProvider: primaryProvider,
        toProvider: fallbackProvider,
        lostCapabilities,
      });
    }

    // Try the fallback provider
    try {
      const result = await tryCreateProvider(fallbackProvider, fallbackModel, options);
      return {
        ...result,
        usedFallback: true,
        requestedProvider: primaryProvider,
        failedAttempts,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      failedAttempts.push({
        provider: fallbackProvider,
        error: err,
        timestamp: new Date(),
      });
      options.fallback?.onProviderFailed?.(fallbackProvider, err);
    }
  }

  // All providers failed
  throw new AllProvidersFailedError(failedAttempts);
}
