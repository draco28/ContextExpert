/**
 * MultiProjectVectorStoreManager Tests
 *
 * Tests for cross-project search functionality including:
 * - Embedding validation across projects
 * - Multi-project store loading
 * - Parallel search with RRF merge
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryVectorStore } from '@contextaisdk/rag';

import {
  MultiProjectVectorStoreManager,
  getMultiProjectVectorStoreManager,
  resetMultiProjectVectorStoreManager,
} from '../multi-project-store.js';
import { resetVectorStoreManager } from '../store.js';
import { EmbeddingMismatchError } from '../errors.js';
import type { Project } from '../../database/schema.js';

// Mock dependencies
vi.mock('../../database/operations.js', () => ({
  getDatabase: vi.fn(() => mockDbOps),
  DatabaseOperations: vi.fn(),
}));

vi.mock('../store.js', () => ({
  getVectorStoreManager: vi.fn(() => mockStoreManager),
  resetVectorStoreManager: vi.fn(),
  VectorStoreManager: vi.fn(),
}));

// Mock instances
let mockDbOps: {
  getProjectById: ReturnType<typeof vi.fn>;
  getAllProjects: ReturnType<typeof vi.fn>;
};

let mockStoreManager: {
  getStore: ReturnType<typeof vi.fn>;
  hasStore: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
  clearAll: ReturnType<typeof vi.fn>;
};

/**
 * Create a mock project.
 */
function createMockProject(
  id: string,
  name: string,
  options: {
    embeddingModel?: string | null;
    embeddingDimensions?: number;
  } = {}
): Project {
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
    embedding_model: options.embeddingModel ?? 'BAAI/bge-large-en-v1.5',
    embedding_dimensions: options.embeddingDimensions ?? 1024,
    description: null,
  };
}

/**
 * Create a mock InMemoryVectorStore with search results.
 */
function createMockStore(
  chunks: Array<{ id: string; content: string; score: number; metadata?: Record<string, unknown> }>
): InMemoryVectorStore {
  const mockStore = {
    search: vi.fn().mockResolvedValue(
      chunks.map((c) => ({
        id: c.id,
        score: c.score,
        chunk: {
          id: c.id,
          content: c.content,
          metadata: c.metadata ?? { filePath: 'test.ts', fileType: 'code' },
        },
      }))
    ),
    count: vi.fn().mockResolvedValue(chunks.length),
    insert: vi.fn(),
    clear: vi.fn(),
    getIndexType: vi.fn().mockReturnValue('hnsw'),
  } as unknown as InMemoryVectorStore;

  return mockStore;
}

