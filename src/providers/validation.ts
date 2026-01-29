/**
 * API Key Validators
 *
 * Validates API key format without exposing key values.
 * Each provider has specific format requirements.
 *
 * SECURITY: These functions NEVER log or return the actual key.
 * They only report presence/absence and format validity.
 */

import { z } from 'zod';
import { getEnv, hasApiKey, SETUP_INSTRUCTIONS } from '../config/env.js';

// ============================================================================
// VALIDATION RESULT TYPE
// ============================================================================

/**
 * Result of validating a provider's API key.
 * Uses a discriminated union for type-safe error handling.
 *
 * When valid: { valid: true }
 * When invalid: { valid: false, error: string, setupInstructions: string }
 */
export type ValidationResult =
  | { valid: true }
  | { valid: false; error: string; setupInstructions: string };

// ============================================================================
// FORMAT VALIDATORS (Zod schemas)
// ============================================================================

/**
 * Anthropic API key format: sk-ant-api03-... (variable length)
 *
 * Format history:
 * - Old format: sk-ant-... (shorter)
 * - Current format: sk-ant-api03-... (longer, versioned)
 *
 * We check the common prefix only to be forward-compatible.
 */
export const AnthropicKeySchema = z
  .string()
  .min(1, 'API key cannot be empty')
  .refine(
    (key) => key.startsWith('sk-ant-'),
    'Invalid Anthropic API key format (should start with "sk-ant-")'
  );

/**
 * OpenAI API key format: sk-... (variable length)
 *
 * OpenAI has multiple key types:
 * - sk-... (legacy)
 * - sk-proj-... (project-scoped)
 * - sk-svcacct-... (service accounts)
 *
 * All start with "sk-" so we use that as the common check.
 */
export const OpenAIKeySchema = z
  .string()
  .min(1, 'API key cannot be empty')
  .refine(
    (key) => key.startsWith('sk-'),
    'Invalid OpenAI API key format (should start with "sk-")'
  );

/**
 * Ollama host URL format validation.
 * Must be a valid HTTP or HTTPS URL.
 */
export const OllamaHostSchema = z
  .string()
  .url('Invalid Ollama host URL')
  .refine(
    (url) => url.startsWith('http://') || url.startsWith('https://'),
    'Ollama host must be an HTTP(S) URL'
  );

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

/**
 * Validate that Anthropic API key exists and has correct format.
 * Returns actionable error message with setup instructions if invalid.
 *
 * @returns ValidationResult indicating success or failure with details
 */
export function validateAnthropicKey(): ValidationResult {
  if (!hasApiKey('anthropic')) {
    return {
      valid: false,
      error: 'ANTHROPIC_API_KEY environment variable is not set',
      setupInstructions: SETUP_INSTRUCTIONS.anthropic,
    };
  }

  const key = getEnv('ANTHROPIC_API_KEY')!;
  const result = AnthropicKeySchema.safeParse(key);

  if (!result.success) {
    return {
      valid: false,
      error: result.error.issues[0]?.message ?? 'Invalid API key format',
      setupInstructions: SETUP_INSTRUCTIONS.anthropic,
    };
  }

  return { valid: true };
}

/**
 * Validate that OpenAI API key exists and has correct format.
 *
 * @returns ValidationResult indicating success or failure with details
 */
export function validateOpenAIKey(): ValidationResult {
  if (!hasApiKey('openai')) {
    return {
      valid: false,
      error: 'OPENAI_API_KEY environment variable is not set',
      setupInstructions: SETUP_INSTRUCTIONS.openai,
    };
  }

  const key = getEnv('OPENAI_API_KEY')!;
  const result = OpenAIKeySchema.safeParse(key);

  if (!result.success) {
    return {
      valid: false,
      error: result.error.issues[0]?.message ?? 'Invalid API key format',
      setupInstructions: SETUP_INSTRUCTIONS.openai,
    };
  }

  return { valid: true };
}

