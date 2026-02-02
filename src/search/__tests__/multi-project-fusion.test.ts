/**
 * MultiProjectFusionService Tests
 *
 * Tests for cross-project hybrid search functionality including:
 * - Validation delegation to vector manager
 * - Parallel loading of vector and BM25 stores
 * - Hybrid search with RRF fusion
 * - Project attribution preservation
 * - Reranking integration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  MultiProjectFusionService,
  getMultiProjectFusionService,
  resetMultiProjectFusionService,
} from '../multi-project-fusion.js';
import { EmbeddingMismatchError } from '../errors.js';
import type {
  MultiProjectSearchResult,
  EmbeddingValidation,
} from '../types.js';

// Mock the underlying managers
const mockVectorManager = {
  validateProjects: vi.fn(),
  loadStores: vi.fn(),
  search: vi.fn(),
  getLoadedProjects: vi.fn(),
  clearLoadedProjects: vi.fn(),
  removeProject: vi.fn(),
  loadedProjectCount: 0,
};

const mockBM25Manager = {
  loadRetrievers: vi.fn(),
  search: vi.fn(),
  getLoadedProjects: vi.fn(),
  clearLoadedProjects: vi.fn(),
  removeProject: vi.fn(),
  loadedProjectCount: 0,
};

const mockRerankerService = {
  warmup: vi.fn(),
  rerank: vi.fn(),
  isLoaded: vi.fn(),
};

// Mock modules
vi.mock('../multi-project-store.js', () => ({
  getMultiProjectVectorStoreManager: vi.fn(() => mockVectorManager),
  MultiProjectVectorStoreManager: vi.fn(),
  resetMultiProjectVectorStoreManager: vi.fn(),
}));

vi.mock('../multi-project-bm25-store.js', () => ({
  getMultiProjectBM25StoreManager: vi.fn(() => mockBM25Manager),
  MultiProjectBM25StoreManager: vi.fn(),
  resetMultiProjectBM25StoreManager: vi.fn(),
}));

vi.mock('../reranker.js', () => ({
  RerankerService: vi.fn(() => mockRerankerService),
}));

// Mock fusion.js but keep the actual computeRRF implementation
vi.mock('../fusion.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fusion.js')>();
  return {
    ...actual,
    // Keep the real computeRRF for accurate fusion testing
  };
});

/**
 * Create a mock multi-project search result.
 */
function createMockResult(
  id: string,
  score: number,
  projectId: string,
  projectName: string
): MultiProjectSearchResult {
  return {
    id,
    score,
    content: `Content for ${id}`,
    filePath: `src/${id}.ts`,
    fileType: 'code',
    language: 'typescript',
    lineRange: { start: 1, end: 10 },
    metadata: { filePath: `src/${id}.ts`, fileType: 'code' },
    projectId,
    projectName,
  };
}