describe('MultiProjectVectorStoreManager', () => {
  beforeEach(() => {
    // Reset mocks
    mockDbOps = {
      getProjectById: vi.fn(),
      getAllProjects: vi.fn(),
    };

    mockStoreManager = {
      getStore: vi.fn(),
      hasStore: vi.fn(),
      invalidate: vi.fn(),
      clearAll: vi.fn(),
    };

    resetMultiProjectVectorStoreManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetMultiProjectVectorStoreManager();
  });

  // ==========================================================================
  // Validation Tests
  // ==========================================================================

  describe('validateProjects', () => {
    it('should pass validation for projects with same embedding model', () => {
      const project1 = createMockProject('proj-1', 'project-one');
      const project2 = createMockProject('proj-2', 'project-two');

      mockDbOps.getProjectById
        .mockReturnValueOnce(project1)
        .mockReturnValueOnce(project2);

      const manager = new MultiProjectVectorStoreManager();
      const result = manager.validateProjects(['proj-1', 'proj-2']);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
      expect(result.expectedDimensions).toBe(1024);
      expect(result.expectedModel).toBe('BAAI/bge-large-en-v1.5');
    });

    it('should fail validation for projects with different dimensions', () => {
      const project1 = createMockProject('proj-1', 'project-one', {
        embeddingDimensions: 1024,
      });
      const project2 = createMockProject('proj-2', 'project-two', {
        embeddingDimensions: 768, // Different!
      });

      mockDbOps.getProjectById
        .mockReturnValueOnce(project1)
        .mockReturnValueOnce(project2);

      const manager = new MultiProjectVectorStoreManager();
      const result = manager.validateProjects(['proj-1', 'proj-2']);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors![0]!.projectId).toBe('proj-2');
      expect(result.errors![0]!.embeddingDimensions).toBe(768);
    });

    it('should fail validation for projects with different models', () => {
      const project1 = createMockProject('proj-1', 'project-one', {
        embeddingModel: 'BAAI/bge-large-en-v1.5',
      });
      const project2 = createMockProject('proj-2', 'project-two', {
        embeddingModel: 'Xenova/nomic-embed-text-v1.5', // Different!
      });

      mockDbOps.getProjectById
        .mockReturnValueOnce(project1)
        .mockReturnValueOnce(project2);

      const manager = new MultiProjectVectorStoreManager();
      const result = manager.validateProjects(['proj-1', 'proj-2']);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors![0]!.projectName).toBe('project-two');
    });

    it('should allow null embedding models (legacy projects)', () => {
      const project1 = createMockProject('proj-1', 'project-one', {
        embeddingModel: null,
      });
      const project2 = createMockProject('proj-2', 'project-two', {
        embeddingModel: null,
      });

      mockDbOps.getProjectById
        .mockReturnValueOnce(project1)
        .mockReturnValueOnce(project2);

      const manager = new MultiProjectVectorStoreManager();
      const result = manager.validateProjects(['proj-1', 'proj-2']);

      expect(result.valid).toBe(true);
    });

    it('should fail for unknown project ID', () => {
      mockDbOps.getProjectById.mockReturnValue(undefined);

      const manager = new MultiProjectVectorStoreManager();
      const result = manager.validateProjects(['unknown-id']);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors![0]!.projectId).toBe('unknown-id');
    });

    it('should return valid for empty project list', () => {
      const manager = new MultiProjectVectorStoreManager();
      const result = manager.validateProjects([]);

      expect(result.valid).toBe(true);
    });
  });

  // ==========================================================================
  // Store Loading Tests
  // ==========================================================================

  describe('loadStores', () => {
    it('should load multiple project stores', async () => {
      const project1 = createMockProject('proj-1', 'project-one');
      const project2 = createMockProject('proj-2', 'project-two');

      mockDbOps.getProjectById
        .mockReturnValueOnce(project1)
        .mockReturnValueOnce(project2);

      const store1 = createMockStore([{ id: 'c1', content: 'chunk 1', score: 0.9 }]);
      const store2 = createMockStore([{ id: 'c2', content: 'chunk 2', score: 0.8 }]);

      mockStoreManager.getStore
        .mockResolvedValueOnce(store1)
        .mockResolvedValueOnce(store2);

      const manager = new MultiProjectVectorStoreManager();
      const stores = await manager.loadStores({
        projectIds: ['proj-1', 'proj-2'],
        dimensions: 1024,
      });

      expect(stores.size).toBe(2);
      expect(stores.get('proj-1')).toBe(store1);
      expect(stores.get('proj-2')).toBe(store2);
    });

    it('should report progress per project', async () => {
      const project1 = createMockProject('proj-1', 'project-one');
      const project2 = createMockProject('proj-2', 'project-two');

      // Use mockImplementation to return correct project based on ID
      // This handles both validation calls and loading calls
      mockDbOps.getProjectById.mockImplementation((id: string) => {
        if (id === 'proj-1') return project1;
        if (id === 'proj-2') return project2;
        return undefined;
      });

      // Mock getStore to call the progress callback
      mockStoreManager.getStore.mockImplementation(
        async (_options: unknown, onProgress?: (p: unknown) => void) => {
          onProgress?.({ phase: 'loading', loaded: 10, total: 20 });
          return createMockStore([]);
        }
      );

      const progressCalls: unknown[] = [];
      const manager = new MultiProjectVectorStoreManager();

      await manager.loadStores(
        {
          projectIds: ['proj-1', 'proj-2'],
          dimensions: 1024,
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
      mockStoreManager.getStore.mockResolvedValue(createMockStore([]));

      const manager = new MultiProjectVectorStoreManager();

      expect(manager.hasProjectStore('proj-1')).toBe(false);

      await manager.loadStores({
        projectIds: ['proj-1'],
        dimensions: 1024,
      });

      expect(manager.hasProjectStore('proj-1')).toBe(true);
      expect(manager.getLoadedProjects()).toEqual(['proj-1']);
    });

    it('should throw EmbeddingMismatchError when models mismatch', async () => {
      const project1 = createMockProject('proj-1', 'project-one', {
        embeddingModel: 'BAAI/bge-large-en-v1.5',
      });
      const project2 = createMockProject('proj-2', 'project-two', {
        embeddingModel: 'Xenova/nomic-embed-text-v1.5', // Different!
      });

      mockDbOps.getProjectById
        .mockReturnValueOnce(project1)
        .mockReturnValueOnce(project2);

      const manager = new MultiProjectVectorStoreManager();

      await expect(
        manager.loadStores({
          projectIds: ['proj-1', 'proj-2'],
          dimensions: 1024,
        })
      ).rejects.toThrow(EmbeddingMismatchError);
    });

    it('should throw EmbeddingMismatchError when dimensions mismatch', async () => {
      const project1 = createMockProject('proj-1', 'project-one', {
        embeddingDimensions: 1024,
      });
      const project2 = createMockProject('proj-2', 'project-two', {
        embeddingDimensions: 768, // Different!
      });

      mockDbOps.getProjectById
        .mockReturnValueOnce(project1)
        .mockReturnValueOnce(project2);

      const manager = new MultiProjectVectorStoreManager();

      await expect(
        manager.loadStores({
          projectIds: ['proj-1', 'proj-2'],
          dimensions: 1024,
        })
      ).rejects.toThrow(EmbeddingMismatchError);
    });

    it('should skip validation for single project', async () => {
      const project = createMockProject('proj-1', 'project-one');
      mockDbOps.getProjectById.mockReturnValue(project);
      mockStoreManager.getStore.mockResolvedValue(createMockStore([]));

      const manager = new MultiProjectVectorStoreManager();

      // Should NOT throw - single project means nothing to compare
      await expect(
        manager.loadStores({ projectIds: ['proj-1'], dimensions: 1024 })
      ).resolves.toBeDefined();
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

      const store1 = createMockStore([
        { id: 'c1', content: 'authentication code', score: 0.9 },
      ]);
      const store2 = createMockStore([
        { id: 'c2', content: 'auth middleware', score: 0.85 },
      ]);

      // Return appropriate store based on projectId
      mockStoreManager.getStore.mockImplementation(
        async (options: { projectId: string }) => {
          if (options.projectId === 'proj-1') return store1;
          if (options.projectId === 'proj-2') return store2;
          return undefined;
        }
      );

      mockStoreManager.hasStore.mockReturnValue(true);

      const manager = new MultiProjectVectorStoreManager();
      await manager.loadStores({
        projectIds: ['proj-1', 'proj-2'],
        dimensions: 1024,
      });

      const queryEmbedding = new Array(1024).fill(0.1);
      const results = await manager.search(queryEmbedding, { topK: 5 });

      expect(results.length).toBe(2);
      // Both stores should have been searched
      expect(store1.search).toHaveBeenCalled();
      expect(store2.search).toHaveBeenCalled();
    });

    it('should include projectId and projectName in results', async () => {
      const project = createMockProject('proj-1', 'project-one');
      mockDbOps.getProjectById.mockReturnValue(project);

      const store = createMockStore([
        { id: 'c1', content: 'test content', score: 0.9 },
      ]);
      mockStoreManager.getStore.mockResolvedValue(store);
      mockStoreManager.hasStore.mockReturnValue(true);

      const manager = new MultiProjectVectorStoreManager();
      await manager.loadStores({
        projectIds: ['proj-1'],
        dimensions: 1024,
      });

      const queryEmbedding = new Array(1024).fill(0.1);
      const results = await manager.search(queryEmbedding);

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
      const store1 = createMockStore([
        { id: 'shared-chunk', content: 'shared content', score: 0.9 },
        { id: 'c1-only', content: 'unique to proj-1', score: 0.8 },
      ]);
      const store2 = createMockStore([
        { id: 'shared-chunk', content: 'shared content', score: 0.85 },
        { id: 'c2-only', content: 'unique to proj-2', score: 0.7 },
      ]);

      // Return appropriate store based on projectId
      mockStoreManager.getStore.mockImplementation(
        async (options: { projectId: string }) => {
          if (options.projectId === 'proj-1') return store1;
          if (options.projectId === 'proj-2') return store2;
          return undefined;
        }
      );

      mockStoreManager.hasStore.mockReturnValue(true);

      const manager = new MultiProjectVectorStoreManager();
      await manager.loadStores({
        projectIds: ['proj-1', 'proj-2'],
        dimensions: 1024,
      });

      const queryEmbedding = new Array(1024).fill(0.1);
      const results = await manager.search(queryEmbedding, { topK: 10 });

      // The shared chunk should be boosted by RRF (appears in both lists)
      expect(results.length).toBe(3);
      expect(results[0]!.id).toBe('shared-chunk');
    });

    it('should return empty array when no projects loaded', async () => {
      const manager = new MultiProjectVectorStoreManager();

      const queryEmbedding = new Array(1024).fill(0.1);
      const results = await manager.search(queryEmbedding);

      expect(results).toEqual([]);
    });

    it('should skip RRF for single project (optimization)', async () => {
      const project = createMockProject('proj-1', 'project-one');
      mockDbOps.getProjectById.mockReturnValue(project);

      const store = createMockStore([
        { id: 'c1', content: 'chunk 1', score: 0.9 },
        { id: 'c2', content: 'chunk 2', score: 0.8 },
      ]);
      mockStoreManager.getStore.mockResolvedValue(store);
      mockStoreManager.hasStore.mockReturnValue(true);

      const manager = new MultiProjectVectorStoreManager();
      await manager.loadStores({
        projectIds: ['proj-1'],
        dimensions: 1024,
      });

      const queryEmbedding = new Array(1024).fill(0.1);
      const results = await manager.search(queryEmbedding, { topK: 5 });

      expect(results.length).toBe(2);
      // Original scores should be preserved (no RRF transformation)
      expect(results[0]!.score).toBe(0.9);
      expect(results[1]!.score).toBe(0.8);
    });

    it('should respect topK limit', async () => {
      const project = createMockProject('proj-1', 'project-one');
      mockDbOps.getProjectById.mockReturnValue(project);

      const store = createMockStore([
        { id: 'c1', content: 'chunk 1', score: 0.9 },
        { id: 'c2', content: 'chunk 2', score: 0.8 },
        { id: 'c3', content: 'chunk 3', score: 0.7 },
      ]);
      mockStoreManager.getStore.mockResolvedValue(store);
      mockStoreManager.hasStore.mockReturnValue(true);

      const manager = new MultiProjectVectorStoreManager();
      await manager.loadStores({
        projectIds: ['proj-1'],
        dimensions: 1024,
      });

      const queryEmbedding = new Array(1024).fill(0.1);
      const results = await manager.search(queryEmbedding, { topK: 2 });

      expect(results.length).toBe(2);
    });

    it('should apply file type and language filters', async () => {
      const project = createMockProject('proj-1', 'project-one');
      mockDbOps.getProjectById.mockReturnValue(project);

      const store = createMockStore([]);
      mockStoreManager.getStore.mockResolvedValue(store);
      mockStoreManager.hasStore.mockReturnValue(true);

      const manager = new MultiProjectVectorStoreManager();
      await manager.loadStores({
        projectIds: ['proj-1'],
        dimensions: 1024,
      });

      const queryEmbedding = new Array(1024).fill(0.1);
      await manager.search(queryEmbedding, {
        fileType: 'code',
        language: 'typescript',
      });

      // Verify filter was passed to store.search
      expect(store.search).toHaveBeenCalledWith(
        queryEmbedding,
        expect.objectContaining({
          filter: { fileType: 'code', language: 'typescript' },
        })
      );
    });

    it('should handle external cache invalidation gracefully', async () => {
      const project1 = createMockProject('proj-1', 'project-one');
      const project2 = createMockProject('proj-2', 'project-two');

      mockDbOps.getProjectById.mockImplementation((id: string) => {
        if (id === 'proj-1') return project1;
        if (id === 'proj-2') return project2;
        return undefined;
      });

      const store1 = createMockStore([
        { id: 'c1', content: 'chunk 1', score: 0.9 },
      ]);
      const store2 = createMockStore([
        { id: 'c2', content: 'chunk 2', score: 0.8 },
      ]);

      mockStoreManager.getStore.mockImplementation(
        async (options: { projectId: string }) => {
          if (options.projectId === 'proj-1') return store1;
          if (options.projectId === 'proj-2') return store2;
          return undefined;
        }
      );

      const manager = new MultiProjectVectorStoreManager();
      await manager.loadStores({
        projectIds: ['proj-1', 'proj-2'],
        dimensions: 1024,
      });

      // Simulate external invalidation - proj-1's store was cleared
      mockStoreManager.hasStore.mockImplementation((id: string) => id !== 'proj-1');

      const queryEmbedding = new Array(1024).fill(0.1);
      const results = await manager.search(queryEmbedding);

      // Should only get results from proj-2 (proj-1 was skipped due to invalidation)
      expect(results.length).toBe(1);
      expect(results[0]!.projectId).toBe('proj-2');
    });

    it('should handle concurrent search requests', async () => {
      const project = createMockProject('proj-1', 'project-one');
      mockDbOps.getProjectById.mockReturnValue(project);

      const store = createMockStore([
        { id: 'c1', content: 'chunk 1', score: 0.9 },
      ]);
      mockStoreManager.getStore.mockResolvedValue(store);
      mockStoreManager.hasStore.mockReturnValue(true);

      const manager = new MultiProjectVectorStoreManager();
      await manager.loadStores({
        projectIds: ['proj-1'],
        dimensions: 1024,
      });

      const queryEmbedding = new Array(1024).fill(0.1);

      // Run multiple searches concurrently
      const [results1, results2, results3] = await Promise.all([
        manager.search(queryEmbedding),
        manager.search(queryEmbedding),
        manager.search(queryEmbedding),
      ]);

      // All should complete successfully with same results
      expect(results1.length).toBe(1);
      expect(results2.length).toBe(1);
      expect(results3.length).toBe(1);
      expect(results1[0]!.id).toBe(results2[0]!.id);
      expect(results2[0]!.id).toBe(results3[0]!.id);
    });

    it('should skip stores that fail during getStore in search', async () => {
      const project1 = createMockProject('proj-1', 'project-one');
      const project2 = createMockProject('proj-2', 'project-two');

      mockDbOps.getProjectById.mockImplementation((id: string) => {
        if (id === 'proj-1') return project1;
        if (id === 'proj-2') return project2;
        return undefined;
      });

      const store2 = createMockStore([
        { id: 'c2', content: 'chunk 2', score: 0.8 },
      ]);

      // First project's store throws, second succeeds
      mockStoreManager.getStore.mockImplementation(
        async (options: { projectId: string }) => {
          if (options.projectId === 'proj-1') {
            throw new Error('Store rebuild failed');
          }
          return store2;
        }
      );

      mockStoreManager.hasStore.mockReturnValue(true);

      const manager = new MultiProjectVectorStoreManager();

      // Load stores - proj-1 will fail
      await expect(
        manager.loadStores({
          projectIds: ['proj-1', 'proj-2'],
          dimensions: 1024,
        })
      ).rejects.toThrow('Store rebuild failed');
    });
  });

  // ==========================================================================
  // State Management Tests
  // ==========================================================================

  describe('state management', () => {
    it('should clear loaded projects', async () => {
      const project = createMockProject('proj-1', 'project-one');
      mockDbOps.getProjectById.mockReturnValue(project);
      mockStoreManager.getStore.mockResolvedValue(createMockStore([]));

      const manager = new MultiProjectVectorStoreManager();
      await manager.loadStores({
        projectIds: ['proj-1'],
        dimensions: 1024,
      });

      expect(manager.loadedProjectCount).toBe(1);

      manager.clearLoadedProjects();

      expect(manager.loadedProjectCount).toBe(0);
      expect(manager.hasProjectStore('proj-1')).toBe(false);
    });

    it('should remove specific project', async () => {
      const project1 = createMockProject('proj-1', 'project-one');
      const project2 = createMockProject('proj-2', 'project-two');

      mockDbOps.getProjectById
        .mockReturnValueOnce(project1)
        .mockReturnValueOnce(project2);

      mockStoreManager.getStore.mockResolvedValue(createMockStore([]));

      const manager = new MultiProjectVectorStoreManager();
      await manager.loadStores({
        projectIds: ['proj-1', 'proj-2'],
        dimensions: 1024,
      });

      expect(manager.loadedProjectCount).toBe(2);

      const removed = manager.removeProject('proj-1');

      expect(removed).toBe(true);
      expect(manager.loadedProjectCount).toBe(1);
      expect(manager.hasProjectStore('proj-1')).toBe(false);
      expect(manager.hasProjectStore('proj-2')).toBe(true);
    });
  });

  // ==========================================================================
  // Singleton Tests
  // ==========================================================================

  describe('singleton functions', () => {
    beforeEach(() => {
      resetMultiProjectVectorStoreManager();
    });

    it('should return singleton instance', () => {
      const manager1 = getMultiProjectVectorStoreManager();
      const manager2 = getMultiProjectVectorStoreManager();
      expect(manager1).toBe(manager2);
    });

    it('should reset singleton', () => {
      const manager1 = getMultiProjectVectorStoreManager();
      resetMultiProjectVectorStoreManager();
      const manager2 = getMultiProjectVectorStoreManager();
      expect(manager1).not.toBe(manager2);
    });
  });
});
