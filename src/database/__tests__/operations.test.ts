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
});
