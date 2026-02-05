/**
 * Tests for check command
 *
 * Tests cover:
 * - Command structure
 * - Ready project (no issues)
 * - No chunks (error severity)
 * - Missing path (error severity)
 * - Embedding model mismatch (warning, still ready)
 * - Stale files (warning)
 * - Non-existent project name (CLIError)
 * - JSON output format
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { createCheckCommand } from '../check.js';
import type { CommandContext } from '../../types.js';
import * as database from '../../../database/index.js';
import * as configLoader from '../../../config/loader.js';
import * as fs from 'node:fs';

// Mock the database module
vi.mock('../../../database/index.js', () => ({
  runMigrations: vi.fn(),
  getDb: vi.fn(),
}));

// Mock the config loader
vi.mock('../../../config/loader.js', () => ({
  loadConfig: vi.fn(),
}));

// Mock node:fs
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readdirSync: vi.fn(),
}));

describe('createCheckCommand', () => {
  let mockContext: CommandContext;
  let logOutput: string[];
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let mockDb: { prepare: ReturnType<typeof vi.fn> };

  const mockProject = {
    id: 'uuid-123',
    name: 'test-project',
    path: '/Users/test/projects/test-project',
    tags: null,
    ignore_patterns: null,
    indexed_at: '2024-01-15T10:00:00.000Z',
    updated_at: '2024-01-20T15:30:00.000Z',
    file_count: 50,
    chunk_count: 500,
    config: null,
    embedding_model: 'BAAI/bge-large-en-v1.5',
    embedding_dimensions: 1024,
    description: 'Test project for unit tests',
  };

  beforeEach(() => {
    logOutput = [];
    mockContext = {
      options: { verbose: false, json: false },
      log: (msg: string) => logOutput.push(msg),
      debug: vi.fn(),
      error: vi.fn(),
    };

    // Set up mock database
    const fileHashesResult: Array<{ file_path: string; indexed_at: string }> = [];
    mockDb = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('file_hashes')) {
          return { all: vi.fn().mockReturnValue(fileHashesResult) };
        }
        return { get: vi.fn().mockReturnValue(mockProject) };
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
        top_k: 5,
        rerank: true,
      },
    });

    // Default: path exists, files up to date
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({
      mtimeMs: new Date('2024-01-10T00:00:00.000Z').getTime(), // Before indexed_at
    } as fs.Stats);

    // Spy on console.log for JSON output
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Reset process.exitCode
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  // Helper to run the command
  async function runCheck(projectName: string, context = mockContext) {
    const cmd = createCheckCommand(() => context);
    const program = new Command();
    program.addCommand(cmd);
    await program.parseAsync(['node', 'test', 'check', projectName]);
  }

  describe('command structure', () => {
    it('creates command with correct name', () => {
      const cmd = createCheckCommand(() => mockContext);
      expect(cmd.name()).toBe('check');
    });

    it('has description', () => {
      const cmd = createCheckCommand(() => mockContext);
      expect(cmd.description()).toContain('health');
    });

    it('requires project argument', () => {
      const cmd = createCheckCommand(() => mockContext);
      const args = (cmd as unknown as { registeredArguments: Array<{ required: boolean; name: () => string }> }).registeredArguments;
      expect(args).toHaveLength(1);
      expect(args[0].required).toBe(true);
      expect(args[0].name()).toBe('project');
    });
  });

  describe('non-existent project', () => {
    it('throws CLIError when project not found', async () => {
      mockDb.prepare = vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(undefined),
        all: vi.fn().mockReturnValue([]),
      });

      await expect(runCheck('nonexistent')).rejects.toThrow(
        'Project not found: nonexistent'
      );
    });
  });

  describe('ready project (no issues)', () => {
    it('reports ready in text mode', async () => {
      await runCheck('test-project');

      const output = logOutput.join('\n');
      expect(output).toContain('ready');
      expect(output).toContain('test-project');
      expect(output).toContain('No issues found');
    });

    it('does not set exit code when ready', async () => {
      await runCheck('test-project');
      expect(process.exitCode).toBeUndefined();
    });

    it('reports ready=true in JSON mode', async () => {
      mockContext.options.json = true;
      await runCheck('test-project');

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.ready).toBe(true);
      expect(jsonOutput.project.name).toBe('test-project');
      expect(jsonOutput.chunkCount).toBe(500);
      expect(jsonOutput.embeddingModel).toBe('BAAI/bge-large-en-v1.5');
      expect(jsonOutput.embeddingDimensions).toBe(1024);
      expect(jsonOutput.description).toBe('Test project for unit tests');
      expect(jsonOutput.issues).toEqual([]);
    });
  });

  describe('no chunks (error)', () => {
    beforeEach(() => {
      const noChunksProject = { ...mockProject, chunk_count: 0 };
      mockDb.prepare = vi.fn((sql: string) => {
        if (sql.includes('file_hashes')) {
          return { all: vi.fn().mockReturnValue([]) };
        }
        return { get: vi.fn().mockReturnValue(noChunksProject) };
      });
    });

    it('reports not ready when no chunks', async () => {
      mockContext.options.json = true;
      await runCheck('test-project');

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.ready).toBe(false);
      expect(jsonOutput.issues).toHaveLength(1);
      expect(jsonOutput.issues[0].severity).toBe('error');
      expect(jsonOutput.issues[0].message).toContain('no indexed chunks');
    });

    it('sets exit code 1 when not ready', async () => {
      await runCheck('test-project');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('missing path (error)', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockImplementation((path: fs.PathLike) => {
        if (String(path) === mockProject.path) return false;
        return true;
      });
    });

    it('reports path not found error', async () => {
      mockContext.options.json = true;
      await runCheck('test-project');

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.ready).toBe(false);
      expect(jsonOutput.staleness.pathExists).toBe(false);

      const pathIssue = jsonOutput.issues.find((i: { message: string }) =>
        i.message.includes('does not exist')
      );
      expect(pathIssue).toBeDefined();
      expect(pathIssue.severity).toBe('error');
    });
  });

  describe('embedding model mismatch (warning, still ready)', () => {
    beforeEach(() => {
      vi.mocked(configLoader.loadConfig).mockReturnValue({
        default_provider: 'anthropic',
        default_model: 'claude-sonnet-4-20250514',
        embedding: {
          provider: 'openai',
          model: 'text-embedding-3-small',
          batch_size: 32,
        },
        search: {
          top_k: 5,
          rerank: true,
        },
      });
    });

    it('reports warning but stays ready', async () => {
      mockContext.options.json = true;
      await runCheck('test-project');

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.ready).toBe(true);

      const mismatchIssue = jsonOutput.issues.find((i: { message: string }) =>
        i.message.includes('mismatch')
      );
      expect(mismatchIssue).toBeDefined();
      expect(mismatchIssue.severity).toBe('warning');
    });

    it('does not set exit code for warnings only', async () => {
      await runCheck('test-project');
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe('stale files (warning)', () => {
    beforeEach(() => {
      const staleFileHashes = [
        { file_path: 'src/index.ts', indexed_at: '2024-01-15T10:00:00.000Z' },
        { file_path: 'src/app.ts', indexed_at: '2024-01-15T10:00:00.000Z' },
      ];

      mockDb.prepare = vi.fn((sql: string) => {
        if (sql.includes('file_hashes')) {
          return { all: vi.fn().mockReturnValue(staleFileHashes) };
        }
        return { get: vi.fn().mockReturnValue(mockProject) };
      });

      // Files modified after indexed_at
      vi.mocked(fs.statSync).mockReturnValue({
        mtimeMs: new Date('2024-02-01T00:00:00.000Z').getTime(),
      } as fs.Stats);
    });

    it('reports stale files as warning', async () => {
      mockContext.options.json = true;
      await runCheck('test-project');

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.ready).toBe(true); // warnings don't block

      expect(jsonOutput.staleness.filesChanged).toBe(2);
      expect(jsonOutput.staleness.needsReindex).toBe(true);

      const stalenessIssue = jsonOutput.issues.find((i: { message: string }) =>
        i.message.includes('changed since')
      );
      expect(stalenessIssue).toBeDefined();
      expect(stalenessIssue.severity).toBe('warning');
    });
  });

  describe('JSON output structure', () => {
    it('includes all required fields', async () => {
      mockContext.options.json = true;
      await runCheck('test-project');

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput).toHaveProperty('ready');
      expect(jsonOutput).toHaveProperty('project');
      expect(jsonOutput).toHaveProperty('chunkCount');
      expect(jsonOutput).toHaveProperty('embeddingModel');
      expect(jsonOutput).toHaveProperty('embeddingDimensions');
      expect(jsonOutput).toHaveProperty('description');
      expect(jsonOutput).toHaveProperty('issues');
      expect(jsonOutput).toHaveProperty('staleness');

      expect(jsonOutput.project).toHaveProperty('name');
      expect(jsonOutput.project).toHaveProperty('path');
      expect(jsonOutput.project).toHaveProperty('id');

      expect(jsonOutput.staleness).toHaveProperty('filesChanged');
      expect(jsonOutput.staleness).toHaveProperty('needsReindex');
      expect(jsonOutput.staleness).toHaveProperty('pathExists');
    });
  });

  describe('database initialization', () => {
    it('runs migrations before operations', async () => {
      await runCheck('test-project');
      expect(database.runMigrations).toHaveBeenCalled();
    });
  });
});
