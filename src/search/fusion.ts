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
import {
  reciprocalRankFusion,
  DEFAULT_RRF_K,
  type RankingList,
} from '@contextaisdk/rag';

import { SearchService, createSearchService } from './retriever.js';
import { BM25SearchService, createBM25SearchService } from './bm25-retriever.js';
import { RerankerService } from './reranker.js';
import type {
  SearchResultWithContext,
  SearchQueryOptions,
  FusionConfig,
  FusionServiceOptions,
  SearchConfig,
  IndexBuildProgress,
  SearchServiceOptions,
  RerankConfig,
} from './types.js';

// Re-export DEFAULT_RRF_K from SDK for convenience
export { DEFAULT_RRF_K };

/**
 * Compute Reciprocal Rank Fusion scores for two ranked result lists.
 *
 * Uses the ContextAI SDK's reciprocalRankFusion() internally, with a wrapper
 * to handle our SearchResultWithContext format and custom weights.
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

  // Build a lookup map to preserve full SearchResultWithContext metadata
  // (SDK's RRFResult only has chunk data, not our full context)
  const resultLookup = new Map<string, SearchResultWithContext>();
  for (const result of denseResults) {
    resultLookup.set(result.id, result);
  }
  for (const result of bm25Results) {
    // Only add if not already present (dense takes priority for metadata)
    if (!resultLookup.has(result.id)) {
      resultLookup.set(result.id, result);
    }
  }

  // Convert to SDK's RankingList format
  const rankings: RankingList[] = [
    {
      name: 'dense',
      items: denseResults.map((r, i) => ({
        id: r.id,
        rank: i + 1, // 1-indexed
        score: r.score,
        chunk: { id: r.id, content: r.content, metadata: r.metadata },
      })),
    },
    {
      name: 'bm25',
      items: bm25Results.map((r, i) => ({
        id: r.id,
        rank: i + 1,
        score: r.score,
        chunk: { id: r.id, content: r.content, metadata: r.metadata },
      })),
    },
  ];

  // Call SDK's RRF implementation
  const rrfResults = reciprocalRankFusion(rankings, k);

  // Convert back to SearchResultWithContext and apply custom weights
  const fusedResults: SearchResultWithContext[] = rrfResults.map((rrf) => {
    const original = resultLookup.get(rrf.id)!;

    // Apply custom weights by adjusting contributions
    let adjustedScore = rrf.score;
    if (denseWeight !== 1.0 || bm25Weight !== 1.0) {
      // Recalculate score with weights applied to each contribution
      adjustedScore = 0;
      for (const contrib of rrf.contributions) {
        const weight = contrib.name === 'dense' ? denseWeight : bm25Weight;
        adjustedScore += contrib.contribution * weight;
      }
    }

    return {
      ...original,
      score: adjustedScore,
    };
  });

  // Re-sort if weights changed the order
  if (denseWeight !== 1.0 || bm25Weight !== 1.0) {
    fusedResults.sort((a, b) => b.score - a.score);
  }

  return fusedResults;
}

/**
 * FusionService - Hybrid search combining dense and sparse retrieval.
 *
 * Wraps SearchService (dense) and BM25SearchService (sparse) to provide
 * a unified search interface with RRF-based result fusion.
 *
 * Optionally applies BGE cross-encoder reranking after fusion for
 * improved precision (enabled via searchConfig.rerank).
 *
 * Pipeline: Query → Dense + BM25 → RRF Fusion → [Optional Rerank] → Results
 *
 * Both underlying services are lazily initialized on first search.
 */
export class FusionService {
  private readonly projectId: string;
  private readonly fusionConfig: FusionConfig;
  private readonly denseService: SearchService;
  private readonly bm25Service: BM25SearchService;
  private readonly rerankerService: RerankerService | null = null;
  private readonly shouldRerank: boolean;
  private initialized = false;

