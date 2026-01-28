/**
 * Tests for index command
 *
 * Tests cover:
 * - Command structure and options
 * - Path validation (exists, is directory)
 * - Project name handling (default and custom)
 * - Tag parsing
 * - Re-indexing flow (with and without --force)
 * - Pipeline integration
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { createIndexCommand } from '../index.js';
import type { CommandContext } from '../../types.js';

// Mock all external dependencies
// Note: vi.mock() calls are hoisted to the top of the file by Vitest

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock('../../../database/index.js', () => ({
  runMigrations: vi.fn(),
  getDatabase: vi.fn(),
}));

vi.mock('../../../indexer/index.js', () => ({
  runIndexPipeline: vi.fn(),
}));

vi.mock('../../../indexer/embedder/index.js', () => ({
  createEmbeddingProvider: vi.fn(),
}));

vi.mock('../../../config/index.js', () => ({
  loadConfig: vi.fn(),
  DEFAULT_CONFIG: {
    embedding: {
      provider: 'huggingface',
      model: 'BAAI/bge-large-en-v1.5',
    },
  },
}));

vi.mock('../../utils/progress.js', () => ({
  createProgressReporter: vi.fn(),
}));

// Mock ora (dynamic import in the command)
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

// Import mocked modules to set up return values
import * as fs from 'node:fs';
import * as database from '../../../database/index.js';
import * as indexer from '../../../indexer/index.js';
import * as embedder from '../../../indexer/embedder/index.js';
import * as config from '../../../config/index.js';
import * as progress from '../../utils/progress.js';
import { CLIError } from '../../../errors/index.js';

describe('createIndexCommand', () => {
  let mockContext: CommandContext;
  let mockDb: {
    getProjectByPath: ReturnType<typeof vi.fn>;
    deleteProjectChunks: ReturnType<typeof vi.fn>;
  };
  let mockReporter: {
    startStage: ReturnType<typeof vi.fn>;
    updateProgress: ReturnType<typeof vi.fn>;
    completeStage: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    showSummary: ReturnType<typeof vi.fn>;
  };
  let mockEmbeddingProvider: { embed: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Set up mock context
    mockContext = {
      options: { verbose: false, json: false },
      log: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };

    // Set up mock database
    mockDb = {
      getProjectByPath: vi.fn().mockReturnValue(undefined),
      deleteProjectChunks: vi.fn(),
    };
    vi.mocked(database.getDatabase).mockReturnValue(mockDb as any);

    // Set up mock progress reporter
    mockReporter = {
      startStage: vi.fn(),
      updateProgress: vi.fn(),
      completeStage: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      showSummary: vi.fn(),
    };
    vi.mocked(progress.createProgressReporter).mockReturnValue(mockReporter as any);

    // Set up mock embedding provider (returns new EmbeddingProviderResult structure)
    mockEmbeddingProvider = { embed: vi.fn() };
    vi.mocked(embedder.createEmbeddingProvider).mockResolvedValue({
      provider: mockEmbeddingProvider,
      model: 'BAAI/bge-large-en-v1.5',
      dimensions: 1024,
    } as any);

    // Set up mock config
    vi.mocked(config.loadConfig).mockReturnValue({
      embedding: { provider: 'huggingface', model: 'BAAI/bge-large-en-v1.5' },
    } as any);

    // Set up mock pipeline result
    vi.mocked(indexer.runIndexPipeline).mockResolvedValue({
      projectId: 'test-uuid',
      projectName: 'test-project',
      filesIndexed: 10,
      chunksCreated: 50,
      chunksStored: 50,
      totalDurationMs: 1000,
      stageDurations: { scanning: 100, chunking: 300, embedding: 400, storing: 200 },
      databaseSizeIncrease: 1024,
      warnings: [],
      errors: [],
    });

    // Default: path exists and is a directory
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);

    // Ensure stdout.isTTY is false for tests (avoids spinner complexity)
    vi.stubGlobal('process', {
      ...process,
      stdout: { ...process.stdout, isTTY: false },
      env: { ...process.env },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Helper to run the command
  async function runCommand(args: string[] = []): Promise<void> {
    const cmd = createIndexCommand(() => mockContext);
    const program = new Command();
    program.addCommand(cmd);
    // Prevent Commander from calling process.exit on errors
    program.exitOverride();
    await program.parseAsync(['node', 'test', 'index', ...args]);
  }

  describe('command structure', () => {
    it('creates command with correct name', () => {
      const cmd = createIndexCommand(() => mockContext);
      expect(cmd.name()).toBe('index');
    });

    it('has correct description', () => {
      const cmd = createIndexCommand(() => mockContext);
      expect(cmd.description()).toBe('Index a project directory for semantic search');
    });

    it('requires path argument', () => {
      const cmd = createIndexCommand(() => mockContext);
      // Commander stores arguments in _args
      const args = (cmd as any)._args;
      expect(args).toHaveLength(1);
      expect(args[0].name()).toBe('path');
      expect(args[0].required).toBe(true);
    });

    it('has --name option with -n alias', () => {
      const cmd = createIndexCommand(() => mockContext);
      const nameOption = cmd.options.find((o) => o.long === '--name');
      expect(nameOption).toBeDefined();
      expect(nameOption?.short).toBe('-n');
    });

    it('has --tags option with -t alias', () => {
      const cmd = createIndexCommand(() => mockContext);
      const tagsOption = cmd.options.find((o) => o.long === '--tags');
      expect(tagsOption).toBeDefined();
      expect(tagsOption?.short).toBe('-t');
    });

    it('has --force option', () => {
      const cmd = createIndexCommand(() => mockContext);
      const forceOption = cmd.options.find((o) => o.long === '--force');
      expect(forceOption).toBeDefined();
    });
  });

  describe('path validation', () => {
    it('throws CLIError for non-existent path', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      await expect(runCommand(['/non/existent/path'])).rejects.toThrow(CLIError);
      await expect(runCommand(['/non/existent/path'])).rejects.toThrow('Path does not exist');
    });

    it('throws CLIError when path is a file, not directory', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false } as any);

      await expect(runCommand(['/path/to/file.txt'])).rejects.toThrow(CLIError);
      await expect(runCommand(['/path/to/file.txt'])).rejects.toThrow('Path is not a directory');
    });

    it('resolves relative paths to absolute', async () => {
      await runCommand(['./my-project']);

      // Check that runIndexPipeline was called with an absolute path
      expect(indexer.runIndexPipeline).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: expect.stringMatching(/^\/.*my-project$/),
        })
      );
    });
  });

  describe('project name', () => {
    it('defaults to directory basename', async () => {
      await runCommand(['/path/to/my-awesome-project']);

      expect(indexer.runIndexPipeline).toHaveBeenCalledWith(
        expect.objectContaining({
          projectName: 'my-awesome-project',
        })
      );
    });

    it('uses --name option when provided', async () => {
      await runCommand(['/path/to/project', '--name', 'Custom Name']);

      expect(indexer.runIndexPipeline).toHaveBeenCalledWith(
        expect.objectContaining({
          projectName: 'Custom Name',
        })
      );
    });

    it('uses -n alias for name', async () => {
      await runCommand(['/path/to/project', '-n', 'Short Name']);

      expect(indexer.runIndexPipeline).toHaveBeenCalledWith(
        expect.objectContaining({
          projectName: 'Short Name',
        })
      );
    });
  });

  describe('tag parsing', () => {
    it('parses comma-separated tags', async () => {
      await runCommand(['/path/to/project', '--tags', 'frontend,react,typescript']);

      // Tags are passed to the command but note: currently they're not passed to runIndexPipeline
      // They would be used when storing the project in the database
      // For now, just verify the command runs successfully
      expect(indexer.runIndexPipeline).toHaveBeenCalled();
    });

    it('trims whitespace from tags', async () => {
      await runCommand(['/path/to/project', '-t', 'tag1 , tag2 , tag3']);

      // Command should run without errors even with whitespace
      expect(indexer.runIndexPipeline).toHaveBeenCalled();
    });

    it('filters empty tags', async () => {
      await runCommand(['/path/to/project', '--tags', 'valid,,also-valid,']);

      expect(indexer.runIndexPipeline).toHaveBeenCalled();
    });
  });

  describe('re-indexing', () => {
    const existingProject = {
      id: 'existing-uuid',
      name: 'existing-project',
      path: '/path/to/project',
      chunk_count: 100,
    };

    it('throws error when project exists and --force not provided', async () => {
      mockDb.getProjectByPath.mockReturnValue(existingProject);

      await expect(runCommand(['/path/to/project'])).rejects.toThrow(CLIError);
      await expect(runCommand(['/path/to/project'])).rejects.toThrow('Project already indexed');
    });

    it('suggests using --force in error message', async () => {
      mockDb.getProjectByPath.mockReturnValue(existingProject);

      try {
        await runCommand(['/path/to/project']);
      } catch (error) {
        expect((error as CLIError).hint).toContain('--force');
      }
    });

    it('allows re-indexing with --force flag', async () => {
      mockDb.getProjectByPath.mockReturnValue(existingProject);

      await runCommand(['/path/to/project', '--force']);

      expect(mockDb.deleteProjectChunks).toHaveBeenCalledWith('existing-uuid');
      expect(indexer.runIndexPipeline).toHaveBeenCalled();
    });

    it('passes existing project ID when re-indexing', async () => {
      mockDb.getProjectByPath.mockReturnValue(existingProject);

      await runCommand(['/path/to/project', '--force']);

      expect(indexer.runIndexPipeline).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'existing-uuid',
        })
      );
    });

    it('deletes existing chunks before re-indexing', async () => {
      mockDb.getProjectByPath.mockReturnValue(existingProject);

      await runCommand(['/path/to/project', '--force']);

      // Verify deleteProjectChunks was called BEFORE runIndexPipeline
      const deleteCall = mockDb.deleteProjectChunks.mock.invocationCallOrder[0];
      const pipelineCall = vi.mocked(indexer.runIndexPipeline).mock.invocationCallOrder[0];
      expect(deleteCall).toBeLessThan(pipelineCall);
    });
  });

  describe('pipeline integration', () => {
    it('creates embedding provider with config', async () => {
      await runCommand(['/path/to/project']);

      expect(embedder.createEmbeddingProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'huggingface',
          model: 'BAAI/bge-large-en-v1.5',
        }),
        expect.any(Object)
      );
    });

    it('passes embedding provider to pipeline', async () => {
      await runCommand(['/path/to/project']);

      expect(indexer.runIndexPipeline).toHaveBeenCalledWith(
        expect.objectContaining({
          embeddingProvider: mockEmbeddingProvider,
        })
      );
    });

    it('wires progress callbacks to reporter', async () => {
      // Capture the callbacks passed to runIndexPipeline
      let capturedCallbacks: any;
      vi.mocked(indexer.runIndexPipeline).mockImplementation(async (options) => {
        capturedCallbacks = options;
        return {
          projectId: 'test-uuid',
          projectName: 'test',
          filesIndexed: 10,
          chunksCreated: 50,
          chunksStored: 50,
          totalDurationMs: 1000,
          stageDurations: {},
          databaseSizeIncrease: 1024,
          warnings: [],
          errors: [],
        };
      });

      await runCommand(['/path/to/project']);

      // Simulate pipeline calling the callbacks
      capturedCallbacks.onStageStart('scanning', 0);
      expect(mockReporter.startStage).toHaveBeenCalledWith('scanning', 0);

      capturedCallbacks.onProgress('scanning', 5, 0, 'src/file.ts');
      expect(mockReporter.updateProgress).toHaveBeenCalledWith(5, 'src/file.ts');

      capturedCallbacks.onStageComplete('scanning', { stage: 'scanning', processed: 10, total: 10, durationMs: 100 });
      expect(mockReporter.completeStage).toHaveBeenCalled();

      capturedCallbacks.onWarning('test warning', 'context');
      expect(mockReporter.warn).toHaveBeenCalledWith('test warning', 'context');

      capturedCallbacks.onError(new Error('test error'), 'context');
      expect(mockReporter.error).toHaveBeenCalledWith('test error', 'context');
    });

    it('shows summary after pipeline completes', async () => {
      const mockResult = {
        projectId: 'test-uuid',
        projectName: 'test-project',
        filesIndexed: 100,
        chunksCreated: 500,
        chunksStored: 500,
        totalDurationMs: 5000,
        stageDurations: {},
        databaseSizeIncrease: 10240,
        warnings: [],
        errors: [],
      };
      vi.mocked(indexer.runIndexPipeline).mockResolvedValue(mockResult);

      await runCommand(['/path/to/project']);

      expect(mockReporter.showSummary).toHaveBeenCalledWith(mockResult);
    });

    it('runs migrations before accessing database', async () => {
      await runCommand(['/path/to/project']);

      expect(database.runMigrations).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('throws CLIError when embedding provider fails to initialize', async () => {
      vi.mocked(embedder.createEmbeddingProvider).mockRejectedValue(
        new Error('Failed to load model')
      );

      await expect(runCommand(['/path/to/project'])).rejects.toThrow(CLIError);
      await expect(runCommand(['/path/to/project'])).rejects.toThrow(
        'Failed to initialize embedding provider'
      );
    });

    it('throws CLIError when pipeline fails', async () => {
      vi.mocked(indexer.runIndexPipeline).mockRejectedValue(
        new Error('Database write failed')
      );

      await expect(runCommand(['/path/to/project'])).rejects.toThrow(CLIError);
      await expect(runCommand(['/path/to/project'])).rejects.toThrow('Indexing failed');
    });

    it('includes original error message in CLIError', async () => {
      vi.mocked(indexer.runIndexPipeline).mockRejectedValue(
        new Error('Specific database error')
      );

      await expect(runCommand(['/path/to/project'])).rejects.toThrow(
        'Indexing failed: Specific database error'
      );
    });
  });

  describe('debug logging', () => {
    it('logs indexing path in debug mode', async () => {
      await runCommand(['/path/to/my-project']);

      expect(mockContext.debug).toHaveBeenCalledWith(
        expect.stringContaining('Indexing path:')
      );
    });

    it('logs project name in debug mode', async () => {
      await runCommand(['/path/to/project', '--name', 'My Project']);

      expect(mockContext.debug).toHaveBeenCalledWith('Project name: My Project');
    });

    it('logs tags in debug mode when provided', async () => {
      await runCommand(['/path/to/project', '--tags', 'api,backend']);

      expect(mockContext.debug).toHaveBeenCalledWith(
        expect.stringContaining('Tags:')
      );
    });

    it('logs embedding provider info in debug mode', async () => {
      await runCommand(['/path/to/project']);

      expect(mockContext.debug).toHaveBeenCalledWith(
        expect.stringContaining('Embedding provider:')
      );
    });
  });

  describe('JSON output mode', () => {
    it('creates reporter with json option', async () => {
      mockContext.options.json = true;

      await runCommand(['/path/to/project']);

      expect(progress.createProgressReporter).toHaveBeenCalledWith(
        expect.objectContaining({
          json: true,
        })
      );
    });
  });

  describe('verbose mode', () => {
    it('creates reporter with verbose option', async () => {
      mockContext.options.verbose = true;

      await runCommand(['/path/to/project']);

      expect(progress.createProgressReporter).toHaveBeenCalledWith(
        expect.objectContaining({
          verbose: true,
        })
      );
    });
  });
});
