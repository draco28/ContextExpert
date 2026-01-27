/**
 * Search Module Types
 *
 * Type definitions for the vector search pipeline.
 * Defines interfaces for search configuration, options, and results.
 */

/**
 * Search configuration from config.toml [search] section.
 */
export interface SearchConfig {
  /** Number of results to return (default: 10) */
  top_k: number;
  /** Whether to enable reranking (Sprint 3 feature) */
  rerank: boolean;
}

/**
 * Options for initializing the SearchService.
 */
export interface SearchServiceOptions {
  /** Project ID to scope searches */
  projectId: string;
  /** Embedding dimensions (1024 for BGE-large, 768 for BGE-base) */
  dimensions: number;
  /** Use HNSW index for O(log n) search (default: true) */
  useHNSW?: boolean;
  /** HNSW index tuning parameters */
  hnswConfig?: {
    /** Max connections per node (default: 16) */
    M?: number;
    /** Build quality - higher = better index, slower build (default: 200) */
    efConstruction?: number;
    /** Search quality - higher = better recall, slower search (default: 100) */
    efSearch?: number;
  };
}

/**
 * Options for performing a search query.
 */
export interface SearchQueryOptions {
  /** Number of results to return (overrides config default) */
  topK?: number;
  /** Minimum similarity score threshold (0-1 for cosine) */
  minScore?: number;
  /** Filter by content type */
  fileType?: 'code' | 'docs' | 'config';
  /** Filter by programming language */
  language?: string;
}

/**
 * A search result with full chunk context.
 *
 * Includes everything needed to display results and navigate to source.
 */
export interface SearchResultWithContext {
  /** Chunk UUID */
  id: string;
  /** Similarity score (0-1 for cosine, higher = more similar) */
  score: number;
  /** The matched chunk text content */
  content: string;
  /** Relative file path from project root */
  filePath: string;
  /** Content type classification */
  fileType: 'code' | 'docs' | 'config' | 'unknown';
  /** Programming language (null for non-code) */
  language: string | null;
  /** Line range in source file */
  lineRange: {
    start: number;
    end: number;
  };
  /** Additional metadata from chunk */
  metadata: Record<string, unknown>;
}

/**
 * Progress callback for index building.
 *
 * Called during lazy loading to report progress.
 */
export interface IndexBuildProgress {
  /** Current phase of index building */
  phase: 'loading' | 'building';
  /** Number of chunks loaded so far */
  loaded: number;
  /** Total chunks to load */
  total: number;
}
