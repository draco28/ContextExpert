/**
 * Embedding Provider Factory
 *
 * Creates embedding providers from configuration. Supports:
 * - HuggingFace (local inference with Xenova/transformers.js)
 * - Ollama (local server at localhost:11434)
 * - Automatic fallback if primary provider unavailable
 * - Caching wrapper for efficiency
 *
 * The factory pattern lets us:
 * 1. Read provider type from config.toml
 * 2. Instantiate the right SDK class
 * 3. Handle fallback logic transparently
 * 4. Wrap with caching for duplicate text deduplication
 */

import {
  HuggingFaceEmbeddingProvider,
  OllamaEmbeddingProvider,
  CachedEmbeddingProvider,
  type EmbeddingProvider,
} from '@contextaisdk/rag';

import type {
  EmbeddingConfig,
  ProviderOptions,
  EmbeddingProviderResult,
} from './types.js';

/**
 * Model name mapping for different providers.
 *
 * HuggingFace uses "Xenova/" prefix for transformers.js compatibility.
 * The BAAI/bge-large-en-v1.5 model becomes Xenova/bge-large-en-v1.5.
 */
function normalizeHuggingFaceModel(model: string): string {
  // If user specified BAAI/bge-large-en-v1.5, convert to Xenova/bge-large-en-v1.5
  if (model.startsWith('BAAI/')) {
    return model.replace('BAAI/', 'Xenova/');
  }
  // If already has Xenova prefix or is a different format, use as-is
  return model;
}

/**
 * Create a HuggingFace embedding provider.
 *
 * Uses transformers.js (Xenova) for local inference - no API costs!
 * First run downloads the model (~1.3GB for BGE-large) to ~/.cache/huggingface.
 */
async function createHuggingFaceProvider(
  model: string,
  options?: ProviderOptions
): Promise<HuggingFaceEmbeddingProvider> {
  const normalizedModel = normalizeHuggingFaceModel(model);

  const provider = new HuggingFaceEmbeddingProvider({
    model: normalizedModel,
    // BGE-large produces 1024-dimensional embeddings
    // This is auto-detected by the SDK but we can specify for clarity
    normalize: true, // L2 normalize for cosine similarity
    onProgress: options?.onProgress
      ? (progress: { status: string; progress?: number }) => {
          options.onProgress!({
            status: progress.status,
            progress: progress.progress,
          });
        }
      : undefined,
  });

  return provider;
}

/**
 * Create an Ollama embedding provider.
 *
 * Requires Ollama server running at localhost:11434.
 * Default model is nomic-embed-text (768 dimensions).
 */
async function createOllamaProvider(
  model: string
): Promise<OllamaEmbeddingProvider> {
  const provider = new OllamaEmbeddingProvider({
    model,
    // Default baseUrl is http://localhost:11434
    normalize: true,
  });

  return provider;
}

/**
 * Check if a provider is available/ready to use.
 *
 * - HuggingFace: Always available (downloads model if needed)
 * - Ollama: Checks if server is running and model exists
 */
async function isProviderAvailable(
  provider: EmbeddingProvider
): Promise<boolean> {
  try {
    return await provider.isAvailable();
  } catch {
    return false;
  }
}

/**
 * Create an embedding provider from configuration.
 *
 * This is the main entry point for the embedding system.
 * It reads your config.toml settings and creates the appropriate provider.
 *
 * Returns both the provider and metadata about which model was used
 * and its dimensions - this is needed for database tracking.
 *
 * @example
 * ```typescript
 * import { loadConfig } from '../config';
 * import { createEmbeddingProvider } from './embedder';
 *
 * const config = await loadConfig();
 * const { provider, model, dimensions } = await createEmbeddingProvider(config.embedding);
 *
 * const result = await provider.embed("Hello, world!");
 * console.log(result.embedding.length); // 1024 for BGE-large
 * console.log(dimensions); // 1024
 * ```
 *
 * @param config - Embedding configuration from config.toml
 * @param options - Optional callbacks for progress reporting
 * @returns Object with provider, model name used, and dimensions
 * @throws Error if neither primary nor fallback provider is available
 * @throws Error if fallback model has different dimensions than primary
 */
