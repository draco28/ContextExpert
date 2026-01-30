/**
 * Shared Formatting Utilities
 *
 * Common utilities for formatting search results across services.
 * Used by both SearchService (dense/semantic) and BM25SearchService (keyword).
 *
 * Extracted to eliminate duplicate code while maintaining identical behavior.
 */

import type { SearchResultWithContext, SearchQueryOptions } from './types.js';

/**
 * Format a retriever result chunk into our standard result format.
 *
 * This is the SINGLE source of truth for converting raw retrieval results
 * (from DenseRetriever or BM25Retriever) into SearchResultWithContext objects.
 *
 * Both SearchService and BM25SearchService use this to ensure consistent
 * result structure across all search types.
 *
 * @param id - Chunk identifier
 * @param score - Relevance score (cosine similarity for dense, BM25 for keyword)
 * @param content - The actual chunk text content
 * @param metadata - Optional chunk metadata (file info, line ranges, etc.)
 * @returns Formatted result ready for display/consumption
 *
 * @example
 * ```typescript
 * const result = formatSearchResult(
 *   chunk.id,
 *   score,
 *   chunk.content,
 *   chunk.metadata
 * );
 * // result.filePath, result.lineRange, etc. are all safely extracted
 * ```
 */
export function formatSearchResult(
  id: string,
  score: number,
  content: string,
  metadata: Record<string, unknown> | undefined
): SearchResultWithContext {
  return {
    id,
    score,
    content,
    filePath: (metadata?.filePath as string) ?? '',
    fileType: (metadata?.fileType as SearchResultWithContext['fileType']) ?? 'unknown',
    language: (metadata?.language as string | null) ?? null,
    lineRange: {
      start: (metadata?.startLine as number) ?? 0,
      end: (metadata?.endLine as number) ?? 0,
    },
    metadata: metadata ?? {},
  };
}

/**
 * Check if a formatted search result matches the given filter options.
 *
 * Used by BM25SearchService for post-retrieval filtering. The BM25 retriever
 * doesn't support filter queries like the vector store, so we filter in memory.
 *
 * SearchService uses the vector store's native filtering (more efficient),
 * but this function can be used anywhere post-filtering is needed.
 *
 * @param result - The formatted search result to check
 * @param options - Filter criteria (fileType, language, projectIds, minScore)
 * @returns true if result matches all filters, false if any filter rejects it
 *
 * @example
 * ```typescript
 * const results = rawResults
 *   .map(r => formatSearchResult(r.id, r.score, r.content, r.metadata))
 *   .filter(r => matchesFilters(r, { fileType: 'code', minScore: 0.5 }));
 * ```
 */
export function matchesFilters(
  result: SearchResultWithContext,
  options: SearchQueryOptions
): boolean {
  // File type filter
  if (options.fileType && result.fileType !== options.fileType) {
    return false;
  }

  // Language filter
  if (options.language && result.language !== options.language) {
    return false;
  }

  // Project filter: result must belong to one of the specified projects
  if (options.projectIds?.length) {
    const resultProjectId = result.metadata?.projectId as string | undefined;
    if (!resultProjectId || !options.projectIds.includes(resultProjectId)) {
      return false;
    }
  }

  // Minimum score filter
  if (options.minScore !== undefined && result.score < options.minScore) {
    return false;
  }

  return true;
}
