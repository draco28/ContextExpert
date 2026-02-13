/**
 * Eval Aggregator Tests (Ticket #118)
 *
 * Pure unit tests — no database needed. The aggregator works with
 * EvalRun[] (raw DB rows) and RetrievalMetrics (parsed objects),
 * so we can test entirely with in-memory data structures.
 *
 * Test helpers follow the same factory pattern as runner.test.ts
 * (makeMetrics, makeEvalRun) for consistency across the eval module.
 */

import { describe, it, expect } from 'vitest';

import {
  compareRuns,
  computeTrend,
  formatTrendReport,
  REGRESSION_THRESHOLD,
  type TrendResult,
} from '../aggregator.js';
import type { EvalRun, RetrievalMetrics } from '../types.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

/** Build RetrievalMetrics with sensible defaults. Override any metric. */
function makeMetrics(overrides: Partial<RetrievalMetrics> = {}): RetrievalMetrics {
  return {
    mrr: 0.700,
    precision_at_k: 0.600,
    recall_at_k: 0.750,
    hit_rate: 0.850,
    ndcg: 0.720,
    map: 0.680,
    ...overrides,
  };
}

/**
 * Build an EvalRun database row with JSON-serialized metrics.
 *
 * Takes typed RetrievalMetrics and serializes to JSON string,
 * matching the shape returned by db.getEvalRuns().
 */
function makeEvalRun(
  metrics: RetrievalMetrics,
  overrides: Partial<EvalRun> = {},
): EvalRun {
  return {
    id: `run-${Math.random().toString(36).slice(2, 8)}`,
    project_id: 'test-project',
    timestamp: new Date().toISOString(),
    dataset_version: '1.0',
    query_count: 10,
    metrics: JSON.stringify(metrics),
    config: JSON.stringify({ top_k: 5 }),
    notes: 'status:completed',
    ...overrides,
  };
}

// ============================================================================
// compareRuns
// ============================================================================

describe('compareRuns', () => {
  it('detects improvements when metrics increase beyond threshold', () => {
    const previous = makeMetrics({ mrr: 0.700, hit_rate: 0.800 });
    const current = makeMetrics({ mrr: 0.760, hit_rate: 0.860 });

    const result = compareRuns(current, previous);

    expect(result.metrics.mrr.isImprovement).toBe(true);
    expect(result.metrics.mrr.direction).toBe('up');
    expect(result.metrics.mrr.delta).toBeCloseTo(0.06, 5);

    expect(result.metrics.hit_rate.isImprovement).toBe(true);
    expect(result.metrics.hit_rate.direction).toBe('up');
    expect(result.metrics.hit_rate.delta).toBeCloseTo(0.06, 5);
  });

  it('detects regressions when metrics drop beyond threshold', () => {
    const previous = makeMetrics({ precision_at_k: 0.650, ndcg: 0.800 });
    const current = makeMetrics({ precision_at_k: 0.590, ndcg: 0.740 });

    const result = compareRuns(current, previous);

    expect(result.metrics.precision_at_k.isRegression).toBe(true);
    expect(result.metrics.precision_at_k.direction).toBe('down');
    expect(result.metrics.precision_at_k.delta).toBeCloseTo(-0.06, 5);

    expect(result.metrics.ndcg.isRegression).toBe(true);
    expect(result.metrics.ndcg.direction).toBe('down');
  });

  it('treats changes within ±threshold as stable', () => {
    const previous = makeMetrics({ mrr: 0.700, map: 0.680 });
    const current = makeMetrics({ mrr: 0.730, map: 0.660 });

    const result = compareRuns(current, previous);

    // +0.030 and -0.020 are both within ±0.05
    expect(result.metrics.mrr.direction).toBe('stable');
    expect(result.metrics.mrr.isImprovement).toBe(false);
    expect(result.metrics.mrr.isRegression).toBe(false);

    expect(result.metrics.map.direction).toBe('stable');
    expect(result.metrics.map.isImprovement).toBe(false);
    expect(result.metrics.map.isRegression).toBe(false);
  });

  it('treats delta at threshold boundary as stable (strict inequality)', () => {
    // IEEE 754: 0.25 - 0.20 = 0.04999999999999999 (just below 0.05)
    // This verifies the strict > threshold: exactly-at-or-below is stable
    const previous = makeMetrics({ mrr: 0.200, precision_at_k: 0.250 });
    const current = makeMetrics({ mrr: 0.250, precision_at_k: 0.200 });

    const result = compareRuns(current, previous);

    // +0.0499... → stable (not improvement)
    expect(result.metrics.mrr.direction).toBe('stable');
    expect(result.metrics.mrr.isImprovement).toBe(false);

    // -0.0499... → stable (not regression)
    expect(result.metrics.precision_at_k.direction).toBe('stable');
    expect(result.metrics.precision_at_k.isRegression).toBe(false);
  });

  it('handles mixed improvements, regressions, and stable metrics', () => {
    const previous = makeMetrics({
      mrr: 0.700,
      precision_at_k: 0.600,
      recall_at_k: 0.750,
      hit_rate: 0.850,
      ndcg: 0.720,
      map: 0.680,
    });
    const current = makeMetrics({
      mrr: 0.800,        // +0.100 → improvement
      precision_at_k: 0.530, // -0.070 → regression
      recall_at_k: 0.760,   // +0.010 → stable
      hit_rate: 0.850,      //  0.000 → stable
      ndcg: 0.720,          //  0.000 → stable
      map: 0.680,           //  0.000 → stable
    });

    const result = compareRuns(current, previous);

    expect(result.summary.improvementCount).toBe(1);
    expect(result.summary.regressionCount).toBe(1);
    expect(result.summary.stableCount).toBe(4);
  });

  it('computes summary counts correctly when all metrics are stable', () => {
    const metrics = makeMetrics();
    const result = compareRuns(metrics, metrics);

    expect(result.summary.improvementCount).toBe(0);
    expect(result.summary.regressionCount).toBe(0);
    expect(result.summary.stableCount).toBe(6);
  });

  it('stores correct current and previous values', () => {
    const previous = makeMetrics({ mrr: 0.600 });
    const current = makeMetrics({ mrr: 0.900 });

    const result = compareRuns(current, previous);

    expect(result.metrics.mrr.current).toBe(0.900);
    expect(result.metrics.mrr.previous).toBe(0.600);
  });
});

