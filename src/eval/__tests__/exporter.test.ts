/**
 * Eval Exporter Tests
 *
 * Tests RAGAS and DeepEval export format conversion + file writing.
 * Export functions are pure transforms — no mocks needed.
 * writeExport uses a temp directory for file I/O isolation.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  exportToRagas,
  exportToDeepEval,
  writeExport,
  type ExportSourceEntry,
  type RagasEntry,
  type DeepEvalEntry,
} from '../exporter.js';
import type { GoldenEntry, EvalResult } from '../types.js';
import { EvalError, EvalErrorCodes } from '../types.js';

// ============================================================================
// TEST FIXTURES
// ============================================================================

/** Golden entry with both file paths and expected answer */
function makeGoldenEntry(overrides: Partial<GoldenEntry> = {}): GoldenEntry {
  return {
    id: 'entry-1',
    query: 'How does authentication work?',
    expectedFilePaths: ['src/auth/login.ts', 'src/auth/middleware.ts'],
    expectedAnswer: 'Authentication uses JWT tokens with refresh rotation.',
    tags: ['auth'],
    source: 'manual' as const,
    ...overrides,
  };
}

/** Golden entry with only file paths (no expected answer) */
function makeFilePathOnlyEntry(): GoldenEntry {
  return makeGoldenEntry({
    id: 'entry-2',
    query: 'Where is the database schema?',
    expectedFilePaths: ['src/database/schema.ts'],
    expectedAnswer: undefined,
  });
}

/** Eval result with retrieved files */
function makeEvalResult(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    id: 'result-1',
    eval_run_id: 'run-1',
    query: 'How does authentication work?',
    expected_files: JSON.stringify(['src/auth/login.ts', 'src/auth/middleware.ts']),
    retrieved_files: JSON.stringify(['src/auth/login.ts', 'src/auth/session.ts', 'src/auth/middleware.ts']),
    latency_ms: 150,
    metrics: JSON.stringify({ reciprocal_rank: 1, precision_at_k: 0.67, recall_at_k: 1, hit_rate: 1 }),
    passed: true,
    ...overrides,
  };
}

// ============================================================================
// exportToRagas
// ============================================================================

describe('exportToRagas', () => {
  it('converts golden entry with eval result to RAGAS format', () => {
    const entries: ExportSourceEntry[] = [
      { golden: makeGoldenEntry(), evalResult: makeEvalResult() },
    ];

    const result = exportToRagas(entries);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      question: 'How does authentication work?',
      answer: '', // EvalResult doesn't store answers
      contexts: ['src/auth/login.ts', 'src/auth/session.ts', 'src/auth/middleware.ts'],
      ground_truths: [
        'Authentication uses JWT tokens with refresh rotation.',
        'src/auth/login.ts',
        'src/auth/middleware.ts',
      ],
    });
  });

  it('handles golden entry without eval result (golden-only export)', () => {
    const entries: ExportSourceEntry[] = [
      { golden: makeGoldenEntry() },
    ];

    const result = exportToRagas(entries);

    expect(result).toHaveLength(1);
    expect(result[0]!.contexts).toEqual([]);
    expect(result[0]!.answer).toBe('');
    expect(result[0]!.ground_truths).toContain('Authentication uses JWT tokens with refresh rotation.');
    expect(result[0]!.ground_truths).toContain('src/auth/login.ts');
  });

  it('handles golden entry with only file paths (no expectedAnswer)', () => {
    const entries: ExportSourceEntry[] = [
      { golden: makeFilePathOnlyEntry() },
    ];

    const result = exportToRagas(entries);

    expect(result).toHaveLength(1);
    expect(result[0]!.ground_truths).toEqual(['src/database/schema.ts']);
  });

  it('handles golden entry with only expectedAnswer (no file paths)', () => {
    const golden = makeGoldenEntry({
      expectedFilePaths: undefined,
      expectedAnswer: 'The answer is 42.',
    });

    const result = exportToRagas([{ golden }]);

    expect(result[0]!.ground_truths).toEqual(['The answer is 42.']);
  });

  it('handles malformed retrieved_files JSON gracefully', () => {
    const evalResult = makeEvalResult({ retrieved_files: 'not-json' });

    const result = exportToRagas([{ golden: makeGoldenEntry(), evalResult }]);

    expect(result[0]!.contexts).toEqual([]);
  });

  it('handles null retrieved_files gracefully', () => {
    const evalResult = makeEvalResult({ retrieved_files: null as unknown as string });

    const result = exportToRagas([{ golden: makeGoldenEntry(), evalResult }]);

    expect(result[0]!.contexts).toEqual([]);
  });

  it('filters out entries with empty query', () => {
    const entries: ExportSourceEntry[] = [
      { golden: makeGoldenEntry({ query: '' }) },
      { golden: makeGoldenEntry({ id: 'valid', query: 'Valid query?' }) },
    ];

    const result = exportToRagas(entries);

    expect(result).toHaveLength(1);
    expect(result[0]!.question).toBe('Valid query?');
  });

  it('handles empty input array', () => {
    expect(exportToRagas([])).toEqual([]);
  });

  it('handles multiple entries', () => {
    const entries: ExportSourceEntry[] = [
      { golden: makeGoldenEntry(), evalResult: makeEvalResult() },
      { golden: makeFilePathOnlyEntry() },
    ];

    const result = exportToRagas(entries);

    expect(result).toHaveLength(2);
    expect(result[0]!.question).toBe('How does authentication work?');
    expect(result[1]!.question).toBe('Where is the database schema?');
  });
});

