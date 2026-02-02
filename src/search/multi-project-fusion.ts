/**
 * Multi-Project Fusion Service
 *
 * Orchestrates cross-project hybrid search by combining:
 * - Dense (semantic) search via MultiProjectVectorStoreManager
 * - Sparse (keyword) search via MultiProjectBM25StoreManager
 *
 * Results are fused using Reciprocal Rank Fusion (RRF), with optional
 * cross-encoder reranking for improved precision.
 *
 * Architecture: Composition over Inheritance
 * - Composes existing multi-project managers (reuse caching/validation)
 * - Uses 2-level RRF: managers merge within type, this service merges across types
 * - Singleton pattern for efficient resource sharing
 *
 * Pipeline: Query → Dense + BM25 (parallel) → RRF Fusion → [Optional Rerank] → Results
 *
 * @example
 * ```typescript
 * const service = getMultiProjectFusionService({ rerank: false });
 *
 * // Validate before loading (checks embedding compatibility)
 * const validation = service.validateProjects(['proj-1', 'proj-2']);
 * if (!validation.valid) throw new Error('Incompatible embeddings');
 *
 * // Load stores for both managers in parallel
 * await service.loadProjects({
 *   projectIds: ['proj-1', 'proj-2'],
 *   dimensions: 1024,
 * });
 *
 * // Search with both query text (BM25) and embedding (dense)
 * const results = await service.search(
 *   'authentication middleware',
 *   queryEmbedding,
 *   { topK: 10 }
 * );
 * // results include projectId and projectName for attribution
 * ```
 */

import {
  MultiProjectVectorStoreManager,
  getMultiProjectVectorStoreManager,
} from './multi-project-store.js';
import {
  MultiProjectBM25StoreManager,
  getMultiProjectBM25StoreManager,
} from './multi-project-bm25-store.js';
import { RerankerService } from './reranker.js';
import { computeRRF, DEFAULT_RRF_K } from './fusion.js';
import type {
  MultiProjectFusionLoadOptions,
  MultiProjectFusionConfig,
  MultiProjectFusionSearchOptions,
  MultiProjectSearchResult,
  MultiProjectLoadProgress,
  EmbeddingValidation,
  FusionConfig,
  SearchResultWithContext,
} from './types.js';

/**
 * Project attribution lookup map type.
 * Maps chunk ID to its project info for restoration after RRF/reranking.
 */
type ProjectLookup = Map<string, { projectId: string; projectName: string }>;

/**
 * Multi-Project Fusion Service
 *
 * Provides hybrid search across multiple projects using dense + BM25 fusion.
 */
export class MultiProjectFusionService {
  /** Dense (vector) search manager */
  private readonly vectorManager: MultiProjectVectorStoreManager;

  /** Sparse (keyword) search manager */
  private readonly bm25Manager: MultiProjectBM25StoreManager;

  /** RRF configuration for merging dense vs BM25 */
  private readonly fusionConfig: FusionConfig;

  /** Optional cross-encoder reranker */
  private readonly rerankerService: RerankerService | null = null;

  /** Whether reranking is enabled */
  private readonly shouldRerank: boolean;

  /** Whether loadProjects() has been called */
  private initialized = false;

  constructor(config: MultiProjectFusionConfig = {}) {
    // Use existing singleton managers for caching benefits
    // This is the composition pattern - we don't extend, we wrap
    this.vectorManager = getMultiProjectVectorStoreManager();
    this.bm25Manager = getMultiProjectBM25StoreManager();

    // Configure RRF fusion (defaults to k=60, equal weights)
    this.fusionConfig = {
      k: config.fusionConfig?.k ?? DEFAULT_RRF_K,
      weights: config.fusionConfig?.weights,
    };

    // Configure reranking (disabled by default)
    this.shouldRerank = config.rerank ?? false;
    if (this.shouldRerank) {
      this.rerankerService = new RerankerService(config.rerankConfig);
    }
  }

  // ==========================================================================
  // Validation
  // ==========================================================================

