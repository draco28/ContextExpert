/**
 * E2E Eval Workflow Tests (Ticket #128)
 *
 * Tests the complete evaluation cycle end-to-end:
 * 1. Index a test fixture project
 * 2. Create a golden dataset on disk
 * 3. Run evaluation with the runner
 * 4. Verify eval_run/eval_results in SQLite
 * 5. Verify retrieval metrics
 * 6. Generate trend report
 * 7. Export to RAGAS format
 * 8. Clean up
 *
 * Mocking Strategy:
 * - Paths: Redirected to temp directories (isolated from ~/.ctx)
 * - Embeddings: Deterministic hash-based (fast, reproducible)
 * - LLM: Scripted responses (prevent accidental API calls)
 * - Search: Mock via dependency injection (deterministic metrics)
 * - Database: Real SQLite (tests actual storage logic)
 * - Golden Dataset: Real filesystem I/O (tests actual file loading)
 * - homedir: Redirected so golden.ts writes to temp dir
 *
 * Pattern: Follows src/__tests__/e2e/workflow.test.ts
 */

import { mkdirSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// ============================================================================
// Mocks (MUST be before imports that use them)
// ============================================================================

// Store test root for cleanup - set in vi.mock factory
declare global {
  // eslint-disable-next-line no-var
  var __e2eTestRoot: string;
  // eslint-disable-next-line no-var
  var __e2eDataDir: string;
  // eslint-disable-next-line no-var
  var __e2eDbPath: string;
}

/**
 * Mock paths module to isolate tests from ~/.ctx
 *
 * Identical to workflow.test.ts — redirects all path constants
 * to a temp directory for full filesystem isolation.
 */
vi.mock('../../config/paths.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os');

  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-eval-e2e-'));
  const dataDir = path.join(testRoot, 'data');
  const configDir = path.join(testRoot, 'config');

  globalThis.__e2eTestRoot = testRoot;
  globalThis.__e2eDataDir = dataDir;
  globalThis.__e2eDbPath = path.join(dataDir, 'context.db');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });

  return {
    CTX_DIR: dataDir,
    DB_PATH: path.join(dataDir, 'context.db'),
    CONFIG_PATH: path.join(configDir, 'config.toml'),
    PROVIDERS_PATH: path.join(configDir, 'providers.json'),
    getCtxDir: () => dataDir,
    getDbPath: () => path.join(dataDir, 'context.db'),
    getConfigPath: () => path.join(configDir, 'config.toml'),
    getProvidersPath: () => path.join(configDir, 'providers.json'),
  };
});

/**
 * Mock node:os to redirect homedir() to our temp directory.
 *
 * This is the KEY ADDITION over workflow.test.ts. The golden dataset
 * module (src/eval/golden.ts) uses homedir() to construct the path
 * ~/.ctx/eval/<project>/golden.json. By redirecting homedir, golden
 * dataset files land inside our isolated test filesystem.
 *
 * The homedir function reads globalThis.__e2eTestRoot lazily at call
 * time (not at mock definition time), so it works correctly even though
 * __e2eTestRoot is set by the paths mock factory above.
 */
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return {
    ...original,
    homedir: () => globalThis.__e2eTestRoot,
  };
});

/**
 * Mock embedding provider for deterministic hash-based embeddings.
 * Same as workflow.test.ts.
 */
vi.mock('../../indexer/embedder/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../indexer/embedder/index.js')>();
  return {
    ...original,
    createEmbeddingProvider: vi.fn(),
    embedChunks: vi.fn(),
  };
});

vi.mock('../../indexer/embedder/provider.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../indexer/embedder/provider.js')>();
  return {
    ...original,
    createEmbeddingProvider: vi.fn(),
  };
});

/**
 * Mock LLM provider to prevent accidental API calls.
 * Eval runner only does search (not ask), but kept for safety.
 */
vi.mock('../../providers/llm.js', () => ({
  createLLMProvider: vi.fn(),
}));

/**
 * Mock config loader with test-friendly settings.
 */
vi.mock('../../config/loader.js', () => ({
  loadConfig: () => ({
    default_model: 'mock-model',
    default_provider: 'mock',
    embedding: {
      provider: 'huggingface',
      model: 'BAAI/bge-large-en-v1.5',
      fallback_provider: 'ollama',
      fallback_model: 'mxbai-embed-large',
      batch_size: 32,
      timeout_ms: 120000,
    },
    search: {
      top_k: 10,
      rerank: false,
    },
  }),
}));

