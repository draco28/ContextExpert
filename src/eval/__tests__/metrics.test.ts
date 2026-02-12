/**
 * Retrieval Quality Metrics Tests
 *
 * Comprehensive tests for the pure TypeScript IR metric implementations
 * in src/eval/metrics.ts. Covers per-query metrics, aggregate metrics,
 * orchestrator functions, path normalization, and edge cases.
 *
 * All expected values are computed by hand from standard IR formulas.
 */

import { describe, it, expect } from 'vitest';
import {
  reciprocalRank,
  precisionAtK,
  recallAtK,
  hitRate,
  ndcgAtK,
  averagePrecision,
  computePerQueryMetrics,
  computeAggregateMetrics,
} from '../metrics.js';

// ============================================================================
// reciprocalRank
// ============================================================================

describe('reciprocalRank', () => {
  it('returns 1.0 when first result is relevant', () => {
    expect(reciprocalRank(['a.ts', 'b.ts', 'c.ts'], ['a.ts'])).toBe(1.0);
  });

  it('returns 0.5 when first relevant result is at rank 2', () => {
    expect(reciprocalRank(['a.ts', 'b.ts', 'c.ts'], ['b.ts'])).toBe(0.5);
  });

  it('returns 0.2 when first relevant result is at rank 5', () => {
    expect(
      reciprocalRank(
        ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
        ['e.ts']
      )
    ).toBeCloseTo(0.2, 4);
  });

  it('returns 0 when no relevant results found', () => {
    expect(reciprocalRank(['a.ts', 'b.ts'], ['x.ts'])).toBe(0);
  });

  it('returns 0 for empty retrieved array', () => {
    expect(reciprocalRank([], ['a.ts'])).toBe(0);
  });

  it('returns 0 for empty expected array', () => {
    expect(reciprocalRank(['a.ts', 'b.ts'], [])).toBe(0);
  });

  it('uses first match when multiple expected files exist', () => {
    // b.ts is at rank 2, d.ts at rank 4 — RR should be 1/2
    expect(
      reciprocalRank(['a.ts', 'b.ts', 'c.ts', 'd.ts'], ['b.ts', 'd.ts'])
    ).toBe(0.5);
  });

  it('handles path normalization - leading slashes', () => {
    expect(reciprocalRank(['/src/auth.ts'], ['src/auth.ts'])).toBe(1.0);
  });

  it('handles path normalization - case insensitivity', () => {
    expect(reciprocalRank(['src/Auth.ts'], ['src/auth.ts'])).toBe(1.0);
  });

  it('deduplicates retrieved file paths from same file', () => {
    // Two chunks from a.ts, one from b.ts (relevant) — after dedup: [a.ts, b.ts] → rank 2
    expect(
      reciprocalRank(['a.ts', 'a.ts', 'b.ts'], ['b.ts'])
    ).toBe(0.5);
  });
});

// ============================================================================
// precisionAtK
// ============================================================================

