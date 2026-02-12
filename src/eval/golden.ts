/**
 * Golden Dataset Management
 *
 * CRUD operations for golden dataset files stored at ~/.ctx/eval/<project>/golden.json.
 * Golden datasets define test cases for evaluating RAG retrieval quality.
 *
 * Uses expectedFilePaths (not chunk IDs) so datasets survive re-indexing.
 *
 * Pattern: Follows src/config/providers.ts for file I/O (sync fs, graceful defaults, Zod validation).
 */

import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { GoldenDataset, GoldenEntry } from './types.js';
import { EvalError } from './types.js';

// ============================================================================
// VALIDATION SCHEMA (for golden.json file format)
// ============================================================================

/**
 * Zod schema for validating golden.json files on load.
 *
 * Mirrors the GoldenDataset/GoldenEntry interfaces but provides
 * runtime validation for files that could be hand-edited or corrupted.
 */
const GoldenEntrySchema = z.object({
  id: z.string().min(1),
  query: z.string().min(1),
  expectedFilePaths: z.array(z.string()).optional(),
  expectedAnswer: z.string().optional(),
  tags: z.array(z.string()).optional(),
  source: z.enum(['manual', 'generated', 'captured']),
});

const GoldenDatasetSchema = z.object({
  version: z.literal('1.0'),
  projectName: z.string().min(1),
  entries: z.array(GoldenEntrySchema),
});

// ============================================================================
// PATH MANAGEMENT
// ============================================================================

/**
 * Get the file path for a project's golden dataset.
 *
 * Structure: ~/.ctx/eval/<projectName>/golden.json
 *
 * @param projectName - Project name (used as directory name)
 * @returns Absolute path to the golden.json file
 */
export function getGoldenDatasetPath(projectName: string): string {
  return join(homedir(), '.ctx', 'eval', projectName, 'golden.json');
}

// ============================================================================
// LOAD / SAVE
// ============================================================================

/**
 * Load a project's golden dataset from disk.
 *
 * Returns an empty dataset if the file doesn't exist (graceful default).
 * Throws EvalError.datasetInvalid if the file exists but has invalid content.
 *
 * @param projectName - Project name
 * @returns Golden dataset (possibly empty)
 * @throws EvalError with code DATASET_INVALID if file content is malformed
 */
export function loadGoldenDataset(projectName: string): GoldenDataset {
  const filePath = getGoldenDatasetPath(projectName);

  if (!fs.existsSync(filePath)) {
    return { version: '1.0', projectName, entries: [] };
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    return GoldenDatasetSchema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw EvalError.datasetInvalid(`schema validation failed: ${issues}`);
    }
    if (error instanceof SyntaxError) {
      throw EvalError.datasetInvalid('file contains invalid JSON');
    }
    throw error;
  }
}

/**
 * Save a golden dataset to disk.
 *
 * Creates the parent directory if it doesn't exist.
 * Writes pretty-printed JSON (2-space indent) for human readability.
 *
 * @param dataset - Golden dataset to save
 */
export function saveGoldenDataset(dataset: GoldenDataset): void {
  const filePath = getGoldenDatasetPath(dataset.projectName);
  const dir = dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, JSON.stringify(dataset, null, 2), 'utf-8');
}

// ============================================================================
// CRUD OPERATIONS
// ============================================================================

/**
 * Add a new entry to a project's golden dataset.
 *
 * Generates a UUID for the entry, appends it, and saves the dataset.
 * Creates the dataset file if it doesn't exist.
 *
 * @param projectName - Project name
 * @param entry - Entry data (id is generated automatically)
 * @returns The created entry with its generated ID
 * @throws EvalError with code DATASET_INVALID if entry has no query or no expected results
 */
export function addGoldenEntry(
  projectName: string,
  entry: Omit<GoldenEntry, 'id'>
): GoldenEntry {
  if (!entry.query || entry.query.trim().length === 0) {
    throw EvalError.datasetInvalid('entry query must be a non-empty string');
  }

  if (!entry.expectedFilePaths?.length && !entry.expectedAnswer) {
    throw EvalError.datasetInvalid(
      'entry must have at least one of expectedFilePaths or expectedAnswer'
    );
  }

  const dataset = loadGoldenDataset(projectName);

  const newEntry: GoldenEntry = {
    id: randomUUID(),
    ...entry,
  };

  dataset.entries.push(newEntry);
  saveGoldenDataset(dataset);

  return newEntry;
}

/**
 * Remove an entry from a project's golden dataset by ID.
 *
 * @param projectName - Project name
 * @param entryId - UUID of the entry to remove
 * @returns true if the entry was found and removed, false if not found
 */
export function removeGoldenEntry(projectName: string, entryId: string): boolean {
  const dataset = loadGoldenDataset(projectName);
  const originalLength = dataset.entries.length;

  dataset.entries = dataset.entries.filter((e) => e.id !== entryId);

  if (dataset.entries.length === originalLength) {
    return false;
  }

  saveGoldenDataset(dataset);
  return true;
}

/**
 * List all entries in a project's golden dataset.
 *
 * Returns an empty array if no dataset file exists.
 *
 * @param projectName - Project name
 * @returns Array of golden entries
 */
export function listGoldenEntries(projectName: string): GoldenEntry[] {
  const dataset = loadGoldenDataset(projectName);
  return dataset.entries;
}
