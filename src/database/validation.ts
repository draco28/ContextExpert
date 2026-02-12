/**
 * Database Row Validation (Ticket #51)
 *
 * Zod schemas for validating database reads at runtime.
 * Provides type safety that survives beyond compile time.
 *
 * Why Zod validation on database reads?
 * - TypeScript `as Type` casts are erased at runtime
 * - Database schema can drift from code (failed migrations, manual changes)
 * - Early detection with clear error messages vs silent corruption
 *
 * Usage:
 * ```ts
 * // Instead of:
 * const row = db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as Project;
 *
 * // Use:
 * const row = db.prepare('SELECT * FROM projects WHERE name = ?').get(name);
 * return row ? validateRow(ProjectRowSchema, row, `projects.name=${name}`) : undefined;
 * ```
 */

import { z, type ZodIssue } from 'zod';
import { CLIError } from '../errors/types.js';

// ============================================================================
// Project Schema
// ============================================================================

/**
 * Zod schema for validating Project rows from the database.
 *
 * Matches the `Project` interface in schema.ts exactly.
 * All nullable fields use `.nullable()` to match SQLite's NULL behavior.
 */
export const ProjectRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  tags: z.string().nullable(),
  ignore_patterns: z.string().nullable(),
  indexed_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  file_count: z.number().int().nonnegative(),
  chunk_count: z.number().int().nonnegative(),
  config: z.string().nullable(),
  embedding_model: z.string().nullable(),
  // Default matches the migration's DEFAULT 1024
  embedding_dimensions: z.number().int().positive().default(1024),
  description: z.string().nullable(),
});

/** Type inferred from ProjectRowSchema (should match Project interface) */
export type ProjectRow = z.infer<typeof ProjectRowSchema>;

// ============================================================================
// Chunk Schema
// ============================================================================

/**
 * Zod schema for validating Chunk rows from the database.
 *
 * Note: `embedding` is a Buffer (BLOB) - we validate it exists and is a Buffer.
 * The actual Float32Array conversion happens in application code.
 */
export const ChunkRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  content: z.string(),
  // Buffer validation - SQLite returns BLOBs as Buffers via better-sqlite3
  embedding: z.instanceof(Buffer),
  file_path: z.string(),
  // Nullable enum for file_type
  file_type: z.enum(['code', 'docs', 'config']).nullable(),
  language: z.string().nullable(),
  start_line: z.number().int().nullable(),
  end_line: z.number().int().nullable(),
  metadata: z.string().nullable(),
  created_at: z.string(),
});

/** Type inferred from ChunkRowSchema (should match Chunk interface) */
export type ChunkRow = z.infer<typeof ChunkRowSchema>;

/**
 * Partial schema for chunk rows loaded in VectorStoreManager.
 *
 * This matches the SELECT subset used when loading chunks for vector search:
 * - Includes embedding (Buffer)
 * - Excludes project_id, created_at (not needed at load time)
 */
export const ChunkLoadRowSchema = z.object({
  id: z.string(),
  content: z.string(),
  embedding: z.instanceof(Buffer),
  file_path: z.string(),
  file_type: z.string().nullable(),
  language: z.string().nullable(),
  start_line: z.number().int().nullable(),
  end_line: z.number().int().nullable(),
  metadata: z.string().nullable(),
});

/** Type inferred from ChunkLoadRowSchema */
export type ChunkLoadRow = z.infer<typeof ChunkLoadRowSchema>;

/**
 * Partial schema for chunk rows loaded in BM25StoreManager.
 *
 * BM25 only needs text content for term matching, no embeddings.
 * - Excludes embedding (not needed for BM25)
 * - Excludes project_id, created_at (not needed at load time)
 */
export const ChunkLoadNoEmbeddingSchema = z.object({
  id: z.string(),
  content: z.string(),
  file_path: z.string(),
  file_type: z.string().nullable(),
  language: z.string().nullable(),
  start_line: z.number().int().nullable(),
  end_line: z.number().int().nullable(),
  metadata: z.string().nullable(),
});

/** Type inferred from ChunkLoadNoEmbeddingSchema */
export type ChunkLoadNoEmbeddingRow = z.infer<typeof ChunkLoadNoEmbeddingSchema>;

// ============================================================================
// FileHash Schema
// ============================================================================

/**
 * Zod schema for validating FileHash rows from the database.
 *
 * FileHash tracks which files have been indexed and their content hashes
 * for incremental indexing.
 */
export const FileHashRowSchema = z.object({
  project_id: z.string(),
  file_path: z.string(),
  hash: z.string(),
  chunk_ids: z.string(), // JSON array stored as string
  indexed_at: z.string(),
});

/** Type inferred from FileHashRowSchema (should match FileHash interface) */
export type FileHashRow = z.infer<typeof FileHashRowSchema>;