describe('precisionAtK', () => {
  it('returns 1.0 when all top-k are relevant', () => {
    expect(precisionAtK(['a.ts', 'b.ts'], ['a.ts', 'b.ts'], 2)).toBe(1.0);
  });

  it('returns 0.5 when half of top-k are relevant', () => {
    expect(precisionAtK(['a.ts', 'b.ts', 'c.ts', 'd.ts'], ['a.ts', 'c.ts'], 4)).toBe(0.5);
  });

  it('returns 0.2 when 1 of 5 is relevant', () => {
    expect(
      precisionAtK(
        ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
        ['c.ts'],
        5
      )
    ).toBeCloseTo(0.2, 4);
  });

  it('returns 0 when none are relevant', () => {
    expect(precisionAtK(['a.ts', 'b.ts'], ['x.ts'], 2)).toBe(0);
  });

  it('returns 0 for empty retrieved', () => {
    expect(precisionAtK([], ['a.ts'], 5)).toBe(0);
  });

  it('returns 0 for empty expected', () => {
    expect(precisionAtK(['a.ts', 'b.ts'], [], 2)).toBe(0);
  });

  it('uses k parameter to limit results considered', () => {
    // Only look at first 2: a.ts (relevant), b.ts (not) → 1/2 = 0.5
    expect(
      precisionAtK(['a.ts', 'b.ts', 'c.ts'], ['a.ts', 'c.ts'], 2)
    ).toBe(0.5);
  });

  it('handles k larger than retrieved length', () => {
    // k=10 but only 3 results. 2 relevant. Precision = 2/10 = 0.2
    expect(
      precisionAtK(['a.ts', 'b.ts', 'c.ts'], ['a.ts', 'c.ts'], 10)
    ).toBeCloseTo(0.2, 4);
  });

  it('handles k = 0', () => {
    expect(precisionAtK(['a.ts'], ['a.ts'], 0)).toBe(0);
  });

  it('deduplicates retrieved before computing', () => {
    // Input: [a.ts, a.ts, b.ts] → dedup: [a.ts, b.ts]. Both relevant. P@2 = 2/2 = 1.0
    expect(
      precisionAtK(['a.ts', 'a.ts', 'b.ts'], ['a.ts', 'b.ts'], 2)
    ).toBe(1.0);
  });

  it('defaults k to deduped length when not provided', () => {
    // dedup: [a.ts, b.ts, c.ts], 2 relevant → 2/3
    expect(
      precisionAtK(['a.ts', 'b.ts', 'c.ts'], ['a.ts', 'c.ts'])
    ).toBeCloseTo(2 / 3, 4);
  });
});

// ============================================================================
// recallAtK
// ============================================================================

describe('recallAtK', () => {
  it('returns 1.0 when all expected files are retrieved', () => {
    expect(
      recallAtK(['a.ts', 'b.ts', 'c.ts'], ['a.ts', 'b.ts'], 5)
    ).toBe(1.0);
  });

  it('returns 0.5 when half of expected files are retrieved', () => {
    expect(
      recallAtK(['a.ts', 'x.ts'], ['a.ts', 'b.ts'], 5)
    ).toBe(0.5);
  });

  it('returns 0 when no expected files are retrieved', () => {
    expect(recallAtK(['x.ts', 'y.ts'], ['a.ts', 'b.ts'], 5)).toBe(0);
  });

  it('returns 0 for empty expected', () => {
    expect(recallAtK(['a.ts'], [], 5)).toBe(0);
  });

  it('returns 0 for empty retrieved', () => {
    expect(recallAtK([], ['a.ts'], 5)).toBe(0);
  });

  it('handles more expected than k allows', () => {
    // k=2, only see [a.ts, b.ts]. Expected: [a.ts, b.ts, c.ts]. Recall = 2/3
    expect(
      recallAtK(['a.ts', 'b.ts', 'c.ts'], ['a.ts', 'b.ts', 'c.ts'], 2)
    ).toBeCloseTo(2 / 3, 4);
  });

  it('is not affected by irrelevant results in retrieved', () => {
    // [a.ts, x.ts, b.ts] with expected [a.ts, b.ts]. k=5. Recall = 2/2 = 1.0
    expect(
      recallAtK(['a.ts', 'x.ts', 'b.ts'], ['a.ts', 'b.ts'], 5)
    ).toBe(1.0);
  });
});

// ============================================================================
// hitRate
// ============================================================================

describe('hitRate', () => {
  it('returns 1 when at least one relevant result exists', () => {
    expect(hitRate(['a.ts', 'b.ts'], ['b.ts'], 5)).toBe(1);
  });

  it('returns 0 when no relevant results exist', () => {
    expect(hitRate(['a.ts', 'b.ts'], ['x.ts'], 5)).toBe(0);
  });

  it('returns 0 for empty retrieved', () => {
    expect(hitRate([], ['a.ts'], 5)).toBe(0);
  });

  it('returns 0 for empty expected', () => {
    expect(hitRate(['a.ts'], [], 5)).toBe(0);
  });

  it('returns 1 even if relevant result is at last position', () => {
    expect(
      hitRate(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], ['e.ts'], 5)
    ).toBe(1);
  });

  it('respects k parameter — misses relevant result beyond k', () => {
    // c.ts is relevant but at position 3, k=2 → miss
    expect(hitRate(['a.ts', 'b.ts', 'c.ts'], ['c.ts'], 2)).toBe(0);
  });
});

