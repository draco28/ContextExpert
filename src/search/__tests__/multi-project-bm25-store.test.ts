/**
 * MultiProjectBM25StoreManager Tests
 *
 * Tests for cross-project BM25 search functionality including:
 * - Multi-project retriever loading
 * - Parallel search with RRF merge
 * - State management
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BM25Retriever, RetrievalResult } from '@contextaisdk/rag';

import {
  MultiProjectBM25StoreManager,
  getMultiProjectBM25StoreManager,
  resetMultiProjectBM25StoreManager,
} from '../multi-project-bm25-store.js';
import { resetBM25StoreManager } from '../bm25-store.js';
import type { Project } from '../../database/schema.js';

// Mock dependencies
vi.mock('../../database/operations.js', () => ({
  getDatabase: vi.fn(() => mockDbOps),
  DatabaseOperations: vi.fn(),
}));

vi.mock('../bm25-store.js', () => ({
  getBM25StoreManager: vi.fn(() => mockStoreManager),
  resetBM25StoreManager: vi.fn(),
  BM25StoreManager: vi.fn(),
}));

// Mock instances
let mockDbOps: {
  getProjectById: ReturnType<typeof vi.fn>;
  getAllProjects: ReturnType<typeof vi.fn>;
};

let mockStoreManager: {
  getRetriever: ReturnType<typeof vi.fn>;
  hasRetriever: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
  clearAll: ReturnType<typeof vi.fn>;
};

/**
 * Create a mock project.
 */
function createMockProject(id: string, name: string): Project {
  return {
    id,
    name,
    path: `/path/to/${name}`,
    tags: null,
    ignore_patterns: null,
    indexed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    file_count: 10,
    chunk_count: 50,
    config: null,
    embedding_model: 'BAAI/bge-large-en-v1.5',
    embedding_dimensions: 1024,
    description: null,
  };
}

/**
 * Create a mock BM25Retriever with search results.
 */
function createMockRetriever(
  chunks: Array<{ id: string; content: string; score: number; metadata?: Record<string, unknown> }>
): BM25Retriever {
  const mockRetriever = {
    retrieve: vi.fn().mockResolvedValue(
      chunks.map((c): RetrievalResult => ({
        id: c.id,
        score: c.score,
        chunk: {
          id: c.id,
          content: c.content,
          metadata: c.metadata ?? { filePath: 'test.ts', fileType: 'code' },
        },
      }))
    ),
    buildIndex: vi.fn(),
    documentCount: chunks.length,
    vocabularySize: 100,
    averageDocumentLength: 50,
  } as unknown as BM25Retriever;

  return mockRetriever;
}