export async function createEmbeddingProvider(
  config: EmbeddingConfig,
  options?: ProviderOptions
): Promise<EmbeddingProviderResult> {
  let provider: EmbeddingProvider | null = null;
  let providerName: string = config.provider;
  let actualModel: string = config.model;

  // Validate dimension consistency upfront if fallback is configured
  if (config.fallback_provider && config.fallback_model) {
    const primaryDims = getModelDimensions(config.model);
    const fallbackDims = getModelDimensions(config.fallback_model);

    if (primaryDims !== fallbackDims) {
      throw new Error(
        `Embedding dimension mismatch: primary model '${config.model}' has ${primaryDims} dimensions, ` +
        `but fallback model '${config.fallback_model}' has ${fallbackDims} dimensions. ` +
        `Both models must have matching dimensions. Update your ~/.ctx/config.toml.`
      );
    }
  }

  // Try primary provider
  try {
    if (config.provider === 'huggingface') {
      provider = await createHuggingFaceProvider(config.model, options);
    } else if (config.provider === 'ollama') {
      provider = await createOllamaProvider(config.model);
    } else if (config.provider === 'openai') {
      // OpenAI support is future work - not implemented yet
      throw new Error('OpenAI embedding provider not yet implemented');
    }

    // Verify provider is available
    if (provider && (await isProviderAvailable(provider))) {
      // Wrap with caching for efficiency
      // CachedEmbeddingProvider deduplicates identical text inputs
      return {
        provider: new CachedEmbeddingProvider({ provider }),
        model: actualModel,
        dimensions: getModelDimensions(actualModel),
      };
    }
  } catch (error) {
    // Primary provider failed, will try fallback
    const message = error instanceof Error ? error.message : String(error);
    options?.onProgress?.({
      status: `Primary provider (${config.provider}) unavailable: ${message}. Trying fallback...`,
    });
  }

  // Try fallback provider if configured
  if (config.fallback_provider && config.fallback_model) {
    providerName = config.fallback_provider;
    actualModel = config.fallback_model;

    try {
      if (config.fallback_provider === 'huggingface') {
        provider = await createHuggingFaceProvider(config.fallback_model, options);
      } else if (config.fallback_provider === 'ollama') {
        provider = await createOllamaProvider(config.fallback_model);
      }

      if (provider && (await isProviderAvailable(provider))) {
        options?.onProgress?.({
          status: `Using fallback provider: ${config.fallback_provider}`,
        });
        return {
          provider: new CachedEmbeddingProvider({ provider }),
          model: actualModel,
          dimensions: getModelDimensions(actualModel),
        };
      }
    } catch (error) {
      // Fallback also failed
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Both primary (${config.provider}) and fallback (${config.fallback_provider}) ` +
        `embedding providers failed. Last error: ${message}`
      );
    }
  }

  // No provider available
  throw new Error(
    `Embedding provider '${providerName}' is not available. ` +
    (config.provider === 'ollama'
      ? 'Make sure Ollama is running (ollama serve) and the model is pulled.'
      : 'Check your internet connection for initial model download.')
  );
}

/**
 * Get the expected embedding dimensions for a model.
 *
 * Useful for pre-allocating arrays or validating results.
 */
export function getModelDimensions(model: string): number {
  const normalizedModel = model.toLowerCase();

  // BGE models (various sizes)
  if (normalizedModel.includes('bge-large')) return 1024;
  if (normalizedModel.includes('bge-base')) return 768;
  if (normalizedModel.includes('bge-small')) return 384;

  // Ollama models
  if (normalizedModel.includes('nomic-embed')) return 768;
  if (normalizedModel.includes('mxbai-embed')) return 1024;

  // OpenAI models (future)
  if (normalizedModel.includes('text-embedding-3-large')) return 3072;
  if (normalizedModel.includes('text-embedding-3-small')) return 1536;
  if (normalizedModel.includes('text-embedding-ada')) return 1536;

  // Default fallback
  return 1024;
}
