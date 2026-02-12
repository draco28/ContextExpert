/**
 * Environment Variable Handler
 *
 * Loads and provides secure access to LLM API keys.
 * Supports .env files for local development via dotenv.
 *
 * SECURITY NOTES:
 * - Keys are NEVER logged, even in verbose mode
 * - Keys are NEVER included in error messages
 * - Only key presence/absence and format validity are reported
 */

import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

// Load .env file (for local development)
// No-op if .env doesn't exist - production uses real env vars
dotenvConfig();

// ============================================================================
// SCHEMA DEFINITIONS
// ============================================================================

/**
 * Environment variable schema with optional values.
 * We don't require keys at load time - validation happens on use.
 * This enables "lazy validation" where only the provider you're
 * actually using needs to have its key configured.
 */
export const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OLLAMA_HOST: z.string().default('http://localhost:11434'),
  // OpenAI-compatible provider (Z.AI, OpenRouter, etc.)
  OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
  OPENAI_COMPATIBLE_BASE_URL: z.string().optional(),
  OPENAI_COMPATIBLE_MODEL: z.string().optional(),
});

export type EnvVars = z.infer<typeof EnvSchema>;

// ============================================================================
// PRIVATE STATE
// ============================================================================

/**
 * Cached environment variables (loaded once at first access).
 * This is intentionally NOT exported - access through getEnv().
 *
 * Why cache?
 * 1. Performance: process.env lookups aren't free
 * 2. Testability: _clearEnvCache() allows test isolation
 * 3. Consistency: Values won't change mid-operation
 */
let _envCache: EnvVars | null = null;

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Load environment variables (called once, then cached).
 * Does NOT validate key presence - that happens when you try to use a provider.
 *
 * @returns The parsed environment variables with defaults applied
 */
export function loadEnv(): EnvVars {
  if (_envCache !== null) {
    return _envCache;
  }

  const result = EnvSchema.safeParse({
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OLLAMA_HOST: process.env.OLLAMA_HOST,
    OPENAI_COMPATIBLE_API_KEY: process.env.OPENAI_COMPATIBLE_API_KEY,
    OPENAI_COMPATIBLE_BASE_URL: process.env.OPENAI_COMPATIBLE_BASE_URL,
    OPENAI_COMPATIBLE_MODEL: process.env.OPENAI_COMPATIBLE_MODEL,
  });

  if (!result.success) {
    // Schema validation failed - shouldn't happen with our permissive schema,
    // but handle gracefully by using raw values with defaults
    _envCache = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OLLAMA_HOST: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
      OPENAI_COMPATIBLE_API_KEY: process.env.OPENAI_COMPATIBLE_API_KEY,
      OPENAI_COMPATIBLE_BASE_URL: process.env.OPENAI_COMPATIBLE_BASE_URL,
      OPENAI_COMPATIBLE_MODEL: process.env.OPENAI_COMPATIBLE_MODEL,
    };
  } else {
    _envCache = result.data;
  }

  return _envCache;
}

/**
 * Get a specific environment variable by key.
 * Use this for type-safe access to env vars.
 *
 * @param key - The environment variable name
 * @returns The value (may be undefined for optional keys)
 */
export function getEnv<K extends keyof EnvVars>(key: K): EnvVars[K] {
  const env = loadEnv();
  return env[key];
}

/**
 * Check if an API key is configured (non-empty).
 * Returns true/false WITHOUT exposing the key value.
 *
 * This is the security-safe way to check key presence in conditionals
 * and error messages.
 *
 * @param provider - The provider to check ('anthropic', 'openai', or 'openai-compatible')
 * @returns true if the key exists and is non-empty
 */
export function hasApiKey(provider: 'anthropic' | 'openai' | 'openai-compatible'): boolean {
  const env = loadEnv();
  switch (provider) {
    case 'anthropic':
      return Boolean(env.ANTHROPIC_API_KEY?.trim());
    case 'openai':
      return Boolean(env.OPENAI_API_KEY?.trim());
    case 'openai-compatible':
      return Boolean(env.OPENAI_COMPATIBLE_API_KEY?.trim());
  }
}