  constructor(
    projectId: string,
    embeddingProvider: EmbeddingProvider,
    searchConfig: SearchConfig,
    options: FusionServiceOptions,
    rerankConfig?: RerankConfig
  ) {
    // Validate dimensions - required, no silent fallbacks
    const dimensions = options.denseOptions?.dimensions;
    if (!dimensions || dimensions <= 0) {
      throw new Error(
        `FusionService requires dimensions in denseOptions. ` +
        `Pass { denseOptions: { dimensions: <number> } } matching your indexed embedding model. ` +
        `Use createEmbeddingProvider() to get the correct dimensions.`
      );
    }

    this.projectId = projectId;
    this.fusionConfig = {
      k: options.fusionConfig?.k ?? DEFAULT_RRF_K,
      weights: options.fusionConfig?.weights,
    };

    // Configure reranking - only create service if enabled
    this.shouldRerank = searchConfig.rerank;
    if (this.shouldRerank) {
      this.rerankerService = new RerankerService(rerankConfig);
    }

    // Create underlying services with validated dimensions
    this.denseService = createSearchService(projectId, embeddingProvider, searchConfig, {
      dimensions,
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
   * If reranking is enabled, fused results are passed through the BGE
   * cross-encoder reranker for improved precision before applying filters.
   *
   * @param query - Search query text
   * @param options - Search options (topK, minScore, fileType, language)
   * @returns Fused (and optionally reranked) results sorted by score descending
   */
  async search(
    query: string,
    options?: SearchQueryOptions
  ): Promise<SearchResultWithContext[]> {
    // Ensure all services are initialized (including reranker warmup)
    await this.ensureInitialized();

    // Run both searches in parallel for performance
    const [denseResults, bm25Results] = await Promise.all([
      this.denseService.search(query, options),
      this.bm25Service.search(query, options),
    ]);

    // Fuse results using RRF
    let fusedResults = computeRRF(denseResults, bm25Results, this.fusionConfig);

    // Apply reranking if enabled
    // Reranker takes top N candidates (default 50) and returns top K after reranking
    if (this.shouldRerank && this.rerankerService) {
      const topK = options?.topK ?? 10;
      fusedResults = await this.rerankerService.rerank(query, fusedResults, topK);
    }

    // Apply post-fusion/post-rerank filters
    if (options?.minScore !== undefined) {
      fusedResults = fusedResults.filter((r) => r.score >= options.minScore!);
    }

    // Apply topK limit (reranker already limits if enabled, but this handles non-reranked case)
    if (options?.topK !== undefined && !this.shouldRerank) {
      fusedResults = fusedResults.slice(0, options.topK);
    }

    return fusedResults;
  }

  /**
   * Initialize all underlying services.
   *
   * Called automatically on first search, but can be called explicitly
   * to control when the loading happens (e.g., with progress reporting).
   *
   * If reranking is enabled, the BGE model is warmed up in parallel with
   * the dense and BM25 index loading, hiding the model load latency.
   *
   * @param onProgress - Optional callback for progress updates
   */
  async ensureInitialized(
    onProgress?: (progress: IndexBuildProgress) => void
  ): Promise<void> {
    if (this.initialized) return;

    // Build list of initialization promises
    const initPromises: Promise<void>[] = [
      this.denseService.ensureInitialized(onProgress),
      this.bm25Service.ensureInitialized(onProgress),
    ];

    // Warmup reranker in parallel if enabled
    // This hides the ~2-3 second model load time behind index loading
    if (this.rerankerService) {
      initPromises.push(this.rerankerService.warmup());
    }

    await Promise.all(initPromises);
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
 * @param searchConfig - Search configuration (includes rerank flag)
 * @param options - Required options including denseOptions.dimensions
 * @returns Configured FusionService instance
 * @throws Error if dimensions is not provided in denseOptions
 *
 * @example
 * ```typescript
 * const { provider, dimensions } = await createEmbeddingProvider(config.embedding);
 *
 * // Without reranking
 * const service = createFusionService('my-project', provider, config.search, {
 *   denseOptions: { dimensions },
 * });
 *
 * // With reranking enabled (searchConfig.rerank = true)
 * const serviceWithRerank = createFusionService('my-project', provider,
 *   { ...config.search, rerank: true },
 *   { denseOptions: { dimensions } },
 *   { model: 'Xenova/bge-reranker-base', candidateCount: 50 }  // Optional rerank config
 * );
 *
 * const results = await service.search('authentication flow');
 * ```
 */
export function createFusionService(
  projectId: string,
  embeddingProvider: EmbeddingProvider,
  searchConfig: SearchConfig = { top_k: 10, rerank: false },
  options: { denseOptions: { dimensions: number; useHNSW?: boolean; hnswConfig?: SearchServiceOptions['hnswConfig'] } } & Partial<Omit<FusionServiceOptions, 'projectId' | 'denseOptions'>>,
  rerankConfig?: RerankConfig
): FusionService {
  return new FusionService(
    projectId,
    embeddingProvider,
    searchConfig,
    {
      projectId,
      denseOptions: options.denseOptions,
      fusionConfig: options.fusionConfig,
      bm25Options: options.bm25Options,
    },
    rerankConfig
  );
}
