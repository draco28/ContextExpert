/**
 * Eval Operations Tests (Tickets #112, #113)
 *
 * Tests the eval CRUD operations via the actual DatabaseOperations class
 * using constructor injection with a temp database. Verifies JSON serialization
 * round-trips, dynamic filtering, boolean coercion, and foreign key cascades.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import { DatabaseOperations } from '../operations.js';
import { EvalResultRowSchema } from '../validation.js';
import type { TraceInput, EvalRunInput, EvalResultInput } from '../../eval/types.js';

// ============================================================================
// Test Setup
// ============================================================================

describe('Eval Operations', () => {
  const testDir = join(tmpdir(), `ctx-eval-ops-test-${Date.now()}`);
  const testDbPath = join(testDir, 'test.db');
  let db: Database.Database;
  let ops: DatabaseOperations;

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

  // Helper: create a test project via raw SQL (project ops aren't the focus here)
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
    // Inject test database into DatabaseOperations via constructor DI
    ops = new DatabaseOperations(db);
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
  // Migration 004: Table Structure (raw SQL — testing schema, not operations)
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
  // Trace Operations (via DatabaseOperations class)
  // ============================================================================

  describe('insertTrace + getTraces', () => {
    it('round-trips a trace with JSON serialization', () => {
      const projectId = createTestProject();

      const input: TraceInput = {
        project_id: projectId,
        query: 'How does authentication work?',
        retrieved_files: ['src/auth.ts', 'src/middleware.ts'],
        top_k: 5,
        latency_ms: 150,
        answer: 'Authentication uses JWT tokens...',
        retrieval_method: 'fusion',
        feedback: 'positive',
        metadata: { model: 'gpt-4o' },
      };

      const traceId = ops.insertTrace(input);
      expect(traceId).toBeDefined();

      const traces = ops.getTraces({ project_id: projectId });
      expect(traces).toHaveLength(1);

      const trace = traces[0];
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

      const traceId = ops.insertTrace({
        project_id: projectId,
        query: 'search only query',
        retrieved_files: ['src/index.ts'],
        top_k: 3,
        latency_ms: 80,
        retrieval_method: 'dense',
        // answer, feedback, metadata all omitted
      });

      const traces = ops.getTraces({ project_id: projectId });
      expect(traces).toHaveLength(1);
      expect(traces[0].id).toBe(traceId);
      expect(traces[0].answer).toBeNull();
      expect(traces[0].feedback).toBeNull();
      expect(traces[0].metadata).toBeNull();
    });

    it('filters by project_id', () => {
      const projectA = createTestProject('project-a');
      const projectB = createTestProject('project-b');

      ops.insertTrace({ project_id: projectA, query: 'query A1', retrieved_files: [], top_k: 5, latency_ms: 100, retrieval_method: 'dense' });
      ops.insertTrace({ project_id: projectA, query: 'query A2', retrieved_files: [], top_k: 5, latency_ms: 100, retrieval_method: 'dense' });
      ops.insertTrace({ project_id: projectB, query: 'query B1', retrieved_files: [], top_k: 5, latency_ms: 100, retrieval_method: 'dense' });

      const tracesA = ops.getTraces({ project_id: projectA });
      expect(tracesA).toHaveLength(2);
      expect(tracesA.every((t) => t.project_id === projectA)).toBe(true);

      const tracesB = ops.getTraces({ project_id: projectB });
      expect(tracesB).toHaveLength(1);
    });

    it('filters by date range', () => {
      const projectId = createTestProject();

      // Need raw SQL here because insertTrace auto-generates timestamps
      const insertStmt = db.prepare(`
        INSERT INTO eval_traces (id, project_id, query, timestamp, retrieved_files, top_k, latency_ms, retrieval_method)
        VALUES (?, ?, ?, ?, '[]', 5, 100, 'dense')
      `);

      insertStmt.run(randomUUID(), projectId, 'old query', '2026-01-01T00:00:00Z');
      insertStmt.run(randomUUID(), projectId, 'recent query', '2026-02-10T00:00:00Z');
      insertStmt.run(randomUUID(), projectId, 'newest query', '2026-02-11T00:00:00Z');

      const traces = ops.getTraces({ start_date: '2026-02-01', end_date: '2026-02-28' });
      expect(traces).toHaveLength(2);
      expect(traces[0].query).toBe('newest query'); // DESC order
    });

    it('filters by feedback', () => {
      const projectId = createTestProject();

      ops.insertTrace({ project_id: projectId, query: 'good result', retrieved_files: [], top_k: 5, latency_ms: 100, retrieval_method: 'dense', feedback: 'positive' });
      ops.insertTrace({ project_id: projectId, query: 'bad result', retrieved_files: [], top_k: 5, latency_ms: 100, retrieval_method: 'dense', feedback: 'negative' });
      ops.insertTrace({ project_id: projectId, query: 'no feedback', retrieved_files: [], top_k: 5, latency_ms: 100, retrieval_method: 'dense' });

      const traces = ops.getTraces({ feedback: 'negative' });
      expect(traces).toHaveLength(1);
      expect(traces[0].query).toBe('bad result');
    });

    it('respects limit', () => {
      const projectId = createTestProject();

      for (let i = 0; i < 10; i++) {
        ops.insertTrace({ project_id: projectId, query: `query ${i}`, retrieved_files: [], top_k: 5, latency_ms: 100, retrieval_method: 'dense' });
      }

      const traces = ops.getTraces({ limit: 3 });
      expect(traces).toHaveLength(3);
    });
  });

  // ============================================================================
  // Eval Run Operations (via DatabaseOperations class)
  // ============================================================================

  describe('insertEvalRun + getEvalRuns', () => {
    it('round-trips an eval run with JSON metrics and config', () => {
      const projectId = createTestProject();

      const metrics = {
        mrr: 0.85,
        precision_at_k: 0.7,
        recall_at_k: 0.9,
        hit_rate: 0.95,
        ndcg: 0.82,
        map: 0.78,
      };

      const config = { topK: 5, rerank: true, embeddingModel: 'bge-large' };

      const input: EvalRunInput = {
        project_id: projectId,
        dataset_version: '1.0',
        query_count: 25,
        metrics,
        config,
        notes: 'Baseline evaluation',
      };

      const runId = ops.insertEvalRun(input);
      expect(runId).toBeDefined();

      const runs = ops.getEvalRuns(projectId);
      expect(runs).toHaveLength(1);

      const run = runs[0];
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
      const baseInput: EvalRunInput = {
        project_id: projectId,
        dataset_version: '1.0',
        query_count: 10,
        metrics: { mrr: 0, precision_at_k: 0, recall_at_k: 0, hit_rate: 0, ndcg: 0, map: 0 },
        config: {},
      };

      // Insert 3 runs (timestamps auto-generated close together)
      ops.insertEvalRun(baseInput);
      ops.insertEvalRun(baseInput);
      ops.insertEvalRun(baseInput);

      const runs = ops.getEvalRuns(projectId, 2);
      expect(runs).toHaveLength(2);
    });
  });

  describe('getEvalRun (singular)', () => {
    it('returns a single run by ID', () => {
      const projectId = createTestProject();
      const runId = ops.insertEvalRun({
        project_id: projectId,
        dataset_version: '1.0',
        query_count: 5,
        metrics: { mrr: 0.9, precision_at_k: 0.8, recall_at_k: 0.85, hit_rate: 0.95, ndcg: 0.88, map: 0.82 },
        config: { topK: 5 },
        notes: 'Test run',
      });

      const run = ops.getEvalRun(runId);
      expect(run).toBeDefined();
      expect(run!.id).toBe(runId);
      expect(run!.dataset_version).toBe('1.0');
      expect(run!.notes).toBe('Test run');
    });

    it('returns undefined for non-existent ID', () => {
      const run = ops.getEvalRun('non-existent-id');
      expect(run).toBeUndefined();
    });
  });

  describe('updateEvalRun', () => {
    it('updates metrics and notes without affecting other fields', () => {
      const projectId = createTestProject();

      const runId = ops.insertEvalRun({
        project_id: projectId,
        dataset_version: '1.0',
        query_count: 10,
        metrics: { mrr: 0.5, precision_at_k: 0, recall_at_k: 0, hit_rate: 0, ndcg: 0, map: 0 },
        config: {},
      });

      ops.updateEvalRun(runId, {
        metrics: { mrr: 0.85, precision_at_k: 0.7, recall_at_k: 0.9, hit_rate: 0.95, ndcg: 0.82, map: 0.78 },
        notes: 'Improved after reranking',
      });

      const run = ops.getEvalRun(runId);
      expect(run).toBeDefined();
      expect(JSON.parse(run!.metrics).mrr).toBe(0.85);
      expect(run!.notes).toBe('Improved after reranking');
      expect(run!.dataset_version).toBe('1.0'); // Unchanged
      expect(run!.query_count).toBe(10); // Unchanged
    });
  });

  // ============================================================================
  // Eval Result Operations (via DatabaseOperations class)
  // ============================================================================

  describe('insertEvalResult + getEvalResults', () => {
    it('round-trips a result with boolean coercion', () => {
      const projectId = createTestProject();
      const runId = ops.insertEvalRun({
        project_id: projectId,
        dataset_version: '1.0',
        query_count: 1,
        metrics: { mrr: 0, precision_at_k: 0, recall_at_k: 0, hit_rate: 0, ndcg: 0, map: 0 },
        config: {},
      });

      const perQueryMetrics = {
        reciprocal_rank: 1.0,
        precision_at_k: 0.8,
        recall_at_k: 1.0,
        hit_rate: 1,
      };

      const input: EvalResultInput = {
        eval_run_id: runId,
        query: 'How does auth work?',
        expected_files: ['src/auth.ts'],
        retrieved_files: ['src/auth.ts', 'src/middleware.ts'],
        latency_ms: 120,
        metrics: perQueryMetrics,
        passed: true,
      };

      const resultId = ops.insertEvalResult(input);
      expect(resultId).toBeDefined();

      const results = ops.getEvalResults(runId);
      expect(results).toHaveLength(1);

      const result = results[0];
      expect(result.id).toBe(resultId);
      expect(result.eval_run_id).toBe(runId);
      expect(result.query).toBe('How does auth work?');
      expect(JSON.parse(result.expected_files)).toEqual(['src/auth.ts']);
      expect(JSON.parse(result.retrieved_files)).toEqual(['src/auth.ts', 'src/middleware.ts']);
      expect(result.latency_ms).toBe(120);
      expect(JSON.parse(result.metrics)).toEqual(perQueryMetrics);
      // Key test: boolean → integer → boolean round-trip
      expect(result.passed).toBe(true);
      expect(typeof result.passed).toBe('boolean');
    });

    it('coerces passed=false through the full pipeline', () => {
      const projectId = createTestProject();
      const runId = ops.insertEvalRun({
        project_id: projectId,
        dataset_version: '1.0',
        query_count: 1,
        metrics: { mrr: 0, precision_at_k: 0, recall_at_k: 0, hit_rate: 0, ndcg: 0, map: 0 },
        config: {},
      });

      const resultId = ops.insertEvalResult({
        eval_run_id: runId,
        query: 'failed query',
        expected_files: ['src/x.ts'],
        retrieved_files: ['src/y.ts'],
        latency_ms: 200,
        metrics: { reciprocal_rank: 0, precision_at_k: 0, recall_at_k: 0, hit_rate: 0 },
        passed: false,
      });

      const results = ops.getEvalResults(runId);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(resultId);
      expect(results[0].passed).toBe(false);
      expect(typeof results[0].passed).toBe('boolean');
    });

    it('gets all results for a run with mixed pass/fail', () => {
      const projectId = createTestProject();
      const runId = ops.insertEvalRun({
        project_id: projectId,
        dataset_version: '1.0',
        query_count: 3,
        metrics: { mrr: 0, precision_at_k: 0, recall_at_k: 0, hit_rate: 0, ndcg: 0, map: 0 },
        config: {},
      });

      const baseResult = {
        eval_run_id: runId,
        expected_files: [] as string[],
        retrieved_files: [] as string[],
        latency_ms: 100,
        metrics: { reciprocal_rank: 0, precision_at_k: 0, recall_at_k: 0, hit_rate: 0 },
      };

      ops.insertEvalResult({ ...baseResult, query: 'query 1', passed: true });
      ops.insertEvalResult({ ...baseResult, query: 'query 2', passed: false });
      ops.insertEvalResult({ ...baseResult, query: 'query 3', passed: true });

      const results = ops.getEvalResults(runId);
      expect(results).toHaveLength(3);
      expect(results.filter((r) => r.passed)).toHaveLength(2);
      expect(results.filter((r) => !r.passed)).toHaveLength(1);
    });
  });

  // ============================================================================
  // Foreign Key Cascades (raw SQL — testing schema behavior)
  // ============================================================================

  describe('CASCADE DELETE', () => {
    it('deleting a project removes its traces', () => {
      const projectId = createTestProject();

      ops.insertTrace({ project_id: projectId, query: 'test', retrieved_files: [], top_k: 5, latency_ms: 100, retrieval_method: 'dense' });

      expect(ops.getTraces({ project_id: projectId })).toHaveLength(1);

      db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

      expect(ops.getTraces({ project_id: projectId })).toHaveLength(0);
    });

    it('deleting a project cascades through eval_runs to eval_results', () => {
      const projectId = createTestProject();
      const runId = ops.insertEvalRun({
        project_id: projectId,
        dataset_version: '1.0',
        query_count: 1,
        metrics: { mrr: 0, precision_at_k: 0, recall_at_k: 0, hit_rate: 0, ndcg: 0, map: 0 },
        config: {},
      });

      ops.insertEvalResult({
        eval_run_id: runId,
        query: 'test',
        expected_files: [],
        retrieved_files: [],
        latency_ms: 100,
        metrics: { reciprocal_rank: 0, precision_at_k: 0, recall_at_k: 0, hit_rate: 0 },
        passed: true,
      });

      expect(ops.getEvalRuns(projectId)).toHaveLength(1);
      expect(ops.getEvalResults(runId)).toHaveLength(1);

      // Delete project — should cascade: project → run → result
      db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

      expect(ops.getEvalRuns(projectId)).toHaveLength(0);
      expect(ops.getEvalResults(runId)).toHaveLength(0);
    });

    it('deleting an eval run cascades to its results', () => {
      const projectId = createTestProject();
      const runId = ops.insertEvalRun({
        project_id: projectId,
        dataset_version: '1.0',
        query_count: 1,
        metrics: { mrr: 0, precision_at_k: 0, recall_at_k: 0, hit_rate: 0, ndcg: 0, map: 0 },
        config: {},
      });

      ops.insertEvalResult({
        eval_run_id: runId,
        query: 'test',
        expected_files: [],
        retrieved_files: [],
        latency_ms: 100,
        metrics: { reciprocal_rank: 0, precision_at_k: 0, recall_at_k: 0, hit_rate: 0 },
        passed: true,
      });

      expect(ops.getEvalResults(runId)).toHaveLength(1);

      // Delete run — results should cascade
      db.prepare('DELETE FROM eval_runs WHERE id = ?').run(runId);

      expect(ops.getEvalResults(runId)).toHaveLength(0);
    });
  });

  // ============================================================================
  // Input Validation (Round 2 — Zod defense-in-depth)
  // ============================================================================

  describe('Input validation', () => {
    it('insertTrace rejects malformed input with Zod error', () => {
      // Missing required fields — should throw ZodError, not SQLite error
      expect(() =>
        ops.insertTrace({} as TraceInput)
      ).toThrow();

      // Verify it's a Zod error (has `issues` property)
      try {
        ops.insertTrace({} as TraceInput);
      } catch (err: unknown) {
        expect((err as { issues?: unknown[] }).issues).toBeDefined();
        expect(Array.isArray((err as { issues: unknown[] }).issues)).toBe(true);
      }
    });

    it('insertTrace rejects invalid retrieval_method', () => {
      const projectId = createTestProject();
      expect(() =>
        ops.insertTrace({
          project_id: projectId,
          query: 'test',
          retrieved_files: [],
          top_k: 5,
          latency_ms: 100,
          retrieval_method: 'invalid_method' as 'dense',
        })
      ).toThrow();
    });

    it('getTraces rejects invalid feedback filter', () => {
      expect(() =>
        ops.getTraces({ feedback: 'invalid' as 'positive' })
      ).toThrow();
    });

    it('insertEvalRun rejects malformed input with Zod error', () => {
      expect(() =>
        ops.insertEvalRun({} as EvalRunInput)
      ).toThrow();

      try {
        ops.insertEvalRun({} as EvalRunInput);
      } catch (err: unknown) {
        expect((err as { issues?: unknown[] }).issues).toBeDefined();
        expect(Array.isArray((err as { issues: unknown[] }).issues)).toBe(true);
      }
    });

    it('insertEvalResult rejects malformed input with Zod error', () => {
      expect(() =>
        ops.insertEvalResult({} as EvalResultInput)
      ).toThrow();

      try {
        ops.insertEvalResult({} as EvalResultInput);
      } catch (err: unknown) {
        expect((err as { issues?: unknown[] }).issues).toBeDefined();
        expect(Array.isArray((err as { issues: unknown[] }).issues)).toBe(true);
      }
    });

    it('insertEvalResults rejects malformed item with Zod error', () => {
      expect(() =>
        ops.insertEvalResults([{} as EvalResultInput])
      ).toThrow();

      try {
        ops.insertEvalResults([{} as EvalResultInput]);
      } catch (err: unknown) {
        expect((err as { issues?: unknown[] }).issues).toBeDefined();
        expect(Array.isArray((err as { issues: unknown[] }).issues)).toBe(true);
      }
    });
  });

  // ============================================================================
  // Batch Insert (Round 2 — transaction-wrapped batch)
  // ============================================================================

  describe('insertEvalResults (batch)', () => {
    it('inserts multiple results atomically and returns IDs', () => {
      const projectId = createTestProject();
      const runId = ops.insertEvalRun({
        project_id: projectId,
        dataset_version: '1.0',
        query_count: 3,
        metrics: { mrr: 0, precision_at_k: 0, recall_at_k: 0, hit_rate: 0, ndcg: 0, map: 0 },
        config: {},
      });

      const baseResult = {
        eval_run_id: runId,
        expected_files: ['src/auth.ts'] as string[],
        retrieved_files: ['src/auth.ts'] as string[],
        latency_ms: 100,
        metrics: { reciprocal_rank: 1, precision_at_k: 1, recall_at_k: 1, hit_rate: 1 },
      };

      const results: EvalResultInput[] = [
        { ...baseResult, query: 'query 1', passed: true },
        { ...baseResult, query: 'query 2', passed: false },
        { ...baseResult, query: 'query 3', passed: true },
      ];

      const ids = ops.insertEvalResults(results);
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3); // All unique

      const stored = ops.getEvalResults(runId);
      expect(stored).toHaveLength(3);
      expect(stored.filter((r) => r.passed)).toHaveLength(2);
      expect(stored.filter((r) => !r.passed)).toHaveLength(1);
    });

    it('handles empty array gracefully', () => {
      const ids = ops.insertEvalResults([]);
      expect(ids).toEqual([]);
    });
  });

  // ============================================================================
  // Boolean Coercion Edge Cases (Round 2 — string handling)
  // ============================================================================

  describe('EvalResultRowSchema boolean coercion', () => {
    it('coerces string "1" to true', () => {
      const row = {
        id: 'test-id',
        eval_run_id: 'run-id',
        query: 'test',
        expected_files: '[]',
        retrieved_files: '[]',
        latency_ms: 100,
        metrics: '{}',
        passed: '1',
      };

      const result = EvalResultRowSchema.parse(row);
      expect(result.passed).toBe(true);
    });

    it('coerces string "0" to false', () => {
      const row = {
        id: 'test-id',
        eval_run_id: 'run-id',
        query: 'test',
        expected_files: '[]',
        retrieved_files: '[]',
        latency_ms: 100,
        metrics: '{}',
        passed: '0',
      };

      const result = EvalResultRowSchema.parse(row);
      expect(result.passed).toBe(false);
    });

    it('coerces empty string to false', () => {
      const row = {
        id: 'test-id',
        eval_run_id: 'run-id',
        query: 'test',
        expected_files: '[]',
        retrieved_files: '[]',
        latency_ms: 100,
        metrics: '{}',
        passed: '',
      };

      const result = EvalResultRowSchema.parse(row);
      expect(result.passed).toBe(false);
    });

    it('coerces integer 0 to false and 1 to true', () => {
      const baseRow = {
        id: 'test-id',
        eval_run_id: 'run-id',
        query: 'test',
        expected_files: '[]',
        retrieved_files: '[]',
        latency_ms: 100,
        metrics: '{}',
      };

      expect(EvalResultRowSchema.parse({ ...baseRow, passed: 0 }).passed).toBe(false);
      expect(EvalResultRowSchema.parse({ ...baseRow, passed: 1 }).passed).toBe(true);
    });
  });
});
