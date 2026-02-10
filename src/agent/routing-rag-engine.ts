/**
 * Routing RAG Engine
 *
 * Wraps ContextExpertRAGEngine with automatic query routing to handle
 * both single-project and multi-project searches seamlessly.
 *
 * ARCHITECTURE:
 * ```
 * User Query
 *     │
 *     ▼
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  RoutingRAGEngine                                               │
 * │     │                                                           │
 * │     ├── LLMProjectRouter (routing decisions)                    │
 * │     │     └── QueryIntentClassifier → project selection         │
 * │     │                                                           │
 * │     ├── Engine Pool: Map<projectId, ContextExpertRAGEngine>     │
 * │     │     └── Lazily creates engines per project                │
 * │     │                                                           │
 * │     ├── MultiProjectFusionService (for 2+ projects)             │
 * │     │     └── Dense + BM25 → RRF fusion → optional rerank       │
 * │     │                                                           │
 * │     └── forceRAG: true (default)                                │
 * │           └── Always search when projects exist                 │
 * └─────────────────────────────────────────────────────────────────┘
 *     │
 *     ▼
 * RoutingRAGResult (search results + routing metadata)
 * ```
 *
 * WHY WRAPPER PATTERN?
 * - Follows ContextAI SDK's AdaptiveRAG pattern
 * - Encapsulates routing logic (reusable outside CLI)
 * - Manages engine lifecycle (dispose all at once)
 * - Provides consistent interface regardless of single/multi project
 *
 * @example
 * ```typescript
 * const engine = new RoutingRAGEngine({
 *   config,
 *   embeddingProvider,
 *   dimensions: 1024,
 * });
 *
 * // Search with automatic routing
 * const result = await engine.search(
 *   'How does auth work?',
 *   projects,
 *   currentProjectId,
 *   { finalK: 5 }
 * );
 *
 * console.log(result.routing.method);    // 'heuristic' | 'llm' | 'fallback_all'
 * console.log(result.routing.projectIds); // ['project-1']
 * console.log(result.content);            // XML context for LLM
 * ```
 */

import type { EmbeddingProvider, RAGResult } from '@contextaisdk/rag';
import {
  AdaptiveRAG,
  type AdaptiveRAGResult,
} from '@contextaisdk/rag/adaptive';

import {
  createProjectRouter,
  type LLMProjectRouter,
  type ProjectMetadata,
  type RoutingResult,
} from './query-router.js';
import { createRAGEngine, ContextExpertRAGEngine } from './rag-engine.js';
import type {
  RoutingRAGEngineConfig,
  RoutingRAGResult,
  RoutingMetadata,
  QueryClassification,
  RAGEngineOptions,
  RAGSearchResult,
  RAGSource,
} from './types.js';
import type { Config } from '../config/schema.js';
import {
  getMultiProjectFusionService,
  type MultiProjectFusionService,
} from '../search/multi-project-fusion.js';
import type { MultiProjectSearchResult } from '../search/types.js';
import { EmbeddingMismatchError } from '../search/errors.js';

// ============================================================================
// HELPER: Convert MultiProjectSearchResult to RAGSearchResult format
// ============================================================================

/**
 * Convert MultiProjectFusionService results to RAGSearchResult format.
 *
 * This bridges the gap between multi-project search (which returns
 * MultiProjectSearchResult[]) and the unified RoutingRAGResult interface.
 */
function toRAGSearchResult(
  results: MultiProjectSearchResult[],
  startTime: number
): RAGSearchResult {
  // Build XML content (same format as ContextExpertRAGEngine)
  const content = formatMultiProjectContext(results);

  // Convert to RAGSource format
  const sources: RAGSource[] = results.map((r, idx) => ({
    index: idx + 1, // 1-indexed for citations
    filePath: r.filePath,
    lineRange: r.lineRange,
    score: r.score,
    language: r.language,
    fileType: r.fileType,
  }));

  // Estimate tokens (rough: 4 chars per token)
  const estimatedTokens = Math.ceil(content.length / 4);

  const totalMs = performance.now() - startTime;

  return {
    content,
    estimatedTokens,
    sources,
    rawResults: results, // MultiProjectSearchResult extends SearchResultWithContext
    metadata: {
      retrievalMs: totalMs, // We don't have granular timing for multi-project
      assemblyMs: 0,
      totalMs,
      resultsRetrieved: results.length,
      resultsAssembled: results.length,
      fromCache: false,
    },
  };
}

