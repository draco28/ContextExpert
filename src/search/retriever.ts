/**
 * Search Service
 *
 * High-level search API wrapping DenseRetriever.
 * Handles query embedding, metadata filtering, and result formatting.
 */

import { DenseRetriever } from '@contextaisdk/rag';
import type { EmbeddingProvider } from '@contextaisdk/rag';

import { getVectorStoreManager } from './store.js';
import type {
  SearchConfig,
  SearchServiceOptions,
  SearchQueryOptions,
  SearchResultWithContext,
  IndexBuildProgress,
} from './types.js';

/**
 * Search service for semantic search within a project.
 *
 * Provides a simple interface for searching indexed content:
 * 1. Lazily loads vectors from SQLite on first search
 * 2. Embeds the query text using the configured provider
 * 3. Performs vector similarity search
 * 4. Returns results with full context for display
 *
 * @example
 * ```typescript
 * const service = await createSearchService(
 *   'project-123',
 *   embeddingProvider,
 *   { top_k: 10, rerank: false }
 * );
 *
 * const results = await service.search('authentication middleware', {
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
export class SearchService {
  private retriever: DenseRetriever | null = null;
  private readonly projectId: string;
  private readonly dimensions: number;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly config: SearchConfig;
  private readonly useHNSW: boolean;
  private readonly hnswConfig?: SearchServiceOptions['hnswConfig'];

  constructor(
    embeddingProvider: EmbeddingProvider,
    config: SearchConfig,
    options: SearchServiceOptions
  ) {
    this.embeddingProvider = embeddingProvider;
    this.config = config;
    this.projectId = options.projectId;
    this.dimensions = options.dimensions;
    this.useHNSW = options.useHNSW ?? true;
    this.hnswConfig = options.hnswConfig;
  }

  /**
   * Ensure the retriever is initialized.
   *
   * Lazily loads the vector store on first search.
   * Safe to call multiple times - only initializes once.
   */
  async ensureInitialized(
    onProgress?: (progress: IndexBuildProgress) => void
  ): Promise<void> {
    if (this.retriever) return;

    const storeManager = getVectorStoreManager();
    const store = await storeManager.getStore(
      {
        projectId: this.projectId,
        dimensions: this.dimensions,
        useHNSW: this.useHNSW,
        hnswConfig: this.hnswConfig,
      },
      onProgress
    );

    // DenseRetriever handles query embedding + vector search
    this.retriever = new DenseRetriever(store, this.embeddingProvider);
  }

  /**
   * Perform a semantic search.
   *
   * @param query - Natural language search query
   * @param options - Search options (topK, filters, etc.)
   * @returns Array of results with context, sorted by relevance
   */
  async search(
    query: string,
    options: SearchQueryOptions = {}
  ): Promise<SearchResultWithContext[]> {
    await this.ensureInitialized();

    const topK = options.topK ?? this.config.top_k;
    const minScore = options.minScore ?? 0;

    // Build metadata filter from options
    const filter: Record<string, unknown> = {};
    if (options.fileType) {
      filter.fileType = options.fileType;
    }
    if (options.language) {
      filter.language = options.language;
    }
    // Project filter: use exact match for single ID, $in operator for multiple
    if (options.projectIds?.length) {
      filter.projectId =
        options.projectIds.length === 1
          ? options.projectIds[0]
          : { $in: options.projectIds };
    }

    // Perform retrieval (DenseRetriever embeds query automatically)
    const results = await this.retriever!.retrieve(query, {
      topK,
      minScore,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
    });

    // Convert to our result format
    return results.map((result) => ({
      id: result.chunk.id,
      score: result.score,
      content: result.chunk.content,
      filePath: (result.chunk.metadata?.filePath as string) ?? '',
      fileType: (result.chunk.metadata?.fileType as SearchResultWithContext['fileType']) ?? 'unknown',
      language: (result.chunk.metadata?.language as string | null) ?? null,
      lineRange: {
        start: (result.chunk.metadata?.startLine as number) ?? 0,
        end: (result.chunk.metadata?.endLine as number) ?? 0,
      },
      metadata: result.chunk.metadata ?? {},
    }));
  }

  /**
   * Get the number of indexed chunks for this project.
   */
  async getChunkCount(): Promise<number> {
    await this.ensureInitialized();
    const storeManager = getVectorStoreManager();
    const store = await storeManager.getStore({
      projectId: this.projectId,
      dimensions: this.dimensions,
    });
    return store.count();
  }

  /**
   * Check if the search index is initialized.
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
 * Create a search service for a project.
 *
 * This is the main entry point for search functionality.
 *
 * @param projectId - Project to search within
 * @param embeddingProvider - Provider for embedding queries
 * @param config - Search configuration from config.toml
 * @param options - Additional options (dimensions, HNSW config)
 * @returns Configured SearchService instance
 *
 * @example
 * ```typescript
 * import { createEmbeddingProvider } from '../indexer/embedder/provider.js';
 * import { createSearchService } from './retriever.js';
 *
 * const provider = await createEmbeddingProvider(config.embedding);
 * const search = await createSearchService(
 *   projectId,
 *   provider,
 *   config.search,
 *   { dimensions: 1024 }
 * );
 *
 * const results = await search.search('how does auth work?');
 * ```
 */
export function createSearchService(
  projectId: string,
  embeddingProvider: EmbeddingProvider,
  config: SearchConfig,
  options?: Partial<Omit<SearchServiceOptions, 'projectId'>>
): SearchService {
  // Default to BGE-large dimensions
  const dimensions = options?.dimensions ?? 1024;

  return new SearchService(embeddingProvider, config, {
    projectId,
    dimensions,
    useHNSW: options?.useHNSW ?? true,
    hnswConfig: options?.hnswConfig,
  });
}
