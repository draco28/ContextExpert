/**
 * Eval Runner Tests (Ticket #116)
 *
 * Tests the evaluation orchestrator using dependency injection:
 * - Mock search function (no RAG engine needed)
 * - Real DatabaseOperations with temp SQLite (catches real SQL bugs)
 * - Mock loadGoldenDataset (no filesystem needed)
 *
 * No vi.mock() required — all dependencies injected via EvalRunnerDeps.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import { DatabaseOperations } from '../../database/operations.js';
import { runEval, type EvalRunnerDeps, type EvalRunOptions, type EvalSearchResult } from '../runner.js';
import { EvalError, EvalErrorCodes, type EvalConfig, type GoldenDataset, type GoldenEntry, type RetrievalMetrics } from '../types.js';

// ============================================================================
// TEST SETUP
// ============================================================================

describe('Eval Runner', () => {
  const testDir = join(tmpdir(), `ctx-runner-test-${Date.now()}`);
  const testDbPath = join(testDir, 'test.db');
  let db: Database.Database;
  let ops: DatabaseOperations;

  // SQL for all tables needed by the runner (projects for FK, eval tables for storage)
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

  /** Default eval config for tests */
  const defaultEvalConfig: EvalConfig = {
    golden_path: '~/.ctx/eval',
    default_k: 5,
    thresholds: { mrr: 0.7, hit_rate: 0.85, precision_at_k: 0.6 },
    python_path: 'python3',
    ragas_model: 'gpt-4o-mini',
  };

  /** Test project ID in the database */
  let testProjectId: string;

  /** Create a test project in the database */
  function createTestProject(name = 'test-project'): string {
    const id = `proj-${Date.now()}`;
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO projects (id, name, path, indexed_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, name, `/test/${name}`, now, now);
    return id;
  }

  /** Build a golden dataset with the given entries */
  function makeDataset(entries: GoldenEntry[], projectName = 'test-project'): GoldenDataset {
    return { version: '1.0', projectName, entries };
  }

  /** Build a golden entry with sensible defaults */
  function makeEntry(overrides: Partial<GoldenEntry> & { query: string }): GoldenEntry {
    return {
      id: `entry-${Math.random().toString(36).slice(2, 8)}`,
      source: 'manual',
      expectedFilePaths: ['src/default.ts'],
      ...overrides,
    };
  }

  /** Build mock search function that returns fixed results per query */
  function makeSearch(
    resultMap: Record<string, string[]>,
    latencyMs = 50,
  ): (query: string, topK: number) => Promise<EvalSearchResult> {
    return async (query: string, _topK: number) => ({
      filePaths: resultMap[query] ?? [],
      latencyMs,
    });
  }

  /** Build EvalRunnerDeps with the given overrides */
  function makeDeps(overrides: Partial<EvalRunnerDeps> = {}): EvalRunnerDeps {
    return {
      search: makeSearch({}),
      db: ops,
      loadGoldenDataset: () => makeDataset([]),
      projectId: testProjectId,
      evalConfig: defaultEvalConfig,
      ...overrides,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
    db = new Database(testDbPath);
    db.pragma('foreign_keys = ON');
    db.exec(createTablesSql);
    ops = new DatabaseOperations(db);
    testProjectId = createTestProject();
  });

  afterAll(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Clean eval tables between tests (order matters for FK constraints)
    db.exec('DELETE FROM eval_results');
    db.exec('DELETE FROM eval_runs');
  });

  // ============================================================================
  // HAPPY PATH
  // ============================================================================

  describe('happy path', () => {
    it('evaluates all entries and returns correct summary', async () => {
      const entries = [
        makeEntry({ query: 'How does auth work?', expectedFilePaths: ['src/auth.ts'] }),
        makeEntry({ query: 'Search implementation', expectedFilePaths: ['src/search.ts'] }),
      ];

      const search = makeSearch({
        'How does auth work?': ['src/auth.ts', 'src/utils.ts'],
        'Search implementation': ['src/search.ts', 'src/index.ts'],
      });

      const deps = makeDeps({
        search,
        loadGoldenDataset: () => makeDataset(entries),
      });

      const summary = await runEval({ projectName: 'test-project' }, deps);

      expect(summary.project_name).toBe('test-project');
      expect(summary.query_count).toBe(2);
      expect(summary.run_id).toBeDefined();
      expect(summary.timestamp).toBeDefined();
      expect(summary.config).toEqual({
        top_k: 5,
        include_generation: false,
        tags: [],
      });
    });

    it('computes correct aggregate metrics', async () => {
      const entries = [
        // Perfect hit: first result is relevant
        makeEntry({ query: 'q1', expectedFilePaths: ['a.ts'] }),
        // Miss: no relevant results
        makeEntry({ query: 'q2', expectedFilePaths: ['b.ts'] }),
      ];

      const search = makeSearch({
        q1: ['a.ts', 'x.ts'],
        q2: ['x.ts', 'y.ts'],
      });

      const deps = makeDeps({
        search,
        loadGoldenDataset: () => makeDataset(entries),
      });

      const summary = await runEval({ projectName: 'test-project' }, deps);

      // MRR: (1.0 + 0.0) / 2 = 0.5
      expect(summary.metrics.mrr).toBeCloseTo(0.5, 4);
      // Hit rate: (1 + 0) / 2 = 0.5
      expect(summary.metrics.hit_rate).toBeCloseTo(0.5, 4);
      // Precision@5: q1 has 1/5=0.2 (divides by K, not result count), q2 has 0/5=0.0 → avg 0.1
      expect(summary.metrics.precision_at_k).toBeCloseTo(0.1, 4);
    });

    it('stores eval results in the database', async () => {
      const entries = [
        makeEntry({ query: 'q1', expectedFilePaths: ['a.ts'] }),
        makeEntry({ query: 'q2', expectedFilePaths: ['b.ts'] }),
      ];

      const search = makeSearch({
        q1: ['a.ts'],
        q2: ['x.ts'],
      });

      const deps = makeDeps({
        search,
        loadGoldenDataset: () => makeDataset(entries),
      });

      const summary = await runEval({ projectName: 'test-project' }, deps);

      const results = ops.getEvalResults(summary.run_id);
      expect(results).toHaveLength(2);

      // q1 should pass (hit_rate = 1), q2 should fail (hit_rate = 0)
      const q1Result = results.find((r) => r.query === 'q1');
      const q2Result = results.find((r) => r.query === 'q2');
      expect(q1Result).toBeDefined();
      expect(q2Result).toBeDefined();
      // Zod schema coerces SQLite INTEGER back to boolean
      expect(q1Result!.passed).toBe(true);
      expect(q2Result!.passed).toBe(false);
    });

    it('updates eval_run notes to status:completed', async () => {
      const entries = [
        makeEntry({ query: 'q1', expectedFilePaths: ['a.ts'] }),
      ];

      const search = makeSearch({ q1: ['a.ts'] });

      const deps = makeDeps({
        search,
        loadGoldenDataset: () => makeDataset(entries),
      });

      const summary = await runEval({ projectName: 'test-project' }, deps);

      const run = ops.getEvalRun(summary.run_id);
      expect(run).toBeDefined();
      expect(run!.notes).toContain('status:completed');
      expect(run!.notes).toContain('1/1 passed');
    });
  });

  // ============================================================================
  // COMPARISON WITH PREVIOUS RUN
  // ============================================================================

  describe('comparison with previous run', () => {
    it('returns comparison deltas when previous run exists', async () => {
      // Insert a previous run manually
      const previousMetrics: RetrievalMetrics = {
        mrr: 0.4,
        precision_at_k: 0.3,
        recall_at_k: 0.5,
        hit_rate: 0.6,
        ndcg: 0.45,
        map: 0.35,
      };

      ops.insertEvalRun({
        project_id: testProjectId,
        dataset_version: '1.0',
        query_count: 2,
        metrics: previousMetrics,
        config: { top_k: 5 },
        notes: 'status:completed | 1/2 passed',
      });

      // Run a new evaluation where q1 hits perfectly
      const entries = [
        makeEntry({ query: 'q1', expectedFilePaths: ['a.ts'] }),
      ];
      const search = makeSearch({ q1: ['a.ts'] });

      const deps = makeDeps({
        search,
        loadGoldenDataset: () => makeDataset(entries),
      });

      const summary = await runEval({ projectName: 'test-project' }, deps);

      expect(summary.comparison).toBeDefined();
      expect(summary.comparison!.previous_run_id).toBeDefined();
      // Current MRR is 1.0, previous was 0.4 → delta = +0.6
      expect(summary.comparison!.metric_changes.mrr).toBeCloseTo(0.6, 4);
    });

    it('returns undefined comparison for first run', async () => {
      const entries = [
        makeEntry({ query: 'q1', expectedFilePaths: ['a.ts'] }),
      ];
      const search = makeSearch({ q1: ['a.ts'] });

      const deps = makeDeps({
        search,
        loadGoldenDataset: () => makeDataset(entries),
      });

      const summary = await runEval({ projectName: 'test-project' }, deps);

      expect(summary.comparison).toBeUndefined();
    });
  });

  // ============================================================================
  // GOLDEN DATASET EDGE CASES
  // ============================================================================

  describe('golden dataset edge cases', () => {
    it('throws DATASET_NOT_FOUND for empty dataset', async () => {
      const deps = makeDeps({
        loadGoldenDataset: () => makeDataset([]),
      });

      await expect(
        runEval({ projectName: 'empty-project' }, deps),
      ).rejects.toThrow(EvalError);

      try {
        await runEval({ projectName: 'empty-project' }, deps);
      } catch (error) {
        expect(error).toBeInstanceOf(EvalError);
        expect((error as EvalError).code).toBe(EvalErrorCodes.DATASET_NOT_FOUND);
      }
    });

    it('throws DATASET_INVALID when no entries have expectedFilePaths', async () => {
      const entries = [
        makeEntry({ query: 'q1', expectedFilePaths: undefined, expectedAnswer: 'some answer' }),
        makeEntry({ query: 'q2', expectedFilePaths: undefined, expectedAnswer: 'another answer' }),
      ];

      const deps = makeDeps({
        loadGoldenDataset: () => makeDataset(entries),
      });

      await expect(
        runEval({ projectName: 'test-project' }, deps),
      ).rejects.toThrow(EvalError);

      try {
        await runEval({ projectName: 'test-project' }, deps);
      } catch (error) {
        expect((error as EvalError).code).toBe(EvalErrorCodes.DATASET_INVALID);
      }
    });

    it('skips entries without expectedFilePaths', async () => {
      const entries = [
        makeEntry({ query: 'q1', expectedFilePaths: ['a.ts'] }),
        makeEntry({ query: 'q2', expectedFilePaths: ['b.ts'] }),
        // This one has only an expectedAnswer, no file paths — should be skipped
        makeEntry({ query: 'q3', expectedFilePaths: undefined, expectedAnswer: 'answer' }),
      ];

      const search = makeSearch({
        q1: ['a.ts'],
        q2: ['b.ts'],
      });

      const deps = makeDeps({
        search,
        loadGoldenDataset: () => makeDataset(entries),
      });

      const summary = await runEval({ projectName: 'test-project' }, deps);

      expect(summary.query_count).toBe(2); // Not 3
      const run = ops.getEvalRun(summary.run_id);
      expect(run!.notes).toContain('1 skipped (no expectedFilePaths)');
    });

    it('filters entries by tags when specified', async () => {
      const entries = [
        makeEntry({ query: 'q1', expectedFilePaths: ['a.ts'], tags: ['api'] }),
        makeEntry({ query: 'q2', expectedFilePaths: ['b.ts'], tags: ['auth'] }),
        makeEntry({ query: 'q3', expectedFilePaths: ['c.ts'], tags: ['api', 'auth'] }),
      ];

      const search = makeSearch({
        q2: ['b.ts'],
        q3: ['c.ts'],
      });

      const deps = makeDeps({
        search,
        loadGoldenDataset: () => makeDataset(entries),
      });

      // Only run entries with 'auth' tag → q2 and q3
      const summary = await runEval(
        { projectName: 'test-project', tags: ['auth'] },
        deps,
      );

      expect(summary.query_count).toBe(2);
      const run = ops.getEvalRun(summary.run_id);
      expect(run!.notes).toContain('1 filtered by tags');
    });

    it('skips entries with empty expectedFilePaths array', async () => {
      const entries = [
        makeEntry({ query: 'q1', expectedFilePaths: ['a.ts'] }),
        makeEntry({ query: 'q2', expectedFilePaths: [] }), // empty array
      ];

      const search = makeSearch({ q1: ['a.ts'] });

      const deps = makeDeps({
        search,
        loadGoldenDataset: () => makeDataset(entries),
      });

      const summary = await runEval({ projectName: 'test-project' }, deps);

      expect(summary.query_count).toBe(1);
    });
  });

  // ============================================================================
  // ERROR HANDLING
  // ============================================================================

  describe('error handling', () => {
    it('marks run as failed when search throws', async () => {
      const entries = [
        makeEntry({ query: 'q1', expectedFilePaths: ['a.ts'] }),
        makeEntry({ query: 'q2', expectedFilePaths: ['b.ts'] }),
      ];

      let callCount = 0;
      const failingSearch = async (_query: string, _topK: number): Promise<EvalSearchResult> => {
        callCount++;
        if (callCount === 2) {
          throw new Error('network timeout');
        }
        return { filePaths: ['a.ts'], latencyMs: 50 };
      };

      const deps = makeDeps({
        search: failingSearch,
        loadGoldenDataset: () => makeDataset(entries),
      });

      await expect(
        runEval({ projectName: 'test-project' }, deps),
      ).rejects.toThrow(EvalError);

      // Verify the run was marked as failed in the database
      const runs = ops.getEvalRuns(testProjectId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.notes).toContain('status:failed');
      expect(runs[0]!.notes).toContain('network timeout');
    });

    it('wraps non-EvalError exceptions in EVAL_RUN_FAILED', async () => {
      const entries = [
        makeEntry({ query: 'q1', expectedFilePaths: ['a.ts'] }),
      ];

      const failingSearch = async (_query: string, _topK: number): Promise<EvalSearchResult> => {
        throw new Error('unexpected error');
      };

      const deps = makeDeps({
        search: failingSearch,
        loadGoldenDataset: () => makeDataset(entries),
      });

      try {
        await runEval({ projectName: 'test-project' }, deps);
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(EvalError);
        expect((error as EvalError).code).toBe(EvalErrorCodes.EVAL_RUN_FAILED);
        expect((error as EvalError).cause).toBeInstanceOf(Error);
        expect((error as EvalError).cause!.message).toBe('unexpected error');
      }
    });

    it('re-throws EvalError as-is without double wrapping', async () => {
      const entries = [
        makeEntry({ query: 'q1', expectedFilePaths: ['a.ts'] }),
      ];

      const originalError = EvalError.datasetInvalid('custom reason');
      const failingSearch = async (_query: string, _topK: number): Promise<EvalSearchResult> => {
        throw originalError;
      };

      const deps = makeDeps({
        search: failingSearch,
        loadGoldenDataset: () => makeDataset(entries),
      });

      try {
        await runEval({ projectName: 'test-project' }, deps);
        expect.unreachable('Should have thrown');
      } catch (error) {
        // Should be the exact same error object, not wrapped in EVAL_RUN_FAILED
        expect(error).toBe(originalError);
        expect((error as EvalError).code).toBe(EvalErrorCodes.DATASET_INVALID);
      }
    });
  });

  // ============================================================================
  // TOP-K PARAMETER
  // ============================================================================

  describe('topK parameter', () => {
    it('uses override topK when provided', async () => {
      const entries = [
        makeEntry({ query: 'q1', expectedFilePaths: ['a.ts'] }),
      ];

      const search = makeSearch({ q1: ['a.ts'] });

      const deps = makeDeps({
        search,
        loadGoldenDataset: () => makeDataset(entries),
      });

      const summary = await runEval(
        { projectName: 'test-project', topK: 3 },
        deps,
      );

      expect(summary.config).toHaveProperty('top_k', 3);
    });

    it('passes topK to the search function', async () => {
      const entries = [
        makeEntry({ query: 'q1', expectedFilePaths: ['a.ts'] }),
        makeEntry({ query: 'q2', expectedFilePaths: ['b.ts'] }),
      ];

      const searchSpy = vi.fn(async (_query: string, _topK: number) => ({
        filePaths: ['a.ts'],
        latencyMs: 50,
      }));

      const deps = makeDeps({
        search: searchSpy,
        loadGoldenDataset: () => makeDataset(entries),
      });

      await runEval({ projectName: 'test-project', topK: 7 }, deps);

      // Every search call should receive topK=7
      expect(searchSpy).toHaveBeenCalledTimes(2);
      expect(searchSpy).toHaveBeenCalledWith('q1', 7);
      expect(searchSpy).toHaveBeenCalledWith('q2', 7);
    });

    it('falls back to evalConfig.default_k when no override', async () => {
      const entries = [
        makeEntry({ query: 'q1', expectedFilePaths: ['a.ts'] }),
      ];

      const search = makeSearch({ q1: ['a.ts'] });

      const deps = makeDeps({
        search,
        loadGoldenDataset: () => makeDataset(entries),
        evalConfig: { ...defaultEvalConfig, default_k: 10 },
      });

      const summary = await runEval({ projectName: 'test-project' }, deps);

      expect(summary.config).toHaveProperty('top_k', 10);
    });
  });

  // ============================================================================
  // PASSED LOGIC
  // ============================================================================

  describe('passed logic', () => {
    it('query passes when hit_rate is 1 (relevant result found)', async () => {
      const entries = [
        makeEntry({ query: 'q1', expectedFilePaths: ['a.ts'] }),
      ];

      const search = makeSearch({ q1: ['a.ts', 'b.ts', 'c.ts'] });

      const deps = makeDeps({
        search,
        loadGoldenDataset: () => makeDataset(entries),
      });

      const summary = await runEval({ projectName: 'test-project' }, deps);

      const results = ops.getEvalResults(summary.run_id);
      expect(results).toHaveLength(1);
      expect(results[0]!.passed).toBe(true);
    });

    it('query fails when hit_rate is 0 (no relevant results)', async () => {
      const entries = [
        makeEntry({ query: 'q1', expectedFilePaths: ['a.ts'] }),
      ];

      const search = makeSearch({ q1: ['x.ts', 'y.ts', 'z.ts'] });

      const deps = makeDeps({
        search,
        loadGoldenDataset: () => makeDataset(entries),
      });

      const summary = await runEval({ projectName: 'test-project' }, deps);

      const results = ops.getEvalResults(summary.run_id);
      expect(results).toHaveLength(1);
      expect(results[0]!.passed).toBe(false);
    });
  });

  // ============================================================================
  // INCLUDEGENERATION OPTION
  // ============================================================================

  describe('includeGeneration option', () => {
    it('records includeGeneration in config snapshot', async () => {
      const entries = [
        makeEntry({ query: 'q1', expectedFilePaths: ['a.ts'] }),
      ];

      const search = makeSearch({ q1: ['a.ts'] });

      const deps = makeDeps({
        search,
        loadGoldenDataset: () => makeDataset(entries),
      });

      const summary = await runEval(
        { projectName: 'test-project', includeGeneration: true },
        deps,
      );

      expect(summary.config).toHaveProperty('include_generation', true);
    });
  });
});
