/**
 * Eval Threshold Checker Tests
 *
 * Tests the scripts/check-eval-thresholds.js CI quality gate.
 *
 * Two test strategies:
 * 1. Unit tests — import the pure functions directly (fast, precise)
 * 2. Integration tests — run the script as a subprocess (end-to-end)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, unlinkSync, mkdtempSync, readdirSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Import pure functions from the script (the isMain guard prevents side effects)
import {
  checkThresholds,
  validateInput,
  getThresholds,
  parseEnvFloat,
  formatOutput,
} from '../../../scripts/check-eval-thresholds.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(__dirname, '../../../scripts/check-eval-thresholds.js');
const execAsync = promisify(exec);

// ============================================================================
// Test Data Factory
// ============================================================================

/**
 * Create a mock EvalRunOutputJSON matching the shape from eval.ts:73-85.
 *
 * All metrics default to passing values against the CI thresholds
 * (MRR >= 0.6, P@K >= 0.5, Hit Rate >= 0.8).
 */
function makeEvalOutput(overrides: Record<string, unknown> = {}) {
  return {
    run_id: 'test-run-001',
    project_name: 'test-project',
    timestamp: '2026-02-17T00:00:00.000Z',
    query_count: 8,
    metrics: {
      mrr: 0.75,
      precision_at_k: 0.65,
      recall_at_k: 0.80,
      hit_rate: 0.875,
      ndcg: 0.72,
      map: 0.68,
    },
    thresholds: { mrr: 0.7, hit_rate: 0.85, precision_at_k: 0.6 },
    passed: true,
    comparison: null,
    regressions: [],
    improvements: [],
    ragas: null,
    ...overrides,
  };
}

// ============================================================================
// validateInput Tests
// ============================================================================

