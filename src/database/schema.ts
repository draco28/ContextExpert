/**
 * Database Schema Types
 *
 * TypeScript interfaces matching the SQLite table schemas.
 * These provide type safety when querying the database.
 */

import { randomUUID } from 'node:crypto';

// ============================================================================
// Projects Table
// ============================================================================

/**
 * A registered project/codebase in the context system.
 */
export interface Project {
  /** UUID primary key */
  id: string;
  /** Unique project name (e.g., "my-app") */
  name: string;
  /** Absolute path to project root */
  path: string;
  /** JSON array of tags for filtering */
  tags: string | null;
  /** JSON array of glob patterns to ignore */
  ignore_patterns: string | null;
  /** ISO timestamp of last full index */
  indexed_at: string | null;
  /** ISO timestamp of last modification */
  updated_at: string | null;
  /** Count of indexed files */
  file_count: number;
  /** Count of chunks in database */
  chunk_count: number;
  /** JSON object with custom settings */
  config: string | null;
  /** Embedding model name used for this project's vectors (e.g., "BAAI/bge-large-en-v1.5") */
  embedding_model: string | null;
  /** Embedding dimensions (default: 1024 for BGE-large) */
  embedding_dimensions: number;
  /** Optional description for smart query routing (e.g., "Main API server with auth and payments") */
  description: string | null;
}

/**
 * Input for creating a new project.
 * ID and timestamps are auto-generated.
 */
export interface ProjectInput {
  name: string;
  path: string;
  tags?: string[];
  ignore_patterns?: string[];
  config?: Record<string, unknown>;
}

// ============================================================================
// Chunks Table
// ============================================================================

/**
 * A document chunk with vector embedding.
 * Chunks are fragments of files used for semantic search.
 */
export interface Chunk {
  /** UUID primary key */
  id: string;
  /** Foreign key to projects.id */
  project_id: string;
  /** The actual text content */
  content: string;
  /** Binary Float32Array embedding (BLOB) */
  embedding: Buffer;
  /** Relative path from project root */
  file_path: string;
  /** Content type classification */
  file_type: 'code' | 'docs' | 'config' | null;
  /** Programming language or format */
  language: string | null;
  /** Starting line number in source file */
  start_line: number | null;
  /** Ending line number in source file */
  end_line: number | null;
  /** JSON object with additional metadata */
  metadata: string | null;
  /** ISO timestamp of creation */
  created_at: string;
}

/**
 * Input for creating a new chunk.
 */
export interface ChunkInput {
  project_id: string;
  content: string;
  embedding: Float32Array;
  file_path: string;
  file_type?: 'code' | 'docs' | 'config';
  language?: string;
  start_line?: number;
  end_line?: number;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// File Hashes Table
// ============================================================================

/**
 * File hash for incremental indexing.
 * Tracks which files have changed since last index.
 */
export interface FileHash {
  /** Foreign key to projects.id (part of composite PK) */
  project_id: string;
  /** Relative path from project root (part of composite PK) */
  file_path: string;
  /** SHA-256 hash of file content */
  hash: string;
  /** JSON array of chunk IDs for this file */
  chunk_ids: string;
  /** ISO timestamp when file was indexed */
  indexed_at: string;
}

/**
 * Input for creating/updating a file hash.
 */
export interface FileHashInput {
  project_id: string;
  file_path: string;
  hash: string;
  chunk_ids: string[];
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Generate a new UUID for database records.
 */
export function generateId(): string {
  return randomUUID();
}

/**
 * Convert Float32Array to Buffer for BLOB storage.
 *
 * @example
 * ```ts
 * const embedding = new Float32Array([0.1, 0.2, 0.3]);
 * const blob = embeddingToBlob(embedding);
 * db.prepare('INSERT INTO chunks (embedding) VALUES (?)').run(blob);
 * ```
 */
export function embeddingToBlob(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer);
}

/**
 * Convert Buffer from BLOB back to Float32Array.
 *
 * @example
 * ```ts
 * const row = db.prepare('SELECT embedding FROM chunks WHERE id = ?').get(id);
 * const embedding = blobToEmbedding(row.embedding);
 * ```
 */
export function blobToEmbedding(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.length / 4);
}
