/**
 * Evaluation Aggregator
 *
 * Compares eval runs over time to surface quality trends.
 * Used by `ctx eval report` to show metric changes, flag regressions,
 * and display human-readable trend reports.
 *
 * Three public functions:
 * - computeTrend(runs) — deltas and direction for each metric
 * - compareRuns(current, previous) — regressions (>5% drop) and improvements
 * - formatTrendReport(trend) — CLI table with arrows (↑/↓/→)
 */

import type { EvalRun, RetrievalMetrics } from './types.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Absolute change threshold for flagging regressions/improvements.
 *
 * A metric must change by more than 0.05 (5 percentage points on the 0-1 scale)
 * to be flagged. Exactly ±0.05 is treated as stable.
 */
export const REGRESSION_THRESHOLD = 0.05;

/**
 * Ordered list of all retrieval metric keys.
 *
 * Used for iteration — avoids `Object.keys()` which loses type information.
 */
const METRIC_NAMES: readonly (keyof RetrievalMetrics)[] = [
  'mrr',
  'precision_at_k',
  'recall_at_k',
  'hit_rate',
  'ndcg',
  'map',
] as const;

// ============================================================================
// TYPES
// ============================================================================

/**
 * Direction of metric change between consecutive runs.
 *
 * - 'up': improved by more than REGRESSION_THRESHOLD
 * - 'down': regressed by more than REGRESSION_THRESHOLD
 * - 'stable': change within ±REGRESSION_THRESHOLD (or no previous run)
 */
export type MetricDirection = 'up' | 'down' | 'stable';

/**
 * Trend analysis for a single metric across runs.
 */
export interface MetricTrend {
  /** Which metric this trend describes */
  metric: keyof RetrievalMetrics;
  /** Value from the most recent run */
  current: number;
  /** Value from the previous run (null if first run) */
  previous: number | null;
  /** Absolute change: current - previous (null if first run) */
  delta: number | null;
  /** Direction of change based on REGRESSION_THRESHOLD */
  direction: MetricDirection;
  /** True if metric dropped by more than REGRESSION_THRESHOLD */
  isRegression: boolean;
  /** True if metric improved by more than REGRESSION_THRESHOLD */
  isImprovement: boolean;
}

/**
 * Overall trend analysis across multiple eval runs.
 *
 * Returned by computeTrend(), consumed by formatTrendReport().
 */
export interface TrendResult {
  /** Project ID from the eval runs */
  projectId: string;
  /** Total number of runs analyzed */
  runCount: number;
  /** Most recent run ID */
  currentRunId: string;
  /** Previous run ID (null if only one run) */
  previousRunId: string | null;
  /** Per-metric trend data (one entry per metric, 6 total) */
  trends: MetricTrend[];
  /** True if any metric has a regression */
  hasRegressions: boolean;
  /** True if any metric has an improvement */
  hasImprovements: boolean;
}

/**
 * Detailed comparison between two sets of retrieval metrics.
 *
 * Returned by compareRuns() for programmatic analysis.
 */
export interface RunComparison {
  /** Per-metric comparison data */
  metrics: {
    [K in keyof RetrievalMetrics]: {
      current: number;
      previous: number;
      delta: number;
      direction: MetricDirection;
      isRegression: boolean;
      isImprovement: boolean;
    };
  };
  /** Aggregate counts for quick assessment */
  summary: {
    regressionCount: number;
    improvementCount: number;
    stableCount: number;
  };
}

// ============================================================================
// PRIVATE HELPERS
// ============================================================================

/**
 * Map metric keys to human-readable display names.
 */
function formatMetricName(metric: keyof RetrievalMetrics): string {
  const labels: Record<keyof RetrievalMetrics, string> = {
    mrr: 'MRR',
    precision_at_k: 'Precision@K',
    recall_at_k: 'Recall@K',
    hit_rate: 'Hit Rate',
    ndcg: 'NDCG',
    map: 'MAP',
  };
  return labels[metric];
}

/**
 * Determine metric direction from a delta value.
 *
 * Uses strict inequality (> not >=) so exactly ±REGRESSION_THRESHOLD is "stable".
 */
