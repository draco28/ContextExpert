/**
 * Default Configuration Values
 *
 * These are used when:
 * 1. No config.toml exists (first run)
 * 2. User's config.toml is missing certain fields
 *
 * The loader merges user config ON TOP of these defaults.
 */

import type { Config } from './schema.js';

/**
 * Default configuration
 * Optimized for local-first usage with fallbacks
 */
export const DEFAULT_CONFIG: Config = {
  // LLM settings - Claude as default for quality
  default_model: 'claude-sonnet-4-20250514',
  default_provider: 'anthropic',

  // Embedding settings - BGE-large via Huggingface (local, no API cost)
  // with Ollama fallback if Huggingface isn't available
  embedding: {
    provider: 'huggingface',
    model: 'BAAI/bge-large-en-v1.5',
    fallback_provider: 'ollama',
    fallback_model: 'nomic-embed-text',
    batch_size: 32, // Texts per embedding batch (balance of speed vs memory)
  },

  // Search settings - sensible defaults
  search: {
    top_k: 10,      // Return top 10 results
    rerank: true,   // Reranking improves relevance significantly
  },
};

/**
 * Config file template (TOML format)
 * Written to ~/.ctx/config.toml on first run
 */
export const CONFIG_TEMPLATE = `# Context Expert Configuration
# Location: ~/.ctx/config.toml

# LLM Settings
default_model = "${DEFAULT_CONFIG.default_model}"
default_provider = "${DEFAULT_CONFIG.default_provider}"

# Embedding Settings
# Primary: BGE-large via Huggingface (runs locally, no API cost)
# Fallback: nomic-embed via Ollama (if Huggingface unavailable)
[embedding]
provider = "${DEFAULT_CONFIG.embedding.provider}"
model = "${DEFAULT_CONFIG.embedding.model}"
fallback_provider = "${DEFAULT_CONFIG.embedding.fallback_provider}"
fallback_model = "${DEFAULT_CONFIG.embedding.fallback_model}"
batch_size = ${DEFAULT_CONFIG.embedding.batch_size}

# Search Settings
[search]
top_k = ${DEFAULT_CONFIG.search.top_k}
rerank = ${DEFAULT_CONFIG.search.rerank}
`;
