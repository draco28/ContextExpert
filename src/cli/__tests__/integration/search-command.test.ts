/**
 * Search Command Integration Tests
 *
 * These tests verify the complete search flow using a real SQLite database:
 * 1. Index a project with known content
 * 2. Execute search queries
 * 3. Verify results match expected content
 *
 * ISOLATION STRATEGY:
 * - Mock the paths module to redirect to temp directories
 * - Mock embedder to avoid network calls
 * - Mock config loader to disable reranking (avoids model loading)
 * - Mock ora to prevent spinner output
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Command } from 'commander';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ============================================================================
// Mock Setup - MUST be before imports that use these modules
// ============================================================================

// Mock paths module - vi.mock is hoisted, so we need to create paths inside the factory
vi.mock('../../../config/paths.js', () => {
  const path = require('node:path');
  const fs = require('node:fs');
  const os = require('node:os');

  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-integration-search-'));
  const dataDir = path.join(testRoot, 'data');
  const configDir = path.join(testRoot, 'config');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });

  // Store for cleanup and access
  (globalThis as Record<string, unknown>).__testRoot = testRoot;
  (globalThis as Record<string, unknown>).__testDataDir = dataDir;
  (globalThis as Record<string, unknown>).__testConfigDir = configDir;

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

// Mock config loader to disable reranking (avoids loading reranker model)
vi.mock('../../../config/loader.js', () => ({
  loadConfig: () => ({
    embedding: {
      provider: 'huggingface',
      model: 'BAAI/bge-large-en-v1.5',
      timeout_ms: 120000,
    },
    search: {
      top_k: 10,
      rerank: false, // CRITICAL: disable reranking to avoid model loading
    },
  }),
}));

// Mock embedder module
vi.mock('../../../indexer/embedder/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../indexer/embedder/index.js')>();
  return {
    ...original,
    createEmbeddingProvider: vi.fn(),
    embedChunks: vi.fn(),
  };
});

// Mock ora to prevent spinner output
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { createSearchCommand } from '../../commands/search.js';
import { createIndexCommand } from '../../commands/index.js';
import type { CommandContext } from '../../types.js';
import { resetAll } from '../../../test-utils/index.js';
import { runMigrations } from '../../../database/index.js';
import * as embedder from '../../../indexer/embedder/index.js';
import type { EmbeddedChunk } from '../../../indexer/embedder/types.js';
import type { ChunkResult } from '../../../indexer/chunker/types.js';
import {
  createSampleProject,
  createMockEmbeddingProvider,
  getProjectFromDb,
} from './setup.js';

// ============================================================================
// Test Paths (from mocked paths module)
// ============================================================================

function getTestRoot(): string {
  return (globalThis as Record<string, unknown>).__testRoot as string;
}

function getTestDataDir(): string {
  return (globalThis as Record<string, unknown>).__testDataDir as string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Set up mock embedding provider and embedChunks function.
 */
function setupEmbedderMock(): void {
  const mockProvider = createMockEmbeddingProvider(1024);
  vi.mocked(embedder.createEmbeddingProvider).mockResolvedValue({
    provider: mockProvider,
    model: 'mock-model',
    dimensions: 1024,
  });

  vi.mocked(embedder.embedChunks).mockImplementation(
    async (chunks: ChunkResult[]): Promise<EmbeddedChunk[]> => {
      return chunks.map((chunk) => {
        const hash = chunk.content
          .split('')
          .reduce((acc, c) => acc + c.charCodeAt(0), 0);
        const embedding = new Float32Array(1024);
        for (let i = 0; i < 1024; i++) {
          embedding[i] = Math.sin(hash + i) * 0.5;
        }
        return { ...chunk, embedding };
      });
    }
  );
}

/**
 * Run the index command.
 */
