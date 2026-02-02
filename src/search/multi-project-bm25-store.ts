/**
 * Multi-Project BM25 Store Manager
 *
 * Manages loading and searching across multiple project BM25 retrievers.
 * Uses composition to wrap the singleton BM25StoreManager, preserving
 * its caching behavior while adding cross-project capabilities.
 *
 * Key responsibilities:
 * 1. Load BM25 retrievers for multiple projects
 * 2. Coordinate parallel searches across retrievers
 * 3. Merge results using Reciprocal Rank Fusion (RRF)
 *
 * Architecture:
 * - Each project has its own BM25Retriever (per BM25StoreManager)
 * - Search runs in parallel across all loaded retrievers
 * - Results are merged using RRF, same algorithm as FusionService
 * - projectId available from two sources: chunk metadata (for filtering) and
 *   explicit injection at search time (for MultiProjectSearchResult attribution)
 *
 * Key Difference from MultiProjectVectorStoreManager:
 * - No validation phase needed - BM25 uses text tokenization, not embeddings
 * - Simpler load options (no dimensions or HNSW config)
 *
 * @example
 * ```typescript
 * const manager = getMultiProjectBM25StoreManager();
 *
 * // Load retrievers (no validation needed for BM25)
 * await manager.loadRetrievers({
 *   projectIds: ['proj-1', 'proj-2'],
 * }, (progress) => {
 *   console.log(`Loading ${progress.projectName} (${progress.loaded}/${progress.total})`);
 * });
 *
 * // Search across all projects
 * const results = await manager.search('PostgreSQL function', { topK: 10 });
 * // results include projectId and projectName for attribution
 * ```
 */

import type { BM25Retriever } from '@contextaisdk/rag';
import { reciprocalRankFusion, DEFAULT_RRF_K, type RankingList } from '@contextaisdk/rag';

import { getDatabase, type DatabaseOperations } from '../database/operations.js';
import { getBM25StoreManager, type BM25StoreManager } from './bm25-store.js';
import { formatSearchResult } from './shared-formatting.js';
import type {
  MultiProjectBM25LoadOptions,
  MultiProjectLoadProgress,
  MultiProjectSearchResult,
  MultiProjectSearchOptions,
} from './types.js';

/**
 * Multi-Project BM25 Store Manager
 *
 * Coordinates loading and searching across multiple project BM25 retrievers.
 * Wraps the singleton BM25StoreManager for retriever management.
 */
export class MultiProjectBM25StoreManager {
  /**
   * Tracks which projects have been loaded through this manager.
   * Used to know which retrievers to search.
   */
  private loadedProjects = new Map<string, { name: string }>();

  /** Database operations for project info lookup */
  private dbOps: DatabaseOperations;

  /** The underlying single-project BM25 store manager */
  private storeManager: BM25StoreManager;

  constructor() {
    this.dbOps = getDatabase();
    this.storeManager = getBM25StoreManager();
  }

  // ==========================================================================
  // Retriever Loading
  // ==========================================================================

  /**
   * Load BM25 retrievers for multiple projects.
   *
   * Leverages the BM25StoreManager's caching - if a retriever is already loaded,
   * it will be reused without rebuilding from the database.
   *
   * @param options - Load options including projectIds
   * @param onProgress - Optional callback for progress updates
   * @returns Map of projectId to BM25Retriever
   */
  async loadRetrievers(
    options: MultiProjectBM25LoadOptions,
    onProgress?: (progress: MultiProjectLoadProgress) => void
  ): Promise<Map<string, BM25Retriever>> {
    const { projectIds, bm25Config } = options;
    const retrievers = new Map<string, BM25Retriever>();

    for (let i = 0; i < projectIds.length; i++) {
      const projectId = projectIds[i]!;

      // Get project info for progress reporting
      const project = this.dbOps.getProjectById(projectId);
      const projectName = project?.name ?? `Project ${projectId}`;

      // Load retriever with progress callback that includes project context
      const retriever = await this.storeManager.getRetriever(
        { projectId, bm25Config },
        (progress) => {
          onProgress?.({
            ...progress,
            projectId,
            projectName,
            projectIndex: i + 1,
            totalProjects: projectIds.length,
          });
        }
      );

      retrievers.set(projectId, retriever);

      // Track this project as loaded
      this.loadedProjects.set(projectId, { name: projectName });
    }

    return retrievers;
  }

  // ==========================================================================
  // Search
  // ==========================================================================