describe('MultiProjectFusionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMultiProjectFusionService();

    // Default to valid validation (tests that need invalid should override)
    mockVectorManager.validateProjects.mockReturnValue({
      valid: true,
      expectedDimensions: 1024,
      expectedModel: 'BAAI/bge-large-en-v1.5',
    });

    // Reset mock property
    Object.defineProperty(mockVectorManager, 'loadedProjectCount', {
      get: () => 2,
      configurable: true,
    });
  });

  afterEach(() => {
    resetMultiProjectFusionService();
  });

  // ==========================================================================
  // Validation Tests
  // ==========================================================================

  describe('validateProjects', () => {
    it('should delegate to vector manager', () => {
      const validation: EmbeddingValidation = {
        valid: true,
        expectedDimensions: 1024,
        expectedModel: 'BAAI/bge-large-en-v1.5',
      };
      mockVectorManager.validateProjects.mockReturnValue(validation);

      const service = new MultiProjectFusionService();
      const result = service.validateProjects(['proj-1', 'proj-2']);

      expect(mockVectorManager.validateProjects).toHaveBeenCalledWith([
        'proj-1',
        'proj-2',
      ]);
      expect(result).toEqual(validation);
    });

    it('should return validation errors from vector manager', () => {
      const validation: EmbeddingValidation = {
        valid: false,
        errors: [
          {
            projectId: 'proj-2',
            projectName: 'Project 2',
            embeddingModel: 'different-model',
            embeddingDimensions: 768,
          },
        ],
        expectedDimensions: 1024,
        expectedModel: 'BAAI/bge-large-en-v1.5',
      };
      mockVectorManager.validateProjects.mockReturnValue(validation);

      const service = new MultiProjectFusionService();
      const result = service.validateProjects(['proj-1', 'proj-2']);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Loading Tests
  // ==========================================================================

  describe('loadProjects', () => {
    it('should load both vector and BM25 managers in parallel', async () => {
      mockVectorManager.loadStores.mockResolvedValue(new Map());
      mockBM25Manager.loadRetrievers.mockResolvedValue(new Map());

      const service = new MultiProjectFusionService();
      await service.loadProjects({
        projectIds: ['proj-1', 'proj-2'],
        dimensions: 1024,
      });

      expect(mockVectorManager.loadStores).toHaveBeenCalledWith(
        {
          projectIds: ['proj-1', 'proj-2'],
          dimensions: 1024,
          useHNSW: undefined,
          hnswConfig: undefined,
        },
        undefined
      );
      expect(mockBM25Manager.loadRetrievers).toHaveBeenCalledWith(
        {
          projectIds: ['proj-1', 'proj-2'],
          bm25Config: undefined,
        },
        undefined
      );
    });

    it('should pass all options to managers', async () => {
      mockVectorManager.loadStores.mockResolvedValue(new Map());
      mockBM25Manager.loadRetrievers.mockResolvedValue(new Map());

      const service = new MultiProjectFusionService();
      await service.loadProjects({
        projectIds: ['proj-1'],
        dimensions: 768,
        useHNSW: false,
        hnswConfig: { M: 32, efConstruction: 400 },
        bm25Config: { k1: 1.5, b: 0.8 },
      });

      expect(mockVectorManager.loadStores).toHaveBeenCalledWith(
        expect.objectContaining({
          dimensions: 768,
          useHNSW: false,
          hnswConfig: { M: 32, efConstruction: 400 },
        }),
        undefined
      );
      expect(mockBM25Manager.loadRetrievers).toHaveBeenCalledWith(
        expect.objectContaining({
          bm25Config: { k1: 1.5, b: 0.8 },
        }),
        undefined
      );
    });

    it('should set initialized flag after loading', async () => {
      mockVectorManager.loadStores.mockResolvedValue(new Map());
      mockBM25Manager.loadRetrievers.mockResolvedValue(new Map());

      const service = new MultiProjectFusionService();
      expect(service.isInitialized()).toBe(false);

      await service.loadProjects({
        projectIds: ['proj-1'],
        dimensions: 1024,
      });

      expect(service.isInitialized()).toBe(true);
    });

    it('should warmup reranker in parallel when enabled', async () => {
      mockVectorManager.loadStores.mockResolvedValue(new Map());
      mockBM25Manager.loadRetrievers.mockResolvedValue(new Map());
      mockRerankerService.warmup.mockResolvedValue(undefined);

      const service = new MultiProjectFusionService({ rerank: true });
      await service.loadProjects({
        projectIds: ['proj-1'],
        dimensions: 1024,
      });

      expect(mockRerankerService.warmup).toHaveBeenCalled();
    });

    it('should not warmup reranker when disabled', async () => {
      mockVectorManager.loadStores.mockResolvedValue(new Map());
      mockBM25Manager.loadRetrievers.mockResolvedValue(new Map());

      const service = new MultiProjectFusionService({ rerank: false });
      await service.loadProjects({
        projectIds: ['proj-1'],
        dimensions: 1024,
      });

      expect(mockRerankerService.warmup).not.toHaveBeenCalled();
    });

    it('should call progress callback', async () => {
      mockVectorManager.loadStores.mockResolvedValue(new Map());
      mockBM25Manager.loadRetrievers.mockResolvedValue(new Map());

      const onProgress = vi.fn();
      const service = new MultiProjectFusionService();
      await service.loadProjects(
        { projectIds: ['proj-1'], dimensions: 1024 },
        onProgress
      );

      // Progress callback should be passed to both managers
      expect(mockVectorManager.loadStores).toHaveBeenCalledWith(
        expect.anything(),
        onProgress
      );
      expect(mockBM25Manager.loadRetrievers).toHaveBeenCalledWith(
        expect.anything(),
        onProgress
      );
    });

    it('should throw EmbeddingMismatchError when models mismatch', async () => {
      const validation: EmbeddingValidation = {
        valid: false,
        errors: [
          {
            projectId: 'proj-2',
            projectName: 'project-two',
            embeddingModel: 'Xenova/nomic-embed-text-v1.5',
            embeddingDimensions: 768,
          },
        ],
        expectedDimensions: 1024,
        expectedModel: 'BAAI/bge-large-en-v1.5',
      };
      mockVectorManager.validateProjects.mockReturnValue(validation);

      const service = new MultiProjectFusionService();

      await expect(
        service.loadProjects({
          projectIds: ['proj-1', 'proj-2'],
          dimensions: 1024,
        })
      ).rejects.toThrow(EmbeddingMismatchError);

      // Should NOT have called loadStores since validation failed
      expect(mockVectorManager.loadStores).not.toHaveBeenCalled();
      expect(mockBM25Manager.loadRetrievers).not.toHaveBeenCalled();
    });

    it('should skip validation for single project', async () => {
      mockVectorManager.loadStores.mockResolvedValue(new Map());
      mockBM25Manager.loadRetrievers.mockResolvedValue(new Map());

      const service = new MultiProjectFusionService();

      // Should NOT call validateProjects for single project
      await service.loadProjects({
        projectIds: ['proj-1'],
        dimensions: 1024,
      });

      expect(mockVectorManager.validateProjects).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Search Tests
  // ==========================================================================

  describe('search', () => {
    beforeEach(() => {
      // Setup common mock returns
      mockVectorManager.loadStores.mockResolvedValue(new Map());
      mockBM25Manager.loadRetrievers.mockResolvedValue(new Map());
    });

    it('should run dense and BM25 searches in parallel', async () => {
      const denseResults = [
        createMockResult('chunk-1', 0.9, 'proj-1', 'Project 1'),
        createMockResult('chunk-2', 0.8, 'proj-2', 'Project 2'),
      ];
      const bm25Results = [
        createMockResult('chunk-3', 0.85, 'proj-1', 'Project 1'),
        createMockResult('chunk-1', 0.75, 'proj-1', 'Project 1'),
      ];

      mockVectorManager.search.mockResolvedValue(denseResults);
      mockBM25Manager.search.mockResolvedValue(bm25Results);

      const service = new MultiProjectFusionService();
      await service.loadProjects({ projectIds: ['proj-1'], dimensions: 1024 });

      const queryEmbedding = [0.1, 0.2, 0.3];
      await service.search('test query', queryEmbedding);

      expect(mockVectorManager.search).toHaveBeenCalledWith(
        queryEmbedding,
        expect.any(Object)
      );
      expect(mockBM25Manager.search).toHaveBeenCalledWith(
        'test query',
        expect.any(Object)
      );
    });

    it('should fuse results using RRF and preserve project attribution', async () => {
      // Dense results: chunk-1 (rank 1), chunk-2 (rank 2)
      const denseResults = [
        createMockResult('chunk-1', 0.9, 'proj-1', 'Project 1'),
        createMockResult('chunk-2', 0.8, 'proj-2', 'Project 2'),
      ];
      // BM25 results: chunk-2 (rank 1), chunk-1 (rank 2)
      const bm25Results = [
        createMockResult('chunk-2', 0.85, 'proj-2', 'Project 2'),
        createMockResult('chunk-1', 0.75, 'proj-1', 'Project 1'),
      ];

      mockVectorManager.search.mockResolvedValue(denseResults);
      mockBM25Manager.search.mockResolvedValue(bm25Results);

      const service = new MultiProjectFusionService();
      await service.loadProjects({ projectIds: ['proj-1'], dimensions: 1024 });

      const results = await service.search('test', [0.1]);

      // Both chunks appear in both result sets, so they should both be fused
      expect(results.length).toBeGreaterThan(0);

      // Check project attribution is preserved
      for (const result of results) {
        expect(result.projectId).toBeDefined();
        expect(result.projectName).toBeDefined();
      }

      // chunk-1 and chunk-2 both appear in both lists, so they should be in results
      const ids = results.map((r) => r.id);
      expect(ids).toContain('chunk-1');
      expect(ids).toContain('chunk-2');
    });

    it('should handle empty results from one search type', async () => {
      const denseResults = [
        createMockResult('chunk-1', 0.9, 'proj-1', 'Project 1'),
      ];
      const bm25Results: MultiProjectSearchResult[] = [];

      mockVectorManager.search.mockResolvedValue(denseResults);
      mockBM25Manager.search.mockResolvedValue(bm25Results);

      const service = new MultiProjectFusionService();
      await service.loadProjects({ projectIds: ['proj-1'], dimensions: 1024 });

      const results = await service.search('test', [0.1]);

      expect(results.length).toBe(1);
      expect(results[0]!.id).toBe('chunk-1');
    });

    it('should handle empty results from both search types', async () => {
      mockVectorManager.search.mockResolvedValue([]);
      mockBM25Manager.search.mockResolvedValue([]);

      const service = new MultiProjectFusionService();
      await service.loadProjects({ projectIds: ['proj-1'], dimensions: 1024 });

      const results = await service.search('test', [0.1]);

      expect(results).toEqual([]);
    });

    it('should apply topK limit', async () => {
      const denseResults = Array.from({ length: 20 }, (_, i) =>
        createMockResult(`chunk-${i}`, 0.9 - i * 0.01, 'proj-1', 'Project 1')
      );
      const bm25Results = Array.from({ length: 20 }, (_, i) =>
        createMockResult(`chunk-${i + 20}`, 0.85 - i * 0.01, 'proj-1', 'Project 1')
      );

      mockVectorManager.search.mockResolvedValue(denseResults);
      mockBM25Manager.search.mockResolvedValue(bm25Results);

      const service = new MultiProjectFusionService();
      await service.loadProjects({ projectIds: ['proj-1'], dimensions: 1024 });

      const results = await service.search('test', [0.1], { topK: 5 });

      expect(results.length).toBe(5);
    });

    it('should apply minScore filter', async () => {
      const denseResults = [
        createMockResult('chunk-1', 0.9, 'proj-1', 'Project 1'),
        createMockResult('chunk-2', 0.01, 'proj-1', 'Project 1'),
      ];
      const bm25Results = [
        createMockResult('chunk-3', 0.02, 'proj-1', 'Project 1'),
      ];

      mockVectorManager.search.mockResolvedValue(denseResults);
      mockBM25Manager.search.mockResolvedValue(bm25Results);

      const service = new MultiProjectFusionService();
      await service.loadProjects({ projectIds: ['proj-1'], dimensions: 1024 });

      const results = await service.search('test', [0.1], { minScore: 0.02 });

      // After RRF fusion, scores change - but the filter is applied post-fusion
      // RRF scores are typically small (1/(k+rank)), so this tests the filter works
      expect(results.every((r) => r.score >= 0.02)).toBe(true);
    });

    it('should pass search options to managers', async () => {
      mockVectorManager.search.mockResolvedValue([]);
      mockBM25Manager.search.mockResolvedValue([]);

      const service = new MultiProjectFusionService();
      await service.loadProjects({ projectIds: ['proj-1'], dimensions: 1024 });

      await service.search('test', [0.1], {
        topK: 15,
        topKPerProject: 30,
        minScore: 0.5,
        fileType: 'code',
        language: 'typescript',
      });

      expect(mockVectorManager.search).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          topKPerProject: 30,
          minScore: 0.5,
          fileType: 'code',
          language: 'typescript',
        })
      );
    });
  });

  // ==========================================================================
  // Reranking Tests
  // ==========================================================================

  describe('reranking', () => {
    it('should rerank results when enabled', async () => {
      const denseResults = [
        createMockResult('chunk-1', 0.9, 'proj-1', 'Project 1'),
      ];
      const bm25Results = [
        createMockResult('chunk-2', 0.8, 'proj-1', 'Project 1'),
      ];
      const rerankedResults = [
        createMockResult('chunk-2', 0.95, 'proj-1', 'Project 1'),
        createMockResult('chunk-1', 0.85, 'proj-1', 'Project 1'),
      ];

      mockVectorManager.search.mockResolvedValue(denseResults);
      mockBM25Manager.search.mockResolvedValue(bm25Results);
      mockVectorManager.loadStores.mockResolvedValue(new Map());
      mockBM25Manager.loadRetrievers.mockResolvedValue(new Map());
      mockRerankerService.warmup.mockResolvedValue(undefined);
      mockRerankerService.rerank.mockResolvedValue(rerankedResults);

      const service = new MultiProjectFusionService({ rerank: true });
      await service.loadProjects({ projectIds: ['proj-1'], dimensions: 1024 });

      const results = await service.search('test', [0.1], { topK: 5 });

      expect(mockRerankerService.rerank).toHaveBeenCalledWith(
        'test',
        expect.any(Array),
        5
      );
      expect(results).toEqual(rerankedResults);
    });

    it('should not rerank when disabled', async () => {
      mockVectorManager.search.mockResolvedValue([]);
      mockBM25Manager.search.mockResolvedValue([]);
      mockVectorManager.loadStores.mockResolvedValue(new Map());
      mockBM25Manager.loadRetrievers.mockResolvedValue(new Map());

      const service = new MultiProjectFusionService({ rerank: false });
      await service.loadProjects({ projectIds: ['proj-1'], dimensions: 1024 });

      await service.search('test', [0.1]);

      expect(mockRerankerService.rerank).not.toHaveBeenCalled();
    });

    it('should preserve project attribution after reranking (bug fix)', async () => {
      // This test verifies the fix for the bug where reranking lost project attribution
      // because rerankerService.rerank() returns SearchResultWithContext[] (base type)
      // instead of MultiProjectSearchResult[] (extended type with projectId/projectName)

      const denseResults = [
        createMockResult('chunk-1', 0.9, 'proj-1', 'Project 1'),
        createMockResult('chunk-2', 0.7, 'proj-2', 'Project 2'),
      ];
      const bm25Results = [
        createMockResult('chunk-3', 0.85, 'proj-2', 'Project 2'),
        createMockResult('chunk-4', 0.6, 'proj-1', 'Project 1'),
      ];

      // Simulate what the real reranker does: returns base SearchResultWithContext[]
      // WITHOUT projectId and projectName fields
      const rerankedWithoutProjectInfo = [
        {
          id: 'chunk-3',
          score: 0.98,
          content: 'Content for chunk-3',
          filePath: 'src/chunk-3.ts',
          fileType: 'code' as const,
          language: 'typescript',
          lineRange: { start: 1, end: 10 },
          metadata: { filePath: 'src/chunk-3.ts', fileType: 'code' },
          // NOTE: No projectId or projectName - this is the bug scenario
        },
        {
          id: 'chunk-1',
          score: 0.92,
          content: 'Content for chunk-1',
          filePath: 'src/chunk-1.ts',
          fileType: 'code' as const,
          language: 'typescript',
          lineRange: { start: 1, end: 10 },
          metadata: { filePath: 'src/chunk-1.ts', fileType: 'code' },
          // NOTE: No projectId or projectName - this is the bug scenario
        },
      ];

      mockVectorManager.search.mockResolvedValue(denseResults);
      mockBM25Manager.search.mockResolvedValue(bm25Results);
      mockVectorManager.loadStores.mockResolvedValue(new Map());
      mockBM25Manager.loadRetrievers.mockResolvedValue(new Map());
      mockRerankerService.warmup.mockResolvedValue(undefined);
      mockRerankerService.rerank.mockResolvedValue(rerankedWithoutProjectInfo);

      const service = new MultiProjectFusionService({ rerank: true });
      await service.loadProjects({
        projectIds: ['proj-1', 'proj-2'],
        dimensions: 1024,
      });

      const results = await service.search('test', [0.1], { topK: 5 });

      // CRITICAL: Project attribution MUST be preserved after reranking
      // This was the bug - without the fix, projectId and projectName would be undefined
      expect(results).toHaveLength(2);

      // chunk-3 came from proj-2
      expect(results[0]!.id).toBe('chunk-3');
      expect(results[0]!.projectId).toBe('proj-2');
      expect(results[0]!.projectName).toBe('Project 2');

      // chunk-1 came from proj-1
      expect(results[1]!.id).toBe('chunk-1');
      expect(results[1]!.projectId).toBe('proj-1');
      expect(results[1]!.projectName).toBe('Project 1');
    });
  });

  // ==========================================================================
  // State Management Tests
  // ==========================================================================

  describe('state management', () => {
    it('should return loaded projects from vector manager', () => {
      mockVectorManager.getLoadedProjects.mockReturnValue(['proj-1', 'proj-2']);

      const service = new MultiProjectFusionService();
      const projects = service.getLoadedProjects();

      expect(projects).toEqual(['proj-1', 'proj-2']);
    });

    it('should clear both managers', () => {
      const service = new MultiProjectFusionService();
      service.clearLoadedProjects();

      expect(mockVectorManager.clearLoadedProjects).toHaveBeenCalled();
      expect(mockBM25Manager.clearLoadedProjects).toHaveBeenCalled();
    });

    it('should remove project from both managers', () => {
      mockVectorManager.removeProject.mockReturnValue(true);
      mockBM25Manager.removeProject.mockReturnValue(true);

      const service = new MultiProjectFusionService();
      const removed = service.removeProject('proj-1');

      expect(removed).toBe(true);
      expect(mockVectorManager.removeProject).toHaveBeenCalledWith('proj-1');
      expect(mockBM25Manager.removeProject).toHaveBeenCalledWith('proj-1');
    });

    it('should return true if removed from at least one manager', () => {
      mockVectorManager.removeProject.mockReturnValue(true);
      mockBM25Manager.removeProject.mockReturnValue(false);

      const service = new MultiProjectFusionService();
      const removed = service.removeProject('proj-1');

      expect(removed).toBe(true);
    });

    it('should return false if not found in either manager', () => {
      mockVectorManager.removeProject.mockReturnValue(false);
      mockBM25Manager.removeProject.mockReturnValue(false);

      const service = new MultiProjectFusionService();
      const removed = service.removeProject('proj-1');

      expect(removed).toBe(false);
    });

    it('should reset initialized flag when clearing', async () => {
      mockVectorManager.loadStores.mockResolvedValue(new Map());
      mockBM25Manager.loadRetrievers.mockResolvedValue(new Map());

      const service = new MultiProjectFusionService();
      await service.loadProjects({ projectIds: ['proj-1'], dimensions: 1024 });
      expect(service.isInitialized()).toBe(true);

      service.clearLoadedProjects();
      expect(service.isInitialized()).toBe(false);
    });
  });

  // ==========================================================================
  // Singleton Tests
  // ==========================================================================

  describe('singleton pattern', () => {
    it('should return same instance on subsequent calls', () => {
      const service1 = getMultiProjectFusionService();
      const service2 = getMultiProjectFusionService();

      expect(service1).toBe(service2);
    });

    it('should apply config only on first call', () => {
      // This is tested implicitly - the mock RerankerService would be called
      // only if rerank: true is applied
      const service1 = getMultiProjectFusionService({ rerank: true });
      const service2 = getMultiProjectFusionService({ rerank: false });

      expect(service1).toBe(service2);
      // Both should have rerank enabled (from first call)
    });

    it('should create new instance after reset', () => {
      const service1 = getMultiProjectFusionService();
      resetMultiProjectFusionService();
      const service2 = getMultiProjectFusionService();

      expect(service1).not.toBe(service2);
    });

    it('should clear loaded projects on reset', () => {
      const service = getMultiProjectFusionService();
      resetMultiProjectFusionService();

      expect(mockVectorManager.clearLoadedProjects).toHaveBeenCalled();
      expect(mockBM25Manager.clearLoadedProjects).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Configuration Tests
  // ==========================================================================

  describe('configuration', () => {
    it('should use default RRF k value when not specified', () => {
      const service = new MultiProjectFusionService();
      // Internal state check would require exposing fusionConfig
      // Instead we verify it doesn't throw with defaults
      expect(service).toBeDefined();
    });

    it('should accept custom RRF configuration', () => {
      const service = new MultiProjectFusionService({
        fusionConfig: {
          k: 30,
          weights: { dense: 1.2, bm25: 0.8 },
        },
      });
      expect(service).toBeDefined();
    });

    it('should accept reranker configuration', () => {
      const service = new MultiProjectFusionService({
        rerank: true,
        rerankConfig: {
          model: 'Xenova/bge-reranker-large',
          candidateCount: 100,
        },
      });
      expect(service).toBeDefined();
    });
  });
});
