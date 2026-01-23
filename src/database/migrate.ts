/**
 * Database Migration Runner
 *
 * Applies SQL migrations in order, tracking which have been applied.
 * Migrations are idempotent - safe to run multiple times.
 */

import { getDb } from './connection.js';

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
];

/**
 * Run all pending migrations.
 *
 * @returns Array of migration names that were applied
 *
 * @example
 * ```ts
 * import { runMigrations } from './database/migrate.js';
 *
 * const applied = runMigrations();
 * console.log(`Applied ${applied.length} migrations`);
 * ```
 */
export function runMigrations(): string[] {
  const db = getDb();
  const applied: string[] = [];

  // Ensure migrations table exists (bootstrap)
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Get list of already-applied migrations
  const appliedMigrations = new Set(
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

    // Run migration in transaction for atomicity
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(migration.name);
    })();

    applied.push(migration.name);
  }

  return applied;
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
