/**
 * E2E Workflow Tests
 *
 * Tests the complete user journey: index → search → ask → chat
 *
 * These tests verify that:
 * 1. Projects can be indexed and stored in the database
 * 2. Search returns relevant chunks from indexed content
 * 3. Ask generates answers with proper citations
 * 4. Chat session commands work correctly
 *
 * Mocking Strategy:
 * - Paths: Redirected to temp directories (isolated from ~/.ctx)
 * - Embeddings: Deterministic hash-based (fast, reproducible)
 * - LLM: Scripted responses with citations (deterministic)
 * - Database: Real SQLite (tests actual storage logic)
 * - Filesystem: Real temp directories (tests actual file operations)
 */

import { mkdirSync, rmSync, realpathSync } from 'node:fs';
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
 * This is the critical foundation for integration/e2e tests.
 * By redirecting all paths to a temp directory, we:
 * 1. Don't pollute the user's real data
 * 2. Get isolation between test runs
 * 3. Can clean up completely after tests
 *
 * NOTE: vi.mock factories run synchronously, so we use require() style imports.
 */
vi.mock('../../config/paths.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os');

  // Create unique temp directory for this test run
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-e2e-'));
  const dataDir = path.join(testRoot, 'data');
  const configDir = path.join(testRoot, 'config');

  // Store for cleanup and access in tests
  globalThis.__e2eTestRoot = testRoot;
  globalThis.__e2eDataDir = dataDir;
  globalThis.__e2eDbPath = path.join(dataDir, 'context.db');

  // Create directories
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
 * Mock embedding provider to use deterministic hash-based embeddings.
 *
 * Real embeddings (HuggingFace BGE) would:
 * 1. Take ~2s to load the model on first run
 * 2. Download ~300MB model if not cached
 * 3. Be slower for each embedding call
 *
 * Our mock generates consistent embeddings from text content,
 * allowing search to work predictably in tests.
 *
 * NOTE: We mock BOTH import paths because different modules import
 * createEmbeddingProvider from different locations:
 * - search.ts imports from indexer/embedder/index.js
 * - rag-engine.ts imports from indexer/embedder/provider.js
 */
vi.mock('../../indexer/embedder/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../indexer/embedder/index.js')>();

  return {
    ...original,
    createEmbeddingProvider: vi.fn(),
    embedChunks: vi.fn(),
  };
});

// Also mock the direct provider path for rag-engine.ts
vi.mock('../../indexer/embedder/provider.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../indexer/embedder/provider.js')>();

  return {
    ...original,
    createEmbeddingProvider: vi.fn(),
  };
});

/**
 * Mock LLM provider to return deterministic responses.
 *
 * Real LLM calls (Z.AI GLM-4.7) would:
 * 1. Cost API credits
 * 2. Return non-deterministic responses
 * 3. Be slow (~1-2s per call)
 *
 * Our mock returns pre-defined responses with embedded citations.
 */
vi.mock('../../providers/llm.js', () => ({
  createLLMProvider: vi.fn(),
}));

/**
 * Mock config loader to use test-friendly settings.
 *
 * Key changes:
 * - Disable reranking (requires model loading, slow)
 * - Use mock provider settings
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
      rerank: false, // Disable reranking for faster tests
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

import { runMigrations, getDb, resetDatabase, closeDb } from '../../database/index.js';
import { resetVectorStoreManager } from '../../search/store.js';
import { resetBM25StoreManager } from '../../search/bm25-store.js';
import * as embedder from '../../indexer/embedder/index.js';
import * as embedderProvider from '../../indexer/embedder/provider.js';
import * as llmProvider from '../../providers/llm.js';
import { createIndexCommand } from '../../cli/commands/index.js';
import { createSearchCommand } from '../../cli/commands/search.js';
import { createAskCommand } from '../../cli/commands/ask.js';
import { parseREPLCommand, createCompleter } from '../../cli/commands/chat.js';
import type { CommandContext } from '../../cli/types.js';

import {
  createSampleProject,
  createMockEmbeddingProvider,
  getProjectFromDb,
  countChunksInDb,
  DEFAULT_SAMPLE_FILES,
  createMockLLMProvider,
  DEFAULT_MOCK_RESPONSES,
  verifyCitations,
  extractCitationReferences,
  captureStdout,
} from './setup.js';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Get the test root directory (set by paths mock).
 */
