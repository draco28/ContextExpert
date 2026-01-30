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
  // IMPORTANT: Both primary and fallback must have matching dimensions (1024)
  embedding: {
    provider: 'huggingface',
    model: 'BAAI/bge-large-en-v1.5',      // 1024 dimensions
    fallback_provider: 'ollama',
    fallback_model: 'mxbai-embed-large',  // 1024 dimensions (matches primary)
    batch_size: 32,       // Texts per embedding batch (balance of speed vs memory)
    timeout_ms: 120000,   // 2 minutes - allows time for model loading on first run
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
# Fallback: mxbai-embed-large via Ollama (if Huggingface unavailable)
# IMPORTANT: Both must have matching dimensions (1024) to avoid data corruption
[embedding]
provider = "${DEFAULT_CONFIG.embedding.provider}"
model = "${DEFAULT_CONFIG.embedding.model}"
fallback_provider = "${DEFAULT_CONFIG.embedding.fallback_provider}"
fallback_model = "${DEFAULT_CONFIG.embedding.fallback_model}"
batch_size = ${DEFAULT_CONFIG.embedding.batch_size}
timeout_ms = ${DEFAULT_CONFIG.embedding.timeout_ms}  # 2 minutes (allows for model download)

# Search Settings
[search]
top_k = ${DEFAULT_CONFIG.search.top_k}
rerank = ${DEFAULT_CONFIG.search.rerank}
`;
