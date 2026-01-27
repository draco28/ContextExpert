/**
 * Search Module
 *
 * Semantic vector search for indexed projects.
 *
 * This module provides the foundation for search functionality:
 * - Load embeddings from SQLite into memory
 * - Build HNSW index for fast approximate search
 * - Query with natural language, get relevant chunks
 *
 * @example
 * ```typescript
 * import { createSearchService } from './search/index.js';
 * import { createEmbeddingProvider } from './indexer/embedder/provider.js';
 *
 * // Create search service for a project
 * const provider = await createEmbeddingProvider(config.embedding);
 * const search = createSearchService(projectId, provider, config.search, {
 *   dimensions: 1024,
 * });
 *
 * // Perform semantic search
 * const results = await search.search('authentication middleware', {
 *   topK: 5,
 *   fileType: 'code',
 * });
 *
 * // Display results
 * for (const result of results) {
 *   console.log(`${result.filePath}:${result.lineRange.start}-${result.lineRange.end}`);
 *   console.log(`  Score: ${result.score.toFixed(3)}`);
 *   console.log(`  ${result.content.slice(0, 100)}...`);
 * }
 * ```
 *
 * @packageDocumentation
 */

// Search service (main entry point)
export { SearchService, createSearchService } from './retriever.js';

// Store management
export {
  VectorStoreManager,
  getVectorStoreManager,
  resetVectorStoreManager,
} from './store.js';

// Types
export type {
  SearchConfig,
  SearchServiceOptions,
  SearchQueryOptions,
  SearchResultWithContext,
  IndexBuildProgress,
} from './types.js';