  /**
   * Validate that all projects use compatible embedding models.
   *
   * Delegates to MultiProjectVectorStoreManager.validateProjects().
   * BM25 has no validation requirements (text-based tokenization).
   *
   * Call this BEFORE loadProjects() to catch embedding mismatches early.
   *
   * @param projectIds - Project IDs to validate
   * @returns Validation result with details if invalid
   */
  validateProjects(projectIds: string[]): EmbeddingValidation {
    return this.vectorManager.validateProjects(projectIds);
  }

  // ==========================================================================
  // Loading
  // ==========================================================================

  /**
   * Load stores for multiple projects (both vector and BM25).
   *
   * Loads both managers in parallel for optimal performance.
   * If reranking is enabled, also warms up the reranker model.
   *
   * Progress is reported per-manager as each project loads.
   *
   * @param options - Load options including projectIds and dimensions
   * @param onProgress - Optional callback for progress updates
   */
  async loadProjects(
    options: MultiProjectFusionLoadOptions,
    onProgress?: (progress: MultiProjectLoadProgress) => void
  ): Promise<void> {
    const { projectIds, dimensions, useHNSW, hnswConfig, bm25Config } = options;

    // Load both managers in parallel for better performance
    // This is why we use Promise.all instead of sequential loading
    const loadPromises: Promise<unknown>[] = [
      this.vectorManager.loadStores(
        { projectIds, dimensions, useHNSW, hnswConfig },
        onProgress
      ),
      this.bm25Manager.loadRetrievers({ projectIds, bm25Config }, onProgress),
    ];

    // Warmup reranker in parallel if enabled
    // This hides the ~2-3 second model load time behind store loading
    if (this.rerankerService) {
      loadPromises.push(this.rerankerService.warmup());
    }

    await Promise.all(loadPromises);
    this.initialized = true;
  }

  // ==========================================================================
  // Search
  // ==========================================================================

  /**
   * Perform hybrid search across all loaded projects.
   *
   * Runs dense and BM25 searches in parallel, then fuses results using RRF.
   * Optionally applies cross-encoder reranking for improved precision.
   *
   * @param query - Search query text (used for BM25 and reranking)
   * @param queryEmbedding - Query vector (used for dense search)
   * @param options - Search options (topK, filters, etc.)
   * @returns Fused (and optionally reranked) results sorted by score descending
   */
  async search(
    query: string,
    queryEmbedding: number[],
    options: MultiProjectFusionSearchOptions = {}
  ): Promise<MultiProjectSearchResult[]> {
    const {
      topKPerProject = 20,
      topK = 10,
      minScore,
      fileType,
      language,
    } = options;

    // Build search options for both managers
    // Over-fetch to improve RRF quality - more candidates = better ranking
    const searchOptions = {
      topKPerProject,
      topK: topKPerProject * Math.max(this.vectorManager.loadedProjectCount, 1),
      minScore,
      fileType,
      language,
    };

    // Run both searches in parallel - this is the key performance optimization
    const [denseResults, bm25Results] = await Promise.all([
      this.vectorManager.search(queryEmbedding, searchOptions),
      this.bm25Manager.search(query, searchOptions),
    ]);

    // Build project lookup BEFORE any transformations that lose project fields
    // This is needed because both computeRRF() and reranker return base types
    const projectLookup = this.buildProjectLookup(denseResults, bm25Results);

    // Fuse results using RRF (dense vs BM25)
    let fusedResults = this.fuseResults(denseResults, bm25Results, projectLookup);

    // Apply reranking if enabled
    // CRITICAL: reranker.rerank() returns SearchResultWithContext[] which loses
    // projectId/projectName - we must restore them after reranking
    if (this.shouldRerank && this.rerankerService) {
      const reranked = await this.rerankerService.rerank(
        query,
        fusedResults,
        topK
      );
      // Restore project attribution after reranking
      fusedResults = this.restoreProjectAttribution(reranked, projectLookup);
    }

    // Apply post-fusion filters
    if (minScore !== undefined) {
      fusedResults = fusedResults.filter((r) => r.score >= minScore);
    }

    // Apply topK limit (reranker already limits if enabled)
    if (!this.shouldRerank) {
      fusedResults = fusedResults.slice(0, topK);
    }

    return fusedResults;
  }

