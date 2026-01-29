/**
 * RAG Engine Tests
 *
 * Tests for the RAG pipeline including:
 * - FusionServiceAdapter (converts our search results to SDK format)
 * - ContextExpertRAGEngine (wraps SDK with our API)
 * - Type conversions (SearchResultWithContext ↔ RetrievalResult)
 *
 * Uses mocks to test in isolation from database/embedding providers.
 */

import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import type {
  RetrievalResult,
  RAGResult,
  SourceAttribution,
  RAGSearchMetadata,
  RAGTimings,
  AssembledContext,
} from '@contextaisdk/rag';

import { FusionServiceAdapter, ContextExpertRAGEngine } from '../rag-engine.js';
import type { FusionService } from '../../search/fusion.js';
import type { SearchResultWithContext } from '../../search/types.js';
import type { RAGConfig } from '../types.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a mock SearchResultWithContext for testing.
 */
function createMockSearchResult(overrides: Partial<SearchResultWithContext> = {}): SearchResultWithContext {
  return {
    id: 'chunk-1',
    score: 0.95,
    content: 'function authenticate(user: User) {\n  // auth logic\n}',
    filePath: 'src/auth/handler.ts',
    fileType: 'code',
    language: 'typescript',
    lineRange: { start: 42, end: 67 },
    metadata: { projectId: 'test-project' },
    ...overrides,
  };
}

/**
 * Create a mock FusionService for testing.
 */
function createMockFusionService(): FusionService {
  return {
    search: vi.fn().mockResolvedValue([]),
    ensureInitialized: vi.fn().mockResolvedValue(undefined),
    isInitialized: vi.fn().mockReturnValue(false),
    getProjectId: vi.fn().mockReturnValue('test-project'),
    getChunkCounts: vi.fn().mockResolvedValue({ dense: 100, bm25: 100 }),
  } as unknown as FusionService;
}

/**
 * Create a mock RAGEngineImpl for testing.
 */
function createMockRAGEngineImpl(): {
  search: Mock;
  warmUp: Mock;
  clearCache: Mock;
  name: string;
} {
  return {
    search: vi.fn(),
    warmUp: vi.fn().mockResolvedValue(undefined),
    clearCache: vi.fn().mockResolvedValue(undefined),
    name: 'MockRAGEngine',
  };
}

/**
 * Create a mock RAGResult from the SDK.
 */
function createMockRAGResult(overrides: Partial<RAGResult> = {}): RAGResult {
  const defaultSources: SourceAttribution[] = [
    {
      source: 'src/auth/handler.ts',
      location: 'lines 42-67',
      score: 0.95,
      metadata: {
        filePath: 'src/auth/handler.ts',
        fileType: 'code',
        language: 'typescript',
        startLine: 42,
        endLine: 67,
      },
    },
  ];

  const defaultTimings: RAGTimings = {
    retrievalMs: 50,
    assemblyMs: 10,
    totalMs: 60,
  };

  const defaultMetadata: RAGSearchMetadata = {
    effectiveQuery: 'test query',
    retrievedCount: 5,
    assembledCount: 3,
    deduplicatedCount: 0,
    droppedCount: 2,
    fromCache: false,
    timings: defaultTimings,
  };

  const defaultAssembly: AssembledContext = {
    content: '<sources>...</sources>',
    estimatedTokens: 100,
    sources: defaultSources,
    chunkCount: 3,
    deduplicatedCount: 0,
    droppedCount: 2,
  };

  return {
    content: '<sources>\n  <source id="1" file="src/auth/handler.ts">...</source>\n</sources>',
    estimatedTokens: 150,
    sources: defaultSources,
    assembly: defaultAssembly,
    retrievalResults: [
      {
        id: 'chunk-1',
        chunk: {
          id: 'chunk-1',
          content: 'function authenticate()',
          metadata: {
            filePath: 'src/auth/handler.ts',
            fileType: 'code',
            language: 'typescript',
            startLine: 42,
            endLine: 67,
          },
        },
        score: 0.95,
      },
    ],
    metadata: defaultMetadata,
    ...overrides,
  };
}