// ============================================================================
// Eval Input Validation Schemas (Defense-in-depth)
// ============================================================================

/**
 * Zod schema for validating TraceInput before database insertion.
 *
 * Catches malformed input with clear Zod error messages instead of
 * cryptic SQLite constraint violations.
 */
export const TraceInputSchema = z.object({
  project_id: z.string().min(1),
  query: z.string().min(1),
  retrieved_files: z.array(z.string()),
  top_k: z.number().int().min(1),
  latency_ms: z.number().int().min(0),
  answer: z.string().optional(),
  retrieval_method: z.enum(['dense', 'bm25', 'fusion']),
  feedback: z.enum(['positive', 'negative']).optional(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * Zod schema for validating TraceFilter before query construction.
 *
 * Ensures filter values are well-formed before building dynamic SQL.
 */
export const TraceFilterSchema = z.object({
  project_id: z.string().optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  feedback: z.enum(['positive', 'negative']).optional(),
  limit: z.number().int().min(1).optional(),
});

/**
 * Zod schema for validating EvalRunInput before database insertion.
 *
 * Catches malformed eval run input with clear Zod error messages.
 * Metrics fields are constrained to [0, 1] range.
 */
export const EvalRunInputSchema = z.object({
  project_id: z.string().min(1),
  dataset_version: z.string().min(1),
  query_count: z.number().int().min(1),
  metrics: z.object({
    mrr: z.number().min(0).max(1),
    precision_at_k: z.number().min(0).max(1),
    recall_at_k: z.number().min(0).max(1),
    hit_rate: z.number().min(0).max(1),
    ndcg: z.number().min(0).max(1),
    map: z.number().min(0).max(1),
  }),
  config: z.record(z.unknown()),
  notes: z.string().optional(),
});

/**
 * Zod schema for validating EvalResultInput before database insertion.
 *
 * Catches malformed eval result input with clear Zod error messages.
 * Per-query metrics fields are constrained to [0, 1] range.
 */
export const EvalResultInputSchema = z.object({
  eval_run_id: z.string().min(1),
  query: z.string().min(1),
  expected_files: z.array(z.string()),
  retrieved_files: z.array(z.string()),
  latency_ms: z.number().int().min(0),
  metrics: z.object({
    reciprocal_rank: z.number().min(0).max(1),
    precision_at_k: z.number().min(0).max(1),
    recall_at_k: z.number().min(0).max(1),
    hit_rate: z.number().min(0).max(1),
  }),
  passed: z.boolean(),
});

// ============================================================================
// Eval Trace Schema
// ============================================================================

/**
 * Zod schema for validating EvalTrace rows from the eval_traces table.
 *
 * All JSON fields (retrieved_files, metadata) are stored as TEXT in SQLite.
 * Validation ensures they exist as strings — parsing happens in application code.
 */
export const EvalTraceRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  query: z.string(),
  timestamp: z.string(),
  retrieved_files: z.string(), // JSON array stored as TEXT
  top_k: z.number().int(),
  latency_ms: z.number().int(),
  answer: z.string().nullable(),
  retrieval_method: z.string(),
  feedback: z.string().nullable(),
  metadata: z.string().nullable(),
});

/** Type inferred from EvalTraceRowSchema */
export type EvalTraceRow = z.infer<typeof EvalTraceRowSchema>;

// ============================================================================
// Eval Run Schema
// ============================================================================

/**
 * Zod schema for validating EvalRun rows from the eval_runs table.
 *
 * metrics and config are JSON-serialized TEXT fields.
 */
export const EvalRunRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  timestamp: z.string(),
  dataset_version: z.string(),
  query_count: z.number().int(),
  metrics: z.string(), // JSON RetrievalMetrics
  config: z.string(), // JSON config snapshot
  notes: z.string().nullable(),
});

/** Type inferred from EvalRunRowSchema */
export type EvalRunRow = z.infer<typeof EvalRunRowSchema>;

// ============================================================================
// Eval Result Schema
// ============================================================================

/**
 * Zod schema for validating EvalResult rows from the eval_results table.
 *
 * The `passed` field is stored as INTEGER (0/1) in SQLite but typed as
 * boolean in the EvalResult interface. We use .transform() to coerce.
 */
export const EvalResultRowSchema = z.object({
  id: z.string(),
  eval_run_id: z.string(),
  query: z.string(),
  expected_files: z.string(), // JSON array
  retrieved_files: z.string(), // JSON array
  latency_ms: z.number().int(),
  metrics: z.string(), // JSON per-query metrics
  passed: z
    .union([z.number(), z.boolean(), z.string()])
    .transform((val) => {
      if (typeof val === 'boolean') return val;
      if (typeof val === 'string') return val !== '0' && val !== '';
      return val !== 0;
    }),
});

