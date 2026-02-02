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
  /** Filter by project ID(s) - results must match ANY of the provided IDs (OR logic) */
  projectIds?: string[];
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
 * Dense search options for FusionService.
 * Dimensions is required to ensure embedding configuration is explicit.
 */
export interface DenseSearchOptions {
  /** Embedding dimensions - REQUIRED, must match indexed data */
  dimensions: number;
  /** Use HNSW index for O(log n) search (default: true) */
  useHNSW?: boolean;
  /** HNSW index tuning parameters */
  hnswConfig?: SearchServiceOptions['hnswConfig'];
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
  /** Dense search options - dimensions is REQUIRED */
  denseOptions: DenseSearchOptions;
  /** Override default BM25ServiceOptions */
  bm25Options?: Partial<Omit<BM25ServiceOptions, 'projectId'>>;
}

/**
 * Configuration for BGE cross-encoder reranking.
 *
 * Reranking improves search precision by scoring query-document pairs
 * with a cross-encoder model after initial retrieval. Cross-encoders
 * process query and document together, capturing fine-grained interactions
 * that bi-encoder embeddings miss.
 *
 * Pipeline: Query → Hybrid Search (top N) → BGE Rerank → Final Results (top K)
 */
export interface RerankConfig {
  /**
   * Reranker model identifier (default: 'Xenova/bge-reranker-base').
   *
   * Available models:
   * - 'Xenova/bge-reranker-base' (~110MB, good balance of speed/quality)
   * - 'Xenova/bge-reranker-large' (~330MB, best quality, slower)
   */
  model?: string;
  /**
   * Number of candidates to rerank (default: 50).
   *
   * After hybrid search, this many top results are passed to the reranker.
   * Research suggests ~50 candidates provides good precision/recall:
   * - Too few (10-20): May miss relevant documents ranked lower initially
   * - Too many (100+): Diminishing returns, increased latency
   */
  candidateCount?: number;
  /**
   * Device for model inference (default: 'auto').
   *
   * - 'cpu': Force CPU inference (slower but universal)
   * - 'gpu': Attempt GPU acceleration (may not be available)
   * - 'auto': Automatically detect best option
   */
  device?: 'cpu' | 'gpu' | 'auto';
}

// ============================================================================
// Result Formatting Types
// ============================================================================

/**
 * Options for formatting search results.
 */
export interface FormatOptions {
  /** Maximum snippet length in characters (default: 200) */
  snippetLength?: number;
  /** Show project name prefix for cross-project searches (default: false) */
  showProject?: boolean;
  /** Show relevance score (default: true) */
  showScore?: boolean;
  /** Show line numbers in file:start-end format (default: true) */
  showLineNumbers?: boolean;
}

/**
 * JSON-serializable search result for programmatic consumption.
 *
 * Used when outputting results in JSON format (e.g., `--json` CLI flag).
 */
export interface FormattedResultJSON {
  /** Similarity score (0-1, higher = more relevant) */
  score: number;
  /** Relative file path from project root */
  filePath: string;
  /** Start line number in source file */
  lineStart: number;
  /** End line number in source file */
  lineEnd: number;
  /** Matched chunk text content */
  content: string;
  /** Programming language (null for non-code) */
  language: string | null;
  /** Content type classification */
  fileType: 'code' | 'docs' | 'config' | 'unknown';
  /** Project ID (included when showProject option is true) */
  projectId?: string;
  /** Project name (included when showProject option is true) */
  projectName?: string;
}

// ============================================================================
// Multi-Project Search Types
// ============================================================================

/**
 * Options for loading multiple project stores.
 *
 * Used with MultiProjectVectorStoreManager to load vector stores
 * for cross-project search.
 */
export interface MultiProjectLoadOptions {
  /** Project IDs to load */
  projectIds: string[];
  /** Embedding dimensions (must be consistent across all projects) */
  dimensions: number;
  /** Use HNSW index for O(log n) search (default: true) */
  useHNSW?: boolean;
  /** HNSW index tuning parameters */
  hnswConfig?: SearchServiceOptions['hnswConfig'];
}

/**
 * Progress during multi-project store loading.
 *
 * Extends IndexBuildProgress with project context so UI can show
 * "Loading project 2/5: my-project (150/500 chunks)".
 */
