/**
 * Database Operations Tests
 *
 * Tests the high-level database operations used by the indexing pipeline.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import {
  DatabaseOperations,
  type ProjectUpsertInput,
  type ChunkInsertInput,
} from '../operations.js';
import { embeddingToBlob } from '../schema.js';

describe('DatabaseOperations', () => {
  // Test setup - create a temporary database
  const testDir = join(tmpdir(), `ctx-ops-test-${Date.now()}`);
  const testDbPath = join(testDir, 'test.db');
  let testDb: Database.Database;

  // Create migration SQL inline for testing
  // NOTE: Keep in sync with migrations in migrate.ts
  const createTablesSql = `
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      tags TEXT,
      ignore_patterns TEXT,
      indexed_at TEXT,
      updated_at TEXT,
      file_count INTEGER DEFAULT 0,
      chunk_count INTEGER DEFAULT 0,
      config TEXT,
      embedding_model TEXT,
      embedding_dimensions INTEGER DEFAULT 1024,
      description TEXT
    );

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
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
  `;

  beforeAll(() => {
    // Create test directory
    mkdirSync(testDir, { recursive: true });

    // Create test database
    testDb = new Database(testDbPath);
    testDb.exec(createTablesSql);
  });

  afterAll(() => {
    testDb.close();
    // Clean up temp directory
    rmSync(testDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Clear tables before each test
    testDb.exec('DELETE FROM chunks');
    testDb.exec('DELETE FROM projects');
  });

  describe('upsertProject', () => {
    it('should insert a new project', () => {
      // We can't use the real DatabaseOperations here since it uses getDb()
      // which connects to the real database. Let's test the SQL logic directly.
      const id = 'test-project-1';
      const name = 'Test Project';
      const path = '/test/path';
      const now = new Date().toISOString();

      const stmt = testDb.prepare(`
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
        name,
        path,
        tags: JSON.stringify(['api', 'core']),
        ignorePatterns: null,
        now,
      });

      const project = testDb.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
      expect(project).toBeDefined();
      expect(project.name).toBe(name);
      expect(project.path).toBe(path);
      expect(JSON.parse(project.tags)).toEqual(['api', 'core']);
    });

    it('should update existing project on conflict', () => {
      const id = 'test-project-2';

      // Insert first
      testDb.prepare(`
        INSERT INTO projects (id, name, path, indexed_at, updated_at, file_count, chunk_count)
        VALUES (?, 'Original Name', '/original/path', ?, ?, 0, 0)
      `).run(id, new Date().toISOString(), new Date().toISOString());

      // Upsert with same id
      const now = new Date().toISOString();
      testDb.prepare(`
        INSERT INTO projects (id, name, path, tags, ignore_patterns, indexed_at, updated_at, file_count, chunk_count, config)
        VALUES (@id, @name, @path, @tags, @ignorePatterns, @now, @now, 0, 0, NULL)
        ON CONFLICT(id) DO UPDATE SET
          name = @name,
          path = @path,
          indexed_at = @now,
          updated_at = @now
      `).run({
        id,
        name: 'Updated Name',
        path: '/updated/path',
        tags: null,
        ignorePatterns: null,
        now,
      });

      const project = testDb.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
      expect(project.name).toBe('Updated Name');
      expect(project.path).toBe('/updated/path');
    });
  });

  describe('insertChunks', () => {
    it('should insert multiple chunks in a transaction', () => {
      const projectId = 'test-project-3';
      const now = new Date().toISOString();

      // Create project first
      testDb.prepare(`
        INSERT INTO projects (id, name, path, indexed_at, updated_at, file_count, chunk_count)
        VALUES (?, 'Test Project', '/test/path', ?, ?, 0, 0)
      `).run(projectId, now, now);

      const stmt = testDb.prepare(`
        INSERT INTO chunks (id, project_id, content, embedding, file_path, file_type, language, start_line, end_line, metadata, created_at)
        VALUES (@id, @projectId, @content, @embedding, @filePath, @fileType, @language, @startLine, @endLine, @metadata, @createdAt)
      `);

      const chunks: ChunkInsertInput[] = [
        {
          id: 'chunk-1',
          content: 'function hello() {}',
          embedding: new Float32Array([0.1, 0.2, 0.3]),
          filePath: 'src/hello.ts',
          fileType: 'code',
          contentType: 'code',
          language: 'typescript',
          startLine: 1,
          endLine: 1,
          metadata: { symbolName: 'hello' },
        },
        {
          id: 'chunk-2',
          content: 'function world() {}',
          embedding: new Float32Array([0.4, 0.5, 0.6]),
          filePath: 'src/world.ts',
          fileType: 'code',
          contentType: 'code',
          language: 'typescript',
          startLine: 1,
          endLine: 1,
          metadata: { symbolName: 'world' },
        },
      ];

      // Insert in transaction
      const insertMany = testDb.transaction((chunksToInsert: ChunkInsertInput[]) => {
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

      const count = (testDb.prepare('SELECT COUNT(*) as count FROM chunks WHERE project_id = ?').get(projectId) as any).count;
      expect(count).toBe(2);
    });
  });

  describe('updateProjectStats', () => {
    it('should update file and chunk counts', () => {
      const projectId = 'test-project-4';
      const now = new Date().toISOString();

      // Create project
      testDb.prepare(`
        INSERT INTO projects (id, name, path, indexed_at, updated_at, file_count, chunk_count)
        VALUES (?, 'Test Project', '/test/path', ?, ?, 0, 0)
      `).run(projectId, now, now);

      // Update stats
      testDb.prepare(`
        UPDATE projects
        SET file_count = @fileCount,
            chunk_count = @chunkCount,
            updated_at = @now
        WHERE id = @id
      `).run({
        id: projectId,
        fileCount: 50,
        chunkCount: 200,
        now: new Date().toISOString(),
      });

      const project = testDb.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
      expect(project.file_count).toBe(50);
      expect(project.chunk_count).toBe(200);
    });
  });

  describe('deleteProjectChunks', () => {
    it('should delete all chunks for a project', () => {
      const projectId = 'test-project-5';
      const now = new Date().toISOString();

      // Create project
      testDb.prepare(`
        INSERT INTO projects (id, name, path, indexed_at, updated_at, file_count, chunk_count)
        VALUES (?, 'Test Project', '/test/path', ?, ?, 0, 0)
      `).run(projectId, now, now);

      // Insert chunks
      const stmt = testDb.prepare(`
        INSERT INTO chunks (id, project_id, content, embedding, file_path, created_at)
        VALUES (?, ?, 'test', ?, 'test.ts', ?)
      `);
      const emptyEmbedding = embeddingToBlob(new Float32Array([0.1]));
      stmt.run('chunk-1', projectId, emptyEmbedding, now);
      stmt.run('chunk-2', projectId, emptyEmbedding, now);

      // Delete
      const result = testDb.prepare('DELETE FROM chunks WHERE project_id = ?').run(projectId);
      expect(result.changes).toBe(2);

      const count = (testDb.prepare('SELECT COUNT(*) as count FROM chunks WHERE project_id = ?').get(projectId) as any).count;
      expect(count).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Atomic Re-indexing: Staging Table Pattern Tests
  //
  // These tests verify the staging table operations used for zero-downtime
  // re-indexing. The pattern:
  // 1. Create staging table
  // 2. Insert new chunks to staging (main table continues serving queries)
  // 3. Atomically swap: DELETE old + INSERT from staging in one transaction
  // 4. Drop staging table
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Staging Table Pattern (Atomic Re-indexing)', () => {
    // SQL to create staging table (mirrors operations.ts)
    const createStagingSql = `
      CREATE TABLE chunks_staging (
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
        created_at TEXT NOT NULL
      )
    `;

    it('should create staging table with correct schema', () => {
      // Drop if exists from previous test
      testDb.exec('DROP TABLE IF EXISTS chunks_staging');

      // Create staging table
      testDb.exec(createStagingSql);

      // Verify table exists
      const tableInfo = testDb.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_staging'`
      ).get() as { name: string } | undefined;

      expect(tableInfo).toBeDefined();
      expect(tableInfo?.name).toBe('chunks_staging');

      // Verify columns match chunks table
      const columns = testDb.prepare(`PRAGMA table_info(chunks_staging)`).all() as Array<{ name: string }>;
      const columnNames = columns.map(c => c.name);

      expect(columnNames).toContain('id');
      expect(columnNames).toContain('project_id');
      expect(columnNames).toContain('content');
      expect(columnNames).toContain('embedding');
      expect(columnNames).toContain('file_path');

      // Cleanup
      testDb.exec('DROP TABLE chunks_staging');
    });

    it('should insert chunks to staging table', () => {
      const projectId = 'staging-test-1';
      const now = new Date().toISOString();

      // Create project
      testDb.prepare(`
        INSERT INTO projects (id, name, path, indexed_at, updated_at, file_count, chunk_count)
        VALUES (?, 'Staging Test', '/staging/path', ?, ?, 0, 0)
      `).run(projectId, now, now);

      // Create staging table
      testDb.exec('DROP TABLE IF EXISTS chunks_staging');
      testDb.exec(createStagingSql);

      // Insert to staging
      const stmt = testDb.prepare(`
        INSERT INTO chunks_staging (id, project_id, content, embedding, file_path, file_type, language, start_line, end_line, metadata, created_at)
        VALUES (@id, @projectId, @content, @embedding, @filePath, @fileType, @language, @startLine, @endLine, @metadata, @createdAt)
      `);

      const testChunks: ChunkInsertInput[] = [
        {
          id: 'staging-chunk-1',
          content: 'new function A',
          embedding: new Float32Array([0.1, 0.2]),
          filePath: 'src/a.ts',
          fileType: 'code',
          contentType: 'code',
          language: 'typescript',
          startLine: 1,
          endLine: 5,
          metadata: {},
        },
        {
          id: 'staging-chunk-2',
          content: 'new function B',
          embedding: new Float32Array([0.3, 0.4]),
          filePath: 'src/b.ts',
          fileType: 'code',
          contentType: 'code',
          language: 'typescript',
          startLine: 1,
          endLine: 10,
          metadata: {},
        },
      ];

      const insertMany = testDb.transaction((chunks: ChunkInsertInput[]) => {
        for (const chunk of chunks) {
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

      insertMany(testChunks);

      // Verify staging has chunks
      const stagingCount = (testDb.prepare(
        'SELECT COUNT(*) as count FROM chunks_staging WHERE project_id = ?'
      ).get(projectId) as { count: number }).count;

      expect(stagingCount).toBe(2);

      // Verify main table is empty (no interference)
      const mainCount = (testDb.prepare(
        'SELECT COUNT(*) as count FROM chunks WHERE project_id = ?'
      ).get(projectId) as { count: number }).count;

      expect(mainCount).toBe(0);

      // Cleanup
      testDb.exec('DROP TABLE chunks_staging');
    });

    it('should atomically swap old chunks with staged chunks', () => {
      const projectId = 'atomic-swap-test';
      const now = new Date().toISOString();

      // Create project
      testDb.prepare(`
        INSERT INTO projects (id, name, path, indexed_at, updated_at, file_count, chunk_count)
        VALUES (?, 'Atomic Swap Test', '/atomic/path', ?, ?, 0, 0)
      `).run(projectId, now, now);

      // Insert OLD chunks to main table (simulating existing indexed data)
      const oldChunkStmt = testDb.prepare(`
        INSERT INTO chunks (id, project_id, content, embedding, file_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const emptyEmbedding = embeddingToBlob(new Float32Array([0.1]));
      oldChunkStmt.run('old-chunk-1', projectId, 'old content A', emptyEmbedding, 'old-a.ts', now);
      oldChunkStmt.run('old-chunk-2', projectId, 'old content B', emptyEmbedding, 'old-b.ts', now);
      oldChunkStmt.run('old-chunk-3', projectId, 'old content C', emptyEmbedding, 'old-c.ts', now);

      // Verify old chunks exist
      const oldCount = (testDb.prepare(
        'SELECT COUNT(*) as count FROM chunks WHERE project_id = ?'
      ).get(projectId) as { count: number }).count;
      expect(oldCount).toBe(3);

      // Create staging table with NEW chunks
      testDb.exec('DROP TABLE IF EXISTS chunks_staging');
      testDb.exec(createStagingSql);

      const newChunkStmt = testDb.prepare(`
        INSERT INTO chunks_staging (id, project_id, content, embedding, file_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      newChunkStmt.run('new-chunk-1', projectId, 'new content X', emptyEmbedding, 'new-x.ts', now);
      newChunkStmt.run('new-chunk-2', projectId, 'new content Y', emptyEmbedding, 'new-y.ts', now);

      // Perform ATOMIC SWAP in a transaction
      const swapResult = testDb.transaction(() => {
        const deleteResult = testDb.prepare(
          'DELETE FROM chunks WHERE project_id = ?'
        ).run(projectId);

        const insertResult = testDb.prepare(
          'INSERT INTO chunks SELECT * FROM chunks_staging WHERE project_id = ?'
        ).run(projectId);

        return {
          deleted: deleteResult.changes,
          inserted: insertResult.changes,
        };
      })();

      // Verify swap results
      expect(swapResult.deleted).toBe(3);
      expect(swapResult.inserted).toBe(2);

      // Verify main table now has NEW chunks only
      const newCount = (testDb.prepare(
        'SELECT COUNT(*) as count FROM chunks WHERE project_id = ?'
      ).get(projectId) as { count: number }).count;
      expect(newCount).toBe(2);

      // Verify content is from new chunks
      const chunks = testDb.prepare(
        'SELECT id, content FROM chunks WHERE project_id = ? ORDER BY id'
      ).all(projectId) as Array<{ id: string; content: string }>;

      expect(chunks[0].id).toBe('new-chunk-1');
      expect(chunks[0].content).toBe('new content X');
      expect(chunks[1].id).toBe('new-chunk-2');
      expect(chunks[1].content).toBe('new content Y');

      // Cleanup
      testDb.exec('DROP TABLE chunks_staging');
    });

    it('should maintain query availability during staging (old data serves queries)', () => {
      const projectId = 'query-availability-test';
      const now = new Date().toISOString();

      // Create project with old chunks
      testDb.prepare(`
        INSERT INTO projects (id, name, path, indexed_at, updated_at, file_count, chunk_count)
        VALUES (?, 'Query Test', '/query/path', ?, ?, 0, 0)
      `).run(projectId, now, now);

      const chunkStmt = testDb.prepare(`
        INSERT INTO chunks (id, project_id, content, embedding, file_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const emptyEmbedding = embeddingToBlob(new Float32Array([0.1]));
      chunkStmt.run('existing-chunk', projectId, 'existing content', emptyEmbedding, 'existing.ts', now);

      // Simulate re-indexing: create staging and add new chunks
      testDb.exec('DROP TABLE IF EXISTS chunks_staging');
      testDb.exec(createStagingSql);

      const stagingStmt = testDb.prepare(`
        INSERT INTO chunks_staging (id, project_id, content, embedding, file_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stagingStmt.run('staged-chunk', projectId, 'staged content', emptyEmbedding, 'staged.ts', now);

      // KEY TEST: While staging table has data, queries to main table should still work
      // and return the OLD data (not 0 results!)
      const mainTableQuery = testDb.prepare(
        'SELECT content FROM chunks WHERE project_id = ?'
      ).all(projectId) as Array<{ content: string }>;

      expect(mainTableQuery.length).toBe(1);
      expect(mainTableQuery[0].content).toBe('existing content');

      // Staging table has different data
      const stagingQuery = testDb.prepare(
        'SELECT content FROM chunks_staging WHERE project_id = ?'
      ).all(projectId) as Array<{ content: string }>;

      expect(stagingQuery.length).toBe(1);
      expect(stagingQuery[0].content).toBe('staged content');

      // Cleanup
      testDb.exec('DROP TABLE chunks_staging');
    });

    it('should drop staging table on cleanup', () => {
      // Create staging table
      testDb.exec('DROP TABLE IF EXISTS chunks_staging');
      testDb.exec(createStagingSql);

      // Verify it exists
      let tableExists = testDb.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_staging'`
      ).get();
      expect(tableExists).toBeDefined();

      // Drop it (cleanup)
      testDb.exec('DROP TABLE IF EXISTS chunks_staging');

      // Verify it's gone
      tableExists = testDb.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_staging'`
      ).get();
      expect(tableExists).toBeUndefined();
    });

    it('should handle orphaned staging table from crashed session', () => {
      // Simulate a crashed session: staging table exists with partial data
      testDb.exec('DROP TABLE IF EXISTS chunks_staging');
      testDb.exec(createStagingSql);

      const orphanedStmt = testDb.prepare(`
        INSERT INTO chunks_staging (id, project_id, content, embedding, file_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const emptyEmbedding = embeddingToBlob(new Float32Array([0.1]));
      orphanedStmt.run('orphaned-chunk', 'crashed-project', 'orphaned', emptyEmbedding, 'orphan.ts', new Date().toISOString());

      // New session starts: should drop existing staging table and create fresh
      // This is what createChunksStagingTable() does
      testDb.exec('DROP TABLE IF EXISTS chunks_staging');
      testDb.exec(createStagingSql);

      // Verify orphaned data is gone
      const count = (testDb.prepare(
        'SELECT COUNT(*) as count FROM chunks_staging'
      ).get() as { count: number }).count;

      expect(count).toBe(0);

      // Cleanup
      testDb.exec('DROP TABLE IF EXISTS chunks_staging');
    });
  });
});