// ============================================================================
// FusionServiceAdapter Tests
// ============================================================================

describe('FusionServiceAdapter', () => {
  describe('retrieve', () => {
    it('should initialize fusion service on first retrieve', async () => {
      const fusionService = createMockFusionService();
      const adapter = new FusionServiceAdapter(fusionService);

      await adapter.retrieve('test query');

      expect(fusionService.ensureInitialized).toHaveBeenCalledOnce();
    });

    it('should not re-initialize on subsequent retrieves', async () => {
      const fusionService = createMockFusionService();
      const adapter = new FusionServiceAdapter(fusionService);

      await adapter.retrieve('query 1');
      await adapter.retrieve('query 2');

      expect(fusionService.ensureInitialized).toHaveBeenCalledOnce();
    });

    it('should pass topK to fusion service', async () => {
      const fusionService = createMockFusionService();
      const adapter = new FusionServiceAdapter(fusionService);

      await adapter.retrieve('test query', { topK: 15 });

      expect(fusionService.search).toHaveBeenCalledWith('test query', {
        topK: 15,
        minScore: 0,
      });
    });

    it('should pass minScore to fusion service', async () => {
      const fusionService = createMockFusionService();
      const adapter = new FusionServiceAdapter(fusionService);

      await adapter.retrieve('test query', { minScore: 0.5 });

      expect(fusionService.search).toHaveBeenCalledWith('test query', {
        topK: 20,
        minScore: 0.5,
      });
    });

    it('should use default topK of 20 when not specified', async () => {
      const fusionService = createMockFusionService();
      const adapter = new FusionServiceAdapter(fusionService);

      await adapter.retrieve('test query');

      expect(fusionService.search).toHaveBeenCalledWith('test query', {
        topK: 20,
        minScore: 0,
      });
    });
  });

  describe('type conversion', () => {
    it('should convert SearchResultWithContext to RetrievalResult', async () => {
      const mockResult = createMockSearchResult();
      const fusionService = createMockFusionService();
      (fusionService.search as Mock).mockResolvedValue([mockResult]);

      const adapter = new FusionServiceAdapter(fusionService);
      const results = await adapter.retrieve('test query');

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        id: 'chunk-1',
        chunk: {
          id: 'chunk-1',
          content: 'function authenticate(user: User) {\n  // auth logic\n}',
          metadata: {
            filePath: 'src/auth/handler.ts',
            fileType: 'code',
            language: 'typescript',
            startLine: 42,
            endLine: 67,
            projectId: 'test-project',
          },
        },
        score: 0.95,
      });
    });

    it('should preserve all metadata fields', async () => {
      const mockResult = createMockSearchResult({
        metadata: {
          projectId: 'test-project',
          customField: 'custom-value',
          nested: { a: 1, b: 2 },
        },
      });
      const fusionService = createMockFusionService();
      (fusionService.search as Mock).mockResolvedValue([mockResult]);

      const adapter = new FusionServiceAdapter(fusionService);
      const results = await adapter.retrieve('test query');

      expect(results[0]!.chunk.metadata).toMatchObject({
        projectId: 'test-project',
        customField: 'custom-value',
        nested: { a: 1, b: 2 },
      });
    });

    it('should handle null language', async () => {
      const mockResult = createMockSearchResult({
        language: null,
        fileType: 'docs',
      });
      const fusionService = createMockFusionService();
      (fusionService.search as Mock).mockResolvedValue([mockResult]);

      const adapter = new FusionServiceAdapter(fusionService);
      const results = await adapter.retrieve('test query');

      expect(results[0]!.chunk.metadata.language).toBeNull();
      expect(results[0]!.chunk.metadata.fileType).toBe('docs');
    });
  });
});

// ============================================================================
// ContextExpertRAGEngine Tests
// ============================================================================

