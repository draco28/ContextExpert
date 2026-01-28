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

/**
 * Reciprocal Rank Fusion (RRF) configuration.
 *
 * RRF combines results from multiple retrieval systems using rank positions
 * rather than raw scores. This avoids score normalization issues between
 * systems with different scoring scales (e.g., cosine similarity vs BM25).
 *
 * Formula: RRF(d) = Σ 1/(k + rank(d))
 */
export interface FusionConfig {
  /**
   * RRF constant (default: 60).
   *
   * Controls the influence of top-ranked items:
   * - Lower k: Top ranks have more influence
   * - Higher k: Scores more evenly distributed across ranks
   *
   * The value 60 is the empirically validated default from the original
   * RRF paper (Cormack, Clarke & Büttcher, 2009).
   */
  k: number;
  /**
   * Optional weights for each retrieval source.
   *
   * When provided, RRF scores are multiplied by these weights:
   * - dense: Weight for vector/semantic search results
   * - bm25: Weight for keyword/BM25 search results
   *
   * Default behavior (no weights): Equal contribution from both sources.
   */
  weights?: {
    /** Weight multiplier for dense vector results (default: 1.0) */
    dense: number;
    /** Weight multiplier for BM25 keyword results (default: 1.0) */
    bm25: number;
  };
}

/**
 * Options for initializing the FusionService.
 *
 * The FusionService wraps both SearchService (dense) and BM25SearchService
 * to provide hybrid search with RRF-based result fusion.
 */
export interface FusionServiceOptions {
  /** Project ID to scope searches */
  projectId: string;
  /** RRF tuning parameters */
  fusionConfig?: Partial<FusionConfig>;
  /** Override default SearchService options */
  denseOptions?: Partial<Omit<SearchServiceOptions, 'projectId'>>;
  /** Override default BM25ServiceOptions */
  bm25Options?: Partial<Omit<BM25ServiceOptions, 'projectId'>>;
}
