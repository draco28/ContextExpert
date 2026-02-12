/**
 * Retrieval Quality Metrics
 *
 * Pure TypeScript implementations of standard Information Retrieval metrics
 * for evaluating RAG search quality. All functions are deterministic, fast,
 * and require no LLM calls or external dependencies.
 *
 * Metrics:
 * - Per-query: reciprocalRank, precisionAtK, recallAtK, hitRate
 * - Aggregate-only: ndcgAtK, averagePrecision
 * - Orchestrators: computePerQueryMetrics, computeAggregateMetrics
 *
 * Relevance matching uses file paths (not chunk IDs) so metrics survive
 * re-indexing. Path normalization handles prefix and case differences.
 */

import type { RetrievalMetrics } from './types.js';

// ============================================================================
// PATH NORMALIZATION (Internal)
// ============================================================================

/**
 * Normalize a file path for comparison.
 *
 * Strips leading slashes and ./ prefixes, collapses redundant separators,
 * and lowercases for case-insensitive matching on macOS/Windows.
 *
 * @param filePath - Raw file path to normalize
 * @returns Normalized path string for comparison
 *
 * @example
 * normalizePath('./src/Auth.ts')  // => 'src/auth.ts'
 * normalizePath('/src/auth.ts')   // => 'src/auth.ts'
 * normalizePath('src//auth.ts')   // => 'src/auth.ts'
 */