/**
 * Mock ora spinner to prevent terminal output during tests.
 */
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { runMigrations, resetDatabase, closeDb } from '../../database/index.js';
import { DatabaseOperations } from '../../database/operations.js';
import { resetVectorStoreManager } from '../../search/store.js';
import { resetBM25StoreManager } from '../../search/bm25-store.js';
import * as embedder from '../../indexer/embedder/index.js';
import * as embedderProvider from '../../indexer/embedder/provider.js';
import * as llmProvider from '../../providers/llm.js';
import { createIndexCommand } from '../../cli/commands/index.js';
import type { CommandContext } from '../../cli/types.js';

// Eval modules
import { runEval, type EvalRunnerDeps, type EvalSearchResult } from '../../eval/runner.js';
import { saveGoldenDataset, loadGoldenDataset } from '../../eval/golden.js';
import { computeTrend, formatTrendReport } from '../../eval/aggregator.js';
import { exportToRagas, writeExport, type ExportSourceEntry } from '../../eval/exporter.js';
import type { GoldenDataset, GoldenEntry, RetrievalMetrics, EvalConfig } from '../../eval/types.js';

// Setup helpers
import {
  createSampleProject,
  createMockEmbeddingProvider,
  getProjectFromDb,
  countChunksInDb,
  DEFAULT_SAMPLE_FILES,
  createMockLLMProvider,
  DEFAULT_MOCK_RESPONSES,
} from './setup.js';

// ============================================================================
// Test Constants
// ============================================================================

const PROJECT_NAME = 'eval-e2e-project';

/**
 * Golden dataset entries referencing DEFAULT_SAMPLE_FILES paths.
 *
 * Each entry maps a natural language query to the expected source file.
 * These match the sample project's auth.ts, token.ts, and types.ts files.
 */
const GOLDEN_ENTRIES: Omit<GoldenEntry, 'id'>[] = [
  {
    query: 'How does authentication work?',
    expectedFilePaths: ['src/auth.ts'],
    source: 'manual',
    tags: ['auth'],
  },
  {
    query: 'How is token validation implemented?',
    expectedFilePaths: ['src/token.ts'],
    source: 'manual',
    tags: ['auth'],
  },
  {
    query: 'What interfaces are defined for users?',
    expectedFilePaths: ['src/types.ts'],
    source: 'manual',
    tags: ['types'],
  },
];

/**
 * Mock search results: maps each golden query to a ranked list of file paths.
 *
 * The expected file always appears at position 1, guaranteeing:
 * - MRR = 1.0 (first result is always relevant)
 * - Hit Rate = 1.0 (all queries have at least one hit)
 * - Precision varies (extra non-relevant results)
 */
const SEARCH_RESULTS: Record<string, string[]> = {
  'How does authentication work?': ['src/auth.ts', 'src/index.ts', 'src/token.ts'],
  'How is token validation implemented?': ['src/token.ts', 'src/auth.ts'],
  'What interfaces are defined for users?': ['src/types.ts', 'src/auth.ts', 'README.md'],
};

/** Default eval config for the test runner */
const TEST_EVAL_CONFIG: EvalConfig = {
  golden_path: '~/.ctx/eval',
  default_k: 5,
  thresholds: { mrr: 0.7, hit_rate: 0.85, precision_at_k: 0.6 },
  python_path: 'python3',
  ragas_model: 'gpt-4o-mini',
};

// ============================================================================
// Test Utilities
// ============================================================================

function getTestRoot(): string {
  return globalThis.__e2eTestRoot;
}

function resetAll(): void {
  resetVectorStoreManager();
  resetBM25StoreManager();
  resetDatabase();
  closeDb();
}