/**
 * Get the Ollama host URL.
 * Returns the default (localhost:11434) if not configured.
 *
 * @returns The Ollama host URL
 */
export function getOllamaHost(): string {
  return getEnv('OLLAMA_HOST');
}

/**
 * Get OpenAI-compatible provider configuration.
 * Used for Z.AI, OpenRouter, and other OpenAI-compatible APIs.
 *
 * @returns Object with apiKey, baseUrl, and model (all optional)
 */
export function getOpenAICompatibleConfig(): {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  model: string | undefined;
} {
  const env = loadEnv();
  return {
    apiKey: env.OPENAI_COMPATIBLE_API_KEY,
    baseUrl: env.OPENAI_COMPATIBLE_BASE_URL,
    model: env.OPENAI_COMPATIBLE_MODEL,
  };
}

/**
 * Check if OpenAI-compatible provider is fully configured.
 * Requires API key and base URL at minimum.
 *
 * @returns true if ready to use
 */
export function isOpenAICompatibleConfigured(): boolean {
  const config = getOpenAICompatibleConfig();
  return Boolean(config.apiKey?.trim() && config.baseUrl?.trim());
}

/**
 * Clear the environment cache.
 * FOR TESTING ONLY - allows tests to mock different env values.
 *
 * @internal
 */
export function _clearEnvCache(): void {
  _envCache = null;
}

// ============================================================================
// SETUP INSTRUCTIONS
// ============================================================================

/**
 * Provider-specific setup instructions.
 * Shown when a required API key is missing.
 *
 * These are designed to be user-friendly and actionable:
 * - Where to get the key
 * - Exact commands to run
 * - Platform-specific instructions
 */
export const SETUP_INSTRUCTIONS: Record<'anthropic' | 'openai' | 'ollama' | 'openai-compatible', string> = {
  anthropic: `
To use Anthropic (Claude) models:

1. Get your API key from https://console.anthropic.com/
2. Set the environment variable:

   # macOS/Linux (add to ~/.bashrc or ~/.zshrc)
   export ANTHROPIC_API_KEY="sk-ant-..."

   # Windows (PowerShell)
   $env:ANTHROPIC_API_KEY="sk-ant-..."

3. Restart your terminal or run: source ~/.bashrc
`.trim(),

  openai: `
To use OpenAI models:

1. Get your API key from https://platform.openai.com/api-keys
2. Set the environment variable:

   # macOS/Linux (add to ~/.bashrc or ~/.zshrc)
   export OPENAI_API_KEY="sk-..."

   # Windows (PowerShell)
   $env:OPENAI_API_KEY="sk-..."

3. Restart your terminal or run: source ~/.bashrc
`.trim(),

  ollama: `
To use Ollama (local models):

1. Install Ollama from https://ollama.ai/
2. Start the Ollama server:

   ollama serve

3. Pull a model:

   ollama pull llama2

4. (Optional) Set custom host:

   export OLLAMA_HOST="http://localhost:11434"
`.trim(),

  'openai-compatible': `
To use an OpenAI-compatible provider (Z.AI, OpenRouter, etc.):

1. Create a .env file in the project root (copy from .env.example)

2. Set the environment variables:

   OPENAI_COMPATIBLE_API_KEY="your-api-key"
   OPENAI_COMPATIBLE_BASE_URL="https://api.example.com/v1"
   OPENAI_COMPATIBLE_MODEL="model-name"

3. Example for Z.AI:

   OPENAI_COMPATIBLE_API_KEY="your-zai-key"
   OPENAI_COMPATIBLE_BASE_URL="https://api.z.ai/api/coding/paas/v4"
   OPENAI_COMPATIBLE_MODEL="GLM-5"

4. Restart your terminal or rebuild the project
`.trim(),
};
