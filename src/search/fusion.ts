/**
 * Fusion Service - Reciprocal Rank Fusion (RRF)
 *
 * Combines results from dense vector search and BM25 keyword search
 * using RRF, which uses rank positions rather than raw scores.
 *
 * RRF Formula: score(d) = Σ 1/(k + rank(d))
 *
 * Why RRF?
 * - Dense search scores: 0-1 (cosine similarity)
 * - BM25 scores: unbounded (relative ranking)
 * - RRF normalizes by using rank position, making them comparable
 *
 * Reference: Cormack, Clarke & Büttcher (2009)
 * "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods"
 */

import type { EmbeddingProvider } from '@contextaisdk/rag';

import { SearchService, createSearchService } from './retriever.js';
import { BM25SearchService, createBM25SearchService } from './bm25-retriever.js';
import type {
  SearchResultWithContext,
  SearchQueryOptions,
  FusionConfig,
  FusionServiceOptions,
  SearchConfig,
  IndexBuildProgress,
} from './types.js';

/**
 * Default RRF constant (k=60).
 *
 * This value comes from the original RRF paper and has been
 * empirically validated across many retrieval benchmarks.
 * It provides a good balance between:
 * - Not over-weighting top-ranked items (too low k)
 * - Not under-weighting rank differences (too high k)
 */
export const DEFAULT_RRF_K = 60;

/**
 * Compute Reciprocal Rank Fusion scores for two ranked result lists.
 *
 * This is a pure function - it takes ranked lists and returns a fused list.
 * No side effects, easy to test, easy to reason about.
 *
 * @param denseResults - Results from dense/vector search (already sorted by score desc)
 * @param bm25Results - Results from BM25/keyword search (already sorted by score desc)
 * @param config - RRF configuration (k constant, optional weights)
 * @returns Fused results sorted by RRF score descending
 *
 * @example
 * ```typescript
 * const fused = computeRRF(denseResults, bm25Results, { k: 60 });
 * // fused is sorted by combined RRF score
 * ```
 */
export function computeRRF(
  denseResults: SearchResultWithContext[],
  bm25Results: SearchResultWithContext[],
  config: FusionConfig
): SearchResultWithContext[] {
  const { k, weights } = config;
  const denseWeight = weights?.dense ?? 1.0;
  const bm25Weight = weights?.bm25 ?? 1.0;

  // Map from document ID to { rrfScore, result }
  // We keep the first occurrence's metadata (arbitrary but deterministic)
  const scoreMap = new Map<
    string,
    { rrfScore: number; result: SearchResultWithContext }
  >();

  // Process dense results
  // rank is 1-based: first item is rank 1, second is rank 2, etc.
  denseResults.forEach((result, index) => {
    const rank = index + 1; // Convert 0-based index to 1-based rank
    const rrfScore = denseWeight / (k + rank);

    const existing = scoreMap.get(result.id);
    if (existing) {
      // Document already seen in BM25 results - add to score
      existing.rrfScore += rrfScore;
    } else {
      // First occurrence - store result with initial score
      scoreMap.set(result.id, {
        rrfScore,
        result, // Keep this result's metadata
      });
    }
  });

  // Process BM25 results
  bm25Results.forEach((result, index) => {
    const rank = index + 1;
    const rrfScore = bm25Weight / (k + rank);

    const existing = scoreMap.get(result.id);
    if (existing) {
      // Document already seen in dense results - add to score
      existing.rrfScore += rrfScore;
    } else {
      // First occurrence - store result with initial score
      scoreMap.set(result.id, {
        rrfScore,
        result, // Keep this result's metadata
      });
    }
  });

  // Convert map to array and sort by RRF score descending
  const fusedResults = Array.from(scoreMap.values())
    .map(({ rrfScore, result }) => ({
      ...result,
      score: rrfScore, // Replace original score with RRF score
    }))
    .sort((a, b) => b.score - a.score);

  return fusedResults;
}

/**
 * FusionService - Hybrid search combining dense and sparse retrieval.
 *
 * Wraps SearchService (dense) and BM25SearchService (sparse) to provide
 * a unified search interface with RRF-based result fusion.
 *
 * Both underlying services are lazily initialized on first search.
 */
