/**
 * Tests for status command
 *
 * Tests cover:
 * - Command structure and metadata
 * - Empty database state
 * - Database statistics display
 * - JSON output format
 * - File size formatting
 * - Path formatting with home directory
 * - Config information display
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { createStatusCommand } from '../status.js';
import type { CommandContext } from '../../types.js';
import * as database from '../../../database/index.js';
import * as configLoader from '../../../config/loader.js';
import * as fs from 'node:fs';

// Mock the database module
vi.mock('../../../database/index.js', () => ({
  runMigrations: vi.fn(),
  getDb: vi.fn(),
  getDbPath: vi.fn(),
  getCtxDir: vi.fn(),
}));

// Mock the config loader
vi.mock('../../../config/loader.js', () => ({
  loadConfig: vi.fn(),
  getConfigPath: vi.fn(),
}));

// Mock node:fs for file size operations
vi.mock('node:fs', () => ({
  statSync: vi.fn(),
  existsSync: vi.fn(),
}));

describe('createStatusCommand', () => {
  let mockContext: CommandContext;
  let logOutput: string[];
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let mockDb: { prepare: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    logOutput = [];
    mockContext = {
      options: { verbose: false, json: false },
      log: (msg: string) => logOutput.push(msg),
      debug: vi.fn(),
      error: vi.fn(),
    };

    // Set up mock database with default empty stats
    mockDb = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({
          project_count: 0,
          total_chunks: 0,
        }),
      }),
    };
    vi.mocked(database.getDb).mockReturnValue(
      mockDb as unknown as ReturnType<typeof database.getDb>
    );
    vi.mocked(database.getDbPath).mockReturnValue('/Users/test/.ctx/context.db');
    vi.mocked(database.getCtxDir).mockReturnValue('/Users/test/.ctx');

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
    vi.mocked(configLoader.getConfigPath).mockReturnValue('/Users/test/.ctx/config.toml');

    // Set up mock file system
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ size: 131072 } as fs.Stats); // 128 KB

    // Spy on console.log for JSON output
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('command structure', () => {
    it('creates command with correct name', () => {
      const cmd = createStatusCommand(() => mockContext);
      expect(cmd.name()).toBe('status');
    });

    it('has description', () => {
      const cmd = createStatusCommand(() => mockContext);
      expect(cmd.description()).toBe('Show storage statistics and system health');
    });
  });

  describe('empty state', () => {
    it('shows helpful message when no projects', async () => {
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({
          project_count: 0,
          total_chunks: 0,
        }),
      });

      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      const output = logOutput.join('\n');
      expect(output).toContain('No projects indexed');
      expect(output).toContain('ctx index');
    });

    it('shows zero counts in empty state', async () => {
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({
          project_count: 0,
          total_chunks: 0,
        }),
      });

      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      const output = logOutput.join('\n');
      expect(output).toContain('Projects:');
      expect(output).toContain('0');
      expect(output).toContain('Total Chunks:');
    });
  });

  describe('with data', () => {
    beforeEach(() => {
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({
          project_count: 3,
          total_chunks: 5432,
        }),
      });
    });

    it('displays project and chunk counts', async () => {
      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      const output = logOutput.join('\n');
      expect(output).toContain('3');
      expect(output).toContain('5,432');
    });

    it('displays database size', async () => {
      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      const output = logOutput.join('\n');
      expect(output).toContain('128 KB');
    });

    it('displays embedding provider info', async () => {
      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      const output = logOutput.join('\n');
      expect(output).toContain('BAAI/bge-large-en-v1.5');
      expect(output).toContain('huggingface');
    });

    it('displays LLM provider info', async () => {
      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      const output = logOutput.join('\n');
      expect(output).toContain('anthropic');
      expect(output).toContain('claude-sonnet-4-20250514');
    });

    it('does not show empty state hint when projects exist', async () => {
      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      const output = logOutput.join('\n');
      expect(output).not.toContain('No projects indexed');
    });
  });

  describe('JSON output', () => {
    beforeEach(() => {
      mockContext.options.json = true;
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({
          project_count: 5,
          total_chunks: 10000,
        }),
      });
    });

    it('outputs valid JSON', async () => {
      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      expect(consoleLogSpy).toHaveBeenCalled();
      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput).toBeDefined();
    });

    it('includes project and chunk counts', async () => {
      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.projects).toBe(5);
      expect(jsonOutput.totalChunks).toBe(10000);
    });

    it('includes database info with raw and formatted size', async () => {
      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.database).toBeDefined();
      expect(jsonOutput.database.path).toBe('/Users/test/.ctx/context.db');
      expect(jsonOutput.database.size).toBe(131072);
      expect(jsonOutput.database.sizeFormatted).toBe('128 KB');
    });

    it('includes embedding configuration', async () => {
      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.embedding).toBeDefined();
      expect(jsonOutput.embedding.provider).toBe('huggingface');
      expect(jsonOutput.embedding.model).toBe('BAAI/bge-large-en-v1.5');
    });

    it('includes LLM configuration', async () => {
      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.llm).toBeDefined();
      expect(jsonOutput.llm.provider).toBe('anthropic');
      expect(jsonOutput.llm.model).toBe('claude-sonnet-4-20250514');
    });

    it('includes config path', async () => {
      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.config).toBeDefined();
      expect(jsonOutput.config.path).toBe('/Users/test/.ctx/config.toml');
    });
  });

  describe('file size formatting', () => {
    it('formats 0 bytes', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      const output = logOutput.join('\n');
      expect(output).toContain('0 Bytes');
    });

    it('formats kilobytes', async () => {
      vi.mocked(fs.statSync).mockReturnValue({ size: 5120 } as fs.Stats);

      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      const output = logOutput.join('\n');
      expect(output).toContain('5 KB');
    });

    it('formats megabytes', async () => {
      vi.mocked(fs.statSync).mockReturnValue({ size: 134217728 } as fs.Stats); // 128 MB

      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      const output = logOutput.join('\n');
      expect(output).toContain('128 MB');
    });

    it('formats gigabytes', async () => {
      vi.mocked(fs.statSync).mockReturnValue({ size: 2147483648 } as fs.Stats); // 2 GB

      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      const output = logOutput.join('\n');
      expect(output).toContain('2 GB');
    });
  });

  describe('path formatting', () => {
    it('replaces home directory with ~', async () => {
      const originalHome = process.env['HOME'];
      process.env['HOME'] = '/Users/test';

      vi.mocked(database.getDbPath).mockReturnValue('/Users/test/.ctx/context.db');
      vi.mocked(configLoader.getConfigPath).mockReturnValue('/Users/test/.ctx/config.toml');

      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      const output = logOutput.join('\n');
      expect(output).toContain('~/.ctx/context.db');
      expect(output).toContain('~/.ctx/config.toml');

      process.env['HOME'] = originalHome;
    });
  });

  describe('database initialization', () => {
    it('runs migrations before querying', async () => {
      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      expect(database.runMigrations).toHaveBeenCalled();
    });

    it('queries database with aggregate SQL', async () => {
      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      expect(mockDb.prepare).toHaveBeenCalled();
      const sqlCall = mockDb.prepare.mock.calls[0][0];

      expect(sqlCall).toContain('SELECT');
      expect(sqlCall).toContain('COUNT');
      expect(sqlCall).toContain('SUM');
      expect(sqlCall).toContain('FROM projects');
    });
  });

  describe('debug logging', () => {
    it('logs debug message when fetching status', async () => {
      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      expect(mockContext.debug).toHaveBeenCalledWith('Fetching system status...');
    });

    it('logs statistics in debug mode', async () => {
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({
          project_count: 2,
          total_chunks: 1000,
        }),
      });

      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      expect(mockContext.debug).toHaveBeenCalledWith('Projects: 2, Chunks: 1000');
    });
  });

  describe('output formatting', () => {
    it('includes title', async () => {
      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      const output = logOutput.join('\n');
      expect(output).toContain('Context Expert Status');
    });

    it('includes separator line', async () => {
      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      const output = logOutput.join('\n');
      expect(output).toContain('─');
    });

    it('formats large numbers with separators', async () => {
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({
          project_count: 1000000,
          total_chunks: 5000000,
        }),
      });

      const cmd = createStatusCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'status']);

      const output = logOutput.join('\n');
      // Check that numbers are formatted with separators (locale-agnostic)
      // toLocaleString() uses system locale, so we check for presence of formatted number
      const expectedProjectCount = (1000000).toLocaleString();
      const expectedChunkCount = (5000000).toLocaleString();
      expect(output).toContain(expectedProjectCount);
      expect(output).toContain(expectedChunkCount);
    });
  });
});