// ============================================================================
// ndcgAtK
// ============================================================================

describe('ndcgAtK', () => {
  it('returns 1.0 for perfect ranking', () => {
    // All relevant docs at top positions
    expect(
      ndcgAtK(['a.ts', 'b.ts', 'c.ts'], ['a.ts', 'b.ts'], 3)
    ).toBeCloseTo(1.0, 4);
  });

  it('returns less than 1.0 when relevant results are not at top', () => {
    // relevant at positions 3 and 5 (0-indexed: 2 and 4)
    const result = ndcgAtK(
      ['x1.ts', 'x2.ts', 'a.ts', 'x3.ts', 'b.ts'],
      ['a.ts', 'b.ts'],
      5
    );
    // DCG = 1/log2(4) + 1/log2(6) = 0.5 + 0.3869 = 0.8869
    // IDCG = 1/log2(2) + 1/log2(3) = 1.0 + 0.6309 = 1.6309
    // NDCG = 0.8869 / 1.6309 ≈ 0.5438
    expect(result).toBeCloseTo(0.5438, 3);
  });

  it('returns 0 when no relevant results found', () => {
    expect(ndcgAtK(['a.ts', 'b.ts'], ['x.ts'], 2)).toBe(0);
  });

  it('returns 0 for empty expected', () => {
    expect(ndcgAtK(['a.ts'], [], 5)).toBe(0);
  });

  it('returns 0 for empty retrieved', () => {
    expect(ndcgAtK([], ['a.ts'], 5)).toBe(0);
  });

  it('penalizes relevant results at lower positions', () => {
    // Relevant at position 1 should score higher than relevant at position 3
    const scoreAtTop = ndcgAtK(['a.ts', 'x.ts', 'y.ts'], ['a.ts'], 3);
    const scoreAtBottom = ndcgAtK(['x.ts', 'y.ts', 'a.ts'], ['a.ts'], 3);
    expect(scoreAtTop).toBeGreaterThan(scoreAtBottom);
  });

  it('handles single result correctly', () => {
    // Single relevant result at position 1
    // DCG = 1/log2(2) = 1.0, IDCG = 1/log2(2) = 1.0 → NDCG = 1.0
    expect(ndcgAtK(['a.ts'], ['a.ts'], 1)).toBeCloseTo(1.0, 4);
  });

  it('handles k = 0', () => {
    expect(ndcgAtK(['a.ts'], ['a.ts'], 0)).toBe(0);
  });

  it('computes correct IDCG when expected count < k', () => {
    // 1 expected, k=5. IDCG = 1/log2(2) = 1.0 (only 1 ideal relevant doc)
    // Retrieved: relevant at position 3 → DCG = 1/log2(4) = 0.5
    // NDCG = 0.5 / 1.0 = 0.5
    expect(
      ndcgAtK(['x.ts', 'y.ts', 'a.ts', 'z.ts', 'w.ts'], ['a.ts'], 5)
    ).toBeCloseTo(0.5, 4);
  });
});

// ============================================================================
// averagePrecision
// ============================================================================

