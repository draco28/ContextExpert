/**
 * Fusion Service Tests
 *
 * Tests for the RRF (Reciprocal Rank Fusion) algorithm and FusionService.
 * Unlike other search tests, we can test computeRRF as a pure function
 * without database mocking - it just transforms ranked lists.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EmbeddingProvider, EmbeddingResult } from '@contextaisdk/rag';

import {
  computeRRF,
  FusionService,
  createFusionService,
  DEFAULT_RRF_K,
} from '../fusion.js';
import { resetVectorStoreManager } from '../store.js';
import { resetBM25StoreManager } from '../bm25-store.js';
import { embeddingToBlob } from '../../database/schema.js';
import type { SearchResultWithContext } from '../types.js';

/**
 * Helper to create mock search results for testing.
 *
 * Creates results with predictable IDs and scores for verifying fusion behavior.
 */
function createMockResults(
  ids: string[],
  scoreStart = 0.9,
  scoreDecrement = 0.1
): SearchResultWithContext[] {
  return ids.map((id, index) => ({
    id,
    score: scoreStart - index * scoreDecrement,
    content: `Content for ${id}`,
    filePath: `src/${id}.ts`,
    fileType: 'code' as const,
    language: 'typescript',
    lineRange: { start: 1, end: 10 },
    metadata: {},
  }));
}