// ============================================================================
// computeTrend
// ============================================================================

describe('computeTrend', () => {
  it('computes trend with two runs showing improvement', () => {
    const previousMetrics = makeMetrics({ mrr: 0.700, hit_rate: 0.800 });
    const currentMetrics = makeMetrics({ mrr: 0.800, hit_rate: 0.900 });

    const runs = [
      makeEvalRun(currentMetrics, { id: 'run-current', timestamp: '2026-02-13T10:00:00Z' }),
      makeEvalRun(previousMetrics, { id: 'run-previous', timestamp: '2026-02-12T10:00:00Z' }),
    ];

    const trend = computeTrend(runs);

    expect(trend.runCount).toBe(2);
    expect(trend.currentRunId).toBe('run-current');
    expect(trend.previousRunId).toBe('run-previous');
    expect(trend.hasImprovements).toBe(true);

    const mrrTrend = trend.trends.find((t) => t.metric === 'mrr')!;
    expect(mrrTrend.current).toBe(0.800);
    expect(mrrTrend.previous).toBe(0.700);
    expect(mrrTrend.delta).toBeCloseTo(0.1, 5);
    expect(mrrTrend.direction).toBe('up');
    expect(mrrTrend.isImprovement).toBe(true);
  });

  it('computes trend with two runs showing regression', () => {
    const previousMetrics = makeMetrics({ precision_at_k: 0.700 });
    const currentMetrics = makeMetrics({ precision_at_k: 0.600 });

    const runs = [
      makeEvalRun(currentMetrics, { id: 'run-current' }),
      makeEvalRun(previousMetrics, { id: 'run-previous' }),
    ];

    const trend = computeTrend(runs);

    expect(trend.hasRegressions).toBe(true);

    const precisionTrend = trend.trends.find((t) => t.metric === 'precision_at_k')!;
    expect(precisionTrend.delta).toBeCloseTo(-0.1, 5);
    expect(precisionTrend.direction).toBe('down');
    expect(precisionTrend.isRegression).toBe(true);
  });

  it('handles single run (no previous comparison)', () => {
    const runs = [makeEvalRun(makeMetrics(), { id: 'run-solo' })];

    const trend = computeTrend(runs);

    expect(trend.runCount).toBe(1);
    expect(trend.currentRunId).toBe('run-solo');
    expect(trend.previousRunId).toBeNull();
    expect(trend.hasRegressions).toBe(false);
    expect(trend.hasImprovements).toBe(false);

    for (const t of trend.trends) {
      expect(t.previous).toBeNull();
      expect(t.delta).toBeNull();
      expect(t.direction).toBe('stable');
      expect(t.isRegression).toBe(false);
      expect(t.isImprovement).toBe(false);
    }
  });

  it('throws error for empty runs array', () => {
    expect(() => computeTrend([])).toThrow('Cannot compute trend: no eval runs provided');
  });

  it('throws error when current run has corrupted metrics JSON', () => {
    const run = makeEvalRun(makeMetrics(), { id: 'run-bad' });
    run.metrics = 'not-json!!!';

    expect(() => computeTrend([run])).toThrow('corrupted metrics JSON');
  });

  it('gracefully handles corrupted previous-run metrics', () => {
    const currentRun = makeEvalRun(makeMetrics(), { id: 'run-current' });
    const previousRun = makeEvalRun(makeMetrics(), { id: 'run-previous' });
    previousRun.metrics = '{bad json';

    const trend = computeTrend([currentRun, previousRun]);

    // Should treat as first run (no previous comparison)
    expect(trend.runCount).toBe(2);
    expect(trend.previousRunId).toBe('run-previous');
    for (const t of trend.trends) {
      expect(t.previous).toBeNull();
      expect(t.delta).toBeNull();
      expect(t.direction).toBe('stable');
    }
  });

  it('treats 5.1% change as regression/improvement (above threshold)', () => {
    const previous = makeMetrics({ mrr: 0.700, precision_at_k: 0.600 });
    const current = makeMetrics({ mrr: 0.751, precision_at_k: 0.549 });

    const runs = [
      makeEvalRun(current, { id: 'run-current' }),
      makeEvalRun(previous, { id: 'run-previous' }),
    ];

    const trend = computeTrend(runs);

    const mrrTrend = trend.trends.find((t) => t.metric === 'mrr')!;
    expect(mrrTrend.isImprovement).toBe(true);

    const precisionTrend = trend.trends.find((t) => t.metric === 'precision_at_k')!;
    expect(precisionTrend.isRegression).toBe(true);
  });

  it('treats 4.9% change as stable (below threshold)', () => {
    const previous = makeMetrics({ mrr: 0.700, precision_at_k: 0.600 });
    const current = makeMetrics({ mrr: 0.749, precision_at_k: 0.551 });

    const runs = [
      makeEvalRun(current, { id: 'run-current' }),
      makeEvalRun(previous, { id: 'run-previous' }),
    ];

    const trend = computeTrend(runs);

    const mrrTrend = trend.trends.find((t) => t.metric === 'mrr')!;
    expect(mrrTrend.direction).toBe('stable');
    expect(mrrTrend.isImprovement).toBe(false);

    const precisionTrend = trend.trends.find((t) => t.metric === 'precision_at_k')!;
    expect(precisionTrend.direction).toBe('stable');
    expect(precisionTrend.isRegression).toBe(false);
  });

  it('produces 6 trend entries (one per metric)', () => {
    const runs = [makeEvalRun(makeMetrics())];
    const trend = computeTrend(runs);

    expect(trend.trends).toHaveLength(6);
    const metricNames = trend.trends.map((t) => t.metric);
    expect(metricNames).toEqual([
      'mrr', 'precision_at_k', 'recall_at_k', 'hit_rate', 'ndcg', 'map',
    ]);
  });

  it('uses project_id from the current run', () => {
    const runs = [
      makeEvalRun(makeMetrics(), { project_id: 'proj-abc' }),
    ];

    const trend = computeTrend(runs);
    expect(trend.projectId).toBe('proj-abc');
  });

  it('handles many runs (only compares latest two)', () => {
    const runs = Array.from({ length: 10 }, (_, i) =>
      makeEvalRun(
        makeMetrics({ mrr: 0.5 + i * 0.05 }),
        { id: `run-${i}`, timestamp: new Date(2026, 1, 13, 10, i).toISOString() },
      ),
    );

    const trend = computeTrend(runs);

    expect(trend.runCount).toBe(10);
    // Should compare runs[0] vs runs[1] only
    expect(trend.currentRunId).toBe('run-0');
    expect(trend.previousRunId).toBe('run-1');
  });
});

