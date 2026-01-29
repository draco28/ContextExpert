/**
 * Providers Module
 *
 * Handles LLM provider configuration, validation, and access.
 * This module bridges the config system with actual API clients.
 *
 * MAIN ENTRY POINT:
 * ```typescript
 * import { createLLMProvider } from './providers';
 * const { provider, name, model } = await createLLMProvider(config);
 * ```
 */

// ============================================================================
// VALIDATION UTILITIES
// ============================================================================

export {
  validateProviderKey,
  validateAnthropicKey,
  validateOpenAIKey,
  validateOllamaHost,
  validateOllamaHostUrl,
  getProviderKey,
  getProviderKeyUnsafe,
  type ValidationResult,
} from './validation.js';

// Schemas for external use (testing, custom validation)
export {
  AnthropicKeySchema,
  OpenAIKeySchema,
  OllamaHostSchema,
} from './validation.js';

// ============================================================================
// LLM PROVIDERS
// ============================================================================

// Main factory - creates provider based on config
export {
  createLLMProvider,
  type LLMProviderResult,
  type LLMProviderOptions,
  type ProviderType,
} from './llm.js';

// Individual provider factories - for direct use when needed
export {
  createAnthropicProvider,
  type AnthropicProviderOptions,
  type AnthropicProviderResult,
  DEFAULT_ANTHROPIC_MODEL,
} from './anthropic.js';

export {
  createOpenAIProvider,
  type OpenAIProviderOptions,
  type OpenAIProviderResult,
  DEFAULT_OPENAI_MODEL,
} from './openai.js';

export {
  createOllamaProvider,
  type OllamaProviderOptions,
  type OllamaProviderResult,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_TIMEOUT,
} from './ollama.js';
