/**
 * BM25SearchService Tests
 *
 * Tests for the BM25 search service wrapper.
 * Uses mocked database to test in isolation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { BM25SearchService, createBM25SearchService } from '../bm25-retriever.js';
import { resetBM25StoreManager } from '../bm25-store.js';

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

describe('BM25SearchService', () => {
  beforeEach(() => {
    resetBM25StoreManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetBM25StoreManager();
  });

  describe('search', () => {
    it('should return results sorted by BM25 score', async () => {
      const testChunks: ChunkRow[] = [
        {
          id: 'chunk-1',
          content: 'PostgreSQL database connection pool configuration',
          file_path: 'src/db/postgres.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 10,
          end_line: 50,
          metadata: JSON.stringify({ symbolName: 'createPool' }),
        },
        {
          id: 'chunk-2',
          content: 'MySQL database driver setup',
          file_path: 'src/db/mysql.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 30,
          metadata: null,
        },
        {
          id: 'chunk-3',
          content: 'PostgreSQL specific query optimizer',
          file_path: 'src/db/optimizer.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 5,
          end_line: 25,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const service = createBM25SearchService('test-project', {
        top_k: 10,
        rerank: false,
      });

      // Search for PostgreSQL - should rank PostgreSQL chunks higher
      const results = await service.search('PostgreSQL');

      expect(results.length).toBeGreaterThan(0);

      // Results should have scores in descending order
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
      }

      // PostgreSQL chunks should rank higher than MySQL
      const postgresResults = results.filter((r) =>
        r.content.includes('PostgreSQL')
      );
      expect(postgresResults.length).toBeGreaterThan(0);
    });

    it('should respect topK limit', async () => {
      const testChunks: ChunkRow[] = Array.from({ length: 20 }, (_, i) => ({
        id: `chunk-${i}`,
        content: `Database content ${i} with keywords`,
        file_path: `file-${i}.ts`,
        file_type: 'code',
        language: 'typescript',
        start_line: 1,
        end_line: 10,
        metadata: null,
      }));

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const service = createBM25SearchService('test-project', {
        top_k: 10,
        rerank: false,
      });

      const results = await service.search('database content', { topK: 5 });

      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('should include correct result metadata', async () => {
      const testChunks: ChunkRow[] = [
        {
          id: 'chunk-1',
          content: 'Specific function implementation for testing',
          file_path: 'src/utils/helper.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 42,
          end_line: 67,
          metadata: JSON.stringify({ symbolName: 'helper', symbolType: 'function' }),
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const service = createBM25SearchService('test-project', {
        top_k: 10,
        rerank: false,
      });

      const results = await service.search('function implementation testing');

      expect(results.length).toBe(1);
      const result = results[0]!;

      expect(result.id).toBe('chunk-1');
      expect(result.filePath).toBe('src/utils/helper.ts');
      expect(result.fileType).toBe('code');
      expect(result.language).toBe('typescript');
      expect(result.lineRange.start).toBe(42);
      expect(result.lineRange.end).toBe(67);
      expect(result.score).toBeGreaterThan(0);
      expect(result.metadata.symbolName).toBe('helper');
    });

    it('should handle empty search results', async () => {
      const mockDb = createMockDb([]);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const service = createBM25SearchService('empty-project', {
        top_k: 10,
        rerank: false,
      });

      const results = await service.search('anything');

      expect(results).toEqual([]);
    });

    it('should filter by fileType', async () => {
      const testChunks: ChunkRow[] = [
        {
          id: 'chunk-1',
          content: 'Authentication code implementation',
          file_path: 'src/auth.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 50,
          metadata: null,
        },
        {
          id: 'chunk-2',
          content: 'Authentication documentation guide',
          file_path: 'docs/auth.md',
          file_type: 'docs',
          language: null,
          start_line: 1,
          end_line: 100,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const service = createBM25SearchService('test-project', {
        top_k: 10,
        rerank: false,
      });

      // Filter to only code
      const results = await service.search('authentication', {
        fileType: 'code',
      });

      expect(results.length).toBe(1);
      expect(results[0]!.fileType).toBe('code');
    });

    it('should filter by language', async () => {
      const testChunks: ChunkRow[] = [
        {
          id: 'chunk-1',
          content: 'function handleRequest implementation',
          file_path: 'src/handler.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 50,
          metadata: null,
        },
        {
          id: 'chunk-2',
          content: 'function handleRequest implementation',
          file_path: 'src/handler.py',
          file_type: 'code',
          language: 'python',
          start_line: 1,
          end_line: 50,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const service = createBM25SearchService('test-project', {
        top_k: 10,
        rerank: false,
      });

      // Filter to only Python
      const results = await service.search('handleRequest', {
        language: 'python',
      });

      expect(results.length).toBe(1);
      expect(results[0]!.language).toBe('python');
    });

    it('should filter by single projectId', async () => {
      const testChunks: ChunkRow[] = [
        {
          id: 'chunk-1',
          content: 'Database authentication handler',
          file_path: 'src/auth.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 50,
          metadata: JSON.stringify({ projectId: 'project-alpha' }),
        },
        {
          id: 'chunk-2',
          content: 'Database connection handler',
          file_path: 'src/db.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 50,
          metadata: JSON.stringify({ projectId: 'project-beta' }),
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const service = createBM25SearchService('test-project', {
        top_k: 10,
        rerank: false,
      });

      // Filter to only project-alpha
      const results = await service.search('database', {
        projectIds: ['project-alpha'],
      });

      expect(results.length).toBe(1);
      expect(results[0]!.metadata.projectId).toBe('project-alpha');
    });

    it('should filter by multiple projectIds (OR logic)', async () => {
      const testChunks: ChunkRow[] = [
        {
          id: 'chunk-1',
          content: 'Database handler for alpha',
          file_path: 'src/alpha.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 50,
          metadata: JSON.stringify({ projectId: 'project-alpha' }),
        },
        {
          id: 'chunk-2',
          content: 'Database handler for beta',
          file_path: 'src/beta.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 50,
          metadata: JSON.stringify({ projectId: 'project-beta' }),
        },
        {
          id: 'chunk-3',
          content: 'Database handler for gamma',
          file_path: 'src/gamma.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 50,
          metadata: JSON.stringify({ projectId: 'project-gamma' }),
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const service = createBM25SearchService('test-project', {
        top_k: 10,
        rerank: false,
      });

      // Filter to alpha OR beta (should exclude gamma)
      const results = await service.search('database handler', {
        projectIds: ['project-alpha', 'project-beta'],
      });

      expect(results.length).toBe(2);
      const projectIds = results.map((r) => r.metadata.projectId);
      expect(projectIds).toContain('project-alpha');
      expect(projectIds).toContain('project-beta');
      expect(projectIds).not.toContain('project-gamma');
    });

    it('should exclude chunks without projectId when filter is applied', async () => {
      const testChunks: ChunkRow[] = [
        {
          id: 'chunk-1',
          content: 'Database handler with project',
          file_path: 'src/with-project.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 50,
          metadata: JSON.stringify({ projectId: 'project-alpha' }),
        },
        {
          id: 'chunk-2',
          content: 'Database handler without project',
          file_path: 'src/no-project.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 50,
          metadata: null, // No projectId
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const service = createBM25SearchService('test-project', {
        top_k: 10,
        rerank: false,
      });

      // Filter should exclude chunk without projectId
      const results = await service.search('database handler', {
        projectIds: ['project-alpha'],
      });

      expect(results.length).toBe(1);
      expect(results[0]!.id).toBe('chunk-1');
    });

    it('should filter by minScore', async () => {
      const testChunks: ChunkRow[] = [
        {
          id: 'chunk-1',
          content: 'PostgreSQL PostgreSQL PostgreSQL database',
          file_path: 'high-match.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 10,
          metadata: null,
        },
        {
          id: 'chunk-2',
          content: 'Some other content with unrelated keywords',
          file_path: 'low-match.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 10,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const service = createBM25SearchService('test-project', {
        top_k: 10,
        rerank: false,
      });

      // High minScore should filter out low-scoring results
      const allResults = await service.search('PostgreSQL');
      const filteredResults = await service.search('PostgreSQL', {
        minScore: allResults[0]!.score * 0.9, // 90% of top score
      });

      expect(filteredResults.length).toBeLessThanOrEqual(allResults.length);
      // All filtered results should meet the threshold
      for (const result of filteredResults) {
        expect(result.score).toBeGreaterThanOrEqual(allResults[0]!.score * 0.9);
      }
    });
  });

  describe('lazy initialization', () => {
    it('should only build index on first search', async () => {
      const testChunks: ChunkRow[] = [
        {
          id: 'chunk-1',
          content: 'test content',
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

      const service = createBM25SearchService('test-project', {
        top_k: 10,
        rerank: false,
      });

      // Not initialized yet
      expect(service.isInitialized()).toBe(false);

      // First search triggers initialization
      await service.search('test');
      expect(service.isInitialized()).toBe(true);

      // Database should be queried
      expect(mockDb.prepare).toHaveBeenCalled();
    });

    it('should reuse retriever across searches', async () => {
      const testChunks: ChunkRow[] = [
        {
          id: 'chunk-1',
          content: 'test content with keywords',
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

      const service = createBM25SearchService('test-project', {
        top_k: 10,
        rerank: false,
      });

      // Multiple searches
      await service.search('query 1');
      const callsAfterFirst = mockDb.prepare.mock.calls.length;

      await service.search('query 2');
      const callsAfterSecond = mockDb.prepare.mock.calls.length;

      // Should not call prepare again (retriever is cached)
      expect(callsAfterSecond).toBe(callsAfterFirst);
    });
  });

  describe('getChunkCount', () => {
    it('should return the number of indexed chunks', async () => {
      const testChunks: ChunkRow[] = Array.from({ length: 15 }, (_, i) => ({
        id: `chunk-${i}`,
        content: `Content ${i}`,
        file_path: `file-${i}.ts`,
        file_type: 'code',
        language: null,
        start_line: 1,
        end_line: 1,
        metadata: null,
      }));

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const service = createBM25SearchService('test-project', {
        top_k: 10,
        rerank: false,
      });

      const count = await service.getChunkCount();
      expect(count).toBe(15);
    });
  });

  describe('getProjectId', () => {
    it('should return the project ID', () => {
      const service = createBM25SearchService('my-project-123', {
        top_k: 10,
        rerank: false,
      });

      expect(service.getProjectId()).toBe('my-project-123');
    });
  });
});

describe('createBM25SearchService', () => {
  beforeEach(() => {
    resetBM25StoreManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetBM25StoreManager();
  });

  it('should create a service with default BM25 config', () => {
    const service = createBM25SearchService('test', {
      top_k: 10,
      rerank: false,
    });

    expect(service).toBeInstanceOf(BM25SearchService);
  });

  it('should create a service with custom BM25 config', () => {
    const service = createBM25SearchService(
      'test',
      { top_k: 10, rerank: false },
      { bm25Config: { k1: 2.0, b: 0.5 } }
    );

    expect(service).toBeInstanceOf(BM25SearchService);
  });
});
