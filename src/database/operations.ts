/**
 * Database Operations
 *
 * High-level database operations for the indexing pipeline.
 * Wraps low-level SQL queries with type-safe TypeScript interfaces.
 *
 * Design: These functions work with the raw better-sqlite3 Database instance
 * returned by getDb(). They handle:
 * - Type conversion (Float32Array ↔ Buffer)
 * - JSON serialization/deserialization
 * - Transaction management for batch operations
 */

import { statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { getDb, getDbPath } from './connection.js';
import { embeddingToBlob, generateId } from './schema.js';
import type { Project } from './schema.js';
import {
  ProjectRowSchema,
  EvalTraceRowSchema,
  EvalRunRowSchema,
  EvalResultRowSchema,
  TraceInputSchema,
  TraceFilterSchema,
  EvalRunInputSchema,
  EvalResultInputSchema,
  validateRow,
  validateRows,
} from './validation.js';
import type { FileType, Language } from '../indexer/types.js';
import type { ContentType } from '../indexer/chunker/types.js';
import { getVectorStoreManager, getBM25StoreManager } from '../search/index.js';
import type {
  EvalTrace,
  TraceInput,
  TraceFilter,
  EvalRun,
  EvalRunInput,
  EvalResult,
  EvalResultInput,
} from '../eval/types.js';

/**
 * Input for creating/updating a project.
 */
export interface ProjectUpsertInput {
  id?: string;
  name: string;
  path: string;
  tags?: string[];
  ignorePatterns?: string[];
  /** Embedding model name (e.g., "BAAI/bge-large-en-v1.5") */
  embeddingModel?: string;
  /** Embedding dimensions (default: 1024) */
  embeddingDimensions?: number;
  /** Optional description for smart query routing */
  description?: string;
}

/**
 * Input for inserting a chunk.
 */
export interface ChunkInsertInput {
  id: string;
  content: string;
  embedding: Float32Array;
  filePath: string;
  fileType: FileType;
  contentType: ContentType;
  language: Language;
  startLine: number;
  endLine: number;
  metadata: Record<string, unknown>;
}

/**
 * Statistics update for a project.
 */
export interface ProjectStatsUpdate {
  fileCount: number;
  chunkCount: number;
}

/**
 * High-level database operations wrapper.
 *
 * Provides type-safe methods for common indexing operations.
 * All methods use the shared database connection from getDb().
 */
export class DatabaseOperations {
  private db: Database.Database;

  constructor(db?: Database.Database) {
    this.db = db ?? getDb();
  }

  /**
   * Get the current database file size in bytes.
   * Returns 0 if the database file doesn't exist yet.
   * Throws for other errors (permissions, disk issues, etc.)
   */
  getDatabaseSize(): number {
    try {
      const dbPath = getDbPath();
      const stat = statSync(dbPath);
      return stat.size;
    } catch (error) {
      // File doesn't exist yet - that's OK for fresh installs
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return 0;
      }
      // Permission errors, disk issues, etc. should propagate
      throw error;
    }
  }

  /**
   * Create or update a project.
   *
   * Uses INSERT OR REPLACE to handle both new and existing projects.
   */
  upsertProject(input: ProjectUpsertInput): string {
    const id = input.id ?? generateId();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO projects (id, name, path, tags, ignore_patterns, indexed_at, updated_at, file_count, chunk_count, config, embedding_model, embedding_dimensions, description)
      VALUES (@id, @name, @path, @tags, @ignorePatterns, @now, @now, 0, 0, NULL, @embeddingModel, @embeddingDimensions, @description)
      ON CONFLICT(id) DO UPDATE SET
        name = @name,
        path = @path,
        tags = @tags,
        ignore_patterns = @ignorePatterns,
        indexed_at = @now,
        updated_at = @now,
        embedding_model = COALESCE(@embeddingModel, embedding_model),
        embedding_dimensions = COALESCE(@embeddingDimensions, embedding_dimensions),
        description = COALESCE(@description, description)
    `);

    stmt.run({
      id,
      name: input.name,
      path: input.path,
      tags: input.tags ? JSON.stringify(input.tags) : null,
      ignorePatterns: input.ignorePatterns ? JSON.stringify(input.ignorePatterns) : null,
      embeddingModel: input.embeddingModel ?? null,
      embeddingDimensions: input.embeddingDimensions ?? 1024,
      description: input.description ?? null,
      now,
    });

    return id;
  }

  /**
   * Insert multiple chunks in a single transaction.
   *
   * Uses a transaction for better performance when inserting many rows.
   * Each chunk's embedding is converted from Float32Array to Buffer.
   */
  insertChunks(projectId: string, chunks: ChunkInsertInput[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO chunks (id, project_id, content, embedding, file_path, file_type, language, start_line, end_line, metadata, created_at)
      VALUES (@id, @projectId, @content, @embedding, @filePath, @fileType, @language, @startLine, @endLine, @metadata, @createdAt)
    `);

    const now = new Date().toISOString();

    // Use a transaction for batch insert performance
    const insertMany = this.db.transaction((chunksToInsert: ChunkInsertInput[]) => {
      for (const chunk of chunksToInsert) {
        stmt.run({
          id: chunk.id,
          projectId,
          content: chunk.content,
          embedding: embeddingToBlob(chunk.embedding),
          filePath: chunk.filePath,
          fileType: chunk.fileType,
          language: chunk.language,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          metadata: JSON.stringify(chunk.metadata),
          createdAt: now,
        });
      }
    });

    insertMany(chunks);
  }

  /**
   * Update project statistics after indexing.
   */
  updateProjectStats(projectId: string, stats: ProjectStatsUpdate): void {
    const stmt = this.db.prepare(`
      UPDATE projects
      SET file_count = @fileCount,
          chunk_count = @chunkCount,
          updated_at = @now
      WHERE id = @id
    `);

    stmt.run({
      id: projectId,
      fileCount: stats.fileCount,
      chunkCount: stats.chunkCount,
      now: new Date().toISOString(),
    });
  }

  /**
   * Delete all chunks for a project (for re-indexing).
   */
  deleteProjectChunks(projectId: string): number {
    const result = this.db.prepare('DELETE FROM chunks WHERE project_id = ?').run(projectId);
    return result.changes;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Atomic Re-indexing: Staging Table Pattern
  //
  // These methods enable zero-downtime re-indexing by:
  // 1. Writing new chunks to a staging table while queries use the main table
  // 2. Atomically swapping data in a single transaction
  // 3. Cleaning up the staging table after swap
  //
  // This eliminates the "query gap" where searches would return 0 results
  // during the traditional delete-then-insert approach.
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create staging table for atomic re-indexing.
   *
   * The staging table mirrors the chunks table schema but without foreign keys
   * or indexes - we only need it for temporary storage before the atomic swap.
   *
   * Called at the start of a re-indexing operation.
   */
  createChunksStagingTable(): void {
    // Drop any orphaned staging table from a previous crashed session
    this.db.exec('DROP TABLE IF EXISTS chunks_staging');

    // Create fresh staging table with same column structure as chunks
    // No foreign key constraints - we'll copy to the real table atomically
    this.db.exec(`
      CREATE TABLE chunks_staging (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB NOT NULL,
        file_path TEXT NOT NULL,
        file_type TEXT NOT NULL,
        language TEXT,
        start_line INTEGER,
        end_line INTEGER,
        metadata TEXT,
        created_at TEXT NOT NULL
      )
    `);
  }

  /**
   * Insert chunks to the staging table (for atomic re-indexing).
   *
   * This is identical to insertChunks() but targets chunks_staging instead.
   * Chunks are written here during re-indexing while the main table continues
   * serving queries with the old data.
   */
  insertChunksToStaging(projectId: string, chunks: ChunkInsertInput[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO chunks_staging (id, project_id, content, embedding, file_path, file_type, language, start_line, end_line, metadata, created_at)
      VALUES (@id, @projectId, @content, @embedding, @filePath, @fileType, @language, @startLine, @endLine, @metadata, @createdAt)
    `);

    const now = new Date().toISOString();

    // Use a transaction for batch insert performance
    const insertMany = this.db.transaction((chunksToInsert: ChunkInsertInput[]) => {
      for (const chunk of chunksToInsert) {
        stmt.run({
          id: chunk.id,
          projectId,
          content: chunk.content,
          embedding: embeddingToBlob(chunk.embedding),
          filePath: chunk.filePath,
          fileType: chunk.fileType,
          language: chunk.language,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          metadata: JSON.stringify(chunk.metadata),
          createdAt: now,
        });
      }
    });

    insertMany(chunks);
  }

  /**
   * Atomically swap old chunks with staged chunks.
   *
   * This is the critical operation that makes re-indexing "atomic":
   * - DELETE old chunks and INSERT new chunks in a single transaction
   * - From the perspective of concurrent queries, data changes instantly
   * - No window where queries return 0 results
   *
   * @throws Error if staging table doesn't exist or is empty for this project
   * @returns Counts of deleted and inserted chunks for logging
   */
  atomicSwapChunks(projectId: string): { deleted: number; inserted: number } {
    // Validate staging table exists and has data before attempting swap
    const stagingExists = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_staging'`)
      .get();

    if (!stagingExists) {
      throw new Error('Atomic swap failed: staging table does not exist');
    }

    const stagingCount = (
      this.db
        .prepare('SELECT COUNT(*) as count FROM chunks_staging WHERE project_id = ?')
        .get(projectId) as { count: number }
    ).count;

    if (stagingCount === 0) {
      throw new Error(`Atomic swap failed: no staged chunks found for project '${projectId}'`);
    }

    return this.db.transaction(() => {
      // Delete old chunks for this project
      const deleteResult = this.db
        .prepare('DELETE FROM chunks WHERE project_id = ?')
        .run(projectId);

      // Insert all staged chunks into the main table
      const insertResult = this.db
        .prepare('INSERT INTO chunks SELECT * FROM chunks_staging WHERE project_id = ?')
        .run(projectId);

      return {
        deleted: deleteResult.changes,
        inserted: insertResult.changes,
      };
    })();
  }

  /**
   * Drop the staging table after a successful swap.
   *
   * Also called at the start of createChunksStagingTable() to clean up
   * any orphaned staging table from a crashed session.
   */
  dropChunksStagingTable(): void {
    this.db.exec('DROP TABLE IF EXISTS chunks_staging');
  }

  /**
   * Get a project by name.
   *
   * Uses Zod validation to ensure the database row matches the expected schema.
   * Throws SchemaValidationError if the row has unexpected shape.
   */
  getProjectByName(name: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE name = ?').get(name);
    if (!row) return undefined;
    return validateRow(ProjectRowSchema, row, `projects.name=${name}`);
  }

  /**
   * Delete a project and all associated data.
   *
   * CASCADE DELETE automatically removes:
   * - All chunks (via FOREIGN KEY ... ON DELETE CASCADE)
   * - All file_hashes (via FOREIGN KEY ... ON DELETE CASCADE)
   *
   * Uses a transaction to ensure atomicity and verify deletion.
   *
   * @returns Object with counts of deleted items
   * @throws Error if project doesn't exist or deletion fails
   */
  deleteProject(projectId: string): { chunksDeleted: number; fileHashesDeleted: number } {
    // Wrap in transaction for atomicity
    const result = this.db.transaction(() => {
      // Get counts BEFORE deletion for reporting (CASCADE will delete them)
      const chunkCount = (
        this.db.prepare('SELECT COUNT(*) as count FROM chunks WHERE project_id = ?').get(projectId) as { count: number }
      ).count;

      const fileHashCount = (
        this.db.prepare('SELECT COUNT(*) as count FROM file_hashes WHERE project_id = ?').get(projectId) as { count: number }
      ).count;

      // Delete the project - CASCADE handles chunks and file_hashes
      const deleteResult = this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

      // Verify the deletion actually happened
      if (deleteResult.changes === 0) {
        throw new Error(`Project '${projectId}' not found or already deleted`);
      }

      return { chunksDeleted: chunkCount, fileHashesDeleted: fileHashCount };
    })();

    // Invalidate search caches AFTER successful deletion
    // (outside transaction since these are in-memory operations)
    getVectorStoreManager().invalidate(projectId);
    getBM25StoreManager().invalidate(projectId);

    return result;
  }

  /**
   * Get a project by ID.
   *
   * Uses Zod validation to ensure the database row matches the expected schema.
   */
  getProjectById(id: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!row) return undefined;
    return validateRow(ProjectRowSchema, row, `projects.id=${id}`);
  }

  /**
   * Get a project by path.
   *
   * Uses Zod validation to ensure the database row matches the expected schema.
   */
  getProjectByPath(path: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE path = ?').get(path);
    if (!row) return undefined;
    return validateRow(ProjectRowSchema, row, `projects.path=${path}`);
  }

  /**
   * Get all projects.
   *
   * Uses Zod validation to ensure all database rows match the expected schema.
   */
  getAllProjects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
    return validateRows(ProjectRowSchema, rows, 'projects');
  }

  /**
   * Get storage statistics for all projects.
   */
  getStorageStats(): {
    projectCount: number;
    totalChunks: number;
    totalFiles: number;
    databaseSize: number;
  } {
    const projectCount = (this.db.prepare('SELECT COUNT(*) as count FROM projects').get() as { count: number }).count;
    const totalChunks = (this.db.prepare('SELECT COUNT(*) as count FROM chunks').get() as { count: number }).count;
    const totalFiles = (this.db.prepare('SELECT SUM(file_count) as total FROM projects').get() as { total: number | null }).total ?? 0;

    return {
      projectCount,
      totalChunks,
      totalFiles,
      databaseSize: this.getDatabaseSize(),
    };
  }

  /**
   * Update project metadata (description and tags).
   *
   * Only updates fields that are provided - doesn't overwrite others.
   * Used by /describe command to enable smart query routing.
   *
   * @example
   * ```typescript
   * db.updateProjectMetadata(projectId, {
   *   description: 'Main REST API with auth',
   *   tags: ['backend', 'api', 'auth']
   * });
   * ```
   */
  // ─────────────────────────────────────────────────────────────────────────────
  // Eval Trace Operations (Ticket #113)
  //
  // Always-on local trace recording for every ask/search/chat interaction.
  // Traces enable retrospective analysis, trend tracking, and golden dataset
  // generation via `ctx eval golden capture`.
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Insert a single trace record.
   *
   * Called automatically on every ask/search/chat command.
   * Serializes native arrays/objects to JSON for SQLite storage.
   *
   * @returns The generated trace ID (UUID)
   */
  insertTrace(trace: TraceInput): string {
    TraceInputSchema.parse(trace);
    const id = generateId();

    const stmt = this.db.prepare(`
      INSERT INTO eval_traces (id, project_id, query, timestamp, retrieved_files, top_k, latency_ms, answer, retrieval_method, feedback, metadata, langfuse_trace_id)
      VALUES (@id, @projectId, @query, @timestamp, @retrievedFiles, @topK, @latencyMs, @answer, @retrievalMethod, @feedback, @metadata, @langfuseTraceId)
    `);

    stmt.run({
      id,
      projectId: trace.project_id,
      query: trace.query,
      timestamp: new Date().toISOString(),
      retrievedFiles: JSON.stringify(trace.retrieved_files),
      topK: trace.top_k,
      latencyMs: trace.latency_ms,
      answer: trace.answer ?? null,
      retrievalMethod: trace.retrieval_method,
      feedback: trace.feedback ?? null,
      metadata: trace.metadata ? JSON.stringify(trace.metadata) : null,
      langfuseTraceId: trace.langfuse_trace_id ?? null,
    });

    return id;
  }

  /**
   * Query traces with optional filters.
   *
   * Builds a dynamic WHERE clause from the provided filter.
   * All fields are optional — omitted fields don't filter.
   *
   * @example
   * ```ts
   * // Get last 20 traces for a project
   * db.getTraces({ project_id: 'abc', limit: 20 });
   *
   * // Get negative-feedback traces from this week
   * db.getTraces({ feedback: 'negative', start_date: '2026-02-05' });
   * ```
   */
  getTraces(filter: TraceFilter): EvalTrace[] {
    TraceFilterSchema.parse(filter);
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter.project_id) {
      conditions.push('project_id = @projectId');
      params.projectId = filter.project_id;
    }

    if (filter.start_date) {
      conditions.push('timestamp >= @startDate');
      params.startDate = filter.start_date;
    }

    if (filter.end_date) {
      conditions.push('timestamp <= @endDate');
      params.endDate = filter.end_date;
    }

    if (filter.feedback) {
      conditions.push('feedback = @feedback');
      params.feedback = filter.feedback;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = filter.limit ? 'LIMIT @limit' : '';
    if (filter.limit) {
      params.limit = Math.max(1, Math.floor(filter.limit));
    }

    const rows = this.db
      .prepare(`SELECT * FROM eval_traces ${where} ORDER BY timestamp DESC ${limitClause}`)
      .all(params);

    return validateRows(EvalTraceRowSchema, rows, 'eval_traces');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Eval Run Operations (Ticket #113)
  //
  // Batch evaluation run history. Each run evaluates all golden dataset entries
  // and stores aggregate metrics for trend tracking.
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Insert a new eval run record.
   *
   * Called when `ctx eval run` starts an evaluation.
   * Serializes metrics and config objects to JSON.
   *
   * @returns The generated run ID (UUID)
   */
  insertEvalRun(run: EvalRunInput): string {
    EvalRunInputSchema.parse(run);
    const id = generateId();

    const stmt = this.db.prepare(`
      INSERT INTO eval_runs (id, project_id, timestamp, dataset_version, query_count, metrics, config, notes)
      VALUES (@id, @projectId, @timestamp, @datasetVersion, @queryCount, @metrics, @config, @notes)
    `);

    stmt.run({
      id,
      projectId: run.project_id,
      timestamp: new Date().toISOString(),
      datasetVersion: run.dataset_version,
      queryCount: run.query_count,
      metrics: JSON.stringify(run.metrics),
      config: JSON.stringify(run.config),
      notes: run.notes ?? null,
    });

    return id;
  }

  /**
   * Update an existing eval run.
   *
   * Used to update metrics/notes after the run completes.
   * Only updates provided fields (like `updateProjectMetadata`).
   */
  updateEvalRun(
    id: string,
    update: Partial<Pick<EvalRunInput, 'metrics' | 'query_count' | 'notes'>>
  ): void {
    const updates: string[] = [];
    const params: Record<string, unknown> = { id };

    if (update.metrics !== undefined) {
      updates.push('metrics = @metrics');
      params.metrics = JSON.stringify(update.metrics);
    }

    if (update.query_count !== undefined) {
      updates.push('query_count = @queryCount');
      params.queryCount = update.query_count;
    }

    if (update.notes !== undefined) {
      updates.push('notes = @notes');
      params.notes = update.notes;
    }

    if (updates.length === 0) return;

    this.db.prepare(`UPDATE eval_runs SET ${updates.join(', ')} WHERE id = @id`).run(params);
  }

  /**
   * Get eval run history for a project.
   *
   * Returns runs ordered by most recent first.
   * Used by `ctx eval report` to show trends.
   */
  getEvalRuns(projectId: string, limit?: number): EvalRun[] {
    const limitClause = limit ? 'LIMIT @limit' : '';
    const params: Record<string, unknown> = { projectId };
    if (limit) {
      params.limit = Math.max(1, Math.floor(limit));
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM eval_runs WHERE project_id = @projectId ORDER BY timestamp DESC ${limitClause}`
      )
      .all(params);

    return validateRows(EvalRunRowSchema, rows, 'eval_runs');
  }

  /**
   * Get a single eval run by ID.
   *
   * Used when loading a specific run for detailed analysis.
   */
  getEvalRun(id: string): EvalRun | undefined {
    const row = this.db
      .prepare('SELECT * FROM eval_runs WHERE id = @id')
      .get({ id });
    if (!row) return undefined;
    return validateRow(EvalRunRowSchema, row, `eval_runs.id=${id}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Eval Result Operations (Ticket #113)
  //
  // Per-query results within an eval run. One record per golden dataset entry,
  // enabling per-query analysis of failures.
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Insert a single eval result.
   *
   * Called once per golden dataset entry during an eval run.
   * Converts boolean `passed` to integer for SQLite storage.
   *
   * @returns The generated result ID (UUID)
   */
  insertEvalResult(result: EvalResultInput): string {
    EvalResultInputSchema.parse(result);
    const id = generateId();

    const stmt = this.db.prepare(`
      INSERT INTO eval_results (id, eval_run_id, query, expected_files, retrieved_files, latency_ms, metrics, passed)
      VALUES (@id, @evalRunId, @query, @expectedFiles, @retrievedFiles, @latencyMs, @metrics, @passed)
    `);

    stmt.run({
      id,
      evalRunId: result.eval_run_id,
      query: result.query,
      expectedFiles: JSON.stringify(result.expected_files),
      retrievedFiles: JSON.stringify(result.retrieved_files),
      latencyMs: result.latency_ms,
      metrics: JSON.stringify(result.metrics),
      passed: result.passed ? 1 : 0,
    });

    return id;
  }

  /**
   * Insert multiple eval results in a single transaction.
   *
   * Used by the eval runner to store all per-query results atomically.
   * Wrapping in a transaction improves performance (one commit vs N commits)
   * and ensures atomicity (all results stored or none).
   *
   * @returns Array of generated result IDs (UUIDs)
   */
  insertEvalResults(results: EvalResultInput[]): string[] {
    const ids: string[] = [];

    const stmt = this.db.prepare(`
      INSERT INTO eval_results (id, eval_run_id, query, expected_files, retrieved_files, latency_ms, metrics, passed)
      VALUES (@id, @evalRunId, @query, @expectedFiles, @retrievedFiles, @latencyMs, @metrics, @passed)
    `);

    const insertMany = this.db.transaction((resultsToInsert: EvalResultInput[]) => {
      for (const result of resultsToInsert) {
        EvalResultInputSchema.parse(result);
        const id = generateId();
        ids.push(id);
        stmt.run({
          id,
          evalRunId: result.eval_run_id,
          query: result.query,
          expectedFiles: JSON.stringify(result.expected_files),
          retrievedFiles: JSON.stringify(result.retrieved_files),
          latencyMs: result.latency_ms,
          metrics: JSON.stringify(result.metrics),
          passed: result.passed ? 1 : 0,
        });
      }
    });

    insertMany(results);
    return ids;
  }

  /**
   * Get all results for an eval run.
   *
   * Returns results for per-query analysis (which queries passed/failed).
   * Zod validation coerces `passed` from integer back to boolean.
   */
  getEvalResults(runId: string): EvalResult[] {
    const rows = this.db
      .prepare('SELECT * FROM eval_results WHERE eval_run_id = @runId')
      .all({ runId });

    return validateRows(EvalResultRowSchema, rows, 'eval_results');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Project Metadata
  // ─────────────────────────────────────────────────────────────────────────────

  updateProjectMetadata(
    projectId: string,
    metadata: { description?: string; tags?: string[] }
  ): void {
    // Build dynamic SET clause - only update provided fields
    const updates: string[] = [];
    const params: Record<string, unknown> = { id: projectId };

    if (metadata.description !== undefined) {
      updates.push('description = @description');
      params.description = metadata.description;
    }

    if (metadata.tags !== undefined) {
      updates.push('tags = @tags');
      params.tags = JSON.stringify(metadata.tags);
    }

    // Nothing to update
    if (updates.length === 0) return;

    // Always update timestamp when metadata changes
    updates.push('updated_at = @now');
    params.now = new Date().toISOString();

    const stmt = this.db.prepare(`
      UPDATE projects
      SET ${updates.join(', ')}
      WHERE id = @id
    `);

    stmt.run(params);
  }
}

// Singleton instance
let dbOpsInstance: DatabaseOperations | null = null;

/**
 * Get the DatabaseOperations singleton.
 *
 * The singleton pattern ensures we reuse the same database connection
 * throughout the application lifecycle.
 */
export function getDatabase(): DatabaseOperations {
  if (!dbOpsInstance) {
    dbOpsInstance = new DatabaseOperations();
  }
  return dbOpsInstance;
}

/**
 * Reset the database operations instance.
 * Primarily for testing.
 */
export function resetDatabase(): void {
  dbOpsInstance = null;
}