// ============================================================================
// exportToDeepEval
// ============================================================================

describe('exportToDeepEval', () => {
  it('converts golden entry with eval result to DeepEval format', () => {
    const entries: ExportSourceEntry[] = [
      { golden: makeGoldenEntry(), evalResult: makeEvalResult() },
    ];

    const result = exportToDeepEval(entries);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      input: 'How does authentication work?',
      actual_output: '',
      retrieval_context: ['src/auth/login.ts', 'src/auth/session.ts', 'src/auth/middleware.ts'],
      expected_output: 'Authentication uses JWT tokens with refresh rotation.',
    });
  });

  it('falls back to file paths for expected_output when no expectedAnswer', () => {
    const entries: ExportSourceEntry[] = [
      { golden: makeFilePathOnlyEntry() },
    ];

    const result = exportToDeepEval(entries);

    expect(result[0]!.expected_output).toBe('src/database/schema.ts');
  });

  it('uses comma-joined file paths when multiple paths and no answer', () => {
    const golden = makeGoldenEntry({
      expectedAnswer: undefined,
      expectedFilePaths: ['src/a.ts', 'src/b.ts'],
    });

    const result = exportToDeepEval([{ golden }]);

    expect(result[0]!.expected_output).toBe('src/a.ts, src/b.ts');
  });

  it('returns empty expected_output when no answer and no file paths', () => {
    const golden = makeGoldenEntry({
      expectedAnswer: undefined,
      expectedFilePaths: undefined,
    });

    const result = exportToDeepEval([{ golden }]);

    expect(result[0]!.expected_output).toBe('');
  });

  it('handles golden entry without eval result', () => {
    const result = exportToDeepEval([{ golden: makeGoldenEntry() }]);

    expect(result[0]!.retrieval_context).toEqual([]);
    expect(result[0]!.actual_output).toBe('');
  });

  it('handles malformed retrieved_files JSON gracefully', () => {
    const evalResult = makeEvalResult({ retrieved_files: '{invalid}' });

    const result = exportToDeepEval([{ golden: makeGoldenEntry(), evalResult }]);

    expect(result[0]!.retrieval_context).toEqual([]);
  });

  it('filters out entries with empty query', () => {
    const entries: ExportSourceEntry[] = [
      { golden: makeGoldenEntry({ query: '' }) },
      { golden: makeGoldenEntry({ id: 'ok', query: 'Real query' }) },
    ];

    const result = exportToDeepEval(entries);

    expect(result).toHaveLength(1);
  });

  it('handles empty input array', () => {
    expect(exportToDeepEval([])).toEqual([]);
  });
});

// ============================================================================
// writeExport
// ============================================================================

const testDir = join(tmpdir(), `ctx-exporter-test-${Date.now()}`);

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('writeExport', () => {
  it('writes RAGAS data to JSON file', () => {
    const data: RagasEntry[] = [
      { question: 'test?', answer: 'yes', contexts: ['a.ts'], ground_truths: ['yes'] },
    ];
    const outputPath = join(testDir, 'ragas-output.json');

    writeExport(data, outputPath);

    expect(existsSync(outputPath)).toBe(true);
    const content = JSON.parse(readFileSync(outputPath, 'utf-8'));
    expect(content).toEqual(data);
  });

  it('writes DeepEval data to JSON file', () => {
    const data: DeepEvalEntry[] = [
      { input: 'test?', actual_output: 'yes', retrieval_context: ['a.ts'], expected_output: 'yes' },
    ];
    const outputPath = join(testDir, 'deepeval-output.json');

    writeExport(data, outputPath);

    const content = JSON.parse(readFileSync(outputPath, 'utf-8'));
    expect(content).toEqual(data);
  });

  it('creates parent directories if they do not exist', () => {
    const data: RagasEntry[] = [
      { question: 'q', answer: 'a', contexts: [], ground_truths: [] },
    ];
    const outputPath = join(testDir, 'nested', 'dir', 'output.json');

    writeExport(data, outputPath);

    expect(existsSync(outputPath)).toBe(true);
  });

  it('writes pretty-printed JSON with 2-space indent', () => {
    const data: RagasEntry[] = [
      { question: 'q', answer: 'a', contexts: [], ground_truths: [] },
    ];
    const outputPath = join(testDir, 'pretty.json');

    writeExport(data, outputPath);

    const raw = readFileSync(outputPath, 'utf-8');
    expect(raw).toBe(JSON.stringify(data, null, 2));
  });

  it('writes empty array for no entries', () => {
    const outputPath = join(testDir, 'empty.json');

    writeExport([], outputPath);

    const content = JSON.parse(readFileSync(outputPath, 'utf-8'));
    expect(content).toEqual([]);
  });

  it('throws EvalError on write failure', () => {
    // Try to write to a path that can't exist (file as directory)
    const blockerPath = join(testDir, 'blocker-file');
    // Create a file where we'll try to use it as a directory
    const { writeFileSync: wfs } = require('node:fs');
    wfs(blockerPath, 'block');
    const impossiblePath = join(blockerPath, 'subdir', 'output.json');

    expect(() => writeExport([], impossiblePath)).toThrow(EvalError);
  });
});