export interface MultiProjectLoadProgress extends IndexBuildProgress {
  /** ID of the project currently being loaded */
  projectId: string;
  /** Human-readable project name */
  projectName: string;
  /** 1-indexed position in the load queue */
  projectIndex: number;
  /** Total number of projects to load */
  totalProjects: number;
}

/**
 * Search result with project attribution.
 *
 * Extends SearchResultWithContext to include which project the result
 * came from. Essential for cross-project search display.
 */
export interface MultiProjectSearchResult extends SearchResultWithContext {
  /** Project ID this result came from */
  projectId: string;
  /** Human-readable project name */
  projectName: string;
}

/**
 * Options for multi-project search.
 *
 * Extends single-project search options with parameters for
 * cross-project result merging.
 */
export interface MultiProjectSearchOptions {
  /**
   * Number of results to retrieve per project before merging (default: 20).
   *
   * Over-fetching improves RRF quality - documents that appear in multiple
   * projects' results get boosted in the final ranking.
   */
  topKPerProject?: number;
  /** Final number of results after RRF merge (default: 10) */
  topK?: number;
  /** Minimum similarity score threshold (0-1 for cosine) */
  minScore?: number;
  /** Filter by content type */
  fileType?: 'code' | 'docs' | 'config';
  /** Filter by programming language */
  language?: string;
}

/**
 * Result of embedding model validation across projects.
 *
 * All projects in a cross-project search must use the same embedding model
 * and dimensions. This ensures vectors are comparable.
 */
export interface EmbeddingValidation {
  /** Whether all projects are compatible */
  valid: boolean;
  /**
   * Details of mismatched projects (only present if valid=false).
   *
   * Each entry describes a project that differs from the reference.
   */
  errors?: Array<{
    projectId: string;
    projectName: string;
    embeddingModel: string | null;
    embeddingDimensions: number;
  }>;
  /** Expected dimensions based on first project */
  expectedDimensions?: number;
  /** Expected model name based on first project */
  expectedModel?: string | null;
}

// ============================================================================
// Multi-Project BM25 Search Types
// ============================================================================

/**
 * Options for loading multiple project BM25 retrievers.
 *
 * Unlike vector stores, BM25 doesn't require embedding validation since
 * it uses text-based tokenization rather than fixed-dimension vectors.
 */
export interface MultiProjectBM25LoadOptions {
  /** Project IDs to load */
  projectIds: string[];
  /** BM25 configuration (optional, uses defaults if not provided) */
  bm25Config?: BM25Config;
}

// ============================================================================
// Multi-Project Fusion Search Types
// ============================================================================

/**
 * Options for loading multiple project stores for fusion search.
 *
 * Combines requirements from both vector (dimensions) and BM25 (config) loading.
 * Essentially a union of MultiProjectLoadOptions and MultiProjectBM25LoadOptions.
 */
export interface MultiProjectFusionLoadOptions {
  /** Project IDs to load */
  projectIds: string[];
  /** Embedding dimensions (must be consistent across all projects) */
  dimensions: number;
  /** Use HNSW index for O(log n) search (default: true) */
  useHNSW?: boolean;
  /** HNSW index tuning parameters */
  hnswConfig?: SearchServiceOptions['hnswConfig'];
  /** BM25 configuration (optional, uses defaults if not provided) */
  bm25Config?: BM25Config;
}

/**
 * Configuration for multi-project fusion service.
 *
 * Controls RRF fusion behavior and optional reranking.
 */
export interface MultiProjectFusionConfig {
  /**
   * RRF configuration for merging dense vs BM25 results.
   * Uses DEFAULT_RRF_K (60) if not specified.
   */
  fusionConfig?: Partial<FusionConfig>;
  /** Enable cross-encoder reranking after fusion (default: false) */
  rerank?: boolean;
  /** Reranker configuration (only used if rerank is true) */
  rerankConfig?: RerankConfig;
}

/**
 * Options for multi-project fusion search queries.
 *
 * Extends MultiProjectSearchOptions - same filtering capabilities,
 * but used in the context of hybrid (dense + BM25) search.
 */
export interface MultiProjectFusionSearchOptions extends MultiProjectSearchOptions {
  // Inherits all options from MultiProjectSearchOptions:
  // - topKPerProject: Results per project before RRF (default: 20)
  // - topK: Final results after all merging (default: 10)
  // - minScore: Minimum similarity threshold
  // - fileType: Filter by 'code' | 'docs' | 'config'
  // - language: Filter by programming language
}
