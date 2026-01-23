/**
 * Database Module Tests
 *
 * Tests for connection, schema, and migrations.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  embeddingToBlob,
  blobToEmbedding,
  generateId,
  type Project,
  type Chunk,
} from '../schema.js';

// Use a test database in temp directory
let testDb: Database.Database;
let testDir: string;

beforeAll(() => {
  // Create temp directory for test database
  testDir = mkdtempSync(join(tmpdir(), 'ctx-test-'));
  const dbPath = join(testDir, 'test.db');

  testDb = new Database(dbPath);
  testDb.pragma('foreign_keys = ON');

  // Apply schema directly (simulating migration)
  testDb.exec(`
    CREATE TABLE projects (
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

    CREATE TABLE chunks (
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

    CREATE TABLE file_hashes (
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      hash TEXT NOT NULL,
      chunk_ids TEXT NOT NULL,
      indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, file_path),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);
});

afterAll(() => {
  testDb.close();
  // Clean up temp directory
  rmSync(testDir, { recursive: true, force: true });
});

describe('Schema Types', () => {
  it('should generate unique UUIDs', () => {
    const id1 = generateId();
    const id2 = generateId();

    expect(id1).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(id1).not.toBe(id2);
  });

  it('should convert Float32Array to Buffer and back', () => {
    const original = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
    const blob = embeddingToBlob(original);
    const restored = blobToEmbedding(blob);

    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i]!, 6);
    }
  });

  it('should handle large embeddings (1024 dimensions)', () => {
    // Simulate a real embedding size
    const embedding = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      embedding[i] = Math.random() * 2 - 1; // Values between -1 and 1
    }

    const blob = embeddingToBlob(embedding);
    expect(blob.length).toBe(1024 * 4); // 4 bytes per float32

    const restored = blobToEmbedding(blob);
    expect(restored.length).toBe(1024);
  });
});

describe('Database Operations', () => {
  it('should insert and query projects', () => {
    const projectId = generateId();

    testDb
      .prepare(
        `
      INSERT INTO projects (id, name, path, file_count, chunk_count)
      VALUES (?, ?, ?, ?, ?)
    `
      )
      .run(projectId, 'test-project', '/path/to/project', 10, 50);

    const project = testDb
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(projectId) as Project;

    expect(project.name).toBe('test-project');
    expect(project.path).toBe('/path/to/project');
    expect(project.file_count).toBe(10);
    expect(project.chunk_count).toBe(50);
  });

  it('should insert chunks with BLOB embeddings', () => {
    // First get or create a project
    let project = testDb
      .prepare("SELECT * FROM projects WHERE name = ?")
      .get('test-project') as Project | undefined;

    if (!project) {
      const projectId = generateId();
      testDb
        .prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)')
        .run(projectId, 'test-project', '/path/to/project');
      project = testDb
        .prepare('SELECT * FROM projects WHERE id = ?')
        .get(projectId) as Project;
    }

    const chunkId = generateId();
    const embedding = new Float32Array([0.1, 0.2, 0.3]);
    const blob = embeddingToBlob(embedding);

    testDb
      .prepare(
        `
      INSERT INTO chunks (id, project_id, content, embedding, file_path, file_type, language)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        chunkId,
        project.id,
        'function hello() { return "world"; }',
        blob,
        'src/hello.ts',
        'code',
        'typescript'
      );

    const chunk = testDb
      .prepare('SELECT * FROM chunks WHERE id = ?')
      .get(chunkId) as Chunk;

    expect(chunk.content).toBe('function hello() { return "world"; }');
    expect(chunk.file_type).toBe('code');
    expect(chunk.language).toBe('typescript');

    // Verify embedding round-trip
    const restoredEmbedding = blobToEmbedding(chunk.embedding);
    expect(restoredEmbedding.length).toBe(3);
    expect(restoredEmbedding[0]).toBeCloseTo(0.1, 6);
  });

  it('should enforce UNIQUE constraint on project name', () => {
    const id1 = generateId();
    const id2 = generateId();

    testDb
      .prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)')
      .run(id1, 'unique-test', '/path/1');

    expect(() => {
      testDb
        .prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)')
        .run(id2, 'unique-test', '/path/2');
    }).toThrow(/UNIQUE constraint failed/);
  });
});

describe('Foreign Key Constraints', () => {
  it('should CASCADE delete chunks when project is deleted', () => {
    const projectId = generateId();
    const chunkId = generateId();
    const embedding = embeddingToBlob(new Float32Array([1, 2, 3]));

    // Insert project and chunk
    testDb
      .prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)')
      .run(projectId, 'cascade-test', '/path/cascade');

    testDb
      .prepare(
        `
      INSERT INTO chunks (id, project_id, content, embedding, file_path)
      VALUES (?, ?, ?, ?, ?)
    `
      )
      .run(chunkId, projectId, 'test content', embedding, 'test.ts');

    // Verify chunk exists
    let chunk = testDb.prepare('SELECT * FROM chunks WHERE id = ?').get(chunkId);
    expect(chunk).toBeDefined();

    // Delete project
    testDb.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

    // Verify chunk was CASCADE deleted
    chunk = testDb.prepare('SELECT * FROM chunks WHERE id = ?').get(chunkId);
    expect(chunk).toBeUndefined();
  });

  it('should CASCADE delete file_hashes when project is deleted', () => {
    const projectId = generateId();

    // Insert project and file_hash
    testDb
      .prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)')
      .run(projectId, 'hash-cascade-test', '/path/hash');

    testDb
      .prepare(
        `
      INSERT INTO file_hashes (project_id, file_path, hash, chunk_ids)
      VALUES (?, ?, ?, ?)
    `
      )
      .run(projectId, 'src/index.ts', 'abc123', '[]');

    // Verify file_hash exists
    let hash = testDb
      .prepare('SELECT * FROM file_hashes WHERE project_id = ?')
      .get(projectId);
    expect(hash).toBeDefined();

    // Delete project
    testDb.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

    // Verify file_hash was CASCADE deleted
    hash = testDb
      .prepare('SELECT * FROM file_hashes WHERE project_id = ?')
      .get(projectId);
    expect(hash).toBeUndefined();
  });

  it('should reject chunks with invalid project_id', () => {
    const chunkId = generateId();
    const embedding = embeddingToBlob(new Float32Array([1, 2, 3]));

    expect(() => {
      testDb
        .prepare(
          `
        INSERT INTO chunks (id, project_id, content, embedding, file_path)
        VALUES (?, ?, ?, ?, ?)
      `
        )
        .run(chunkId, 'non-existent-project-id', 'content', embedding, 'test.ts');
    }).toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe('Parameterized Queries', () => {
  it('should safely handle special characters in values', () => {
    const projectId = generateId();
    const dangerousName = "test'; DROP TABLE projects; --";
    const dangerousPath = '/path/with "quotes" and \'apostrophes\'';

    // This should NOT cause SQL injection
    testDb
      .prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)')
      .run(projectId, dangerousName, dangerousPath);

    const project = testDb
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(projectId) as Project;

    expect(project.name).toBe(dangerousName);
    expect(project.path).toBe(dangerousPath);

    // Verify projects table still exists
    const tables = testDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    expect(tables.map((t) => (t as { name: string }).name)).toContain('projects');
  });
});
