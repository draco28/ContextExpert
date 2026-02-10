/**
 * RoutingRAGEngine Unit Tests
 *
 * Tests the unified routing + RAG engine that handles:
 * - Single-project search via ContextExpertRAGEngine
 * - Multi-project search via MultiProjectFusionService
 * - Automatic query routing via LLMProjectRouter
 * - Force RAG behavior
 * - AdaptiveRAG query classification and pipeline optimization
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RoutingRAGEngineConfig, ProjectMetadata, RAGSearchResult } from '../types.js';
import type { EmbeddingProvider } from '@contextaisdk/rag';
import type { AdaptiveRAGResult } from '@contextaisdk/rag/adaptive';

// Mock router
const mockRoute = vi.fn();
const mockUpdateProjects = vi.fn();
vi.mock('../query-router.js', () => ({
  createProjectRouter: () => ({
    route: mockRoute,
    updateProjects: mockUpdateProjects,
  }),
  LLMProjectRouter: class MockLLMProjectRouter {},
}));

// Mock RAG engine
const mockEngineSearch = vi.fn();
const mockEngineDispose = vi.fn();
const mockGetSDKEngine = vi.fn();
const mockConvertResult = vi.fn();
const mockCreateRAGEngine = vi.fn();
vi.mock('../rag-engine.js', () => ({
  createRAGEngine: (...args: unknown[]) => mockCreateRAGEngine(...args),
  ContextExpertRAGEngine: class MockContextExpertRAGEngine {},
}));

// Mock AdaptiveRAG from SDK
const mockAdaptiveSearch = vi.fn();
vi.mock('@contextaisdk/rag/adaptive', () => ({
  AdaptiveRAG: class MockAdaptiveRAG {
    search = mockAdaptiveSearch;
    constructor() {
      // No-op: accepts config but we don't need it
    }
  },
}));

// Mock fusion service
const mockValidateProjects = vi.fn();
const mockLoadProjects = vi.fn();
const mockFusionSearch = vi.fn();
vi.mock('../../search/multi-project-fusion.js', () => ({
  getMultiProjectFusionService: () => ({
    validateProjects: mockValidateProjects,
    loadProjects: mockLoadProjects,
    search: mockFusionSearch,
  }),
}));

// Import after mocks
const { RoutingRAGEngine, createRoutingRAGEngine } = await import('../routing-rag-engine.js');

// Test fixtures
const mockConfig = {
  embedding: { provider: 'ollama', model: 'nomic-embed-text' },
  search: { rerank: true },
} as RoutingRAGEngineConfig['config'];

const mockEmbeddingProvider: EmbeddingProvider = {
  name: 'mock-embedder',
  embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3], tokenCount: 3, model: 'mock' }),
  embedBatch: vi.fn(),
  dimensions: 768,
};

const mockProjects: ProjectMetadata[] = [
  { id: 'project-1', name: 'Project One', description: 'First project', tags: ['backend'], fileCount: 10, chunkCount: 100 },
  { id: 'project-2', name: 'Project Two', description: 'Second project', tags: ['frontend'], fileCount: 20, chunkCount: 200 },
];

const mockSingleProjectResult: RAGSearchResult = {
  content: '<sources><source id="1" project="project-1">mock content</source></sources>',
  estimatedTokens: 100,
  sources: [{ index: 1, filePath: 'test.ts', lineRange: { start: 1, end: 10 }, score: 0.9, language: 'typescript', fileType: 'code' }],
  rawResults: [],
  metadata: { retrievalMs: 50, assemblyMs: 10, totalMs: 60, resultsRetrieved: 5, resultsAssembled: 3, fromCache: false },
};

function createTestEngine(overrides?: Partial<RoutingRAGEngineConfig>): InstanceType<typeof RoutingRAGEngine> {
  return createRoutingRAGEngine({
    config: mockConfig,
    embeddingProvider: mockEmbeddingProvider,
    dimensions: 768,
    forceRAG: true,
    ...overrides,
  });
}

describe('RoutingRAGEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset embedding provider mock (cleared by vi.clearAllMocks)
    (mockEmbeddingProvider.embed as ReturnType<typeof vi.fn>).mockResolvedValue({
      embedding: [0.1, 0.2, 0.3],
      tokenCount: 3,
      model: 'mock',
    });

    // Default mock implementations
    mockRoute.mockResolvedValue({
      projectIds: ['project-1'],
      method: 'heuristic',
      confidence: 0.9,
      reason: 'Project name detected',
    });

    mockEngineSearch.mockResolvedValue(mockSingleProjectResult);
    mockEngineDispose.mockReturnValue(undefined);
    mockGetSDKEngine.mockReturnValue({ name: 'mock-sdk-engine' });
    mockConvertResult.mockReturnValue(mockSingleProjectResult);
    mockCreateRAGEngine.mockResolvedValue({
      search: mockEngineSearch,
      dispose: mockEngineDispose,
      getSDKEngine: mockGetSDKEngine,
      convertResult: mockConvertResult,
    });

    // Default AdaptiveRAG mock — simulates a FACTUAL classification with normal search
    mockAdaptiveSearch.mockResolvedValue({
      content: '<sources><source id="1">adaptive content</source></sources>',
      estimatedTokens: 80,
      sources: [{ file: 'test.ts', startLine: 1, endLine: 10, score: 0.85 }],
      assembly: { content: '', estimatedTokens: 0, chunkCount: 0, deduplicatedCount: 0, droppedCount: 0, sources: [], chunks: [] },
      retrievalResults: [],
      metadata: {
        effectiveQuery: 'test query',
        retrievedCount: 5,
        assembledCount: 3,
        deduplicatedCount: 0,
        droppedCount: 0,
        fromCache: false,
        timings: { retrievalMs: 40, assemblyMs: 8, totalMs: 48 },
      },
      classification: {
        type: 'factual',
        confidence: 0.85,
        features: { wordCount: 6, charCount: 30, hasQuestionWords: true, questionWords: ['how'], isGreeting: false, hasPronouns: false, pronouns: [], hasComplexKeywords: false, complexKeywords: [], hasFollowUpPattern: false, endsWithQuestion: true, potentialEntityCount: 0 },
        recommendation: { skipRetrieval: false, enableEnhancement: false, enableReranking: true, suggestedTopK: 5, needsConversationContext: false },
      },
      skippedRetrieval: false,
    } satisfies AdaptiveRAGResult);

    mockValidateProjects.mockReturnValue({ valid: true });
    mockLoadProjects.mockResolvedValue(undefined);
    mockFusionSearch.mockResolvedValue([
      {
        id: 'chunk-1',
        score: 0.85,
        content: 'multi-project content 1',
        filePath: 'project-a/src/file.ts',
        fileType: 'code',
        language: 'typescript',
        lineRange: { start: 1, end: 20 },
        projectId: 'project-a',
        projectName: 'Project A',
      },
      {
        id: 'chunk-2',
        score: 0.75,
        content: 'multi-project content 2',
        filePath: 'project-b/src/other.ts',
        fileType: 'code',
        language: 'typescript',
        lineRange: { start: 10, end: 30 },
        projectId: 'project-b',
        projectName: 'Project B',
      },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create engine with default forceRAG=true', () => {
      const engine = createTestEngine();
      expect(engine).toBeInstanceOf(RoutingRAGEngine);
    });

    it('should accept custom forceRAG setting', () => {
      const engine = createTestEngine({ forceRAG: false });
      expect(engine).toBeInstanceOf(RoutingRAGEngine);
    });
  });

  describe('search', () => {
    it('should return empty result when no projects', async () => {
      const engine = createTestEngine();
      const result = await engine.search('test query', [], undefined);

      expect(result.sources).toHaveLength(0);
      expect(result.routing.method).toBe('fallback_all');
      expect(result.routing.projectIds).toHaveLength(0);
      expect(result.routing.reason).toBe('No projects available');
    });

    it('should route to single project when heuristic detects project name', async () => {
      const engine = createTestEngine();
      const result = await engine.search('How does auth work in Project One?', mockProjects, undefined);

      expect(result.routing.method).toBe('heuristic');
      expect(result.routing.projectIds).toEqual(['project-1']);
      expect(result.routing.confidence).toBe(0.9);
      expect(result.sources.length).toBeGreaterThan(0);
    });

    it('should include routing metadata in result', async () => {
      const engine = createTestEngine();
      const result = await engine.search('test query', mockProjects, undefined);

      expect(result.routing).toBeDefined();
      expect(result.routing.method).toBeDefined();
      expect(result.routing.projectIds).toBeDefined();
      expect(result.routing.confidence).toBeDefined();
      expect(result.routing.reason).toBeDefined();
    });

    it('should use currentProjectId as routing hint', async () => {
      const engine = createTestEngine();
      await engine.search('test query', mockProjects, 'project-2');

      // Router should have been called with currentProjectId
      expect(mockRoute).toHaveBeenCalledWith(
        'test query',
        mockProjects,
        'project-2'
      );
    });
  });

  describe('search - multi-project', () => {
    it('should use fusion service for multiple projects', async () => {
      // Mock router to return multiple projects
      mockRoute.mockResolvedValueOnce({
        projectIds: ['project-1', 'project-2'],
        method: 'heuristic',
        confidence: 0.85,
        reason: 'Multi-project query detected',
      });

      const engine = createTestEngine();
      const result = await engine.search('Compare auth across projects', mockProjects, undefined);

      expect(result.routing.projectIds).toEqual(['project-1', 'project-2']);
      expect(result.sources.length).toBe(2);
      // Multi-project results should include project attribution
      expect(result.content).toContain('project=');
    });

    it('should validate embedding compatibility for multi-project search', async () => {
      // Mock router to return multiple projects
      mockRoute.mockResolvedValueOnce({
        projectIds: ['project-1', 'project-2'],
        method: 'heuristic',
        confidence: 0.85,
        reason: 'Multi-project query detected',
      });

      // Mock validation failure
      mockValidateProjects.mockReturnValueOnce({
        valid: false,
        errors: [{ projectId: 'project-2', projectName: 'Project Two', embeddingModel: 'different-model' }],
      });

      const engine = createTestEngine();

      // Should throw EmbeddingMismatchError
      await expect(
        engine.search('Compare auth across projects', mockProjects, undefined)
      ).rejects.toThrow();
    });
  });

  describe('forceRAG behavior', () => {
    it('should apply force-rag method when confidence is low and forceRAG=true', async () => {
      // Mock router to return low confidence
      mockRoute.mockResolvedValueOnce({
        projectIds: ['project-1'],
        method: 'fallback_all',
        confidence: 0.3, // Low confidence
        reason: 'Uncertain routing',
      });

      const engine = createTestEngine({ forceRAG: true });
      const result = await engine.search('What is a REST API?', mockProjects, undefined);

      // With forceRAG=true, low confidence should become 'force-rag' method
      expect(result.routing.method).toBe('force-rag');
      expect(result.routing.reason).toContain('Force RAG');
    });

    it('should not apply force-rag when confidence is high', async () => {
      const engine = createTestEngine({ forceRAG: true });
      const result = await engine.search('How does auth work in Project One?', mockProjects, undefined);

      // High confidence (0.9) should keep original method
      expect(result.routing.method).toBe('heuristic');
      expect(result.routing.reason).not.toContain('Force RAG');
    });
  });

  describe('engine caching', () => {
    it('should cache engines for reuse', async () => {
      const engine = createTestEngine();

      // First search
      await engine.search('query 1', mockProjects, undefined);
      // Second search to same project
      await engine.search('query 2', mockProjects, undefined);

      // createRAGEngine should only be called once (cached)
      expect(mockCreateRAGEngine).toHaveBeenCalledTimes(1);
    });
  });

  describe('dispose', () => {
    it('should dispose all cached engines', async () => {
      const engine = createTestEngine();

      // Create an engine by searching
      await engine.search('test', mockProjects, undefined);

      // Dispose
      engine.dispose();

      // Engine's dispose should have been called
      expect(mockEngineDispose).toHaveBeenCalled();
    });
  });

  describe('updateProjects', () => {
    it('should update router with new projects', () => {
      const engine = createTestEngine();

      const newProjects: ProjectMetadata[] = [
        { id: 'project-3', name: 'New Project', description: null, tags: [], fileCount: 5, chunkCount: 50 },
      ];

      engine.updateProjects(newProjects);

      expect(mockUpdateProjects).toHaveBeenCalledWith(newProjects);
    });
  });

  describe('getEngineForProject', () => {
    it('should return engine for specific project', async () => {
      const engine = createTestEngine();

      const projectEngine = await engine.getEngineForProject('project-1');

      expect(projectEngine).toBeDefined();
      expect(projectEngine.search).toBeDefined();
    });

    it('should cache and reuse engines', async () => {
      const engine = createTestEngine();

      const engine1 = await engine.getEngineForProject('project-1');
      const engine2 = await engine.getEngineForProject('project-1');

      expect(engine1).toBe(engine2);
      expect(mockCreateRAGEngine).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================================
  // AdaptiveRAG Integration Tests
  // ============================================================================

  describe('adaptive RAG', () => {
    it('should use AdaptiveRAG for single-project search when adaptive=true (default)', async () => {
      const engine = createTestEngine(); // adaptive defaults to true

      await engine.search('How does auth work?', mockProjects, undefined);

      // AdaptiveRAG.search should have been called instead of engine.search directly
      expect(mockAdaptiveSearch).toHaveBeenCalledWith('How does auth work?', {
        topK: 5,
        maxTokens: undefined,
      });
      // Direct engine search should NOT be called (adaptive path converts via convertResult)
      expect(mockEngineSearch).not.toHaveBeenCalled();
    });

    it('should pass classification metadata through to result', async () => {
      const engine = createTestEngine();
      const result = await engine.search('How does auth work?', mockProjects, undefined);

      expect(result.classification).toBeDefined();
      expect(result.classification!.type).toBe('factual');
      expect(result.classification!.confidence).toBe(0.85);
      expect(result.classification!.skippedRetrieval).toBe(false);
    });

    it('should convert AdaptiveRAG result through engine.convertResult()', async () => {
      const engine = createTestEngine();
      await engine.search('How does auth work?', mockProjects, undefined);

      // convertResult should have been called with the AdaptiveRAGResult cast as RAGResult
      expect(mockConvertResult).toHaveBeenCalledTimes(1);
      const [resultArg, timingArg] = mockConvertResult.mock.calls[0];
      expect(resultArg.content).toBe('<sources><source id="1">adaptive content</source></sources>');
      expect(timingArg).toBe(48); // totalMs from mock
    });

    it('should return empty result with classification when retrieval is skipped (SIMPLE query)', async () => {
      // Mock AdaptiveRAG to simulate a SIMPLE classification that skips retrieval
      mockAdaptiveSearch.mockResolvedValueOnce({
        content: '',
        estimatedTokens: 0,
        sources: [],
        assembly: { content: '', estimatedTokens: 0, chunkCount: 0, deduplicatedCount: 0, droppedCount: 0, sources: [], chunks: [] },
        retrievalResults: [],
        metadata: {
          effectiveQuery: 'hello',
          retrievedCount: 0,
          assembledCount: 0,
          deduplicatedCount: 0,
          droppedCount: 0,
          fromCache: false,
          timings: { retrievalMs: 0, assemblyMs: 0, totalMs: 2 },
        },
        classification: {
          type: 'simple',
          confidence: 0.95,
          features: { wordCount: 1, charCount: 5, hasQuestionWords: false, questionWords: [], isGreeting: true, hasPronouns: false, pronouns: [], hasComplexKeywords: false, complexKeywords: [], hasFollowUpPattern: false, endsWithQuestion: false, potentialEntityCount: 0 },
          recommendation: { skipRetrieval: true, enableEnhancement: false, enableReranking: false, suggestedTopK: 0, needsConversationContext: false },
        },
        skippedRetrieval: true,
        skipReason: 'Query classified as simple - no retrieval needed',
      } satisfies AdaptiveRAGResult);

      const engine = createTestEngine();
      const result = await engine.search('hello', mockProjects, undefined);

      // Should return empty result
      expect(result.sources).toHaveLength(0);
      expect(result.estimatedTokens).toBe(0);

      // Classification should be present
      expect(result.classification).toBeDefined();
      expect(result.classification!.type).toBe('simple');
      expect(result.classification!.confidence).toBe(0.95);
      expect(result.classification!.skippedRetrieval).toBe(true);

      // Routing metadata should still be present
      expect(result.routing.method).toBe('heuristic');
      expect(result.routing.projectIds).toEqual(['project-1']);

      // engine.convertResult should NOT be called when retrieval is skipped
      expect(mockConvertResult).not.toHaveBeenCalled();
    });

    it('should respect custom topK from options', async () => {
      const engine = createTestEngine();
      await engine.search('Analyze the full architecture', mockProjects, undefined, { finalK: 10 });

      expect(mockAdaptiveSearch).toHaveBeenCalledWith(
        'Analyze the full architecture',
        { topK: 10, maxTokens: undefined }
      );
    });

    it('should fall back to direct engine.search when adaptive=false', async () => {
      const engine = createTestEngine({ adaptive: false });
      const result = await engine.search('How does auth work?', mockProjects, undefined);

      // AdaptiveRAG should NOT be used
      expect(mockAdaptiveSearch).not.toHaveBeenCalled();
      // Direct engine search should be called
      expect(mockEngineSearch).toHaveBeenCalledWith('How does auth work?', undefined);
      // Result should come from direct engine search (no classification)
      expect(result.classification).toBeUndefined();
      expect(result.sources.length).toBeGreaterThan(0);
    });

    it('should cache AdaptiveRAG instances per project', async () => {
      const engine = createTestEngine();

      // Two searches to the same project
      await engine.search('query 1', mockProjects, undefined);
      await engine.search('query 2', mockProjects, undefined);

      // AdaptiveRAG constructor should only be called once (cached)
      // Since vi.mock creates a new class instance, we verify by checking that
      // getSDKEngine was only called once (it's called during AdaptiveRAG creation)
      expect(mockGetSDKEngine).toHaveBeenCalledTimes(1);
    });

    it('should clear adaptive engines on dispose', async () => {
      const engine = createTestEngine();

      // Create an adaptive engine by searching
      await engine.search('test', mockProjects, undefined);
      expect(mockGetSDKEngine).toHaveBeenCalledTimes(1);

      // Dispose clears both engines and adaptiveEngines maps
      engine.dispose();

      // After dispose, a new search should create a new engine + adaptive wrapper
      mockGetSDKEngine.mockClear();
      mockCreateRAGEngine.mockResolvedValue({
        search: mockEngineSearch,
        dispose: mockEngineDispose,
        getSDKEngine: mockGetSDKEngine,
        convertResult: mockConvertResult,
      });

      await engine.search('test again', mockProjects, undefined);
      // Should create fresh engine + adaptive wrapper
      expect(mockGetSDKEngine).toHaveBeenCalledTimes(1);
      expect(mockCreateRAGEngine).toHaveBeenCalledTimes(2); // original + after dispose
    });

    it('should not use AdaptiveRAG for multi-project searches', async () => {
      // Mock router to return multiple projects
      mockRoute.mockResolvedValueOnce({
        projectIds: ['project-1', 'project-2'],
        method: 'heuristic',
        confidence: 0.85,
        reason: 'Multi-project query detected',
      });

      const engine = createTestEngine();
      const result = await engine.search('Compare auth across projects', mockProjects, undefined);

      // Multi-project uses fusion service, NOT AdaptiveRAG
      expect(mockAdaptiveSearch).not.toHaveBeenCalled();
      expect(mockFusionSearch).toHaveBeenCalled();
      // No classification on multi-project results
      expect(result.classification).toBeUndefined();
    });

    it('should handle AdaptiveRAG with missing classification gracefully', async () => {
      // Mock AdaptiveRAG to return result without classification (includeClassificationInMetadata=false)
      mockAdaptiveSearch.mockResolvedValueOnce({
        content: '<sources>content</sources>',
        estimatedTokens: 50,
        sources: [],
        assembly: { content: '', estimatedTokens: 0, chunkCount: 0, deduplicatedCount: 0, droppedCount: 0, sources: [], chunks: [] },
        retrievalResults: [],
        metadata: {
          effectiveQuery: 'test',
          retrievedCount: 3,
          assembledCount: 3,
          deduplicatedCount: 0,
          droppedCount: 0,
          fromCache: false,
          timings: { retrievalMs: 30, assemblyMs: 5, totalMs: 35 },
        },
        // No classification field
        skippedRetrieval: false,
      } satisfies AdaptiveRAGResult);

      const engine = createTestEngine();
      const result = await engine.search('test query', mockProjects, undefined);

      // Should work without classification
      expect(result.classification).toBeUndefined();
      expect(mockConvertResult).toHaveBeenCalled();
    });
  });
});

describe('createRoutingRAGEngine factory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a RoutingRAGEngine instance', () => {
    const engine = createRoutingRAGEngine({
      config: mockConfig,
      embeddingProvider: mockEmbeddingProvider,
      dimensions: 768,
    });

    expect(engine).toBeInstanceOf(RoutingRAGEngine);
  });
});
