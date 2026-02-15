/**
 * Eval Exporter
 *
 * Converts eval data (golden datasets + eval results) into formats
 * consumed by Python evaluation frameworks:
 *
 * - **RAGAS**: {question, answer, contexts, ground_truths}
 *   https://docs.ragas.io/en/latest/
 *
 * - **DeepEval**: {input, actual_output, retrieval_context, expected_output}
 *   https://docs.confident-ai.com/docs/
 *
 * Used by `ctx eval export --format ragas|deepeval --output ./eval_data.json`
 *
 * Design:
 * - Pure data transformation (no DB access, no side effects except writeExport)
 * - Accepts pre-loaded data so callers control data fetching
 * - JSON output for easy Python consumption: `dataset = json.load(open(path))`
 */

import * as fs from 'node:fs';
import { dirname } from 'node:path';
import { EvalError } from './types.js';
import type { GoldenEntry, EvalResult } from './types.js';

// ============================================================================
// EXPORT FORMAT TYPES
// ============================================================================

/**
 * RAGAS dataset entry format.
 *
 * Matches the RAGAS Dataset schema expected by `evaluate()`:
 * - question: the query text
 * - answer: LLM-generated answer (empty string if unavailable)
 * - contexts: retrieved text chunks (file paths used as proxy)
 * - ground_truths: expected correct answers/file paths
 *
 * @see https://docs.ragas.io/en/latest/concepts/metrics/index.html
 */
export interface RagasEntry {
  question: string;
  answer: string;
  contexts: string[];
  ground_truths: string[];
}

/**
 * DeepEval test case format.
 *
 * Matches DeepEval's LLMTestCase schema:
 * - input: the query text
 * - actual_output: LLM-generated answer (empty string if unavailable)
 * - retrieval_context: retrieved text chunks (file paths used as proxy)
 * - expected_output: expected correct answer
 *
 * @see https://docs.confident-ai.com/docs/evaluation-test-cases
 */
export interface DeepEvalEntry {
  input: string;
  actual_output: string;
  retrieval_context: string[];
  expected_output: string;
}

/**
 * Source data for export: a golden entry paired with its eval result.
 *
 * When evalResult is provided, the exporter uses actual retrieved files
 * and answer from the eval run. When absent, only golden dataset fields
 * are used (contexts/answer will be empty).
 */
export interface ExportSourceEntry {
  golden: GoldenEntry;
  evalResult?: EvalResult;
}

// ============================================================================
// RAGAS EXPORT
// ============================================================================

/**
 * Convert eval data to RAGAS format.
 *
 * Maps each source entry to the RAGAS Dataset schema:
 * - question ← golden.query
 * - answer ← eval result's answer (parsed from metadata) or empty string
 * - contexts ← eval result's retrieved_files (parsed JSON) or empty array
 * - ground_truths ← golden.expectedFilePaths + golden.expectedAnswer
 *
 * Entries without a query are skipped (shouldn't happen with valid golden data).
 *
 * @param entries - Source entries pairing golden data with optional eval results
 * @returns Array of RAGAS-formatted entries ready for JSON serialization
 */
export function exportToRagas(entries: ExportSourceEntry[]): RagasEntry[] {
  return entries
    .filter((e) => e.golden.query)
    .map((e) => {
      const retrievedFiles = parseJsonArray(e.evalResult?.retrieved_files);
      const answer = parseAnswer(e.evalResult);

      // ground_truths: combine expectedAnswer and expectedFilePaths
      const groundTruths: string[] = [];
      if (e.golden.expectedAnswer) {
        groundTruths.push(e.golden.expectedAnswer);
      }
      if (e.golden.expectedFilePaths?.length) {
        groundTruths.push(...e.golden.expectedFilePaths);
      }

      return {
        question: e.golden.query,
        answer,
        contexts: retrievedFiles,
        ground_truths: groundTruths,
      };
    });
}

// ============================================================================
// DEEPEVAL EXPORT
// ============================================================================

/**
 * Convert eval data to DeepEval format.
 *
 * Maps each source entry to DeepEval's LLMTestCase schema:
 * - input ← golden.query
 * - actual_output ← eval result's answer or empty string
 * - retrieval_context ← eval result's retrieved_files (parsed JSON) or empty array
 * - expected_output ← golden.expectedAnswer or comma-joined expectedFilePaths
 *
 * @param entries - Source entries pairing golden data with optional eval results
 * @returns Array of DeepEval-formatted entries ready for JSON serialization
 */
export function exportToDeepEval(entries: ExportSourceEntry[]): DeepEvalEntry[] {
  return entries
    .filter((e) => e.golden.query)
    .map((e) => {
      const retrievedFiles = parseJsonArray(e.evalResult?.retrieved_files);
      const answer = parseAnswer(e.evalResult);

      // expected_output: prefer expectedAnswer, fall back to file paths
      const expectedOutput = e.golden.expectedAnswer
        ?? e.golden.expectedFilePaths?.join(', ')
        ?? '';

      return {
        input: e.golden.query,
        actual_output: answer,
        retrieval_context: retrievedFiles,
        expected_output: expectedOutput,
      };
    });
}

// ============================================================================
// WRITE EXPORT
// ============================================================================

/**
 * Write exported data to a JSON file.
 *
 * Creates parent directories if they don't exist.
 * Writes pretty-printed JSON (2-space indent) for human readability
 * and Python `json.load()` compatibility.
 *
 * @param data - The exported data array (RAGAS or DeepEval entries)
 * @param outputPath - Absolute or relative path for the output file
 * @throws EvalError with EVAL_RUN_FAILED code if write fails
 */
export function writeExport(data: RagasEntry[] | DeepEvalEntry[], outputPath: string): void {
  try {
    const dir = dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    throw EvalError.evalRunFailed(
      `Failed to write export to ${outputPath}: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined,
    );
  }
}

// ============================================================================
// PRIVATE HELPERS
// ============================================================================

/**
 * Safely parse a JSON-serialized string array.
 *
 * EvalResult stores retrieved_files and expected_files as JSON strings
 * in SQLite. This helper gracefully handles null, undefined, and
 * malformed JSON by returning an empty array.
 */
function parseJsonArray(jsonString: string | null | undefined): string[] {
  if (!jsonString) return [];
  try {
    const parsed = JSON.parse(jsonString);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Extract the answer text from an eval result.
 *
 * EvalResult doesn't directly store the answer (it's a retrieval-focused
 * record). Returns empty string — the answer field will be populated
 * when trace-based export is implemented (traces store the LLM answer).
 */
function parseAnswer(_evalResult?: EvalResult): string {
  // EvalResult stores retrieval data, not generation data.
  // Answer will come from EvalTrace when trace-based export is added.
  return '';
}