function getTestRoot(): string {
  return globalThis.__e2eTestRoot;
}

/**
 * Reset all singletons between tests.
 *
 * This is critical for test isolation. Without it:
 * - Database connections persist between tests
 * - Vector store caches contain stale data
 * - BM25 indexes have old content
 */
function resetAll(): void {
  resetVectorStoreManager();
  resetBM25StoreManager();
  resetDatabase();
  closeDb();
}

/**
 * Create a mock command context for testing CLI commands.
 *
 * The context provides:
 * - options: Global flags (verbose, json)
 * - log/debug/error: Output functions (mocked for testing)
 */
function createMockContext(options: { verbose?: boolean; json?: boolean } = {}): CommandContext {
  return {
    options: {
      verbose: options.verbose ?? false,
      json: options.json ?? false,
    },
    log: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * Setup the embedder mock with our deterministic provider.
 *
 * Called before each test to ensure fresh mock state.
 *
 * NOTE: We mock BOTH import paths because:
 * - embedder.createEmbeddingProvider is used by search.ts
 * - embedderProvider.createEmbeddingProvider is used by rag-engine.ts
 */
function setupEmbedderMock(): void {
  const mockProvider = createMockEmbeddingProvider(1024);

  // The return format expected by CLI commands
  const mockResult = {
    provider: mockProvider,
    model: 'mock-model',
    dimensions: 1024,
  };

  // Mock both import paths
  vi.mocked(embedder.createEmbeddingProvider).mockResolvedValue(mockResult);
  vi.mocked(embedderProvider.createEmbeddingProvider).mockResolvedValue(mockResult);

  vi.mocked(embedder.embedChunks).mockImplementation(async (chunks) => {
    const results = await mockProvider.embedBatch(chunks.map((c) => c.content));
    return chunks.map((chunk, i) => ({
      ...chunk,
      embedding: results[i]!.embedding,
    }));
  });
}

/**
 * Setup the LLM mock with deterministic responses.
 *
 * Called before each test to ensure fresh mock state.
 */
function setupLLMMock(): void {
  const mockLLM = createMockLLMProvider({
    responses: DEFAULT_MOCK_RESPONSES,
    defaultResponse: 'I could not find relevant information in the provided context.',
  });

  vi.mocked(llmProvider.createLLMProvider).mockResolvedValue({
    provider: mockLLM,
    name: 'mock',
    model: 'mock-model',
  });
}

/**
 * Run the index command programmatically.
 *
 * NOTE: We wrap the subcommand in a parent Command because Commander.js
 * needs the full program structure to parse arguments correctly.
 *
 * @param args - Command arguments (e.g., ['/path/to/project', '--name', 'my-project'])
 * @param ctx - Command context (optional, creates mock if not provided)
 */
async function runIndexCommand(
  args: string[],
  ctx: CommandContext = createMockContext()
): Promise<void> {
  const { Command } = await import('commander');
  const cmd = createIndexCommand(() => ctx);
  const program = new Command();
  program.addCommand(cmd);
  program.exitOverride(); // Don't exit process on error

  await program.parseAsync(['node', 'test', 'index', ...args]);
}

/**
 * Run the search command programmatically.
 *
 * @param args - Command arguments (e.g., ['authentication', '--project', 'my-project'])
 * @param ctx - Command context
 * @returns The context (for inspecting captured output)
 */
async function runSearchCommand(
  args: string[],
  ctx: CommandContext = createMockContext()
): Promise<CommandContext> {
  const { Command } = await import('commander');
  const cmd = createSearchCommand(() => ctx);
  const program = new Command();
  program.addCommand(cmd);
  program.exitOverride();

  await program.parseAsync(['node', 'test', 'search', ...args]);
  return ctx;
}

/**
 * Run the ask command programmatically.
 *
 * @param args - Command arguments (e.g., ['How does auth work?', '--project', 'my-project'])
 * @param ctx - Command context
 * @returns The context (for inspecting captured output)
 */
async function runAskCommand(
  args: string[],
  ctx: CommandContext = createMockContext()
): Promise<CommandContext> {
  const { Command } = await import('commander');
  const cmd = createAskCommand(() => ctx);
  const program = new Command();
  program.addCommand(cmd);
  program.exitOverride();

  await program.parseAsync(['node', 'test', 'ask', ...args]);
  return ctx;
}

// ============================================================================
// Test Suites
// ============================================================================

describe('E2E Workflow Tests', () => {
  let testProjectDir: string;
  const PROJECT_NAME = 'e2e-test-project';

  // ──────────────────────────────────────────────────────────────────────────
  // Setup: Run ONCE before all tests
  // ──────────────────────────────────────────────────────────────────────────

  beforeAll(async () => {
    // 1. Create sample project in temp directory
    testProjectDir = join(getTestRoot(), 'sample-project');
    mkdirSync(testProjectDir, { recursive: true });
    createSampleProject(testProjectDir, DEFAULT_SAMPLE_FILES);

    // 2. Run database migrations
    runMigrations();

    // 3. Setup mocks
    setupEmbedderMock();
    setupLLMMock();

    // 4. Index the sample project ONCE for all tests
    //    This mimics a user running: ctx index ./sample-project --name e2e-test-project
    await runIndexCommand([testProjectDir, '--name', PROJECT_NAME]);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Cleanup: Run ONCE after all tests
  // ──────────────────────────────────────────────────────────────────────────

  afterAll(() => {
    resetAll();
    // Clean up temp directory
    try {
      rmSync(getTestRoot(), { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors (Windows file locking, etc.)
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Reset: Run before EACH test
  // ──────────────────────────────────────────────────────────────────────────

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-setup mocks that were cleared
    setupEmbedderMock();
    setupLLMMock();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Suite 1: Index Phase
  // ══════════════════════════════════════════════════════════════════════════

  describe('Index Phase', () => {
    it('creates project entry in database', () => {
      const db = new Database(globalThis.__e2eDbPath);

      try {
        const project = getProjectFromDb(db, PROJECT_NAME);

        expect(project).toBeDefined();
        expect(project!.name).toBe(PROJECT_NAME);
        // Use realpathSync to handle macOS /var → /private/var symlink
        expect(realpathSync(project!.path)).toBe(realpathSync(testProjectDir));
      } finally {
        db.close();
      }
    });

    it('stores chunks with embeddings', () => {
      const db = new Database(globalThis.__e2eDbPath);

      try {
        const project = getProjectFromDb(db, PROJECT_NAME);
        expect(project).toBeDefined();

        const chunkCount = countChunksInDb(db, project!.id);

        // DEFAULT_SAMPLE_FILES has 5 files, should produce multiple chunks
        expect(chunkCount).toBeGreaterThan(0);

        // Verify chunks have embeddings (stored as BLOBs)
        const chunk = db
          .prepare('SELECT embedding FROM chunks WHERE project_id = ? LIMIT 1')
          .get(project!.id) as { embedding: Buffer } | undefined;

        expect(chunk).toBeDefined();
        expect(chunk!.embedding).toBeInstanceOf(Buffer);
        // 1024 dimensions * 4 bytes per float = 4096 bytes
        expect(chunk!.embedding.length).toBe(1024 * 4);
      } finally {
        db.close();
      }
    });

    it('tracks file count in project metadata', () => {
      const db = new Database(globalThis.__e2eDbPath);

      try {
        const project = getProjectFromDb(db, PROJECT_NAME);

        expect(project).toBeDefined();
        // DEFAULT_SAMPLE_FILES has 5 files
        expect(project!.file_count).toBe(DEFAULT_SAMPLE_FILES.length);
      } finally {
        db.close();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Suite 2: Search Phase
  // ══════════════════════════════════════════════════════════════════════════

  describe('Search Phase', () => {
    it('finds relevant chunks for query', async () => {
      const ctx = createMockContext();
      await runSearchCommand(['authenticate', '--project', PROJECT_NAME], ctx);

      // Search should call log with results
      expect(ctx.log).toHaveBeenCalled();

      // Check that results were found (log called multiple times for formatting)
      const logCalls = vi.mocked(ctx.log).mock.calls;
      const allOutput = logCalls.map((call) => call[0]).join('\n');

      // Should mention auth-related files
      expect(allOutput).toMatch(/auth\.ts|token\.ts|authentication/i);
    });

    it('returns JSON output when json option is set', async () => {
      const ctx = createMockContext({ json: true });

      // Spy on console.log because JSON output goes directly there
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      try {
        await runSearchCommand(['token', '--project', PROJECT_NAME], ctx);

        expect(consoleSpy).toHaveBeenCalled();
        const jsonString = consoleSpy.mock.calls[0]?.[0] as string;
        const parsed = JSON.parse(jsonString);

        expect(parsed).toHaveProperty('results');
        expect(Array.isArray(parsed.results)).toBe(true);
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('handles empty results gracefully', async () => {
      const ctx = createMockContext();
      await runSearchCommand(['xyznonexistentquery123', '--project', PROJECT_NAME], ctx);

      // Should not throw, and should indicate no results
      const logCalls = vi.mocked(ctx.log).mock.calls;
      const allOutput = logCalls.map((call) => call[0]).join('\n');

      // Either shows "no results" message or empty results
      expect(ctx.error).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Suite 3: Ask Phase
  // ══════════════════════════════════════════════════════════════════════════

  describe('Ask Phase', () => {
    it('generates answer using RAG context', async () => {
      const capture = captureStdout();

      try {
        const ctx = createMockContext();
        await runAskCommand(
          ['How does authentication work?', '--project', PROJECT_NAME],
          ctx
        );

        const output = capture.getContent();

        // Should contain authentication-related content from mock LLM
        expect(output).toMatch(/authenticate|auth\.ts|password/i);
      } finally {
        capture.restore();
      }
    });

    it('includes citations in response', async () => {
      const capture = captureStdout();

      try {
        const ctx = createMockContext();
        await runAskCommand(
          ['How does authentication work?', '--project', PROJECT_NAME],
          ctx
        );

        const output = capture.getContent();

        // Mock response includes [1], [2] citations
        const citations = extractCitationReferences(output);
        expect(citations.length).toBeGreaterThan(0);
      } finally {
        capture.restore();
      }
    });

    it('returns JSON output with sources when json option is set', async () => {
      const ctx = createMockContext({ json: true });

      // Spy on console.log because JSON output goes directly there
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      try {
        await runAskCommand(
          ['How does token validation work?', '--project', PROJECT_NAME],
          ctx
        );

        expect(consoleSpy).toHaveBeenCalled();
        const jsonString = consoleSpy.mock.calls[0]?.[0] as string;
        const parsed = JSON.parse(jsonString);

        expect(parsed).toMatchObject({
          question: expect.any(String),
          answer: expect.any(String),
          sources: expect.any(Array),
          metadata: expect.objectContaining({
            projectSearched: PROJECT_NAME,
            model: expect.any(String),
          }),
        });

        // Verify sources structure
        if (parsed.sources.length > 0) {
          expect(parsed.sources[0]).toMatchObject({
            index: expect.any(Number),
            filePath: expect.any(String),
            lineStart: expect.any(Number),
            lineEnd: expect.any(Number),
            score: expect.any(Number),
          });
        }
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('displays sources after answer', async () => {
      const ctx = createMockContext();
      await runAskCommand(
        ['What is a User?', '--project', PROJECT_NAME],
        ctx
      );

      // The command should log "Sources:" header
      const logCalls = vi.mocked(ctx.log).mock.calls;
      const allOutput = logCalls.map((call) => call[0]).join('\n');

      expect(allOutput).toMatch(/sources/i);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Suite 4: Complete Workflow
  // ══════════════════════════════════════════════════════════════════════════

  describe('Complete Workflow', () => {
    it('executes index → search → ask in sequence', async () => {
      // Create a NEW project for this test
      const workflowProjectDir = join(getTestRoot(), 'workflow-project');
      const workflowProjectName = 'workflow-test';

      mkdirSync(workflowProjectDir, { recursive: true });
      createSampleProject(workflowProjectDir, DEFAULT_SAMPLE_FILES);

      // Step 1: Index
      await runIndexCommand([workflowProjectDir, '--name', workflowProjectName]);

      // Verify index succeeded
      const db = new Database(globalThis.__e2eDbPath);
      try {
        const project = getProjectFromDb(db, workflowProjectName);
        expect(project).toBeDefined();
        expect(countChunksInDb(db, project!.id)).toBeGreaterThan(0);
      } finally {
        db.close();
      }

      // Step 2: Search
      const searchCtx = createMockContext();
      await runSearchCommand(['password', '--project', workflowProjectName], searchCtx);

      // Verify search found results
      expect(searchCtx.log).toHaveBeenCalled();

      // Step 3: Ask
      const capture = captureStdout();
      try {
        const askCtx = createMockContext();
        await runAskCommand(
          ['How are passwords handled?', '--project', workflowProjectName],
          askCtx
        );

        const output = capture.getContent();
        expect(output).toMatch(/password|hash/i);
      } finally {
        capture.restore();
      }
    });

    it('handles multiple questions in sequence', async () => {
      // Ask multiple questions using the same indexed project
      const questions = [
        'How does authentication work?',
        'What is token validation?',
        'What interfaces are defined?',
      ];

      for (const question of questions) {
        const capture = captureStdout();
        try {
          const ctx = createMockContext();
          await runAskCommand([question, '--project', PROJECT_NAME], ctx);

          const output = capture.getContent();
          // Each question should produce some output
          expect(output.length).toBeGreaterThan(0);
        } finally {
          capture.restore();
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Suite 5: Citation Verification
  // ══════════════════════════════════════════════════════════════════════════

  describe('Citation Verification', () => {
    it('extractCitationReferences parses [N] patterns', () => {
      const text = 'See [1] for auth, [2] for tokens. Also [1] again.';
      const refs = extractCitationReferences(text);

      expect(refs).toEqual([1, 2]); // Unique, sorted
    });

    it('extractCitationReferences handles no citations', () => {
      const text = 'No citations here.';
      const refs = extractCitationReferences(text);

      expect(refs).toEqual([]);
    });

    it('verifyCitations validates references against sources', () => {
      const response = 'The auth module [1] handles login. See [2] for tokens.';
      const sources: RAGSource[] = [
        {
          index: 1,
          filePath: 'src/auth.ts',
          lineRange: { start: 10, end: 20 },
          score: 0.95,
          language: 'typescript',
          fileType: 'code',
        },
        {
          index: 2,
          filePath: 'src/token.ts',
          lineRange: { start: 5, end: 15 },
          score: 0.88,
          language: 'typescript',
          fileType: 'code',
        },
      ];

      const result = verifyCitations(response, sources);

      expect(result.allReferencesValid).toBe(true);
      expect(result.referencedIndices).toEqual([1, 2]);
      expect(result.invalidReferences).toHaveLength(0);
      expect(result.citedSources).toHaveLength(2);
      expect(result.uncitedSources).toHaveLength(0);
    });

    it('verifyCitations detects invalid references', () => {
      const response = 'See [1] and [99] for details.';
      const sources: RAGSource[] = [
        {
          index: 1,
          filePath: 'src/auth.ts',
          lineRange: { start: 10, end: 20 },
          score: 0.95,
          language: 'typescript',
          fileType: 'code',
        },
      ];

      const result = verifyCitations(response, sources);

      expect(result.allReferencesValid).toBe(false);
      expect(result.invalidReferences).toEqual([99]);
      expect(result.citedSources).toHaveLength(1);
    });

    it('verifyCitations tracks uncited sources', () => {
      const response = 'Only [1] is mentioned.';
      const sources: RAGSource[] = [
        {
          index: 1,
          filePath: 'src/auth.ts',
          lineRange: { start: 10, end: 20 },
          score: 0.95,
          language: 'typescript',
          fileType: 'code',
        },
        {
          index: 2,
          filePath: 'src/token.ts',
          lineRange: { start: 5, end: 15 },
          score: 0.88,
          language: 'typescript',
          fileType: 'code',
        },
      ];

      const result = verifyCitations(response, sources);

      expect(result.allReferencesValid).toBe(true);
      expect(result.uncitedSources).toHaveLength(1);
      expect(result.uncitedSources[0]!.index).toBe(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Suite 6: Chat Session
  // ══════════════════════════════════════════════════════════════════════════

  describe('Chat Session', () => {
    describe('REPL command parsing', () => {
      it('parses /focus command with project name', () => {
        const result = parseREPLCommand('/focus my-project');

        expect(result).not.toBeNull();
        expect(result!.command.name).toBe('focus');
        expect(result!.args).toEqual(['my-project']);
      });

      it('parses /focus alias (/f)', () => {
        const result = parseREPLCommand('/f another-project');

        expect(result).not.toBeNull();
        expect(result!.command.name).toBe('focus');
        expect(result!.args).toEqual(['another-project']);
      });

      it('parses exit command without slash', () => {
        const result = parseREPLCommand('exit');

        expect(result).not.toBeNull();
        expect(result!.command.name).toBe('exit');
        expect(result!.args).toEqual([]);
      });

      it('parses quit command without slash', () => {
        const result = parseREPLCommand('quit');

        expect(result).not.toBeNull();
        expect(result!.command.name).toBe('exit');
      });

      it('parses /clear command', () => {
        const result = parseREPLCommand('/clear');

        expect(result).not.toBeNull();
        expect(result!.command.name).toBe('clear');
      });

      it('parses /unfocus command', () => {
        const result = parseREPLCommand('/unfocus');

        expect(result).not.toBeNull();
        expect(result!.command.name).toBe('unfocus');
      });

      it('parses /projects command', () => {
        const result = parseREPLCommand('/projects');

        expect(result).not.toBeNull();
        expect(result!.command.name).toBe('projects');
      });

      it('parses /help command', () => {
        const result = parseREPLCommand('/help');

        expect(result).not.toBeNull();
        expect(result!.command.name).toBe('help');
      });

      it('returns null for regular questions (not commands)', () => {
        const result = parseREPLCommand('How does authentication work?');

        expect(result).toBeNull();
      });

      it('returns null for unknown commands', () => {
        const result = parseREPLCommand('/unknowncommand');

        expect(result).toBeNull();
      });
    });

    describe('Tab completion', () => {
      it('completes project names for /focus', () => {
        const mockGetProjects = () => ['project-alpha', 'project-beta', 'my-app'];
        const completer = createCompleter(mockGetProjects);

        const [completions] = completer('/focus pro');

        expect(completions).toContain('/focus project-alpha');
        expect(completions).toContain('/focus project-beta');
        expect(completions).not.toContain('/focus my-app'); // Doesn't start with "pro"
      });

      it('completes project names for /f alias', () => {
        const mockGetProjects = () => ['test-project'];
        const completer = createCompleter(mockGetProjects);

        const [completions] = completer('/f test');

        expect(completions).toContain('/f test-project');
      });

      it('returns empty for non-focus commands', () => {
        const completer = createCompleter(() => ['project-a']);

        const [completions] = completer('/clear');

        expect(completions).toEqual([]);
      });

      it('returns empty for regular text', () => {
        const completer = createCompleter(() => ['project-a']);

        const [completions] = completer('How does auth work?');

        expect(completions).toEqual([]);
      });
    });
  });
});