/**
 * Format multi-project search results as XML context.
 *
 * Includes project attribution in each source element.
 */
function formatMultiProjectContext(results: MultiProjectSearchResult[]): string {
  if (results.length === 0) {
    return '<sources>\n  <!-- No relevant context found -->\n</sources>';
  }

  const sourceElements = results
    .map((r, idx) => {
      const lineRange =
        r.lineRange.start === r.lineRange.end
          ? `${r.lineRange.start}`
          : `${r.lineRange.start}-${r.lineRange.end}`;

      // Escape XML special characters in content
      const escapedContent = r.content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      return `  <source id="${idx + 1}" project="${r.projectName}" file="${r.filePath}" lines="${lineRange}" score="${r.score.toFixed(3)}">
${escapedContent}
  </source>`;
    })
    .join('\n');

  return `<sources>\n${sourceElements}\n</sources>`;
}

// ============================================================================
// ROUTING RAG ENGINE
// ============================================================================

/**
 * RAG Engine with automatic query routing.
 *
 * Provides a unified interface for searching across one or multiple projects,
 * with automatic routing based on query content and project metadata.
 */
export class RoutingRAGEngine {
  /** Router for determining target project(s) */
  private readonly router: LLMProjectRouter;

  /** Application config for creating engines */
  private readonly config: Config;

  /** Pool of single-project RAG engines (lazy instantiation) */
  private readonly engines: Map<string, ContextExpertRAGEngine> = new Map();

  /** Embedding provider for multi-project search */
  private readonly embeddingProvider: EmbeddingProvider;

  /** Embedding dimensions */
  private readonly dimensions: number;

  /** Force RAG search even for low-confidence routing */
  private readonly forceRAG: boolean;

  /** Multi-project fusion service (lazy instantiation) */
  private fusionService: MultiProjectFusionService | null = null;

  /** Rerank config from app config */
  private readonly rerankEnabled: boolean;

  /** Whether AdaptiveRAG pipeline optimization is enabled */
  private readonly adaptiveEnabled: boolean;

  /** Pool of AdaptiveRAG wrappers per project (lazy, mirrors engines pool) */
  private readonly adaptiveEngines: Map<string, AdaptiveRAG> = new Map();

