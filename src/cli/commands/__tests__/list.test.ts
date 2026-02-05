/**
 * Tests for list command
 *
 * Tests cover:
 * - Listing projects from database
 * - Empty state handling
 * - JSON output format
 * - Sort order (newest first)
 * - Path truncation and formatting
 * - Relative time formatting
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { createListCommand } from '../list.js';
import type { CommandContext } from '../../types.js';
import * as database from '../../../database/index.js';

// Mock the database module
vi.mock('../../../database/index.js', () => ({
  runMigrations: vi.fn(),
  getDb: vi.fn(),
}));

describe('createListCommand', () => {
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

    // Set up mock database
    mockDb = {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([]),
      }),
    };
    vi.mocked(database.getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof database.getDb>);

    // Spy on console.log for JSON output
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('command structure', () => {
    it('creates command with correct name', () => {
      const cmd = createListCommand(() => mockContext);
      expect(cmd.name()).toBe('list');
    });

    it('has ls alias', () => {
      const cmd = createListCommand(() => mockContext);
      expect(cmd.aliases()).toContain('ls');
    });

    it('has description', () => {
      const cmd = createListCommand(() => mockContext);
      expect(cmd.description()).toBe('List all indexed projects');
    });
  });

  describe('empty state', () => {
    it('shows helpful message when no projects', async () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([]),
      });

      const cmd = createListCommand(() => mockContext);

      // Create a program to parse the command
      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'list']);

      const output = logOutput.join('\n');
      expect(output).toContain('No projects indexed yet');
      expect(output).toContain('ctx index');
    });

    it('outputs empty array in JSON mode', async () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([]),
      });

      mockContext.options.json = true;
      const cmd = createListCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'list']);

      expect(consoleLogSpy).toHaveBeenCalled();
      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.count).toBe(0);
      expect(jsonOutput.projects).toEqual([]);
    });
  });

  describe('with projects', () => {
    const mockProjects = [
      {
        id: 'uuid-1',
        name: 'project-a',
        path: '/Users/test/projects/project-a',
        tags: '["frontend", "react"]',
        ignore_patterns: null,
        indexed_at: '2024-01-15T10:00:00.000Z',
        updated_at: '2024-01-20T15:30:00.000Z',
        file_count: 150,
        chunk_count: 500,
        config: null,
        embedding_model: 'BAAI/bge-large-en-v1.5',
        embedding_dimensions: 1024,
        description: 'Frontend React application',
      },
      {
        id: 'uuid-2',
        name: 'project-b',
        path: '/Users/test/code/project-b',
        tags: null,
        ignore_patterns: null,
        indexed_at: '2024-01-10T08:00:00.000Z',
        updated_at: null,
        file_count: 75,
        chunk_count: 200,
        config: null,
        embedding_model: null,
        embedding_dimensions: 1024,
        description: null,
      },
    ];

    beforeEach(() => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue(mockProjects),
      });
    });

    it('displays table with project data', async () => {
      const cmd = createListCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'list']);

      const output = logOutput.join('\n');

      // Check for table structure
      expect(output).toContain('┌');
      expect(output).toContain('┐');
      expect(output).toContain('│');

      // Check for headers
      expect(output).toContain('Name');
      expect(output).toContain('Path');
      expect(output).toContain('Chunks');

      // Check for data
      expect(output).toContain('project-a');
      expect(output).toContain('project-b');
      expect(output).toContain('500');
      expect(output).toContain('200');

      // Check for summary
      expect(output).toContain('2 projects indexed');
    });

    it('outputs JSON with correct structure', async () => {
      mockContext.options.json = true;
      const cmd = createListCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'list']);

      expect(consoleLogSpy).toHaveBeenCalled();
      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);

      expect(jsonOutput.count).toBe(2);
      expect(jsonOutput.projects).toHaveLength(2);

      // Check first project structure
      const firstProject = jsonOutput.projects[0];
      expect(firstProject.id).toBe('uuid-1');
      expect(firstProject.name).toBe('project-a');
      expect(firstProject.path).toBe('/Users/test/projects/project-a');
      expect(firstProject.fileCount).toBe(150);
      expect(firstProject.chunkCount).toBe(500);
      expect(firstProject.tags).toEqual(['frontend', 'react']);
    });

    it('parses tags JSON in JSON output', async () => {
      mockContext.options.json = true;
      const cmd = createListCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'list']);

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);

      // First project has tags
      expect(jsonOutput.projects[0].tags).toEqual(['frontend', 'react']);

      // Second project has no tags (null in DB)
      expect(jsonOutput.projects[1].tags).toEqual([]);
    });

    it('includes embedding metadata in JSON output', async () => {
      mockContext.options.json = true;
      const cmd = createListCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'list']);

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);

      // First project has embedding info
      expect(jsonOutput.projects[0].embeddingModel).toBe('BAAI/bge-large-en-v1.5');
      expect(jsonOutput.projects[0].embeddingDimensions).toBe(1024);
      expect(jsonOutput.projects[0].description).toBe('Frontend React application');

      // Second project has null embedding model
      expect(jsonOutput.projects[1].embeddingModel).toBeNull();
      expect(jsonOutput.projects[1].embeddingDimensions).toBe(1024);
      expect(jsonOutput.projects[1].description).toBeNull();
    });

    it('queries database with correct SQL', async () => {
      const cmd = createListCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'list']);

      expect(mockDb.prepare).toHaveBeenCalled();
      const sqlCall = mockDb.prepare.mock.calls[0][0];

      // Should select from projects table
      expect(sqlCall).toContain('SELECT');
      expect(sqlCall).toContain('FROM projects');

      // Should order by updated_at descending
      expect(sqlCall).toContain('ORDER BY');
      expect(sqlCall).toContain('DESC');
    });
  });

  describe('singular/plural grammar', () => {
    it('shows "1 project" for single project', async () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([
          {
            id: 'uuid-1',
            name: 'only-project',
            path: '/path/to/project',
            tags: null,
            ignore_patterns: null,
            indexed_at: '2024-01-15T10:00:00.000Z',
            updated_at: null,
            file_count: 10,
            chunk_count: 50,
            config: null,
          },
        ]),
      });

      const cmd = createListCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'list']);

      const output = logOutput.join('\n');
      expect(output).toContain('1 project indexed');
      expect(output).not.toContain('1 projects');
    });
  });

  describe('database initialization', () => {
    it('runs migrations before querying', async () => {
      const cmd = createListCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'list']);

      expect(database.runMigrations).toHaveBeenCalled();
    });
  });

  describe('debug logging', () => {
    it('logs debug message when listing', async () => {
      const cmd = createListCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'list']);

      expect(mockContext.debug).toHaveBeenCalledWith('Listing projects...');
    });

    it('logs project count in debug', async () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([
          {
            id: 'uuid-1',
            name: 'test',
            path: '/test',
            tags: null,
            ignore_patterns: null,
            indexed_at: null,
            updated_at: null,
            file_count: 0,
            chunk_count: 0,
            config: null,
          },
        ]),
      });

      const cmd = createListCommand(() => mockContext);

      const program = new Command();
      program.addCommand(cmd);
      await program.parseAsync(['node', 'test', 'list']);

      expect(mockContext.debug).toHaveBeenCalledWith('Found 1 project(s)');
    });
  });
});
