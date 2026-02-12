/**
 * Eval Operations Tests (Tickets #112, #113)
 *
 * Tests the eval CRUD operations: trace recording, eval run management,
 * and per-query result storage. Verifies JSON serialization round-trips,
 * dynamic filtering, boolean coercion, and foreign key cascades.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import {
  EvalTraceRowSchema,
  EvalRunRowSchema,
  EvalResultRowSchema,
  validateRow,
  validateRows,
} from '../validation.js';

// ============================================================================
// Test Setup
// ============================================================================

describe('Eval Operations', () => {
  const testDir = join(tmpdir(), `ctx-eval-ops-test-${Date.now()}`);
  const testDbPath = join(testDir, 'test.db');
  let db: Database.Database;

  // SQL to create all tables needed for eval tests
  // Includes projects (for FK references) and all three eval tables
  const createTablesSql = `
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS eval_traces (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      query TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      retrieved_files TEXT NOT NULL,
      top_k INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      answer TEXT,
      retrieval_method TEXT NOT NULL,
      feedback TEXT,
      metadata TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_eval_traces_project ON eval_traces(project_id);
    CREATE INDEX IF NOT EXISTS idx_eval_traces_timestamp ON eval_traces(timestamp);

    CREATE TABLE IF NOT EXISTS eval_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      dataset_version TEXT NOT NULL,
      query_count INTEGER NOT NULL,
      metrics TEXT NOT NULL,
      config TEXT NOT NULL,
      notes TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_eval_runs_project ON eval_runs(project_id);
    CREATE INDEX IF NOT EXISTS idx_eval_runs_timestamp ON eval_runs(timestamp);

    CREATE TABLE IF NOT EXISTS eval_results (
      id TEXT PRIMARY KEY,
      eval_run_id TEXT NOT NULL,
      query TEXT NOT NULL,
      expected_files TEXT NOT NULL,
      retrieved_files TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      metrics TEXT NOT NULL,
      passed INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (eval_run_id) REFERENCES eval_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_eval_results_run ON eval_results(eval_run_id);
  `;

  // Helper: create a test project and return its ID
  function createTestProject(name = 'test-project'): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO projects (id, name, path, indexed_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, name, `/test/${name}`, now, now);
    return id;
  }

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
    db = new Database(testDbPath);
    db.pragma('foreign_keys = ON');
    db.exec(createTablesSql);
  });

  afterAll(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.exec('DELETE FROM eval_results');
    db.exec('DELETE FROM eval_runs');
    db.exec('DELETE FROM eval_traces');
    db.exec('DELETE FROM projects');
  });

  // ============================================================================
  // Migration 004: Table Structure
  // ============================================================================

  describe('Migration 004: Table structure', () => {
    it('creates eval_traces with correct columns', () => {
      const columns = db.prepare('PRAGMA table_info(eval_traces)').all() as Array<{ name: string; type: string; notnull: number }>;
      const columnNames = columns.map((c) => c.name);

      expect(columnNames).toEqual([
        'id', 'project_id', 'query', 'timestamp', 'retrieved_files',
        'top_k', 'latency_ms', 'answer', 'retrieval_method', 'feedback', 'metadata',
      ]);

      // Verify NOT NULL constraints
      const notNullCols = columns.filter((c) => c.notnull).map((c) => c.name);
      expect(notNullCols).toContain('project_id');
      expect(notNullCols).toContain('query');
      expect(notNullCols).toContain('retrieved_files');
      expect(notNullCols).toContain('top_k');
      expect(notNullCols).toContain('latency_ms');
      expect(notNullCols).toContain('retrieval_method');
    });

    it('creates eval_runs with correct columns', () => {
      const columns = db.prepare('PRAGMA table_info(eval_runs)').all() as Array<{ name: string }>;
      const columnNames = columns.map((c) => c.name);

      expect(columnNames).toEqual([
        'id', 'project_id', 'timestamp', 'dataset_version',
        'query_count', 'metrics', 'config', 'notes',
      ]);
    });

    it('creates eval_results with correct columns', () => {
      const columns = db.prepare('PRAGMA table_info(eval_results)').all() as Array<{ name: string }>;
      const columnNames = columns.map((c) => c.name);

      expect(columnNames).toEqual([
        'id', 'eval_run_id', 'query', 'expected_files',
        'retrieved_files', 'latency_ms', 'metrics', 'passed',
      ]);
    });
  });

  // ============================================================================
  // Trace Operations
  // ============================================================================

  describe('insertTrace + getTraces', () => {
    it('round-trips a trace with JSON serialization', () => {
      const projectId = createTestProject();
      const traceId = randomUUID();
      const now = new Date().toISOString();

      // Insert trace (mimics operations.ts insertTrace)
      db.prepare(`
        INSERT INTO eval_traces (id, project_id, query, timestamp, retrieved_files, top_k, latency_ms, answer, retrieval_method, feedback, metadata)
        VALUES (@id, @projectId, @query, @timestamp, @retrievedFiles, @topK, @latencyMs, @answer, @retrievalMethod, @feedback, @metadata)
      `).run({
        id: traceId,
        projectId,
        query: 'How does authentication work?',
        timestamp: now,
        retrievedFiles: JSON.stringify(['src/auth.ts', 'src/middleware.ts']),
        topK: 5,
        latencyMs: 150,
        answer: 'Authentication uses JWT tokens...',
        retrievalMethod: 'fusion',
        feedback: 'positive',
        metadata: JSON.stringify({ model: 'gpt-4o' }),
      });

      // Read back and validate
      const row = db.prepare('SELECT * FROM eval_traces WHERE id = ?').get(traceId);
      const trace = validateRow(EvalTraceRowSchema, row, 'eval_traces');

      expect(trace.id).toBe(traceId);
      expect(trace.project_id).toBe(projectId);
      expect(trace.query).toBe('How does authentication work?');
      expect(JSON.parse(trace.retrieved_files)).toEqual(['src/auth.ts', 'src/middleware.ts']);
      expect(trace.top_k).toBe(5);
      expect(trace.latency_ms).toBe(150);
      expect(trace.answer).toBe('Authentication uses JWT tokens...');
      expect(trace.retrieval_method).toBe('fusion');
      expect(trace.feedback).toBe('positive');
      expect(JSON.parse(trace.metadata!)).toEqual({ model: 'gpt-4o' });
    });

    it('handles nullable fields (answer, feedback, metadata)', () => {
      const projectId = createTestProject();
      const traceId = randomUUID();

      db.prepare(`
        INSERT INTO eval_traces (id, project_id, query, timestamp, retrieved_files, top_k, latency_ms, answer, retrieval_method, feedback, metadata)
        VALUES (@id, @projectId, @query, @timestamp, @retrievedFiles, @topK, @latencyMs, @answer, @retrievalMethod, @feedback, @metadata)
      `).run({
        id: traceId,
        projectId,
        query: 'search only query',
        timestamp: new Date().toISOString(),
        retrievedFiles: JSON.stringify(['src/index.ts']),
        topK: 3,
        latencyMs: 80,
        answer: null,
        retrievalMethod: 'dense',
        feedback: null,
        metadata: null,
      });

      const row = db.prepare('SELECT * FROM eval_traces WHERE id = ?').get(traceId);
      const trace = validateRow(EvalTraceRowSchema, row, 'eval_traces');

      expect(trace.answer).toBeNull();
      expect(trace.feedback).toBeNull();
      expect(trace.metadata).toBeNull();
    });

    it('filters by project_id', () => {
      const projectA = createTestProject('project-a');
      const projectB = createTestProject('project-b');

      const insertStmt = db.prepare(`
        INSERT INTO eval_traces (id, project_id, query, timestamp, retrieved_files, top_k, latency_ms, retrieval_method)
        VALUES (?, ?, ?, ?, '[]', 5, 100, 'dense')
      `);

      insertStmt.run(randomUUID(), projectA, 'query A1', '2026-02-01T00:00:00Z');
      insertStmt.run(randomUUID(), projectA, 'query A2', '2026-02-02T00:00:00Z');
      insertStmt.run(randomUUID(), projectB, 'query B1', '2026-02-01T00:00:00Z');

      // Filter by project A
      const rows = db.prepare(
        'SELECT * FROM eval_traces WHERE project_id = @projectId ORDER BY timestamp DESC'
      ).all({ projectId: projectA });

      const traces = validateRows(EvalTraceRowSchema, rows, 'eval_traces');
      expect(traces).toHaveLength(2);
      expect(traces.every((t) => t.project_id === projectA)).toBe(true);
    });

    it('filters by date range', () => {
      const projectId = createTestProject();
      const insertStmt = db.prepare(`
        INSERT INTO eval_traces (id, project_id, query, timestamp, retrieved_files, top_k, latency_ms, retrieval_method)
        VALUES (?, ?, ?, ?, '[]', 5, 100, 'dense')
      `);

      insertStmt.run(randomUUID(), projectId, 'old query', '2026-01-01T00:00:00Z');
      insertStmt.run(randomUUID(), projectId, 'recent query', '2026-02-10T00:00:00Z');
      insertStmt.run(randomUUID(), projectId, 'newest query', '2026-02-11T00:00:00Z');

      const rows = db.prepare(
        'SELECT * FROM eval_traces WHERE timestamp >= @startDate AND timestamp <= @endDate ORDER BY timestamp DESC'
      ).all({ startDate: '2026-02-01', endDate: '2026-02-28' });

      const traces = validateRows(EvalTraceRowSchema, rows, 'eval_traces');
      expect(traces).toHaveLength(2);
      expect(traces[0].query).toBe('newest query');
    });

    it('filters by feedback', () => {
      const projectId = createTestProject();
      const insertStmt = db.prepare(`
        INSERT INTO eval_traces (id, project_id, query, timestamp, retrieved_files, top_k, latency_ms, retrieval_method, feedback)
        VALUES (?, ?, ?, ?, '[]', 5, 100, 'dense', ?)
      `);

      insertStmt.run(randomUUID(), projectId, 'good result', new Date().toISOString(), 'positive');
      insertStmt.run(randomUUID(), projectId, 'bad result', new Date().toISOString(), 'negative');
      insertStmt.run(randomUUID(), projectId, 'no feedback', new Date().toISOString(), null);

      const rows = db.prepare(
        'SELECT * FROM eval_traces WHERE feedback = @feedback'
      ).all({ feedback: 'negative' });

      const traces = validateRows(EvalTraceRowSchema, rows, 'eval_traces');
      expect(traces).toHaveLength(1);
      expect(traces[0].query).toBe('bad result');
    });

    it('respects limit', () => {
      const projectId = createTestProject();
      const insertStmt = db.prepare(`
        INSERT INTO eval_traces (id, project_id, query, timestamp, retrieved_files, top_k, latency_ms, retrieval_method)
        VALUES (?, ?, ?, ?, '[]', 5, 100, 'dense')
      `);

      for (let i = 0; i < 10; i++) {
        insertStmt.run(randomUUID(), projectId, `query ${i}`, new Date().toISOString());
      }

      const rows = db.prepare(
        'SELECT * FROM eval_traces ORDER BY timestamp DESC LIMIT 3'
      ).all();

      const traces = validateRows(EvalTraceRowSchema, rows, 'eval_traces');
      expect(traces).toHaveLength(3);
    });
  });

  // ============================================================================
  // Eval Run Operations
  // ============================================================================

  describe('insertEvalRun + getEvalRuns', () => {
    it('round-trips an eval run with JSON metrics and config', () => {
      const projectId = createTestProject();
      const runId = randomUUID();
      const now = new Date().toISOString();

      const metrics = {
        mrr: 0.85,
        precision_at_k: 0.7,
        recall_at_k: 0.9,
        hit_rate: 0.95,
        ndcg: 0.82,
        map: 0.78,
      };

      const config = { topK: 5, rerank: true, embeddingModel: 'bge-large' };

      db.prepare(`
        INSERT INTO eval_runs (id, project_id, timestamp, dataset_version, query_count, metrics, config, notes)
        VALUES (@id, @projectId, @timestamp, @datasetVersion, @queryCount, @metrics, @config, @notes)
      `).run({
        id: runId,
        projectId,
        timestamp: now,
        datasetVersion: '1.0',
        queryCount: 25,
        metrics: JSON.stringify(metrics),
        config: JSON.stringify(config),
        notes: 'Baseline evaluation',
      });

      const row = db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(runId);
      const run = validateRow(EvalRunRowSchema, row, 'eval_runs');

      expect(run.id).toBe(runId);
      expect(run.project_id).toBe(projectId);
      expect(run.dataset_version).toBe('1.0');
      expect(run.query_count).toBe(25);
      expect(JSON.parse(run.metrics)).toEqual(metrics);
      expect(JSON.parse(run.config)).toEqual(config);
      expect(run.notes).toBe('Baseline evaluation');
    });

    it('returns runs ordered by timestamp DESC with limit', () => {
      const projectId = createTestProject();

      const insertStmt = db.prepare(`
        INSERT INTO eval_runs (id, project_id, timestamp, dataset_version, query_count, metrics, config)
        VALUES (?, ?, ?, '1.0', 10, '{}', '{}')
      `);

      insertStmt.run(randomUUID(), projectId, '2026-02-01T00:00:00Z');
      insertStmt.run(randomUUID(), projectId, '2026-02-05T00:00:00Z');
      insertStmt.run(randomUUID(), projectId, '2026-02-10T00:00:00Z');

      const rows = db.prepare(
        'SELECT * FROM eval_runs WHERE project_id = @projectId ORDER BY timestamp DESC LIMIT 2'
      ).all({ projectId });

      const runs = validateRows(EvalRunRowSchema, rows, 'eval_runs');
      expect(runs).toHaveLength(2);
      // Most recent first
      expect(runs[0].timestamp).toBe('2026-02-10T00:00:00Z');
      expect(runs[1].timestamp).toBe('2026-02-05T00:00:00Z');
    });
  });

  describe('updateEvalRun', () => {
    it('updates metrics and notes without affecting other fields', () => {
      const projectId = createTestProject();
      const runId = randomUUID();

      db.prepare(`
        INSERT INTO eval_runs (id, project_id, timestamp, dataset_version, query_count, metrics, config, notes)
        VALUES (?, ?, ?, '1.0', 10, '{"mrr": 0.5}', '{}', NULL)
      `).run(runId, projectId, new Date().toISOString());

      // Update just metrics and notes
      db.prepare('UPDATE eval_runs SET metrics = @metrics, notes = @notes WHERE id = @id').run({
        id: runId,
        metrics: JSON.stringify({ mrr: 0.85 }),
        notes: 'Improved after reranking',
      });

      const row = db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(runId);
      const run = validateRow(EvalRunRowSchema, row, 'eval_runs');

      expect(JSON.parse(run.metrics)).toEqual({ mrr: 0.85 });
      expect(run.notes).toBe('Improved after reranking');
      expect(run.dataset_version).toBe('1.0'); // Unchanged
      expect(run.query_count).toBe(10); // Unchanged
    });
  });

  // ============================================================================
  // Eval Result Operations
  // ============================================================================

  describe('insertEvalResult + getEvalResults', () => {
    it('round-trips a result with boolean coercion', () => {
      const projectId = createTestProject();
      const runId = randomUUID();
      const resultId = randomUUID();

      // Create eval run first (FK requirement)
      db.prepare(`
        INSERT INTO eval_runs (id, project_id, timestamp, dataset_version, query_count, metrics, config)
        VALUES (?, ?, ?, '1.0', 1, '{}', '{}')
      `).run(runId, projectId, new Date().toISOString());

      const perQueryMetrics = {
        reciprocal_rank: 1.0,
        precision_at_k: 0.8,
        recall_at_k: 1.0,
        hit_rate: 1,
      };

      db.prepare(`
        INSERT INTO eval_results (id, eval_run_id, query, expected_files, retrieved_files, latency_ms, metrics, passed)
        VALUES (@id, @evalRunId, @query, @expectedFiles, @retrievedFiles, @latencyMs, @metrics, @passed)
      `).run({
        id: resultId,
        evalRunId: runId,
        query: 'How does auth work?',
        expectedFiles: JSON.stringify(['src/auth.ts']),
        retrievedFiles: JSON.stringify(['src/auth.ts', 'src/middleware.ts']),
        latencyMs: 120,
        metrics: JSON.stringify(perQueryMetrics),
        passed: 1, // SQLite integer for true
      });

      const row = db.prepare('SELECT * FROM eval_results WHERE id = ?').get(resultId);
      const result = validateRow(EvalResultRowSchema, row, 'eval_results');

      expect(result.eval_run_id).toBe(runId);
      expect(result.query).toBe('How does auth work?');
      expect(JSON.parse(result.expected_files)).toEqual(['src/auth.ts']);
      expect(JSON.parse(result.retrieved_files)).toEqual(['src/auth.ts', 'src/middleware.ts']);
      expect(result.latency_ms).toBe(120);
      expect(JSON.parse(result.metrics)).toEqual(perQueryMetrics);
      // The key test: SQLite integer 1 → boolean true
      expect(result.passed).toBe(true);
      expect(typeof result.passed).toBe('boolean');
    });

    it('coerces passed=0 to false', () => {
      const projectId = createTestProject();
      const runId = randomUUID();
      const resultId = randomUUID();

      db.prepare(`
        INSERT INTO eval_runs (id, project_id, timestamp, dataset_version, query_count, metrics, config)
        VALUES (?, ?, ?, '1.0', 1, '{}', '{}')
      `).run(runId, projectId, new Date().toISOString());

      db.prepare(`
        INSERT INTO eval_results (id, eval_run_id, query, expected_files, retrieved_files, latency_ms, metrics, passed)
        VALUES (?, ?, 'failed query', '["src/x.ts"]', '["src/y.ts"]', 200, '{}', 0)
      `).run(resultId, runId);

      const row = db.prepare('SELECT * FROM eval_results WHERE id = ?').get(resultId);
      const result = validateRow(EvalResultRowSchema, row, 'eval_results');

      expect(result.passed).toBe(false);
      expect(typeof result.passed).toBe('boolean');
    });

    it('gets all results for a run', () => {
      const projectId = createTestProject();
      const runId = randomUUID();

      db.prepare(`
        INSERT INTO eval_runs (id, project_id, timestamp, dataset_version, query_count, metrics, config)
        VALUES (?, ?, ?, '1.0', 3, '{}', '{}')
      `).run(runId, projectId, new Date().toISOString());

      const insertStmt = db.prepare(`
        INSERT INTO eval_results (id, eval_run_id, query, expected_files, retrieved_files, latency_ms, metrics, passed)
        VALUES (?, ?, ?, '[]', '[]', 100, '{}', ?)
      `);

      insertStmt.run(randomUUID(), runId, 'query 1', 1);
      insertStmt.run(randomUUID(), runId, 'query 2', 0);
      insertStmt.run(randomUUID(), runId, 'query 3', 1);

      const rows = db.prepare('SELECT * FROM eval_results WHERE eval_run_id = @runId').all({ runId });
      const results = validateRows(EvalResultRowSchema, rows, 'eval_results');

      expect(results).toHaveLength(3);
      expect(results.filter((r) => r.passed)).toHaveLength(2);
      expect(results.filter((r) => !r.passed)).toHaveLength(1);
    });
  });

  // ============================================================================
  // Foreign Key Cascades
  // ============================================================================

  describe('CASCADE DELETE', () => {
    it('deleting a project removes its traces', () => {
      const projectId = createTestProject();

      db.prepare(`
        INSERT INTO eval_traces (id, project_id, query, timestamp, retrieved_files, top_k, latency_ms, retrieval_method)
        VALUES (?, ?, 'test query', ?, '[]', 5, 100, 'dense')
      `).run(randomUUID(), projectId, new Date().toISOString());

      // Verify trace exists
      const beforeCount = (db.prepare(
        'SELECT COUNT(*) as count FROM eval_traces WHERE project_id = ?'
      ).get(projectId) as { count: number }).count;
      expect(beforeCount).toBe(1);

      // Delete project
      db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

      // Trace should be gone via CASCADE
      const afterCount = (db.prepare(
        'SELECT COUNT(*) as count FROM eval_traces WHERE project_id = ?'
      ).get(projectId) as { count: number }).count;
      expect(afterCount).toBe(0);
    });

    it('deleting a project cascades through eval_runs to eval_results', () => {
      const projectId = createTestProject();
      const runId = randomUUID();

      // Create run and result
      db.prepare(`
        INSERT INTO eval_runs (id, project_id, timestamp, dataset_version, query_count, metrics, config)
        VALUES (?, ?, ?, '1.0', 1, '{}', '{}')
      `).run(runId, projectId, new Date().toISOString());

      db.prepare(`
        INSERT INTO eval_results (id, eval_run_id, query, expected_files, retrieved_files, latency_ms, metrics, passed)
        VALUES (?, ?, 'test', '[]', '[]', 100, '{}', 1)
      `).run(randomUUID(), runId);

      // Verify both exist
      expect(
        (db.prepare('SELECT COUNT(*) as count FROM eval_runs').get() as { count: number }).count
      ).toBe(1);
      expect(
        (db.prepare('SELECT COUNT(*) as count FROM eval_results').get() as { count: number }).count
      ).toBe(1);

      // Delete project — should cascade: project → run → result
      db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

      expect(
        (db.prepare('SELECT COUNT(*) as count FROM eval_runs').get() as { count: number }).count
      ).toBe(0);
      expect(
        (db.prepare('SELECT COUNT(*) as count FROM eval_results').get() as { count: number }).count
      ).toBe(0);
    });

    it('deleting an eval run cascades to its results', () => {
      const projectId = createTestProject();
      const runId = randomUUID();

      db.prepare(`
        INSERT INTO eval_runs (id, project_id, timestamp, dataset_version, query_count, metrics, config)
        VALUES (?, ?, ?, '1.0', 1, '{}', '{}')
      `).run(runId, projectId, new Date().toISOString());

      db.prepare(`
        INSERT INTO eval_results (id, eval_run_id, query, expected_files, retrieved_files, latency_ms, metrics, passed)
        VALUES (?, ?, 'test', '[]', '[]', 100, '{}', 1)
      `).run(randomUUID(), runId);

      // Delete run — results should cascade
      db.prepare('DELETE FROM eval_runs WHERE id = ?').run(runId);

      expect(
        (db.prepare('SELECT COUNT(*) as count FROM eval_results').get() as { count: number }).count
      ).toBe(0);
    });
  });
});