describe('computeRRF', () => {
  describe('basic fusion', () => {
    it('should combine results from both sources', () => {
      // Dense: A, B, C (in rank order)
      // BM25: D, E, F (in rank order)
      // Expected: All 6 results, ranked by RRF score
      const denseResults = createMockResults(['A', 'B', 'C']);
      const bm25Results = createMockResults(['D', 'E', 'F']);

      const fused = computeRRF(denseResults, bm25Results, { k: 60 });

      expect(fused.length).toBe(6);
      // All IDs should be present
      const ids = fused.map((r) => r.id);
      expect(ids).toContain('A');
      expect(ids).toContain('B');
      expect(ids).toContain('C');
      expect(ids).toContain('D');
      expect(ids).toContain('E');
      expect(ids).toContain('F');
    });

    it('should return results sorted by RRF score descending', () => {
      const denseResults = createMockResults(['A', 'B', 'C']);
      const bm25Results = createMockResults(['D', 'E', 'F']);

      const fused = computeRRF(denseResults, bm25Results, { k: 60 });

      // Scores should be in descending order
      for (let i = 1; i < fused.length; i++) {
        expect(fused[i - 1]!.score).toBeGreaterThanOrEqual(fused[i]!.score);
      }
    });

    it('should use rank position, not original scores', () => {
      // Both have same items but different scores
      // RRF should produce same result regardless of score magnitudes
      const dense1 = createMockResults(['A', 'B'], 0.99, 0.01); // High scores
      const dense2 = createMockResults(['A', 'B'], 0.5, 0.4); // Low scores

      const bm25 = createMockResults(['C', 'D']);

      const fused1 = computeRRF(dense1, bm25, { k: 60 });
      const fused2 = computeRRF(dense2, bm25, { k: 60 });

      // Same rank order should produce same RRF scores
      expect(fused1.map((r) => r.id)).toEqual(fused2.map((r) => r.id));
      expect(fused1.map((r) => r.score)).toEqual(fused2.map((r) => r.score));
    });
  });

  describe('deduplication', () => {
    it('should merge scores when same document appears in both lists', () => {
      // Dense: A (rank 1), B (rank 2)
      // BM25: A (rank 1), C (rank 2)
      // 'A' should get RRF scores from both lists summed
      const denseResults = createMockResults(['A', 'B']);
      const bm25Results = createMockResults(['A', 'C']);

      const fused = computeRRF(denseResults, bm25Results, { k: 60 });

      // Should have 3 unique results (A, B, C)
      expect(fused.length).toBe(3);

      // A should be ranked first (gets score from both lists)
      expect(fused[0]!.id).toBe('A');

      // A's score should be higher than items appearing in only one list
      const scoreA = fused.find((r) => r.id === 'A')!.score;
      const scoreB = fused.find((r) => r.id === 'B')!.score;
      const scoreC = fused.find((r) => r.id === 'C')!.score;

      expect(scoreA).toBeGreaterThan(scoreB);
      expect(scoreA).toBeGreaterThan(scoreC);
    });

    it('should preserve metadata from first occurrence', () => {
      const denseResults: SearchResultWithContext[] = [
        {
          id: 'A',
          score: 0.9,
          content: 'Dense content',
          filePath: 'dense-path.ts',
          fileType: 'code',
          language: 'typescript',
          lineRange: { start: 1, end: 10 },
          metadata: { source: 'dense' },
        },
      ];

      const bm25Results: SearchResultWithContext[] = [
        {
          id: 'A',
          score: 5.0,
          content: 'BM25 content',
          filePath: 'bm25-path.ts',
          fileType: 'docs',
          language: null,
          lineRange: { start: 100, end: 200 },
          metadata: { source: 'bm25' },
        },
      ];

      const fused = computeRRF(denseResults, bm25Results, { k: 60 });

      expect(fused.length).toBe(1);
      // Should keep metadata from dense (first occurrence in processing order)
      expect(fused[0]!.content).toBe('Dense content');
      expect(fused[0]!.filePath).toBe('dense-path.ts');
      expect(fused[0]!.metadata.source).toBe('dense');
    });
  });

  describe('RRF formula verification', () => {
    it('should compute correct RRF scores with k=60', () => {
      // With k=60:
      // Rank 1: 1/(60+1) = 0.01639...
      // Rank 2: 1/(60+2) = 0.01613...
      const denseResults = createMockResults(['A']);
      const bm25Results = createMockResults(['B']);

      const fused = computeRRF(denseResults, bm25Results, { k: 60 });

      // Both should have same RRF score (both rank 1 in their respective lists)
      const scoreA = fused.find((r) => r.id === 'A')!.score;
      const scoreB = fused.find((r) => r.id === 'B')!.score;

      // 1 / (60 + 1) = 0.016393...
      const expectedScore = 1 / (60 + 1);
      expect(scoreA).toBeCloseTo(expectedScore, 5);
      expect(scoreB).toBeCloseTo(expectedScore, 5);
    });

    it('should compute correct summed score for duplicates', () => {
      // A appears at rank 1 in both lists
      // RRF(A) = 1/(k+1) + 1/(k+1) = 2/(k+1)
      const denseResults = createMockResults(['A']);
      const bm25Results = createMockResults(['A']);

      const fused = computeRRF(denseResults, bm25Results, { k: 60 });

      const scoreA = fused[0]!.score;
      const expectedScore = 2 / (60 + 1);
      expect(scoreA).toBeCloseTo(expectedScore, 5);
    });

    it('should respect different k values', () => {
      const denseResults = createMockResults(['A']);
      const bm25Results = createMockResults(['B']);

      // Lower k = higher individual scores
      const fusedK10 = computeRRF(denseResults, bm25Results, { k: 10 });
      const fusedK60 = computeRRF(denseResults, bm25Results, { k: 60 });

      // k=10: score = 1/(10+1) = 0.0909...
      // k=60: score = 1/(60+1) = 0.0164...
      expect(fusedK10[0]!.score).toBeGreaterThan(fusedK60[0]!.score);
    });
  });

  describe('weighted fusion', () => {
    it('should apply weights to RRF scores', () => {
      const denseResults = createMockResults(['A']);
      const bm25Results = createMockResults(['B']);

      // Give dense 2x weight
      const fused = computeRRF(denseResults, bm25Results, {
        k: 60,
        weights: { dense: 2.0, bm25: 1.0 },
      });

      const scoreA = fused.find((r) => r.id === 'A')!.score;
      const scoreB = fused.find((r) => r.id === 'B')!.score;

      // A (dense) should have 2x the score of B (bm25)
      expect(scoreA).toBeCloseTo(scoreB * 2, 5);
    });

    it('should handle zero weight for one source', () => {
      const denseResults = createMockResults(['A', 'B']);
      const bm25Results = createMockResults(['C', 'D']);

      // Zero weight for BM25 - effectively dense-only
      const fused = computeRRF(denseResults, bm25Results, {
        k: 60,
        weights: { dense: 1.0, bm25: 0 },
      });

      // BM25 results should have 0 score
      const scoreC = fused.find((r) => r.id === 'C')!.score;
      const scoreD = fused.find((r) => r.id === 'D')!.score;
      expect(scoreC).toBe(0);
      expect(scoreD).toBe(0);

      // Dense results should still have scores
      const scoreA = fused.find((r) => r.id === 'A')!.score;
      expect(scoreA).toBeGreaterThan(0);
    });
  });

  describe('edge cases', () => {
    it('should handle empty dense results', () => {
      const denseResults: SearchResultWithContext[] = [];
      const bm25Results = createMockResults(['A', 'B']);

      const fused = computeRRF(denseResults, bm25Results, { k: 60 });

      expect(fused.length).toBe(2);
      expect(fused[0]!.id).toBe('A');
    });

    it('should handle empty BM25 results', () => {
      const denseResults = createMockResults(['A', 'B']);
      const bm25Results: SearchResultWithContext[] = [];

      const fused = computeRRF(denseResults, bm25Results, { k: 60 });

      expect(fused.length).toBe(2);
      expect(fused[0]!.id).toBe('A');
    });

    it('should handle both empty', () => {
      const fused = computeRRF([], [], { k: 60 });
      expect(fused).toEqual([]);
    });

    it('should handle single result in each list', () => {
      const denseResults = createMockResults(['A']);
      const bm25Results = createMockResults(['B']);

      const fused = computeRRF(denseResults, bm25Results, { k: 60 });

      expect(fused.length).toBe(2);
      // Both have same rank (1), so same score, order depends on processing
      expect(fused[0]!.score).toEqual(fused[1]!.score);
    });
  });
});

