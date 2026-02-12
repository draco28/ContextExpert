/**
 * Evaluation Runner
 *
 * Batch evaluation orchestrator that ties together golden datasets,
 * RAG search, retrieval metrics, and database storage.
 *
 * Flow:
 * 1. Load golden dataset for a project
 * 2. Create eval_run record (status: running)
 * 3. For each golden entry: run RAG search, compute retrieval metrics
 * 4. Aggregate metrics into run summary
 * 5. Update eval_run (status: completed)
 * 6. Return EvalRunSummary with optional comparison to previous run
 *
 * Uses dependency injection for testability — see createEvalRunnerDeps()
 * for production wiring.
 */

import {
  EvalConfigSchema,
  EvalError,
  type EvalConfig,
  type EvalResultInput,
  type EvalRunSummary,
  type GoldenDataset,
  type RetrievalMetrics,
} from './types.js';
import { computePerQueryMetrics, computeAggregateMetrics, type QueryResult } from './metrics.js';
import { loadGoldenDataset as defaultLoadGoldenDataset } from './golden.js';
import type { DatabaseOperations } from '../database/operations.js';
import type { ContextExpertRAGEngine } from '../agent/rag-engine.js';
import type { Config } from '../config/schema.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Simplified search result for evaluation.
 *
 * Abstracts away the full RAGSearchResult — the runner only needs
 * file paths (for metrics) and latency (for performance tracking).
 */
export interface EvalSearchResult {
  /** File paths from retrieved results, in rank order */
  filePaths: string[];
  /** End-to-end search latency in milliseconds */
  latencyMs: number;
}

/**
 * Injectable dependencies for the eval runner.
 *
 * Enables testing without complex module mocks — tests provide
 * simple function stubs and an in-memory SQLite database.
 *
 * For production usage, see createEvalRunnerDeps().
 */
export interface EvalRunnerDeps {
  /** Execute a RAG search, returning ranked file paths */
  search: (query: string, topK: number) => Promise<EvalSearchResult>;
  /** Database operations for storing eval runs and results */
  db: DatabaseOperations;
  /** Load the golden dataset for a project */
  loadGoldenDataset: (projectName: string) => GoldenDataset;
  /** Project ID in the database (for eval_run records) */
  projectId: string;
  /** Eval config with thresholds and default_k */
  evalConfig: EvalConfig;
}

/**
 * Options for running an evaluation.
 */
export interface EvalRunOptions {
  /** Project name (used for golden dataset lookup and display) */
  projectName: string;
  /** Override top-k for retrieval metrics (defaults to evalConfig.default_k) */
  topK?: number;
  /** Include generation-quality evaluation via RAGAS (future, not implemented) */
  includeGeneration?: boolean;
  /** Filter golden entries by tags (only entries with at least one matching tag) */
  tags?: string[];
}

// ============================================================================
// PRIVATE HELPERS
// ============================================================================

/** Placeholder metrics for a new eval run (all zeros). */
const ZERO_METRICS: RetrievalMetrics = {
  mrr: 0,
  precision_at_k: 0,
  recall_at_k: 0,
  hit_rate: 0,
  ndcg: 0,
  map: 0,
};

/**
 * Build comparison data against the previous eval run.
 *
 * Fetches the 2 most recent runs for this project. If a previous
 * run exists (different from currentRunId), computes metric deltas.
 * Positive delta = improvement, negative = regression.
 */
