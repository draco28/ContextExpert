/**
 * Tests for remove command
 *
 * Tests cover:
 * - Command structure (name, alias, arguments, options)
 * - Non-existent project error
 * - Confirmation required without --force
 * - Successful deletion with --force
 * - JSON output format
 * - Storage calculation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { createRemoveCommand } from '../remove.js';
import type { CommandContext } from '../../types.js';
import * as database from '../../../database/index.js';
import * as migrate from '../../../database/migrate.js';

// Mock the database module
vi.mock('../../../database/index.js', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('../../../database/migrate.js', () => ({
  runMigrations: vi.fn(),
}));

describe('createRemoveCommand', () => {
  let mockContext: CommandContext;
  let logOutput: string[];
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let mockDbOps: {
    getProjectByName: ReturnType<typeof vi.fn>;
    deleteProject: ReturnType<typeof vi.fn>;
  };

  const mockProject = {
    id: 'uuid-123',
    name: 'test-project',
    path: '/Users/test/projects/test-project',
    tags: null,
    ignore_patterns: null,
    indexed_at: '2024-01-15T10:00:00.000Z',
    updated_at: '2024-01-20T15:30:00.000Z',
    file_count: 150,
    chunk_count: 500,
    config: null,
  };

  beforeEach(() => {
    logOutput = [];
    mockContext = {
      options: { verbose: false, json: false },
      log: (msg: string) => logOutput.push(msg),
      debug: vi.fn(),
      error: vi.fn(),
    };

    // Set up mock database operations
    mockDbOps = {
      getProjectByName: vi.fn(),
      deleteProject: vi.fn(),
    };
    vi.mocked(database.getDatabase).mockReturnValue(mockDbOps as unknown as ReturnType<typeof database.getDatabase>);

    // Spy on console.log for JSON output
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Reset process.exitCode
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  describe('command structure', () => {
    it('creates command with correct name', () => {
      const cmd = createRemoveCommand(() => mockContext);
      expect(cmd.name()).toBe('remove');
    });

    it('has rm alias', () => {
      const cmd = createRemoveCommand(() => mockContext);
      expect(cmd.aliases()).toContain('rm');
    });

    it('has description', () => {
      const cmd = createRemoveCommand(() => mockContext);
      expect(cmd.description()).toBe('Remove an indexed project and all its data');
    });

    it('requires name argument', () => {
      const cmd = createRemoveCommand(() => mockContext);
      // Commander registers arguments in _args array
      const args = (cmd as unknown as { registeredArguments: Array<{ required: boolean; name: () => string }> }).registeredArguments;
      expect(args).toHaveLength(1);
      expect(args[0].required).toBe(true);
      expect(args[0].name()).toBe('name');
    });

    it('has --force option', () => {
      const cmd = createRemoveCommand(() => mockContext);
      const forceOption = cmd.options.find(opt => opt.long === '--force');
      expect(forceOption).toBeDefined();
      expect(forceOption?.short).toBe('-f');
    });
  });

  describe('non-existent project', () => {
    it('throws CLIError when project not found', async () => {
      mockDbOps.getProjectByName.mockReturnValue(undefined);

      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);
      program.exitOverride();

      await expect(
        program.parseAsync(['node', 'test', 'remove', 'nonexistent', '--force'])
      ).rejects.toThrow('Project not found: nonexistent');
    });

    it('provides helpful hint in error message', async () => {
      mockDbOps.getProjectByName.mockReturnValue(undefined);

      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);
      program.exitOverride();

      try {
        await program.parseAsync(['node', 'test', 'remove', 'nonexistent', '--force']);
      } catch (error: unknown) {
        if (error && typeof error === 'object' && 'hint' in error) {
          expect((error as { hint: string }).hint).toContain('ctx list');
        }
      }
    });
  });

  describe('confirmation behavior', () => {
    beforeEach(() => {
      mockDbOps.getProjectByName.mockReturnValue(mockProject);
    });

    it('shows warning without --force flag', async () => {
      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);

      await program.parseAsync(['node', 'test', 'remove', 'test-project']);

      const output = logOutput.join('\n');
      expect(output).toContain('permanently delete');
      expect(output).toContain('test-project');
      expect(output).toContain('--force');
    });

    it('shows project details in warning', async () => {
      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);

      await program.parseAsync(['node', 'test', 'remove', 'test-project']);

      const output = logOutput.join('\n');
      expect(output).toContain(mockProject.path);
      expect(output).toContain('500'); // chunk_count
      expect(output).toContain('150'); // file_count
    });

    it('sets exit code 1 without --force', async () => {
      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);

      await program.parseAsync(['node', 'test', 'remove', 'test-project']);

      expect(process.exitCode).toBe(1);
    });

    it('does not delete without --force', async () => {
      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);

      await program.parseAsync(['node', 'test', 'remove', 'test-project']);

      expect(mockDbOps.deleteProject).not.toHaveBeenCalled();
    });
  });

  describe('successful deletion with --force', () => {
    beforeEach(() => {
      mockDbOps.getProjectByName.mockReturnValue(mockProject);
      mockDbOps.deleteProject.mockReturnValue({
        chunksDeleted: 500,
        fileHashesDeleted: 150,
      });
    });

    it('deletes project with --force flag', async () => {
      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);

      await program.parseAsync(['node', 'test', 'remove', 'test-project', '--force']);

      expect(mockDbOps.deleteProject).toHaveBeenCalledWith('uuid-123');
    });

    it('deletes project with -f short flag', async () => {
      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);

      await program.parseAsync(['node', 'test', 'remove', 'test-project', '-f']);

      expect(mockDbOps.deleteProject).toHaveBeenCalledWith('uuid-123');
    });

    it('shows success message', async () => {
      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);

      await program.parseAsync(['node', 'test', 'remove', 'test-project', '--force']);

      const output = logOutput.join('\n');
      expect(output).toContain('Removed project');
      expect(output).toContain('test-project');
    });

    it('shows deletion summary', async () => {
      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);

      await program.parseAsync(['node', 'test', 'remove', 'test-project', '--force']);

      const output = logOutput.join('\n');
      expect(output).toContain('500'); // chunks deleted
      expect(output).toContain('150'); // file hashes deleted
      expect(output).toContain('Storage freed');
    });

    it('does not set exit code on success', async () => {
      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);

      await program.parseAsync(['node', 'test', 'remove', 'test-project', '--force']);

      expect(process.exitCode).toBeUndefined();
    });
  });

  describe('JSON output', () => {
    beforeEach(() => {
      mockDbOps.getProjectByName.mockReturnValue(mockProject);
      mockDbOps.deleteProject.mockReturnValue({
        chunksDeleted: 500,
        fileHashesDeleted: 150,
      });
      mockContext.options.json = true;
    });

    it('requires --force in JSON mode', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);

      // No --force flag - should NOT delete
      await program.parseAsync(['node', 'test', 'remove', 'test-project']);

      expect(mockDbOps.deleteProject).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);

      // Should output structured JSON error to stderr
      expect(consoleErrorSpy).toHaveBeenCalled();
      const errorOutput = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(errorOutput.error).toBe('confirmation_required');
      expect(errorOutput.action).toBe('remove');
      expect(errorOutput.project.name).toBe('test-project');
      expect(errorOutput.hint).toContain('--force');

      consoleErrorSpy.mockRestore();
    });

    it('outputs valid JSON', async () => {
      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);

      await program.parseAsync(['node', 'test', 'remove', 'test-project', '--force']);

      expect(consoleLogSpy).toHaveBeenCalled();
      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput).toBeDefined();
    });

    it('includes success flag in JSON output', async () => {
      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);

      await program.parseAsync(['node', 'test', 'remove', 'test-project', '--force']);

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.success).toBe(true);
    });

    it('includes project info in JSON output', async () => {
      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);

      await program.parseAsync(['node', 'test', 'remove', 'test-project', '--force']);

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.project.id).toBe('uuid-123');
      expect(jsonOutput.project.name).toBe('test-project');
      expect(jsonOutput.project.path).toBe('/Users/test/projects/test-project');
    });

    it('includes deletion counts in JSON output', async () => {
      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);

      await program.parseAsync(['node', 'test', 'remove', 'test-project', '--force']);

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.deleted.chunks).toBe(500);
      expect(jsonOutput.deleted.fileHashes).toBe(150);
    });

    it('includes storage freed estimate in JSON output', async () => {
      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);

      await program.parseAsync(['node', 'test', 'remove', 'test-project', '--force']);

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      // 500 chunks * 2048 bytes = 1024000 bytes
      expect(jsonOutput.storageFreed).toBe(1024000);
    });
  });

  describe('storage calculation', () => {
    beforeEach(() => {
      mockDbOps.getProjectByName.mockReturnValue(mockProject);
    });

    it('calculates storage based on chunk count', async () => {
      mockDbOps.deleteProject.mockReturnValue({
        chunksDeleted: 1000,
        fileHashesDeleted: 100,
      });

      mockContext.options.json = true;
      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);

      await program.parseAsync(['node', 'test', 'remove', 'test-project', '--force']);

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      // 1000 chunks * 2048 bytes = 2048000 bytes
      expect(jsonOutput.storageFreed).toBe(2048000);
    });

    it('handles zero chunks', async () => {
      mockDbOps.deleteProject.mockReturnValue({
        chunksDeleted: 0,
        fileHashesDeleted: 0,
      });

      mockContext.options.json = true;
      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);

      await program.parseAsync(['node', 'test', 'remove', 'test-project', '--force']);

      const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(jsonOutput.storageFreed).toBe(0);
    });
  });

  describe('database initialization', () => {
    beforeEach(() => {
      mockDbOps.getProjectByName.mockReturnValue(mockProject);
      mockDbOps.deleteProject.mockReturnValue({
        chunksDeleted: 500,
        fileHashesDeleted: 150,
      });
    });

    it('runs migrations before operations', async () => {
      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);

      await program.parseAsync(['node', 'test', 'remove', 'test-project', '--force']);

      expect(migrate.runMigrations).toHaveBeenCalled();
    });
  });

  describe('debug logging', () => {
    beforeEach(() => {
      mockDbOps.getProjectByName.mockReturnValue(mockProject);
      mockDbOps.deleteProject.mockReturnValue({
        chunksDeleted: 500,
        fileHashesDeleted: 150,
      });
    });

    it('logs command invocation', async () => {
      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);

      await program.parseAsync(['node', 'test', 'remove', 'test-project', '--force']);

      expect(mockContext.debug).toHaveBeenCalledWith(
        expect.stringContaining('Remove command called')
      );
    });

    it('logs found project info', async () => {
      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);

      await program.parseAsync(['node', 'test', 'remove', 'test-project', '--force']);

      expect(mockContext.debug).toHaveBeenCalledWith(
        expect.stringContaining('Found project')
      );
    });

    it('logs deletion results', async () => {
      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);

      await program.parseAsync(['node', 'test', 'remove', 'test-project', '--force']);

      expect(mockContext.debug).toHaveBeenCalledWith(
        expect.stringContaining('Deleted 500 chunks')
      );
    });
  });

  describe('alias usage', () => {
    beforeEach(() => {
      mockDbOps.getProjectByName.mockReturnValue(mockProject);
      mockDbOps.deleteProject.mockReturnValue({
        chunksDeleted: 500,
        fileHashesDeleted: 150,
      });
    });

    it('works with rm alias', async () => {
      const cmd = createRemoveCommand(() => mockContext);
      const program = new Command();
      program.addCommand(cmd);

      await program.parseAsync(['node', 'test', 'rm', 'test-project', '--force']);

      expect(mockDbOps.deleteProject).toHaveBeenCalledWith('uuid-123');
    });
  });
});
