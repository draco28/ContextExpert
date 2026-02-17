/**
 * Eval Command Tests
 *
 * Tests the parseSince helper function for the ctx eval traces command,
 * the buildMetricRows / formatResultsTable helpers for ctx eval run,
 * and the golden subcommand helpers + integration tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import {
  parseSince,
  buildMetricRows,
  formatResultsTable,
  parseRetrievedFiles,
  parseSelection,
  createEvalCommand,
} from '../eval.js';
import type { CommandContext } from '../../types.js';
import type { EvalRunSummary, EvalRun, RetrievalMetrics } from '../../../eval/types.js';
import * as database from '../../../database/index.js';
import * as golden from '../../../eval/golden.js';
import * as aggregator from '../../../eval/aggregator.js';
import * as fs from 'node:fs';

// ============================================================================
// Module Mocks (for golden subcommand integration tests)
// ============================================================================

vi.mock('../../../database/index.js', () => ({
  runMigrations: vi.fn(),
  getDb: vi.fn(),
  getDatabase: vi.fn(),
}));

vi.mock('../../../eval/golden.js', () => ({
  listGoldenEntries: vi.fn(),
  addGoldenEntry: vi.fn(),
  loadGoldenDataset: vi.fn(),
}));

vi.mock('../../../eval/aggregator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../eval/aggregator.js')>();
  return {
    ...actual,
    computeTrend: vi.fn(),
    formatTrendReport: vi.fn(),
  };
});

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

// ============================================================================
// parseSince Tests (existing)
// ============================================================================

describe('parseSince', () => {
  // Fix the current date for deterministic tests
  const NOW = new Date('2026-02-15T12:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses day format (7d)', () => {
    const result = parseSince('7d');
    const expected = new Date('2026-02-08T12:00:00.000Z');
    expect(new Date(result).toISOString()).toBe(expected.toISOString());
  });

  it('parses hour format (24h)', () => {
    const result = parseSince('24h');
    const expected = new Date('2026-02-14T12:00:00.000Z');
    expect(new Date(result).toISOString()).toBe(expected.toISOString());
  });

  it('parses week format (2w)', () => {
    const result = parseSince('2w');
    const expected = new Date('2026-02-01T12:00:00.000Z');
    expect(new Date(result).toISOString()).toBe(expected.toISOString());
  });

  it('parses single day (1d)', () => {
    const result = parseSince('1d');
    const expected = new Date('2026-02-14T12:00:00.000Z');
    expect(new Date(result).toISOString()).toBe(expected.toISOString());
  });

  it('passes through ISO date strings', () => {
    const isoDate = '2026-01-01T00:00:00.000Z';
    expect(parseSince(isoDate)).toBe(isoDate);
  });

  it('passes through partial date strings', () => {
    const dateStr = '2026-01-15';
    expect(parseSince(dateStr)).toBe(dateStr);
  });
});

// ============================================================================
// buildMetricRows Tests
// ============================================================================

describe('buildMetricRows', () => {
  const metrics: RetrievalMetrics = {
    mrr: 0.85,
    precision_at_k: 0.65,
    recall_at_k: 0.72,
    hit_rate: 0.90,
    ndcg: 0.78,
    map: 0.74,
  };

  const thresholds = {
    mrr: 0.7,
    hit_rate: 0.85,
    precision_at_k: 0.6,
  };

  it('creates 6 metric rows in correct order', () => {
    const rows = buildMetricRows(metrics, thresholds);

    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.name)).toEqual([
      'MRR', 'Hit Rate', 'Precision@K', 'Recall@K', 'NDCG', 'MAP',
    ]);
  });

  it('marks threshold metrics as passed when above threshold', () => {
    const rows = buildMetricRows(metrics, thresholds);

    // MRR: 0.85 >= 0.7 → PASS
    expect(rows[0]!.passed).toBe(true);
    // Hit Rate: 0.90 >= 0.85 → PASS
    expect(rows[1]!.passed).toBe(true);
    // Precision@K: 0.65 >= 0.6 → PASS
    expect(rows[2]!.passed).toBe(true);
  });

  it('marks threshold metrics as failed when below threshold', () => {
    const lowMetrics: RetrievalMetrics = {
      ...metrics,
      mrr: 0.5,
      hit_rate: 0.4,
    };

    const rows = buildMetricRows(lowMetrics, thresholds);

    expect(rows[0]!.passed).toBe(false); // MRR: 0.5 < 0.7
    expect(rows[1]!.passed).toBe(false); // Hit Rate: 0.4 < 0.85
  });

  it('sets target and passed to null for non-threshold metrics', () => {
    const rows = buildMetricRows(metrics, thresholds);

    // Recall@K, NDCG, MAP have no thresholds
    expect(rows[3]!.target).toBeNull();
    expect(rows[3]!.passed).toBeNull();
    expect(rows[4]!.target).toBeNull();
    expect(rows[4]!.passed).toBeNull();
    expect(rows[5]!.target).toBeNull();
    expect(rows[5]!.passed).toBeNull();
  });

  it('does not set delta/direction when no comparison', () => {
    const rows = buildMetricRows(metrics, thresholds);

    for (const row of rows) {
      expect(row.delta).toBeUndefined();
      expect(row.direction).toBeUndefined();
    }
  });

  it('adds trend data from comparison', () => {
    const comparison: EvalRunSummary['comparison'] = {
      previous_run_id: 'prev-123',
      metric_changes: {
        mrr: 0.08,           // improvement (> 0.05)
        hit_rate: -0.02,     // stable
        precision_at_k: -0.07, // regression (< -0.05)
        recall_at_k: 0.03,  // stable
        ndcg: 0.12,         // improvement
        map: -0.01,         // stable
      },
    };

    const rows = buildMetricRows(metrics, thresholds, comparison);

    // MRR: +0.08 → up
    expect(rows[0]!.delta).toBe(0.08);
    expect(rows[0]!.direction).toBe('up');

    // Hit Rate: -0.02 → stable
    expect(rows[1]!.delta).toBe(-0.02);
    expect(rows[1]!.direction).toBe('stable');

    // Precision@K: -0.07 → down
    expect(rows[2]!.delta).toBe(-0.07);
    expect(rows[2]!.direction).toBe('down');

    // NDCG: +0.12 → up
    expect(rows[4]!.delta).toBe(0.12);
    expect(rows[4]!.direction).toBe('up');
  });

  it('handles exact threshold boundary (0.05) as stable', () => {
    const comparison: EvalRunSummary['comparison'] = {
      previous_run_id: 'prev-123',
      metric_changes: {
        mrr: 0.05,      // exactly threshold → stable
        hit_rate: -0.05, // exactly -threshold → stable
      },
    };

    const rows = buildMetricRows(metrics, thresholds, comparison);

    expect(rows[0]!.direction).toBe('stable');
    expect(rows[1]!.direction).toBe('stable');
  });

  it('handles partial comparison (some metrics missing)', () => {
    const comparison: EvalRunSummary['comparison'] = {
      previous_run_id: 'prev-123',
      metric_changes: {
        mrr: 0.1,
        // Other metrics not provided
      },
    };

    const rows = buildMetricRows(metrics, thresholds, comparison);

    expect(rows[0]!.delta).toBe(0.1);
    expect(rows[0]!.direction).toBe('up');
    // Other metrics should have no delta
    expect(rows[1]!.delta).toBeUndefined();
  });
});

// ============================================================================
// formatResultsTable Tests
// ============================================================================

describe('formatResultsTable', () => {
  const baseSummary: EvalRunSummary = {
    run_id: 'run-abc12345-def6-7890',
    project_name: 'test-project',
    timestamp: '2026-02-15T12:00:00.000Z',
    query_count: 10,
    metrics: {
      mrr: 0.85,
      precision_at_k: 0.65,
      recall_at_k: 0.72,
      hit_rate: 0.90,
      ndcg: 0.78,
      map: 0.74,
    },
    config: { top_k: 5 },
  };

  const thresholds = { mrr: 0.7, hit_rate: 0.85, precision_at_k: 0.6 };

  it('includes project name and query count in header', () => {
    const rows = buildMetricRows(baseSummary.metrics, thresholds);
    const output = formatResultsTable(baseSummary, rows);

    expect(output).toContain('test-project');
    expect(output).toContain('Queries: 10');
  });

  it('includes truncated run ID', () => {
    const rows = buildMetricRows(baseSummary.metrics, thresholds);
    const output = formatResultsTable(baseSummary, rows);

    expect(output).toContain('run-abc1');
  });

  it('shows metric values', () => {
    const rows = buildMetricRows(baseSummary.metrics, thresholds);
    const output = formatResultsTable(baseSummary, rows);

    expect(output).toContain('0.850'); // MRR
    expect(output).toContain('0.900'); // Hit Rate
    expect(output).toContain('0.650'); // Precision@K
  });

  it('shows PASS/FAIL for threshold metrics', () => {
    const rows = buildMetricRows(baseSummary.metrics, thresholds);
    const output = formatResultsTable(baseSummary, rows);

    // All threshold metrics pass in the test data
    // chalk.green('PASS') produces styled text that still contains 'PASS'
    expect(output).toContain('PASS');
  });

  it('shows trend arrows when comparison exists', () => {
    const summaryWithComparison: EvalRunSummary = {
      ...baseSummary,
      comparison: {
        previous_run_id: 'prev-run',
        metric_changes: {
          mrr: 0.08,
          hit_rate: -0.02,
          precision_at_k: -0.07,
          recall_at_k: 0.03,
          ndcg: 0.12,
          map: -0.01,
        },
      },
    };

    const rows = buildMetricRows(
      summaryWithComparison.metrics,
      thresholds,
      summaryWithComparison.comparison,
    );
    const output = formatResultsTable(summaryWithComparison, rows);

    // Should contain trend direction header
    expect(output).toContain('Trend');
    expect(output).toContain('Change');
  });

  it('shows regression/improvement summary when comparison exists', () => {
    const summaryWithComparison: EvalRunSummary = {
      ...baseSummary,
      comparison: {
        previous_run_id: 'prev-run',
        metric_changes: {
          mrr: 0.08,
          precision_at_k: -0.07,
        },
      },
    };

    const rows = buildMetricRows(
      summaryWithComparison.metrics,
      thresholds,
      summaryWithComparison.comparison,
    );
    const output = formatResultsTable(summaryWithComparison, rows);

    expect(output).toContain('Improvements');
    expect(output).toContain('MRR');
    expect(output).toContain('Regressions');
    expect(output).toContain('Precision@K');
  });

  it('shows "All metrics stable" when no regressions or improvements', () => {
    const summaryWithComparison: EvalRunSummary = {
      ...baseSummary,
      comparison: {
        previous_run_id: 'prev-run',
        metric_changes: {
          mrr: 0.01,
          hit_rate: -0.01,
          precision_at_k: 0.02,
          recall_at_k: -0.03,
          ndcg: 0.01,
          map: 0.00,
        },
      },
    };

    const rows = buildMetricRows(
      summaryWithComparison.metrics,
      thresholds,
      summaryWithComparison.comparison,
    );
    const output = formatResultsTable(summaryWithComparison, rows);

    expect(output).toContain('All metrics stable');
  });
});

// ============================================================================
// parseRetrievedFiles Tests
// ============================================================================

describe('parseRetrievedFiles', () => {
  it('parses valid JSON array', () => {
    expect(parseRetrievedFiles('["a.ts","b.ts"]')).toEqual(['a.ts', 'b.ts']);
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseRetrievedFiles('not json')).toEqual([]);
  });

  it('returns empty array for non-array JSON', () => {
    expect(parseRetrievedFiles('{"key": "value"}')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseRetrievedFiles('')).toEqual([]);
  });

  it('handles empty JSON array', () => {
    expect(parseRetrievedFiles('[]')).toEqual([]);
  });
});

// ============================================================================
// parseSelection Tests
// ============================================================================

describe('parseSelection', () => {
  function createMockCtx(): { ctx: CommandContext; warnOutput: string[] } {
    const warnOutput: string[] = [];
    return {
      ctx: {
        options: { verbose: false, json: false },
        log: vi.fn(),
        debug: vi.fn(),
        warn: (msg: string) => warnOutput.push(msg),
        error: vi.fn(),
      },
      warnOutput,
    };
  }

  it('parses valid comma-separated input (1-based → 0-based)', () => {
    const { ctx } = createMockCtx();
    expect(parseSelection('1,2,3', 5, ctx)).toEqual([0, 1, 2]);
  });

  it('warns and excludes out-of-range values', () => {
    const { ctx, warnOutput } = createMockCtx();
    const result = parseSelection('0,6', 5, ctx);
    expect(result).toEqual([]);
    expect(warnOutput).toHaveLength(1);
    expect(warnOutput[0]).toContain('0');
    expect(warnOutput[0]).toContain('6');
  });

  it('warns and excludes non-numeric input', () => {
    const { ctx, warnOutput } = createMockCtx();
    expect(parseSelection('abc', 5, ctx)).toEqual([]);
    expect(warnOutput).toHaveLength(1);
  });

  it('warns and excludes decimal numbers', () => {
    const { ctx, warnOutput } = createMockCtx();
    expect(parseSelection('1.5', 5, ctx)).toEqual([]);
    expect(warnOutput).toHaveLength(1);
  });

  it('returns empty array for empty input', () => {
    const { ctx } = createMockCtx();
    expect(parseSelection('', 5, ctx)).toEqual([]);
  });

  it('handles mixed valid/invalid with warning', () => {
    const { ctx, warnOutput } = createMockCtx();
    const result = parseSelection('1,abc,3', 5, ctx);
    expect(result).toEqual([0, 2]);
    expect(warnOutput).toHaveLength(1);
    expect(warnOutput[0]).toContain('abc');
  });
});

// ============================================================================
// Golden List Subcommand Tests
// ============================================================================

describe('golden list', () => {
  const mockProject = {
    id: 'uuid-123',
    name: 'test-project',
    path: '/tmp/test-project',
    tags: null,
    ignore_patterns: null,
    indexed_at: '2026-01-01T00:00:00.000Z',
    updated_at: null,
    file_count: 10,
    chunk_count: 100,
    config: null,
    embedding_model: 'BAAI/bge-large-en-v1.5',
    embedding_dimensions: 1024,
    description: null,
  };

  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  function createMockCtx(jsonMode = false): { ctx: CommandContext; logOutput: string[] } {
    const logOutput: string[] = [];
    return {
      ctx: {
        options: { verbose: false, json: jsonMode },
        log: (msg: string) => logOutput.push(msg),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      logOutput,
    };
  }

  async function runGoldenList(ctx: CommandContext, args: string[]) {
    const cmd = createEvalCommand(() => ctx);
    const program = new Command();
    program.addCommand(cmd);
    await program.parseAsync(['node', 'test', 'eval', 'golden', 'list', ...args]);
  }

  beforeEach(() => {
    vi.mocked(database.runMigrations).mockReturnValue(undefined);
    vi.mocked(database.getDb).mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(mockProject),
      }),
    } as unknown as ReturnType<typeof database.getDb>);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows helpful message when no entries', async () => {
    vi.mocked(golden.listGoldenEntries).mockReturnValue([]);
    const { ctx, logOutput } = createMockCtx();
    await runGoldenList(ctx, ['--project', 'test-project']);
    expect(logOutput.join('\n')).toContain('No golden entries found');
  });

  it('outputs empty JSON when no entries in JSON mode', async () => {
    vi.mocked(golden.listGoldenEntries).mockReturnValue([]);
    const { ctx } = createMockCtx(true);
    await runGoldenList(ctx, ['--project', 'test-project']);
    const output = JSON.parse(consoleLogSpy.mock.calls[0]![0] as string);
    expect(output).toEqual({ count: 0, entries: [] });
  });

  it('shows table with entries', async () => {
    vi.mocked(golden.listGoldenEntries).mockReturnValue([
      {
        id: 'entry-uuid-1234',
        query: 'How does authentication work?',
        source: 'manual' as const,
        expectedFilePaths: ['auth.ts'],
      },
    ]);
    const { ctx, logOutput } = createMockCtx();
    await runGoldenList(ctx, ['--project', 'test-project']);
    const output = logOutput.join('\n');
    expect(output).toContain('Golden Dataset');
    expect(output).toContain('How does authentication work?');
  });

  it('throws CLIError for non-existent project', async () => {
    vi.mocked(database.getDb).mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(undefined),
      }),
    } as unknown as ReturnType<typeof database.getDb>);
    const { ctx } = createMockCtx();
    await expect(
      runGoldenList(ctx, ['--project', 'nope']),
    ).rejects.toThrow(/Project not found/);
  });
});

// ============================================================================
// Golden Add (Non-Interactive) Subcommand Tests
// ============================================================================

describe('golden add (non-interactive)', () => {
  const mockProject = {
    id: 'uuid-123',
    name: 'test-project',
    path: '/tmp/test-project',
    tags: null,
    ignore_patterns: null,
    indexed_at: '2026-01-01T00:00:00.000Z',
    updated_at: null,
    file_count: 10,
    chunk_count: 100,
    config: null,
    embedding_model: 'BAAI/bge-large-en-v1.5',
    embedding_dimensions: 1024,
    description: null,
  };

  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  function createMockCtx(jsonMode = false): { ctx: CommandContext; logOutput: string[] } {
    const logOutput: string[] = [];
    return {
      ctx: {
        options: { verbose: false, json: jsonMode },
        log: (msg: string) => logOutput.push(msg),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      logOutput,
    };
  }

  async function runGoldenAdd(ctx: CommandContext, args: string[]) {
    const cmd = createEvalCommand(() => ctx);
    const program = new Command();
    program.addCommand(cmd);
    await program.parseAsync(['node', 'test', 'eval', 'golden', 'add', ...args]);
  }

  beforeEach(() => {
    vi.mocked(database.runMigrations).mockReturnValue(undefined);
    vi.mocked(database.getDb).mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(mockProject),
      }),
    } as unknown as ReturnType<typeof database.getDb>);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds entry with --query and --files flags', async () => {
    const createdEntry = {
      id: 'new-uuid-12345678',
      query: 'How does auth work?',
      source: 'manual' as const,
      expectedFilePaths: ['auth.ts', 'login.ts'],
    };
    vi.mocked(golden.addGoldenEntry).mockReturnValue(createdEntry);
    const { ctx, logOutput } = createMockCtx();

    await runGoldenAdd(ctx, [
      '--project', 'test-project',
      '--query', 'How does auth work?',
      '--files', 'auth.ts,login.ts',
    ]);

    expect(golden.addGoldenEntry).toHaveBeenCalledWith('test-project', {
      query: 'How does auth work?',
      expectedFilePaths: ['auth.ts', 'login.ts'],
      expectedAnswer: undefined,
      tags: undefined,
      source: 'manual',
    });
    expect(logOutput.join('\n')).toContain('Entry added');
  });

  it('outputs JSON in JSON mode', async () => {
    const createdEntry = {
      id: 'new-uuid',
      query: 'Q1',
      source: 'manual' as const,
    };
    vi.mocked(golden.addGoldenEntry).mockReturnValue(createdEntry);
    const { ctx } = createMockCtx(true);

    await runGoldenAdd(ctx, [
      '--project', 'test-project',
      '--query', 'Q1',
    ]);

    const output = JSON.parse(consoleLogSpy.mock.calls[0]![0] as string);
    expect(output.id).toBe('new-uuid');
  });

  it('passes --answer and --tags when provided', async () => {
    vi.mocked(golden.addGoldenEntry).mockReturnValue({
      id: 'x',
      query: 'Q1',
      source: 'manual' as const,
    });
    const { ctx } = createMockCtx();

    await runGoldenAdd(ctx, [
      '--project', 'test-project',
      '--query', 'Q1',
      '--answer', 'The answer',
      '--tags', 'auth,security',
    ]);

    expect(golden.addGoldenEntry).toHaveBeenCalledWith('test-project', expect.objectContaining({
      expectedAnswer: 'The answer',
      tags: ['auth', 'security'],
    }));
  });
});

// ============================================================================
// Eval Report Subcommand Tests
// ============================================================================

describe('eval report', () => {
  const mockProject = {
    id: 'uuid-123',
    name: 'test-project',
    path: '/tmp/test-project',
  };

  const mockEvalRuns: EvalRun[] = [
    {
      id: 'run-001',
      project_id: 'uuid-123',
      timestamp: '2026-02-15T12:00:00.000Z',
      dataset_version: '1.0',
      query_count: 10,
      metrics: JSON.stringify({
        mrr: 0.85, precision_at_k: 0.65, recall_at_k: 0.72,
        hit_rate: 0.90, ndcg: 0.78, map: 0.74,
      }),
      config: JSON.stringify({ top_k: 5 }),
      notes: 'status:completed',
    },
    {
      id: 'run-002',
      project_id: 'uuid-123',
      timestamp: '2026-02-14T12:00:00.000Z',
      dataset_version: '1.0',
      query_count: 10,
      metrics: JSON.stringify({
        mrr: 0.80, precision_at_k: 0.60, recall_at_k: 0.70,
        hit_rate: 0.85, ndcg: 0.75, map: 0.70,
      }),
      config: JSON.stringify({ top_k: 5 }),
      notes: 'status:completed',
    },
  ];

  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  function createMockCtx(jsonMode = false): { ctx: CommandContext; logOutput: string[] } {
    const logOutput: string[] = [];
    return {
      ctx: {
        options: { verbose: false, json: jsonMode },
        log: (msg: string) => logOutput.push(msg),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      logOutput,
    };
  }

  async function runReport(ctx: CommandContext, args: string[]) {
    const cmd = createEvalCommand(() => ctx);
    const program = new Command();
    program.addCommand(cmd);
    await program.parseAsync(['node', 'test', 'eval', 'report', ...args]);
  }

  beforeEach(() => {
    vi.mocked(database.runMigrations).mockReturnValue(undefined);
    vi.mocked(database.getDatabase).mockReturnValue({
      getProjectByName: vi.fn().mockReturnValue(mockProject),
      getEvalRuns: vi.fn().mockReturnValue([]),
    } as unknown as ReturnType<typeof database.getDatabase>);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows helpful message when no eval runs found', async () => {
    const { ctx, logOutput } = createMockCtx();
    await runReport(ctx, ['--project', 'test-project']);
    expect(logOutput.join('\n')).toContain('No eval runs found');
  });

  it('outputs empty JSON when no runs in JSON mode', async () => {
    const { ctx } = createMockCtx(true);
    await runReport(ctx, ['--project', 'test-project']);
    const output = JSON.parse(consoleLogSpy.mock.calls[0]![0] as string);
    expect(output.run_count).toBe(0);
    expect(output.trends).toEqual([]);
  });

  it('calls computeTrend and formatTrendReport with runs', async () => {
    const mockDb = {
      getProjectByName: vi.fn().mockReturnValue(mockProject),
      getEvalRuns: vi.fn().mockReturnValue(mockEvalRuns),
    };
    vi.mocked(database.getDatabase).mockReturnValue(
      mockDb as unknown as ReturnType<typeof database.getDatabase>
    );

    const mockTrend = {
      projectId: 'uuid-123',
      runCount: 2,
      currentRunId: 'run-001',
      previousRunId: 'run-002',
      trends: [
        { metric: 'mrr', current: 0.85, previous: 0.80, delta: 0.05, direction: 'stable' as const, isRegression: false, isImprovement: false },
      ],
      hasRegressions: false,
      hasImprovements: false,
    };
    vi.mocked(aggregator.computeTrend).mockReturnValue(mockTrend);
    vi.mocked(aggregator.formatTrendReport).mockReturnValue('Formatted Report Output');

    const { ctx, logOutput } = createMockCtx();
    await runReport(ctx, ['--project', 'test-project']);

    expect(aggregator.computeTrend).toHaveBeenCalledWith(mockEvalRuns);
    expect(aggregator.formatTrendReport).toHaveBeenCalledWith(mockTrend);
    expect(logOutput.join('\n')).toContain('Formatted Report Output');
  });

  it('respects --last option', async () => {
    const mockDb = {
      getProjectByName: vi.fn().mockReturnValue(mockProject),
      getEvalRuns: vi.fn().mockReturnValue([]),
    };
    vi.mocked(database.getDatabase).mockReturnValue(
      mockDb as unknown as ReturnType<typeof database.getDatabase>
    );

    const { ctx } = createMockCtx();
    await runReport(ctx, ['--project', 'test-project', '--last', '5']);

    expect(mockDb.getEvalRuns).toHaveBeenCalledWith('uuid-123', 5);
  });

  it('throws CLIError for non-existent project', async () => {
    vi.mocked(database.getDatabase).mockReturnValue({
      getProjectByName: vi.fn().mockReturnValue(undefined),
      getEvalRuns: vi.fn(),
    } as unknown as ReturnType<typeof database.getDatabase>);

    const { ctx } = createMockCtx();
    await expect(
      runReport(ctx, ['--project', 'nope']),
    ).rejects.toThrow(/Project not found/);
  });

  it('outputs structured JSON with trend data in JSON mode', async () => {
    const mockDb = {
      getProjectByName: vi.fn().mockReturnValue(mockProject),
      getEvalRuns: vi.fn().mockReturnValue(mockEvalRuns),
    };
    vi.mocked(database.getDatabase).mockReturnValue(
      mockDb as unknown as ReturnType<typeof database.getDatabase>
    );

    const mockTrend = {
      projectId: 'uuid-123',
      runCount: 2,
      currentRunId: 'run-001',
      previousRunId: 'run-002',
      trends: [
        { metric: 'mrr' as const, current: 0.85, previous: 0.80, delta: 0.05, direction: 'stable' as const, isRegression: false, isImprovement: false },
      ],
      hasRegressions: false,
      hasImprovements: false,
    };
    vi.mocked(aggregator.computeTrend).mockReturnValue(mockTrend);

    const { ctx } = createMockCtx(true);
    await runReport(ctx, ['--project', 'test-project']);

    const output = JSON.parse(consoleLogSpy.mock.calls[0]![0] as string);
    expect(output.project_name).toBe('test-project');
    expect(output.run_count).toBe(2);
    expect(output.current_run_id).toBe('run-001');
    expect(output.previous_run_id).toBe('run-002');
    expect(output.trends).toHaveLength(1);
    expect(output.trends[0].metric).toBe('mrr');
  });
});

// ============================================================================
// Eval Traces --type Filter Tests
// ============================================================================

describe('eval traces --type', () => {
  const mockProject = {
    id: 'uuid-123',
    name: 'test-project',
    path: '/tmp/test-project',
  };

  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  function createMockCtx(jsonMode = false): { ctx: CommandContext; logOutput: string[] } {
    const logOutput: string[] = [];
    return {
      ctx: {
        options: { verbose: false, json: jsonMode },
        log: (msg: string) => logOutput.push(msg),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      logOutput,
    };
  }

  async function runTraces(ctx: CommandContext, args: string[]) {
    const cmd = createEvalCommand(() => ctx);
    const program = new Command();
    program.addCommand(cmd);
    await program.parseAsync(['node', 'test', 'eval', 'traces', ...args]);
  }

  beforeEach(() => {
    vi.mocked(database.runMigrations).mockReturnValue(undefined);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes trace_type filter to getTraces when --type is provided', async () => {
    const mockDb = {
      getProjectByName: vi.fn().mockReturnValue(mockProject),
      getTraces: vi.fn().mockReturnValue([]),
    };
    vi.mocked(database.getDatabase).mockReturnValue(
      mockDb as unknown as ReturnType<typeof database.getDatabase>
    );

    const { ctx } = createMockCtx();
    await runTraces(ctx, ['--project', 'test-project', '--type', 'ask']);

    expect(mockDb.getTraces).toHaveBeenCalledWith(
      expect.objectContaining({ trace_type: 'ask' }),
    );
  });

  it('does not filter by type when --type is omitted', async () => {
    const mockDb = {
      getProjectByName: vi.fn().mockReturnValue(mockProject),
      getTraces: vi.fn().mockReturnValue([]),
    };
    vi.mocked(database.getDatabase).mockReturnValue(
      mockDb as unknown as ReturnType<typeof database.getDatabase>
    );

    const { ctx } = createMockCtx();
    await runTraces(ctx, ['--project', 'test-project']);

    expect(mockDb.getTraces).toHaveBeenCalledWith(
      expect.objectContaining({ trace_type: undefined }),
    );
  });

  it('validates --type value and rejects invalid types', async () => {
    const { ctx } = createMockCtx();
    await expect(
      runTraces(ctx, ['--type', 'invalid']),
    ).rejects.toThrow(/Invalid --type value/);
  });
});
