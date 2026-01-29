/**
 * Agent Module
 *
 * RAG (Retrieval-Augmented Generation) pipeline for Context_Expert.
 *
 * This module provides a high-level RAG engine that:
 * 1. Searches indexed project content using hybrid retrieval
 * 2. Assembles results into XML context for LLM consumption
 * 3. Provides source attributions for citations
 *
 * ARCHITECTURE:
 * The RAG engine wraps the existing search infrastructure (FusionService)
 * with ContextAI SDK's RAGEngineImpl for orchestration and XMLAssembler
 * for context formatting.
 *
 * @example
 * ```typescript
 * import { createRAGEngine } from './agent';
 * import { loadConfig } from './config';
 * import { createLLMProvider } from './providers';
 *
 * const config = await loadConfig();
 * const engine = await createRAGEngine(config, 'my-project');
 *
 * // Search for context
 * const result = await engine.search('How does authentication work?');
 *
 * // Use with LLM
 * const { provider: llm } = await createLLMProvider(config);
 * const response = await llm.complete({
 *   prompt: `Answer using this context:\n${result.content}\n\nQuestion: How does auth work?`,
 * });
 *
 * // Citation data available
 * console.log(`Based on ${result.sources.length} sources:`);
 * for (const source of result.sources) {
 *   console.log(`  [${source.index}] ${source.filePath}:${source.lineRange.start}`);
 * }
 * ```
 *
 * @packageDocumentation
 */

// ============================================================================
// Core Factories
// ============================================================================

export {
  createRAGEngine,
  ContextExpertRAGEngine,
  FusionServiceAdapter,
} from './rag-engine.js';

export {
  createAssembler,
  DEFAULT_ASSEMBLER_CONFIG,
  AssemblerOptionsSchema,
} from './assembler.js';

// ============================================================================
// Types
// ============================================================================

export type {
  RAGConfig,
  RAGEngineOptions,
  RAGSearchResult,
  RAGSource,
  RAGTimingMetadata,
  OrderingStrategy,
  RAGErrorCode,
} from './types.js';

export type { AssemblerOptions } from './assembler.js';

// ============================================================================
// Schemas & Errors
// ============================================================================

export {
  RAGConfigSchema,
  OrderingStrategySchema,
  RAGEngineError,
  RAGErrorCodes,
} from './types.js';
