/**
 * RoutingRAGEngine Unit Tests
 *
 * Tests the unified routing + RAG engine that handles:
 * - Single-project search via ContextExpertRAGEngine
 * - Multi-project search via MultiProjectFusionService
 * - Automatic query routing via LLMProjectRouter
 * - Force RAG behavior
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RoutingRAGEngineConfig, ProjectMetadata, RAGSearchResult } from '../types.js';
import type { EmbeddingProvider } from '@contextaisdk/rag';

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
const mockCreateRAGEngine = vi.fn();
vi.mock('../rag-engine.js', () => ({
  createRAGEngine: (...args: unknown[]) => mockCreateRAGEngine(...args),
  ContextExpertRAGEngine: class MockContextExpertRAGEngine {},
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
    mockCreateRAGEngine.mockResolvedValue({
      search: mockEngineSearch,
      dispose: mockEngineDispose,
    });

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