describe('ContextExpertRAGEngine', () => {
  const defaultConfig: RAGConfig = {
    max_tokens: 4000,
    retrieve_k: 20,
    final_k: 5,
    enhance_query: false,
    ordering: 'sandwich',
  };

  describe('search', () => {
    it('should delegate to SDK engine with correct options', async () => {
      const mockEngine = createMockRAGEngineImpl();
      mockEngine.search.mockResolvedValue(createMockRAGResult());

      const fusionService = createMockFusionService();
      const engine = new ContextExpertRAGEngine(
        mockEngine as any,
        fusionService,
        defaultConfig
      );

      await engine.search('test query');

      expect(mockEngine.search).toHaveBeenCalledWith('test query', {
        topK: 5, // final_k from config
        maxTokens: 4000,
        ordering: 'sandwich',
        rerank: true, // default when skipRerank not set
        enhance: false, // from config
      });
    });

    it('should apply runtime options over config', async () => {
      const mockEngine = createMockRAGEngineImpl();
      mockEngine.search.mockResolvedValue(createMockRAGResult());

      const fusionService = createMockFusionService();
      const engine = new ContextExpertRAGEngine(
        mockEngine as any,
        fusionService,
        defaultConfig
      );

      await engine.search('test query', {
        finalK: 10,
        maxTokens: 8000,
        ordering: 'relevance',
        skipRerank: true,
        enhanceQuery: true,
      });

      expect(mockEngine.search).toHaveBeenCalledWith('test query', {
        topK: 10,
        maxTokens: 8000,
        ordering: 'relevance',
        rerank: false, // skipRerank: true
        enhance: true, // overridden
      });
    });
  });

  describe('result conversion', () => {
    it('should convert SDK result to RAGSearchResult', async () => {
      const mockEngine = createMockRAGEngineImpl();
      mockEngine.search.mockResolvedValue(createMockRAGResult());

      const fusionService = createMockFusionService();
      const engine = new ContextExpertRAGEngine(
        mockEngine as any,
        fusionService,
        defaultConfig
      );

      const result = await engine.search('test query');

      expect(result.content).toContain('<sources>');
      expect(result.estimatedTokens).toBe(150);
      expect(result.sources).toHaveLength(1);
      expect(result.sources[0]).toEqual({
        index: 1, // 1-indexed
        filePath: 'src/auth/handler.ts',
        lineRange: { start: 42, end: 67 },
        score: 0.95,
        language: 'typescript',
        fileType: 'code',
      });
    });

    it('should include timing metadata', async () => {
      const mockEngine = createMockRAGEngineImpl();
      mockEngine.search.mockResolvedValue(createMockRAGResult());

      const fusionService = createMockFusionService();
      const engine = new ContextExpertRAGEngine(
        mockEngine as any,
        fusionService,
        defaultConfig
      );

      const result = await engine.search('test query');

      expect(result.metadata.retrievalMs).toBe(50);
      expect(result.metadata.assemblyMs).toBe(10);
      expect(result.metadata.totalMs).toBeGreaterThan(0);
      expect(result.metadata.resultsRetrieved).toBe(5);
      expect(result.metadata.resultsAssembled).toBe(3);
      expect(result.metadata.fromCache).toBe(false);
    });

    it('should include raw results for debugging', async () => {
      const mockEngine = createMockRAGEngineImpl();
      mockEngine.search.mockResolvedValue(createMockRAGResult());

      const fusionService = createMockFusionService();
      const engine = new ContextExpertRAGEngine(
        mockEngine as any,
        fusionService,
        defaultConfig
      );

      const result = await engine.search('test query');

      expect(result.rawResults).toHaveLength(1);
      expect(result.rawResults[0]).toMatchObject({
        id: 'chunk-1',
        content: 'function authenticate()',
        filePath: 'src/auth/handler.ts',
        fileType: 'code',
        language: 'typescript',
        lineRange: { start: 42, end: 67 },
      });
    });
  });

  describe('warmUp', () => {
    it('should warm up both fusion service and SDK engine', async () => {
      const mockEngine = createMockRAGEngineImpl();
      const fusionService = createMockFusionService();

      const engine = new ContextExpertRAGEngine(
        mockEngine as any,
        fusionService,
        defaultConfig
      );

      await engine.warmUp();

      expect(fusionService.ensureInitialized).toHaveBeenCalledOnce();
      expect(mockEngine.warmUp).toHaveBeenCalledOnce();
    });
  });

  describe('getProjectId', () => {
    it('should return project ID from fusion service', () => {
      const mockEngine = createMockRAGEngineImpl();
      const fusionService = createMockFusionService();
      (fusionService.getProjectId as Mock).mockReturnValue('my-project');

      const engine = new ContextExpertRAGEngine(
        mockEngine as any,
        fusionService,
        defaultConfig
      );

      expect(engine.getProjectId()).toBe('my-project');
    });
  });

  describe('error handling', () => {
    it('should wrap SDK errors in RAGEngineError', async () => {
      const mockEngine = createMockRAGEngineImpl();
      mockEngine.search.mockRejectedValue(new Error('SDK error'));

      const fusionService = createMockFusionService();
      const engine = new ContextExpertRAGEngine(
        mockEngine as any,
        fusionService,
        defaultConfig
      );

      await expect(engine.search('test query')).rejects.toThrow('Search failed: SDK error');
    });
  });
});

