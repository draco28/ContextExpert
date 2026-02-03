/**
 * RAG Engine Types
 *
 * Type definitions for the RAG (Retrieval-Augmented Generation) pipeline.
 * Includes configuration schema, runtime options, and result types.
 *
 * ARCHITECTURE NOTE:
 * The RAG engine wraps the existing FusionService (hybrid search) with
 * ContextAI SDK's RAGEngineImpl for orchestration and XMLAssembler for
 * context formatting. This adapter pattern allows reuse of existing
 * search infrastructure while gaining SDK features.
 */

import { z } from 'zod';
import type { SearchResultWithContext } from '../search/types.js';

// ============================================================================
// CONFIGURATION SCHEMA
// ============================================================================

/**
 * Ordering strategy for assembled context.
 *
 * How chunks are ordered in the final context affects LLM attention:
 * - 'relevance': Most relevant first (traditional ranking)
 * - 'sandwich': Most relevant at start AND end (better for long contexts)
 * - 'chronological': By file/line order (good for code understanding)
 */
export const OrderingStrategySchema = z.enum(['relevance', 'sandwich', 'chronological']);
export type OrderingStrategy = z.infer<typeof OrderingStrategySchema>;

/**
 * RAG configuration schema for config.toml [rag] section.
 *
 * All fields have sensible defaults, making this section optional.
 *
 * @example config.toml
 * ```toml
 * [rag]
 * max_tokens = 4000
 * final_k = 5
 * ordering = "sandwich"
 * ```
 */
export const RAGConfigSchema = z.object({
  /**
   * Maximum tokens in assembled context.
   *
   * This budget determines how many search results can fit in the
   * LLM context window. Larger values provide more context but:
   * - Cost more (tokens = $$$)
   * - May dilute relevance with less relevant content
   * - Risk exceeding model limits
   *
   * Default: 4000 (fits comfortably in 8k-32k context windows)
   */
  max_tokens: z.number().int().min(500).max(16000).default(4000),

  /**
   * Number of candidates to retrieve initially.
   *
   * More candidates = better recall but slower. The reranker (if enabled)
   * processes these to select final_k results.
   *
   * Default: 20 (good balance for code search)
   */
  retrieve_k: z.number().int().min(5).max(100).default(20),

  /**
   * Final number of results after reranking.
   *
   * These are assembled into the context. Fewer = more focused answers,
   * more = broader coverage but potential noise.
   *
   * Default: 5 (typical for RAG applications)
   */
  final_k: z.number().int().min(1).max(20).default(5),

  /**
   * Enable LLM-based query enhancement.
   *
   * When true, queries are rewritten for better retrieval:
   * - Expands abbreviations
   * - Adds synonyms
   * - Fixes typos
   *
   * Requires LLM calls, adding latency and cost.
   * Default: false (fast mode)
   */
  enhance_query: z.boolean().default(false),

  /**
   * Ordering strategy for assembled context.
   *
   * Default: 'sandwich' (puts most relevant at start AND end,
   * leveraging the "lost in the middle" phenomenon where LLMs
   * pay less attention to middle content)
   */
  ordering: OrderingStrategySchema.default('sandwich'),
});

export type RAGConfig = z.infer<typeof RAGConfigSchema>;

// ============================================================================
// RUNTIME OPTIONS
// ============================================================================

/**
 * Options for RAG engine search at runtime.
 *
 * These override config.toml settings for individual searches.
 * Useful for different query types (broad vs. focused).
 */
export interface RAGEngineOptions {
  /** Override retrieve_k (initial retrieval count) */
  retrieveK?: number;

  /** Override final_k (results after reranking) */
  finalK?: number;

  /** Override max_tokens budget */
  maxTokens?: number;

  /** Override enhance_query flag */
  enhanceQuery?: boolean;

  /** Skip reranking even if enabled in config */
  skipRerank?: boolean;

  /** Override ordering strategy */
  ordering?: OrderingStrategy;
}

// ============================================================================
// RESULT TYPES
// ============================================================================

/**
 * Source attribution for citations.
 *
 * Each source represents a chunk used in the assembled context.
 * Can be used to generate citations or link back to source files.
 */
export interface RAGSource {
  /** 1-based index in assembled context (for "[1]" style citations) */
  index: number;

  /** File path relative to project root */
  filePath: string;

  /** Line range in source file */
  lineRange: {
    start: number;
    end: number;
  };

  /** Relevance score (0-1, higher = more relevant) */
  score: number;

  /** Programming language if applicable, null for non-code */
  language: string | null;

  /** Content type classification */
  fileType: 'code' | 'docs' | 'config' | 'unknown';
}

/**
 * Timing breakdown for performance analysis.
 */
