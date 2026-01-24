/**
 * Environment Variable Handler
 *
 * Loads and provides secure access to LLM API keys.
 *
 * SECURITY NOTES:
 * - Keys are NEVER logged, even in verbose mode
 * - Keys are NEVER included in error messages
 * - Only key presence/absence and format validity are reported
 */

import { z } from 'zod';

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
  });

  if (!result.success) {
    // Schema validation failed - shouldn't happen with our permissive schema,
    // but handle gracefully by using raw values with defaults
    _envCache = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OLLAMA_HOST: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
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
 * @param provider - The provider to check ('anthropic' or 'openai')
 * @returns true if the key exists and is non-empty
 */
export function hasApiKey(provider: 'anthropic' | 'openai'): boolean {
  const env = loadEnv();
  switch (provider) {
    case 'anthropic':
      return Boolean(env.ANTHROPIC_API_KEY?.trim());
    case 'openai':
      return Boolean(env.OPENAI_API_KEY?.trim());
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
export const SETUP_INSTRUCTIONS: Record<'anthropic' | 'openai' | 'ollama', string> = {
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
};
