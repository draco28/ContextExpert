/**
 * Providers Module
 *
 * Handles LLM provider configuration, validation, and access.
 * This module bridges the config system with actual API clients.
 */

// Validation utilities
export {
  validateProviderKey,
  validateAnthropicKey,
  validateOpenAIKey,
  validateOllamaHost,
  getProviderKey,
  type ValidationResult,
} from './validation.js';

// Schemas for external use (testing, custom validation)
export {
  AnthropicKeySchema,
  OpenAIKeySchema,
  OllamaHostSchema,
} from './validation.js';
