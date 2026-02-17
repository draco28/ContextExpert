/**
 * Evaluation & Observability Types
 *
 * Type definitions for the evaluation and observability system:
 * - Config schemas (Zod) for user-facing [eval] and [observability] TOML sections
 * - Trace types for always-on local recording
 * - Eval run types for batch evaluation against golden datasets
 * - Retrieval metrics (MRR, P@K, R@K, Hit Rate, NDCG, MAP)
 * - Golden dataset format for test cases
 * - Error types with factory methods
 *
 * Shared across eval/, observability/, database/, and CLI modules.
 */

import { z } from 'zod';

// ============================================================================
// CONFIGURATION SCHEMAS (User-facing, validated at runtime)
// ============================================================================

/**
 * Evaluation configuration schema for config.toml [eval] section.
 *
 * Controls golden dataset location, retrieval quality thresholds, and
 * optional Python/RAGAS integration for answer quality metrics.
 *
 * @example config.toml
 * ```toml
 * [eval]
 * golden_path = "~/.ctx/eval"
 * default_k = 5
 * python_path = "/usr/bin/python3"
 * ragas_model = "gpt-4o-mini"
 *
 * [eval.thresholds]
 * mrr = 0.7
 * hit_rate = 0.85
 * precision_at_k = 0.6
 * ```
 */
export const EvalConfigSchema = z.object({
  /**
   * Directory path for golden datasets.
   *
   * Structure: <golden_path>/<projectName>/golden.json
   * Supports tilde expansion for home directory.
   * Default: '~/.ctx/eval'
   */
  golden_path: z
    .string()
    .default('~/.ctx/eval')
    .describe('Directory path for golden datasets'),

  /**
   * Default value of k for Precision@K, Recall@K, NDCG@K.
   *
   * Common values: 5 (focused), 10 (comprehensive), 20 (recall-heavy).
   * Default: 5 (matches typical RAG top-k)
   */
  default_k: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(5)
    .describe('Default k for retrieval metrics (1-100)'),

  /**
   * Quality thresholds for pass/fail evaluation.
   *
   * Metrics below these thresholds trigger warnings in eval reports.
   * Based on industry benchmarks for code search RAG systems.
   */
  thresholds: z
    .object({
      /** Mean Reciprocal Rank target (0-1, higher = better). Default: 0.7 */
      mrr: z.number().min(0).max(1).default(0.7),
      /** Hit rate at k target (0-1, higher = better). Default: 0.85 */
      hit_rate: z.number().min(0).max(1).default(0.85),
      /** Precision at k target (0-1, higher = better). Default: 0.6 */
      precision_at_k: z.number().min(0).max(1).default(0.6),
    })
    .default({}),

  /**
   * Python executable path for RAGAS/DeepEval integration.
   *
   * Used for answer quality evaluation (faithfulness, relevancy).
   * Only needed if running `ctx eval run --ragas`.
   * Default: 'python3' (assumes available in PATH)
   */
  python_path: z
    .string()
    .default('python3')
    .describe('Python executable path for RAGAS integration'),

  /**
   * LLM model for RAGAS answer evaluation.
   *
   * Used as the judge model for faithfulness/relevancy scoring.
   * Requires an OpenAI-compatible API key.
   * Default: 'gpt-4o-mini' (fast, low cost)
   */
  ragas_model: z
    .string()
    .default('gpt-4o-mini')
    .describe('LLM model for RAGAS answer evaluation'),
});

export type EvalConfig = z.infer<typeof EvalConfigSchema>;

/**
 * Observability configuration schema for config.toml [observability] section.
 *
 * Controls always-on local trace recording and optional Langfuse cloud sync.
 * Local SQLite traces are always captured; Langfuse sync requires API keys.
 *
 * @example config.toml
 * ```toml
 * [observability]
 * enabled = true
 * sample_rate = 1.0
 * langfuse_public_key = "pk-lf-..."
 * langfuse_secret_key = "sk-lf-..."
 * langfuse_host = "https://cloud.langfuse.com"
 * ```
 */