describe('validateInput', () => {
  it('returns valid for well-formed eval JSON', () => {
    const data = makeEvalOutput();
    const result = validateInput(data);
    expect(result).toEqual({ valid: true, error: null });
  });

  it('returns invalid for null input', () => {
    const result = validateInput(null);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not a JSON object');
  });

  it('returns invalid for undefined input', () => {
    const result = validateInput(undefined);
    expect(result.valid).toBe(false);
  });

  it('returns invalid for string input', () => {
    const result = validateInput('not an object');
    expect(result.valid).toBe(false);
  });

  it('returns invalid for missing metrics field', () => {
    const result = validateInput({ run_id: '123' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('metrics');
  });

  it('returns invalid for non-object metrics', () => {
    const result = validateInput({ metrics: 'not an object' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('metrics');
  });

  it('returns invalid for missing mrr', () => {
    const result = validateInput({
      metrics: { precision_at_k: 0.5, hit_rate: 0.8 },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('metrics.mrr');
  });

  it('returns invalid for missing precision_at_k', () => {
    const result = validateInput({
      metrics: { mrr: 0.7, hit_rate: 0.8 },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('metrics.precision_at_k');
  });

  it('returns invalid for missing hit_rate', () => {
    const result = validateInput({
      metrics: { mrr: 0.7, precision_at_k: 0.5 },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('metrics.hit_rate');
  });

  it('returns invalid for non-number metric value', () => {
    const result = validateInput({
      metrics: { mrr: 'high', precision_at_k: 0.5, hit_rate: 0.8 },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('metrics.mrr');
  });

  it('returns invalid for NaN metric value', () => {
    const result = validateInput({
      metrics: { mrr: NaN, precision_at_k: 0.5, hit_rate: 0.8 },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('metrics.mrr');
  });

  it('returns invalid for Infinity metric value', () => {
    const result = validateInput({
      metrics: { mrr: Infinity, precision_at_k: 0.5, hit_rate: 0.8 },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('metrics.mrr');
  });

  it('returns valid when optional fields are absent', () => {
    const result = validateInput({
      metrics: { mrr: 0.7, precision_at_k: 0.5, hit_rate: 0.8 },
    });
    expect(result.valid).toBe(true);
  });
});

// ============================================================================
// checkThresholds Tests
// ============================================================================

describe('checkThresholds', () => {
  const defaultThresholds = { mrr: 0.6, precision_at_k: 0.5, hit_rate: 0.8 };

  it('returns allPassed true when all metrics above thresholds', () => {
    const metrics = { mrr: 0.75, precision_at_k: 0.65, hit_rate: 0.90 };
    const result = checkThresholds(metrics, defaultThresholds);

    expect(result.allPassed).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(result.results.every((r: { passed: boolean }) => r.passed)).toBe(true);
  });

  it('returns allPassed false when all metrics below thresholds', () => {
    const metrics = { mrr: 0.3, precision_at_k: 0.2, hit_rate: 0.4 };
    const result = checkThresholds(metrics, defaultThresholds);

    expect(result.allPassed).toBe(false);
    expect(result.results.every((r: { passed: boolean }) => !r.passed)).toBe(true);
  });

  it('returns allPassed false when one metric fails', () => {
    const metrics = { mrr: 0.75, precision_at_k: 0.3, hit_rate: 0.90 };
    const result = checkThresholds(metrics, defaultThresholds);

    expect(result.allPassed).toBe(false);

    const mrrResult = result.results.find((r: { key: string }) => r.key === 'mrr');
    expect(mrrResult!.passed).toBe(true);

    const precResult = result.results.find((r: { key: string }) => r.key === 'precision_at_k');
    expect(precResult!.passed).toBe(false);

    const hitResult = result.results.find((r: { key: string }) => r.key === 'hit_rate');
    expect(hitResult!.passed).toBe(true);
  });

  it('passes when metric exactly equals threshold (>= not >)', () => {
    const metrics = { mrr: 0.6, precision_at_k: 0.5, hit_rate: 0.8 };
    const result = checkThresholds(metrics, defaultThresholds);

    expect(result.allPassed).toBe(true);
    expect(result.results.every((r: { passed: boolean }) => r.passed)).toBe(true);
  });

  it('fails when metric is zero against non-zero threshold', () => {
    const metrics = { mrr: 0.0, precision_at_k: 0.0, hit_rate: 0.0 };
    const result = checkThresholds(metrics, defaultThresholds);

    expect(result.allPassed).toBe(false);
  });

  it('passes when all metrics are 1.0 (perfect)', () => {
    const metrics = { mrr: 1.0, precision_at_k: 1.0, hit_rate: 1.0 };
    const result = checkThresholds(metrics, defaultThresholds);

    expect(result.allPassed).toBe(true);
  });

  it('includes metric names in results', () => {
    const metrics = { mrr: 0.75, precision_at_k: 0.65, hit_rate: 0.90 };
    const result = checkThresholds(metrics, defaultThresholds);

    expect(result.results.map((r: { name: string }) => r.name)).toEqual([
      'MRR',
      'Precision@K',
      'Hit Rate',
    ]);
  });
});

// ============================================================================
// parseEnvFloat Tests
// ============================================================================

describe('parseEnvFloat', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns default when env var is not set', () => {
    delete process.env.TEST_THRESHOLD;
    const result = parseEnvFloat('TEST_THRESHOLD', 0.6);
    expect(result).toEqual({ value: 0.6, error: null });
  });

  it('returns default when env var is empty string', () => {
    process.env.TEST_THRESHOLD = '';
    const result = parseEnvFloat('TEST_THRESHOLD', 0.6);
    expect(result).toEqual({ value: 0.6, error: null });
  });

  it('parses valid float from env var', () => {
    process.env.TEST_THRESHOLD = '0.75';
    const result = parseEnvFloat('TEST_THRESHOLD', 0.6);
    expect(result).toEqual({ value: 0.75, error: null });
  });

  it('accepts 0.0 as valid', () => {
    process.env.TEST_THRESHOLD = '0';
    const result = parseEnvFloat('TEST_THRESHOLD', 0.6);
    expect(result).toEqual({ value: 0, error: null });
  });

  it('accepts 1.0 as valid', () => {
    process.env.TEST_THRESHOLD = '1.0';
    const result = parseEnvFloat('TEST_THRESHOLD', 0.6);
    expect(result).toEqual({ value: 1.0, error: null });
  });

  it('returns error for non-numeric value', () => {
    process.env.TEST_THRESHOLD = 'high';
    const result = parseEnvFloat('TEST_THRESHOLD', 0.6);
    expect(result.error).toContain('TEST_THRESHOLD=high');
    expect(result.error).toContain('not a valid threshold');
  });

  it('returns error for value above 1.0', () => {
    process.env.TEST_THRESHOLD = '1.5';
    const result = parseEnvFloat('TEST_THRESHOLD', 0.6);
    expect(result.error).toContain('not a valid threshold');
  });

  it('returns error for negative value', () => {
    process.env.TEST_THRESHOLD = '-0.1';
    const result = parseEnvFloat('TEST_THRESHOLD', 0.6);
    expect(result.error).toContain('not a valid threshold');
  });
});

// ============================================================================
// getThresholds Tests
// ============================================================================

describe('getThresholds', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns defaults when no env vars set', () => {
    delete process.env.EVAL_THRESHOLD_MRR;
    delete process.env.EVAL_THRESHOLD_PRECISION;
    delete process.env.EVAL_THRESHOLD_HIT_RATE;

    const result = getThresholds();
    expect(result.error).toBeNull();
    expect(result.thresholds).toEqual({
      mrr: 0.6,
      precision_at_k: 0.5,
      hit_rate: 0.8,
    });
  });

  it('overrides MRR from EVAL_THRESHOLD_MRR', () => {
    process.env.EVAL_THRESHOLD_MRR = '0.7';
    const result = getThresholds();
    expect(result.thresholds!.mrr).toBe(0.7);
  });

  it('overrides Precision from EVAL_THRESHOLD_PRECISION', () => {
    process.env.EVAL_THRESHOLD_PRECISION = '0.65';
    const result = getThresholds();
    expect(result.thresholds!.precision_at_k).toBe(0.65);
  });

  it('overrides Hit Rate from EVAL_THRESHOLD_HIT_RATE', () => {
    process.env.EVAL_THRESHOLD_HIT_RATE = '0.9';
    const result = getThresholds();
    expect(result.thresholds!.hit_rate).toBe(0.9);
  });

  it('returns error for invalid env var', () => {
    process.env.EVAL_THRESHOLD_MRR = 'bad';
    const result = getThresholds();
    expect(result.error).toContain('EVAL_THRESHOLD_MRR');
    expect(result.thresholds).toBeNull();
  });
});

// ============================================================================
// formatOutput Tests
// ============================================================================

describe('formatOutput', () => {
  it('shows PASS when all metrics pass', () => {
    const checkResult = {
      allPassed: true,
      results: [
        { name: 'MRR', key: 'mrr', value: 0.75, threshold: 0.6, passed: true },
        { name: 'Precision@K', key: 'precision_at_k', value: 0.65, threshold: 0.5, passed: true },
        { name: 'Hit Rate', key: 'hit_rate', value: 0.90, threshold: 0.8, passed: true },
      ],
    };
    const data = makeEvalOutput();

    const output = formatOutput(checkResult, data);
    expect(output).toContain('Eval Quality Gate');
    expect(output).toContain('Result: PASS');
    expect(output).toContain('PASS');
    expect(output).not.toContain('Result: FAIL');
  });

  it('shows FAIL with count when some metrics fail', () => {
    const checkResult = {
      allPassed: false,
      results: [
        { name: 'MRR', key: 'mrr', value: 0.75, threshold: 0.6, passed: true },
        { name: 'Precision@K', key: 'precision_at_k', value: 0.35, threshold: 0.5, passed: false },
        { name: 'Hit Rate', key: 'hit_rate', value: 0.90, threshold: 0.8, passed: true },
      ],
    };
    const data = makeEvalOutput();

    const output = formatOutput(checkResult, data);
    expect(output).toContain('Result: FAIL');
    expect(output).toContain('1/3');
    expect(output).toContain('Precision@K: 0.350 < 0.500');
  });

  it('includes project name and run ID from input data', () => {
    const checkResult = {
      allPassed: true,
      results: [
        { name: 'MRR', key: 'mrr', value: 0.75, threshold: 0.6, passed: true },
        { name: 'Precision@K', key: 'precision_at_k', value: 0.65, threshold: 0.5, passed: true },
        { name: 'Hit Rate', key: 'hit_rate', value: 0.90, threshold: 0.8, passed: true },
      ],
    };
    const data = makeEvalOutput();

    const output = formatOutput(checkResult, data);
    expect(output).toContain('Project: test-project');
    expect(output).toContain('Run: test-run');
    expect(output).toContain('Queries: 8');
  });

  it('handles missing data gracefully', () => {
    const checkResult = {
      allPassed: true,
      results: [
        { name: 'MRR', key: 'mrr', value: 0.75, threshold: 0.6, passed: true },
        { name: 'Precision@K', key: 'precision_at_k', value: 0.65, threshold: 0.5, passed: true },
        { name: 'Hit Rate', key: 'hit_rate', value: 0.90, threshold: 0.8, passed: true },
      ],
    };

    // Should not throw when data is minimal
    const output = formatOutput(checkResult, { metrics: { mrr: 0.75, precision_at_k: 0.65, hit_rate: 0.9 } });
    expect(output).toContain('Eval Quality Gate');
  });

  it('shows metric values with 3 decimal places', () => {
    const checkResult = {
      allPassed: true,
      results: [
        { name: 'MRR', key: 'mrr', value: 0.7, threshold: 0.6, passed: true },
        { name: 'Precision@K', key: 'precision_at_k', value: 0.5, threshold: 0.5, passed: true },
        { name: 'Hit Rate', key: 'hit_rate', value: 0.8, threshold: 0.8, passed: true },
      ],
    };

    const output = formatOutput(checkResult, {});
    expect(output).toContain('0.700');
    expect(output).toContain('0.500');
    expect(output).toContain('0.800');
  });
});

// ============================================================================
// Integration Tests (subprocess)
// ============================================================================

describe('integration: subprocess', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'eval-threshold-'));
  });

  afterEach(() => {
    // Clean up temp files (best-effort)
    try {
      for (const f of readdirSync(tmpDir)) {
        unlinkSync(join(tmpDir, f));
      }
      rmdirSync(tmpDir);
    } catch {
      // Ignore cleanup errors
    }
  });

  /**
   * Helper to run the script via shell pipe (echo '...' | node script.js).
   *
   * Uses exec() (not execFile) so the shell handles stdin piping and EOF
   * correctly — matching how the script is invoked in real CI pipelines.
   */
  async function runScript(
    input: string,
    env?: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Escape single quotes in the JSON for shell safety
    const escaped = input.replace(/'/g, "'\\''");
    const cmd = `echo '${escaped}' | ${process.execPath} ${SCRIPT_PATH}`;

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        env: { ...process.env, ...env },
        timeout: 10000,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
        exitCode: error.code ?? 1,
      };
    }
  }

  /**
   * Helper to run the script with a file argument (no stdin).
   */
  async function runScriptWithFile(
    filePath: string,
    env?: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cmd = `${process.execPath} ${SCRIPT_PATH} ${filePath}`;

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        env: { ...process.env, ...env },
        timeout: 10000,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
        exitCode: error.code ?? 1,
      };
    }
  }

  it('exits 0 when all metrics pass via stdin', async () => {
    const data = makeEvalOutput();
    const result = await runScript(JSON.stringify(data));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Result: PASS');
  });

  it('exits 1 when metrics below threshold via stdin', async () => {
    const data = makeEvalOutput({
      metrics: {
        mrr: 0.3,
        precision_at_k: 0.2,
        recall_at_k: 0.5,
        hit_rate: 0.4,
        ndcg: 0.5,
        map: 0.4,
      },
    });
    const result = await runScript(JSON.stringify(data));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Result: FAIL');
  });

  it('exits 2 for invalid JSON input', async () => {
    const result = await runScript('not valid json {{{');

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Invalid JSON');
  });

  it('exits 2 for JSON missing metrics field', async () => {
    const result = await runScript(JSON.stringify({ run_id: '123' }));

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('metrics');
  });

  it('reads from file argument', async () => {
    const data = makeEvalOutput();
    const filePath = join(tmpDir, 'results.json');
    writeFileSync(filePath, JSON.stringify(data));

    const result = await runScriptWithFile(filePath);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Result: PASS');
  });

  it('respects EVAL_THRESHOLD_MRR env var override', async () => {
    // MRR is 0.75, set threshold to 0.9 → should fail
    const data = makeEvalOutput();
    const result = await runScript(JSON.stringify(data), {
      EVAL_THRESHOLD_MRR: '0.9',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('FAIL');
    expect(result.stdout).toContain('MRR');
  });

  it('exits 2 for invalid threshold env var', async () => {
    const data = makeEvalOutput();
    const result = await runScript(JSON.stringify(data), {
      EVAL_THRESHOLD_MRR: 'invalid',
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('EVAL_THRESHOLD_MRR');
  });

  it('shows project name in output', async () => {
    const data = makeEvalOutput({ project_name: 'my-awesome-project' });
    const result = await runScript(JSON.stringify(data));

    expect(result.stdout).toContain('my-awesome-project');
  });
});