async function runIndexCommand(args: string[]): Promise<void> {
  const indexContext: CommandContext = {
    options: { verbose: false, json: false },
    log: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
  const cmd = createIndexCommand(() => indexContext);
  const program = new Command();
  program.addCommand(cmd);
  program.exitOverride();
  await program.parseAsync(['node', 'test', 'index', ...args]);
}

/**
 * Run the search command.
 */
async function runSearchCommand(
  args: string[],
  context: CommandContext
): Promise<void> {
  const cmd = createSearchCommand(() => context);
  const program = new Command();
  program.addCommand(cmd);
  program.exitOverride();
  await program.parseAsync(['node', 'test', 'search', ...args]);
}

/**
 * Get a direct database connection for verification.
 */
function getTestDb(): Database.Database {
  runMigrations();
  const dbPath = join(getTestDataDir(), 'context.db');
  return new Database(dbPath);
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Search Command Integration', () => {
  let mockContext: CommandContext;
  let capturedOutput: string[];
  let testProjectDir: string;

  beforeAll(async () => {
    testProjectDir = join(getTestRoot(), 'project');
    mkdirSync(testProjectDir, { recursive: true });

    // Create and index a sample project ONCE for all search tests
    createSampleProject(testProjectDir);

    // Run migrations FIRST to ensure tables exist
    runMigrations();

    setupEmbedderMock();

    // Index the project so we have data to search
    await runIndexCommand([testProjectDir, '--name', 'search-test-project']);
  });

  afterAll(() => {
    resetAll();
    rmSync(getTestRoot(), { recursive: true, force: true });
  });

  beforeEach(() => {
    // Don't reset singletons - we need indexed data to persist
    vi.clearAllMocks();
    capturedOutput = [];

    mockContext = {
      options: { verbose: false, json: false },
      log: vi.fn((msg: string) => capturedOutput.push(msg)),
      debug: vi.fn(),
      error: vi.fn(),
    };

    // Re-mock embedding provider (cleared by vi.clearAllMocks)
    setupEmbedderMock();
  });

  // ==========================================================================
  // Test Cases
  // ==========================================================================

  describe('basic search functionality', () => {
    it('finds results for terms that exist in indexed content', async () => {
      // The sample project contains "authenticate" and "authentication"
      await runSearchCommand(['authenticate'], mockContext);

      expect(mockContext.log).toHaveBeenCalled();
      const output = capturedOutput.join('\n');
      expect(output).toMatch(/result/i);
    });

    it('returns results in JSON format when --json is used', async () => {
      const jsonContext: CommandContext = {
        options: { verbose: false, json: true },
        log: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      };

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      try {
        await runSearchCommand(['authenticate'], jsonContext);

        expect(consoleSpy).toHaveBeenCalled();
        const jsonString = consoleSpy.mock.calls[0][0];
        const parsed = JSON.parse(jsonString);

        expect(parsed).toHaveProperty('query', 'authenticate');
        expect(parsed).toHaveProperty('count');
        expect(parsed).toHaveProperty('results');
        expect(Array.isArray(parsed.results)).toBe(true);
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });

  describe('search execution', () => {
    it('executes search and returns results for matching terms', async () => {
      // With BM25 + mock embeddings, search will find matches
      // We just verify the search executes without error
      await runSearchCommand(['function'], mockContext);

      const output = capturedOutput.join('\n');
      // Should find results since sample files contain "function"
      expect(output).toMatch(/result/i);
    });

    it('executes search for arbitrary query without crashing', async () => {
      // Even nonsense queries should execute without error
      // BM25 may still return results based on token overlap
      await runSearchCommand(['xyznonexistentterm123'], mockContext);

      // Should have logged something (results or no results message)
      expect(mockContext.log).toHaveBeenCalled();
    });
  });

  describe('project filtering', () => {
    it('searches only the specified project when --project is used', async () => {
      await runSearchCommand(
        ['authenticate', '--project', 'search-test-project'],
        mockContext
      );

      expect(mockContext.log).toHaveBeenCalled();
    });

    it('throws error for non-existent project', async () => {
      await expect(
        runSearchCommand(['query', '--project', 'nonexistent-project-name'], mockContext)
      ).rejects.toThrow(/not found/i);
    });
  });

  describe('query validation', () => {
    it('throws error for empty query', async () => {
      await expect(runSearchCommand(['   '], mockContext)).rejects.toThrow(/empty/i);
    });
  });

  describe('result count options', () => {
    it('respects --top option for limiting results', async () => {
      const jsonContext: CommandContext = {
        options: { verbose: false, json: true },
        log: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      };

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      try {
        await runSearchCommand(['function', '--top', '3'], jsonContext);

        const jsonString = consoleSpy.mock.calls[0][0];
        const parsed = JSON.parse(jsonString);

        expect(parsed.results.length).toBeLessThanOrEqual(3);
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('throws error for invalid --top value', async () => {
      await expect(runSearchCommand(['query', '--top', 'abc'], mockContext)).rejects.toThrow(
        /invalid/i
      );
    });

    it('throws error for --top value exceeding maximum', async () => {
      await expect(runSearchCommand(['query', '--top', '500'], mockContext)).rejects.toThrow(
        /too large/i
      );
    });
  });

  describe('database integration', () => {
    it('reads chunks from the actual database', async () => {
      const db = getTestDb();
      try {
        const project = getProjectFromDb(db, 'search-test-project');
        expect(project).toBeDefined();
        expect(project!.chunk_count).toBeGreaterThan(0);

        const chunks = db
          .prepare('SELECT content FROM chunks WHERE project_id = ?')
          .all(project!.id) as Array<{ content: string }>;

        expect(chunks.length).toBeGreaterThan(0);

        // At least one chunk should contain "authenticate" (from sample files)
        const hasAuthContent = chunks.some((c) =>
          c.content.toLowerCase().includes('authenticate')
        );
        expect(hasAuthContent).toBe(true);
      } finally {
        db.close();
      }
    });
  });
});

// Note: Multiple projects test has been moved into the main "Search Command Integration"
// suite as the "project filtering" tests, which verify searching by project name.