function buildComparison(
  db: DatabaseOperations,
  projectId: string,
  currentRunId: string,
  currentMetrics: RetrievalMetrics,
): EvalRunSummary['comparison'] {
  const recentRuns = db.getEvalRuns(projectId, 2);
  const previousRun = recentRuns.find((r) => r.id !== currentRunId);

  if (!previousRun) {
    return undefined;
  }

  const previousMetrics: RetrievalMetrics = JSON.parse(previousRun.metrics);

  return {
    previous_run_id: previousRun.id,
    metric_changes: {
      mrr: currentMetrics.mrr - previousMetrics.mrr,
      precision_at_k: currentMetrics.precision_at_k - previousMetrics.precision_at_k,
      recall_at_k: currentMetrics.recall_at_k - previousMetrics.recall_at_k,
      hit_rate: currentMetrics.hit_rate - previousMetrics.hit_rate,
      ndcg: currentMetrics.ndcg - previousMetrics.ndcg,
      map: currentMetrics.map - previousMetrics.map,
    },
  };
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

/**
 * Run a batch evaluation against a golden dataset.
 *
 * Orchestrates the full eval pipeline: load golden data, run RAG searches,
 * compute per-query and aggregate retrieval metrics, store results in SQLite,
 * and return a summary with optional comparison to the previous run.
 *
 * @param options - Evaluation run options (projectName, topK, tags)
 * @param deps - Injectable dependencies (search, db, config)
 * @returns EvalRunSummary with aggregate metrics and optional comparison
 * @throws EvalError DATASET_NOT_FOUND if golden dataset has no entries
 * @throws EvalError DATASET_INVALID if no entries have expectedFilePaths
 * @throws EvalError EVAL_RUN_FAILED if search or storage fails mid-run
 *
 * @example
 * ```typescript
 * const deps = createEvalRunnerDeps(ragEngine, dbOps, config);
 * const summary = await runEval({ projectName: 'my-project' }, deps);
 * console.log(`MRR: ${summary.metrics.mrr}`);
 * ```
 */
export async function runEval(
  options: EvalRunOptions,
  deps: EvalRunnerDeps,
): Promise<EvalRunSummary> {
  const { projectName, topK: overrideK, tags } = options;
  const { search, db, loadGoldenDataset: loadDataset, projectId, evalConfig } = deps;
  const k = overrideK ?? evalConfig.default_k;

  // ── Step 1: Load and validate golden dataset ────────────────────────────
  const dataset = loadDataset(projectName);

  if (dataset.entries.length === 0) {
    throw EvalError.datasetNotFound(projectName);
  }

  // Filter to entries with expectedFilePaths (skip answer-only entries)
  const entriesWithFilePaths = dataset.entries.filter(
    (e) => e.expectedFilePaths && e.expectedFilePaths.length > 0,
  );
  const noFilePathsCount = dataset.entries.length - entriesWithFilePaths.length;

  // Optionally filter by tags
  let evaluableEntries = entriesWithFilePaths;
  if (tags && tags.length > 0) {
    evaluableEntries = entriesWithFilePaths.filter(
      (e) => e.tags?.some((t) => tags.includes(t)),
    );
  }
  const tagFilteredCount = entriesWithFilePaths.length - evaluableEntries.length;

  if (evaluableEntries.length === 0) {
    throw EvalError.datasetInvalid(
      'No entries with expectedFilePaths found in golden dataset',
    );
  }

  // ── Step 2: Create eval_run record ──────────────────────────────────────
  const configSnapshot: Record<string, unknown> = {
    top_k: k,
    include_generation: options.includeGeneration ?? false,
    tags: tags ?? [],
  };

  const runId = db.insertEvalRun({
    project_id: projectId,
    dataset_version: dataset.version,
    query_count: evaluableEntries.length,
    metrics: ZERO_METRICS,
    config: configSnapshot,
    notes: 'status:running',
  });

  // ── Step 3–6: Evaluate, aggregate, store, return ────────────────────────
  try {
    const queryResults: QueryResult[] = [];
    const evalResults: EvalResultInput[] = [];

    // Step 3: Run search and compute per-query metrics
    for (const entry of evaluableEntries) {
      const { filePaths, latencyMs } = await search(entry.query, k);

      const metrics = computePerQueryMetrics(
        filePaths,
        entry.expectedFilePaths!,
        k,
      );

      // Per-query pass: at least one relevant result in top-K
      const passed = metrics.hit_rate === 1;

      evalResults.push({
        eval_run_id: runId,
        query: entry.query,
        expected_files: entry.expectedFilePaths!,
        retrieved_files: filePaths,
        latency_ms: latencyMs,
        metrics,
        passed,
      });

      queryResults.push({
        retrieved: filePaths,
        expected: entry.expectedFilePaths!,
      });
    }

    // Step 4: Aggregate metrics across all queries
    const aggregateMetrics = computeAggregateMetrics(queryResults, k);

    // Step 5: Batch insert per-query results and update run
    db.insertEvalResults(evalResults);

    const passedCount = evalResults.filter((r) => r.passed).length;
    const completionNotes = [
      'status:completed',
      `${passedCount}/${evaluableEntries.length} passed`,
      noFilePathsCount > 0 ? `${noFilePathsCount} skipped (no expectedFilePaths)` : '',
      tagFilteredCount > 0 ? `${tagFilteredCount} filtered by tags` : '',
    ].filter(Boolean).join(' | ');

    db.updateEvalRun(runId, {
      metrics: aggregateMetrics,
      query_count: evaluableEntries.length,
      notes: completionNotes,
    });

    // Step 6: Build comparison with previous run and return summary
    const comparison = buildComparison(db, projectId, runId, aggregateMetrics);

    return {
      run_id: runId,
      project_name: projectName,
      timestamp: new Date().toISOString(),
      query_count: evaluableEntries.length,
      metrics: aggregateMetrics,
      config: configSnapshot,
      comparison,
    };
  } catch (error) {
    // Mark run as failed in the database
    const errorMessage = error instanceof Error ? error.message : String(error);
    try {
      db.updateEvalRun(runId, {
        notes: `status:failed | ${errorMessage}`,
      });
    } catch {
      // Swallow secondary DB error — the original error is more important
    }

    // Re-throw EvalError as-is, wrap everything else
    if (error instanceof EvalError) {
      throw error;
    }

    throw EvalError.evalRunFailed(
      errorMessage,
      error instanceof Error ? error : undefined,
    );
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Create EvalRunnerDeps from a RAG engine and application config.
 *
 * Production factory that wires real dependencies. Tests should
 * construct EvalRunnerDeps directly with mock functions instead.
 *
 * @param engine - Initialized RAG engine for the target project
 * @param db - Database operations instance
 * @param config - Application config (eval section used for thresholds/k)
 * @returns Ready-to-use EvalRunnerDeps
 */
export function createEvalRunnerDeps(
  engine: ContextExpertRAGEngine,
  db: DatabaseOperations,
  config: Config,
): EvalRunnerDeps {
  const evalConfig = EvalConfigSchema.parse(config.eval ?? {});

  return {
    search: async (query: string, topK: number): Promise<EvalSearchResult> => {
      const startTime = performance.now();
      const result = await engine.search(query, {
        finalK: topK,
      });
      const latencyMs = Math.round(performance.now() - startTime);

      return {
        filePaths: result.rawResults.map((r) => r.filePath),
        latencyMs,
      };
    },
    db,
    loadGoldenDataset: defaultLoadGoldenDataset,
    projectId: engine.getProjectId(),
    evalConfig,
  };
}
