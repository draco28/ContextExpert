#!/usr/bin/env node

/**
 * CI Quality Gate: Eval Threshold Checker
 *
 * Reads JSON output from `ctx eval run --json` and fails CI if
 * retrieval quality metrics fall below configurable thresholds.
 *
 * Usage:
 *   ctx eval run --json --project X | node scripts/check-eval-thresholds.js
 *   node scripts/check-eval-thresholds.js results.json
 *
 * Environment variable overrides:
 *   EVAL_THRESHOLD_MRR         (default: 0.6)
 *   EVAL_THRESHOLD_PRECISION   (default: 0.5)
 *   EVAL_THRESHOLD_HIT_RATE    (default: 0.8)
 *
 * Exit codes:
 *   0 - All metrics pass
 *   1 - One or more metrics below threshold
 *   2 - Usage/input error
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================================
// Constants
// ============================================================================

/**
 * Default CI thresholds — intentionally lower than config defaults
 * (config: MRR 0.7, Hit Rate 0.85, P@K 0.6) to serve as a minimum
 * quality floor rather than a target.
 */
const DEFAULT_THRESHOLDS = {
  mrr: 0.6,
  precision_at_k: 0.5,
  hit_rate: 0.8,
};

/**
 * Metric display configuration — maps internal keys to human-readable
 * names and their corresponding environment variable override names.
 */
const METRIC_CONFIG = [
  { key: 'mrr', name: 'MRR', envVar: 'EVAL_THRESHOLD_MRR' },
  { key: 'precision_at_k', name: 'Precision@K', envVar: 'EVAL_THRESHOLD_PRECISION' },
  { key: 'hit_rate', name: 'Hit Rate', envVar: 'EVAL_THRESHOLD_HIT_RATE' },
];

// ============================================================================
// Pure Functions (exported for testing)
// ============================================================================

/**
 * Parse a float from an environment variable, falling back to a default.
 *
 * Returns the default if the env var is unset or empty.
 * Returns { value, error } to avoid calling process.exit in a pure function.
 */
export function parseEnvFloat(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return { value: defaultValue, error: null };

  const parsed = parseFloat(raw);
  if (isNaN(parsed) || parsed < 0 || parsed > 1) {
    return {
      value: defaultValue,
      error: `${name}=${raw} is not a valid threshold (must be 0.0-1.0)`,
    };
  }
  return { value: parsed, error: null };
}

/**
 * Build thresholds from defaults + environment variable overrides.
 *
 * Returns { thresholds, error } — error is non-null if any env var is invalid.
 */
export function getThresholds() {
  const thresholds = { ...DEFAULT_THRESHOLDS };

  for (const { key, envVar } of METRIC_CONFIG) {
    const { value, error } = parseEnvFloat(envVar, DEFAULT_THRESHOLDS[key]);
    if (error) return { thresholds: null, error };
    thresholds[key] = value;
  }

  return { thresholds, error: null };
}

/**
 * Validate that input JSON has the expected shape from `ctx eval run --json`.
 *
 * Checks for the presence and type of the three required metric fields.
 * Does NOT check the `passed` field — the script enforces its own thresholds.
 */
export function validateInput(data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Input is not a JSON object' };
  }

  if (!data.metrics || typeof data.metrics !== 'object') {
    return { valid: false, error: 'Missing or invalid "metrics" field' };
  }

  const requiredMetrics = ['mrr', 'precision_at_k', 'hit_rate'];
  for (const key of requiredMetrics) {
    const value = data.metrics[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { valid: false, error: `metrics.${key} is not a valid number` };
    }
  }

  return { valid: true, error: null };
}

/**
 * Check each metric against its threshold.
 *
 * Uses >= comparison to match the convention in eval.ts buildMetricRows().
 * Returns structured results for each metric and an overall pass/fail flag.
 */
export function checkThresholds(metrics, thresholds) {
  const results = METRIC_CONFIG.map(({ key, name }) => ({
    name,
    key,
    value: metrics[key],
    threshold: thresholds[key],
    passed: metrics[key] >= thresholds[key],
  }));

  return {
    results,
    allPassed: results.every((r) => r.passed),
  };
}

/**
 * Format the threshold check results as a human-readable table.
 *
 * No chalk dependency — uses plain text suitable for CI logs.
 */
export function formatOutput(checkResult, data) {
  const lines = [];

  // Header
  lines.push('Eval Quality Gate');
  lines.push('=================');

  // Context line from input data (if available)
  const parts = [];
  if (data?.project_name) parts.push(`Project: ${data.project_name}`);
  if (data?.run_id) parts.push(`Run: ${data.run_id.substring(0, 8)}`);
  if (data?.query_count !== undefined) parts.push(`Queries: ${data.query_count}`);
  if (parts.length > 0) lines.push(parts.join('  |  '));
  lines.push('');

  // Metric rows
  for (const r of checkResult.results) {
    const name = r.name.padEnd(13);
    const value = r.value.toFixed(3).padStart(7);
    const threshold = `>= ${r.threshold.toFixed(3)}`;
    const status = r.passed ? 'PASS' : 'FAIL';
    lines.push(`  ${name} ${value}    ${threshold}    ${status}`);
  }

  lines.push('');

  // Summary
  if (checkResult.allPassed) {
    lines.push('Result: PASS (all metrics at or above thresholds)');
  } else {
    const failCount = checkResult.results.filter((r) => !r.passed).length;
    const total = checkResult.results.length;
    lines.push(`Result: FAIL (${failCount}/${total} metrics below threshold)`);

    for (const r of checkResult.results) {
      if (!r.passed) {
        lines.push(`  ${r.name}: ${r.value.toFixed(3)} < ${r.threshold.toFixed(3)}`);
      }
    }
  }

  return lines.join('\n');
}

// ============================================================================
// I/O Functions
// ============================================================================

function printUsage() {
  console.log(`Usage:
  ctx eval run --json --project <name> | node scripts/check-eval-thresholds.js
  node scripts/check-eval-thresholds.js <results.json>

Environment variable overrides:
  EVAL_THRESHOLD_MRR         (default: ${DEFAULT_THRESHOLDS.mrr})
  EVAL_THRESHOLD_PRECISION   (default: ${DEFAULT_THRESHOLDS.precision_at_k})
  EVAL_THRESHOLD_HIT_RATE    (default: ${DEFAULT_THRESHOLDS.hit_rate})

Exit codes: 0 = pass, 1 = fail, 2 = usage error`);
}

async function readInput() {
  const filePath = process.argv[2];

  if (filePath) {
    return readFileSync(resolve(filePath), 'utf-8');
  }

  // No file arg — read from stdin
  if (process.stdin.isTTY) {
    printUsage();
    process.exit(2);
  }

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const raw = await readInput();

  // Parse JSON
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error('Error: Invalid JSON input');
    process.exit(2);
  }

  // Validate shape
  const validation = validateInput(data);
  if (!validation.valid) {
    console.error(`Error: ${validation.error}`);
    process.exit(2);
  }

  // Build thresholds
  const { thresholds, error: thresholdError } = getThresholds();
  if (thresholdError) {
    console.error(`Error: ${thresholdError}`);
    process.exit(2);
  }

  // Check
  const result = checkThresholds(data.metrics, thresholds);

  // Output
  console.log(formatOutput(result, data));

  process.exit(result.allPassed ? 0 : 1);
}

// Guard: only run main() when executed directly, not when imported for testing
const __filename = fileURLToPath(import.meta.url);
const isMain = resolve(process.argv[1] ?? '') === resolve(__filename);

if (isMain) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(2);
  });
}
