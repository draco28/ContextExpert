/**
 * Reranker Service
 *
 * Thin wrapper around ContextAI SDK's BGEReranker that handles:
 * 1. Type conversion between SearchResultWithContext and SDK's RetrievalResult
 * 2. Lazy loading of the reranker model
 * 3. Consistent interface for FusionService integration
 *
 * The cross-encoder reranker scores query-document pairs together,
 * providing more accurate relevance scores than bi-encoder similarity.
 *
 * @example
 * ```typescript
 * const reranker = new RerankerService({ model: 'Xenova/bge-reranker-base' });
 *
 * // Optional: Pre-load model during startup
 * await reranker.warmup();
 *
 * // Rerank search results
 * const reranked = await reranker.rerank(query, fusedResults, topK);
 * ```
 */

import { BGEReranker, type RetrievalResult } from '@contextaisdk/rag';
import type { SearchResultWithContext, RerankConfig } from './types.js';

/**
 * Default reranker model - good balance of quality and speed (~110MB).
 */
const DEFAULT_MODEL = 'Xenova/bge-reranker-base';

/**
 * Default number of candidates to rerank.
 * Research suggests ~50 candidates provides good precision/recall tradeoff.
 */
const DEFAULT_CANDIDATE_COUNT = 50;

/**
 * Service for reranking search results using BGE cross-encoder.
 *
 * Wraps the ContextAI SDK's BGEReranker to:
 * - Convert between our SearchResultWithContext and SDK's RetrievalResult
 * - Provide lazy loading with explicit warmup option
 * - Integrate cleanly with FusionService
 */
export class RerankerService {
  private reranker: BGEReranker | null = null;
  private readonly config: Required<RerankConfig>;

  constructor(config: RerankConfig = {}) {
    this.config = {
      model: config.model ?? DEFAULT_MODEL,
      candidateCount: config.candidateCount ?? DEFAULT_CANDIDATE_COUNT,
      device: config.device ?? 'auto',
    };
  }

  /**
   * Pre-load the reranker model.
   *
   * Call this during application startup to avoid first-request latency.
   * The model is ~110MB and takes 2-3 seconds to load.
   *
   * Safe to call multiple times - subsequent calls are no-ops.
   */
  async warmup(): Promise<void> {
    if (!this.reranker) {
      this.reranker = new BGEReranker({
        modelName: this.config.model,
        device: this.config.device,
      });
    }
    await this.reranker.warmup();
  }

  /**
   * Rerank search results using BGE cross-encoder.
   *
   * Takes the top candidates from hybrid search and reorders them
   * based on cross-encoder relevance scores. Returns the top K results.
   *
   * @param query - The search query text
   * @param results - Search results from hybrid retrieval (RRF-fused)
   * @param topK - Number of results to return after reranking
   * @returns Reranked results with updated scores (highest relevance first)
   *
   * @example
   * ```typescript
   * // After RRF fusion returns 50 candidates
   * const reranked = await rerankerService.rerank(
   *   'authentication middleware',
   *   fusedResults,
   *   10  // Return top 10 after reranking
   * );
   * ```
   */
  async rerank(
    query: string,
    results: SearchResultWithContext[],
    topK: number
  ): Promise<SearchResultWithContext[]> {
    // Handle edge cases
    if (results.length === 0) {
      return [];
    }

    // Lazy load model if not already loaded
    if (!this.reranker) {
      await this.warmup();
    }

    // Limit to configured candidate count
    const candidates = results.slice(0, this.config.candidateCount);

    // Convert to SDK's RetrievalResult format
    // SDK expects: { id, chunk: { content, metadata }, score }
    // We have: { id, content, metadata, score, ... }
    const retrievalResults: RetrievalResult[] = candidates.map((r) => ({
      id: r.id,
      chunk: {
        id: r.id,
        content: r.content,
        metadata: r.metadata,
      },
      score: r.score,
    }));

    // Rerank using SDK's BGEReranker
    const reranked = await this.reranker!.rerank(query, retrievalResults, {
      topK,
    });

    // Map back to SearchResultWithContext
    // Build lookup for O(1) access to original results
    const resultLookup = new Map(candidates.map((r) => [r.id, r]));

    const mapped = reranked.map((r) => {
      const original = resultLookup.get(r.id);
      if (!original) {
        // This should never happen, but TypeScript requires the check
        throw new Error(`Reranked result ID not found in original results: ${r.id}`);
      }
      return {
        ...original,
        score: r.score, // Raw reranker score (sigmoid of cross-encoder logit)
      };
    });

    // Min-max normalize scores so they spread meaningfully across 0-1.
    // BGE reranker sigmoid outputs cluster tightly (e.g., all ~0.73),
    // making raw scores uninformative. Normalization preserves ordering
    // while giving users visible score differentiation.
    return normalizeScores(mapped);
  }

  /**
   * Check if the reranker model is loaded.
   *
   * Useful for checking warmup status before first search.
   */
  isLoaded(): boolean {
    return this.reranker?.isLoaded() ?? false;
  }

  /**
   * Get the configured candidate count.
   *
   * This is the maximum number of results that will be reranked.
   */
  getCandidateCount(): number {
    return this.config.candidateCount;
  }
}

/**
 * Normalize scores to a meaningful 0-1 range.
 *
 * The BGE cross-encoder reranker applies sigmoid to its logits, but
 * Transformers.js may already apply sigmoid internally (double-sigmoid),
 * compressing all scores to bitwise-identical floats (~0.73). When scores
 * have sufficient spread, min-max normalization is used. When scores are
 * too compressed (range < epsilon), rank-based scoring is used instead —
 * the reranker's ordering is still meaningful even when absolute scores aren't.
 */
function normalizeScores(
  results: SearchResultWithContext[]
): SearchResultWithContext[] {
  if (results.length <= 1) {
    return results;
  }

  const scores = results.map((r) => r.score);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const range = maxScore - minScore;

  const EPSILON = 1e-6;
  if (range < EPSILON) {
    // Double-sigmoid compressed scores to be effectively identical.
    // Fall back to rank-based scoring: top result = 1.0, bottom = 0.5.
    const n = results.length;
    return results.map((r, i) => ({
      ...r,
      score: 1 - (i / (n - 1)) * 0.5,
    }));
  }

  return results.map((r) => ({
    ...r,
    score: (r.score - minScore) / range,
  }));
}
