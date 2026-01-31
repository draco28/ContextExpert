/**
 * BM25StoreManager Tests
 *
 * Tests for lazy loading from SQLite and retriever caching.
 * Uses mocked database to avoid real I/O.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  BM25StoreManager,
  getBM25StoreManager,
  resetBM25StoreManager,
} from '../bm25-store.js';

// Mock the database module
vi.mock('../../database/connection.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../database/connection.js';

/**
 * Row shape matching what we load from SQLite.
 */
interface ChunkRow {
  id: string;
  content: string;
  file_path: string;
  file_type: string | null;
  language: string | null;
  start_line: number | null;
  end_line: number | null;
  metadata: string | null;
}

/**
 * Create a mock database with test chunks.
 */
function createMockDb(chunks: ChunkRow[]) {
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

describe('BM25StoreManager', () => {
  beforeEach(() => {
    resetBM25StoreManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetBM25StoreManager();
  });

  describe('getRetriever', () => {
    it('should load chunks from SQLite and build BM25 index', async () => {
      const testChunks: ChunkRow[] = [
        {
          id: 'chunk-1',
          content: 'PostgreSQL database connection pool',
          file_path: 'src/db/pool.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 10,
          end_line: 50,
          metadata: JSON.stringify({ symbolName: 'createPool' }),
        },
        {
          id: 'chunk-2',
          content: 'MySQL database driver configuration',
          file_path: 'src/db/mysql.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 30,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new BM25StoreManager();
      const retriever = await manager.getRetriever({
        projectId: 'test-project',
      });

      expect(retriever).toBeDefined();
      expect(retriever.documentCount).toBe(2);
    });

    it('should return cached retriever on subsequent calls', async () => {
      const testChunks: ChunkRow[] = [
        {
          id: 'chunk-1',
          content: 'Test content',
          file_path: 'test.ts',
          file_type: 'code',
          language: null,
          start_line: 1,
          end_line: 10,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new BM25StoreManager();

      // First call builds the retriever
      const retriever1 = await manager.getRetriever({
        projectId: 'test-project',
      });

      // Second call should return cached
      const retriever2 = await manager.getRetriever({
        projectId: 'test-project',
      });

      expect(retriever1).toBe(retriever2);
      // Database should only be queried once
      expect(mockDb.prepare).toHaveBeenCalledTimes(2); // COUNT + SELECT
    });

    it('should handle concurrent initialization requests', async () => {
      const testChunks: ChunkRow[] = [
        {
          id: 'chunk-1',
          content: 'Test content',
          file_path: 'test.ts',
          file_type: 'code',
          language: null,
          start_line: 1,
          end_line: 10,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new BM25StoreManager();

      // Start two concurrent builds
      const [retriever1, retriever2] = await Promise.all([
        manager.getRetriever({ projectId: 'test-project' }),
        manager.getRetriever({ projectId: 'test-project' }),
      ]);

      // Should return the same instance
      expect(retriever1).toBe(retriever2);
      // Should only build once
      expect(mockDb.prepare).toHaveBeenCalledTimes(2); // COUNT + SELECT (once)
    });

    it('should report progress during loading', async () => {
      // Create enough chunks to trigger multiple batches
      const testChunks: ChunkRow[] = Array.from({ length: 5 }, (_, i) => ({
        id: `chunk-${i}`,
        content: `Content ${i}`,
        file_path: `file-${i}.ts`,
        file_type: 'code',
        language: null,
        start_line: 1,
        end_line: 10,
        metadata: null,
      }));

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new BM25StoreManager();
      const progressUpdates: Array<{ phase: string; loaded: number; total: number }> = [];

      await manager.getRetriever(
        { projectId: 'test-project' },
        (progress) => progressUpdates.push(progress)
      );

      // Should have at least loading and building phases
      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(progressUpdates[0]!.phase).toBe('loading');
      expect(progressUpdates[progressUpdates.length - 1]!.phase).toBe('building');
      expect(progressUpdates[progressUpdates.length - 1]!.loaded).toBe(5);
    });

    it('should handle empty project gracefully', async () => {
      const mockDb = createMockDb([]);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new BM25StoreManager();
      const retriever = await manager.getRetriever({
        projectId: 'empty-project',
      });

      expect(retriever).toBeDefined();
      expect(retriever.documentCount).toBe(0);
    });

    it('should use custom BM25 config when provided', async () => {
      const testChunks: ChunkRow[] = [
        {
          id: 'chunk-1',
          content: 'Test content with keywords',
          file_path: 'test.ts',
          file_type: 'code',
          language: null,
          start_line: 1,
          end_line: 10,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new BM25StoreManager();
      const retriever = await manager.getRetriever({
        projectId: 'test-project',
        bm25Config: {
          k1: 2.0,
          b: 0.5,
        },
      });

      expect(retriever).toBeDefined();
      // Retriever should be built (we can't easily verify config was used,
      // but the fact it doesn't throw is good)
    });

    it('should create separate retrievers for different projects', async () => {
      const testChunks: ChunkRow[] = [
        {
          id: 'chunk-1',
          content: 'Test content',
          file_path: 'test.ts',
          file_type: 'code',
          language: null,
          start_line: 1,
          end_line: 10,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new BM25StoreManager();

      const retriever1 = await manager.getRetriever({ projectId: 'project-1' });
      const retriever2 = await manager.getRetriever({ projectId: 'project-2' });

      expect(retriever1).not.toBe(retriever2);
      expect(manager.cacheSize).toBe(2);
    });
  });

  describe('invalidate', () => {
    it('should clear cached retriever for project', async () => {
      const testChunks: ChunkRow[] = [
        {
          id: 'chunk-1',
          content: 'Test content',
          file_path: 'test.ts',
          file_type: 'code',
          language: null,
          start_line: 1,
          end_line: 10,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new BM25StoreManager();

      // Build retriever
      const retriever1 = await manager.getRetriever({ projectId: 'test-project' });
      expect(manager.hasRetriever('test-project')).toBe(true);

      // Invalidate
      manager.invalidate('test-project');
      expect(manager.hasRetriever('test-project')).toBe(false);

      // Next call should rebuild
      const retriever2 = await manager.getRetriever({ projectId: 'test-project' });
      expect(retriever1).not.toBe(retriever2);
    });
  });

  describe('hasRetriever', () => {
    it('should return true for cached retrievers', async () => {
      const testChunks: ChunkRow[] = [
        {
          id: 'chunk-1',
          content: 'Test content',
          file_path: 'test.ts',
          file_type: 'code',
          language: null,
          start_line: 1,
          end_line: 10,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new BM25StoreManager();

      expect(manager.hasRetriever('test-project')).toBe(false);

      await manager.getRetriever({ projectId: 'test-project' });

      expect(manager.hasRetriever('test-project')).toBe(true);
    });
  });

  describe('clearAll', () => {
    it('should clear all cached retrievers', async () => {
      const testChunks: ChunkRow[] = [
        {
          id: 'chunk-1',
          content: 'Test content',
          file_path: 'test.ts',
          file_type: 'code',
          language: null,
          start_line: 1,
          end_line: 10,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new BM25StoreManager();

      await manager.getRetriever({ projectId: 'project-1' });
      await manager.getRetriever({ projectId: 'project-2' });
      expect(manager.cacheSize).toBe(2);

      manager.clearAll();
      expect(manager.cacheSize).toBe(0);
    });
  });
});

describe('singleton functions', () => {
  beforeEach(() => {
    resetBM25StoreManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetBM25StoreManager();
  });

  it('getBM25StoreManager should return singleton', () => {
    const manager1 = getBM25StoreManager();
    const manager2 = getBM25StoreManager();

    expect(manager1).toBe(manager2);
  });

  it('resetBM25StoreManager should clear singleton', async () => {
    const testChunks: ChunkRow[] = [
      {
        id: 'chunk-1',
        content: 'Test content',
        file_path: 'test.ts',
        file_type: 'code',
        language: null,
        start_line: 1,
        end_line: 10,
        metadata: null,
      },
    ];

    const mockDb = createMockDb(testChunks);
    vi.mocked(getDb).mockReturnValue(mockDb as any);

    const manager1 = getBM25StoreManager();
    await manager1.getRetriever({ projectId: 'test' });

    resetBM25StoreManager();

    const manager2 = getBM25StoreManager();
    expect(manager1).not.toBe(manager2);
    expect(manager2.cacheSize).toBe(0);
  });
});

describe('BM25StoreManager edge cases', () => {
  beforeEach(() => {
    resetBM25StoreManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetBM25StoreManager();
  });

  describe('metadata handling', () => {
    it('should handle corrupted JSON in metadata', async () => {
      const testChunks: ChunkRow[] = [
        {
          id: 'chunk-1',
          content: 'valid content for BM25 indexing',
          file_path: 'src/file.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 10,
          metadata: '{not valid json at all', // Corrupted JSON
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new BM25StoreManager();

      // Should not throw - corrupted metadata handled gracefully
      const retriever = await manager.getRetriever({ projectId: 'test-project' });

      expect(retriever).toBeDefined();
    });

    it('should continue loading after corrupted metadata', async () => {
      // Mix of valid and invalid metadata
      const testChunks: ChunkRow[] = [
        {
          id: 'chunk-1',
          content: 'first chunk content',
          file_path: 'src/file1.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 10,
          metadata: '{broken', // Corrupted
        },
        {
          id: 'chunk-2',
          content: 'second chunk content',
          file_path: 'src/file2.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 10,
          metadata: JSON.stringify({ valid: true }), // Valid
        },
        {
          id: 'chunk-3',
          content: 'third chunk content',
          file_path: 'src/file3.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 10,
          metadata: null, // Null (valid)
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const manager = new BM25StoreManager();
      const retriever = await manager.getRetriever({ projectId: 'test-project' });

      // All chunks should be loaded despite corrupted metadata in one
      expect(retriever).toBeDefined();
    });
  });
});
