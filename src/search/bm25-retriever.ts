/**
 * BM25 Search Service
 *
 * High-level BM25 search API wrapping BM25Retriever.
 * Handles result formatting and metadata filtering.
 *
 * Use this for keyword-based search where exact term matching matters:
 * - Finding specific function/class names
 * - Searching for error codes or technical terms
 * - Matching exact phrases in documentation
 */

import type { BM25Retriever } from '@contextaisdk/rag';

import { getBM25StoreManager } from './bm25-store.js';
import type {
  SearchConfig,
  SearchQueryOptions,
  SearchResultWithContext,
  IndexBuildProgress,
  BM25ServiceOptions,
} from './types.js';

/**
 * BM25 search service for keyword-based search within a project.
 *
 * Provides a simple interface for searching indexed content:
 * 1. Lazily loads chunks from SQLite on first search
 * 2. Builds BM25 index from chunk content
 * 3. Performs keyword matching using BM25 scoring
 * 4. Returns results with full context for display
 *
 * @example
 * ```typescript
 * const service = createBM25SearchService('project-123', {
 *   top_k: 10,
 *   rerank: false,
 * });
 *
 * // Exact keyword search
 * const results = await service.search('PostgreSQL connection pool', {
 *   topK: 5,
 *   fileType: 'code',
 * });
 *
 * for (const result of results) {
 *   console.log(`${result.filePath}:${result.lineRange.start}-${result.lineRange.end}`);
 *   console.log(`Score: ${result.score.toFixed(3)}`);
 * }
 * ```
 */
export class BM25SearchService {
  private retriever: BM25Retriever | null = null;
  private chunkCount: number = 0;
  private readonly projectId: string;
  private readonly config: SearchConfig;
  private readonly bm25Config?: BM25ServiceOptions['bm25Config'];

  constructor(config: SearchConfig, options: BM25ServiceOptions) {
    this.config = config;
    this.projectId = options.projectId;
    this.bm25Config = options.bm25Config;
  }

  /**
   * Ensure the retriever is initialized.
   *
   * Lazily loads the BM25 index on first search.
   * Safe to call multiple times - only initializes once.
   */
  async ensureInitialized(
    onProgress?: (progress: IndexBuildProgress) => void
  ): Promise<void> {
    if (this.retriever) return;

    const storeManager = getBM25StoreManager();
    this.retriever = await storeManager.getRetriever(
      {
        projectId: this.projectId,
        bm25Config: this.bm25Config,
      },
      onProgress
    );

    // Cache chunk count for later queries
    this.chunkCount = this.retriever.documentCount;
  }

  /**
   * Perform a keyword search using BM25.
   *
   * @param query - Keyword search query (exact terms matter)
   * @param options - Search options (topK, filters, etc.)
   * @returns Array of results with context, sorted by BM25 score (descending)
   */
  async search(
    query: string,
    options: SearchQueryOptions = {}
  ): Promise<SearchResultWithContext[]> {
    await this.ensureInitialized();

    const topK = options.topK ?? this.config.top_k;

    // Perform BM25 retrieval
    const results = await this.retriever!.retrieve(query, { topK });

    // Convert to our result format and apply filters
    const formatted: SearchResultWithContext[] = [];

    for (const result of results) {
      const fileType = (result.chunk.metadata?.fileType as SearchResultWithContext['fileType']) ?? 'unknown';
      const language = (result.chunk.metadata?.language as string | null) ?? null;

      // Apply filters
      if (options.fileType && fileType !== options.fileType) {
        continue;
      }
      if (options.language && language !== options.language) {
        continue;
      }
      if (options.minScore !== undefined && result.score < options.minScore) {
        continue;
      }

      formatted.push({
        id: result.chunk.id,
        score: result.score,
        content: result.chunk.content,
        filePath: (result.chunk.metadata?.filePath as string) ?? '',
        fileType,
        language,
        lineRange: {
          start: (result.chunk.metadata?.startLine as number) ?? 0,
          end: (result.chunk.metadata?.endLine as number) ?? 0,
        },
        metadata: result.chunk.metadata ?? {},
      });
    }

    return formatted;
  }

  /**
   * Get the number of indexed chunks for this project.
   */
  async getChunkCount(): Promise<number> {
    await this.ensureInitialized();
    return this.chunkCount;
  }

  /**
   * Check if the BM25 index is initialized.
   */
  isInitialized(): boolean {
    return this.retriever !== null;
  }

  /**
   * Get the project ID this service is scoped to.
   */
  getProjectId(): string {
    return this.projectId;
  }
}

/**
 * Create a BM25 search service for a project.
 *
 * This is the main entry point for BM25 search functionality.
 *
 * @param projectId - Project to search within
 * @param config - Search configuration from config.toml
 * @param options - Additional options (BM25 tuning parameters)
 * @returns Configured BM25SearchService instance
 *
 * @example
 * ```typescript
 * // Basic usage
 * const search = createBM25SearchService(projectId, config);
 * const results = await search.search('authentication middleware');
 *
 * // With custom BM25 parameters
 * const search = createBM25SearchService(projectId, config, {
 *   bm25Config: { k1: 1.5, b: 0.5 },
 * });
 * ```
 */
export function createBM25SearchService(
  projectId: string,
  config: SearchConfig,
  options?: Partial<Omit<BM25ServiceOptions, 'projectId'>>
): BM25SearchService {
  return new BM25SearchService(config, {
    projectId,
    bm25Config: options?.bm25Config,
  });
}