export const ObservabilityConfigSchema = z.object({
  /**
   * Enable observability features.
   *
   * When true, traces are recorded to local SQLite.
   * When false, no trace recording occurs.
   * Default: true
   */
  enabled: z.boolean().default(true).describe('Enable trace recording'),

  /**
   * Langfuse public API key.
   *
   * Required for cloud sync. Get from https://cloud.langfuse.com/settings
   * Can also be set via LANGFUSE_PUBLIC_KEY environment variable.
   */
  langfuse_public_key: z
    .string()
    .optional()
    .describe('Langfuse public API key for cloud sync'),

  /**
   * Langfuse secret API key.
   *
   * Required for cloud sync. Get from https://cloud.langfuse.com/settings
   * Can also be set via LANGFUSE_SECRET_KEY environment variable.
   */
  langfuse_secret_key: z
    .string()
    .optional()
    .describe('Langfuse secret API key for cloud sync'),

  /**
   * Langfuse API host URL.
   *
   * Override for self-hosted Langfuse instances.
   * Default: 'https://cloud.langfuse.com'
   */
  langfuse_host: z
    .string()
    .url()
    .default('https://cloud.langfuse.com')
    .describe('Langfuse API host URL'),

  /**
   * Trace sampling rate for local SQLite recording.
   *
   * Controls what fraction of interactions are recorded to eval_traces.
   * 1.0 = all interactions (default), 0.5 = 50%, 0.0 = none.
   * Reduces SQLite disk usage on high-traffic deployments.
   * Langfuse cloud sync has its own sampling via the Langfuse SDK.
   * Default: 1.0
   */
  sample_rate: z
    .number()
    .min(0)
    .max(1)
    .default(1.0)
    .describe('Trace sampling rate for local SQLite recording (0.0-1.0)'),
});

export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>;

// ============================================================================
// TRACE CAPTURE TYPES (Always-on local recording)
// ============================================================================

/**
 * Evaluation trace record stored in SQLite eval_traces table.
 *
 * Captures every RAG query for retrospective analysis, trend tracking,
 * and golden dataset generation via `ctx eval golden capture`.
 *
 * JSON fields (retrieved_files, metadata) are stored as TEXT in SQLite
 * and parsed on read.
 */
export interface EvalTrace {
  /** UUID primary key */
  id: string;
  /** Foreign key to projects.id */
  project_id: string;
  /** User's original query text */
  query: string;
  /** ISO 8601 timestamp of query execution */
  timestamp: string;
  /** JSON-serialized array of retrieved file paths */
  retrieved_files: string;
  /** Number of results requested (top-k) */
  top_k: number;
  /** End-to-end retrieval latency in milliseconds */
  latency_ms: number;
  /** LLM-generated answer text (null for search-only queries) */
  answer: string | null;
  /** Retrieval method used: 'dense', 'bm25', or 'fusion' */
  retrieval_method: string;
  /** Optional user feedback on result quality */
  feedback: string | null;
  /** JSON-serialized custom metadata */
  metadata: string | null;
  /** Langfuse trace ID for cross-referencing local and cloud traces */
  langfuse_trace_id: string | null;
  /** Command type that created this trace: 'ask', 'search', or 'chat' (null for legacy traces) */
  trace_type: string | null;
}

/**
 * Input for creating a new trace record.
 *
 * Uses native types (arrays, objects) that get serialized to JSON
 * before SQLite insertion.
 */
export interface TraceInput {
  project_id: string;
  query: string;
  retrieved_files: string[];
  top_k: number;
  latency_ms: number;
  answer?: string;
  retrieval_method: 'dense' | 'bm25' | 'fusion';
  feedback?: 'positive' | 'negative';
  metadata?: Record<string, unknown>;
  /** Langfuse trace ID for cross-referencing local and cloud traces */
  langfuse_trace_id?: string;
  /** Command type that created this trace: 'ask', 'search', or 'chat' */
  trace_type?: 'ask' | 'search' | 'chat';
}

/**
 * Filter criteria for querying traces.
 *
 * All fields are optional — omitted fields don't filter.
 */