function classifyDelta(delta: number): {
  direction: MetricDirection;
  isRegression: boolean;
  isImprovement: boolean;
} {
  if (delta > REGRESSION_THRESHOLD) {
    return { direction: 'up', isRegression: false, isImprovement: true };
  }
  if (delta < -REGRESSION_THRESHOLD) {
    return { direction: 'down', isRegression: true, isImprovement: false };
  }
  return { direction: 'stable', isRegression: false, isImprovement: false };
}

// ============================================================================
// PUBLIC FUNCTIONS
// ============================================================================

/**
 * Compare two sets of retrieval metrics.
 *
 * Provides metric-by-metric comparison with regression/improvement flags.
 * Pure function — no DB access, no JSON parsing.
 *
 * @param current - Metrics from the more recent run
 * @param previous - Metrics from the earlier run
 * @returns Detailed comparison with per-metric analysis and summary counts
 *
 * @example
 * const comparison = compareRuns(
 *   { mrr: 0.80, precision_at_k: 0.55, ... },
 *   { mrr: 0.75, precision_at_k: 0.65, ... },
 * );
 * // comparison.metrics.mrr.isImprovement === true  (+0.05 exceeds threshold? No, exactly 0.05 → stable)
 * // comparison.metrics.precision_at_k.isRegression === true  (-0.10 < -0.05)
 */
export function compareRuns(
  current: RetrievalMetrics,
  previous: RetrievalMetrics,
): RunComparison {
  const metrics = {} as RunComparison['metrics'];
  let regressionCount = 0;
  let improvementCount = 0;
  let stableCount = 0;

  for (const name of METRIC_NAMES) {
    const delta = current[name] - previous[name];
    const { direction, isRegression, isImprovement } = classifyDelta(delta);

    if (isRegression) regressionCount++;
    else if (isImprovement) improvementCount++;
    else stableCount++;

    metrics[name] = {
      current: current[name],
      previous: previous[name],
      delta,
      direction,
      isRegression,
      isImprovement,
    };
  }

  return {
    metrics,
    summary: { regressionCount, improvementCount, stableCount },
  };
}

/**
 * Compute trend analysis across multiple eval runs.
 *
 * Takes EvalRun[] as returned by db.getEvalRuns() (ordered DESC by timestamp).
 * Compares the most recent run against the previous run to compute per-metric
 * deltas and direction.
 *
 * @param runs - Eval runs ordered by timestamp DESC (most recent first)
 * @returns Trend analysis with per-metric deltas and regression flags
 * @throws Error if runs array is empty
 * @throws Error if the most recent run has corrupted metrics JSON
 *
 * @example
 * const runs = db.getEvalRuns(projectId, 10);
 * const trend = computeTrend(runs);
 * if (trend.hasRegressions) console.warn('Quality dropped!');
 */
export function computeTrend(runs: EvalRun[]): TrendResult {
  if (runs.length === 0) {
    throw new Error('Cannot compute trend: no eval runs provided');
  }

  // runs[0] is the most recent (DESC order from DB)
  const currentRun = runs[0]!;
  const previousRun = runs.length > 1 ? runs[1]! : null;

  // Parse current run metrics — must succeed
  let currentMetrics: RetrievalMetrics;
  try {
    currentMetrics = JSON.parse(currentRun.metrics) as RetrievalMetrics;
  } catch {
    throw new Error(
      `Cannot compute trend: current run ${currentRun.id} has corrupted metrics JSON`,
    );
  }

  // Parse previous run metrics — graceful degradation if corrupted
  let previousMetrics: RetrievalMetrics | null = null;
  if (previousRun) {
    try {
      previousMetrics = JSON.parse(previousRun.metrics) as RetrievalMetrics;
    } catch {
      // Treat as no previous run — show current-only report
      previousMetrics = null;
    }
  }

  // Build per-metric trends
  const trends: MetricTrend[] = METRIC_NAMES.map((name) => {
    const current = currentMetrics[name];
    const previous = previousMetrics?.[name] ?? null;
    const delta = previous !== null ? current - previous : null;

    if (delta === null) {
      return {
        metric: name,
        current,
        previous,
        delta,
        direction: 'stable' as MetricDirection,
        isRegression: false,
        isImprovement: false,
      };
    }

    const { direction, isRegression, isImprovement } = classifyDelta(delta);
    return { metric: name, current, previous, delta, direction, isRegression, isImprovement };
  });

  return {
    projectId: currentRun.project_id,
    runCount: runs.length,
    currentRunId: currentRun.id,
    previousRunId: previousRun?.id ?? null,
    trends,
    hasRegressions: trends.some((t) => t.isRegression),
    hasImprovements: trends.some((t) => t.isImprovement),
  };
}

