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

/**
 * BM25 algorithm configuration.
 *
 * BM25 (Best Match 25) is a ranking function used for keyword-based retrieval.
 * It extends TF-IDF with document length normalization.
 */
export interface BM25Config {
  /**
   * Term frequency saturation parameter (default: 1.2).
   *
   * Controls how quickly term frequency effects saturate:
   * - Lower k1 (e.g., 0.5): Diminishing returns kick in earlier
   * - Higher k1 (e.g., 2.0): More weight to repeated terms
   */
  k1?: number;
  /**
   * Document length normalization parameter (default: 0.75).
   *
   * Controls how much document length affects scoring:
   * - b=0: No length normalization (longer docs not penalized)
   * - b=1: Full length normalization (longer docs penalized more)
   */
  b?: number;
}

/**
 * Options for initializing the BM25SearchService.
 */
export interface BM25ServiceOptions {
  /** Project ID to scope searches */
  projectId: string;
  /** BM25 tuning parameters */
  bm25Config?: BM25Config;
}
