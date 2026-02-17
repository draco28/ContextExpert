/**
 * Eval Test Fixtures Validation (Ticket #127)
 *
 * Validates that the eval fixture files are correct and usable:
 * 1. golden.json passes GoldenDatasetSchema validation
 * 2. All expectedFilePaths point to real files in test-project/
 * 3. Fixtures integrate correctly with the eval runner
 *
 * These tests enable CI eval without external dependencies — no live
 * RAG engine, no user home directory, no indexed projects needed.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import { GoldenDatasetSchema } from '../golden.js';
import { DatabaseOperations } from '../../database/operations.js';
import { runEval, type EvalRunnerDeps, type EvalSearchResult } from '../runner.js';
import type { EvalConfig, GoldenDataset } from '../types.js';

// ============================================================================
// PATH RESOLUTION
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to fixtures/eval/ at the project root */
const FIXTURES_DIR = resolve(__dirname, '../../../fixtures/eval');
const GOLDEN_PATH = join(FIXTURES_DIR, 'golden.json');
const TEST_PROJECT_DIR = join(FIXTURES_DIR, 'test-project');

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Recursively collect all file paths under a directory.
 * Returns paths relative to the base directory.
 */
function collectFiles(dir: string, base: string = dir): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, base));
    } else {
      files.push(fullPath.slice(base.length + 1)); // relative path
    }
  }

  return files;
}

// ============================================================================
// TESTS
// ============================================================================

