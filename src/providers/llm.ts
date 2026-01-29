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
  createAnthropicProvider,
  type AnthropicProviderOptions,
} from './anthropic.js';
import { createOpenAIProvider, type OpenAIProviderOptions } from './openai.js';
import { createOllamaProvider, type OllamaProviderOptions } from './ollama.js';

// ============================================================================
// TYPES
// ============================================================================

/** Supported LLM provider types */
export type ProviderType = 'anthropic' | 'openai' | 'ollama';

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
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create an LLM provider based on configuration.
 *
 * This is the main entry point for getting an LLM provider in the CLI.
 * It reads config.default_provider and config.default_model to determine
 * which provider to create and how to configure it.
 *
 * @param config - Application configuration (from loadConfig())
 * @param options - Optional overrides and provider-specific options
 * @returns Provider instance with metadata
 * @throws Error if the configured provider cannot be created
 *
 * @example
 * ```typescript
 * // Basic usage - uses config defaults
 * const { provider, name, model } = await createLLMProvider(config);
 * console.log(`Using ${name} with model ${model}`);
 *
 * // Override model
 * const { provider } = await createLLMProvider(config, {
 *   model: 'claude-3-opus-20240229',
 * });
 *
 * // Skip availability check for faster startup
 * const { provider } = await createLLMProvider(config, {
 *   skipAvailabilityCheck: true,
 * });
 *
 * // Provider-specific options
 * const { provider } = await createLLMProvider(config, {
 *   openai: {
 *     organization: 'org-xxx',
 *     baseURL: 'https://openrouter.ai/api/v1',
 *   },
 * });
 * ```
 */
export async function createLLMProvider(
  config: Config,
  options: LLMProviderOptions = {}
): Promise<LLMProviderResult> {
  const providerType = config.default_provider;
  const model = options.model ?? config.default_model;
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

    default: {
      // TypeScript exhaustiveness check - this should never happen
      // if config.default_provider is properly typed
      const _exhaustiveCheck: never = providerType;
      throw new Error(`Unknown provider type: ${_exhaustiveCheck}`);
    }
  }
}
