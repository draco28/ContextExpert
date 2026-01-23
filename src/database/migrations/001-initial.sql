-- Migration 001: Initial Schema
-- Creates core tables for the context system

-- ============================================================================
-- Projects Table
-- Registry of indexed codebases
-- ============================================================================
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  path TEXT NOT NULL,
  tags TEXT,                    -- JSON array of strings
  ignore_patterns TEXT,         -- JSON array of glob patterns
  indexed_at TEXT,              -- ISO 8601 timestamp
  updated_at TEXT,              -- ISO 8601 timestamp
  file_count INTEGER DEFAULT 0,
  chunk_count INTEGER DEFAULT 0,
  config TEXT                   -- JSON object
);

-- Index for listing projects by name
CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);

-- ============================================================================
-- Chunks Table
-- Document fragments with vector embeddings for semantic search
-- ============================================================================
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB NOT NULL,      -- Float32Array as binary (1024 dims = ~4KB)
  file_path TEXT NOT NULL,      -- Relative path from project root
  file_type TEXT,               -- 'code', 'docs', 'config'
  language TEXT,                -- 'typescript', 'python', 'markdown', etc.
  start_line INTEGER,
  end_line INTEGER,
  metadata TEXT,                -- JSON object for additional data
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- Foreign key with CASCADE delete
  -- When a project is deleted, all its chunks are automatically removed
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Index for filtering chunks by project
CREATE INDEX IF NOT EXISTS idx_chunks_project_id ON chunks(project_id);

-- Index for finding chunks by file path within a project
CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(project_id, file_path);

-- Index for filtering by file type
CREATE INDEX IF NOT EXISTS idx_chunks_file_type ON chunks(project_id, file_type);

-- ============================================================================
-- File Hashes Table
-- Tracks file content hashes for incremental indexing
-- ============================================================================
CREATE TABLE IF NOT EXISTS file_hashes (
  project_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  hash TEXT NOT NULL,           -- SHA-256 of file content
  chunk_ids TEXT NOT NULL,      -- JSON array of chunk IDs
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- Composite primary key
  PRIMARY KEY (project_id, file_path),

  -- Foreign key with CASCADE delete
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- ============================================================================
-- Migrations Tracking Table
-- Records which migrations have been applied
-- ============================================================================
CREATE TABLE IF NOT EXISTS _migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