/**
 * Format trend analysis as a human-readable CLI report.
 *
 * Generates a table with arrows (↑↓→) showing metric changes,
 * followed by regression warnings and improvement highlights.
 *
 * @param trend - Trend result from computeTrend()
 * @returns Multi-line formatted report string
 */
export function formatTrendReport(trend: TrendResult): string {
  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push('Eval Trend Report');
  lines.push('=================');
  lines.push(`Runs analyzed: ${trend.runCount}`);
  lines.push(`Current run:  ${trend.currentRunId}`);
  if (trend.previousRunId) {
    lines.push(`Previous run: ${trend.previousRunId}`);
  } else {
    lines.push('Previous run: (none — first eval)');
  }
  lines.push('');

  // ── Metric table ──────────────────────────────────────────────────────────
  const arrow = (d: MetricDirection): string =>
    d === 'up' ? '↑' : d === 'down' ? '↓' : '→';

  if (trend.previousRunId) {
    // Full comparison table
    lines.push('Metric         Current  Previous  Change  Trend');
    lines.push('─────────────  ───────  ────────  ──────  ─────');

    for (const t of trend.trends) {
      const label = formatMetricName(t.metric).padEnd(13);
      const cur = t.current.toFixed(3).padStart(7);
      const prev = t.previous !== null ? t.previous.toFixed(3).padStart(8) : '       -';
      const delta =
        t.delta !== null
          ? ((t.delta >= 0 ? '+' : '') + t.delta.toFixed(3)).padStart(6)
          : '     -';
      lines.push(`${label}  ${cur}  ${prev}  ${delta}  ${arrow(t.direction)}`);
    }
  } else {
    // First run — current metrics only
    lines.push('Metric         Value');
    lines.push('─────────────  ───────');

    for (const t of trend.trends) {
      const label = formatMetricName(t.metric).padEnd(13);
      const val = t.current.toFixed(3).padStart(7);
      lines.push(`${label}  ${val}`);
    }
  }

  lines.push('');

  // ── Regressions ───────────────────────────────────────────────────────────
  const regressions = trend.trends.filter((t) => t.isRegression);
  if (regressions.length > 0) {
    lines.push(`Regressions (${regressions.length}):`);
    for (const t of regressions) {
      const absChange = Math.abs(t.delta!).toFixed(3);
      lines.push(
        `  ${formatMetricName(t.metric)} dropped by ${absChange} (${t.previous!.toFixed(3)} -> ${t.current.toFixed(3)})`,
      );
    }
    lines.push('');
  }

  // ── Improvements ──────────────────────────────────────────────────────────
  const improvements = trend.trends.filter((t) => t.isImprovement);
  if (improvements.length > 0) {
    lines.push(`Improvements (${improvements.length}):`);
    for (const t of improvements) {
      lines.push(
        `  ${formatMetricName(t.metric)} improved by ${t.delta!.toFixed(3)} (${t.previous!.toFixed(3)} -> ${t.current.toFixed(3)})`,
      );
    }
    lines.push('');
  }

  // ── All stable ────────────────────────────────────────────────────────────
  if (!trend.hasRegressions && !trend.hasImprovements && trend.previousRunId) {
    lines.push('All metrics stable (no changes exceeding 5%)');
    lines.push('');
  }

  return lines.join('\n');
}
