/**
 * Multi-Project Vector Store Manager
 *
 * Manages loading and searching across multiple project vector stores.
 * Uses composition to wrap the singleton VectorStoreManager, preserving
 * its caching behavior while adding cross-project capabilities.
 *
 * Key responsibilities:
 * 1. Validate embedding model consistency across projects
 * 2. Load multiple project stores with progress reporting
 * 3. Coordinate parallel searches across stores
 * 4. Merge results using Reciprocal Rank Fusion (RRF)
 *
 * Architecture:
 * - Each project has its own InMemoryVectorStore (per VectorStoreManager)
 * - Search runs in parallel across all loaded stores
 * - Results are merged using RRF, same algorithm as FusionService
 * - projectId is injected at search time (not stored in chunk metadata)
 *
 * @example
 * ```typescript
 * const manager = getMultiProjectVectorStoreManager();
 *
 * // Validate before loading
 * const validation = await manager.validateProjects(['proj-1', 'proj-2']);
 * if (!validation.valid) {
 *   throw new Error(`Cannot search: ${validation.errors![0].projectName} uses different embedding model`);
 * }
 *
 * // Load stores
 * await manager.loadStores({
 *   projectIds: ['proj-1', 'proj-2'],
 *   dimensions: 1024,
 * }, (progress) => {
 *   console.log(`Loading ${progress.projectName} (${progress.loaded}/${progress.total})`);
 * });
 *
 * // Search across all projects
 * const results = await manager.search(queryEmbedding, { topK: 10 });
 * // results include projectId and projectName for attribution
 * ```
 */

import type { InMemoryVectorStore, SearchOptions } from '@contextaisdk/rag';
import { reciprocalRankFusion, DEFAULT_RRF_K, type RankingList } from '@contextaisdk/rag';

import { getDatabase, type DatabaseOperations } from '../database/operations.js';
import type { Project } from '../database/schema.js';
import { getVectorStoreManager, type VectorStoreManager } from './store.js';
import { formatSearchResult } from './shared-formatting.js';
import type {
  MultiProjectLoadOptions,
  MultiProjectLoadProgress,
  MultiProjectSearchResult,
  MultiProjectSearchOptions,
  EmbeddingValidation,
  SearchServiceOptions,
} from './types.js';

/**
 * Multi-Project Vector Store Manager
 *
 * Coordinates loading and searching across multiple project vector stores.
 * Wraps the singleton VectorStoreManager for store management.
 */
export class MultiProjectVectorStoreManager {
  /**
   * Tracks which projects have been loaded through this manager.
   * Used to know which stores to search.
   */
  private loadedProjects = new Map<string, { name: string; dimensions: number }>();

  /** Database operations for project validation */
  private dbOps: DatabaseOperations;

  /** The underlying single-project store manager */
  private storeManager: VectorStoreManager;

  constructor() {
    this.dbOps = getDatabase();
    this.storeManager = getVectorStoreManager();
  }

  // ==========================================================================
  // Validation
  // ==========================================================================

