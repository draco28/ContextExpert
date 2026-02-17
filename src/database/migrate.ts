/**
 * Database Migration Runner
 *
 * Applies SQL migrations in order, tracking which have been applied.
 * Migrations are idempotent - safe to run multiple times.
 */

import { getDb } from './connection.js';

// ============================================================================
// Migration State Tracking (Ticket #52)
// ============================================================================

/**
 * Process-level migration state.
 *
 * Why module-level state?
 * - Node.js caches modules, so this persists across all imports
 * - Prevents redundant database calls when multiple commands call runMigrations()
 * - Can be reset for testing via resetMigrationState()
 */
interface MigrationState {
  /** Whether migrations have been checked/applied this process */
  initialized: boolean;
  /** Names of applied migrations (from _migrations table) */
  applied: Set<string>;
  /** Timestamp when state was initialized */
  lastCheck: number;
}

/** Module-level state - null until first runMigrations() call */
let migrationState: MigrationState | null = null;

// ============================================================================
// Migration Result Type (Ticket #52)
// ============================================================================

/**
 * Result of running migrations.
 *
 * Provides explicit success/failure information instead of throwing.
 * This allows callers to handle failures gracefully.
 */
export interface MigrationResult {
  /** Names of migrations that were successfully applied */
  applied: string[];
  /** Migrations that failed with their error messages */
  failed: Array<{ name: string; error: string }>;
}

// ============================================================================
// Embedded Migrations
// ============================================================================

// Embedded migrations (bundler-friendly approach)
// SQL files are embedded as strings to avoid file system dependencies in bundled output
const MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: '001-initial.sql',
    sql: `
-- Migration 001: Initial Schema
-- Creates core tables for the context system

-- Projects Table
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  path TEXT NOT NULL,
  tags TEXT,
  ignore_patterns TEXT,
  indexed_at TEXT,
  updated_at TEXT,
  file_count INTEGER DEFAULT 0,
  chunk_count INTEGER DEFAULT 0,
  config TEXT
);

CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);

-- Chunks Table
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB NOT NULL,
  file_path TEXT NOT NULL,
  file_type TEXT,
  language TEXT,
  start_line INTEGER,
  end_line INTEGER,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunks_project_id ON chunks(project_id);
CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(project_id, file_path);
CREATE INDEX IF NOT EXISTS idx_chunks_file_type ON chunks(project_id, file_type);

-- File Hashes Table
CREATE TABLE IF NOT EXISTS file_hashes (
  project_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  hash TEXT NOT NULL,
  chunk_ids TEXT NOT NULL,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, file_path),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Migrations Tracking Table
CREATE TABLE IF NOT EXISTS _migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
    `.trim(),
  },
  {
    name: '002-add-embedding-tracking.sql',
    sql: `
-- Migration 002: Add Embedding Tracking
-- Tracks embedding model and dimensions per project to prevent dimension mismatch issues

-- Add embedding model name (e.g., "BAAI/bge-large-en-v1.5")
ALTER TABLE projects ADD COLUMN embedding_model TEXT;

-- Add embedding dimensions with default of 1024 (BGE-large standard)
ALTER TABLE projects ADD COLUMN embedding_dimensions INTEGER DEFAULT 1024;

-- Index for quick lookups by embedding model (useful for future model-based queries)
CREATE INDEX IF NOT EXISTS idx_projects_embedding_model ON projects(embedding_model);
    `.trim(),
  },
  {
    name: '003-add-project-description.sql',
    sql: `
-- Migration 003: Add Project Description
-- Adds a description field for smart query routing in Phase 3 of chat-first experience
-- The LLM project router will use this to make better routing decisions
ALTER TABLE projects ADD COLUMN description TEXT;
    `.trim(),
  },
  {
    name: '004-add-eval-tables.sql',
    sql: `
-- Migration 004: Add Evaluation & Observability Tables
-- Enables always-on local trace recording and batch evaluation against golden datasets
-- Part of Phase 1: Storage and Schema Foundation (tickets #112, #113)

-- eval_traces: Always-on local trace storage for every ask/search/chat interaction
-- One row per RAG query, used for trend analysis and golden dataset capture
CREATE TABLE IF NOT EXISTS eval_traces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  query TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  retrieved_files TEXT NOT NULL,    -- JSON array of file paths
  top_k INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  answer TEXT,                     -- NULL for search-only queries
  retrieval_method TEXT NOT NULL,  -- 'dense', 'bm25', or 'fusion'
  feedback TEXT,                   -- 'positive' or 'negative'
  metadata TEXT,                   -- JSON object
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_eval_traces_project ON eval_traces(project_id);
CREATE INDEX IF NOT EXISTS idx_eval_traces_timestamp ON eval_traces(timestamp);

-- eval_runs: Batch evaluation run history
-- One row per evaluation execution against a golden dataset
CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  dataset_version TEXT NOT NULL,
  query_count INTEGER NOT NULL,
  metrics TEXT NOT NULL,           -- JSON aggregated RetrievalMetrics
  config TEXT NOT NULL,            -- JSON config snapshot used during eval
  notes TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_eval_runs_project ON eval_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_eval_runs_timestamp ON eval_runs(timestamp);

-- eval_results: Per-query results within an eval run
-- One row per golden dataset entry, enabling per-query failure analysis
CREATE TABLE IF NOT EXISTS eval_results (
  id TEXT PRIMARY KEY,
  eval_run_id TEXT NOT NULL,
  query TEXT NOT NULL,
  expected_files TEXT NOT NULL,    -- JSON array of expected file paths
  retrieved_files TEXT NOT NULL,   -- JSON array of actually retrieved paths
  latency_ms INTEGER NOT NULL,
  metrics TEXT NOT NULL,           -- JSON per-query metrics
  passed INTEGER NOT NULL DEFAULT 0,  -- SQLite boolean (0=fail, 1=pass)
  FOREIGN KEY (eval_run_id) REFERENCES eval_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_eval_results_run ON eval_results(eval_run_id);
    `.trim(),
  },
  {
    name: '005-add-langfuse-trace-id.sql',
    sql: `
-- Migration 005: Add Langfuse trace ID linking
-- Links local SQLite traces to Langfuse cloud traces for cross-referencing
ALTER TABLE eval_traces ADD COLUMN langfuse_trace_id TEXT;

-- Index for looking up local traces by Langfuse trace ID
CREATE INDEX IF NOT EXISTS idx_eval_traces_langfuse ON eval_traces(langfuse_trace_id);
    `.trim(),
  },
  {
    name: '006-add-trace-type.sql',
    sql: `
-- Migration 006: Add trace type column
-- Enables filtering traces by command origin (ask, search, chat)
ALTER TABLE eval_traces ADD COLUMN trace_type TEXT;

-- Index for filtering traces by type
CREATE INDEX IF NOT EXISTS idx_eval_traces_type ON eval_traces(trace_type);
    `.trim(),
  },
];

