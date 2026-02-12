/**
 * Golden Dataset Management Tests
 *
 * Tests CRUD operations for golden dataset files.
 * Uses a temp directory with mocked homedir() for isolation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock homedir before importing golden module
const testDir = join(tmpdir(), `ctx-golden-test-${Date.now()}`);

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return {
    ...original,
    homedir: () => testDir,
  };
});

// Import after mock is set up
import {
  getGoldenDatasetPath,
  loadGoldenDataset,
  saveGoldenDataset,
  addGoldenEntry,
  removeGoldenEntry,
  listGoldenEntries,
} from '../golden.js';
import { EvalError, EvalErrorCodes } from '../types.js';
import type { GoldenDataset, GoldenEntry } from '../types.js';

// ============================================================================
// SETUP / TEARDOWN
// ============================================================================

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Clean eval directory between tests for isolation
  const evalDir = join(testDir, '.ctx', 'eval');
  if (existsSync(evalDir)) {
    rmSync(evalDir, { recursive: true, force: true });
  }
});

// ============================================================================
// getGoldenDatasetPath
// ============================================================================

describe('getGoldenDatasetPath', () => {
  it('returns correct path for a project', () => {
    const path = getGoldenDatasetPath('my-app');
    expect(path).toBe(join(testDir, '.ctx', 'eval', 'my-app', 'golden.json'));
  });

  it('handles project names with special characters', () => {
    const path = getGoldenDatasetPath('my_app-v2');
    expect(path).toBe(join(testDir, '.ctx', 'eval', 'my_app-v2', 'golden.json'));
  });
});

// ============================================================================
// loadGoldenDataset
// ============================================================================

describe('loadGoldenDataset', () => {
  it('returns empty dataset when file does not exist', () => {
    const dataset = loadGoldenDataset('nonexistent-project');
    expect(dataset).toEqual({
      version: '1.0',
      projectName: 'nonexistent-project',
      entries: [],
    });
  });

  it('loads a valid golden dataset file', () => {
    const projectName = 'test-project';
    const filePath = getGoldenDatasetPath(projectName);
    const dir = join(testDir, '.ctx', 'eval', projectName);
    mkdirSync(dir, { recursive: true });

    const dataset: GoldenDataset = {
      version: '1.0',
      projectName,
      entries: [
        {
          id: 'entry-1',
          query: 'How does authentication work?',
          expectedFilePaths: ['src/auth/login.ts', 'src/auth/middleware.ts'],
          source: 'manual',
        },
      ],
    };

    writeFileSync(filePath, JSON.stringify(dataset, null, 2), 'utf-8');

    const loaded = loadGoldenDataset(projectName);
    expect(loaded).toEqual(dataset);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]!.query).toBe('How does authentication work?');
  });

  it('loads dataset with all optional fields', () => {
    const projectName = 'full-fields';
    const filePath = getGoldenDatasetPath(projectName);
    const dir = join(testDir, '.ctx', 'eval', projectName);
    mkdirSync(dir, { recursive: true });

    const dataset: GoldenDataset = {
      version: '1.0',
      projectName,
      entries: [
        {
          id: 'entry-full',
          query: 'What is the API endpoint for users?',
          expectedFilePaths: ['src/api/users.ts'],
          expectedAnswer: 'The users API is at /api/users',
          tags: ['api', 'users'],
          source: 'generated',
        },
      ],
    };

    writeFileSync(filePath, JSON.stringify(dataset, null, 2), 'utf-8');

    const loaded = loadGoldenDataset(projectName);
    expect(loaded.entries[0]!.expectedAnswer).toBe('The users API is at /api/users');
    expect(loaded.entries[0]!.tags).toEqual(['api', 'users']);
    expect(loaded.entries[0]!.source).toBe('generated');
  });

  it('throws EvalError for invalid JSON', () => {
    const projectName = 'bad-json';
    const filePath = getGoldenDatasetPath(projectName);
    const dir = join(testDir, '.ctx', 'eval', projectName);
    mkdirSync(dir, { recursive: true });

    writeFileSync(filePath, '{ not valid json!!!', 'utf-8');

    expect(() => loadGoldenDataset(projectName)).toThrow(EvalError);
    try {
      loadGoldenDataset(projectName);
    } catch (error) {
      expect(error).toBeInstanceOf(EvalError);
      expect((error as EvalError).code).toBe(EvalErrorCodes.DATASET_INVALID);
      expect((error as EvalError).message).toContain('invalid JSON');
    }
  });

  it('throws EvalError for valid JSON with wrong schema', () => {
    const projectName = 'bad-schema';
    const filePath = getGoldenDatasetPath(projectName);
    const dir = join(testDir, '.ctx', 'eval', projectName);
    mkdirSync(dir, { recursive: true });

    writeFileSync(filePath, JSON.stringify({ version: '2.0', entries: [] }), 'utf-8');

    expect(() => loadGoldenDataset(projectName)).toThrow(EvalError);
    try {
      loadGoldenDataset(projectName);
    } catch (error) {
      expect(error).toBeInstanceOf(EvalError);
      expect((error as EvalError).code).toBe(EvalErrorCodes.DATASET_INVALID);
      expect((error as EvalError).message).toContain('schema validation failed');
    }
  });

  it('throws EvalError when entries have invalid structure', () => {
    const projectName = 'bad-entries';
    const filePath = getGoldenDatasetPath(projectName);
    const dir = join(testDir, '.ctx', 'eval', projectName);
    mkdirSync(dir, { recursive: true });

    const badDataset = {
      version: '1.0',
      projectName,
      entries: [{ id: '', query: '', source: 'invalid_source' }],
    };

    writeFileSync(filePath, JSON.stringify(badDataset), 'utf-8');

    expect(() => loadGoldenDataset(projectName)).toThrow(EvalError);
  });
});

// ============================================================================
// saveGoldenDataset
// ============================================================================

describe('saveGoldenDataset', () => {
  it('creates directories and writes file', () => {
    const dataset: GoldenDataset = {
      version: '1.0',
      projectName: 'new-project',
      entries: [],
    };

    saveGoldenDataset(dataset);

    const filePath = getGoldenDatasetPath('new-project');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed).toEqual(dataset);
  });

  it('writes pretty-printed JSON', () => {
    const dataset: GoldenDataset = {
      version: '1.0',
      projectName: 'pretty-project',
      entries: [],
    };

    saveGoldenDataset(dataset);

    const filePath = getGoldenDatasetPath('pretty-project');
    const content = readFileSync(filePath, 'utf-8');

    // Pretty-printed JSON has newlines and indentation
    expect(content).toContain('\n');
    expect(content).toBe(JSON.stringify(dataset, null, 2));
  });

  it('overwrites existing file', () => {
    const dataset1: GoldenDataset = {
      version: '1.0',
      projectName: 'overwrite-test',
      entries: [{ id: '1', query: 'first', source: 'manual', expectedFilePaths: ['a.ts'] }],
    };

    const dataset2: GoldenDataset = {
      version: '1.0',
      projectName: 'overwrite-test',
      entries: [{ id: '2', query: 'second', source: 'manual', expectedFilePaths: ['b.ts'] }],
    };

    saveGoldenDataset(dataset1);
    saveGoldenDataset(dataset2);

    const loaded = loadGoldenDataset('overwrite-test');
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]!.query).toBe('second');
  });

  it('roundtrips dataset with entries', () => {
    const dataset: GoldenDataset = {
      version: '1.0',
      projectName: 'roundtrip-test',
      entries: [
        {
          id: 'rt-1',
          query: 'How does search work?',
          expectedFilePaths: ['src/search/engine.ts'],
          expectedAnswer: 'Search uses BM25 + dense hybrid retrieval',
          tags: ['search', 'core'],
          source: 'manual',
        },
        {
          id: 'rt-2',
          query: 'Where is the config?',
          expectedFilePaths: ['src/config/loader.ts'],
          source: 'captured',
        },
      ],
    };

    saveGoldenDataset(dataset);
    const loaded = loadGoldenDataset('roundtrip-test');
    expect(loaded).toEqual(dataset);
  });
});

// ============================================================================
// addGoldenEntry
// ============================================================================

describe('addGoldenEntry', () => {
  it('adds entry with generated UUID', () => {
    const entry = addGoldenEntry('add-test', {
      query: 'How does indexing work?',
      expectedFilePaths: ['src/indexer/index.ts'],
      source: 'manual',
    });

    expect(entry.id).toBeDefined();
    expect(entry.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(entry.query).toBe('How does indexing work?');
    expect(entry.source).toBe('manual');
  });

  it('persists entry to disk', () => {
    addGoldenEntry('persist-test', {
      query: 'What is the database schema?',
      expectedFilePaths: ['src/database/schema.ts'],
      source: 'manual',
    });

    const entries = listGoldenEntries('persist-test');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.query).toBe('What is the database schema?');
  });

  it('appends to existing entries', () => {
    addGoldenEntry('append-test', {
      query: 'First query',
      expectedFilePaths: ['a.ts'],
      source: 'manual',
    });

    addGoldenEntry('append-test', {
      query: 'Second query',
      expectedFilePaths: ['b.ts'],
      source: 'generated',
    });

    const entries = listGoldenEntries('append-test');
    expect(entries).toHaveLength(2);
    expect(entries[0]!.query).toBe('First query');
    expect(entries[1]!.query).toBe('Second query');
  });

  it('generates unique IDs for each entry', () => {
    const entry1 = addGoldenEntry('unique-id-test', {
      query: 'Query 1',
      expectedFilePaths: ['a.ts'],
      source: 'manual',
    });

    const entry2 = addGoldenEntry('unique-id-test', {
      query: 'Query 2',
      expectedFilePaths: ['b.ts'],
      source: 'manual',
    });

    expect(entry1.id).not.toBe(entry2.id);
  });

  it('accepts entry with only expectedAnswer (no file paths)', () => {
    const entry = addGoldenEntry('answer-only', {
      query: 'What is the project about?',
      expectedAnswer: 'A CLI tool for code context management',
      source: 'manual',
    });

    expect(entry.expectedAnswer).toBe('A CLI tool for code context management');
    expect(entry.expectedFilePaths).toBeUndefined();
  });

  it('accepts entry with tags', () => {
    const entry = addGoldenEntry('tags-test', {
      query: 'How does auth work?',
      expectedFilePaths: ['src/auth.ts'],
      tags: ['auth', 'critical'],
      source: 'manual',
    });

    expect(entry.tags).toEqual(['auth', 'critical']);
  });

  it('throws on empty query', () => {
    expect(() =>
      addGoldenEntry('empty-query', {
        query: '',
        expectedFilePaths: ['a.ts'],
        source: 'manual',
      })
    ).toThrow(EvalError);
  });

  it('throws on whitespace-only query', () => {
    expect(() =>
      addGoldenEntry('whitespace-query', {
        query: '   ',
        expectedFilePaths: ['a.ts'],
        source: 'manual',
      })
    ).toThrow(EvalError);
  });

  it('throws when neither expectedFilePaths nor expectedAnswer provided', () => {
    expect(() =>
      addGoldenEntry('no-expected', {
        query: 'Valid query',
        source: 'manual',
      })
    ).toThrow(EvalError);

    try {
      addGoldenEntry('no-expected-2', {
        query: 'Valid query',
        source: 'manual',
      });
    } catch (error) {
      expect((error as EvalError).code).toBe(EvalErrorCodes.DATASET_INVALID);
      expect((error as EvalError).message).toContain('expectedFilePaths');
    }
  });

  it('throws when expectedFilePaths is empty array', () => {
    expect(() =>
      addGoldenEntry('empty-paths', {
        query: 'Valid query',
        expectedFilePaths: [],
        source: 'manual',
      })
    ).toThrow(EvalError);
  });
});

// ============================================================================
// removeGoldenEntry
// ============================================================================

describe('removeGoldenEntry', () => {
  it('removes entry by ID and returns true', () => {
    const entry = addGoldenEntry('remove-test', {
      query: 'To be removed',
      expectedFilePaths: ['a.ts'],
      source: 'manual',
    });

    const removed = removeGoldenEntry('remove-test', entry.id);
    expect(removed).toBe(true);

    const entries = listGoldenEntries('remove-test');
    expect(entries).toHaveLength(0);
  });

  it('returns false for non-existent entry ID', () => {
    addGoldenEntry('remove-miss-test', {
      query: 'Keep me',
      expectedFilePaths: ['a.ts'],
      source: 'manual',
    });

    const removed = removeGoldenEntry('remove-miss-test', 'non-existent-id');
    expect(removed).toBe(false);

    const entries = listGoldenEntries('remove-miss-test');
    expect(entries).toHaveLength(1);
  });

  it('returns false for non-existent project', () => {
    const removed = removeGoldenEntry('ghost-project', 'any-id');
    expect(removed).toBe(false);
  });

  it('removes only the targeted entry', () => {
    const entry1 = addGoldenEntry('selective-remove', {
      query: 'Keep this',
      expectedFilePaths: ['a.ts'],
      source: 'manual',
    });

    const entry2 = addGoldenEntry('selective-remove', {
      query: 'Remove this',
      expectedFilePaths: ['b.ts'],
      source: 'manual',
    });

    const entry3 = addGoldenEntry('selective-remove', {
      query: 'Also keep',
      expectedFilePaths: ['c.ts'],
      source: 'manual',
    });

    removeGoldenEntry('selective-remove', entry2.id);

    const entries = listGoldenEntries('selective-remove');
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.id)).toEqual([entry1.id, entry3.id]);
  });
});

// ============================================================================
// listGoldenEntries
// ============================================================================

describe('listGoldenEntries', () => {
  it('returns empty array for non-existent project', () => {
    const entries = listGoldenEntries('no-such-project');
    expect(entries).toEqual([]);
  });

  it('returns all entries from dataset', () => {
    addGoldenEntry('list-test', {
      query: 'First',
      expectedFilePaths: ['a.ts'],
      source: 'manual',
    });

    addGoldenEntry('list-test', {
      query: 'Second',
      expectedFilePaths: ['b.ts'],
      source: 'generated',
    });

    addGoldenEntry('list-test', {
      query: 'Third',
      expectedAnswer: 'Some answer',
      source: 'captured',
    });

    const entries = listGoldenEntries('list-test');
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.source)).toEqual(['manual', 'generated', 'captured']);
  });

  it('returns entries preserving order', () => {
    addGoldenEntry('order-test', {
      query: 'Alpha',
      expectedFilePaths: ['a.ts'],
      source: 'manual',
    });

    addGoldenEntry('order-test', {
      query: 'Beta',
      expectedFilePaths: ['b.ts'],
      source: 'manual',
    });

    addGoldenEntry('order-test', {
      query: 'Gamma',
      expectedFilePaths: ['c.ts'],
      source: 'manual',
    });

    const entries = listGoldenEntries('order-test');
    expect(entries.map((e) => e.query)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });
});
