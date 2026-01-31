/**
 * VectorStoreManager Tests
 *
 * Tests for lazy loading from SQLite and store caching.
 * Uses mocked database to avoid real I/O.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  VectorStoreManager,
  getVectorStoreManager,
  resetVectorStoreManager,
} from '../store.js';
import { blobToEmbedding, embeddingToBlob } from '../../database/schema.js';

// Mock the database module
vi.mock('../../database/connection.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../database/connection.js';

/**
 * Create a mock database with prepared statements.
 */
function createMockDb(chunks: Array<{
  id: string;
  content: string;
  embedding: Buffer;
  file_path: string;
  file_type: string | null;
  language: string | null;
  start_line: number | null;
  end_line: number | null;
  metadata: string | null;
}>) {
  const mockPrepare = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('COUNT(*)')) {
      return {
        get: vi.fn().mockReturnValue({ count: chunks.length }),
      };
    }
    if (sql.includes('SELECT id, content')) {
      return {
        all: vi.fn().mockImplementation(
          (_projectId: string, limit: number, offset: number) => {
            return chunks.slice(offset, offset + limit);
          }
        ),
      };
    }
    return { get: vi.fn(), all: vi.fn() };
  });

  return { prepare: mockPrepare };
}

/**
 * Create a test embedding as a Buffer (simulating SQLite BLOB).
 */
function createTestEmbedding(dimensions: number, seed: number = 0): Buffer {
  const embedding = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    embedding[i] = Math.sin(seed + i) * 0.5;
  }
  return embeddingToBlob(embedding);
}