/**
 * Run all pending migrations.
 *
 * Returns a MigrationResult with explicit success/failure information.
 * Failed migrations do not stop subsequent migrations from being attempted.
 *
 * @returns MigrationResult with applied and failed arrays
 *
 * @example
 * ```ts
 * import { runMigrations } from './database/migrate.js';
 *
 * const result = runMigrations();
 * if (result.failed.length > 0) {
 *   console.error(`${result.failed.length} migrations failed`);
 *   for (const { name, error } of result.failed) {
 *     console.error(`  - ${name}: ${error}`);
 *   }
 * }
 * console.log(`Applied ${result.applied.length} migrations`);
 * ```
 */
export function runMigrations(): MigrationResult {
  // Fast path: already initialized this process
  // This prevents redundant database calls when multiple commands invoke runMigrations()
  if (migrationState?.initialized) {
    return { applied: [], failed: [] };
  }

  const db = getDb();
  const applied: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  // Ensure migrations table exists (bootstrap)
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Get list of already-applied migrations from database
  const appliedMigrations = new Set<string>(
    db
      .prepare('SELECT name FROM _migrations')
      .all()
      .map((row) => (row as { name: string }).name)
  );

  // Apply each pending migration in a transaction
  for (const migration of MIGRATIONS) {
    if (appliedMigrations.has(migration.name)) {
      continue; // Already applied
    }

    try {
      // Run migration in transaction for atomicity
      db.transaction(() => {
        db.exec(migration.sql);
        db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(migration.name);
      })();

      applied.push(migration.name);
      appliedMigrations.add(migration.name); // Track newly applied
    } catch (error) {
      // Capture error but continue to next migration
      failed.push({
        name: migration.name,
        error: (error as Error).message,
      });
    }
  }

  // Only cache state if no failures
  // This ensures retry on next CLI invocation
  if (failed.length === 0) {
    migrationState = {
      initialized: true,
      applied: appliedMigrations,
      lastCheck: Date.now(),
    };
  }

  return { applied, failed };
}

/**
 * Check if migrations are needed.
 *
 * @returns true if there are pending migrations
 */
export function hasPendingMigrations(): boolean {
  const db = getDb();

  // Check if migrations table exists
  const tableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'"
    )
    .get();

  if (!tableExists) {
    return true; // No migrations table = definitely need to migrate
  }

  // Count applied vs available
  const appliedCount = (
    db.prepare('SELECT COUNT(*) as count FROM _migrations').get() as {
      count: number;
    }
  ).count;

  return appliedCount < MIGRATIONS.length;
}

/**
 * Get list of applied migrations.
 *
 * @returns Array of migration names with timestamps
 */
export function getAppliedMigrations(): Array<{
  name: string;
  applied_at: string;
}> {
  const db = getDb();

  // Check if migrations table exists
  const tableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'"
    )
    .get();

  if (!tableExists) {
    return [];
  }

  return db
    .prepare('SELECT name, applied_at FROM _migrations ORDER BY id')
    .all() as Array<{ name: string; applied_at: string }>;
}

// ============================================================================
// State Management Utilities (Ticket #52)
// ============================================================================

/**
 * Reset migration state for testing.
 *
 * Call this to force the next runMigrations() to check the database again.
 * Useful in tests that need to verify migration behavior.
 *
 * @example
 * ```ts
 * beforeEach(() => {
 *   resetMigrationState();
 * });
 * ```
 */
export function resetMigrationState(): void {
  migrationState = null;
}

/**
 * Check if migrations have been initialized this process.
 *
 * @returns true if runMigrations() has been called successfully
 *
 * @example
 * ```ts
 * if (!isMigrationInitialized()) {
 *   runMigrations();
 * }
 * ```
 */
export function isMigrationInitialized(): boolean {
  return migrationState?.initialized ?? false;
}

/**
 * Get count of available migrations.
 *
 * Useful for status commands to show migration info.
 *
 * @returns Total number of migrations defined in the system
 */
export function getMigrationCount(): number {
  return MIGRATIONS.length;
}
