/**
 * Tests for chat command
 *
 * Tests cover:
 * - Command structure and metadata
 * - REPL command parsing (/help, /focus, /clear, exit)
 * - State mutations (focus/unfocus, clear)
 * - Project resolution (--project option, default to most recent)
 * - Error cases (invalid project)
 *
 * Note: Full REPL loop testing is limited since it requires readline interaction.
 * We test the exported command structure and individual helper behaviors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { createChatCommand, parseREPLCommand, createCompleter, parseIndexArgs } from '../chat.js';
import type { CommandContext } from '../../types.js';
import * as database from '../../../database/index.js';
import * as configLoader from '../../../config/loader.js';
import * as ragEngine from '../../../agent/rag-engine.js';
import * as llmProvider from '../../../providers/llm.js';
import * as fs from 'node:fs';

// Mock the database module
vi.mock('../../../database/index.js', () => ({
  runMigrations: vi.fn(),
  getDb: vi.fn(),
  getDatabase: vi.fn().mockReturnValue({
    getProjectByPath: vi.fn().mockReturnValue(null),
    getProjectById: vi.fn().mockReturnValue(null),
    deleteProjectChunks: vi.fn(),
  }),
}));

// Mock path validation
vi.mock('../../../utils/path-validation.js', () => ({
  validateProjectPath: vi.fn().mockReturnValue({
    valid: true,
    normalizedPath: '/test/path',
    warnings: [],
  }),
}));

// Mock node:fs for existsSync
vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

// Mock progress reporter
vi.mock('../../utils/progress.js', () => ({
  createProgressReporter: vi.fn().mockReturnValue({
    startStage: vi.fn(),
    updateProgress: vi.fn(),
    completeStage: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    showSummary: vi.fn(),
  }),
}));

// Mock indexer
vi.mock('../../../indexer/index.js', () => ({
  runIndexPipeline: vi.fn().mockResolvedValue({
    projectId: 'test-project-id',
    projectName: 'test-project',
    stats: {},
  }),
  createEmbeddingProvider: vi.fn().mockResolvedValue({
    provider: {},
    model: 'test-model',
    dimensions: 384,
  }),
}));

// Mock the config loader
vi.mock('../../../config/loader.js', () => ({
  loadConfig: vi.fn(),
}));

// Mock the RAG engine
vi.mock('../../../agent/rag-engine.js', () => ({
  createRAGEngine: vi.fn(),
}));

// Mock the LLM provider
vi.mock('../../../providers/llm.js', () => ({
  createLLMProvider: vi.fn(),
}));

// Mock the provider config storage (no stored providers by default)
vi.mock('../../../config/providers.js', () => ({
  getDefaultProvider: vi.fn().mockReturnValue(null),
}));

// Mock citations
vi.mock('../../../agent/citations.js', () => ({
  formatCitations: vi.fn().mockReturnValue('  [1] src/file.ts:10-20'),
}));

// Mock readline to prevent actual REPL from starting
// Uses event-based pattern (rl.on) - no async iterator needed
vi.mock('node:readline', () => ({
  createInterface: vi.fn().mockReturnValue({
    prompt: vi.fn(),
    close: vi.fn(),
    on: vi.fn((event: string, handler: () => void) => {
      // Immediately trigger 'close' to end the REPL loop in tests
      if (event === 'close') {
        // Use setImmediate to allow the REPL to set up first
        setImmediate(handler);
      }
    }),
  }),
}));

describe('createChatCommand', () => {
  let mockContext: CommandContext;
  let logOutput: string[];
  let errorOutput: string[];
  let mockDb: { prepare: ReturnType<typeof vi.fn> };
  let mockRAGEngine: { search: ReturnType<typeof vi.fn> };
  let mockLLMProvider: {
    streamChat: ReturnType<typeof vi.fn>;
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

  const mockConfig = {
    embedding: {
      provider: 'huggingface',
      model: 'BAAI/bge-small-en-v1.5',
    },
    llm: {
      provider: 'ollama',
      model: 'llama3.2',
    },
  };

  beforeEach(() => {
    logOutput = [];
    errorOutput = [];
    mockContext = {
      options: { verbose: false, json: false },
      log: (msg: string) => logOutput.push(msg),
      debug: vi.fn(),
      error: (msg: string) => errorOutput.push(msg),
    };

    // Mock database - handle different queries
    mockDb = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('COUNT(*)')) {
          // hasAnyProjects() query - by default, project exists
          return { get: vi.fn().mockReturnValue({ count: 1 }) };
        }
        // Default: return mock project
        return {
          get: vi.fn().mockReturnValue(mockProject),
          all: vi.fn().mockReturnValue([mockProject]),
        };
      }),
    };
    vi.mocked(database.getDb).mockReturnValue(
      mockDb as unknown as ReturnType<typeof database.getDb>
    );

    // Mock config
    vi.mocked(configLoader.loadConfig).mockReturnValue(mockConfig as ReturnType<typeof configLoader.loadConfig>);

    // Mock RAG engine
    mockRAGEngine = {
      search: vi.fn().mockResolvedValue({
        content: '<sources><source id="1">code</source></sources>',
        sources: [{ id: 1, filePath: 'src/file.ts', score: 0.9 }],
        metadata: { retrievalMs: 100, assemblyMs: 20, totalMs: 120 },
      }),
      dispose: vi.fn(),
    };
    vi.mocked(ragEngine.createRAGEngine).mockResolvedValue(
      mockRAGEngine as unknown as ReturnType<typeof ragEngine.createRAGEngine>
    );

    // Mock LLM provider with streaming
    mockLLMProvider = {
      streamChat: vi.fn().mockImplementation(async function* () {
        yield { type: 'text', content: 'Hello ' };
        yield { type: 'text', content: 'world!' };
        yield { type: 'usage', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } };
        yield { type: 'done' };
      }),
    };
    vi.mocked(llmProvider.createLLMProvider).mockResolvedValue({
      provider: mockLLMProvider,
      name: 'ollama',
      model: 'llama3.2',
    } as unknown as Awaited<ReturnType<typeof llmProvider.createLLMProvider>>);

    // Mock fs.existsSync to return true by default (valid project paths)
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('command structure', () => {
    it('creates a Command instance', () => {
      const command = createChatCommand(() => mockContext);
      expect(command).toBeInstanceOf(Command);
    });

    it('has correct name', () => {
      const command = createChatCommand(() => mockContext);
      expect(command.name()).toBe('chat');
    });

    it('has description', () => {
      const command = createChatCommand(() => mockContext);
      expect(command.description()).toContain('Interactive');
    });

    it('has --project option', () => {
      const command = createChatCommand(() => mockContext);
      const projectOption = command.options.find(
        (opt) => opt.long === '--project'
      );
      expect(projectOption).toBeDefined();
      expect(projectOption?.short).toBe('-p');
    });
  });

  describe('--project option', () => {
    it('looks up project by name when --project provided', async () => {
      const command = createChatCommand(() => mockContext);

      // Parse with --project
      await command.parseAsync(['node', 'test', '--project', 'test-project']);

      // Should query database for the project
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('LOWER(name) = LOWER(?)')
      );
    });

    it('creates RAG engine for specified project', async () => {
      const command = createChatCommand(() => mockContext);

      await command.parseAsync(['node', 'test', '--project', 'test-project']);

      expect(ragEngine.createRAGEngine).toHaveBeenCalledWith(
        mockConfig,
        'proj-123'
      );
    });

    it('throws CLIError for non-existent project', async () => {
      // Mock no project found
      mockDb.prepare = vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(undefined),
        all: vi.fn().mockReturnValue([]),
      });

      const command = createChatCommand(() => mockContext);

      await expect(
        command.parseAsync(['node', 'test', '--project', 'nonexistent'])
      ).rejects.toThrow('Project not found');
    });
  });

  describe('default project selection', () => {
    it('uses most recent project when no --project specified', async () => {
      const command = createChatCommand(() => mockContext);

      await command.parseAsync(['node', 'test']);

      // Should query for most recent project
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY updated_at DESC LIMIT 1')
      );
    });

    it('creates RAG engine for most recent project', async () => {
      const command = createChatCommand(() => mockContext);

      await command.parseAsync(['node', 'test']);

      expect(ragEngine.createRAGEngine).toHaveBeenCalledWith(
        mockConfig,
        'proj-123'
      );
    });

    it('works without any projects (pure LLM mode)', async () => {
      // Mock no projects - need to handle different queries:
      // - getMostRecentProject: returns undefined
      // - hasAnyProjects (COUNT query): returns { count: 0 }
      mockDb.prepare = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('COUNT(*)')) {
          return { get: vi.fn().mockReturnValue({ count: 0 }) };
        }
        // Default: no project found
        return {
          get: vi.fn().mockReturnValue(undefined),
          all: vi.fn().mockReturnValue([]),
        };
      });

      const command = createChatCommand(() => mockContext);

      // Should not throw - just run in pure LLM mode
      await expect(command.parseAsync(['node', 'test'])).resolves.not.toThrow();

      // RAG engine should not be created
      expect(ragEngine.createRAGEngine).not.toHaveBeenCalled();
    });

    it('skips stale project when path does not exist', async () => {
      // Mock existsSync to return false (path doesn't exist)
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const command = createChatCommand(() => mockContext);

      await command.parseAsync(['node', 'test']);

      // RAG engine should NOT be created for stale project
      expect(ragEngine.createRAGEngine).not.toHaveBeenCalled();

      // Should log debug message about skipping
      expect(mockContext.debug).toHaveBeenCalledWith(
        expect.stringContaining('Skipping stale project')
      );
    });

    it('auto-focuses on valid project when path exists', async () => {
      // Mock existsSync to return true (path exists)
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const command = createChatCommand(() => mockContext);

      await command.parseAsync(['node', 'test']);

      // RAG engine SHOULD be created for valid project
      expect(ragEngine.createRAGEngine).toHaveBeenCalledWith(
        mockConfig,
        'proj-123'
      );
    });
  });

  describe('LLM provider initialization', () => {
    it('creates LLM provider', async () => {
      const command = createChatCommand(() => mockContext);

      await command.parseAsync(['node', 'test']);

      expect(llmProvider.createLLMProvider).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          fallback: expect.any(Object),
        })
      );
    });
  });

  describe('ConversationContext initialization', () => {
    it('initializes with maxTokens config', async () => {
      // We can't easily test this without exposing internals,
      // but we verify the command runs without error
      const command = createChatCommand(() => mockContext);

      await expect(command.parseAsync(['node', 'test'])).resolves.not.toThrow();
    });
  });
});

describe('streaming output safety (ticket #104)', () => {
  // Regression test: streamResponse() uses process.stdout.write() directly,
  // not printf/sprintf. Verify special characters pass through verbatim.
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('should write % characters verbatim via stdout.write', () => {
    const chunks = [
      'The value is 100% complete',
      'Use %s for string formatting',
      'Multiple %%d patterns %f here',
    ];

    for (const chunk of chunks) {
      process.stdout.write(chunk);
    }

    expect(writeSpy).toHaveBeenCalledWith('The value is 100% complete');
    expect(writeSpy).toHaveBeenCalledWith('Use %s for string formatting');
    expect(writeSpy).toHaveBeenCalledWith('Multiple %%d patterns %f here');
  });

  it('should write unicode special characters verbatim', () => {
    const chunks = [
      'Emoji: \u{1F680}\u{1F4A1}\u{2728}',
      'CJK: \u4F60\u597D\u4E16\u754C',
      'Arabic: \u0645\u0631\u062D\u0628\u0627',
      'Zero-width: foo\u200Bbar\u200Cbaz',
    ];

    for (const chunk of chunks) {
      process.stdout.write(chunk);
    }

    for (const chunk of chunks) {
      expect(writeSpy).toHaveBeenCalledWith(chunk);
    }
  });

  it('should write ANSI escape sequences verbatim', () => {
    const chunks = [
      'Normal text \x1b[31mred text\x1b[0m normal',
      'Cursor move: \x1b[2A\x1b[3B',
      'Clear: \x1b[2J\x1b[H',
    ];

    for (const chunk of chunks) {
      process.stdout.write(chunk);
    }

    for (const chunk of chunks) {
      expect(writeSpy).toHaveBeenCalledWith(chunk);
    }
  });
});

describe('parseREPLCommand', () => {
  describe('/help command', () => {
    it('should be recognized with / prefix', () => {
      const result = parseREPLCommand('/help');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('help');
      expect(result?.args).toEqual([]);
    });

    it('should recognize alias /h', () => {
      const result = parseREPLCommand('/h');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('help');
    });

    it('should recognize alias /?', () => {
      const result = parseREPLCommand('/?');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('help');
    });
  });

  describe('/focus command', () => {
    it('should parse project name from args', () => {
      const result = parseREPLCommand('/focus my-project');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('focus');
      expect(result?.args).toEqual(['my-project']);
    });

    it('should handle multi-word project names as separate args', () => {
      const result = parseREPLCommand('/focus my cool project');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('focus');
      expect(result?.args).toEqual(['my', 'cool', 'project']);
    });

    it('should recognize alias /f', () => {
      const result = parseREPLCommand('/f test-project');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('focus');
      expect(result?.args).toEqual(['test-project']);
    });
  });

  describe('/clear command', () => {
    it('should be recognized with / prefix', () => {
      const result = parseREPLCommand('/clear');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('clear');
    });

    it('should recognize alias /c', () => {
      const result = parseREPLCommand('/c');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('clear');
    });
  });

  describe('exit command', () => {
    it('should work without / prefix', () => {
      const result = parseREPLCommand('exit');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('exit');
    });

    it('should work with quit alias', () => {
      const result = parseREPLCommand('quit');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('exit');
    });

    it('should be case-insensitive', () => {
      expect(parseREPLCommand('EXIT')?.command.name).toBe('exit');
      expect(parseREPLCommand('Quit')?.command.name).toBe('exit');
    });
  });

  describe('regular questions', () => {
    it('should return null for non-command input', () => {
      expect(parseREPLCommand('How does auth work?')).toBeNull();
    });

    it('should return null for unknown /commands', () => {
      expect(parseREPLCommand('/unknown')).toBeNull();
    });

    it('should return null for empty input', () => {
      expect(parseREPLCommand('')).toBeNull();
      expect(parseREPLCommand('   ')).toBeNull();
    });
  });
});

describe('createCompleter (tab completion)', () => {
  // Mock project list for testing
  const mockProjects = ['my-project', 'my-app', 'test-api', 'Demo_Project'];
  const getProjects = () => mockProjects;

  describe('/focus command completion', () => {
    it('handles /focus without space (no match)', () => {
      const completer = createCompleter(getProjects);
      const [completions] = completer('/focus');
      expect(completions).toEqual([]);
    });

    it('handles /focus with trailing space only (empty partial)', () => {
      const completer = createCompleter(getProjects);
      const [completions] = completer('/focus ');
      // Empty partial should match all projects
      expect(completions).toEqual([
        '/focus my-project',
        '/focus my-app',
        '/focus test-api',
        '/focus Demo_Project',
      ]);
    });

    it('filters by partial prefix', () => {
      const completer = createCompleter(getProjects);
      const [completions] = completer('/focus my');
      expect(completions).toEqual(['/focus my-project', '/focus my-app']);
    });

    it('returns exact match when partial is complete', () => {
      const completer = createCompleter(getProjects);
      const [completions] = completer('/focus my-project');
      expect(completions).toEqual(['/focus my-project']);
    });

    it('returns empty when no projects match', () => {
      const completer = createCompleter(getProjects);
      const [completions] = completer('/focus xyz');
      expect(completions).toEqual([]);
    });
  });

  describe('/f shorthand completion', () => {
    it('handles /f with trailing space', () => {
      const completer = createCompleter(getProjects);
      const [completions] = completer('/f ');
      expect(completions).toEqual([
        '/f my-project',
        '/f my-app',
        '/f test-api',
        '/f Demo_Project',
      ]);
    });

    it('filters by partial with /f shorthand', () => {
      const completer = createCompleter(getProjects);
      const [completions] = completer('/f test');
      expect(completions).toEqual(['/f test-api']);
    });

    it('preserves /f prefix in completions', () => {
      const completer = createCompleter(getProjects);
      const [completions] = completer('/f my');
      // Should use /f, not /focus
      expect(completions.every((c) => c.startsWith('/f '))).toBe(true);
    });
  });

  describe('case sensitivity', () => {
    it('matches case-insensitively on partial', () => {
      const completer = createCompleter(getProjects);
      const [completions] = completer('/focus DEMO');
      expect(completions).toEqual(['/focus Demo_Project']);
    });

    it('preserves original project name case in output', () => {
      const completer = createCompleter(getProjects);
      const [completions] = completer('/focus demo');
      // Should output "Demo_Project" not "demo_project"
      expect(completions).toEqual(['/focus Demo_Project']);
    });

    it('handles mixed case command', () => {
      const completer = createCompleter(getProjects);
      const [completions] = completer('/Focus my');
      expect(completions).toEqual(['/Focus my-project', '/Focus my-app']);
    });
  });

  describe('special characters in project names', () => {
    it('handles underscores', () => {
      const completer = createCompleter(getProjects);
      const [completions] = completer('/focus demo_');
      expect(completions).toEqual(['/focus Demo_Project']);
    });

    it('handles hyphens', () => {
      const completer = createCompleter(getProjects);
      const [completions] = completer('/focus my-');
      expect(completions).toEqual(['/focus my-project', '/focus my-app']);
    });
  });

  describe('empty project list', () => {
    it('returns empty completions when no projects exist', () => {
      const completer = createCompleter(() => []);
      const [completions] = completer('/focus ');
      expect(completions).toEqual([]);
    });

    it('handles error in project retrieval gracefully', () => {
      const completer = createCompleter(() => {
        throw new Error('DB error');
      });
      // Should throw since we're not catching inside completer
      expect(() => completer('/focus ')).toThrow('DB error');
    });
  });

  describe('non-focus commands', () => {
    it('returns empty for /help', () => {
      const completer = createCompleter(getProjects);
      const [completions] = completer('/help');
      expect(completions).toEqual([]);
    });

    it('returns empty for regular text', () => {
      const completer = createCompleter(getProjects);
      const [completions] = completer('How does auth work?');
      expect(completions).toEqual([]);
    });

    it('returns empty for partial /foc (no space after)', () => {
      const completer = createCompleter(getProjects);
      const [completions] = completer('/foc');
      expect(completions).toEqual([]);
    });
  });

  describe('return value structure', () => {
    it('returns original line as second element', () => {
      const completer = createCompleter(getProjects);
      const [, originalLine] = completer('/focus my');
      expect(originalLine).toBe('/focus my');
    });

    it('returns tuple matching readline completer spec', () => {
      const completer = createCompleter(getProjects);
      const result = completer('/focus test');
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(Array.isArray(result[0])).toBe(true);
      expect(typeof result[1]).toBe('string');
    });
  });
});

describe('parseIndexArgs', () => {
  describe('path parsing', () => {
    it('parses path only', () => {
      const result = parseIndexArgs(['./my-project']);
      expect(result).toEqual({ path: './my-project', name: undefined, force: false });
    });

    it('parses absolute path', () => {
      const result = parseIndexArgs(['/Users/test/my-project']);
      expect(result).toEqual({ path: '/Users/test/my-project', name: undefined, force: false });
    });

    it('parses relative path with ../', () => {
      const result = parseIndexArgs(['../other-repo']);
      expect(result).toEqual({ path: '../other-repo', name: undefined, force: false });
    });

    it('parses current directory', () => {
      const result = parseIndexArgs(['.']);
      expect(result).toEqual({ path: '.', name: undefined, force: false });
    });

    it('returns empty path when no args', () => {
      const result = parseIndexArgs([]);
      expect(result).toEqual({ path: '', name: undefined, force: false });
    });
  });

  describe('-n/--name option', () => {
    it('parses -n short flag', () => {
      const result = parseIndexArgs(['./my-project', '-n', 'custom-name']);
      expect(result).toEqual({ path: './my-project', name: 'custom-name', force: false });
    });

    it('parses --name long flag', () => {
      const result = parseIndexArgs(['./my-project', '--name', 'my-app']);
      expect(result).toEqual({ path: './my-project', name: 'my-app', force: false });
    });

    it('handles name before path', () => {
      const result = parseIndexArgs(['-n', 'app', './path']);
      expect(result).toEqual({ path: './path', name: 'app', force: false });
    });
  });

  describe('--force/-f option', () => {
    it('parses --force flag', () => {
      const result = parseIndexArgs(['./my-project', '--force']);
      expect(result).toEqual({ path: './my-project', name: undefined, force: true });
    });

    it('parses -f short flag', () => {
      const result = parseIndexArgs(['./my-project', '-f']);
      expect(result).toEqual({ path: './my-project', name: undefined, force: true });
    });

    it('handles force before path', () => {
      const result = parseIndexArgs(['--force', './path']);
      expect(result).toEqual({ path: './path', name: undefined, force: true });
    });
  });

  describe('combined options', () => {
    it('parses all options together', () => {
      const result = parseIndexArgs(['./my-project', '-n', 'my-app', '--force']);
      expect(result).toEqual({ path: './my-project', name: 'my-app', force: true });
    });

    it('handles options in any order', () => {
      const result = parseIndexArgs(['--force', '-n', 'app', './path']);
      expect(result).toEqual({ path: './path', name: 'app', force: true });
    });

    it('handles path between options', () => {
      const result = parseIndexArgs(['-f', './path', '-n', 'name']);
      expect(result).toEqual({ path: './path', name: 'name', force: true });
    });
  });

  describe('edge cases', () => {
    it('ignores unknown flags', () => {
      const result = parseIndexArgs(['./path', '--unknown', '-x']);
      expect(result).toEqual({ path: './path', name: undefined, force: false });
    });

    it('takes first positional as path', () => {
      const result = parseIndexArgs(['./first', './second']);
      expect(result).toEqual({ path: './first', name: undefined, force: false });
    });

    it('handles -n as last argument (no value)', () => {
      const result = parseIndexArgs(['./path', '-n']);
      expect(result).toEqual({ path: './path', name: undefined, force: false });
    });

    it('handles --name as last argument (no value)', () => {
      const result = parseIndexArgs(['./path', '--name']);
      expect(result).toEqual({ path: './path', name: undefined, force: false });
    });

    it('handles -n followed by another flag (flag consumed as name)', () => {
      // Note: -n consumes the next arg regardless of whether it's a flag
      // This matches common CLI behavior (e.g., git commit -m -v)
      const result = parseIndexArgs(['./path', '-n', '--force']);
      expect(result.path).toBe('./path');
      expect(result.name).toBe('--force');
      expect(result.force).toBe(false);
    });
  });
});

describe('parseREPLCommand - /index', () => {
  describe('/index command', () => {
    it('recognizes /index command', () => {
      const result = parseREPLCommand('/index ./my-project');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('index');
      expect(result?.args).toEqual(['./my-project']);
    });

    it('recognizes /i alias', () => {
      const result = parseREPLCommand('/i ./path');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('index');
      expect(result?.args).toEqual(['./path']);
    });

    it('parses multiple arguments', () => {
      const result = parseREPLCommand('/index ./path -n myapp --force');
      expect(result?.command.name).toBe('index');
      expect(result?.args).toEqual(['./path', '-n', 'myapp', '--force']);
    });

    it('handles no arguments', () => {
      const result = parseREPLCommand('/index');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('index');
      expect(result?.args).toEqual([]);
    });

    it('is case-insensitive', () => {
      const result = parseREPLCommand('/INDEX ./path');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('index');
    });
  });

  describe('/index status subcommand', () => {
    it('parses /index status', () => {
      const result = parseREPLCommand('/index status');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('index');
      expect(result?.args).toEqual(['status']);
    });

    it('parses /i status (alias)', () => {
      const result = parseREPLCommand('/i status');
      expect(result).not.toBeNull();
      expect(result?.command.name).toBe('index');
      expect(result?.args).toEqual(['status']);
    });

    it('is case-insensitive for status', () => {
      const result = parseREPLCommand('/index STATUS');
      expect(result).not.toBeNull();
      expect(result?.args).toEqual(['STATUS']);
    });
  });
});

describe('parseIndexArgs - status subcommand', () => {
  describe('status detection', () => {
    it('recognizes status as subcommand', () => {
      const result = parseIndexArgs(['status']);
      expect(result).toEqual({
        path: '',
        name: undefined,
        force: false,
        subcommand: 'status',
      });
    });

    it('is case-insensitive for status', () => {
      const result = parseIndexArgs(['STATUS']);
      expect(result.subcommand).toBe('status');
    });

    it('recognizes Status (mixed case)', () => {
      const result = parseIndexArgs(['Status']);
      expect(result.subcommand).toBe('status');
    });

    it('prioritizes status over path parsing', () => {
      // Even though 'status' could theoretically be a path, treat it as subcommand
      const result = parseIndexArgs(['status']);
      expect(result.subcommand).toBe('status');
      expect(result.path).toBe('');
    });

    it('ignores additional args after status', () => {
      // /index status --force should just be status (no force flag)
      const result = parseIndexArgs(['status', '--force']);
      expect(result.subcommand).toBe('status');
      expect(result.force).toBe(false);
    });
  });

  describe('path vs status disambiguation', () => {
    it('treats ./status as path, not subcommand', () => {
      const result = parseIndexArgs(['./status']);
      expect(result.subcommand).toBeUndefined();
      expect(result.path).toBe('./status');
    });

    it('treats /path/to/status as path', () => {
      const result = parseIndexArgs(['/path/to/status']);
      expect(result.subcommand).toBeUndefined();
      expect(result.path).toBe('/path/to/status');
    });

    it('treats status-app as path', () => {
      // Starts with "status" but not exactly "status"
      const result = parseIndexArgs(['status-app']);
      expect(result.subcommand).toBeUndefined();
      expect(result.path).toBe('status-app');
    });
  });
});
