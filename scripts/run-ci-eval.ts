/**
 * CI Eval Runner (Ticket #125)
 *
 * Runs the eval pipeline against the fixture golden dataset with a mock
 * search function. Outputs EvalRunOutputJSON-compatible JSON to stdout
 * for piping to scripts/check-eval-thresholds.js.
 *
 * No API keys, no RAG engine, no indexed project required.
 *
 * Usage:
 *   pnpm tsx scripts/run-ci-eval.ts > eval-results.json
 *   node scripts/check-eval-thresholds.js eval-results.json
 *
 * Or piped:
 *   pnpm tsx scripts/run-ci-eval.ts | node scripts/check-eval-thresholds.js
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import { GoldenDatasetSchema } from '../src/eval/golden.js';
import { DatabaseOperations } from '../src/database/operations.js';
import { runEval, type EvalRunnerDeps, type EvalSearchResult } from '../src/eval/runner.js';
import type { EvalConfig, GoldenDataset } from '../src/eval/types.js';

// ============================================================================
// Constants
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURES_DIR = resolve(__dirname, '../fixtures/eval');
const GOLDEN_PATH = join(FIXTURES_DIR, 'golden.json');

/**
 * Minimal SQLite schema for eval tables.
 *
 * Same tables used in fixtures.test.ts — only the three tables
 * that runEval() actually reads/writes: projects, eval_runs, eval_results.
 */
const CREATE_TABLES_SQL = `
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

/**
 * CI eval config with thresholds matching check-eval-thresholds.js defaults.
 *
 * These are intentionally lower than the project config defaults
 * (config: MRR 0.7, Hit Rate 0.85, P@K 0.6) to serve as a minimum
 * quality floor in CI.
 *
 * default_k is set to 2 (not the project default of 5) because the
 * fixture golden entries have 1-2 expectedFilePaths each. With k=5,
 * precision@K would be artificially low (0.2-0.4) even with perfect
 * search, since precision = (relevant in top-k) / k.
 */
const CI_EVAL_CONFIG: EvalConfig = {
  golden_path: '~/.ctx/eval',
  default_k: 2,
  thresholds: { mrr: 0.6, hit_rate: 0.8, precision_at_k: 0.5 },
  python_path: 'python3',
  ragas_model: 'gpt-4o-mini',
};

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  // Step 1: Load and validate the fixture golden dataset
  if (!existsSync(GOLDEN_PATH)) {
    throw new Error(
      `Fixture golden dataset not found at ${GOLDEN_PATH}. ` +
      'Ensure fixtures/eval/golden.json exists (created by ticket #127).',
    );
  }

  const raw = readFileSync(GOLDEN_PATH, 'utf-8');
  const dataset: GoldenDataset = GoldenDatasetSchema.parse(JSON.parse(raw));

  // Warn about duplicate queries (later entries silently overwrite in searchMap)
  const seen = new Set<string>();
  for (const entry of dataset.entries) {
    if (seen.has(entry.query)) {
      console.warn(`Warning: duplicate query in golden.json: "${entry.query}"`);
    }
    seen.add(entry.query);
  }

  // Step 2: Set up temporary SQLite database
  const testDir = join(tmpdir(), `ctx-ci-eval-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  const dbPath = join(testDir, 'ci-eval.db');
  const db = new Database(dbPath);

  try {
    db.pragma('foreign_keys = ON');
    db.exec(CREATE_TABLES_SQL);

    const ops = new DatabaseOperations(db);

    // Insert a fake project record (runEval stores eval_run records against it)
    const projectId = `ci-eval-${Date.now()}`;
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO projects (id, name, path, indexed_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(projectId, 'test-project', '/fixtures/test-project', now, now);

    // Step 3: Build "perfect search" mock
    // Maps each golden query to its expectedFilePaths — simulates a RAG
    // engine that always returns the correct files in the right order.
    const searchMap: Record<string, string[]> = {};
    for (const entry of dataset.entries) {
      if (entry.expectedFilePaths && entry.expectedFilePaths.length > 0) {
        searchMap[entry.query] = entry.expectedFilePaths;
      }
    }

    const search = async (query: string, _topK: number): Promise<EvalSearchResult> => ({
      filePaths: searchMap[query] ?? [],
      latencyMs: 5,
    });

    // Step 4: Construct runner dependencies and run eval
    const deps: EvalRunnerDeps = {
      search,
      db: ops,
      loadGoldenDataset: () => dataset,
      projectId,
      evalConfig: CI_EVAL_CONFIG,
    };

    const summary = await runEval({ projectName: 'test-project' }, deps);

    // Step 5: Build EvalRunOutputJSON-compatible output
    // Shape must match src/cli/commands/eval.ts:73-85 so that
    // check-eval-thresholds.js can validate the metrics field.
    const allPassed = summary.metrics.mrr >= CI_EVAL_CONFIG.thresholds.mrr
      && summary.metrics.hit_rate >= CI_EVAL_CONFIG.thresholds.hit_rate
      && summary.metrics.precision_at_k >= CI_EVAL_CONFIG.thresholds.precision_at_k;

    const output = {
      run_id: summary.run_id,
      project_name: summary.project_name,
      timestamp: summary.timestamp,
      query_count: summary.query_count,
      metrics: summary.metrics,
      thresholds: CI_EVAL_CONFIG.thresholds,
      passed: allPassed,
      comparison: summary.comparison ?? null,
      regressions: [],
      improvements: [],
      ragas: null,
    };

    console.log(JSON.stringify(output, null, 2));
  } finally {
    // Guaranteed cleanup even if runEval() throws
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`CI eval failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