function normalizePath(filePath: string): string {
  return filePath
    .trim()
    .replace(/\\/g, '/') // Normalize Windows backslashes
    .replace(/\/+/g, '/') // Collapse repeated slashes
    .replace(/^\.\//, '') // Strip leading ./
    .replace(/^\//, '') // Strip leading /
    .replace(/\/$/, '') // Strip trailing /
    .toLowerCase();
}

/**
 * Deduplicate retrieved paths at the file level.
 *
 * Multiple chunks from the same file collapse into a single entry.
 * The first occurrence (highest rank) is preserved.
 *
 * @param retrievedPaths - Ordered array of retrieved file paths (may have duplicates)
 * @returns Ordered array of normalized paths with duplicates removed
 */
function deduplicateByFile(retrievedPaths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const path of retrievedPaths) {
    const normalized = normalizePath(path);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

/**
 * Build a Set of normalized expected file paths for efficient lookup.
 *
 * @param expectedPaths - Array of expected file paths from golden dataset
 * @returns Set of normalized paths
 */
function normalizeExpected(expectedPaths: string[]): Set<string> {
  return new Set(expectedPaths.map(normalizePath));
}

// ============================================================================
// PER-QUERY METRIC FUNCTIONS
// ============================================================================

/**
 * Compute Reciprocal Rank for a single query.
 *
 * Finds the rank (1-indexed) of the first relevant result and returns 1/rank.
 * Returns 0 if no relevant result is found in the retrieved list.
 *
 * @param retrieved - Ordered retrieved file paths (rank-ordered, may have duplicates)
 * @param expected - Expected relevant file paths from golden dataset
 * @returns Reciprocal rank value in [0, 1]
 *
 * @example
 * reciprocalRank(['a.ts', 'b.ts', 'c.ts'], ['b.ts']) // => 0.5 (found at rank 2)
 * reciprocalRank(['a.ts', 'b.ts'], ['x.ts'])          // => 0   (not found)
 */
export function reciprocalRank(retrieved: string[], expected: string[]): number {
  if (expected.length === 0 || retrieved.length === 0) return 0;

  const expectedSet = normalizeExpected(expected);
  const deduped = deduplicateByFile(retrieved);

  const firstRelevantIndex = deduped.findIndex((path) => expectedSet.has(path));

  return firstRelevantIndex === -1 ? 0 : 1 / (firstRelevantIndex + 1);
}

/**
 * Compute Precision@K for a single query.
 *
 * Fraction of the top-k retrieved results that are relevant.
 * Uses file-level deduplication: multiple chunks from the same file count once.
 *
 * @param retrieved - Ordered retrieved file paths
 * @param expected - Expected relevant file paths
 * @param k - Number of top results to consider (default: all after dedup)
 * @returns Precision value in [0, 1]
 *
 * @example
 * precisionAtK(['a.ts', 'b.ts', 'c.ts'], ['a.ts', 'c.ts'], 3) // => 0.667
 */
export function precisionAtK(
  retrieved: string[],
  expected: string[],
  k?: number
): number {
  if (expected.length === 0 || retrieved.length === 0) return 0;

  const expectedSet = normalizeExpected(expected);
  const deduped = deduplicateByFile(retrieved);
  const effectiveK = k ?? deduped.length;

  if (effectiveK === 0) return 0;

  const topK = deduped.slice(0, effectiveK);
  const relevantCount = topK.filter((path) => expectedSet.has(path)).length;

  return relevantCount / effectiveK;
}

/**
 * Compute Recall@K for a single query.
 *
 * Fraction of all relevant documents that appear in the top-k retrieved results.
 * Returns 0 when expected is empty (no relevance defined).
 *
 * @param retrieved - Ordered retrieved file paths
 * @param expected - Expected relevant file paths
 * @param k - Number of top results to consider (default: all after dedup)
 * @returns Recall value in [0, 1]
 *
 * @example
 * recallAtK(['a.ts', 'b.ts'], ['a.ts', 'c.ts', 'd.ts'], 5) // => 0.333
 */
export function recallAtK(
  retrieved: string[],
  expected: string[],
  k?: number
): number {
  if (expected.length === 0 || retrieved.length === 0) return 0;

  const expectedSet = normalizeExpected(expected);
  const deduped = deduplicateByFile(retrieved);
  const effectiveK = k ?? deduped.length;
  const topK = deduped.slice(0, effectiveK);

  const foundCount = topK.filter((path) => expectedSet.has(path)).length;

  return foundCount / expectedSet.size;
}

/**
 * Compute Hit Rate for a single query.
 *
 * Binary metric: 1 if at least one relevant result appears in top-k, else 0.
 *
 * @param retrieved - Ordered retrieved file paths
 * @param expected - Expected relevant file paths
 * @param k - Number of top results to consider (default: all after dedup)
 * @returns 1 or 0
 *
 * @example
 * hitRate(['a.ts', 'b.ts', 'c.ts'], ['c.ts']) // => 1
 * hitRate(['a.ts', 'b.ts'], ['x.ts'])          // => 0
 */
export function hitRate(
  retrieved: string[],
  expected: string[],
  k?: number
): number {
  if (expected.length === 0 || retrieved.length === 0) return 0;

  const expectedSet = normalizeExpected(expected);
  const deduped = deduplicateByFile(retrieved);
  const effectiveK = k ?? deduped.length;
  const topK = deduped.slice(0, effectiveK);

  return topK.some((path) => expectedSet.has(path)) ? 1 : 0;
}

// ============================================================================
// AGGREGATE-ONLY METRIC FUNCTIONS
// ============================================================================

/**
 * Compute NDCG@K (Normalized Discounted Cumulative Gain) for a single query.
 *
 * Uses binary relevance: 1 if a retrieved document is relevant, 0 otherwise.
 * DCG = sum of rel_i / log2(rank + 1) where rank is 1-indexed.
 * IDCG = best possible DCG with all relevant docs at top positions.
 * NDCG = DCG / IDCG.
 *
 * @param retrieved - Ordered retrieved file paths
 * @param expected - Expected relevant file paths
 * @param k - Number of top results to consider (default: all after dedup)
 * @returns NDCG value in [0, 1]. Returns 0 when expected is empty.
 *
 * @example
 * ndcgAtK(['a.ts', 'b.ts', 'c.ts'], ['a.ts', 'c.ts'], 3)
 * // DCG = 1/log2(2) + 0/log2(3) + 1/log2(4) = 1.0 + 0 + 0.5 = 1.5
 * // IDCG = 1/log2(2) + 1/log2(3) = 1.0 + 0.631 = 1.631
 * // NDCG = 1.5 / 1.631 = 0.9197
 */
export function ndcgAtK(
  retrieved: string[],
  expected: string[],
  k?: number
): number {
  if (expected.length === 0 || retrieved.length === 0) return 0;

  const expectedSet = normalizeExpected(expected);
  const deduped = deduplicateByFile(retrieved);
  const effectiveK = k ?? deduped.length;

  if (effectiveK === 0) return 0;

  const topK = deduped.slice(0, effectiveK);

  // DCG: sum of relevance / log2(rank + 1) where rank is 1-indexed
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    const path = topK[i]!;
    if (expectedSet.has(path)) {
      dcg += 1 / Math.log2(i + 2); // i+2 because rank is 1-indexed: log2(1+1), log2(2+1), ...
    }
  }

  // IDCG: best possible DCG with min(|expected|, k) relevant docs at top
  const idealRelevantCount = Math.min(expectedSet.size, effectiveK);
  let idcg = 0;
  for (let i = 0; i < idealRelevantCount; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Compute Average Precision for a single query.
 *
 * Precision is computed at each position where a relevant document is found,
 * then averaged over the total number of relevant documents (not just found).
 *
 * @param retrieved - Ordered retrieved file paths
 * @param expected - Expected relevant file paths
 * @param k - Number of top results to consider (default: all after dedup)
 * @returns Average precision value in [0, 1]. Returns 0 when expected is empty.
 *
 * @example
 * averagePrecision(['a.ts', 'b.ts', 'c.ts'], ['a.ts', 'c.ts'])
 * // At pos 1 (a.ts): precision = 1/1 = 1.0
 * // At pos 3 (c.ts): precision = 2/3 = 0.667
 * // AP = (1.0 + 0.667) / 2 = 0.833
 */
export function averagePrecision(
  retrieved: string[],
  expected: string[],
  k?: number
): number {
  if (expected.length === 0 || retrieved.length === 0) return 0;

  const expectedSet = normalizeExpected(expected);
  const deduped = deduplicateByFile(retrieved);
  const effectiveK = k ?? deduped.length;
  const topK = deduped.slice(0, effectiveK);

  let relevantSoFar = 0;
  let precisionSum = 0;

  for (let i = 0; i < topK.length; i++) {
    const path = topK[i]!;
    if (expectedSet.has(path)) {
      relevantSoFar++;
      precisionSum += relevantSoFar / (i + 1); // Precision at this position
    }
  }

  // Divide by TOTAL relevant count, not just those found
  return precisionSum / expectedSet.size;
}

// ============================================================================
// ORCHESTRATOR FUNCTIONS
// ============================================================================

/**
 * Per-query result input for aggregate computation.
 *
 * Each entry represents one golden dataset query and its retrieval results.
 */
export interface QueryResult {
  /** Ordered retrieved file paths from search */
  retrieved: string[];
  /** Expected relevant file paths from golden entry */
  expected: string[];
}

/**
 * Compute all per-query metrics for a single retrieval result.
 *
 * Returns an object compatible with EvalResultInput.metrics shape.
 * Does NOT include NDCG or MAP (those are aggregate-only).
 *
 * @param retrieved - Ordered retrieved file paths from search
 * @param expected - Expected relevant file paths from golden entry
 * @param k - Number of top results to consider (default: all after dedup)
 * @returns Per-query metrics matching EvalResultInput.metrics
 */
export function computePerQueryMetrics(
  retrieved: string[],
  expected: string[],
  k?: number
): {
  reciprocal_rank: number;
  precision_at_k: number;
  recall_at_k: number;
  hit_rate: number;
} {
  return {
    reciprocal_rank: reciprocalRank(retrieved, expected),
    precision_at_k: precisionAtK(retrieved, expected, k),
    recall_at_k: recallAtK(retrieved, expected, k),
    hit_rate: hitRate(retrieved, expected, k),
  };
}

/**
 * Compute aggregate RetrievalMetrics across multiple queries.
 *
 * Computes per-query values for all 6 metrics, then macro-averages them.
 * Returns all zeros for empty input.
 *
 * @param queries - Array of query results (retrieved + expected pairs)
 * @param k - Number of top results to consider for all metrics
 * @returns Aggregate RetrievalMetrics object
 */
export function computeAggregateMetrics(
  queries: QueryResult[],
  k?: number
): RetrievalMetrics {
  if (queries.length === 0) {
    return {
      mrr: 0,
      precision_at_k: 0,
      recall_at_k: 0,
      hit_rate: 0,
      ndcg: 0,
      map: 0,
    };
  }

  let totalMrr = 0;
  let totalPrecision = 0;
  let totalRecall = 0;
  let totalHitRate = 0;
  let totalNdcg = 0;
  let totalMap = 0;

  for (const { retrieved, expected } of queries) {
    totalMrr += reciprocalRank(retrieved, expected);
    totalPrecision += precisionAtK(retrieved, expected, k);
    totalRecall += recallAtK(retrieved, expected, k);
    totalHitRate += hitRate(retrieved, expected, k);
    totalNdcg += ndcgAtK(retrieved, expected, k);
    totalMap += averagePrecision(retrieved, expected, k);
  }

  const n = queries.length;
  return {
    mrr: totalMrr / n,
    precision_at_k: totalPrecision / n,
    recall_at_k: totalRecall / n,
    hit_rate: totalHitRate / n,
    ndcg: totalNdcg / n,
    map: totalMap / n,
  };
}