  /**
   * Validate that all projects use compatible embedding models.
   *
   * This should be called before loadStores() for cross-project search.
   * All projects must have the same embedding model and dimensions.
   *
   * @param projectIds - Project IDs to validate
   * @returns Validation result with details if invalid
   */
  validateProjects(projectIds: string[]): EmbeddingValidation {
    const projects: Project[] = [];

    // Fetch all projects
    for (const id of projectIds) {
      const project = this.dbOps.getProjectById(id);
      if (!project) {
        return {
          valid: false,
          errors: [{
            projectId: id,
            projectName: `Unknown (ID: ${id})`,
            embeddingModel: null,
            embeddingDimensions: 0,
          }],
        };
      }
      projects.push(project);
    }

    if (projects.length === 0) {
      return { valid: true }; // No projects to validate
    }

    // Use first project as reference
    const reference = projects[0]!;
    const errors: EmbeddingValidation['errors'] = [];

    for (let i = 1; i < projects.length; i++) {
      const project = projects[i]!;

      // Check dimensions match
      if (project.embedding_dimensions !== reference.embedding_dimensions) {
        errors.push({
          projectId: project.id,
          projectName: project.name,
          embeddingModel: project.embedding_model,
          embeddingDimensions: project.embedding_dimensions,
        });
        continue;
      }

      // Check model name matches (if both are set)
      if (
        project.embedding_model !== null &&
        reference.embedding_model !== null &&
        project.embedding_model !== reference.embedding_model
      ) {
        errors.push({
          projectId: project.id,
          projectName: project.name,
          embeddingModel: project.embedding_model,
          embeddingDimensions: project.embedding_dimensions,
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      expectedDimensions: reference.embedding_dimensions,
      expectedModel: reference.embedding_model,
    };
  }

  // ==========================================================================
  // Store Loading
  // ==========================================================================

  /**
   * Load vector stores for multiple projects.
   *
   * Leverages the VectorStoreManager's caching - if a store is already loaded,
   * it will be reused without reloading from the database.
   *
   * @param options - Load options including projectIds and dimensions
   * @param onProgress - Optional callback for progress updates
   * @returns Map of projectId to InMemoryVectorStore
   */
  async loadStores(
    options: MultiProjectLoadOptions,
    onProgress?: (progress: MultiProjectLoadProgress) => void
  ): Promise<Map<string, InMemoryVectorStore>> {
    const { projectIds, dimensions, useHNSW = true, hnswConfig } = options;
    const stores = new Map<string, InMemoryVectorStore>();

    for (let i = 0; i < projectIds.length; i++) {
      const projectId = projectIds[i]!;

      // Get project info for progress reporting
      const project = this.dbOps.getProjectById(projectId);
      const projectName = project?.name ?? `Project ${projectId}`;

      // Build store options
      const storeOptions: SearchServiceOptions = {
        projectId,
        dimensions,
        useHNSW,
        hnswConfig,
      };

      // Load store with progress callback that includes project context
      const store = await this.storeManager.getStore(
        storeOptions,
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

      stores.set(projectId, store);

      // Track this project as loaded
      this.loadedProjects.set(projectId, {
        name: projectName,
        dimensions,
      });
    }

    return stores;
  }

  // ==========================================================================
  // Search
  // ==========================================================================

  /**
   * Search across all loaded project stores.
   *
   * Executes searches in parallel across all stores and merges results
   * using Reciprocal Rank Fusion (RRF). Each result includes the projectId
   * and projectName for attribution.
   *
   * @param queryEmbedding - Query vector (must match loaded dimensions)
   * @param options - Search options
   * @returns Merged results sorted by RRF score
   */
  async search(
    queryEmbedding: number[],
    options: MultiProjectSearchOptions = {}
  ): Promise<MultiProjectSearchResult[]> {
    const {
      topKPerProject = 20, // Over-fetch per project for better RRF results
      topK = 10,
      minScore,
      fileType,
      language,
    } = options;

    // Build search options for SDK
    const searchOptions: SearchOptions = {
      topK: topKPerProject,
      minScore,
      includeMetadata: true,
      filter: this.buildFilter(fileType, language),
    };

    // Collect results per project
    const projectResults = new Map<string, MultiProjectSearchResult[]>();

    // Search all loaded projects in parallel
    const searchPromises = Array.from(this.loadedProjects.entries()).map(
      async ([projectId, projectInfo]) => {
        // Defensive check: Skip projects whose stores were invalidated externally
        // (e.g., by resetVectorStoreManager() or invalidate()) between loadStores()
        // and this search call. This prevents errors and gracefully degrades results.
        if (!this.storeManager.hasStore(projectId)) {
          return;
        }

        // Get the cached store. Note: If external code called invalidate() between
        // our hasStore() check and now, this will trigger a rebuild. This is safe
        // but may have performance implications in concurrent scenarios.
        const store = await this.storeManager.getStore({
          projectId,
          dimensions: projectInfo.dimensions,
        });

        const results = await store.search(queryEmbedding, searchOptions);

        // Convert to MultiProjectSearchResult with project attribution
        const formattedResults: MultiProjectSearchResult[] = results.map(
          (result) => ({
            ...formatSearchResult(
              result.id,
              result.score,
              result.chunk.content,
              result.chunk.metadata
            ),
            projectId,
            projectName: projectInfo.name,
          })
        );

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
   * Build a metadata filter for the search options.
   */
  private buildFilter(
    fileType?: 'code' | 'docs' | 'config',
    language?: string
  ): Record<string, unknown> | undefined {
    const filter: Record<string, unknown> = {};

    if (fileType) filter.fileType = fileType;
    if (language) filter.language = language;

    return Object.keys(filter).length > 0 ? filter : undefined;
  }

  // ==========================================================================
  // State Management
  // ==========================================================================

  /**
   * Check if a project's store has been loaded through this manager.
   */
  hasProjectStore(projectId: string): boolean {
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
   * Note: This does NOT clear the underlying VectorStoreManager cache.
   * Use this when you want to reset which projects are included in search.
   */
  clearLoadedProjects(): void {
    this.loadedProjects.clear();
  }

  /**
   * Remove a specific project from the loaded set.
   *
   * Note: This does NOT clear the underlying VectorStoreManager cache.
   */
  removeProject(projectId: string): boolean {
    return this.loadedProjects.delete(projectId);
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let managerInstance: MultiProjectVectorStoreManager | null = null;

/**
 * Get the singleton MultiProjectVectorStoreManager instance.
 */
export function getMultiProjectVectorStoreManager(): MultiProjectVectorStoreManager {
  if (!managerInstance) {
    managerInstance = new MultiProjectVectorStoreManager();
  }
  return managerInstance;
}

/**
 * Reset the singleton instance.
 *
 * Useful for testing or when you need to start fresh.
 */
export function resetMultiProjectVectorStoreManager(): void {
  if (managerInstance) {
    managerInstance.clearLoadedProjects();
    managerInstance = null;
  }
}