function createMockContext(options: { verbose?: boolean; json?: boolean } = {}): CommandContext {
  return {
    options: {
      verbose: options.verbose ?? false,
      json: options.json ?? false,
    },
    log: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function setupEmbedderMock(): void {
  const mockProvider = createMockEmbeddingProvider(1024);
  const mockResult = {
    provider: mockProvider,
    model: 'mock-model',
    dimensions: 1024,
  };

  vi.mocked(embedder.createEmbeddingProvider).mockResolvedValue(mockResult);
  vi.mocked(embedderProvider.createEmbeddingProvider).mockResolvedValue(mockResult);

  vi.mocked(embedder.embedChunks).mockImplementation(async (chunks, _provider, _options) => {
    const results = await mockProvider.embedBatch(chunks.map((c) => c.content));
    return chunks.map((chunk, i) => ({
      ...chunk,
      embedding: results[i]!.embedding,
    }));
  });
}

function setupLLMMock(): void {
  const mockLLM = createMockLLMProvider({
    responses: DEFAULT_MOCK_RESPONSES,
    defaultResponse: 'I could not find relevant information in the provided context.',
  });

  vi.mocked(llmProvider.createLLMProvider).mockResolvedValue({
    provider: mockLLM,
    name: 'anthropic',
    model: 'claude-sonnet-4-20250514',
  });
}

async function runIndexCommand(
  args: string[],
  ctx: CommandContext = createMockContext()
): Promise<void> {
  const { Command } = await import('commander');
  const cmd = createIndexCommand(() => ctx);
  const program = new Command();
  program.addCommand(cmd);
  program.exitOverride();
  await program.parseAsync(['node', 'test', 'index', ...args]);
}

/**
 * Build a mock search function that returns known file paths per query.
 *
 * This is the dependency injection pattern from runner.test.ts.
 * By controlling search results, we get deterministic, verifiable metrics.
 */
function makeSearch(
  resultMap: Record<string, string[]>,
  latencyMs = 25,
): (query: string, topK: number) => Promise<EvalSearchResult> {
  return async (query: string, _topK: number) => ({
    filePaths: resultMap[query] ?? [],
    latencyMs,
  });
}

// ============================================================================
// Test Suites
// ============================================================================

describe('E2E Eval Workflow Tests', () => {
  let testProjectDir: string;
  let projectId: string;
  let ops: DatabaseOperations;
  let evalSummary: Awaited<ReturnType<typeof runEval>>;

  // ──────────────────────────────────────────────────────────────────────────
  // Setup: Run ONCE before all tests
  // ──────────────────────────────────────────────────────────────────────────

  beforeAll(async () => {
    // 1. Create sample project in temp directory
    testProjectDir = join(getTestRoot(), 'sample-project');
    mkdirSync(testProjectDir, { recursive: true });
    createSampleProject(testProjectDir, DEFAULT_SAMPLE_FILES);

    // 2. Run database migrations (creates all tables including eval_*)
    runMigrations();

    // 3. Setup mocks
    setupEmbedderMock();
    setupLLMMock();

    // 4. Index the sample project (like a user running: ctx index ./sample-project --name eval-e2e-project)
    await runIndexCommand([testProjectDir, '--name', PROJECT_NAME]);

    // 5. Get project ID from database
    const db = new Database(globalThis.__e2eDbPath);
    try {
      const project = getProjectFromDb(db, PROJECT_NAME);
      expect(project).toBeDefined();
      projectId = project!.id;
    } finally {
      db.close();
    }

    // 6. Create and save golden dataset to temp filesystem
    //    saveGoldenDataset uses homedir() which is mocked to __e2eTestRoot
    //    so it writes to <testRoot>/.ctx/eval/eval-e2e-project/golden.json
    const goldenDataset: GoldenDataset = {
      version: '1.0',
      projectName: PROJECT_NAME,
      entries: GOLDEN_ENTRIES.map((entry, i) => ({
        id: `golden-${i + 1}`,
        ...entry,
      })),
    };
    saveGoldenDataset(goldenDataset);

    // 7. Build eval runner deps with mock search + real DB + real golden loader
    const evalDb = new Database(globalThis.__e2eDbPath);
    ops = new DatabaseOperations(evalDb);

    const deps: EvalRunnerDeps = {
      search: makeSearch(SEARCH_RESULTS),
      db: ops,
      loadGoldenDataset: (name: string) => loadGoldenDataset(name),
      projectId,
      evalConfig: TEST_EVAL_CONFIG,
    };

    // 8. Run evaluation — the core pipeline under test
    evalSummary = await runEval({ projectName: PROJECT_NAME }, deps);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Cleanup: Run ONCE after all tests
  // ──────────────────────────────────────────────────────────────────────────

  afterAll(() => {
    resetAll();

    try {
      rmSync(getTestRoot(), { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    delete (globalThis as Record<string, unknown>).__e2eTestRoot;
    delete (globalThis as Record<string, unknown>).__e2eDataDir;
    delete (globalThis as Record<string, unknown>).__e2eDbPath;
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Reset: Run before EACH test
  // ──────────────────────────────────────────────────────────────────────────

  beforeEach(() => {
    vi.clearAllMocks();
    setupEmbedderMock();
    setupLLMMock();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Suite 1: Index Verification (Sanity Check)
  // ══════════════════════════════════════════════════════════════════════════

  describe('Index Verification', () => {
    it('indexed project exists in database with chunks', () => {
      const db = new Database(globalThis.__e2eDbPath);

      try {
        const project = getProjectFromDb(db, PROJECT_NAME);

        expect(project).toBeDefined();
        expect(project!.name).toBe(PROJECT_NAME);
        expect(realpathSync(project!.path)).toBe(realpathSync(testProjectDir));
        expect(project!.file_count).toBe(DEFAULT_SAMPLE_FILES.length);

        const chunkCount = countChunksInDb(db, project!.id);
        expect(chunkCount).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Suite 2: Eval Run
  // ══════════════════════════════════════════════════════════════════════════

  describe('Eval Run', () => {
    it('returns valid summary with correct fields', () => {
      expect(evalSummary.run_id).toBeDefined();
      expect(evalSummary.project_name).toBe(PROJECT_NAME);
      expect(evalSummary.timestamp).toBeDefined();
      expect(evalSummary.query_count).toBe(3);
      expect(evalSummary.config).toEqual({
        top_k: 5,
        include_generation: false,
        tags: [],
      });
    });

    it('has no comparison on first run', () => {
      expect(evalSummary.comparison).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Suite 3: Database Verification
  // ══════════════════════════════════════════════════════════════════════════

  describe('Database Verification', () => {
    it('eval_run record exists with correct fields', () => {
      const run = ops.getEvalRun(evalSummary.run_id);

      expect(run).toBeDefined();
      expect(run!.project_id).toBe(projectId);
      expect(run!.dataset_version).toBe('1.0');
      expect(run!.query_count).toBe(3);
      expect(run!.notes).toContain('status:completed');

      // Metrics is valid JSON with all 6 metric fields
      const metrics = JSON.parse(run!.metrics);
      expect(metrics).toHaveProperty('mrr');
      expect(metrics).toHaveProperty('precision_at_k');
      expect(metrics).toHaveProperty('recall_at_k');
      expect(metrics).toHaveProperty('hit_rate');
      expect(metrics).toHaveProperty('ndcg');
      expect(metrics).toHaveProperty('map');

      // Config is valid JSON
      const config = JSON.parse(run!.config);
      expect(config).toHaveProperty('top_k', 5);
    });

    it('eval_results records exist with correct per-query data', () => {
      const results = ops.getEvalResults(evalSummary.run_id);

      expect(results).toHaveLength(3);

      for (const result of results) {
        expect(result.eval_run_id).toBe(evalSummary.run_id);
        expect(result.query).toBeDefined();
        expect(result.latency_ms).toBeGreaterThanOrEqual(0);

        // expected_files and retrieved_files are valid JSON arrays
        const expected = JSON.parse(result.expected_files);
        expect(Array.isArray(expected)).toBe(true);
        expect(expected.length).toBeGreaterThan(0);

        const retrieved = JSON.parse(result.retrieved_files);
        expect(Array.isArray(retrieved)).toBe(true);

        // metrics is valid JSON with per-query fields
        const metrics = JSON.parse(result.metrics);
        expect(metrics).toHaveProperty('reciprocal_rank');
        expect(metrics).toHaveProperty('precision_at_k');
        expect(metrics).toHaveProperty('recall_at_k');
        expect(metrics).toHaveProperty('hit_rate');

        // passed is boolean (Zod coerces SQLite integer)
        expect(typeof result.passed).toBe('boolean');
      }
    });

    it('all queries passed (hit_rate=1 for all)', () => {
      const results = ops.getEvalResults(evalSummary.run_id);
      const passedCount = results.filter((r) => r.passed).length;

      expect(passedCount).toBe(3);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Suite 4: Metrics Verification
  // ══════════════════════════════════════════════════════════════════════════

  describe('Metrics Verification', () => {
    it('aggregate metrics are all numbers in [0,1]', () => {
      const metricKeys: (keyof RetrievalMetrics)[] = [
        'mrr', 'precision_at_k', 'recall_at_k', 'hit_rate', 'ndcg', 'map',
      ];

      for (const key of metricKeys) {
        const value = evalSummary.metrics[key];
        expect(typeof value).toBe('number');
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    });

    it('metrics are not all zeros (search returned relevant results)', () => {
      expect(evalSummary.metrics.mrr).toBeGreaterThan(0);
      expect(evalSummary.metrics.hit_rate).toBeGreaterThan(0);
      expect(evalSummary.metrics.recall_at_k).toBeGreaterThan(0);
      expect(evalSummary.metrics.ndcg).toBeGreaterThan(0);
      expect(evalSummary.metrics.map).toBeGreaterThan(0);
    });

    it('MRR is 1.0 when first result is always relevant', () => {
      // Mock search returns the expected file at position 1 for all queries
      expect(evalSummary.metrics.mrr).toBe(1.0);
    });

    it('hit rate is 1.0 when all queries have relevant results', () => {
      expect(evalSummary.metrics.hit_rate).toBe(1.0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Suite 5: Trend Report
  // ══════════════════════════════════════════════════════════════════════════

  describe('Trend Report', () => {
    it('computeTrend with single run returns stable trends', () => {
      const runs = ops.getEvalRuns(projectId, 10);
      expect(runs.length).toBeGreaterThanOrEqual(1);

      const trend = computeTrend(runs);

      expect(trend.projectId).toBe(projectId);
      expect(trend.runCount).toBe(runs.length);
      expect(trend.currentRunId).toBe(evalSummary.run_id);
      expect(trend.trends).toHaveLength(6); // one per metric
      expect(trend.hasRegressions).toBe(false); // first run, no comparison
    });

    it('formatTrendReport returns non-empty string with metric names', () => {
      const runs = ops.getEvalRuns(projectId, 10);
      const trend = computeTrend(runs);
      const report = formatTrendReport(trend);

      expect(report.length).toBeGreaterThan(0);
      expect(report).toContain('Eval Trend Report');
      expect(report).toContain('MRR');
      expect(report).toContain('Precision@K');
      expect(report).toContain('Recall@K');
      expect(report).toContain('Hit Rate');
      expect(report).toContain('NDCG');
      expect(report).toContain('MAP');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Suite 6: RAGAS Export
  // ══════════════════════════════════════════════════════════════════════════

  describe('RAGAS Export', () => {
    it('exportToRagas produces valid entries from golden + eval results', () => {
      const goldenDataset = loadGoldenDataset(PROJECT_NAME);
      const evalResults = ops.getEvalResults(evalSummary.run_id);

      const exportEntries: ExportSourceEntry[] = goldenDataset.entries.map((golden) => {
        const result = evalResults.find((r) => r.query === golden.query);
        return { golden, evalResult: result };
      });

      const ragasData = exportToRagas(exportEntries);

      expect(ragasData).toHaveLength(3);

      for (const entry of ragasData) {
        expect(entry).toHaveProperty('question');
        expect(entry).toHaveProperty('answer');
        expect(entry).toHaveProperty('contexts');
        expect(entry).toHaveProperty('ground_truths');
        expect(typeof entry.question).toBe('string');
        expect(entry.question.length).toBeGreaterThan(0);
        expect(Array.isArray(entry.contexts)).toBe(true);
        expect(Array.isArray(entry.ground_truths)).toBe(true);
        expect(entry.ground_truths.length).toBeGreaterThan(0);
      }
    });

    it('writeExport creates valid JSON file on disk', () => {
      const exportPath = join(getTestRoot(), 'exports', 'ragas_output.json');

      const goldenDataset = loadGoldenDataset(PROJECT_NAME);
      const evalResults = ops.getEvalResults(evalSummary.run_id);

      const exportEntries: ExportSourceEntry[] = goldenDataset.entries.map((golden) => {
        const result = evalResults.find((r) => r.query === golden.query);
        return { golden, evalResult: result };
      });

      const ragasData = exportToRagas(exportEntries);
      writeExport(ragasData, exportPath);

      // Verify file exists and is valid JSON
      expect(existsSync(exportPath)).toBe(true);
      const content = readFileSync(exportPath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(3);
      expect(parsed[0]).toHaveProperty('question');
      expect(parsed[0]).toHaveProperty('answer');
      expect(parsed[0]).toHaveProperty('contexts');
      expect(parsed[0]).toHaveProperty('ground_truths');
    });
  });
});