export interface RAGTimingMetadata {
  /** Time spent in retrieval (search + rerank) */
  retrievalMs: number;

  /** Time spent in context assembly */
  assemblyMs: number;

  /** Total end-to-end time */
  totalMs: number;
}

/**
 * Result from RAG engine search.
 *
 * Contains everything needed for LLM prompting and citation.
 */
export interface RAGSearchResult {
  /**
   * Assembled context (XML formatted) ready for LLM prompt.
   *
   * Structure:
   * ```xml
   * <sources>
   *   <source id="1" file="src/auth.ts" lines="42-67" score="0.95">
   *     function authenticate(user: User) { ... }
   *   </source>
   *   ...
   * </sources>
   * ```
   */
  content: string;

  /** Estimated token count of assembled content */
  estimatedTokens: number;

  /** Source attributions for citations */
  sources: RAGSource[];

  /**
   * Raw search results before assembly.
   *
   * Useful for debugging or custom processing.
   */
  rawResults: SearchResultWithContext[];

  /** Performance metadata */
  metadata: RAGTimingMetadata & {
    /** Number of results retrieved (before assembly filtering) */
    resultsRetrieved: number;

    /** Number of results included in assembly */
    resultsAssembled: number;

    /** Whether result came from cache */
    fromCache: boolean;
  };
}

// ============================================================================
// ERROR TYPES
// ============================================================================

/**
 * Error codes for RAG engine failures.
 *
 * Used in RAGEngineError for programmatic error handling.
 */
export const RAGErrorCodes = {
  /** Embedding provider failed to initialize */
  EMBEDDING_UNAVAILABLE: 'EMBEDDING_UNAVAILABLE',
  /** Project has no indexed content */
  PROJECT_NOT_INDEXED: 'PROJECT_NOT_INDEXED',
  /** Search/retrieval operation failed */
  RETRIEVAL_FAILED: 'RETRIEVAL_FAILED',
  /** Context assembly failed */
  ASSEMBLY_FAILED: 'ASSEMBLY_FAILED',
  /** Invalid configuration */
  CONFIG_ERROR: 'CONFIG_ERROR',
} as const;

export type RAGErrorCode = (typeof RAGErrorCodes)[keyof typeof RAGErrorCodes];

/**
 * Error thrown when RAG engine encounters a failure.
 *
 * Includes structured error code for programmatic handling.
 */
export class RAGEngineError extends Error {
  public readonly code: RAGErrorCode;
  public readonly cause?: Error;

  constructor(code: RAGErrorCode, message: string, cause?: Error) {
    super(message);
    this.name = 'RAGEngineError';
    this.code = code;
    this.cause = cause;

    // Maintains proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RAGEngineError);
    }
  }

  /**
   * Factory for embedding errors.
   */
  static embeddingUnavailable(reason: string, cause?: Error): RAGEngineError {
    return new RAGEngineError(
      RAGErrorCodes.EMBEDDING_UNAVAILABLE,
      `Failed to initialize embedding provider: ${reason}`,
      cause
    );
  }

  /**
   * Factory for project not indexed errors.
   */
  static projectNotIndexed(projectId: string): RAGEngineError {
    return new RAGEngineError(
      RAGErrorCodes.PROJECT_NOT_INDEXED,
      `Project "${projectId}" has no indexed content. Run 'ctx index' first.`
    );
  }

  /**
   * Factory for retrieval errors.
   */
  static retrievalFailed(reason: string, cause?: Error): RAGEngineError {
    return new RAGEngineError(
      RAGErrorCodes.RETRIEVAL_FAILED,
      `RAG retrieval failed: ${reason}`,
      cause
    );
  }

  /**
   * Factory for assembly errors.
   */
  static assemblyFailed(reason: string, cause?: Error): RAGEngineError {
    return new RAGEngineError(
      RAGErrorCodes.ASSEMBLY_FAILED,
      `Context assembly failed: ${reason}`,
      cause
    );
  }

  /**
   * Factory for configuration errors.
   */
  static configError(reason: string, cause?: Error): RAGEngineError {
    return new RAGEngineError(
      RAGErrorCodes.CONFIG_ERROR,
      `RAG configuration error: ${reason}`,
      cause
    );
  }
}

// ============================================================================
// RAG Error Subtypes
// ============================================================================

/**
 * Error thrown when RAG retrieval operation fails.
 *
 * Use this for search/query failures from the SDK or database.
 */
export class RetrievalError extends RAGEngineError {
  constructor(reason: string, cause?: Error) {
    super(RAGErrorCodes.RETRIEVAL_FAILED, `RAG retrieval failed: ${reason}`, cause);
    this.name = 'RetrievalError';
  }
}

