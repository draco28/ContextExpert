/**
 * RAG Engine Implementation
 *
 * Integrates ContextAI SDK's RAGEngineImpl with Context_Expert's
 * existing search infrastructure (FusionService).
 *
 * ARCHITECTURE:
 * ```
 * User Query
 *     │
 *     ▼
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  RAGEngineImpl (SDK Orchestrator)                               │
 * │    │                                                            │
 * │    ├── [Optional] QueryEnhancer (rewrite/expand query)          │
 * │    │                                                            │
 * │    ├── FusionServiceAdapter ─────────────────────────┐          │
 * │    │                                                 │          │
 * │    │   ┌─────────────────────────────────────────────▼────────┐ │
 * │    │   │  FusionService (existing infrastructure)             │ │
 * │    │   │    ├── DenseRetriever (vector search)                │ │
 * │    │   │    ├── BM25Retriever (keyword search)                │ │
 * │    │   │    ├── RRF Fusion (combine results)                  │ │
 * │    │   │    └── [Optional] BGE Reranker                       │ │
 * │    │   └──────────────────────────────────────────────────────┘ │
 * │    │                                                            │
 * │    └── XMLAssembler (format for LLM)                            │
 * │                                                                 │
 * └─────────────────────────────────────────────────────────────────┘
 *     │
 *     ▼
 * RAGSearchResult (XML context + sources + metadata)
 * ```
 *
 * WHY ADAPTER PATTERN?
 * - Reuses existing FusionService (hybrid search, RRF, reranking)
 * - Gains SDK orchestration (caching, timing, abort signals)
 * - Gains XMLAssembler (token budgeting, deduplication, ordering)
 * - Single source of truth for search logic
 *
 * @example
 * ```typescript
 * const config = await loadConfig();
 * const engine = await createRAGEngine(config, 'my-project');
 *
 * const result = await engine.search('How does authentication work?');
 * console.log(result.content);   // XML context for LLM
 * console.log(result.sources);   // Citation data
 * ```
 */

import {
  RAGEngineImpl,
  type Retriever,
  type RetrievalResult,
  type RetrievalOptions,
  type RAGResult,
  type SourceAttribution,
  type OrderingStrategy as SDKOrderingStrategy,
  type EmbeddingProvider,
} from '@contextaisdk/rag';

import { createAssembler } from './assembler.js';

import type { Config } from '../config/schema.js';
import { createEmbeddingProvider } from '../indexer/embedder/provider.js';
import { createFusionService, type FusionService } from '../search/index.js';
import type { SearchResultWithContext } from '../search/types.js';
import {
  RAGConfigSchema,
  RAGEngineError,
  type RAGConfig,
  type RAGEngineOptions,
  type RAGSearchResult,
  type RAGSource,
  type OrderingStrategy,
} from './types.js';

// ============================================================================
// ADAPTER: FusionService → SDK Retriever Interface
// ============================================================================

/**
 * Adapter that wraps FusionService to implement SDK's Retriever interface.
 *
 * This is the ADAPTER PATTERN in action:
 * - FusionService has: search(query, options) → SearchResultWithContext[]
 * - SDK expects: retrieve(query, options) → RetrievalResult[]
 *
 * The adapter bridges these interfaces, allowing our existing search
 * infrastructure to work with the SDK's RAGEngineImpl.
 *
 * @example
 * ```typescript
 * const fusionService = createFusionService(...);
 * const retriever = new FusionServiceAdapter(fusionService);
 *
 * // Now usable with RAGEngineImpl
 * const engine = new RAGEngineImpl({ retriever, assembler });
 * ```
 */
export class FusionServiceAdapter implements Retriever {
  readonly name = 'FusionServiceAdapter';

  private readonly fusionService: FusionService;
  /** Promise-based init to prevent race conditions with concurrent retrieve() calls */
  private initPromise: Promise<void> | null = null;

  constructor(fusionService: FusionService) {
    this.fusionService = fusionService;
  }

  /**
   * Retrieve relevant chunks for a query.
   *
   * Implements SDK's Retriever interface by:
   * 1. Delegating to FusionService.search()
   * 2. Converting SearchResultWithContext[] → RetrievalResult[]
   *
   * @param query - Search query
   * @param options - Retrieval options (topK, minScore, filters)
   * @returns Results in SDK format
   */
  async retrieve(
    query: string,
    options?: RetrievalOptions
  ): Promise<RetrievalResult[]> {
    // Lazy initialization with Promise to handle concurrent calls safely
    // All concurrent calls share the same promise, preventing multiple inits
    if (!this.initPromise) {
      this.initPromise = this.fusionService.ensureInitialized();
    }
    await this.initPromise;

    const topK = options?.topK ?? 20;
    const minScore = options?.minScore ?? 0;

    // Delegate to existing FusionService
    // This does: dense + BM25 → RRF fusion → optional reranking
    const results = await this.fusionService.search(query, {
      topK,
      minScore,
    });

    // Convert to SDK format
    return results.map((r) => this.toRetrievalResult(r));
  }