  /**
   * Search across all loaded project retrievers.
   *
   * Executes searches in parallel across all retrievers and merges results
   * using Reciprocal Rank Fusion (RRF). Each result includes the projectId
   * and projectName for attribution.
   *
   * @param query - Search query text
   * @param options - Search options
   * @returns Merged results sorted by RRF score
   */
  async search(
    query: string,
    options: MultiProjectSearchOptions = {}
  ): Promise<MultiProjectSearchResult[]> {
    const {
      topKPerProject = 20, // Over-fetch per project for better RRF results
      topK = 10,
      minScore,
      fileType,
      language,
    } = options;

    // Collect results per project
    const projectResults = new Map<string, MultiProjectSearchResult[]>();

    // Search all loaded projects in parallel
    const searchPromises = Array.from(this.loadedProjects.entries()).map(
      async ([projectId, projectInfo]) => {
        // Defensive check: Skip projects whose retrievers were invalidated externally
        // (e.g., by resetBM25StoreManager() or invalidate()) between loadRetrievers()
        // and this search call. This prevents errors and gracefully degrades results.
        if (!this.storeManager.hasRetriever(projectId)) {
          return;
        }

        // Get the cached retriever. Note: If external code called invalidate() between
        // our hasRetriever() check and now, this will trigger a rebuild. This is safe
        // but may have performance implications in concurrent scenarios.
        const retriever = await this.storeManager.getRetriever({ projectId });

        // Perform BM25 search
        const results = await retriever.retrieve(query, {
          topK: topKPerProject,
          minScore,
        });

        // Convert to MultiProjectSearchResult with project attribution
        const formattedResults: MultiProjectSearchResult[] = results
          .map((result) => ({
            ...formatSearchResult(
              result.id,
              result.score,
              result.chunk.content,
              result.chunk.metadata as Record<string, unknown> | undefined
            ),
            projectId,
            projectName: projectInfo.name,
          }))
          .filter((r) => this.matchesFilters(r, fileType, language));

        projectResults.set(projectId, formattedResults);
      }
    );

    await Promise.all(searchPromises);

    // Edge case: no projects loaded
    if (projectResults.size === 0) {
      return [];
    }

    // Single project: skip RRF overhead
    if (projectResults.size === 1) {
      const results = Array.from(projectResults.values())[0]!;
      return results.slice(0, topK);
    }

    // Multiple projects: merge using RRF
    return this.mergeWithRRF(projectResults, topK);
  }

  /**
   * Merge results from multiple projects using Reciprocal Rank Fusion.
   *
   * Each project's results are treated as a separate ranking list.
   * Documents appearing in multiple projects' results get boosted.
   */
  private mergeWithRRF(
    projectResults: Map<string, MultiProjectSearchResult[]>,
    topK: number
  ): MultiProjectSearchResult[] {
    // Build a lookup map for full result data (needed after RRF)
    const resultLookup = new Map<string, MultiProjectSearchResult>();

    // Convert to SDK's RankingList format
    const rankings: RankingList[] = [];

    for (const [projectId, results] of projectResults) {
      // Add to lookup map
      for (const result of results) {
        // First occurrence wins (keeps original project attribution)
        if (!resultLookup.has(result.id)) {
          resultLookup.set(result.id, result);
        }
      }

      // Create ranking list for this project
      rankings.push({
        name: projectId,
        items: results.map((r, i) => ({
          id: r.id,
          rank: i + 1, // 1-indexed ranks
          score: r.score,
          chunk: {
            id: r.id,
            content: r.content,
            metadata: r.metadata,
          },
        })),
      });
    }

    // Call SDK's RRF implementation
    const rrfResults = reciprocalRankFusion(rankings, DEFAULT_RRF_K);

    // Convert back to MultiProjectSearchResult
    return rrfResults.slice(0, topK).map((rrf) => ({
      ...resultLookup.get(rrf.id)!,
      score: rrf.score, // Use RRF score
    }));
  }

  /**
   * Check if a result matches the file type and language filters.
   */
  private matchesFilters(
    result: MultiProjectSearchResult,
    fileType?: 'code' | 'docs' | 'config',
    language?: string
  ): boolean {
    if (fileType && result.fileType !== fileType) {
      return false;
    }
    if (language && result.language !== language) {
      return false;
    }
    return true;
  }

  // ==========================================================================
  // State Management
  // ==========================================================================

  /**
   * Check if a project's retriever has been loaded through this manager.
   */
  hasProjectRetriever(projectId: string): boolean {
    return this.loadedProjects.has(projectId);
  }

  /**
   * Get the list of loaded project IDs.
   */
  getLoadedProjects(): string[] {
    return Array.from(this.loadedProjects.keys());
  }

  /**
   * Get the count of loaded projects.
   */
  get loadedProjectCount(): number {
    return this.loadedProjects.size;
  }

  /**
   * Clear all loaded project tracking.
   *
   * Note: This does NOT clear the underlying BM25StoreManager cache.
   * Use this when you want to reset which projects are included in search.
   */
  clearLoadedProjects(): void {
    this.loadedProjects.clear();
  }

  /**
   * Remove a specific project from the loaded set.
   *
   * Note: This does NOT clear the underlying BM25StoreManager cache.
   */
  removeProject(projectId: string): boolean {
    return this.loadedProjects.delete(projectId);
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let managerInstance: MultiProjectBM25StoreManager | null = null;

/**
 * Get the singleton MultiProjectBM25StoreManager instance.
 */
export function getMultiProjectBM25StoreManager(): MultiProjectBM25StoreManager {
  if (!managerInstance) {
    managerInstance = new MultiProjectBM25StoreManager();
  }
  return managerInstance;
}

/**
 * Reset the singleton instance.
 *
 * Useful for testing or when you need to start fresh.
 */
export function resetMultiProjectBM25StoreManager(): void {
  if (managerInstance) {
    managerInstance.clearLoadedProjects();
    managerInstance = null;
  }
}