export interface TraceFilter {
  /** Filter by project ID */
  project_id?: string;
  /** Include traces from this ISO date onward */
  start_date?: string;
  /** Include traces up to this ISO date */
  end_date?: string;
  /** Filter by user feedback value */
  feedback?: 'positive' | 'negative';
  /** Maximum number of results to return */
  limit?: number;
  /** Filter by trace type */
  trace_type?: 'ask' | 'search' | 'chat';
}

// ============================================================================
// EVAL RUN TYPES (Batch evaluation against golden datasets)
// ============================================================================

/**
 * Evaluation run record stored in SQLite eval_runs table.
 *
 * Represents a single batch evaluation of all golden dataset entries.
 * The metrics and config fields are JSON-serialized for flexible storage.
 */
export interface EvalRun {
  /** UUID primary key */
  id: string;
  /** Foreign key to projects.id */
  project_id: string;
  /** ISO 8601 timestamp of evaluation execution */
  timestamp: string;
  /** Golden dataset version evaluated (e.g., '1.0') */
  dataset_version: string;
  /** Number of queries in the golden dataset */
  query_count: number;
  /** JSON-serialized aggregate RetrievalMetrics */
  metrics: string;
  /** JSON-serialized RAG config snapshot used during evaluation */
  config: string;
  /** Optional human-readable notes about this run */
  notes: string | null;
}

/**
 * Input for creating an eval run record.
 *
 * Uses typed objects that get serialized before storage.
 */
export interface EvalRunInput {
  project_id: string;
  dataset_version: string;
  query_count: number;
  metrics: RetrievalMetrics;
  config: Record<string, unknown>;
  notes?: string;
}

/**
 * Individual query result within an eval run.
 *
 * Stored in SQLite eval_results table. One record per golden
 * dataset entry, enabling per-query analysis of failures.
 */
export interface EvalResult {
  /** UUID primary key */
  id: string;
  /** Foreign key to eval_runs.id */
  eval_run_id: string;
  /** The query text from golden dataset */
  query: string;
  /** JSON-serialized array of expected file paths */
  expected_files: string;
  /** JSON-serialized array of actually retrieved file paths */
  retrieved_files: string;
  /** Retrieval latency for this query in milliseconds */
  latency_ms: number;
  /** JSON-serialized per-query metrics */
  metrics: string;
  /** Whether this query met threshold criteria */
  passed: boolean;
}

/**
 * Input for creating an eval result record.
 *
 * Uses typed objects and arrays that get serialized before storage.
 */
export interface EvalResultInput {
  eval_run_id: string;
  query: string;
  expected_files: string[];
  retrieved_files: string[];
  latency_ms: number;
  metrics: {
    /** 1/rank of first relevant result (0 if none found) */
    reciprocal_rank: number;
    /** Fraction of top-k results that are relevant */
    precision_at_k: number;
    /** Fraction of relevant results in top-k */
    recall_at_k: number;
    /** 1 if any relevant result in top-k, else 0 */
    hit_rate: number;
  };
  passed: boolean;
}

// ============================================================================
// METRICS TYPES
// ============================================================================

/**
 * Aggregate retrieval quality metrics.
 *
 * Standard Information Retrieval metrics for evaluating RAG search.
 * All values are in [0, 1] range where higher is better.
 */
export interface RetrievalMetrics {
  /**
   * Mean Reciprocal Rank (MRR).
   *
   * Average of 1/rank for the first relevant result across all queries.
   * MRR=1.0 means every query's first result was relevant.
   * Target: > 0.7
   */
  mrr: number;

  /**
   * Precision at k.
   *
   * Average fraction of top-k results that are relevant.
   * High precision = few irrelevant results in top-k.
   * Target: > 0.6 for k=5
   */
  precision_at_k: number;

  /**
   * Recall at k.
   *
   * Average fraction of all relevant documents found in top-k.
   * High recall = most relevant files are surfaced.
   * Target: > 0.8 for k=5
   */
  recall_at_k: number;