describe('DEFAULT_RRF_K', () => {
  it('should be 60 (the empirically validated default)', () => {
    expect(DEFAULT_RRF_K).toBe(60);
  });
});

// Service tests require database mocking, similar to other search services
describe('FusionService', () => {
  // Mock the database module
  vi.mock('../../database/connection.js', () => ({
    getDb: vi.fn(),
  }));

  beforeEach(() => {
    resetVectorStoreManager();
    resetBM25StoreManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetVectorStoreManager();
    resetBM25StoreManager();
  });

  /**
   * Create a mock embedding provider for testing.
   * Generates deterministic embeddings based on text hash.
   */
  function createMockProvider(dimensions: number = 1024): EmbeddingProvider {
    const generateEmbedding = (text: string): number[] => {
      const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      return Array.from({ length: dimensions }, (_, i) => Math.sin(hash + i) * 0.5);
    };

    return {
      name: 'MockProvider',
      dimensions,
      maxBatchSize: 32,

      async embed(text: string): Promise<EmbeddingResult> {
        return {
          embedding: generateEmbedding(text),
          tokenCount: Math.ceil(text.length / 4),
          model: 'mock-model',
        };
      },

      async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
        return texts.map((text) => ({
          embedding: generateEmbedding(text),
          tokenCount: Math.ceil(text.length / 4),
          model: 'mock-model',
        }));
      },

      async isAvailable(): Promise<boolean> {
        return true;
      },
    };
  }

  /**
   * Create a test embedding as a Buffer.
   */
  function createTestEmbedding(dimensions: number, seed: number = 0): Buffer {
    const embedding = new Float32Array(dimensions);
    for (let i = 0; i < dimensions; i++) {
      embedding[i] = Math.sin(seed + i) * 0.5;
    }
    return embeddingToBlob(embedding);
  }

  /**
   * Row shape matching what we load from SQLite.
   */
  interface ChunkRow {
    id: string;
    content: string;
    embedding: Buffer;
    file_path: string;
    file_type: string | null;
    language: string | null;
    start_line: number | null;
    end_line: number | null;
    metadata: string | null;
  }

  /**
   * Create a mock database with test chunks (including embeddings for dense search).
   */
  function createMockDb(chunks: Omit<ChunkRow, 'embedding'>[]) {
    // Create embeddings that will match well with queries containing similar content
    const chunksWithEmbeddings: ChunkRow[] = chunks.map((chunk, idx) => ({
      ...chunk,
      embedding: createTestEmbedding(1024, idx),
    }));

    const mockPrepare = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('COUNT(*)')) {
        return {
          get: vi.fn().mockReturnValue({ count: chunks.length }),
        };
      }
      // BM25 query (no embedding column)
      if (sql.includes('SELECT id, content') && !sql.includes('embedding')) {
        return {
          all: vi.fn().mockImplementation(
            (_projectId: string, limit: number, offset: number) => {
              return chunks.slice(offset, offset + limit);
            }
          ),
        };
      }
      // Dense query (includes embedding column)
      if (sql.includes('embedding')) {
        return {
          all: vi.fn().mockImplementation(
            (_projectId: string, limit: number, offset: number) => {
              return chunksWithEmbeddings.slice(offset, offset + limit);
            }
          ),
        };
      }
      return { get: vi.fn(), all: vi.fn() };
    });

    return { prepare: mockPrepare };
  }

  describe('search', () => {
    it('should return fused results from both search methods', async () => {
      const { getDb } = await import('../../database/connection.js');

      const testChunks = [
        {
          id: 'chunk-1',
          content: 'PostgreSQL database connection pool',
          file_path: 'src/db/postgres.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 10,
          end_line: 50,
          metadata: null,
        },
        {
          id: 'chunk-2',
          content: 'MySQL database driver',
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

      const provider = createMockProvider();
      const service = createFusionService('test-project', provider, {
        top_k: 10,
        rerank: false,
      });

      const results = await service.search('PostgreSQL database');

      // Should return results (may be deduplicated)
      expect(results.length).toBeGreaterThan(0);

      // Results should have RRF scores
      expect(results[0]!.score).toBeGreaterThan(0);

      // Should be sorted by score descending
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
      }
    });

    it('should respect topK option', async () => {
      const { getDb } = await import('../../database/connection.js');

      const testChunks = Array.from({ length: 20 }, (_, i) => ({
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

      const provider = createMockProvider();
      const service = createFusionService('test-project', provider, {
        top_k: 10,
        rerank: false,
      });

      const results = await service.search('database content', { topK: 5 });

      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('should respect minScore option', async () => {
      const { getDb } = await import('../../database/connection.js');

      const testChunks = [
        {
          id: 'chunk-1',
          content: 'Highly relevant content about databases',
          file_path: 'high.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 10,
          metadata: null,
        },
        {
          id: 'chunk-2',
          content: 'Unrelated content',
          file_path: 'low.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 10,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const provider = createMockProvider();
      const service = createFusionService('test-project', provider, {
        top_k: 10,
        rerank: false,
      });

      // Get all results first
      const allResults = await service.search('databases');

      // Filter with high minScore
      const filteredResults = await service.search('databases', {
        minScore: allResults[0]!.score * 0.99,
      });

      expect(filteredResults.length).toBeLessThanOrEqual(allResults.length);
    });

    it('should apply custom fusion config', async () => {
      const { getDb } = await import('../../database/connection.js');

      const testChunks = [
        {
          id: 'chunk-1',
          content: 'Test content for searching',
          file_path: 'test.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 10,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const provider = createMockProvider();
      // Use k=10 instead of default 60
      const service = createFusionService('test-project', provider, {
        top_k: 10,
        rerank: false,
      }, {
        fusionConfig: { k: 10 },
      });

      const results = await service.search('test content');

      // With k=10, if chunk appears in one list: score = 1/(10+1) = 0.0909...
      // If chunk appears in both lists: score = 2/(10+1) = 0.1818...
      // The exact score depends on whether both dense and BM25 return it.
      // We verify the RRF formula is correctly applied by checking score is in expected range
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.score).toBeGreaterThanOrEqual(1 / 11); // At least one source
      expect(results[0]!.score).toBeLessThanOrEqual(2 / 11); // At most both sources
    });
  });

  describe('getProjectId', () => {
    it('should return the project ID', () => {
      const provider = createMockProvider();
      const service = createFusionService('my-project-123', provider, {
        top_k: 10,
        rerank: false,
      });

      expect(service.getProjectId()).toBe('my-project-123');
    });
  });

  describe('isInitialized', () => {
    it('should return false before first search', () => {
      const provider = createMockProvider();
      const service = createFusionService('test-project', provider, {
        top_k: 10,
        rerank: false,
      });

      expect(service.isInitialized()).toBe(false);
    });

    it('should return true after search', async () => {
      const { getDb } = await import('../../database/connection.js');

      const testChunks = [
        {
          id: 'chunk-1',
          content: 'Test content',
          file_path: 'test.ts',
          file_type: 'code',
          language: 'typescript',
          start_line: 1,
          end_line: 10,
          metadata: null,
        },
      ];

      const mockDb = createMockDb(testChunks);
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const provider = createMockProvider();
      const service = createFusionService('test-project', provider, {
        top_k: 10,
        rerank: false,
      });

      await service.search('test');

      expect(service.isInitialized()).toBe(true);
    });
  });
});

describe('createFusionService', () => {
  /**
   * Create a mock embedding provider for testing.
   */
  function createMockProvider(dimensions: number = 1024): EmbeddingProvider {
    const generateEmbedding = (text: string): number[] => {
      const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      return Array.from({ length: dimensions }, (_, i) => Math.sin(hash + i) * 0.5);
    };

    return {
      name: 'MockProvider',
      dimensions,
      maxBatchSize: 32,

      async embed(text: string): Promise<EmbeddingResult> {
        return {
          embedding: generateEmbedding(text),
          tokenCount: Math.ceil(text.length / 4),
          model: 'mock-model',
        };
      },

      async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
        return texts.map((text) => ({
          embedding: generateEmbedding(text),
          tokenCount: Math.ceil(text.length / 4),
          model: 'mock-model',
        }));
      },

      async isAvailable(): Promise<boolean> {
        return true;
      },
    };
  }

  it('should create a service with default config', () => {
    const provider = createMockProvider();
    const service = createFusionService('test', provider, {
      top_k: 10,
      rerank: false,
    });

    expect(service).toBeInstanceOf(FusionService);
  });

  it('should create a service with custom config', () => {
    const provider = createMockProvider();
    const service = createFusionService('test', provider, {
      top_k: 10,
      rerank: false,
    }, {
      fusionConfig: { k: 30, weights: { dense: 1.5, bm25: 0.8 } },
    });

    expect(service).toBeInstanceOf(FusionService);
  });
});
