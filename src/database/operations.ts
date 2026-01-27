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
import type { FileType, Language } from '../indexer/types.js';
import type { ContentType } from '../indexer/chunker/types.js';

/**
 * Input for creating/updating a project.
 */
export interface ProjectUpsertInput {
  id?: string;
  name: string;
  path: string;
  tags?: string[];
  ignorePatterns?: string[];
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

  constructor() {
    this.db = getDb();
  }

  /**
   * Get the current database file size in bytes.
   */
  getDatabaseSize(): number {
    try {
      const dbPath = getDbPath();
      const stat = statSync(dbPath);
      return stat.size;
    } catch {
      return 0;
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
      INSERT INTO projects (id, name, path, tags, ignore_patterns, indexed_at, updated_at, file_count, chunk_count, config)
      VALUES (@id, @name, @path, @tags, @ignorePatterns, @now, @now, 0, 0, NULL)
      ON CONFLICT(id) DO UPDATE SET
        name = @name,
        path = @path,
        tags = @tags,
        ignore_patterns = @ignorePatterns,
        indexed_at = @now,
        updated_at = @now
    `);

    stmt.run({
      id,
      name: input.name,
      path: input.path,
      tags: input.tags ? JSON.stringify(input.tags) : null,
      ignorePatterns: input.ignorePatterns ? JSON.stringify(input.ignorePatterns) : null,
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

  /**
   * Get a project by name.
   */
  getProjectByName(name: string): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as Project | undefined;
  }

  /**
   * Delete a project and all associated data.
   *
   * CASCADE DELETE automatically removes:
   * - All chunks (via FOREIGN KEY ... ON DELETE CASCADE)
   * - All file_hashes (via FOREIGN KEY ... ON DELETE CASCADE)
   *
   * @returns Object with counts of deleted items
   */
  deleteProject(projectId: string): { chunksDeleted: number; fileHashesDeleted: number } {
    // Get counts BEFORE deletion for reporting
    const chunkCount = (
      this.db.prepare('SELECT COUNT(*) as count FROM chunks WHERE project_id = ?').get(projectId) as { count: number }
    ).count;

    const fileHashCount = (
      this.db.prepare('SELECT COUNT(*) as count FROM file_hashes WHERE project_id = ?').get(projectId) as { count: number }
    ).count;

    // Delete the project - CASCADE handles chunks and file_hashes
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

    return {
      chunksDeleted: chunkCount,
      fileHashesDeleted: fileHashCount,
    };
  }

  /**
   * Get a project by ID.
   */
  getProjectById(id: string): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
  }

  /**
   * Get a project by path.
   */
  getProjectByPath(path: string): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as Project | undefined;
  }

  /**
   * Get all projects.
   */
  getAllProjects(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as Project[];
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