// ============================================================================
// RAGConfigSchema Tests
// ============================================================================

describe('RAGConfigSchema', () => {
  // Import synchronously at top of file instead
  let RAGConfigSchema: typeof import('../types.js').RAGConfigSchema;

  beforeEach(async () => {
    const types = await import('../types.js');
    RAGConfigSchema = types.RAGConfigSchema;
  });

  it('should apply defaults for missing fields', () => {
    const parsed = RAGConfigSchema.parse({});

    expect(parsed).toEqual({
      max_tokens: 4000,
      retrieve_k: 20,
      final_k: 5,
      enhance_query: false,
      ordering: 'sandwich',
    });
  });

  it('should validate max_tokens bounds', () => {
    expect(() => RAGConfigSchema.parse({ max_tokens: 100 })).toThrow();
    expect(() => RAGConfigSchema.parse({ max_tokens: 20000 })).toThrow();
    expect(RAGConfigSchema.parse({ max_tokens: 8000 }).max_tokens).toBe(8000);
  });

  it('should validate ordering enum', () => {
    expect(RAGConfigSchema.parse({ ordering: 'relevance' }).ordering).toBe('relevance');
    expect(RAGConfigSchema.parse({ ordering: 'sandwich' }).ordering).toBe('sandwich');
    expect(RAGConfigSchema.parse({ ordering: 'chronological' }).ordering).toBe('chronological');
    expect(() => RAGConfigSchema.parse({ ordering: 'invalid' })).toThrow();
  });

  it('should accept partial config', () => {
    const parsed = RAGConfigSchema.parse({
      final_k: 10,
      ordering: 'relevance',
    });

    expect(parsed.final_k).toBe(10);
    expect(parsed.ordering).toBe('relevance');
    expect(parsed.max_tokens).toBe(4000); // default
  });
});

// ============================================================================
// RAGEngineError Tests
// ============================================================================

describe('RAGEngineError', () => {
  let RAGEngineError: typeof import('../types.js').RAGEngineError;
  let RAGErrorCodes: typeof import('../types.js').RAGErrorCodes;

  beforeEach(async () => {
    const types = await import('../types.js');
    RAGEngineError = types.RAGEngineError;
    RAGErrorCodes = types.RAGErrorCodes;
  });

  it('should create embedding unavailable error', () => {
    const error = RAGEngineError.embeddingUnavailable('model not found');

    expect(error.code).toBe(RAGErrorCodes.EMBEDDING_UNAVAILABLE);
    expect(error.message).toContain('Failed to initialize embedding provider');
    expect(error.message).toContain('model not found');
  });

  it('should create project not indexed error', () => {
    const error = RAGEngineError.projectNotIndexed('my-project');

    expect(error.code).toBe(RAGErrorCodes.PROJECT_NOT_INDEXED);
    expect(error.message).toContain('my-project');
    expect(error.message).toContain('ctx index');
  });

  it('should preserve cause error', () => {
    const cause = new Error('original error');
    const error = RAGEngineError.retrievalFailed('search failed', cause);

    expect(error.cause).toBe(cause);
  });
});
