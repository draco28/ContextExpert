/**
 * Eval Command Tests
 *
 * Tests the parseSince helper function for the ctx eval traces command
 * and the buildMetricRows / formatResultsTable helpers for ctx eval run.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseSince, buildMetricRows, formatResultsTable } from '../eval.js';
import type { EvalRunSummary, RetrievalMetrics } from '../../../eval/types.js';

// ============================================================================
// parseSince Tests (existing)
// ============================================================================

describe('parseSince', () => {
  // Fix the current date for deterministic tests
  const NOW = new Date('2026-02-15T12:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses day format (7d)', () => {
    const result = parseSince('7d');
    const expected = new Date('2026-02-08T12:00:00.000Z');
    expect(new Date(result).toISOString()).toBe(expected.toISOString());
  });

  it('parses hour format (24h)', () => {
    const result = parseSince('24h');
    const expected = new Date('2026-02-14T12:00:00.000Z');
    expect(new Date(result).toISOString()).toBe(expected.toISOString());
  });

  it('parses week format (2w)', () => {
    const result = parseSince('2w');
    const expected = new Date('2026-02-01T12:00:00.000Z');
    expect(new Date(result).toISOString()).toBe(expected.toISOString());
  });

  it('parses single day (1d)', () => {
    const result = parseSince('1d');
    const expected = new Date('2026-02-14T12:00:00.000Z');
    expect(new Date(result).toISOString()).toBe(expected.toISOString());
  });

  it('passes through ISO date strings', () => {
    const isoDate = '2026-01-01T00:00:00.000Z';
    expect(parseSince(isoDate)).toBe(isoDate);
  });

  it('passes through partial date strings', () => {
    const dateStr = '2026-01-15';
    expect(parseSince(dateStr)).toBe(dateStr);
  });
});

// ============================================================================
// buildMetricRows Tests
// ============================================================================

describe('buildMetricRows', () => {
  const metrics: RetrievalMetrics = {
    mrr: 0.85,
    precision_at_k: 0.65,
    recall_at_k: 0.72,
    hit_rate: 0.90,
    ndcg: 0.78,
    map: 0.74,
  };

  const thresholds = {
    mrr: 0.7,
    hit_rate: 0.85,
    precision_at_k: 0.6,
  };

  it('creates 6 metric rows in correct order', () => {
    const rows = buildMetricRows(metrics, thresholds);

    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.name)).toEqual([
      'MRR', 'Hit Rate', 'Precision@K', 'Recall@K', 'NDCG', 'MAP',
    ]);
  });

  it('marks threshold metrics as passed when above threshold', () => {
    const rows = buildMetricRows(metrics, thresholds);

    // MRR: 0.85 >= 0.7 → PASS
    expect(rows[0]!.passed).toBe(true);
    // Hit Rate: 0.90 >= 0.85 → PASS
    expect(rows[1]!.passed).toBe(true);
    // Precision@K: 0.65 >= 0.6 → PASS
    expect(rows[2]!.passed).toBe(true);
  });

  it('marks threshold metrics as failed when below threshold', () => {
    const lowMetrics: RetrievalMetrics = {
      ...metrics,
      mrr: 0.5,
      hit_rate: 0.4,
    };

    const rows = buildMetricRows(lowMetrics, thresholds);

    expect(rows[0]!.passed).toBe(false); // MRR: 0.5 < 0.7
    expect(rows[1]!.passed).toBe(false); // Hit Rate: 0.4 < 0.85
  });

  it('sets target and passed to null for non-threshold metrics', () => {
    const rows = buildMetricRows(metrics, thresholds);

    // Recall@K, NDCG, MAP have no thresholds
    expect(rows[3]!.target).toBeNull();
    expect(rows[3]!.passed).toBeNull();
    expect(rows[4]!.target).toBeNull();
    expect(rows[4]!.passed).toBeNull();
    expect(rows[5]!.target).toBeNull();
    expect(rows[5]!.passed).toBeNull();
  });

  it('does not set delta/direction when no comparison', () => {
    const rows = buildMetricRows(metrics, thresholds);

    for (const row of rows) {
      expect(row.delta).toBeUndefined();
      expect(row.direction).toBeUndefined();
    }
  });

  it('adds trend data from comparison', () => {
    const comparison: EvalRunSummary['comparison'] = {
      previous_run_id: 'prev-123',
      metric_changes: {
        mrr: 0.08,           // improvement (> 0.05)
        hit_rate: -0.02,     // stable
        precision_at_k: -0.07, // regression (< -0.05)
        recall_at_k: 0.03,  // stable
        ndcg: 0.12,         // improvement
        map: -0.01,         // stable
      },
    };

    const rows = buildMetricRows(metrics, thresholds, comparison);

    // MRR: +0.08 → up
    expect(rows[0]!.delta).toBe(0.08);
    expect(rows[0]!.direction).toBe('up');

    // Hit Rate: -0.02 → stable
    expect(rows[1]!.delta).toBe(-0.02);
    expect(rows[1]!.direction).toBe('stable');

    // Precision@K: -0.07 → down
    expect(rows[2]!.delta).toBe(-0.07);
    expect(rows[2]!.direction).toBe('down');

    // NDCG: +0.12 → up
    expect(rows[4]!.delta).toBe(0.12);
    expect(rows[4]!.direction).toBe('up');
  });

  it('handles exact threshold boundary (0.05) as stable', () => {
    const comparison: EvalRunSummary['comparison'] = {
      previous_run_id: 'prev-123',
      metric_changes: {
        mrr: 0.05,      // exactly threshold → stable
        hit_rate: -0.05, // exactly -threshold → stable
      },
    };

    const rows = buildMetricRows(metrics, thresholds, comparison);

    expect(rows[0]!.direction).toBe('stable');
    expect(rows[1]!.direction).toBe('stable');
  });

  it('handles partial comparison (some metrics missing)', () => {
    const comparison: EvalRunSummary['comparison'] = {
      previous_run_id: 'prev-123',
      metric_changes: {
        mrr: 0.1,
        // Other metrics not provided
      },
    };

    const rows = buildMetricRows(metrics, thresholds, comparison);

    expect(rows[0]!.delta).toBe(0.1);
    expect(rows[0]!.direction).toBe('up');
    // Other metrics should have no delta
    expect(rows[1]!.delta).toBeUndefined();
  });
});

// ============================================================================
// formatResultsTable Tests
// ============================================================================

describe('formatResultsTable', () => {
  const baseSummary: EvalRunSummary = {
    run_id: 'run-abc12345-def6-7890',
    project_name: 'test-project',
    timestamp: '2026-02-15T12:00:00.000Z',
    query_count: 10,
    metrics: {
      mrr: 0.85,
      precision_at_k: 0.65,
      recall_at_k: 0.72,
      hit_rate: 0.90,
      ndcg: 0.78,
      map: 0.74,
    },
    config: { top_k: 5 },
  };

  const thresholds = { mrr: 0.7, hit_rate: 0.85, precision_at_k: 0.6 };

  it('includes project name and query count in header', () => {
    const rows = buildMetricRows(baseSummary.metrics, thresholds);
    const output = formatResultsTable(baseSummary, rows);

    expect(output).toContain('test-project');
    expect(output).toContain('Queries: 10');
  });

  it('includes truncated run ID', () => {
    const rows = buildMetricRows(baseSummary.metrics, thresholds);
    const output = formatResultsTable(baseSummary, rows);

    expect(output).toContain('run-abc1');
  });

  it('shows metric values', () => {
    const rows = buildMetricRows(baseSummary.metrics, thresholds);
    const output = formatResultsTable(baseSummary, rows);

    expect(output).toContain('0.850'); // MRR
    expect(output).toContain('0.900'); // Hit Rate
    expect(output).toContain('0.650'); // Precision@K
  });

  it('shows PASS/FAIL for threshold metrics', () => {
    const rows = buildMetricRows(baseSummary.metrics, thresholds);
    const output = formatResultsTable(baseSummary, rows);

    // All threshold metrics pass in the test data
    // chalk.green('PASS') produces styled text that still contains 'PASS'
    expect(output).toContain('PASS');
  });

  it('shows trend arrows when comparison exists', () => {
    const summaryWithComparison: EvalRunSummary = {
      ...baseSummary,
      comparison: {
        previous_run_id: 'prev-run',
        metric_changes: {
          mrr: 0.08,
          hit_rate: -0.02,
          precision_at_k: -0.07,
          recall_at_k: 0.03,
          ndcg: 0.12,
          map: -0.01,
        },
      },
    };

    const rows = buildMetricRows(
      summaryWithComparison.metrics,
      thresholds,
      summaryWithComparison.comparison,
    );
    const output = formatResultsTable(summaryWithComparison, rows);

    // Should contain trend direction header
    expect(output).toContain('Trend');
    expect(output).toContain('Change');
  });

  it('shows regression/improvement summary when comparison exists', () => {
    const summaryWithComparison: EvalRunSummary = {
      ...baseSummary,
      comparison: {
        previous_run_id: 'prev-run',
        metric_changes: {
          mrr: 0.08,
          precision_at_k: -0.07,
        },
      },
    };

    const rows = buildMetricRows(
      summaryWithComparison.metrics,
      thresholds,
      summaryWithComparison.comparison,
    );
    const output = formatResultsTable(summaryWithComparison, rows);

    expect(output).toContain('Improvements');
    expect(output).toContain('MRR');
    expect(output).toContain('Regressions');
    expect(output).toContain('Precision@K');
  });

  it('shows "All metrics stable" when no regressions or improvements', () => {
    const summaryWithComparison: EvalRunSummary = {
      ...baseSummary,
      comparison: {
        previous_run_id: 'prev-run',
        metric_changes: {
          mrr: 0.01,
          hit_rate: -0.01,
          precision_at_k: 0.02,
          recall_at_k: -0.03,
          ndcg: 0.01,
          map: 0.00,
        },
      },
    };

    const rows = buildMetricRows(
      summaryWithComparison.metrics,
      thresholds,
      summaryWithComparison.comparison,
    );
    const output = formatResultsTable(summaryWithComparison, rows);

    expect(output).toContain('All metrics stable');
  });
});