describe('averagePrecision', () => {
  it('returns 1.0 when all results are relevant and at top', () => {
    expect(
      averagePrecision(['a.ts', 'b.ts'], ['a.ts', 'b.ts'], 2)
    ).toBeCloseTo(1.0, 4);
  });

  it('returns correct value for mixed relevant/irrelevant ordering', () => {
    // Retrieved: [a.ts, x.ts, b.ts], expected: [a.ts, b.ts]
    // At pos 1 (a.ts relevant): precision = 1/1 = 1.0
    // At pos 3 (b.ts relevant): precision = 2/3 = 0.667
    // AP = (1.0 + 0.667) / 2 = 0.833
    expect(
      averagePrecision(['a.ts', 'x.ts', 'b.ts'], ['a.ts', 'b.ts'])
    ).toBeCloseTo(0.8333, 3);
  });

  it('returns 0 when no relevant results found', () => {
    expect(averagePrecision(['a.ts', 'b.ts'], ['x.ts'])).toBe(0);
  });

  it('returns 0 for empty expected', () => {
    expect(averagePrecision(['a.ts'], [])).toBe(0);
  });

  it('returns 0 for empty retrieved', () => {
    expect(averagePrecision([], ['a.ts'])).toBe(0);
  });

  it('divides by total relevant count, not found count', () => {
    // Retrieved: [a.ts], expected: [a.ts, b.ts, c.ts]
    // Only a.ts found at pos 1: precision_at_1 = 1/1 = 1.0
    // AP = 1.0 / 3 = 0.333 (divided by 3, not 1)
    expect(
      averagePrecision(['a.ts'], ['a.ts', 'b.ts', 'c.ts'])
    ).toBeCloseTo(1 / 3, 4);
  });

  it('handles interleaved relevant and irrelevant results', () => {
    // Retrieved: [a.ts, x.ts, b.ts, y.ts, c.ts]
    // Expected: [a.ts, b.ts, c.ts]
    // At pos 1 (a.ts): precision = 1/1 = 1.0
    // At pos 3 (b.ts): precision = 2/3 = 0.667
    // At pos 5 (c.ts): precision = 3/5 = 0.6
    // AP = (1.0 + 0.667 + 0.6) / 3 = 0.7556
    expect(
      averagePrecision(
        ['a.ts', 'x.ts', 'b.ts', 'y.ts', 'c.ts'],
        ['a.ts', 'b.ts', 'c.ts']
      )
    ).toBeCloseTo(0.7556, 3);
  });
});

// ============================================================================
// computePerQueryMetrics
// ============================================================================

describe('computePerQueryMetrics', () => {
  it('returns all four metric fields', () => {
    const result = computePerQueryMetrics(['a.ts'], ['a.ts']);
    expect(result).toHaveProperty('reciprocal_rank');
    expect(result).toHaveProperty('precision_at_k');
    expect(result).toHaveProperty('recall_at_k');
    expect(result).toHaveProperty('hit_rate');
  });

  it('returns correct values for a known scenario', () => {
    // Retrieved: [a.ts, x.ts, b.ts], Expected: [a.ts, b.ts]
    const result = computePerQueryMetrics(
      ['a.ts', 'x.ts', 'b.ts'],
      ['a.ts', 'b.ts'],
      3
    );
    expect(result.reciprocal_rank).toBe(1.0); // a.ts at rank 1
    expect(result.precision_at_k).toBeCloseTo(2 / 3, 4); // 2 of 3 relevant
    expect(result.recall_at_k).toBe(1.0); // both found
    expect(result.hit_rate).toBe(1); // at least one found
  });

  it('handles edge case of all-empty inputs', () => {
    const result = computePerQueryMetrics([], []);
    expect(result.reciprocal_rank).toBe(0);
    expect(result.precision_at_k).toBe(0);
    expect(result.recall_at_k).toBe(0);
    expect(result.hit_rate).toBe(0);
  });

  it('respects k parameter', () => {
    // b.ts is relevant but beyond k=1
    const result = computePerQueryMetrics(
      ['x.ts', 'b.ts'],
      ['b.ts'],
      1
    );
    expect(result.precision_at_k).toBe(0); // only x.ts in top-1
    expect(result.recall_at_k).toBe(0);
    expect(result.hit_rate).toBe(0);
    // reciprocal_rank ignores k — scans all results
    expect(result.reciprocal_rank).toBe(0.5); // b.ts at rank 2
  });

  it('output has exactly four keys', () => {
    const result = computePerQueryMetrics(['a.ts'], ['a.ts']);
    expect(Object.keys(result)).toHaveLength(4);
  });
});

// ============================================================================
// computeAggregateMetrics
// ============================================================================