  /**
   * Convert our SearchResultWithContext to SDK's RetrievalResult.
   *
   * Maps fields while preserving all metadata for later use.
   */
  private toRetrievalResult(result: SearchResultWithContext): RetrievalResult {
    return {
      id: result.id,
      chunk: {
        id: result.id,
        content: result.content,
        metadata: {
          // Core location info
          filePath: result.filePath,
          fileType: result.fileType,
          language: result.language,
          startLine: result.lineRange.start,
          endLine: result.lineRange.end,
          // Spread any additional metadata
          ...result.metadata,
        },
      },
      score: result.score,
    };
  }
}

// ============================================================================
// RAG ENGINE WRAPPER
// ============================================================================

/**
 * Context_Expert's RAG Engine wrapper.
 *
 * Wraps SDK's RAGEngineImpl with:
 * - Simplified API (fewer options to think about)
 * - Our result format (RAGSearchResult instead of RAGResult)
 * - Our error types (RAGEngineError)
 *
 * This is the FACADE PATTERN: simplifying a complex subsystem interface.
 */
export class ContextExpertRAGEngine {
  private readonly engine: RAGEngineImpl;
  private readonly fusionService: FusionService;
  private readonly config: RAGConfig;

  constructor(
    engine: RAGEngineImpl,
    fusionService: FusionService,
    config: RAGConfig
  ) {
    this.engine = engine;
    this.fusionService = fusionService;
    this.config = config;
  }

  /**
   * Search for relevant context and assemble it for LLM consumption.
   *
   * @param query - Natural language query
   * @param options - Override default options
   * @returns Assembled context with sources and metadata
   *
   * @example
   * ```typescript
   * const result = await engine.search('How does auth middleware work?');
   *
   * // Use in LLM prompt
   * const systemPrompt = `Answer using this context:\n${result.content}`;
   *
   * // Show citations
   * for (const source of result.sources) {
   *   console.log(`[${source.index}] ${source.filePath}:${source.lineRange.start}`);
   * }
   * ```
   */
  async search(
    query: string,
    options?: RAGEngineOptions
  ): Promise<RAGSearchResult> {
    const startTime = performance.now();

    // Merge options with config
    const topK = options?.finalK ?? this.config.final_k;
    const maxTokens = options?.maxTokens ?? this.config.max_tokens;
    const ordering = options?.ordering ?? this.config.ordering;

    try {
      // Delegate to SDK's RAGEngineImpl
      const result = await this.engine.search(query, {
        topK,
        maxTokens,
        ordering: ordering as SDKOrderingStrategy,
        rerank: !options?.skipRerank,
        enhance: options?.enhanceQuery ?? this.config.enhance_query,
      });

      const endTime = performance.now();
      return this.toRAGSearchResult(result, endTime - startTime);
    } catch (error) {
      // Wrap SDK errors in our error type
      if (error instanceof Error) {
        throw RAGEngineError.retrievalFailed(error.message, error);
      }
      throw RAGEngineError.retrievalFailed(String(error));
    }
  }

  /**
   * Pre-warm the engine (load indexes, models, etc.).
   *
   * Call during application startup to avoid first-request latency.
   * Both the fusion service and SDK engine are warmed up.
   */
  async warmUp(): Promise<void> {
    await Promise.all([
      this.fusionService.ensureInitialized(),
      this.engine.warmUp(),
    ]);
  }

  /**
   * Get the project ID this engine is scoped to.
   */
  getProjectId(): string {
    return this.fusionService.getProjectId();
  }

  /**
   * Convert SDK RAGResult to our RAGSearchResult format.
   *
   * Transforms:
   * - SourceAttribution[] → RAGSource[] (simpler, 1-indexed)
   * - RAGSearchMetadata → our metadata shape
   */
  private toRAGSearchResult(result: RAGResult, totalMs: number): RAGSearchResult {
    // Convert SDK sources to our format
    const sources: RAGSource[] = result.sources.map((s, idx) =>
      this.toRAGSource(s, idx)
    );

    // Extract raw results for debugging
    const rawResults: SearchResultWithContext[] = result.retrievalResults.map(
      (r) => this.toSearchResultWithContext(r)
    );

    return {
      content: result.content,
      estimatedTokens: result.estimatedTokens,
      sources,
      rawResults,
      metadata: {
        retrievalMs: result.metadata.timings.retrievalMs,
        assemblyMs: result.metadata.timings.assemblyMs,
        totalMs,
        resultsRetrieved: result.metadata.retrievedCount,
        resultsAssembled: result.metadata.assembledCount,
        fromCache: result.metadata.fromCache,
      },
    };
  }

  /**
   * Convert SDK SourceAttribution to our RAGSource.
   */
  private toRAGSource(source: SourceAttribution, index: number): RAGSource {
    // Extract from metadata (we put it there in adapter)
    const metadata = source.metadata ?? {};

    return {
      index: index + 1, // 1-indexed for human-readable citations
      filePath: source.source ?? (metadata.filePath as string) ?? '',
      lineRange: {
        start: (metadata.startLine as number) ?? 0,
        end: (metadata.endLine as number) ?? 0,
      },
      score: source.score,
      language: (metadata.language as string) ?? null,
      fileType: (metadata.fileType as RAGSource['fileType']) ?? 'unknown',
    };
  }

