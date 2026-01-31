/**
 * Provider Configuration Storage
 *
 * Manages ~/.ctx/providers.json for persistent LLM provider configs.
 * Supports:
 * - anthropic: Claude models via Anthropic API
 * - openai: GPT models via OpenAI API
 * - openai-compatible: Custom OpenAI-compatible APIs (e.g., Z.AI, OpenRouter)
 *
 * SECURITY NOTE:
 * API keys are stored in plaintext in the JSON file. This is acceptable for
 * a local CLI tool (similar to .npmrc tokens). File permissions should be
 * user-readable only (0600).
 */

import { z } from 'zod';
import * as fs from 'node:fs';
import { getProvidersPath, getCtxDir } from './paths.js';

// ============================================================================
// SCHEMAS
// ============================================================================

/**
 * Anthropic provider configuration.
 * Uses the standard Anthropic API endpoint.
 */
const AnthropicProviderConfigSchema = z.object({
  type: z.literal('anthropic'),
  model: z.string().describe('Model identifier (e.g., claude-sonnet-4-20250514)'),
  apiKey: z.string().describe('Anthropic API key'),
});

/**
 * OpenAI provider configuration.
 * Uses the standard OpenAI API endpoint.
 */
const OpenAIProviderConfigSchema = z.object({
  type: z.literal('openai'),
  model: z.string().describe('Model identifier (e.g., gpt-4o)'),
  apiKey: z.string().describe('OpenAI API key'),
});

/**
 * OpenAI-compatible provider configuration.
 * For custom APIs that implement the OpenAI chat completions format.
 * Examples: Z.AI, OpenRouter, Azure OpenAI, local proxies.
 */
const OpenAICompatibleProviderConfigSchema = z.object({
  type: z.literal('openai-compatible'),
  model: z.string().describe('Model identifier'),
  baseURL: z.string().url().describe('API base URL'),
  apiKey: z.string().describe('API key for the provider'),
});

/**
 * Union of all provider config types.
 * Uses discriminated union on the `type` field for type-safe parsing.
 */
export const ProviderConfigSchema = z.discriminatedUnion('type', [
  AnthropicProviderConfigSchema,
  OpenAIProviderConfigSchema,
  OpenAICompatibleProviderConfigSchema,
]);

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/** Provider type identifier */
export type ConfiguredProviderType = ProviderConfig['type'];

/**
 * Root schema for providers.json file.
 */
export const ProvidersFileSchema = z.object({
  /** Name of the default provider (null if none configured) */
  default: z.string().nullable(),
  /** Map of provider name to configuration */
  providers: z.record(z.string(), ProviderConfigSchema),
});

export type ProvidersFile = z.infer<typeof ProvidersFileSchema>;

// ============================================================================
// FILE I/O
// ============================================================================

/**
 * Load providers from ~/.ctx/providers.json.
 * Returns empty config if file doesn't exist or is corrupted.
 */
export function loadProviders(): ProvidersFile {
  const path = getProvidersPath();

  if (!fs.existsSync(path)) {
    return { default: null, providers: {} };
  }

  try {
    const content = fs.readFileSync(path, 'utf-8');
    const parsed = JSON.parse(content);
    return ProvidersFileSchema.parse(parsed);
  } catch {
    // Return empty if file is corrupted or invalid
    // The caller can warn the user if needed
    return { default: null, providers: {} };
  }
}

/**
 * Save providers to ~/.ctx/providers.json.
 * Creates the ~/.ctx directory if it doesn't exist.
 * Sets file permissions to 0600 (user-readable only) for security.
 */
export function saveProviders(data: ProvidersFile): void {
  const path = getProvidersPath();
  const ctxDir = getCtxDir();

  // Ensure directory exists
  if (!fs.existsSync(ctxDir)) {
    fs.mkdirSync(ctxDir, { recursive: true, mode: 0o700 });
  }

  // Write file with restricted permissions (user-readable only)
  fs.writeFileSync(path, JSON.stringify(data, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

// ============================================================================
// CRUD OPERATIONS
// ============================================================================

/**
 * Add a new provider configuration.
 * If this is the first provider, it automatically becomes the default.
 *
 * @param name - Unique name for this provider (e.g., "z-ai", "work-claude")
 * @param config - Provider configuration
 * @throws Error if a provider with this name already exists
 */
export function addProvider(name: string, config: ProviderConfig): void {
  const data = loadProviders();

  if (data.providers[name]) {
    throw new Error(
      `Provider "${name}" already exists. Use a different name or remove it first.`
    );
  }

  data.providers[name] = config;

  // First provider becomes default automatically
  if (data.default === null) {
    data.default = name;
  }

  saveProviders(data);
}

/**
 * Remove a provider configuration.
 * If removing the default, the first remaining provider becomes the new default.
 *
 * @param name - Name of the provider to remove
 * @throws Error if provider doesn't exist
 */
export function removeProvider(name: string): void {
  const data = loadProviders();

  if (!data.providers[name]) {
    throw new Error(`Provider "${name}" not found`);
  }

  delete data.providers[name];

  // If we removed the default, pick the first remaining or null
  if (data.default === name) {
    const remaining = Object.keys(data.providers);
    data.default = remaining.length > 0 ? remaining[0]! : null;
  }

  saveProviders(data);
}

/**
 * Set the default provider.
 * The default provider is used automatically when starting chat.
 *
 * @param name - Name of the provider to set as default
 * @throws Error if provider doesn't exist
 */
export function setDefaultProvider(name: string): void {
  const data = loadProviders();

  if (!data.providers[name]) {
    throw new Error(`Provider "${name}" not found`);
  }

  data.default = name;
  saveProviders(data);
}

/**
 * Get a specific provider configuration by name.
 *
 * @param name - Name of the provider
 * @returns Provider config or undefined if not found
 */
export function getProvider(name: string): ProviderConfig | undefined {
  const data = loadProviders();
  return data.providers[name];
}

/**
 * Get the default provider configuration.
 *
 * @returns Object with name and config, or null if no default is set
 */
export function getDefaultProvider(): { name: string; config: ProviderConfig } | null {
  const data = loadProviders();

  if (!data.default) {
    return null;
  }

  const config = data.providers[data.default];
  if (!config) {
    return null;
  }

  return { name: data.default, config };
}

/**
 * List all configured providers.
 *
 * @returns Array of providers with their configs and default status
 */
export function listProviders(): Array<{
  name: string;
  config: ProviderConfig;
  isDefault: boolean;
}> {
  const data = loadProviders();

  return Object.entries(data.providers).map(([name, config]) => ({
    name,
    config,
    isDefault: name === data.default,
  }));
}

/**
 * Check if any providers are configured.
 */
export function hasProviders(): boolean {
  const data = loadProviders();
  return Object.keys(data.providers).length > 0;
}