describe('VectorStoreManager', () => {
  beforeEach(() => {
    resetVectorStoreManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetVectorStoreManager();
  });

  describe('getStore', () => {
    it('should load chunks from SQLite and build store', async () => {
      const testChunks = [
        {
          id: 'chunk-1',
          content: 'function hello() { return "world"; }',
          embedding: createTestEmbedding(1024, 1),
          file_path: 'src/hello.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 3,
          metadata: JSON.stringify({ symbolName: 'hello' }),
        },
        {
          id: 'chunk-2',
          content: '# Documentation\nThis is a test.',
          embedding: createTestEmbedding(1024, 2),
          file_path: 'docs/README.md',
          file_type: 'docs',
          language: null,
          start_line: 1,
          end_line: 2,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new VectorStoreManager();
      const store = await manager.getStore({
        projectId: 'test-project',
        dimensions: 1024,
      });

      expect(store).toBeDefined();
      const count = await store.count();
      expect(count).toBe(2);
    });

    it('should return cached store on subsequent calls', async () => {
      const testChunks = [
        {
          id: 'chunk-1',
          content: 'test',
          embedding: createTestEmbedding(1024, 1),
          file_path: 'test.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 1,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new VectorStoreManager();

      const store1 = await manager.getStore({
        projectId: 'test-project',
        dimensions: 1024,
      });

      const store2 = await manager.getStore({
        projectId: 'test-project',
        dimensions: 1024,
      });

      // Should be the exact same instance
      expect(store1).toBe(store2);

      // Database should only be queried once
      expect(mockDb.prepare).toHaveBeenCalledTimes(2); // COUNT + SELECT
    });

    it('should handle concurrent initialization requests', async () => {
      const testChunks = [
        {
          id: 'chunk-1',
          content: 'test',
          embedding: createTestEmbedding(1024, 1),
          file_path: 'test.ts',
          file_type: 'code',
          language: null,
          start_line: 1,
          end_line: 1,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new VectorStoreManager();

      // Start two requests concurrently
      const [store1, store2] = await Promise.all([
        manager.getStore({ projectId: 'test-project', dimensions: 1024 }),
        manager.getStore({ projectId: 'test-project', dimensions: 1024 }),
      ]);

      // Both should get the same store instance
      expect(store1).toBe(store2);
    });

    it('should report progress during loading', async () => {
      // Create 2500 chunks to test batch loading
      const testChunks = Array.from({ length: 2500 }, (_, i) => ({
        id: `chunk-${i}`,
        content: `Content ${i}`,
        embedding: createTestEmbedding(1024, i),
        file_path: `file-${i}.ts`,
        file_type: 'code',
        language: 'typescript',
        start_line: 1,
        end_line: 1,
        metadata: null,
      }));

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new VectorStoreManager();
      const progressCalls: Array<{ phase: string; loaded: number; total: number }> = [];

      await manager.getStore(
        { projectId: 'test-project', dimensions: 1024 },
        (progress) => progressCalls.push(progress)
      );

      // Should have progress calls for batch loading
      expect(progressCalls.length).toBeGreaterThan(0);
      expect(progressCalls[0]!.phase).toBe('loading');
      expect(progressCalls[0]!.total).toBe(2500);

      // Last call should be 'building' phase
      const lastCall = progressCalls[progressCalls.length - 1]!;
      expect(lastCall.phase).toBe('building');
      expect(lastCall.loaded).toBe(2500);
    });

    it('should handle empty project gracefully', async () => {
      const mockDb = createMockDb([]);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new VectorStoreManager();
      const store = await manager.getStore({
        projectId: 'empty-project',
        dimensions: 1024,
      });

      const count = await store.count();
      expect(count).toBe(0);
    });

    it('should use HNSW index by default', async () => {
      const testChunks = [
        {
          id: 'chunk-1',
          content: 'test',
          embedding: createTestEmbedding(1024, 1),
          file_path: 'test.ts',
          file_type: 'code',
          language: null,
          start_line: 1,
          end_line: 1,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new VectorStoreManager();
      const store = await manager.getStore({
        projectId: 'test-project',
        dimensions: 1024,
      });

      expect(store.getIndexType()).toBe('hnsw');
    });

    it('should allow brute-force index when specified', async () => {
      const testChunks = [
        {
          id: 'chunk-1',
          content: 'test',
          embedding: createTestEmbedding(1024, 1),
          file_path: 'test.ts',
          file_type: 'code',
          language: null,
          start_line: 1,
          end_line: 1,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new VectorStoreManager();
      const store = await manager.getStore({
        projectId: 'test-project',
        dimensions: 1024,
        useHNSW: false,
      });

      expect(store.getIndexType()).toBe('brute-force');
    });
  });

  describe('invalidate', () => {
    it('should clear cached store for project', async () => {
      const testChunks = [
        {
          id: 'chunk-1',
          content: 'test',
          embedding: createTestEmbedding(1024, 1),
          file_path: 'test.ts',
          file_type: 'code',
          language: null,
          start_line: 1,
          end_line: 1,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new VectorStoreManager();

      const store1 = await manager.getStore({
        projectId: 'test-project',
        dimensions: 1024,
      });

      manager.invalidate('test-project');

      const store2 = await manager.getStore({
        projectId: 'test-project',
        dimensions: 1024,
      });

      // Should be different instances after invalidation
      expect(store1).not.toBe(store2);
    });
  });

  describe('hasStore', () => {
    it('should return true for cached stores', async () => {
      const testChunks = [
        {
          id: 'chunk-1',
          content: 'test',
          embedding: createTestEmbedding(1024, 1),
          file_path: 'test.ts',
          file_type: 'code',
          language: null,
          start_line: 1,
          end_line: 1,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new VectorStoreManager();

      expect(manager.hasStore('test-project')).toBe(false);

      await manager.getStore({
        projectId: 'test-project',
        dimensions: 1024,
      });

      expect(manager.hasStore('test-project')).toBe(true);
    });
  });
});

describe('blobToEmbedding / embeddingToBlob', () => {
  it('should round-trip Float32Array correctly', () => {
    const original = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
    const blob = embeddingToBlob(original);
    const restored = blobToEmbedding(blob);

    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i]!, 5);
    }
  });

  it('should handle 1024-dimension embeddings', () => {
    const original = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      original[i] = Math.random() - 0.5;
    }

    const blob = embeddingToBlob(original);
    const restored = blobToEmbedding(blob);

    expect(restored.length).toBe(1024);
    expect(blob.length).toBe(1024 * 4); // 4 bytes per float
  });
});

describe('singleton functions', () => {
  beforeEach(() => {
    resetVectorStoreManager();
  });

  afterEach(() => {
    resetVectorStoreManager();
  });

  it('getVectorStoreManager should return singleton', () => {
    const manager1 = getVectorStoreManager();
    const manager2 = getVectorStoreManager();
    expect(manager1).toBe(manager2);
  });

  it('resetVectorStoreManager should clear singleton', () => {
    const manager1 = getVectorStoreManager();
    resetVectorStoreManager();
    const manager2 = getVectorStoreManager();
    expect(manager1).not.toBe(manager2);
  });
});

describe('VectorStoreManager edge cases', () => {
  beforeEach(() => {
    resetVectorStoreManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetVectorStoreManager();
  });

  describe('metadata handling', () => {
    it('should handle corrupted JSON in metadata', async () => {
      const testChunks = [
        {
          id: 'chunk-1',
          content: 'valid content',
          embedding: createTestEmbedding(1024, 1),
          file_path: 'src/file.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 10,
          metadata: '{invalid json', // Corrupted JSON
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new VectorStoreManager();

      // Should not throw - corrupted metadata is handled gracefully
      const store = await manager.getStore({
        projectId: 'test-project',
        dimensions: 1024,
      });

      expect(store).toBeDefined();
    });

    it('should handle null metadata fields', async () => {
      const testChunks = [
        {
          id: 'chunk-1',
          content: 'content',
          embedding: createTestEmbedding(1024, 1),
          file_path: 'src/file.ts',
          file_type: null, // All optional fields are null
          language: null,
          start_line: null,
          end_line: null,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new VectorStoreManager();

      const store = await manager.getStore({
        projectId: 'test-project',
        dimensions: 1024,
      });

      expect(store).toBeDefined();
    });

    it('should handle empty string metadata', async () => {
      const testChunks = [
        {
          id: 'chunk-1',
          content: 'content',
          embedding: createTestEmbedding(1024, 1),
          file_path: 'src/file.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 10,
          metadata: '', // Empty string instead of null or JSON
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new VectorStoreManager();

      const store = await manager.getStore({
        projectId: 'test-project',
        dimensions: 1024,
      });

      expect(store).toBeDefined();
    });
  });

  describe('embedding dimension validation', () => {
    it('should throw on embedding dimension mismatch', async () => {
      // Chunk has 768-dimension embedding, but we expect 1024
      const testChunks = [
        {
          id: 'chunk-1',
          content: 'content',
          embedding: createTestEmbedding(768, 1), // Wrong dimension!
          file_path: 'src/file.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 10,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new VectorStoreManager();

      await expect(
        manager.getStore({
          projectId: 'test-project',
          dimensions: 1024, // Expecting 1024 but chunks have 768
        })
      ).rejects.toThrow(/dimension mismatch/i);
    });

    it('should include helpful message in dimension error', async () => {
      const testChunks = [
        {
          id: 'chunk-1',
          content: 'content',
          embedding: createTestEmbedding(768, 1),
          file_path: 'src/file.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 10,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new VectorStoreManager();

      try {
        await manager.getStore({
          projectId: 'test-project',
          dimensions: 1024,
        });
        expect.fail('Should have thrown');
      } catch (err) {
        const message = (err as Error).message;
        // Should mention both expected and actual dimensions
        expect(message).toMatch(/768/);
        expect(message).toMatch(/1024/);
      }
    });
  });
});