describe('Eval Test Fixtures', () => {
  let fixtureDataset: GoldenDataset;

  // -- DB setup for runner integration tests (same pattern as runner.test.ts) --
  const testDir = join(tmpdir(), `ctx-fixture-test-${Date.now()}`);
  const testDbPath = join(testDir, 'test.db');
  let db: Database.Database;
  let ops: DatabaseOperations;
  let testProjectId: string;

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

  const defaultEvalConfig: EvalConfig = {
    golden_path: '~/.ctx/eval',
    default_k: 5,
    thresholds: { mrr: 0.7, hit_rate: 0.85, precision_at_k: 0.6 },
    python_path: 'python3',
    ragas_model: 'gpt-4o-mini',
  };

  beforeAll(() => {
    // Load and validate golden.json
    const raw = readFileSync(GOLDEN_PATH, 'utf-8');
    fixtureDataset = GoldenDatasetSchema.parse(JSON.parse(raw));

    // Set up temp DB for runner integration tests
    mkdirSync(testDir, { recursive: true });
    db = new Database(testDbPath);
    db.pragma('foreign_keys = ON');
    db.exec(createTablesSql);
    ops = new DatabaseOperations(db);

    testProjectId = `proj-fixture-${Date.now()}`;
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO projects (id, name, path, indexed_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(testProjectId, 'test-project', '/fixtures/test-project', now, now);
  });

  afterAll(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.exec('DELETE FROM eval_results');
    db.exec('DELETE FROM eval_runs');
  });

  // ============================================================================
  // GOLDEN.JSON VALIDATION
  // ============================================================================

  describe('golden.json validation', () => {
    it('golden.json exists at expected path', () => {
      expect(existsSync(GOLDEN_PATH)).toBe(true);
    });

    it('passes GoldenDatasetSchema validation', () => {
      expect(fixtureDataset.version).toBe('1.0');
      expect(fixtureDataset.projectName).toBe('test-project');
    });

    it('has 5-10 entries', () => {
      expect(fixtureDataset.entries.length).toBeGreaterThanOrEqual(5);
      expect(fixtureDataset.entries.length).toBeLessThanOrEqual(10);
    });

    it('all entries have unique IDs', () => {
      const ids = fixtureDataset.entries.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('all entries have at least one of expectedFilePaths or expectedAnswer', () => {
      for (const entry of fixtureDataset.entries) {
        const hasFiles = entry.expectedFilePaths && entry.expectedFilePaths.length > 0;
        const hasAnswer = !!entry.expectedAnswer;
        expect(
          hasFiles || hasAnswer,
          `Entry "${entry.query}" has neither expectedFilePaths nor expectedAnswer`,
        ).toBe(true);
      }
    });

    it('all expectedFilePaths point to existing files in test-project/', () => {
      for (const entry of fixtureDataset.entries) {
        if (entry.expectedFilePaths) {
          for (const filePath of entry.expectedFilePaths) {
            const fullPath = join(TEST_PROJECT_DIR, filePath);
            expect(
              existsSync(fullPath),
              `Expected file not found: ${filePath} (from entry "${entry.query}")`,
            ).toBe(true);
          }
        }
      }
    });

    it('entries cover at least 3 distinct tags', () => {
      const allTags = new Set(fixtureDataset.entries.flatMap((e) => e.tags ?? []));
      expect(allTags.size).toBeGreaterThanOrEqual(3);
    });

    it('includes entries with multiple expectedFilePaths for recall testing', () => {
      const multiFileEntries = fixtureDataset.entries.filter(
        (e) => e.expectedFilePaths && e.expectedFilePaths.length > 1,
      );
      expect(multiFileEntries.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================================================
  // TEST-PROJECT VALIDATION
  // ============================================================================

  describe('test-project structure', () => {
    it('test-project directory exists', () => {
      expect(existsSync(TEST_PROJECT_DIR)).toBe(true);
    });

    it('contains approximately 10 files', () => {
      const files = collectFiles(TEST_PROJECT_DIR);
      expect(files.length).toBeGreaterThanOrEqual(8);
      expect(files.length).toBeLessThanOrEqual(15);
    });

    it('contains TypeScript files', () => {
      const files = collectFiles(TEST_PROJECT_DIR);
      const tsFiles = files.filter((f) => f.endsWith('.ts'));
      expect(tsFiles.length).toBeGreaterThanOrEqual(1);
    });

    it('contains a README.md', () => {
      expect(existsSync(join(TEST_PROJECT_DIR, 'README.md'))).toBe(true);
    });

    it('contains a package.json', () => {
      expect(existsSync(join(TEST_PROJECT_DIR, 'package.json'))).toBe(true);
    });
  });

  // ============================================================================
  // RUNNER INTEGRATION
  // ============================================================================

  describe('fixture integration with eval runner', () => {
    /** Build a mock search that returns perfect results for fixture entries */
    function buildPerfectSearch(): (query: string, topK: number) => Promise<EvalSearchResult> {
      const searchMap: Record<string, string[]> = {};
      for (const entry of fixtureDataset.entries) {
        if (entry.expectedFilePaths && entry.expectedFilePaths.length > 0) {
          searchMap[entry.query] = entry.expectedFilePaths;
        }
      }

      return async (query: string, _topK: number) => ({
        filePaths: searchMap[query] ?? [],
        latencyMs: 10,
      });
    }

    /** Build EvalRunnerDeps with perfect mock search and fixture dataset */
    function buildDeps(overrides: Partial<EvalRunnerDeps> = {}): EvalRunnerDeps {
      return {
        search: buildPerfectSearch(),
        db: ops,
        loadGoldenDataset: () => fixtureDataset,
        projectId: testProjectId,
        evalConfig: defaultEvalConfig,
        ...overrides,
      };
    }

    it('runs eval with fixture golden.json and perfect mock search', async () => {
      const deps = buildDeps();
      const summary = await runEval({ projectName: 'test-project' }, deps);

      expect(summary.project_name).toBe('test-project');
      // Entries with expectedFilePaths (at least 7 of 8 have file paths)
      expect(summary.query_count).toBeGreaterThanOrEqual(7);
      expect(summary.run_id).toBeDefined();
      expect(summary.timestamp).toBeDefined();
    });

    it('achieves perfect metrics with perfect search', async () => {
      const deps = buildDeps();
      const summary = await runEval({ projectName: 'test-project' }, deps);

      // Perfect mock search should yield perfect retrieval metrics
      expect(summary.metrics.mrr).toBe(1.0);
      expect(summary.metrics.hit_rate).toBe(1.0);
      expect(summary.metrics.recall_at_k).toBe(1.0);
      expect(summary.metrics.precision_at_k).toBeGreaterThan(0);
    });

    it('stores results in database', async () => {
      const deps = buildDeps();
      const summary = await runEval({ projectName: 'test-project' }, deps);

      const results = ops.getEvalResults(summary.run_id);
      expect(results.length).toBe(summary.query_count);

      // All queries should pass with perfect search
      const passedCount = results.filter((r) => r.passed).length;
      expect(passedCount).toBe(summary.query_count);
    });

    it('tag filtering returns correct subset', async () => {
      const deps = buildDeps();

      // Run only 'auth' tagged entries
      const summary = await runEval(
        { projectName: 'test-project', tags: ['auth'] },
        deps,
      );

      const authEntries = fixtureDataset.entries.filter(
        (e) => e.tags?.includes('auth') && e.expectedFilePaths && e.expectedFilePaths.length > 0,
      );
      expect(summary.query_count).toBe(authEntries.length);
    });

    it('tag filtering with database tag returns correct subset', async () => {
      const deps = buildDeps();

      const summary = await runEval(
        { projectName: 'test-project', tags: ['database'] },
        deps,
      );

      const dbEntries = fixtureDataset.entries.filter(
        (e) => e.tags?.includes('database') && e.expectedFilePaths && e.expectedFilePaths.length > 0,
      );
      expect(summary.query_count).toBe(dbEntries.length);
    });
  });
});