describe('MultiProjectBM25StoreManager', () => {
  beforeEach(() => {
    // Reset mocks
    mockDbOps = {
      getProjectById: vi.fn(),
      getAllProjects: vi.fn(),
    };

    mockStoreManager = {
      getRetriever: vi.fn(),
      hasRetriever: vi.fn(),
      invalidate: vi.fn(),
      clearAll: vi.fn(),
    };

    resetMultiProjectBM25StoreManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetMultiProjectBM25StoreManager();
  });

  // ==========================================================================
  // Loading Tests
  // ==========================================================================

  describe('loadRetrievers', () => {
    it('should load multiple project retrievers', async () => {
      const project1 = createMockProject('proj-1', 'project-one');
      const project2 = createMockProject('proj-2', 'project-two');

      mockDbOps.getProjectById
        .mockReturnValueOnce(project1)
        .mockReturnValueOnce(project2);

      const retriever1 = createMockRetriever([{ id: 'c1', content: 'chunk 1', score: 0.9 }]);
      const retriever2 = createMockRetriever([{ id: 'c2', content: 'chunk 2', score: 0.8 }]);

      mockStoreManager.getRetriever
        .mockResolvedValueOnce(retriever1)
        .mockResolvedValueOnce(retriever2);

      const manager = new MultiProjectBM25StoreManager();
      const retrievers = await manager.loadRetrievers({
        projectIds: ['proj-1', 'proj-2'],
      });

      expect(retrievers.size).toBe(2);
      expect(retrievers.get('proj-1')).toBe(retriever1);
      expect(retrievers.get('proj-2')).toBe(retriever2);
    });

    it('should report progress per project', async () => {
      const project1 = createMockProject('proj-1', 'project-one');
      const project2 = createMockProject('proj-2', 'project-two');

      mockDbOps.getProjectById
        .mockReturnValueOnce(project1)
        .mockReturnValueOnce(project2);

      // Mock getRetriever to call the progress callback
      mockStoreManager.getRetriever.mockImplementation(
        async (_options: unknown, onProgress?: (p: unknown) => void) => {
          onProgress?.({ phase: 'loading', loaded: 10, total: 20 });
          return createMockRetriever([]);
        }
      );

      const progressCalls: unknown[] = [];
      const manager = new MultiProjectBM25StoreManager();

      await manager.loadRetrievers(
        {
          projectIds: ['proj-1', 'proj-2'],
        },
        (progress) => progressCalls.push(progress)
      );

      expect(progressCalls.length).toBe(2);

      // First project progress
      expect(progressCalls[0]).toMatchObject({
        projectId: 'proj-1',
        projectName: 'project-one',
        projectIndex: 1,
        totalProjects: 2,
      });

      // Second project progress
      expect(progressCalls[1]).toMatchObject({
        projectId: 'proj-2',
        projectName: 'project-two',
        projectIndex: 2,
        totalProjects: 2,
      });
    });

    it('should track loaded projects', async () => {
      const project = createMockProject('proj-1', 'project-one');
      mockDbOps.getProjectById.mockReturnValue(project);
      mockStoreManager.getRetriever.mockResolvedValue(createMockRetriever([]));

      const manager = new MultiProjectBM25StoreManager();

      expect(manager.hasProjectRetriever('proj-1')).toBe(false);

      await manager.loadRetrievers({
        projectIds: ['proj-1'],
      });

      expect(manager.hasProjectRetriever('proj-1')).toBe(true);
      expect(manager.getLoadedProjects()).toEqual(['proj-1']);
    });

    it('should pass BM25 config to store manager', async () => {
      const project = createMockProject('proj-1', 'project-one');
      mockDbOps.getProjectById.mockReturnValue(project);
      mockStoreManager.getRetriever.mockResolvedValue(createMockRetriever([]));

      const manager = new MultiProjectBM25StoreManager();

      await manager.loadRetrievers({
        projectIds: ['proj-1'],
        bm25Config: { k1: 1.5, b: 0.8 },
      });

      expect(mockStoreManager.getRetriever).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          bm25Config: { k1: 1.5, b: 0.8 },
        }),
        expect.any(Function)
      );
    });
  });

  // ==========================================================================
  // Search Tests
  // ==========================================================================

  describe('search', () => {
    it('should search all loaded projects in parallel', async () => {
      const project1 = createMockProject('proj-1', 'project-one');
      const project2 = createMockProject('proj-2', 'project-two');

      mockDbOps.getProjectById.mockImplementation((id: string) => {
        if (id === 'proj-1') return project1;
        if (id === 'proj-2') return project2;
        return undefined;
      });

      const retriever1 = createMockRetriever([
        { id: 'c1', content: 'authentication code', score: 0.9 },
      ]);
      const retriever2 = createMockRetriever([
        { id: 'c2', content: 'auth middleware', score: 0.85 },
      ]);

      // Return appropriate retriever based on projectId
      mockStoreManager.getRetriever.mockImplementation(
        async (options: { projectId: string }) => {
          if (options.projectId === 'proj-1') return retriever1;
          if (options.projectId === 'proj-2') return retriever2;
          return undefined;
        }
      );

      mockStoreManager.hasRetriever.mockReturnValue(true);

      const manager = new MultiProjectBM25StoreManager();
      await manager.loadRetrievers({
        projectIds: ['proj-1', 'proj-2'],
      });

      const results = await manager.search('authentication', { topK: 5 });

      expect(results.length).toBe(2);
      // Both retrievers should have been searched
      expect(retriever1.retrieve).toHaveBeenCalled();
      expect(retriever2.retrieve).toHaveBeenCalled();
    });

    it('should include projectId and projectName in results', async () => {
      const project = createMockProject('proj-1', 'project-one');
      mockDbOps.getProjectById.mockReturnValue(project);

      const retriever = createMockRetriever([
        { id: 'c1', content: 'test content', score: 0.9 },
      ]);
      mockStoreManager.getRetriever.mockResolvedValue(retriever);
      mockStoreManager.hasRetriever.mockReturnValue(true);

      const manager = new MultiProjectBM25StoreManager();
      await manager.loadRetrievers({
        projectIds: ['proj-1'],
      });

      const results = await manager.search('test query');

      expect(results[0]!.projectId).toBe('proj-1');
      expect(results[0]!.projectName).toBe('project-one');
    });

    it('should merge results using RRF for multiple projects', async () => {
      const project1 = createMockProject('proj-1', 'project-one');
      const project2 = createMockProject('proj-2', 'project-two');

      mockDbOps.getProjectById.mockImplementation((id: string) => {
        if (id === 'proj-1') return project1;
        if (id === 'proj-2') return project2;
        return undefined;
      });

      // Both projects have a result for the same chunk ID
      const retriever1 = createMockRetriever([
        { id: 'shared-chunk', content: 'shared content', score: 0.9 },
        { id: 'c1-only', content: 'unique to proj-1', score: 0.8 },
      ]);
      const retriever2 = createMockRetriever([
        { id: 'shared-chunk', content: 'shared content', score: 0.85 },
        { id: 'c2-only', content: 'unique to proj-2', score: 0.7 },
      ]);

      // Return appropriate retriever based on projectId
      mockStoreManager.getRetriever.mockImplementation(
        async (options: { projectId: string }) => {
          if (options.projectId === 'proj-1') return retriever1;
          if (options.projectId === 'proj-2') return retriever2;
          return undefined;
        }
      );

      mockStoreManager.hasRetriever.mockReturnValue(true);

      const manager = new MultiProjectBM25StoreManager();
      await manager.loadRetrievers({
        projectIds: ['proj-1', 'proj-2'],
      });

      const results = await manager.search('shared content', { topK: 10 });

      // The shared chunk should be boosted by RRF (appears in both lists)
      expect(results.length).toBe(3);
      expect(results[0]!.id).toBe('shared-chunk');
    });

    it('should return empty array when no projects loaded', async () => {
      const manager = new MultiProjectBM25StoreManager();

      const results = await manager.search('test query');

      expect(results).toEqual([]);
    });

    it('should skip RRF for single project (optimization)', async () => {
      const project = createMockProject('proj-1', 'project-one');
      mockDbOps.getProjectById.mockReturnValue(project);

      const retriever = createMockRetriever([
        { id: 'c1', content: 'chunk 1', score: 0.9 },
        { id: 'c2', content: 'chunk 2', score: 0.8 },
      ]);
      mockStoreManager.getRetriever.mockResolvedValue(retriever);
      mockStoreManager.hasRetriever.mockReturnValue(true);

      const manager = new MultiProjectBM25StoreManager();
      await manager.loadRetrievers({
        projectIds: ['proj-1'],
      });

      const results = await manager.search('test query', { topK: 5 });

      expect(results.length).toBe(2);
      // Original scores should be preserved (no RRF transformation)
      expect(results[0]!.score).toBe(0.9);
      expect(results[1]!.score).toBe(0.8);
    });

    it('should respect topK limit', async () => {
      const project = createMockProject('proj-1', 'project-one');
      mockDbOps.getProjectById.mockReturnValue(project);

      const retriever = createMockRetriever([
        { id: 'c1', content: 'chunk 1', score: 0.9 },
        { id: 'c2', content: 'chunk 2', score: 0.8 },
        { id: 'c3', content: 'chunk 3', score: 0.7 },
      ]);
      mockStoreManager.getRetriever.mockResolvedValue(retriever);
      mockStoreManager.hasRetriever.mockReturnValue(true);

      const manager = new MultiProjectBM25StoreManager();
      await manager.loadRetrievers({
        projectIds: ['proj-1'],
      });

      const results = await manager.search('test query', { topK: 2 });

      expect(results.length).toBe(2);
    });

    it('should filter by file type', async () => {
      const project = createMockProject('proj-1', 'project-one');
      mockDbOps.getProjectById.mockReturnValue(project);

      const retriever = createMockRetriever([
        { id: 'c1', content: 'code chunk', score: 0.9, metadata: { filePath: 'test.ts', fileType: 'code' } },
        { id: 'c2', content: 'docs chunk', score: 0.85, metadata: { filePath: 'README.md', fileType: 'docs' } },
      ]);
      mockStoreManager.getRetriever.mockResolvedValue(retriever);
      mockStoreManager.hasRetriever.mockReturnValue(true);

      const manager = new MultiProjectBM25StoreManager();
      await manager.loadRetrievers({
        projectIds: ['proj-1'],
      });

      const results = await manager.search('test query', { fileType: 'code' });

      expect(results.length).toBe(1);
      expect(results[0]!.fileType).toBe('code');
    });

    it('should filter by language', async () => {
      const project = createMockProject('proj-1', 'project-one');
      mockDbOps.getProjectById.mockReturnValue(project);

      const retriever = createMockRetriever([
        { id: 'c1', content: 'ts code', score: 0.9, metadata: { filePath: 'test.ts', fileType: 'code', language: 'typescript' } },
        { id: 'c2', content: 'py code', score: 0.85, metadata: { filePath: 'test.py', fileType: 'code', language: 'python' } },
      ]);
      mockStoreManager.getRetriever.mockResolvedValue(retriever);
      mockStoreManager.hasRetriever.mockReturnValue(true);

      const manager = new MultiProjectBM25StoreManager();
      await manager.loadRetrievers({
        projectIds: ['proj-1'],
      });

      const results = await manager.search('test query', { language: 'typescript' });

      expect(results.length).toBe(1);
      expect(results[0]!.language).toBe('typescript');
    });

    it('should handle external cache invalidation gracefully', async () => {
      const project1 = createMockProject('proj-1', 'project-one');
      const project2 = createMockProject('proj-2', 'project-two');

      mockDbOps.getProjectById.mockImplementation((id: string) => {
        if (id === 'proj-1') return project1;
        if (id === 'proj-2') return project2;
        return undefined;
      });

      const retriever1 = createMockRetriever([
        { id: 'c1', content: 'chunk 1', score: 0.9 },
      ]);
      const retriever2 = createMockRetriever([
        { id: 'c2', content: 'chunk 2', score: 0.8 },
      ]);

      mockStoreManager.getRetriever.mockImplementation(
        async (options: { projectId: string }) => {
          if (options.projectId === 'proj-1') return retriever1;
          if (options.projectId === 'proj-2') return retriever2;
          return undefined;
        }
      );

      const manager = new MultiProjectBM25StoreManager();
      await manager.loadRetrievers({
        projectIds: ['proj-1', 'proj-2'],
      });

      // Simulate external invalidation - proj-1's retriever was cleared
      mockStoreManager.hasRetriever.mockImplementation((id: string) => id !== 'proj-1');

      const results = await manager.search('test query');

      // Should only get results from proj-2 (proj-1 was skipped due to invalidation)
      expect(results.length).toBe(1);
      expect(results[0]!.projectId).toBe('proj-2');
    });

    it('should handle concurrent search requests', async () => {
      const project = createMockProject('proj-1', 'project-one');
      mockDbOps.getProjectById.mockReturnValue(project);

      const retriever = createMockRetriever([
        { id: 'c1', content: 'chunk 1', score: 0.9 },
      ]);
      mockStoreManager.getRetriever.mockResolvedValue(retriever);
      mockStoreManager.hasRetriever.mockReturnValue(true);

      const manager = new MultiProjectBM25StoreManager();
      await manager.loadRetrievers({
        projectIds: ['proj-1'],
      });

      // Run multiple searches concurrently
      const [results1, results2, results3] = await Promise.all([
        manager.search('query 1'),
        manager.search('query 2'),
        manager.search('query 3'),
      ]);

      // All should complete successfully
      expect(results1.length).toBe(1);
      expect(results2.length).toBe(1);
      expect(results3.length).toBe(1);
    });
  });

  // ==========================================================================
  // State Management Tests
  // ==========================================================================

  describe('state management', () => {
    it('should clear loaded projects', async () => {
      const project = createMockProject('proj-1', 'project-one');
      mockDbOps.getProjectById.mockReturnValue(project);
      mockStoreManager.getRetriever.mockResolvedValue(createMockRetriever([]));

      const manager = new MultiProjectBM25StoreManager();
      await manager.loadRetrievers({
        projectIds: ['proj-1'],
      });

      expect(manager.loadedProjectCount).toBe(1);

      manager.clearLoadedProjects();

      expect(manager.loadedProjectCount).toBe(0);
      expect(manager.hasProjectRetriever('proj-1')).toBe(false);
    });

    it('should remove specific project', async () => {
      const project1 = createMockProject('proj-1', 'project-one');
      const project2 = createMockProject('proj-2', 'project-two');

      mockDbOps.getProjectById
        .mockReturnValueOnce(project1)
        .mockReturnValueOnce(project2);

      mockStoreManager.getRetriever.mockResolvedValue(createMockRetriever([]));

      const manager = new MultiProjectBM25StoreManager();
      await manager.loadRetrievers({
        projectIds: ['proj-1', 'proj-2'],
      });

      expect(manager.loadedProjectCount).toBe(2);

      const removed = manager.removeProject('proj-1');

      expect(removed).toBe(true);
      expect(manager.loadedProjectCount).toBe(1);
      expect(manager.hasProjectRetriever('proj-1')).toBe(false);
      expect(manager.hasProjectRetriever('proj-2')).toBe(true);
    });

    it('should return false when removing non-existent project', () => {
      const manager = new MultiProjectBM25StoreManager();

      const removed = manager.removeProject('non-existent');

      expect(removed).toBe(false);
    });
  });

  // ==========================================================================
  // Singleton Tests
  // ==========================================================================

  describe('singleton functions', () => {
    beforeEach(() => {
      resetMultiProjectBM25StoreManager();
    });

    it('should return singleton instance', () => {
      const manager1 = getMultiProjectBM25StoreManager();
      const manager2 = getMultiProjectBM25StoreManager();
      expect(manager1).toBe(manager2);
    });

    it('should reset singleton', () => {
      const manager1 = getMultiProjectBM25StoreManager();
      resetMultiProjectBM25StoreManager();
      const manager2 = getMultiProjectBM25StoreManager();
      expect(manager1).not.toBe(manager2);
    });
  });
});