  constructor(engineConfig: RoutingRAGEngineConfig) {
    this.config = engineConfig.config;
    this.embeddingProvider = engineConfig.embeddingProvider;
    this.dimensions = engineConfig.dimensions;
    this.forceRAG = engineConfig.forceRAG ?? true;
    this.rerankEnabled = engineConfig.config.search?.rerank ?? true;
    this.adaptiveEnabled = engineConfig.adaptive !== false; // default: true

    // Create router (heuristic-only if no LLM provider)
    this.router = createProjectRouter(
      engineConfig.llmProvider ?? null,
      engineConfig.routerConfig
    );
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Search with automatic query routing.
   *
   * The routing flow:
   * 1. Router determines target project(s) based on query content
   * 2. If single project: use ContextExpertRAGEngine
   * 3. If multiple projects: use MultiProjectFusionService
   * 4. Return results with routing metadata
   *
   * @param query - User query
   * @param projects - Available projects (from database)
   * @param currentProjectId - Currently focused project (routing hint)
   * @param options - Search options (finalK, maxTokens, etc.)
   * @returns Search results with routing metadata
   *
   * @throws EmbeddingMismatchError if multi-project search with incompatible embeddings
   */
  async search(
    query: string,
    projects: ProjectMetadata[],
    currentProjectId?: string,
    options?: RAGEngineOptions
  ): Promise<RoutingRAGResult> {
    const startTime = performance.now();

    // Handle no projects case
    if (projects.length === 0) {
      return this.createEmptyResult('No projects available');
    }

    // Update router with current project names
    this.router.updateProjects(projects);

    // Route the query
    const routing = await this.router.route(query, projects, currentProjectId);

    // Determine effective routing (apply forceRAG logic)
    const effectiveRouting = this.applyForceRAGLogic(routing, projects);

    // Execute search based on routing
    if (effectiveRouting.projectIds.length === 0) {
      return this.createEmptyResult(effectiveRouting.reason);
    }

    if (effectiveRouting.projectIds.length === 1) {
      return this.searchSingleProject(query, effectiveRouting, options);
    }

    return this.searchMultipleProjects(query, effectiveRouting, options, startTime);
  }

  /**
   * Update router with new project list.
   *
   * Call this when projects are added/removed during the session.
   */
  updateProjects(projects: ProjectMetadata[]): void {
    this.router.updateProjects(projects);
  }

  /**
   * Dispose all cached engines.
   *
   * Call this when done using the engine to free resources.
   * After disposal, the engine should not be used again.
   */
  dispose(): void {
    for (const engine of this.engines.values()) {
      engine.dispose();
    }
    this.engines.clear();
    this.adaptiveEngines.clear();

    // Note: fusionService uses singleton managers, don't reset them here
    // as they may be shared with other parts of the application
    this.fusionService = null;
  }

  /**
   * Get an engine for a specific project.
   *
   * Useful for direct access when routing is not needed.
   */
  async getEngineForProject(projectId: string): Promise<ContextExpertRAGEngine> {
    return this.getOrCreateEngine(projectId);
  }

  // ==========================================================================
  // Private: Engine Management
  // ==========================================================================

  /**
   * Get or create a RAG engine for a project.
   *
   * Engines are cached for reuse across multiple searches.
   */
  private async getOrCreateEngine(projectId: string): Promise<ContextExpertRAGEngine> {
    let engine = this.engines.get(projectId);
    if (!engine) {
      engine = await createRAGEngine(this.config, projectId);
      this.engines.set(projectId, engine);
    }
    return engine;
  }

  /**
   * Get or create the multi-project fusion service.
   */
  private getFusionService(): MultiProjectFusionService {
    if (!this.fusionService) {
      this.fusionService = getMultiProjectFusionService({
        rerank: this.rerankEnabled,
      });
    }
    return this.fusionService;
  }

  /**
   * Get or create an AdaptiveRAG wrapper for a project engine.
   *
   * AdaptiveRAG wraps the SDK's RAGEngineImpl (not our Facade) to classify
   * queries and optimize the pipeline per query complexity:
   * - SIMPLE: skip retrieval (greetings, thanks)
   * - FACTUAL: normal pipeline (topK=5, rerank=true)
   * - COMPLEX: enhanced pipeline (topK=10, enhancement=true)
   * - CONVERSATIONAL: flags needsConversationContext
   */
  private getOrCreateAdaptiveEngine(
    projectId: string,
    engine: ContextExpertRAGEngine
  ): AdaptiveRAG {
    let adaptive = this.adaptiveEngines.get(projectId);
    if (!adaptive) {
      adaptive = new AdaptiveRAG({
        engine: engine.getSDKEngine(),
        includeClassificationInMetadata: true,
      });
      this.adaptiveEngines.set(projectId, adaptive);
    }
    return adaptive;
  }

  // ==========================================================================
  // Private: Routing Logic
  // ==========================================================================

  /**
   * Apply forceRAG logic to routing result.
   *
   * When forceRAG is true and the router returns low confidence,
   * we still search (using the router's projectIds or falling back to all).
   */
  private applyForceRAGLogic(
    routing: RoutingResult,
    projects: ProjectMetadata[]
  ): RoutingResult {
    // If forceRAG is disabled, return routing as-is
    if (!this.forceRAG) {
      return routing;
    }

    // If routing has high confidence, use it
    if (routing.confidence >= 0.5) {
      return routing;
    }

    // forceRAG: Override low confidence with 'force-rag' method
    // Use router's projectIds if available, otherwise fall back to all
    const projectIds =
      routing.projectIds.length > 0
        ? routing.projectIds
        : projects.map((p) => p.id);

    return {
      projectIds,
      method: 'force-rag' as const,
      confidence: routing.confidence,
      reason: `Force RAG: ${routing.reason}`,
    };
  }

  // ==========================================================================
  // Private: Search Execution
  // ==========================================================================

  /**
   * Search a single project using ContextExpertRAGEngine.
   *
   * When adaptive mode is enabled, wraps the search with AdaptiveRAG
   * for query-classification-based pipeline optimization.
   */
  private async searchSingleProject(
    query: string,
    routing: RoutingResult,
    options: RAGEngineOptions | undefined
  ): Promise<RoutingRAGResult> {
    const projectId = routing.projectIds[0]!;
    const engine = await this.getOrCreateEngine(projectId);

    // Adaptive path: classify query and optimize pipeline
    if (this.adaptiveEnabled) {
      const adaptive = this.getOrCreateAdaptiveEngine(projectId, engine);
      const adaptiveResult: AdaptiveRAGResult = await adaptive.search(query, {
        topK: options?.finalK ?? 5,
        maxTokens: options?.maxTokens,
      });

      // Build classification metadata
      const classification: QueryClassification | undefined =
        adaptiveResult.classification
          ? {
              type: adaptiveResult.classification.type as QueryClassification['type'],
              confidence: adaptiveResult.classification.confidence,
              skippedRetrieval: adaptiveResult.skippedRetrieval,
            }
          : undefined;

      // If retrieval was skipped, return empty result with classification
      if (adaptiveResult.skippedRetrieval) {
        return {
          ...this.createEmptyResult(
            adaptiveResult.skipReason ?? 'Retrieval skipped by adaptive classification'
          ),
          routing: this.toRoutingMetadata(routing),
          classification,
        };
      }

      // Convert AdaptiveRAGResult (extends RAGResult) through our converter
      const ragResult = engine.convertResult(
        adaptiveResult as RAGResult,
        adaptiveResult.metadata.timings.totalMs
      );

      return {
        ...ragResult,
        routing: this.toRoutingMetadata(routing),
        classification,
      };
    }

    // Non-adaptive path: direct engine search (backward compatibility)
    const result = await engine.search(query, options);
    return {
      ...result,
      routing: this.toRoutingMetadata(routing),
    };
  }

  /**
   * Search multiple projects using MultiProjectFusionService.
   */
  private async searchMultipleProjects(
    query: string,
    routing: RoutingResult,
    options: RAGEngineOptions | undefined,
    startTime: number
  ): Promise<RoutingRAGResult> {
    const fusionService = this.getFusionService();

    // Validate embedding compatibility
    const validation = fusionService.validateProjects(routing.projectIds);
    if (!validation.valid) {
      throw new EmbeddingMismatchError(validation);
    }

    // Load project stores (caches if already loaded)
    await fusionService.loadProjects({
      projectIds: routing.projectIds,
      dimensions: this.dimensions,
    });

    // Generate query embedding
    const embeddingResult = await this.embeddingProvider.embed(query);

    // Execute multi-project search
    const topK = options?.finalK ?? 10;
    const results = await fusionService.search(query, embeddingResult.embedding, { topK });

    // Convert to RAGSearchResult format
    const ragResult = toRAGSearchResult(results, startTime);

    return {
      ...ragResult,
      routing: this.toRoutingMetadata(routing),
    };
  }

  // ==========================================================================
  // Private: Result Helpers
  // ==========================================================================

  /**
   * Create an empty result when no search can be performed.
   */
  private createEmptyResult(reason: string): RoutingRAGResult {
    return {
      content: '<sources>\n  <!-- No context available -->\n</sources>',
      estimatedTokens: 0,
      sources: [],
      rawResults: [],
      metadata: {
        retrievalMs: 0,
        assemblyMs: 0,
        totalMs: 0,
        resultsRetrieved: 0,
        resultsAssembled: 0,
        fromCache: false,
      },
      routing: {
        method: 'fallback_all',
        projectIds: [],
        confidence: 1.0,
        reason,
      },
    };
  }

  /**
   * Convert RoutingResult to RoutingMetadata.
   */
  private toRoutingMetadata(routing: RoutingResult): RoutingMetadata {
    return {
      method: routing.method as RoutingMetadata['method'],
      projectIds: routing.projectIds,
      confidence: routing.confidence,
      reason: routing.reason,
    };
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create a RoutingRAGEngine with the provided configuration.
 *
 * This is the recommended way to instantiate RoutingRAGEngine.
 *
 * @param config - Engine configuration
 * @returns Configured RoutingRAGEngine
 *
 * @example
 * ```typescript
 * const engine = createRoutingRAGEngine({
 *   config: appConfig,
 *   embeddingProvider,
 *   dimensions: 1024,
 *   forceRAG: true, // default
 * });
 * ```
 */
export function createRoutingRAGEngine(
  config: RoutingRAGEngineConfig
): RoutingRAGEngine {
  return new RoutingRAGEngine(config);
}