/**
 * Validate Ollama host URL format from environment variable.
 * Ollama doesn't require an API key, just a valid host URL.
 *
 * NOTE: If you have a custom host URL (from options), use validateOllamaHostUrl() instead.
 *
 * @returns ValidationResult indicating success or failure with details
 */
export function validateOllamaHost(): ValidationResult {
  const host = getEnv('OLLAMA_HOST');
  return validateOllamaHostUrl(host);
}

/**
 * Validate a specific Ollama host URL.
 *
 * Use this when validating a host from options or any source other than env var.
 * This fixes the bug where validateOllamaHost() would always check the env var
 * even when a custom host was provided via options.
 *
 * @param host - The host URL to validate
 * @returns ValidationResult indicating success or failure with details
 *
 * @example
 * ```typescript
 * const host = options.host ?? getOllamaHost();
 * const validation = validateOllamaHostUrl(host);  // Validates the ACTUAL host
 * ```
 */
export function validateOllamaHostUrl(host: string): ValidationResult {
  const result = OllamaHostSchema.safeParse(host);

  if (!result.success) {
    return {
      valid: false,
      error: result.error.issues[0]?.message ?? 'Invalid Ollama host URL',
      setupInstructions: SETUP_INSTRUCTIONS.ollama,
    };
  }

  return { valid: true };
}

/**
 * Validate the API key/config for a given provider.
 * This is the main entry point - call this before using a provider.
 *
 * @param provider - The provider to validate ('anthropic', 'openai', or 'ollama')
 * @returns ValidationResult indicating success or failure with details
 *
 * @example
 * ```typescript
 * const result = validateProviderKey(config.default_provider);
 * if (!result.valid) {
 *   ctx.error(result.error);
 *   ctx.log(result.setupInstructions);
 *   return;
 * }
 * // Safe to proceed
 * ```
 */
export function validateProviderKey(
  provider: 'anthropic' | 'openai' | 'ollama'
): ValidationResult {
  switch (provider) {
    case 'anthropic':
      return validateAnthropicKey();
    case 'openai':
      return validateOpenAIKey();
    case 'ollama':
      return validateOllamaHost();
  }
}

// ============================================================================
// SECURE KEY ACCESS
// ============================================================================

/**
 * Get API key for provider AFTER validation.
 * Throws if key is invalid - always call validateProviderKey first!
 *
 * This is the ONLY function that returns the actual key value.
 * Use it only when passing to an API client, never for logging.
 *
 * @param provider - The provider to get the key for
 * @returns The API key string
 * @throws Error if key is not configured or invalid
 *
 * @example
 * ```typescript
 * // Always validate first
 * const validation = validateProviderKey('anthropic');
 * if (!validation.valid) {
 *   // Handle error
 *   return;
 * }
 *
 * // Now safe to get the key
 * const apiKey = getProviderKey('anthropic');
 * const client = new Anthropic({ apiKey });
 * ```
 */
export function getProviderKey(provider: 'anthropic' | 'openai'): string {
  const validation = validateProviderKey(provider);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  return getProviderKeyUnsafe(provider);
}

/**
 * Get API key WITHOUT validation.
 *
 * ONLY call this after you've already validated with validateProviderKey()
 * or the provider-specific validation function. This avoids redundant validation
 * when you've already checked the key is valid.
 *
 * @internal Use getProviderKey() for external/public use.
 *
 * @param provider - The provider to get the key for
 * @returns The API key string
 * @throws Error if key is not configured (but NOT format validation)
 *
 * @example
 * ```typescript
 * // Internal use after explicit validation
 * const validation = validateAnthropicKey();
 * if (!validation.valid) { throw... }
 * const apiKey = getProviderKeyUnsafe('anthropic');  // Skip redundant validation
 * ```
 */
export function getProviderKeyUnsafe(provider: 'anthropic' | 'openai'): string {
  const key =
    provider === 'anthropic'
      ? getEnv('ANTHROPIC_API_KEY')
      : getEnv('OPENAI_API_KEY');

  if (!key) {
    throw new Error(`${provider.toUpperCase()}_API_KEY is not configured`);
  }

  return key;
}