  /**
   * Build a lookup map for project attribution.
   *
   * This map is used to restore projectId/projectName after operations
   * that return base SearchResultWithContext[] (like computeRRF and reranking).
   */
  private buildProjectLookup(
    ...resultSets: MultiProjectSearchResult[][]
  ): ProjectLookup {
    const lookup: ProjectLookup = new Map();

    for (const results of resultSets) {
      for (const result of results) {
        // First occurrence wins (preserves original project attribution)
        if (!lookup.has(result.id)) {
          lookup.set(result.id, {
            projectId: result.projectId,
            projectName: result.projectName,
          });
        }
      }
    }

    return lookup;
  }

  /**
   * Restore project attribution to results that lost it.
   *
   * Used after computeRRF() and after reranking, both of which return
   * SearchResultWithContext[] without project fields.
   */
  private restoreProjectAttribution(
    results: SearchResultWithContext[],
    projectLookup: ProjectLookup
  ): MultiProjectSearchResult[] {
    return results.map((result) => {
      const projectInfo = projectLookup.get(result.id);
      return {
        ...result,
        projectId: projectInfo?.projectId ?? '',
        projectName: projectInfo?.projectName ?? '',
      };
    });
  }

  /**
   * Fuse dense and BM25 results using Reciprocal Rank Fusion.
   *
   * The key challenge: computeRRF() returns SearchResultWithContext[],
   * but we need MultiProjectSearchResult[] (with projectId/projectName).
   *
   * Solution: Use the provided lookup map to restore attribution after RRF.
   */
  private fuseResults(
    denseResults: MultiProjectSearchResult[],
    bm25Results: MultiProjectSearchResult[],
    projectLookup: ProjectLookup
  ): MultiProjectSearchResult[] {
    // Compute RRF using existing function (handles ranking + weighting)
    const fused = computeRRF(denseResults, bm25Results, this.fusionConfig);

    // Restore project attribution to fused results
    return this.restoreProjectAttribution(fused, projectLookup);
  }

  // ==========================================================================
  // State Management
  // ==========================================================================

  /**
   * Check if loadProjects() has been called.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the list of loaded project IDs.
   *
   * Returns projects loaded in the vector manager (BM25 should match).
   */
  getLoadedProjects(): string[] {
    return this.vectorManager.getLoadedProjects();
  }

  /**
   * Get the count of loaded projects.
   */
  get loadedProjectCount(): number {
    return this.vectorManager.loadedProjectCount;
  }

  /**
   * Clear all loaded projects from both managers.
   *
   * Note: This does NOT clear the underlying store caches.
   * Use this when you want to reset which projects are included in search.
   */
  clearLoadedProjects(): void {
    this.vectorManager.clearLoadedProjects();
    this.bm25Manager.clearLoadedProjects();
    this.initialized = false;
  }

  /**
   * Remove a specific project from both managers.
   *
   * @returns true if the project was removed from at least one manager
   */
  removeProject(projectId: string): boolean {
    const vectorRemoved = this.vectorManager.removeProject(projectId);
    const bm25Removed = this.bm25Manager.removeProject(projectId);
    return vectorRemoved || bm25Removed;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let serviceInstance: MultiProjectFusionService | null = null;

/**
 * Get the singleton MultiProjectFusionService instance.
 *
 * Configuration is only applied on first call. Subsequent calls
 * return the existing instance (config parameter is ignored).
 *
 * @param config - Configuration for the service (only used on first call)
 */
export function getMultiProjectFusionService(
  config?: MultiProjectFusionConfig
): MultiProjectFusionService {
  if (!serviceInstance) {
    serviceInstance = new MultiProjectFusionService(config);
  }
  return serviceInstance;
}

/**
 * Reset the singleton instance.
 *
 * Useful for testing or when configuration needs to change.
 * After reset, the next getMultiProjectFusionService() call
 * will create a new instance with fresh configuration.
 */
export function resetMultiProjectFusionService(): void {
  if (serviceInstance) {
    serviceInstance.clearLoadedProjects();
    serviceInstance = null;
  }
}
