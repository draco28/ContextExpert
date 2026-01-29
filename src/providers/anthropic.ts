/**
 * Anthropic Claude LLM Provider
 *
 * Factory function that creates a configured AnthropicProvider from the ContextAI SDK.
 * Handles validation and secure API key retrieval before instantiation.
 *
 * SECURITY: API key is retrieved only after validation passes.
 * Never logs or exposes the key in error messages.
 */

import { AnthropicProvider } from '@contextaisdk/provider-anthropic';
import { validateAnthropicKey, getProviderKey } from './validation.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Options for creating an Anthropic provider.
 *
 * All options are optional - sensible defaults are applied.
 */
export interface AnthropicProviderOptions {
  /**
   * Model to use for chat completions.
   * @default 'claude-sonnet-4-20250514'
   */
  model?: string;

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
   * Set to true for faster initialization when you know the API key is valid.
   * @default false
   */
  skipAvailabilityCheck?: boolean;
}

/**
 * Result of creating an Anthropic provider.
 * Includes the provider instance plus metadata for logging/debugging.
 */
export interface AnthropicProviderResult {
  /** The configured provider instance */
  provider: AnthropicProvider;
  /** Provider name for identification */
  name: 'anthropic';
  /** Model being used */
  model: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default model for Anthropic - Claude Sonnet 4 (current best balance of speed/quality) */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create a configured Anthropic provider.
 *
 * This is the main entry point for using Claude models in the CLI.
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
 * // Basic usage - uses defaults
 * const { provider, model } = await createAnthropicProvider();
 *
 * // With custom model
 * const { provider } = await createAnthropicProvider({
 *   model: 'claude-3-opus-20240229',
 * });
 *
 * // Use the provider
 * const response = await provider.chat([
 *   { role: 'user', content: 'Hello!' }
 * ]);
 * ```
 */
export async function createAnthropicProvider(
  options: AnthropicProviderOptions = {}
): Promise<AnthropicProviderResult> {
  // 1. Validate API key format and presence
  const validation = validateAnthropicKey();
  if (!validation.valid) {
    // Throw with both error and setup instructions for actionable feedback
    throw new Error(`${validation.error}\n\n${validation.setupInstructions}`);
  }

  // 2. Get API key securely (only after validation passes)
  const apiKey = getProviderKey('anthropic');

  // 3. Determine model to use
  const model = options.model ?? DEFAULT_ANTHROPIC_MODEL;

  // 4. Create the provider instance
  const provider = new AnthropicProvider({
    apiKey,
    model,
    timeout: options.timeout,
    maxRetries: options.maxRetries,
  });

  // 5. Optionally verify the provider is available
  if (!options.skipAvailabilityCheck) {
    const isAvailable = await provider.isAvailable();
    if (!isAvailable) {
      throw new Error(
        'Anthropic API is not available. Check your API key and internet connection.'
      );
    }
  }

  return {
    provider,
    name: 'anthropic',
    model,
  };
}