/** Type inferred from EvalResultRowSchema */
export type EvalResultRow = z.infer<typeof EvalResultRowSchema>;

// ============================================================================
// Schema Validation Error
// ============================================================================

/**
 * Thrown when a database row fails Zod schema validation.
 *
 * This indicates schema drift - the database has data that doesn't match
 * what the code expects. Common causes:
 * - Failed migration
 * - Manual database modification
 * - Code/database version mismatch
 *
 * Exit code 5: Database error (same as DatabaseError for consistency)
 */
export class SchemaValidationError extends CLIError {
  /** Individual validation issues from Zod */
  public readonly issues: Array<{ path: string; message: string }>;

  constructor(message: string, zodIssues: ZodIssue[]) {
    // Format issues for the hint
    const formattedIssues = zodIssues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));

    const issuesSummary = formattedIssues
      .slice(0, 3) // Show first 3 issues
      .map((i) => `  - ${i.path}: ${i.message}`)
      .join('\n');

    const hint =
      `Schema validation failed:\n${issuesSummary}` +
      (formattedIssues.length > 3
        ? `\n  ... and ${formattedIssues.length - 3} more`
        : '') +
      `\n\nThis may indicate a database/code version mismatch.\n` +
      `Try: ctx status --verbose  to check database health`;

    super(message, hint, 5);
    this.name = 'SchemaValidationError';
    this.issues = formattedIssues;
  }
}

// ============================================================================
// Validation Utilities
// ============================================================================

/**
 * Validate a single database row against a Zod schema.
 *
 * @param schema - Zod schema to validate against
 * @param row - Database row (unknown type from SQLite)
 * @param context - Context string for error messages (e.g., "projects.name=foo")
 * @returns Validated and typed data
 * @throws SchemaValidationError if validation fails
 *
 * @example
 * ```ts
 * const row = db.prepare('SELECT * FROM projects WHERE name = ?').get(name);
 * if (!row) return undefined;
 * return validateRow(ProjectRowSchema, row, `projects.name=${name}`);
 * ```
 */
export function validateRow<T extends z.ZodSchema>(
  schema: T,
  row: unknown,
  context: string
): z.output<T> {
  const result = schema.safeParse(row);

  if (result.success) {
    return result.data;
  }

  throw new SchemaValidationError(
    `Database schema mismatch in ${context}`,
    result.error.issues
  );
}

/**
 * Validate an array of database rows against a Zod schema.
 *
 * By default, throws on first invalid row. Use `options.continueOnError`
 * to collect all errors and return only valid rows.
 *
 * @param schema - Zod schema to validate against
 * @param rows - Array of database rows
 * @param context - Context string for error messages
 * @param options - Validation options
 * @returns Array of validated and typed data
 * @throws SchemaValidationError if validation fails (unless continueOnError)
 *
 * @example
 * ```ts
 * // Strict mode (default) - throws on first error
 * const projects = validateRows(ProjectRowSchema, rows, 'projects');
 *
 * // Lenient mode - returns only valid rows, logs errors
 * const projects = validateRows(ProjectRowSchema, rows, 'projects', {
 *   continueOnError: true,
 *   onError: (row, error) => console.warn('Invalid row:', error.message),
 * });
 * ```
 */
export function validateRows<T extends z.ZodSchema>(
  schema: T,
  rows: unknown[],
  context: string,
  options?: {
    /** If true, continue validation on errors (returns only valid rows) */
    continueOnError?: boolean;
    /** Callback for each invalid row (only called if continueOnError) */
    onError?: (row: unknown, error: z.ZodError) => void;
  }
): z.output<T>[] {
  const valid: z.output<T>[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const result = schema.safeParse(row);

    if (result.success) {
      valid.push(result.data);
    } else if (options?.continueOnError) {
      options.onError?.(row, result.error);
    } else {
      throw new SchemaValidationError(
        `Database schema mismatch in ${context}[${i}]`,
        result.error.issues
      );
    }
  }

  return valid;
}

/**
 * Safely validate a row without throwing.
 *
 * Returns a discriminated union for explicit error handling.
 *
 * @example
 * ```ts
 * const result = safeValidateRow(ProjectRowSchema, row, 'projects');
 * if (result.success) {
 *   console.log('Valid project:', result.data.name);
 * } else {
 *   console.error('Invalid row:', result.error.message);
 * }
 * ```
 */
export function safeValidateRow<T extends z.ZodSchema>(
  schema: T,
  row: unknown,
  context: string
):
  | { success: true; data: z.output<T> }
  | { success: false; error: SchemaValidationError } {
  const result = schema.safeParse(row);

  if (result.success) {
    return { success: true, data: result.data };
  }

  return {
    success: false,
    error: new SchemaValidationError(
      `Database schema mismatch in ${context}`,
      result.error.issues
    ),
  };
}