  /**
   * Hit Rate at k.
   *
   * Fraction of queries with at least one relevant result in top-k.
   * The most intuitive metric: "how often do we find something useful?"
   * Target: > 0.85 for k=5
   */
  hit_rate: number;

  /**
   * Normalized Discounted Cumulative Gain (NDCG).
   *
   * Rank-aware metric that penalizes relevant results at lower positions.
   * Unlike precision, NDCG rewards having the BEST results at the TOP.
   * Target: > 0.75 for k=10
   */
  ndcg: number;

  /**
   * Mean Average Precision (MAP).
   *
   * Average precision computed at each relevant result position.
   * Combines precision and recall into a single rank-aware score.
   * Target: > 0.7
   */
  map: number;
}

/**
 * Summary of an eval run with optional comparison to previous run.
 *
 * Used for displaying eval results in `ctx eval report`.
 */
export interface EvalRunSummary {
  /** Eval run ID */
  run_id: string;
  /** Project name for display */
  project_name: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Number of golden queries evaluated */
  query_count: number;
  /** Aggregate retrieval metrics */
  metrics: RetrievalMetrics;
  /** RAG config snapshot used during eval */
  config: Record<string, unknown>;
  /** Comparison to previous run (when available) */
  comparison?: {
    /** Previous run ID for reference */
    previous_run_id: string;
    /** Metric deltas: positive = improvement, negative = regression */
    metric_changes: Partial<RetrievalMetrics>;
  };
}

/**
 * Trend data across multiple eval runs for a project.
 *
 * Used for plotting metrics over time in `ctx eval report --last N`.
 */
export interface EvalTrend {
  /** Project name */
  project_name: string;
  /** Run summaries ordered by timestamp (oldest first) */
  runs: EvalRunSummary[];
}

// ============================================================================
// GOLDEN DATASET TYPES
// ============================================================================

/**
 * Source of a golden dataset entry.
 *
 * Tracks provenance for audit and quality control:
 * - 'manual': Hand-written by developer (highest quality)
 * - 'generated': Created by LLM from codebase analysis
 * - 'captured': Promoted from positive-feedback traces
 */
export type GoldenEntrySource = 'manual' | 'generated' | 'captured';

/**
 * Golden dataset file format.
 *
 * Stored as JSON at <golden_path>/<projectName>/golden.json.
 * Uses file paths (not chunk IDs) so datasets survive re-indexing.
 */
export interface GoldenDataset {
  /** Schema version for forward compatibility */
  version: '1.0';
  /** Project name this dataset evaluates */
  projectName: string;
  /** Evaluation query entries */
  entries: GoldenEntry[];
}

/**
 * A single evaluation test case in the golden dataset.
 *
 * Each entry defines a query and its expected results.
 * At least one of expectedFilePaths or expectedAnswer should be provided.
 */
export interface GoldenEntry {
  /** Unique ID within the dataset (UUID) */
  id: string;
  /** The query to evaluate against the RAG pipeline */
  query: string;
  /** Expected file paths that should be retrieved (for retrieval metrics) */
  expectedFilePaths?: string[];
  /** Expected answer text (for answer quality metrics via RAGAS) */
  expectedAnswer?: string;
  /** Tags for filtering subsets (e.g., ['api', 'auth', 'critical']) */
  tags?: string[];
  /** How this entry was created */
  source: GoldenEntrySource;
}

// ============================================================================
// ERROR TYPES
// ============================================================================

// ============================================================================
// PYTHON BRIDGE TYPES
// ============================================================================

/**
 * Result of checking whether Python and eval packages are available.
 *
 * Returned by PythonEvalBridge.checkAvailability() — never throws,
 * always returns a result so callers can decide how to degrade gracefully.
 */
export interface PythonAvailability {
  /** Whether the python executable was found and runs */
  pythonFound: boolean;
  /** Python version string (e.g., "3.11.5") or null if not found */
  pythonVersion: string | null;
  /** Whether the ragas package is importable */
  ragasAvailable: boolean;
  /** RAGAS version string or null */
  ragasVersion: string | null;
  /** Whether the deepeval package is importable */
  deepevalAvailable: boolean;
  /** DeepEval version string or null */
  deepevalVersion: string | null;
}

