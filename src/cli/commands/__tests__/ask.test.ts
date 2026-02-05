/**
 * Tests for ask command
 *
 * Tests cover:
 * - Command structure and metadata
 * - Question validation
 * - --project filter (single project lookup)
 * - --top-k option validation (default 5, max 20)
 * - JSON output format
 * - Text mode streaming
 * - Empty results handling
 * - Error cases (invalid project, no projects, empty question)
 * - Citation formatting integration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { createAskCommand } from '../ask.js';
import type { CommandContext } from '../../types.js';
import * as database from '../../../database/index.js';
import * as configLoader from '../../../config/loader.js';
import * as ragEngine from '../../../agent/rag-engine.js';
import * as llmProvider from '../../../providers/llm.js';
import * as citations from '../../../agent/citations.js';

// Mock the database module
vi.mock('../../../database/index.js', () => ({
  runMigrations: vi.fn(),
  getDb: vi.fn(),
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

// Mock citations (partial - keep real formatCitationsJSON)
vi.mock('../../../agent/citations.js', async () => {
  const actual = await vi.importActual('../../../agent/citations.js');
  return {
    ...actual,
    formatCitations: vi.fn(),
  };
});

describe('createAskCommand', () => {
  let mockContext: CommandContext;
  let logOutput: string[];
  let errorOutput: string[];
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let mockDb: { prepare: ReturnType<typeof vi.fn> };
  let mockRAGEngine: {
    search: ReturnType<typeof vi.fn>;
  };
  let mockLLMProvider: {
    chat: ReturnType<typeof vi.fn>;
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

  const mockRAGResult = {
    content: '<sources><source id="1">code here</source></sources>',
    estimatedTokens: 500,
    sources: [
      {
        index: 1,
        filePath: 'src/auth/middleware.ts',
        lineRange: { start: 45, end: 67 },
        score: 0.92,
        language: 'typescript',
        fileType: 'code' as const,
      },
      {
        index: 2,
        filePath: 'src/api/routes.ts',
        lineRange: { start: 120, end: 142 },
        score: 0.87,
        language: 'typescript',
        fileType: 'code' as const,
      },
    ],
    rawResults: [],
    metadata: {
      retrievalMs: 150,
      assemblyMs: 25,
      totalMs: 175,
      resultsRetrieved: 10,
      resultsAssembled: 2,
      fromCache: false,
    },
  };

  const mockLLMResponse = {
    content: 'The authentication uses JWT tokens. See [1] for the middleware implementation.',
    usage: {
      promptTokens: 800,
      completionTokens: 50,
      totalTokens: 850,
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

    // Capture console.log for JSON output verification
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Capture stdout.write for streaming verification
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // Mock database
    mockDb = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(mockProject),
        all: vi.fn().mockReturnValue([mockProject]),
      }),
    };
    vi.mocked(database.getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof database.getDb>);

    // Mock config
    vi.mocked(configLoader.loadConfig).mockReturnValue({
      default_provider: 'anthropic',
      default_model: 'claude-sonnet-4-20250514',
      embedding: {
        provider: 'huggingface',
        model: 'BAAI/bge-small-en-v1.5',
      },
      search: {
        top_k: 10,
        min_score: 0.5,
        rerank: false,
      },
    } as ReturnType<typeof configLoader.loadConfig>);

    // Mock RAG engine
    mockRAGEngine = {
      search: vi.fn().mockResolvedValue(mockRAGResult),
    };
    vi.mocked(ragEngine.createRAGEngine).mockResolvedValue(mockRAGEngine as unknown as Awaited<ReturnType<typeof ragEngine.createRAGEngine>>);

    // Mock LLM provider - async generator for streaming
    async function* mockStreamGenerator() {
      yield { type: 'text' as const, content: 'The authentication ' };
      yield { type: 'text' as const, content: 'uses JWT tokens.' };
      yield { type: 'usage' as const, usage: mockLLMResponse.usage };
      yield { type: 'done' as const };
    }

    mockLLMProvider = {
      chat: vi.fn().mockResolvedValue(mockLLMResponse),
      streamChat: vi.fn().mockReturnValue(mockStreamGenerator()),
    };
    vi.mocked(llmProvider.createLLMProvider).mockResolvedValue({
      provider: mockLLMProvider as unknown as ReturnType<typeof llmProvider.createLLMProvider> extends Promise<infer T> ? T extends { provider: infer P } ? P : never : never,
      name: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      usedFallback: false,
      requestedProvider: 'anthropic',
      failedAttempts: [],
    });

    // Mock formatCitations
    vi.mocked(citations.formatCitations).mockReturnValue('[1] src/auth/middleware.ts:45-67 (0.92)\n[2] src/api/routes.ts:120-142 (0.87)');
  });

  afterEach(() => {
    vi.clearAllMocks();
    consoleLogSpy.mockRestore();
    stdoutWriteSpy.mockRestore();
  });

  // Helper to run the command
  async function runCommand(args: string[], context = mockContext) {
    const command = createAskCommand(() => context);
    const program = new Command();
    program.addCommand(command);
    await program.parseAsync(['node', 'test', 'ask', ...args]);
  }

  describe('command structure', () => {
    it('creates a command named "ask"', () => {
      const command = createAskCommand(() => mockContext);
      expect(command.name()).toBe('ask');
    });

    it('has a description', () => {
      const command = createAskCommand(() => mockContext);
      expect(command.description()).toContain('question');
    });

    it('requires a question argument', () => {
      const command = createAskCommand(() => mockContext);
      const args = command.registeredArguments;
      expect(args).toHaveLength(1);
      expect(args[0].name()).toBe('question');
      expect(args[0].required).toBe(true);
    });

    it('has --project option', () => {
      const command = createAskCommand(() => mockContext);
      const projectOption = command.options.find((o) => o.long === '--project');
      expect(projectOption).toBeDefined();
      expect(projectOption?.short).toBe('-p');
    });

    it('has --top-k option with default 5', () => {
      const command = createAskCommand(() => mockContext);
      const topKOption = command.options.find((o) => o.long === '--top-k');
      expect(topKOption).toBeDefined();
      expect(topKOption?.short).toBe('-k');
      expect(topKOption?.defaultValue).toBe('5');
    });

    it('has --context-only option', () => {
      const command = createAskCommand(() => mockContext);
      const contextOnlyOption = command.options.find((o) => o.long === '--context-only');
      expect(contextOnlyOption).toBeDefined();
    });
  });

  describe('question validation', () => {
    it('trims whitespace from question', async () => {
      await runCommand(['  How does auth work?  ']);

      expect(mockRAGEngine.search).toHaveBeenCalledWith(
        'How does auth work?',
        expect.any(Object)
      );
    });

    it('throws error for empty question', async () => {
      await expect(runCommand(['   '])).rejects.toThrow('Question cannot be empty');
    });

    it('accepts multi-word questions', async () => {
      await runCommand(['How does the authentication middleware work?']);

      expect(mockRAGEngine.search).toHaveBeenCalledWith(
        'How does the authentication middleware work?',
        expect.any(Object)
      );
    });
  });

  describe('--project filter', () => {
    it('looks up project by name when --project provided', async () => {
      await runCommand(['How does auth work?', '--project', 'test-project']);

      expect(mockDb.prepare).toHaveBeenCalledWith(
        'SELECT * FROM projects WHERE name = ?'
      );
    });

    it('uses resolved project ID for RAG engine', async () => {
      await runCommand(['How does auth work?', '--project', 'test-project']);

      expect(ragEngine.createRAGEngine).toHaveBeenCalledWith(
        expect.any(Object),
        'proj-123' // String project ID
      );
    });

    it('throws CLIError for unknown project', async () => {
      mockDb.prepare = vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(undefined),
        all: vi.fn().mockReturnValue([]),
      });

      await expect(
        runCommand(['How does auth work?', '--project', 'nonexistent'])
      ).rejects.toThrow('Project not found: nonexistent');
    });
  });

  describe('--top-k option', () => {
    it('uses default top-k of 5', async () => {
      await runCommand(['How does auth work?']);

      expect(mockRAGEngine.search).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ finalK: 5 })
      );
    });

    it('accepts custom top-k value', async () => {
      await runCommand(['How does auth work?', '--top-k', '10']);

      expect(mockRAGEngine.search).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ finalK: 10 })
      );
    });

    it('accepts -k shorthand', async () => {
      await runCommand(['How does auth work?', '-k', '15']);

      expect(mockRAGEngine.search).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ finalK: 15 })
      );
    });

    it('throws error for invalid top-k', async () => {
      await expect(
        runCommand(['How does auth work?', '--top-k', 'abc'])
      ).rejects.toThrow('Invalid --top-k value');
    });

    it('throws error for top-k > 20', async () => {
      await expect(
        runCommand(['How does auth work?', '--top-k', '25'])
      ).rejects.toThrow('--top-k value too large');
    });

    it('throws error for top-k < 1', async () => {
      await expect(
        runCommand(['How does auth work?', '--top-k', '0'])
      ).rejects.toThrow('Invalid --top-k value');
    });
  });

  describe('text mode output', () => {
    it('streams response to stdout', async () => {
      await runCommand(['How does auth work?']);

      // Verify streamChat was called (not chat)
      expect(mockLLMProvider.streamChat).toHaveBeenCalled();
      expect(mockLLMProvider.chat).not.toHaveBeenCalled();
    });

    it('writes chunks to stdout', async () => {
      await runCommand(['How does auth work?']);

      // Should have written chunks via stdout.write
      expect(stdoutWriteSpy).toHaveBeenCalledWith('The authentication ');
      expect(stdoutWriteSpy).toHaveBeenCalledWith('uses JWT tokens.');
    });

    it('displays Sources header after answer', async () => {
      await runCommand(['How does auth work?']);

      expect(logOutput.some((line) => line.includes('Sources'))).toBe(true);
    });

    it('displays formatted citations', async () => {
      await runCommand(['How does auth work?']);

      expect(citations.formatCitations).toHaveBeenCalledWith(
        mockRAGResult.sources,
        expect.objectContaining({ style: 'compact' })
      );
    });

    it('shows searching message', async () => {
      await runCommand(['How does auth work?']);

      expect(logOutput.some((line) => line.includes('Searching'))).toBe(true);
    });
  });

  describe('JSON output', () => {
    beforeEach(() => {
      mockContext.options.json = true;
    });

    it('uses chat instead of streamChat for JSON mode', async () => {
      await runCommand(['How does auth work?']);

      expect(mockLLMProvider.chat).toHaveBeenCalled();
      expect(mockLLMProvider.streamChat).not.toHaveBeenCalled();
    });

    it('outputs valid JSON', async () => {
      await runCommand(['How does auth work?']);

      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0][0];
      expect(() => JSON.parse(output)).not.toThrow();
    });

    it('includes question in JSON output', async () => {
      await runCommand(['How does auth work?']);

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.question).toBe('How does auth work?');
    });

    it('includes answer in JSON output', async () => {
      await runCommand(['How does auth work?']);

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.answer).toBe(mockLLMResponse.content);
    });

    it('includes sources array in JSON output', async () => {
      await runCommand(['How does auth work?']);

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(Array.isArray(output.sources)).toBe(true);
      expect(output.sources).toHaveLength(2);
    });

    it('includes metadata in JSON output', async () => {
      await runCommand(['How does auth work?']);

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.metadata).toBeDefined();
      expect(output.metadata.projectSearched).toBe('test-project');
      expect(output.metadata.model).toBe('claude-sonnet-4-20250514');
      expect(output.metadata.provider).toBe('anthropic');
    });

    it('includes timing metadata', async () => {
      await runCommand(['How does auth work?']);

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.metadata.retrievalMs).toBe(150);
      expect(output.metadata.assemblyMs).toBe(25);
      expect(typeof output.metadata.generationMs).toBe('number');
      expect(typeof output.metadata.totalMs).toBe('number');
    });

    it('includes token usage when available', async () => {
      await runCommand(['How does auth work?']);

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.metadata.tokensUsed).toBeDefined();
      expect(output.metadata.tokensUsed.promptTokens).toBe(800);
      expect(output.metadata.tokensUsed.completionTokens).toBe(50);
      expect(output.metadata.tokensUsed.totalTokens).toBe(850);
    });
  });

  describe('verbose mode', () => {
    beforeEach(() => {
      mockContext.options.verbose = true;
    });

    it('shows timing details in verbose mode', async () => {
      await runCommand(['How does auth work?']);

      expect(logOutput.some((line) => line.includes('Retrieval'))).toBe(true);
      expect(logOutput.some((line) => line.includes('Generation'))).toBe(true);
      expect(logOutput.some((line) => line.includes('Total'))).toBe(true);
    });

    it('shows model info in verbose mode', async () => {
      await runCommand(['How does auth work?']);

      expect(logOutput.some((line) => line.includes('anthropic'))).toBe(true);
    });
  });

  describe('empty results handling', () => {
    beforeEach(() => {
      mockRAGEngine.search.mockResolvedValue({
        ...mockRAGResult,
        sources: [],
        content: '',
      });
    });

    it('displays helpful message when no results', async () => {
      await runCommand(['How does auth work?']);

      expect(logOutput.some((line) => line.includes('No relevant context'))).toBe(true);
    });

    it('includes tips for improving search', async () => {
      await runCommand(['How does auth work?']);

      expect(logOutput.some((line) => line.includes('Tips'))).toBe(true);
    });

    it('returns null answer in JSON mode', async () => {
      mockContext.options.json = true;
      await runCommand(['How does auth work?']);

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.answer).toBeNull();
    });

    it('does not call LLM when no results', async () => {
      await runCommand(['How does auth work?']);

      expect(mockLLMProvider.chat).not.toHaveBeenCalled();
      expect(mockLLMProvider.streamChat).not.toHaveBeenCalled();
    });
  });

  describe('no projects indexed', () => {
    beforeEach(() => {
      mockDb.prepare = vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(undefined),
        all: vi.fn().mockReturnValue([]),
      });
    });

    it('throws CLIError when no projects indexed', async () => {
      await expect(runCommand(['How does auth work?'])).rejects.toThrow(
        'No projects indexed'
      );
    });
  });

  describe('--context-only mode', () => {
    it('returns context without calling LLM in JSON mode', async () => {
      mockContext.options.json = true;
      await runCommand(['How does auth work?', '--context-only']);

      // LLM should NOT be created or called
      expect(llmProvider.createLLMProvider).not.toHaveBeenCalled();
      expect(mockLLMProvider.chat).not.toHaveBeenCalled();
      expect(mockLLMProvider.streamChat).not.toHaveBeenCalled();

      // Should output JSON
      expect(consoleLogSpy).toHaveBeenCalled();
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);

      expect(output.question).toBe('How does auth work?');
      expect(output.context).toBe(mockRAGResult.content);
      expect(output.estimatedTokens).toBe(500);
      expect(Array.isArray(output.sources)).toBe(true);
      expect(output.sources).toHaveLength(2);
    });

    it('includes metadata in JSON context-only output', async () => {
      mockContext.options.json = true;
      await runCommand(['How does auth work?', '--context-only']);

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.metadata).toBeDefined();
      expect(output.metadata.projectSearched).toBe('test-project');
      expect(output.metadata.retrievalMs).toBe(150);
      expect(output.metadata.assemblyMs).toBe(25);
      expect(typeof output.metadata.totalMs).toBe('number');
      // Should NOT have generationMs
      expect(output.metadata.generationMs).toBeUndefined();
    });

    it('prints XML context in text mode', async () => {
      await runCommand(['How does auth work?', '--context-only']);

      // LLM should NOT be created
      expect(llmProvider.createLLMProvider).not.toHaveBeenCalled();

      // Should print context and sources
      expect(logOutput.some((line) => line.includes('Context'))).toBe(true);
      expect(logOutput.some((line) => line.includes('Sources'))).toBe(true);
    });

    it('handles empty results with --context-only in JSON mode', async () => {
      mockRAGEngine.search.mockResolvedValue({
        ...mockRAGResult,
        sources: [],
        content: '',
      });

      mockContext.options.json = true;
      await runCommand(['How does auth work?', '--context-only']);

      // Should use AskContextOnlyJSON format, not AskOutputJSON
      expect(llmProvider.createLLMProvider).not.toHaveBeenCalled();
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.context).toBe('');
      expect(output.estimatedTokens).toBeDefined();
      expect(output.sources).toEqual([]);
      // Should NOT have answer/generationMs/model fields
      expect(output.answer).toBeUndefined();
      expect(output.metadata.generationMs).toBeUndefined();
    });

    it('handles empty results with --context-only in text mode', async () => {
      mockRAGEngine.search.mockResolvedValue({
        ...mockRAGResult,
        sources: [],
        content: '',
      });

      await runCommand(['How does auth work?', '--context-only']);

      expect(llmProvider.createLLMProvider).not.toHaveBeenCalled();
      expect(logOutput.some((line) => line.includes('No relevant context'))).toBe(true);
    });
  });

  describe('RAG engine integration', () => {
    it('creates RAG engine with config and project ID', async () => {
      await runCommand(['How does auth work?']);

      expect(ragEngine.createRAGEngine).toHaveBeenCalledWith(
        expect.objectContaining({
          embedding: expect.any(Object),
        }),
        'proj-123'
      );
    });

    it('passes finalK option to RAG search', async () => {
      await runCommand(['How does auth work?', '-k', '8']);

      expect(mockRAGEngine.search).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ finalK: 8 })
      );
    });
  });

  describe('LLM provider integration', () => {
    it('creates LLM provider with fallback callbacks', async () => {
      await runCommand(['How does auth work?']);

      expect(llmProvider.createLLMProvider).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          fallback: expect.objectContaining({
            onFallback: expect.any(Function),
          }),
        })
      );
    });

    it('builds system prompt with RAG context', async () => {
      await runCommand(['How does auth work?']);

      const [[messages]] = mockLLMProvider.streamChat.mock.calls;
      const systemMessage = messages.find((m: { role: string }) => m.role === 'system');
      expect(systemMessage.content).toContain('<sources>');
    });

    it('includes user question in messages', async () => {
      await runCommand(['How does auth work?']);

      const [[messages]] = mockLLMProvider.streamChat.mock.calls;
      const userMessage = messages.find((m: { role: string }) => m.role === 'user');
      expect(userMessage.content).toBe('How does auth work?');
    });
  });
});
