/**
 * Ollama Local LLM Provider
 *
 * Factory function that creates a configured OllamaProvider from the ContextAI SDK.
 * Supports local models like Llama, Mistral, CodeLlama, and more.
 *
 * KEY DIFFERENCES FROM CLOUD PROVIDERS:
 * - No API key required (local inference)
 * - Validates Ollama server is running
 * - Supports offline operation (NFR-015)
 */

import { OllamaProvider } from '@contextaisdk/provider-ollama';
import { validateOllamaHostUrl } from './validation.js';
import { getOllamaHost } from '../config/env.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Options for creating an Ollama provider.
 *
 * All options are optional - sensible defaults are applied.
 */
export interface OllamaProviderOptions {
  /**
   * Model to use for chat completions.
   * Run `ollama list` to see available models.
   * @default 'llama3.2'
   */
  model?: string;

  /**
   * Ollama server host URL.
   * Reads from OLLAMA_HOST env var if not specified.
   * @default 'http://localhost:11434'
   */
  host?: string;

  /**
   * Request timeout in milliseconds.
   * Local models can be slow, especially on first load.
   * @default 120000 (2 minutes)
   */
  timeout?: number;

  /**
   * Keep model loaded in memory between requests.
   * Set to '0' to unload immediately, or a duration like '5m'.
   * Useful for memory management on systems with limited RAM.
   */
  keepAlive?: string;

  /**
   * Skip availability check after creation.
   * Set to true for faster initialization when you know Ollama is running.
   * @default false
   */
  skipAvailabilityCheck?: boolean;
}

/**
 * Result of creating an Ollama provider.
 */
export interface OllamaProviderResult {
  /** The configured provider instance */
  provider: OllamaProvider;
  /** Provider name for identification */
  name: 'ollama';
  /** Model being used */
  model: string;
  /** Host URL being used */
  host: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default model for Ollama - Llama 3.2 (good balance of quality/speed) */
export const DEFAULT_OLLAMA_MODEL = 'llama3.2';

/** Default timeout for Ollama - 2 minutes (local models can be slow) */
export const DEFAULT_OLLAMA_TIMEOUT = 120000;

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create a configured Ollama provider.
 *
 * This is the main entry point for using local models in the CLI.
 * It validates the host URL, creates the provider, and optionally verifies
 * the server is running and the model is available.
 *
 * OFFLINE SUPPORT (NFR-015):
 * Ollama runs entirely locally - no internet connection required after
 * the initial model download.
 *
 * @param options - Configuration options
 * @returns Provider instance with metadata
 * @throws Error if host URL is invalid
 * @throws Error if Ollama server is not running (unless skipAvailabilityCheck)
 *
 * @example
 * ```typescript
 * // Basic usage - uses defaults (llama3.2)
 * const { provider, model } = await createOllamaProvider();
 *
 * // With custom model
 * const { provider } = await createOllamaProvider({
 *   model: 'codellama',
 * });
 *
 * // Skip availability check for faster startup
 * const { provider } = await createOllamaProvider({
 *   skipAvailabilityCheck: true,
 * });
 *
 * // Use the provider
 * const response = await provider.chat([
 *   { role: 'user', content: 'Hello!' }
 * ]);
 * ```
 */
export async function createOllamaProvider(
  options: OllamaProviderOptions = {}
): Promise<OllamaProviderResult> {
  // 1. Determine host URL (options > env > default)
  const host = options.host ?? getOllamaHost();

  // 2. Validate host URL format (validates the ACTUAL host, not just env var)
  const validation = validateOllamaHostUrl(host);
  if (!validation.valid) {
    throw new Error(`${validation.error}\n\n${validation.setupInstructions}`);
  }

  // 3. Determine model to use
  const model = options.model ?? DEFAULT_OLLAMA_MODEL;

  // 4. Create the provider instance
  const provider = new OllamaProvider({
    model,
    host,
    timeout: options.timeout ?? DEFAULT_OLLAMA_TIMEOUT,
    keepAlive: options.keepAlive,
  });

  // 5. Verify the provider is available (unless skipped)
  if (!options.skipAvailabilityCheck) {
    const isAvailable = await provider.isAvailable();
    if (!isAvailable) {
      throw new Error(
        `Ollama server is not available at ${host}.\n\n` +
          'To fix this:\n' +
          '1. Make sure Ollama is installed (https://ollama.ai/)\n' +
          '2. Start the server: ollama serve\n' +
          `3. Pull the model: ollama pull ${model}\n\n` +
          'Tip: Run `ollama list` to see available models.'
      );
    }
  }

  return {
    provider,
    name: 'ollama',
    model,
    host,
  };
}