export class FusionService {
  private readonly projectId: string;
  private readonly fusionConfig: FusionConfig;
  private readonly denseService: SearchService;
  private readonly bm25Service: BM25SearchService;
  private initialized = false;

  constructor(
    projectId: string,
    embeddingProvider: EmbeddingProvider,
    searchConfig: SearchConfig,
    options: FusionServiceOptions = { projectId }
  ) {
    this.projectId = projectId;
    this.fusionConfig = {
      k: options.fusionConfig?.k ?? DEFAULT_RRF_K,
      weights: options.fusionConfig?.weights,
    };

    // Create underlying services
    // Dense service needs dimensions - default to 1024 (BGE-large)
    this.denseService = createSearchService(projectId, embeddingProvider, searchConfig, {
      dimensions: options.denseOptions?.dimensions ?? 1024,
      useHNSW: options.denseOptions?.useHNSW,
      hnswConfig: options.denseOptions?.hnswConfig,
    });

    this.bm25Service = createBM25SearchService(projectId, searchConfig, {
      bm25Config: options.bm25Options?.bm25Config,
    });
  }

  /**
   * Perform hybrid search combining dense and BM25 results via RRF.
   *
   * @param query - Search query text
   * @param options - Search options (topK, minScore, fileType, language)
   * @returns Fused results sorted by RRF score descending
   */
  async search(
    query: string,
    options?: SearchQueryOptions
  ): Promise<SearchResultWithContext[]> {
    // Ensure both services are initialized
    await this.ensureInitialized();

    // Run both searches in parallel for performance
    const [denseResults, bm25Results] = await Promise.all([
      this.denseService.search(query, options),
      this.bm25Service.search(query, options),
    ]);

    // Fuse results using RRF
    let fusedResults = computeRRF(denseResults, bm25Results, this.fusionConfig);

    // Apply post-fusion filters
    if (options?.minScore !== undefined) {
      fusedResults = fusedResults.filter((r) => r.score >= options.minScore!);
    }

    if (options?.topK !== undefined) {
      fusedResults = fusedResults.slice(0, options.topK);
    }

    return fusedResults;
  }

  /**
   * Initialize both underlying search services.
   *
   * Called automatically on first search, but can be called explicitly
   * to control when the loading happens (e.g., with progress reporting).
   *
   * @param onProgress - Optional callback for progress updates
   */
  async ensureInitialized(
    onProgress?: (progress: IndexBuildProgress) => void
  ): Promise<void> {
    if (this.initialized) return;

    // Initialize both services in parallel
    await Promise.all([
      this.denseService.ensureInitialized(onProgress),
      this.bm25Service.ensureInitialized(onProgress),
    ]);

    this.initialized = true;
  }

  /**
   * Check if both services are initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the project ID this service is scoped to.
   */
  getProjectId(): string {
    return this.projectId;
  }

  /**
   * Get chunk counts from both underlying services.
   */
  async getChunkCounts(): Promise<{ dense: number; bm25: number }> {
    const [dense, bm25] = await Promise.all([
      this.denseService.getChunkCount(),
      this.bm25Service.getChunkCount(),
    ]);
    return { dense, bm25 };
  }
}

/**
 * Factory function to create a FusionService.
 *
 * Follows the same pattern as createSearchService and createBM25SearchService.
 *
 * @param projectId - Project ID to scope searches
 * @param embeddingProvider - Provider for generating query embeddings (dense search)
 * @param searchConfig - Search configuration
 * @param options - Optional fusion-specific configuration
 * @returns Configured FusionService instance
 *
 * @example
 * ```typescript
 * const provider = await createEmbeddingProvider(config.embedding);
 * const service = createFusionService('my-project', provider, config.search, {
 *   fusionConfig: { k: 60, weights: { dense: 1.0, bm25: 1.0 } }
 * });
 *
 * const results = await service.search('authentication flow');
 * ```
 */
export function createFusionService(
  projectId: string,
  embeddingProvider: EmbeddingProvider,
  searchConfig: SearchConfig = { top_k: 10, rerank: false },
  options?: Partial<Omit<FusionServiceOptions, 'projectId'>>
): FusionService {
  return new FusionService(projectId, embeddingProvider, searchConfig, {
    projectId,
    ...options,
  });
}