/**
 * RAGAS evaluation results returned from the Python subprocess.
 *
 * The Python script runs ragas.evaluate() and writes this JSON structure
 * to a temp file, which the bridge reads back and validates with Zod.
 */
export interface RagasResults {
  /** Aggregate scores per metric (0-1 range). Keys are metric names like "faithfulness", "answer_relevancy" */
  scores: Record<string, number>;
  /** Per-row detailed results for each question in the dataset */
  details: Array<{
    question: string;
    scores: Record<string, number>;
  }>;
  /** Execution metadata for logging and debugging */
  metadata: {
    duration_seconds: number;
    model_used: string;
    metrics_evaluated: string[];
  };
}

/**
 * DeepEval evaluation results returned from the Python subprocess.
 *
 * Same structure as RagasResults but includes per-metric reasoning
 * strings that DeepEval generates for each test case.
 */
export interface DeepEvalResults {
  /** Aggregate scores per metric (0-1 range) */
  scores: Record<string, number>;
  /** Per-row detailed results with reasoning */
  details: Array<{
    input: string;
    scores: Record<string, number>;
    reasons: Record<string, string>;
  }>;
  /** Execution metadata */
  metadata: {
    duration_seconds: number;
    model_used: string;
    metrics_evaluated: string[];
  };
}

/**
 * Error codes for eval/observability failures.
 *
 * Used in EvalError for programmatic error handling.
 */
export const EvalErrorCodes = {
  /** Golden dataset file not found for project */
  DATASET_NOT_FOUND: 'DATASET_NOT_FOUND',
  /** Golden dataset has invalid format */
  DATASET_INVALID: 'DATASET_INVALID',
  /** Batch evaluation run failed */
  EVAL_RUN_FAILED: 'EVAL_RUN_FAILED',
  /** Langfuse API communication error */
  LANGFUSE_ERROR: 'LANGFUSE_ERROR',
  /** Python/RAGAS subprocess error */
  RAGAS_ERROR: 'RAGAS_ERROR',
} as const;

export type EvalErrorCode = (typeof EvalErrorCodes)[keyof typeof EvalErrorCodes];

/**
 * Error thrown by the eval/observability system.
 *
 * Includes structured error codes and factory methods for common cases.
 * Follows the RAGEngineError pattern from agent/types.ts.
 */
export class EvalError extends Error {
  public readonly code: EvalErrorCode;
  public readonly cause?: Error;

  constructor(code: EvalErrorCode, message: string, cause?: Error) {
    super(message);
    this.name = 'EvalError';
    this.code = code;
    this.cause = cause;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, EvalError);
    }
  }

  /** Factory: golden dataset not found for a project */
  static datasetNotFound(projectName: string): EvalError {
    return new EvalError(
      EvalErrorCodes.DATASET_NOT_FOUND,
      `Golden dataset not found for project "${projectName}". Run: ctx eval golden init`
    );
  }

  /** Factory: golden dataset has invalid schema */
  static datasetInvalid(reason: string): EvalError {
    return new EvalError(
      EvalErrorCodes.DATASET_INVALID,
      `Invalid golden dataset: ${reason}`
    );
  }

  /** Factory: batch evaluation run failed */
  static evalRunFailed(reason: string, cause?: Error): EvalError {
    return new EvalError(
      EvalErrorCodes.EVAL_RUN_FAILED,
      `Evaluation run failed: ${reason}`,
      cause
    );
  }

  /** Factory: Langfuse API error */
  static langfuseError(reason: string, cause?: Error): EvalError {
    return new EvalError(
      EvalErrorCodes.LANGFUSE_ERROR,
      `Langfuse API error: ${reason}`,
      cause
    );
  }

  /** Factory: Python/RAGAS integration error */
  static ragasError(reason: string, cause?: Error): EvalError {
    return new EvalError(
      EvalErrorCodes.RAGAS_ERROR,
      `RAGAS integration error: ${reason}`,
      cause
    );
  }
}
