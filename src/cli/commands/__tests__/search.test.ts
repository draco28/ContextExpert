/**
 * Tests for search command
 *
 * Tests cover:
 * - Command structure and metadata
 * - Query validation
 * - --project filter (single project lookup)
 * - --top option validation (default 10, max 100)
 * - JSON output format
 * - Empty results handling
 * - Error cases (invalid project, no projects, empty query)
 * - Multi-project search (no --project flag)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { createSearchCommand } from '../search.js';
import type { CommandContext } from '../../types.js';
import * as database from '../../../database/index.js';
import * as configLoader from '../../../config/loader.js';
import * as embedder from '../../../indexer/embedder/index.js';
import * as searchModule from '../../../search/index.js';

// Mock the database module
vi.mock('../../../database/index.js', () => ({
  runMigrations: vi.fn(),
  getDb: vi.fn(),
}));

// Mock the config loader
vi.mock('../../../config/loader.js', () => ({
  loadConfig: vi.fn(),
}));

// Mock the embedder
vi.mock('../../../indexer/embedder/index.js', () => ({
  createEmbeddingProvider: vi.fn(),
}));

// Mock the search module
vi.mock('../../../search/index.js', () => ({
  createFusionService: vi.fn(),
  formatResults: vi.fn(),
  formatResultsJSON: vi.fn(),
}));

describe('createSearchCommand', () => {
  let mockContext: CommandContext;
  let logOutput: string[];
  let errorOutput: string[];
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let mockDb: { prepare: ReturnType<typeof vi.fn> };
  let mockFusionService: {
    ensureInitialized: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
  };

  const mockProject = {
    id: 'proj-123',
    name: 'test-project',
    path: '/path/to/project',
    tags: null,
    ignore_patterns: null,
    indexed_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    file_count: 10,
    chunk_count: 100,
    config: null,
  };

  const mockSearchResults = [
    {
      id: 'chunk-1',
      score: 0.92,
      content: 'Authentication middleware implementation',
      filePath: 'src/auth/middleware.ts',
      fileType: 'code',
      language: 'typescript',
      lineRange: { start: 45, end: 67 },
      metadata: { projectId: 'proj-123' },
    },
    {
      id: 'chunk-2',
      score: 0.87,
      content: 'API route protection',
      filePath: 'src/api/routes.ts',
      fileType: 'code',
      language: 'typescript',
      lineRange: { start: 120, end: 142 },
      metadata: { projectId: 'proj-123' },
    },
  ];

  beforeEach(() => {
    logOutput = [];
    errorOutput = [];
    mockContext = {
      options: { verbose: false, json: false },
      log: (msg: string) => logOutput.push(msg),
      debug: vi.fn(),
      error: (msg: string) => errorOutput.push(msg),
    };

    // Set up mock database
    mockDb = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(mockProject),
        all: vi.fn().mockReturnValue([mockProject]),
      }),
    };
    vi.mocked(database.getDb).mockReturnValue(
      mockDb as unknown as ReturnType<typeof database.getDb>
    );

    // Set up mock config
    vi.mocked(configLoader.loadConfig).mockReturnValue({
      default_provider: 'anthropic',
      default_model: 'claude-sonnet-4-20250514',
      embedding: {
        provider: 'huggingface',
        model: 'BAAI/bge-large-en-v1.5',
        batch_size: 32,
      },
      search: {
        top_k: 10,
        rerank: false,
      },
    });

    // Set up mock embedding provider (returns new EmbeddingProviderResult structure)
    vi.mocked(embedder.createEmbeddingProvider).mockResolvedValue({
      provider: {
        embed: vi.fn(),
        embedBatch: vi.fn(),
        dimensions: 1024,
      },
      model: 'BAAI/bge-large-en-v1.5',
      dimensions: 1024,
    } as unknown as ReturnType<typeof embedder.createEmbeddingProvider>);

    // Set up mock fusion service
    mockFusionService = {
      ensureInitialized: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue(mockSearchResults),
    };
    vi.mocked(searchModule.createFusionService).mockReturnValue(
      mockFusionService as unknown as ReturnType<typeof searchModule.createFusionService>
    );

    // Set up mock formatters
    vi.mocked(searchModule.formatResults).mockReturnValue(
      '[0.92] src/auth/middleware.ts:45-67\n  Authentication middleware implementation\n\n[0.87] src/api/routes.ts:120-142\n  API route protection'
    );
    vi.mocked(searchModule.formatResultsJSON).mockReturnValue([
      {
        score: 0.92,
        filePath: 'src/auth/middleware.ts',
        lineStart: 45,
        lineEnd: 67,
        content: 'Authentication middleware implementation',
        language: 'typescript',
        fileType: 'code',
      },
      {
        score: 0.87,
        filePath: 'src/api/routes.ts',
        lineStart: 120,
        lineEnd: 142,
        content: 'API route protection',
        language: 'typescript',
        fileType: 'code',
      },
    ]);

    // Spy on console.log for JSON output
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Command Structure
  // ═══════════════════════════════════════════════════════════════════════════

  describe('command structure', () => {
    it('creates command with correct name', () => {
      const cmd = createSearchCommand(() => mockContext);
      expect(cmd.name()).toBe('search');
    });

    it('has description', () => {
      const cmd = createSearchCommand(() => mockContext);
      expect(cmd.description()).toBe('Search for code patterns across indexed projects');
    });

    it('has query argument', () => {
      const cmd = createSearchCommand(() => mockContext);
      const args = cmd.registeredArguments;
      expect(args.length).toBe(1);
      expect(args[0].name()).toBe('query');
      expect(args[0].required).toBe(true);
    });

    it('has --project option', () => {
      const cmd = createSearchCommand(() => mockContext);
      const projectOption = cmd.options.find((o) => o.long === '--project');
      expect(projectOption).toBeDefined();
      expect(projectOption?.short).toBe('-p');
    });

    it('has --top option with default', () => {
      const cmd = createSearchCommand(() => mockContext);
      const topOption = cmd.options.find((o) => o.long === '--top');
      expect(topOption).toBeDefined();
      expect(topOption?.short).toBe('-k');
      expect(topOption?.defaultValue).toBe('10');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Basic Search
  // ═══════════════════════════════════════════════════════════════════════════

  describe('basic search', () => {
    it('executes search with query', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'authentication']);

      expect(mockFusionService.search).toHaveBeenCalledWith(
        'authentication',
        expect.objectContaining({ topK: 10 })
      );
    });

    it('displays results count and formatted output', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'authentication']);

      const output = logOutput.join('\n');
      expect(output).toContain('Found 2 results');
      expect(output).toContain('authentication');
    });

    it('calls formatResults with results', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'authentication']);

      expect(searchModule.formatResults).toHaveBeenCalledWith(
        mockSearchResults,
        expect.any(Object)
      );
    });

    it('initializes fusion service before search', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'authentication']);

      expect(mockFusionService.ensureInitialized).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Project Filter
  // ═══════════════════════════════════════════════════════════════════════════

  describe('--project filter', () => {
    it('looks up project by name when --project provided', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'query', '--project', 'test-project']);

      expect(mockDb.prepare).toHaveBeenCalled();
      const calls = mockDb.prepare.mock.calls;
      const projectLookupCall = calls.find((c) => c[0].includes('WHERE name = ?'));
      expect(projectLookupCall).toBeDefined();
    });

    it('uses resolved project for FusionService creation', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'query', '--project', 'test-project']);

      // FusionService is scoped to the project at creation time
      expect(searchModule.createFusionService).toHaveBeenCalledWith(
        'proj-123',
        expect.any(Object),
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('throws error for unknown project', async () => {
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue(undefined),
        all: vi.fn().mockReturnValue([]),
      });

      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      program.exitOverride();

      await expect(
        program.parseAsync(['node', 'test', 'search', 'query', '--project', 'nonexistent'])
      ).rejects.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Top-K Option
  // ═══════════════════════════════════════════════════════════════════════════

  describe('--top option', () => {
    it('uses default top-k of 10', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'query']);

      expect(mockFusionService.search).toHaveBeenCalledWith(
        'query',
        expect.objectContaining({ topK: 10 })
      );
    });

    it('accepts custom top-k value', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'query', '--top', '20']);

      expect(mockFusionService.search).toHaveBeenCalledWith(
        'query',
        expect.objectContaining({ topK: 20 })
      );
    });

    it('accepts -k shorthand', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'query', '-k', '5']);

      expect(mockFusionService.search).toHaveBeenCalledWith(
        'query',
        expect.objectContaining({ topK: 5 })
      );
    });

    it('rejects top-k greater than 100', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      program.exitOverride();

      await expect(
        program.parseAsync(['node', 'test', 'search', 'query', '--top', '150'])
      ).rejects.toThrow();
    });

    it('rejects top-k less than 1', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      program.exitOverride();

      await expect(
        program.parseAsync(['node', 'test', 'search', 'query', '--top', '0'])
      ).rejects.toThrow();
    });

    it('rejects non-numeric top-k', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      program.exitOverride();

      await expect(
        program.parseAsync(['node', 'test', 'search', 'query', '--top', 'abc'])
      ).rejects.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // JSON Output
  // ═══════════════════════════════════════════════════════════════════════════

  describe('JSON output', () => {
    beforeEach(() => {
      mockContext.options.json = true;
    });

    it('outputs valid JSON', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'authentication']);

      expect(consoleLogSpy).toHaveBeenCalled();
      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput).toBeDefined();
    });

    it('includes query in JSON output', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'authentication']);

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.query).toBe('authentication');
    });

    it('includes count in JSON output', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'authentication']);

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.count).toBe(2);
    });

    it('includes projectsSearched in JSON output', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'authentication']);

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.projectsSearched).toEqual(['test-project']);
    });

    it('includes formatted results array', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'authentication']);

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.results).toBeDefined();
      expect(Array.isArray(jsonOutput.results)).toBe(true);
      expect(jsonOutput.results.length).toBe(2);
    });

    it('calls formatResultsJSON instead of formatResults', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'authentication']);

      expect(searchModule.formatResultsJSON).toHaveBeenCalled();
      expect(searchModule.formatResults).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Empty Results
  // ═══════════════════════════════════════════════════════════════════════════

  describe('empty results handling', () => {
    beforeEach(() => {
      mockFusionService.search.mockResolvedValue([]);
    });

    it('displays helpful message when no results', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'nonexistent-query']);

      const output = logOutput.join('\n');
      expect(output).toContain('No results found');
      expect(output).toContain('nonexistent-query');
    });

    it('includes tips for improving search', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'xyz']);

      const output = logOutput.join('\n');
      expect(output).toContain('Tips');
    });

    it('returns empty results array in JSON mode', async () => {
      mockContext.options.json = true;
      // Also mock formatter to return empty array for empty results
      vi.mocked(searchModule.formatResultsJSON).mockReturnValue([]);

      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'nonexistent']);

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.count).toBe(0);
      expect(jsonOutput.results).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Query Validation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('query validation', () => {
    it('trims whitespace from query', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', '  authentication  ']);

      expect(mockFusionService.search).toHaveBeenCalledWith(
        'authentication',
        expect.any(Object)
      );
    });

    it('rejects empty query after trimming', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      program.exitOverride();

      await expect(
        program.parseAsync(['node', 'test', 'search', '   '])
      ).rejects.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Error Cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('error cases', () => {
    it('throws error when no projects indexed', async () => {
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue(undefined),
        all: vi.fn().mockReturnValue([]),
      });

      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      program.exitOverride();

      await expect(
        program.parseAsync(['node', 'test', 'search', 'query'])
      ).rejects.toThrow();
    });

    it('includes hint to run ctx index when no projects', async () => {
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue(undefined),
        all: vi.fn().mockReturnValue([]),
      });

      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      program.exitOverride();

      let caughtError: Error | undefined;
      try {
        await program.parseAsync(['node', 'test', 'search', 'query']);
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeDefined();
      // The hint is in a separate property on CLIError, or in the full error output
      // Check either the message or hint contains the guidance
      const errorText = caughtError!.message + (caughtError as any).hint;
      expect(errorText).toContain('ctx index');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Multi-Project Search
  // ═══════════════════════════════════════════════════════════════════════════

  describe('multi-project search', () => {
    const project1 = { ...mockProject, id: 'proj-1', name: 'project-one' };
    const project2 = { ...mockProject, id: 'proj-2', name: 'project-two' };

    beforeEach(() => {
      mockDb.prepare.mockReturnValue({
        get: vi.fn(),
        all: vi.fn().mockReturnValue([project1, project2]),
      });
    });

    it('searches first project when multiple exist (single-project mode)', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'query']);

      // FusionService is created with first project; multi-project search not yet supported
      expect(mockFusionService.search).toHaveBeenCalledWith(
        'query',
        expect.objectContaining({ topK: 10 })
      );
    });

    it('enables showProject in formatResults for multi-project', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'query']);

      expect(searchModule.formatResults).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ showProject: true })
      );
    });

    it('shows project count in header for multi-project', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'query']);

      const output = logOutput.join('\n');
      expect(output).toContain('2 projects');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Debug Logging
  // ═══════════════════════════════════════════════════════════════════════════

  describe('debug logging', () => {
    it('logs query in debug mode', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'authentication']);

      expect(mockContext.debug).toHaveBeenCalledWith(expect.stringContaining('Query:'));
      expect(mockContext.debug).toHaveBeenCalledWith(expect.stringContaining('authentication'));
    });

    it('logs project count in debug mode', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'query']);

      expect(mockContext.debug).toHaveBeenCalledWith(expect.stringContaining('Searching'));
      expect(mockContext.debug).toHaveBeenCalledWith(expect.stringContaining('project'));
    });

    it('logs result count in debug mode', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'query']);

      expect(mockContext.debug).toHaveBeenCalledWith(expect.stringContaining('Found'));
      expect(mockContext.debug).toHaveBeenCalledWith(expect.stringContaining('results'));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Provider Initialization
  // ═══════════════════════════════════════════════════════════════════════════

  describe('embedding provider', () => {
    it('creates embedding provider with config', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'query']);

      expect(embedder.createEmbeddingProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'huggingface',
          model: 'BAAI/bge-large-en-v1.5',
        }),
        expect.any(Object)
      );
    });

    it('creates fusion service with project, provider, and dimensions', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'query']);

      expect(searchModule.createFusionService).toHaveBeenCalledWith(
        'proj-123', // First project ID
        expect.any(Object), // Embedding provider
        expect.objectContaining({ top_k: 10, rerank: false }), // Search config
        expect.objectContaining({ denseOptions: { dimensions: 1024 } }) // Dimensions from provider
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Single Result Grammar
  // ═══════════════════════════════════════════════════════════════════════════

  describe('output grammar', () => {
    it('uses singular "result" for single match', async () => {
      mockFusionService.search.mockResolvedValue([mockSearchResults[0]]);

      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'query']);

      const output = logOutput.join('\n');
      expect(output).toContain('Found 1 result');
      expect(output).not.toContain('Found 1 results');
    });

    it('uses plural "results" for multiple matches', async () => {
      const cmd = createSearchCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'search', 'query']);

      const output = logOutput.join('\n');
      expect(output).toContain('Found 2 results');
    });
  });
});