describe('computeAggregateMetrics', () => {
  it('returns all six metric fields', () => {
    const result = computeAggregateMetrics([
      { retrieved: ['a.ts'], expected: ['a.ts'] },
    ]);
    expect(result).toHaveProperty('mrr');
    expect(result).toHaveProperty('precision_at_k');
    expect(result).toHaveProperty('recall_at_k');
    expect(result).toHaveProperty('hit_rate');
    expect(result).toHaveProperty('ndcg');
    expect(result).toHaveProperty('map');
  });

  it('returns all zeros for empty queries array', () => {
    const result = computeAggregateMetrics([]);
    expect(result.mrr).toBe(0);
    expect(result.precision_at_k).toBe(0);
    expect(result.recall_at_k).toBe(0);
    expect(result.hit_rate).toBe(0);
    expect(result.ndcg).toBe(0);
    expect(result.map).toBe(0);
  });

  it('computes correct averages across multiple queries', () => {
    const queries = [
      // Query 1: perfect match — all metrics = 1.0
      { retrieved: ['a.ts'], expected: ['a.ts'] },
      // Query 2: complete miss — all metrics = 0
      { retrieved: ['x.ts'], expected: ['y.ts'] },
    ];

    const result = computeAggregateMetrics(queries);

    // Average of 1.0 and 0 = 0.5 for all metrics
    expect(result.mrr).toBe(0.5);
    expect(result.precision_at_k).toBe(0.5);
    expect(result.recall_at_k).toBe(0.5);
    expect(result.hit_rate).toBe(0.5);
    expect(result.ndcg).toBe(0.5);
    expect(result.map).toBe(0.5);
  });

  it('handles single query correctly (same as per-query)', () => {
    const result = computeAggregateMetrics([
      { retrieved: ['a.ts', 'x.ts', 'b.ts'], expected: ['a.ts', 'b.ts'] },
    ]);

    expect(result.mrr).toBe(1.0);
    expect(result.precision_at_k).toBeCloseTo(2 / 3, 4);
    expect(result.recall_at_k).toBe(1.0);
    expect(result.hit_rate).toBe(1);
  });

  it('handles mix of perfect and zero-result queries', () => {
    const queries = [
      { retrieved: ['a.ts', 'b.ts'], expected: ['a.ts', 'b.ts'] },
      { retrieved: ['a.ts', 'b.ts'], expected: ['a.ts', 'b.ts'] },
      { retrieved: ['x.ts'], expected: ['y.ts'] },
    ];

    const result = computeAggregateMetrics(queries);

    // Two perfect + one zero: (1 + 1 + 0) / 3
    expect(result.mrr).toBeCloseTo(2 / 3, 4);
    expect(result.hit_rate).toBeCloseTo(2 / 3, 4);
  });

  it('respects k parameter across all queries', () => {
    const queries = [
      // With k=1, only first result matters: a.ts is relevant → perfect
      { retrieved: ['a.ts', 'b.ts'], expected: ['a.ts'] },
      // With k=1, only x.ts seen → miss for precision/recall/hit
      { retrieved: ['x.ts', 'a.ts'], expected: ['a.ts'] },
    ];

    const result = computeAggregateMetrics(queries, 1);

    expect(result.precision_at_k).toBe(0.5); // (1.0 + 0.0) / 2
    expect(result.hit_rate).toBe(0.5); // (1 + 0) / 2
  });
});

// ============================================================================
// Path Normalization Edge Cases
// ============================================================================

describe('Path normalization edge cases', () => {
  it('handles ./ prefix', () => {
    expect(reciprocalRank(['./src/auth.ts'], ['src/auth.ts'])).toBe(1.0);
  });

  it('handles mixed separators (backslashes)', () => {
    expect(reciprocalRank(['src\\auth.ts'], ['src/auth.ts'])).toBe(1.0);
  });

  it('handles trailing slashes on directories', () => {
    expect(reciprocalRank(['src/auth/'], ['src/auth'])).toBe(1.0);
  });

  it('handles paths with spaces', () => {
    expect(reciprocalRank(['src/my file.ts'], ['src/my file.ts'])).toBe(1.0);
  });

  it('treats src/auth.ts and /src/auth.ts as same file', () => {
    expect(
      precisionAtK(['/src/auth.ts'], ['src/auth.ts'], 1)
    ).toBe(1.0);
  });

  it('treats src/Auth.ts and src/auth.ts as same file', () => {
    expect(
      precisionAtK(['src/Auth.ts'], ['src/auth.ts'], 1)
    ).toBe(1.0);
  });

  it('handles double slashes', () => {
    expect(reciprocalRank(['src//auth.ts'], ['src/auth.ts'])).toBe(1.0);
  });

  it('handles whitespace around paths', () => {
    expect(reciprocalRank(['  src/auth.ts  '], ['src/auth.ts'])).toBe(1.0);
  });
});
