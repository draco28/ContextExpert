/**
 * Startup Configuration Validation
 *
 * Validates API keys and configuration at CLI startup.
 * Provides early warnings for misconfigurations to avoid wasted time.
 *
 * IMPORTANT: This is a WARNING system, not a hard block.
 * Commands that don't need LLM/embedding should still work.
 */

import chalk from 'chalk';
import { z } from 'zod';
import { loadConfig } from './loader.js';
import { validateProviderKey } from '../providers/validation.js';
import { hasApiKey, SETUP_INSTRUCTIONS } from './env.js';
import { LLMProviderTypeSchema, EmbeddingConfigSchema } from './schema.js';

// Infer types from Zod schemas
type LLMProvider = z.infer<typeof LLMProviderTypeSchema>;
type EmbeddingProvider = z.infer<typeof EmbeddingConfigSchema>['provider'];

// ============================================================================
// Types
// ============================================================================

/**
 * Result of startup validation.
 */
export interface StartupValidationResult {
  /** Whether all required keys are valid */
  valid: boolean;
  /** Warning messages (non-fatal issues) */
  warnings: string[];
  /** Error messages (will prevent some features) */
  errors: string[];
  /** Hint messages with setup instructions */
  hints: string[];
}

/**
 * Options for startup validation.
 */
export interface StartupValidationOptions {
  /** Skip LLM provider validation (for commands that don't need LLM) */
  skipLLM?: boolean;
  /** Skip embedding provider validation (for commands that don't need embeddings) */
  skipEmbedding?: boolean;
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate configuration at CLI startup.
 *
 * Checks:
 * 1. Default LLM provider API key format (if configured)
 * 2. Embedding provider API key (if not using local provider)
 *
 * Returns warnings/errors rather than throwing to allow partial functionality.
 *
 * @param options - Validation options
 * @returns Validation result with warnings, errors, and hints
 *
 * @example
 * const result = validateStartupConfig();
 * if (result.errors.length > 0) {
 *   result.errors.forEach(e => console.error(chalk.red(e)));
 *   result.hints.forEach(h => console.log(chalk.dim(h)));
 * }
 */
export function validateStartupConfig(
  options: StartupValidationOptions = {}
): StartupValidationResult {
  const { skipLLM = false, skipEmbedding = false } = options;
  const warnings: string[] = [];
  const errors: string[] = [];
  const hints: string[] = [];

  // Load config (or use defaults)
  let config;
  try {
    config = loadConfig(false); // Don't create config file if missing
  } catch {
    // Config file doesn't exist or is invalid - will use defaults
    // This is not an error for validation purposes
    config = null;
  }

  // Validate LLM provider key
  if (!skipLLM) {
    const llmProvider = config?.default_provider ?? 'anthropic';
    const llmValidation = validateLLMProviderKey(llmProvider as LLMProvider);

    if (!llmValidation.valid) {
      if (llmValidation.severity === 'error') {
        errors.push(llmValidation.message);
        hints.push(llmValidation.hint);
      } else {
        warnings.push(llmValidation.message);
      }
    }
  }

  // Validate embedding provider key
  if (!skipEmbedding) {
    const embeddingProvider = config?.embedding?.provider ?? 'huggingface';
    const embeddingValidation = validateEmbeddingProviderKey(
      embeddingProvider as EmbeddingProvider
    );

    if (!embeddingValidation.valid) {
      if (embeddingValidation.severity === 'error') {
        errors.push(embeddingValidation.message);
        hints.push(embeddingValidation.hint);
      } else {
        warnings.push(embeddingValidation.message);
      }
    }
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
    hints,
  };
}

/**
 * Validate LLM provider API key.
 */
function validateLLMProviderKey(provider: LLMProvider): {
  valid: boolean;
  severity: 'error' | 'warning';
  message: string;
  hint: string;
} {
  // Ollama doesn't need an API key
  if (provider === 'ollama') {
    return { valid: true, severity: 'warning', message: '', hint: '' };
  }

  // Check if key exists and has valid format
  const validation = validateProviderKey(provider);

  if (!validation.valid) {
    return {
      valid: false,
      severity: 'error',
      message: `${provider.charAt(0).toUpperCase() + provider.slice(1)} API key issue: ${validation.error}`,
      hint: validation.setupInstructions,
    };
  }

  return { valid: true, severity: 'warning', message: '', hint: '' };
}

/**
 * Validate embedding provider API key.
 */
function validateEmbeddingProviderKey(provider: EmbeddingProvider): {
  valid: boolean;
  severity: 'error' | 'warning';
  message: string;
  hint: string;
} {
  // HuggingFace (local) and Ollama don't need API keys
  if (provider === 'huggingface' || provider === 'ollama') {
    return { valid: true, severity: 'warning', message: '', hint: '' };
  }

  // OpenAI embeddings need an API key
  if (provider === 'openai') {
    if (!hasApiKey('openai')) {
      return {
        valid: false,
        severity: 'error',
        message: 'OpenAI embedding provider configured but API key not set',
        hint: SETUP_INSTRUCTIONS.openai,
      };
    }

    const validation = validateProviderKey('openai');
    if (!validation.valid) {
      return {
        valid: false,
        severity: 'error',
        message: `OpenAI API key issue: ${validation.error}`,
        hint: validation.setupInstructions,
      };
    }
  }

  return { valid: true, severity: 'warning', message: '', hint: '' };
}

/**
 * Print startup validation warnings/errors to console.
 *
 * @param result - Validation result from validateStartupConfig
 * @param verbose - Whether to show all warnings (default: only errors)
 */
export function printStartupValidation(
  result: StartupValidationResult,
  verbose = false
): void {
  // Always show errors
  for (const error of result.errors) {
    console.error(chalk.red(`✗ ${error}`));
  }

  // Show hints for errors
  for (const hint of result.hints) {
    console.error(chalk.dim(`  ${hint}`));
  }

  // Only show warnings in verbose mode
  if (verbose) {
    for (const warning of result.warnings) {
      console.warn(chalk.yellow(`⚠ ${warning}`));
    }
  }
}

/**
 * Commands that require LLM functionality.
 * Other commands can run without API keys.
 */
export const COMMANDS_REQUIRING_LLM = ['ask', 'chat'];

/**
 * Commands that require embedding functionality.
 * Other commands can run without embedding keys.
 */
export const COMMANDS_REQUIRING_EMBEDDING = ['index'];

/**
 * Check if a command requires startup validation.
 *
 * @param command - Command name (e.g., 'ask', 'list')
 * @returns Validation options for the command
 */
export function getValidationOptionsForCommand(
  command: string
): StartupValidationOptions {
  return {
    skipLLM: !COMMANDS_REQUIRING_LLM.includes(command),
    skipEmbedding: !COMMANDS_REQUIRING_EMBEDDING.includes(command),
  };
}
