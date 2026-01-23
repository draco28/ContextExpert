/**
 * Configuration Schema
 *
 * Defines the shape of ~/.ctx/config.toml using Zod.
 * This provides both TypeScript types AND runtime validation.
 */

import { z } from 'zod';

/**
 * Embedding provider configuration
 * Supports multiple providers: Huggingface (local), Ollama (local), or cloud APIs
 */
export const EmbeddingConfigSchema = z.object({
  provider: z
    .enum(['huggingface', 'ollama', 'openai'])
    .describe('Embedding provider (huggingface for local BGE, ollama for nomic-embed)'),
  model: z.string().describe('Embedding model name'),
  fallback_provider: z
    .enum(['huggingface', 'ollama', 'openai'])
    .optional()
    .describe('Fallback provider if primary fails'),
  fallback_model: z
    .string()
    .optional()
    .describe('Fallback model name'),
});

/**
 * Search configuration
 * Controls how semantic search behaves
 */
export const SearchConfigSchema = z.object({
  top_k: z.number().int().min(1).max(100).describe('Number of results to return'),
  rerank: z.boolean().describe('Whether to rerank results for better relevance'),
});

/**
 * Root configuration schema
 * This is the complete shape of config.toml
 */
export const ConfigSchema = z.object({
  default_model: z.string().describe('Default LLM model for ask command'),
  default_provider: z
    .enum(['anthropic', 'openai', 'ollama'])
    .describe('LLM provider to use'),
  embedding: EmbeddingConfigSchema,
  search: SearchConfigSchema,
});

/**
 * TypeScript type inferred from the schema
 * Use this for type-safe config access throughout the codebase
 */
export type Config = z.infer<typeof ConfigSchema>;

/**
 * Partial config for merging user overrides with defaults
 * Every field becomes optional, allowing sparse config files
 */
export const PartialConfigSchema = ConfigSchema.deepPartial();
export type PartialConfig = z.infer<typeof PartialConfigSchema>;