/**
 * Error thrown when context assembly fails.
 *
 * Use this for failures during chunk assembly, token budget calculations,
 * or context window management.
 */
export class AssemblyError extends RAGEngineError {
  constructor(reason: string, cause?: Error) {
    super(RAGErrorCodes.ASSEMBLY_FAILED, `Context assembly failed: ${reason}`, cause);
    this.name = 'AssemblyError';
  }
}

/**
 * Error thrown when result formatting fails.
 *
 * Use this for failures during output transformation, citation formatting,
 * or response structuring.
 */
export class FormattingError extends RAGEngineError {
  constructor(reason: string, cause?: Error) {
    super(RAGErrorCodes.ASSEMBLY_FAILED, `Result formatting failed: ${reason}`, cause);
    this.name = 'FormattingError';
  }
}

/**
 * Error thrown when RAG configuration is invalid.
 *
 * Use this for invalid config values, missing required fields,
 * or schema validation failures.
 */
export class ConfigError extends RAGEngineError {
  constructor(reason: string, cause?: Error) {
    super(RAGErrorCodes.CONFIG_ERROR, `RAG configuration error: ${reason}`, cause);
    this.name = 'ConfigError';
  }
}

// ============================================================================
// ROUTING RAG ENGINE TYPES
// ============================================================================

/**
 * Re-export routing types for convenience.
 *
 * These are the core types from query-router.ts that RoutingRAGEngine uses.
 * Re-exporting here allows consumers to import everything from types.ts.
 */
export type {
  ProjectMetadata,
  RoutingResult,
  LLMProjectRouterConfig,
} from './query-router.js';

/**
 * Configuration for RoutingRAGEngine.
 *
 * The RoutingRAGEngine wraps ContextExpertRAGEngine with automatic
 * query routing. It manages a pool of engines (one per project) and
 * uses MultiProjectFusionService for cross-project searches.
 */
export interface RoutingRAGEngineConfig {
  /**
   * Application configuration.
   *
   * Used to create ContextExpertRAGEngine instances for each project.
   * Must include embedding and search configuration.
   */
  config: import('../config/schema.js').Config;

  /**
   * Embedding provider for multi-project search.
   *
   * Used to embed queries before searching with MultiProjectFusionService.
   * Must match the provider used during indexing.
   */
  embeddingProvider: import('@contextaisdk/rag').EmbeddingProvider;

  /**
   * Embedding dimensions.
   *
   * Must match the dimensions of the embedding model used during indexing.
   * Common values: 768 (BGE-small), 1024 (BGE-base), 1536 (OpenAI ada-002)
   */
  dimensions: number;

  /**
   * Force RAG search even for GENERAL/ambiguous queries.
   *
   * When true (default), the engine ALWAYS attempts search when projects exist,
   * regardless of how the query is classified. This ensures the LLM always
   * has context available to use (or ignore) as appropriate.
   *
   * When false, low-confidence routing may skip search for GENERAL queries.
   *
   * Default: true (force RAG)
   */
  forceRAG?: boolean;

  /**
   * Optional LLM provider for intelligent routing.
   *
   * When provided, the router can use LLM to determine which project(s)
   * to search for ambiguous queries. When null, only heuristic routing
   * is used (keyword matching, project name detection).
   *
   * Default: null (heuristic-only routing)
   */
  llmProvider?: import('@contextaisdk/core').LLMProvider | null;

  /**
   * Configuration for the underlying router.
   *
   * Controls confidence thresholds, LLM timeout, retry behavior.
   */
  routerConfig?: import('./query-router.js').LLMProjectRouterConfig;
}

/**
 * Routing metadata included in RoutingRAGResult.
 *
 * Provides visibility into how the query was routed, useful for
 * debugging and logging.
 */
export interface RoutingMetadata {
  /**
   * Routing method used to determine target project(s).
   *
   * - 'heuristic': Project name detected in query (fast, no LLM)
   * - 'llm': LLM determined best project(s) (slower, smarter)
   * - 'fallback_all': Router uncertain, searched all projects
   * - 'force-rag': forceRAG overrode low confidence, searched anyway
   */
  method: 'heuristic' | 'llm' | 'fallback_all' | 'force-rag';

  /** Project IDs that were searched */
  projectIds: string[];

  /** Confidence in routing decision (0-1) */
  confidence: number;

  /** Human-readable explanation of routing decision */
  reason: string;
}

/**
 * Extended RAG result with routing metadata.
 *
 * Includes everything from RAGSearchResult plus routing information.
 */
export interface RoutingRAGResult extends RAGSearchResult {
  /** Routing decision metadata */
  routing: RoutingMetadata;
}