// ============================================================================
// formatTrendReport
// ============================================================================

describe('formatTrendReport', () => {
  it('formats report with comparison data', () => {
    const previousMetrics = makeMetrics({
      mrr: 0.700, precision_at_k: 0.650, recall_at_k: 0.750,
      hit_rate: 0.850, ndcg: 0.720, map: 0.680,
    });
    const currentMetrics = makeMetrics({
      mrr: 0.800, precision_at_k: 0.580, recall_at_k: 0.760,
      hit_rate: 0.900, ndcg: 0.730, map: 0.690,
    });

    const runs = [
      makeEvalRun(currentMetrics, { id: 'run-2' }),
      makeEvalRun(previousMetrics, { id: 'run-1' }),
    ];

    const trend = computeTrend(runs);
    const report = formatTrendReport(trend);

    // Header
    expect(report).toContain('Eval Trend Report');
    expect(report).toContain('Runs analyzed: 2');
    expect(report).toContain('run-2');
    expect(report).toContain('run-1');

    // Metric rows
    expect(report).toContain('MRR');
    expect(report).toContain('Precision@K');
    expect(report).toContain('Recall@K');
    expect(report).toContain('Hit Rate');
    expect(report).toContain('NDCG');
    expect(report).toContain('MAP');

    // Arrows
    expect(report).toContain('↑'); // improvements
    expect(report).toContain('↓'); // regressions
    expect(report).toContain('→'); // stable
  });

  it('formats report for first run (no previous)', () => {
    const runs = [makeEvalRun(makeMetrics({ mrr: 0.750 }), { id: 'first-run' })];
    const trend = computeTrend(runs);
    const report = formatTrendReport(trend);

    expect(report).toContain('first-run');
    expect(report).toContain('(none');
    expect(report).toContain('Value');
    // Should NOT contain comparison table columns (header line has "Previous run:" which is fine)
    expect(report).not.toContain('Current  Previous');
    expect(report).not.toContain('Change  Trend');
  });

  it('shows regression section when regressions exist', () => {
    const runs = [
      makeEvalRun(makeMetrics({ precision_at_k: 0.500 }), { id: 'run-2' }),
      makeEvalRun(makeMetrics({ precision_at_k: 0.700 }), { id: 'run-1' }),
    ];

    const trend = computeTrend(runs);
    const report = formatTrendReport(trend);

    expect(report).toContain('Regressions (1)');
    expect(report).toContain('Precision@K dropped by');
    expect(report).toContain('0.700 -> 0.500');
  });

  it('shows improvement section when improvements exist', () => {
    const runs = [
      makeEvalRun(makeMetrics({ mrr: 0.900 }), { id: 'run-2' }),
      makeEvalRun(makeMetrics({ mrr: 0.700 }), { id: 'run-1' }),
    ];

    const trend = computeTrend(runs);
    const report = formatTrendReport(trend);

    expect(report).toContain('Improvements (1)');
    expect(report).toContain('MRR improved by');
    expect(report).toContain('0.700 -> 0.900');
  });

  it('shows stable message when no significant changes', () => {
    const metrics = makeMetrics();
    const runs = [
      makeEvalRun(metrics, { id: 'run-2' }),
      makeEvalRun(metrics, { id: 'run-1' }),
    ];

    const trend = computeTrend(runs);
    const report = formatTrendReport(trend);

    expect(report).toContain('All metrics stable');
    expect(report).not.toContain('Regressions');
    expect(report).not.toContain('Improvements');
  });

  it('formats metric values to 3 decimal places', () => {
    const runs = [
      makeEvalRun(makeMetrics({ mrr: 0.7 }), { id: 'run-1' }),
    ];

    const trend = computeTrend(runs);
    const report = formatTrendReport(trend);

    // 0.7 should be displayed as 0.700
    expect(report).toContain('0.700');
  });

  it('formats positive deltas with + prefix', () => {
    const runs = [
      makeEvalRun(makeMetrics({ mrr: 0.900 }), { id: 'run-2' }),
      makeEvalRun(makeMetrics({ mrr: 0.700 }), { id: 'run-1' }),
    ];

    const trend = computeTrend(runs);
    const report = formatTrendReport(trend);

    expect(report).toContain('+0.200');
  });

  it('formats negative deltas with - prefix', () => {
    const runs = [
      makeEvalRun(makeMetrics({ precision_at_k: 0.500 }), { id: 'run-2' }),
      makeEvalRun(makeMetrics({ precision_at_k: 0.700 }), { id: 'run-1' }),
    ];

    const trend = computeTrend(runs);
    const report = formatTrendReport(trend);

    expect(report).toContain('-0.200');
  });
});

// ============================================================================
// REGRESSION_THRESHOLD constant
// ============================================================================

describe('REGRESSION_THRESHOLD', () => {
  it('is exported and equals 0.05', () => {
    expect(REGRESSION_THRESHOLD).toBe(0.05);
  });
});