  /**
   * Convert SDK RetrievalResult back to SearchResultWithContext.
   *
   * Used for rawResults in response (debugging/custom processing).
   */
  private toSearchResultWithContext(result: RetrievalResult): SearchResultWithContext {
    const metadata = result.chunk.metadata ?? {};

    return {
      id: result.id,
      score: result.score,
      content: result.chunk.content,
      filePath: (metadata.filePath as string) ?? '',
      fileType: (metadata.fileType as SearchResultWithContext['fileType']) ?? 'unknown',
      language: (metadata.language as string) ?? null,
      lineRange: {
        start: (metadata.startLine as number) ?? 0,
        end: (metadata.endLine as number) ?? 0,
      },
      metadata: Object.fromEntries(
        Object.entries(metadata).filter(
          ([key]) =>
            !['filePath', 'fileType', 'language', 'startLine', 'endLine'].includes(key)
        )
      ),
    };
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Default RAG configuration when not specified in config.toml.
 *
 * These values are used when no [rag] section exists.
 */
const DEFAULT_RAG_CONFIG: RAGConfig = {
  max_tokens: 4000,
  retrieve_k: 20,
  final_k: 5,
  enhance_query: false,
  ordering: 'sandwich',
};

/**
 * Create a RAG engine for a project.
 *
 * This is the main entry point for RAG functionality.
 * It wires together:
 * 1. EmbeddingProvider (for query embedding)
 * 2. FusionService (hybrid search with reranking)
 * 3. FusionServiceAdapter (bridges to SDK interface)
 * 4. XMLAssembler (formats context with token budget)
 * 5. RAGEngineImpl (SDK orchestrator)
 *
 * @param config - Application configuration (from loadConfig())
 * @param projectId - Project ID to search within
 * @param options - Optional runtime overrides
 * @returns Configured RAG engine
 *
 * @throws RAGEngineError if embedding provider fails to initialize
 *
 * @example
 * ```typescript
 * const config = await loadConfig();
 * const engine = await createRAGEngine(config, 'my-project');
 *
 * // Optionally pre-warm for faster first search
 * await engine.warmUp();
 *
 * // Search
 * const result = await engine.search('How does the auth flow work?');
 * console.log(result.content);  // XML context
 * console.log(result.sources);  // Citations
 * ```
 */
export async function createRAGEngine(
  config: Config,
  projectId: string,
  options?: RAGEngineOptions
): Promise<ContextExpertRAGEngine> {
  // =========================================================================
  // Step 1: Parse RAG config (merge defaults + config.toml + runtime options)
  // =========================================================================

  // Parse any [rag] section from config, falling back to defaults
  const configRag = (config as unknown as { rag?: unknown }).rag;
  const parsedConfigRag = configRag
    ? RAGConfigSchema.parse(configRag)
    : DEFAULT_RAG_CONFIG;

  // Merge with runtime options
  const ragConfig: RAGConfig = {
    ...parsedConfigRag,
    max_tokens: options?.maxTokens ?? parsedConfigRag.max_tokens,
    retrieve_k: options?.retrieveK ?? parsedConfigRag.retrieve_k,
    final_k: options?.finalK ?? parsedConfigRag.final_k,
    enhance_query: options?.enhanceQuery ?? parsedConfigRag.enhance_query,
    ordering: options?.ordering ?? parsedConfigRag.ordering,
  };

  // =========================================================================
  // Step 2: Create embedding provider
  // =========================================================================

  let embeddingProvider: EmbeddingProvider;
  let dimensions: number;

  try {
    const result = await createEmbeddingProvider(config.embedding);
    embeddingProvider = result.provider;
    dimensions = result.dimensions;
  } catch (error) {
    throw RAGEngineError.embeddingUnavailable(
      error instanceof Error ? error.message : String(error),
      error instanceof Error ? error : undefined
    );
  }

  // =========================================================================
  // Step 3: Create FusionService (existing hybrid search infrastructure)
  // =========================================================================

  const fusionService = createFusionService(
    projectId,
    embeddingProvider,
    config.search,
    {
      denseOptions: { dimensions },
    }
  );

  // =========================================================================
  // Step 4: Create adapter (bridges FusionService → SDK Retriever)
  // =========================================================================

  const retriever = new FusionServiceAdapter(fusionService);

  // =========================================================================
  // Step 5: Create XMLAssembler (formats context for LLM)
  // =========================================================================

  const assembler = createAssembler({
    maxTokens: ragConfig.max_tokens,
    ordering: ragConfig.ordering,
  });

  // =========================================================================
  // Step 6: Create SDK's RAGEngineImpl
  // =========================================================================

  const engine = new RAGEngineImpl({
    name: `RAGEngine:${projectId}`,
    retriever,
    assembler,
    defaults: {
      topK: ragConfig.final_k,
      rerank: false, // FusionService already does reranking
      enhance: ragConfig.enhance_query,
    },
  });

  // =========================================================================
  // Step 7: Return our wrapper
  // =========================================================================

  return new ContextExpertRAGEngine(engine, fusionService, ragConfig);
}
