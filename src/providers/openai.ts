/**
 * OpenAI GPT LLM Provider
 *
 * Factory function that creates a configured OpenAIProvider from the ContextAI SDK.
 * Supports GPT-4o, GPT-4 Turbo, and other OpenAI models.
 *
 * SECURITY: API key is retrieved only after validation passes.
 * Never logs or exposes the key in error messages.
 */

import { OpenAIProvider } from '@contextaisdk/provider-openai';
import { validateOpenAIKey, getProviderKey } from './validation.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Options for creating an OpenAI provider.
 *
 * All options are optional - sensible defaults are applied.
 */
export interface OpenAIProviderOptions {
  /**
   * Model to use for chat completions.
   * @default 'gpt-4o'
   */
  model?: string;

  /**
   * Optional organization ID for API requests.
   * Required for some enterprise accounts.
   */
  organization?: string;

  /**
   * Custom base URL for the API.
   * Useful for:
   * - OpenRouter: 'https://openrouter.ai/api/v1'
   * - Azure OpenAI: 'https://{resource}.openai.azure.com/...'
   * - Local proxies
   */
  baseURL?: string;

  /**
   * Request timeout in milliseconds.
   * @default 60000 (60 seconds)
   */
  timeout?: number;

  /**
   * Maximum number of retries for failed requests.
   * @default 2
   */
  maxRetries?: number;

  /**
   * Skip availability check after creation.
   * @default false
   */
  skipAvailabilityCheck?: boolean;
}

/**
 * Result of creating an OpenAI provider.
 */
export interface OpenAIProviderResult {
  /** The configured provider instance */
  provider: OpenAIProvider;
  /** Provider name for identification */
  name: 'openai';
  /** Model being used */
  model: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default model for OpenAI - GPT-4o (latest flagship model) */
export const DEFAULT_OPENAI_MODEL = 'gpt-4o';

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create a configured OpenAI provider.
 *
 * This is the main entry point for using GPT models in the CLI.
 * It validates the API key, creates the provider, and optionally verifies
 * the provider is available before returning.
 *
 * @param options - Configuration options
 * @returns Provider instance with metadata
 * @throws Error if API key is missing or invalid (with setup instructions)
 * @throws Error if availability check fails
 *
 * @example
 * ```typescript
 * // Basic usage - uses defaults (gpt-4o)
 * const { provider, model } = await createOpenAIProvider();
 *
 * // With custom model
 * const { provider } = await createOpenAIProvider({
 *   model: 'gpt-4-turbo',
 * });
 *
 * // Using OpenRouter
 * const { provider } = await createOpenAIProvider({
 *   baseURL: 'https://openrouter.ai/api/v1',
 *   model: 'anthropic/claude-3-sonnet', // OpenRouter model names
 * });
 * ```
 */
export async function createOpenAIProvider(
  options: OpenAIProviderOptions = {}
): Promise<OpenAIProviderResult> {
  // 1. Validate API key format and presence
  const validation = validateOpenAIKey();
  if (!validation.valid) {
    throw new Error(`${validation.error}\n\n${validation.setupInstructions}`);
  }

  // 2. Get API key securely
  const apiKey = getProviderKey('openai');

  // 3. Determine model to use
  const model = options.model ?? DEFAULT_OPENAI_MODEL;

  // 4. Create the provider instance
  const provider = new OpenAIProvider({
    apiKey,
    model,
    organization: options.organization,
    baseURL: options.baseURL,
    timeout: options.timeout,
    maxRetries: options.maxRetries,
  });

  // 5. Optionally verify the provider is available
  if (!options.skipAvailabilityCheck) {
    const isAvailable = await provider.isAvailable();
    if (!isAvailable) {
      throw new Error(
        'OpenAI API is not available. Check your API key and internet connection.'
      );
    }
  }

  return {
    provider,
    name: 'openai',
    model,
  };
}
