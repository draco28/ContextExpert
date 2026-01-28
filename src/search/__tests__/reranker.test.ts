/**
 * Reranker Service Tests
 *
 * Tests for the RerankerService wrapper around ContextAI SDK's BGEReranker.
 * Uses mocking to avoid loading the actual model during tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchResultWithContext, RerankConfig } from '../types.js';

// Mock the ContextAI SDK before importing RerankerService
vi.mock('@contextaisdk/rag', () => ({
  BGEReranker: vi.fn().mockImplementation(() => ({
    warmup: vi.fn().mockResolvedValue(undefined),
    isLoaded: vi.fn().mockReturnValue(true),
    rerank: vi.fn().mockImplementation(
      async (
        _query: string,
        results: Array<{ id: string; chunk: { content: string }; score: number }>,
        options?: { topK?: number }
      ) => {
        // Mock reranking: reverse the order to simulate "improved" ranking
        // In real reranking, the cross-encoder would score based on query-doc relevance
        const reversed = [...results].reverse();
        const topK = options?.topK ?? results.length;

        return reversed.slice(0, topK).map((r, index) => ({
          id: r.id,
          chunk: r.chunk,
          score: 0.9 - index * 0.1, // Simulate descending reranker scores
          originalRank: results.findIndex((orig) => orig.id === r.id) + 1,
          newRank: index + 1,
          scores: {
            originalScore: r.score,
            rerankerScore: 0.9 - index * 0.1,
          },
        }));
      }
    ),
  })),
}));

import { RerankerService } from '../reranker.js';
import { BGEReranker } from '@contextaisdk/rag';

/**
 * Helper to create mock search results for testing.
 */
function createMockResults(count: number): SearchResultWithContext[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `chunk-${i + 1}`,
    score: 0.9 - i * 0.1, // Descending scores: 0.9, 0.8, 0.7, ...
    content: `Content for chunk ${i + 1}`,
    filePath: `src/file-${i + 1}.ts`,
    fileType: 'code' as const,
    language: 'typescript',
    lineRange: { start: 1, end: 10 },
    metadata: { index: i },
  }));
}

describe('RerankerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create service with default config', () => {
      const service = new RerankerService();

      expect(service.getCandidateCount()).toBe(50); // Default
      expect(service.isLoaded()).toBe(false); // Not loaded until warmup
    });

    it('should create service with custom config', () => {
      const config: RerankConfig = {
        model: 'Xenova/bge-reranker-large',
        candidateCount: 100,
        device: 'cpu',
      };

      const service = new RerankerService(config);

      expect(service.getCandidateCount()).toBe(100);
    });
  });

  describe('warmup', () => {
    it('should initialize the reranker on first call', async () => {
      const service = new RerankerService();

      await service.warmup();

      expect(BGEReranker).toHaveBeenCalledTimes(1);
      expect(BGEReranker).toHaveBeenCalledWith({
        modelName: 'Xenova/bge-reranker-base',
        device: 'auto',
      });
    });

    it('should not create multiple reranker instances', async () => {
      const service = new RerankerService();

      await service.warmup();
      await service.warmup();
      await service.warmup();

      // Should only create one instance despite multiple calls
      expect(BGEReranker).toHaveBeenCalledTimes(1);
    });

    it('should use custom model from config', async () => {
      const service = new RerankerService({
        model: 'Xenova/bge-reranker-large',
        device: 'gpu',
      });

      await service.warmup();

      expect(BGEReranker).toHaveBeenCalledWith({
        modelName: 'Xenova/bge-reranker-large',
        device: 'gpu',
      });
    });
  });

  describe('rerank', () => {
    it('should rerank results and return top K', async () => {
      const service = new RerankerService();
      const results = createMockResults(10);

      const reranked = await service.rerank('test query', results, 5);

      expect(reranked.length).toBe(5);
    });

    it('should update scores from reranker', async () => {
      const service = new RerankerService();
      const results = createMockResults(5);

      const reranked = await service.rerank('test query', results, 5);

      // All results should have updated scores
      reranked.forEach((r) => {
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
      });
    });

    it('should preserve original metadata', async () => {
      const service = new RerankerService();
      const results = createMockResults(3);

      const reranked = await service.rerank('test query', results, 3);

      // Verify metadata is preserved
      reranked.forEach((r) => {
        expect(r.filePath).toMatch(/^src\/file-\d+\.ts$/);
        expect(r.fileType).toBe('code');
        expect(r.language).toBe('typescript');
        expect(r.metadata).toBeDefined();
      });
    });

    it('should handle empty results', async () => {
      const service = new RerankerService();

      const reranked = await service.rerank('test query', [], 5);

      expect(reranked).toEqual([]);
    });

    it('should limit candidates to configured count', async () => {
      // Create service with small candidate count
      const service = new RerankerService({ candidateCount: 3 });
      const results = createMockResults(10);

      await service.warmup();
      const mockReranker = vi.mocked(BGEReranker).mock.results[0]!.value;

      await service.rerank('test query', results, 5);

      // Should only pass candidateCount (3) results to reranker
      expect(mockReranker.rerank).toHaveBeenCalledWith(
        'test query',
        expect.arrayContaining([
          expect.objectContaining({ id: 'chunk-1' }),
          expect.objectContaining({ id: 'chunk-2' }),
          expect.objectContaining({ id: 'chunk-3' }),
        ]),
        { topK: 5 }
      );

      // Verify only 3 candidates were passed (not all 10)
      const passedResults = mockReranker.rerank.mock.calls[0]![1];
      expect(passedResults.length).toBe(3);
    });

    it('should lazy-load reranker on first rerank call', async () => {
      const service = new RerankerService();
      const results = createMockResults(5);

      expect(BGEReranker).not.toHaveBeenCalled();

      await service.rerank('test query', results, 3);

      expect(BGEReranker).toHaveBeenCalledTimes(1);
    });
  });

  describe('isLoaded', () => {
    it('should return false before warmup', () => {
      const service = new RerankerService();

      expect(service.isLoaded()).toBe(false);
    });

    it('should return true after warmup', async () => {
      const service = new RerankerService();

      await service.warmup();

      expect(service.isLoaded()).toBe(true);
    });
  });

  describe('getCandidateCount', () => {
    it('should return default candidate count', () => {
      const service = new RerankerService();

      expect(service.getCandidateCount()).toBe(50);
    });

    it('should return custom candidate count', () => {
      const service = new RerankerService({ candidateCount: 75 });

      expect(service.getCandidateCount()).toBe(75);
    });
  });

  describe('type conversion', () => {
    it('should convert SearchResultWithContext to RetrievalResult format', async () => {
      const service = new RerankerService();
      const results: SearchResultWithContext[] = [
        {
          id: 'test-id',
          score: 0.85,
          content: 'Test content here',
          filePath: 'src/test.ts',
          fileType: 'code',
          language: 'typescript',
          lineRange: { start: 10, end: 20 },
          metadata: { custom: 'value' },
        },
      ];

      await service.warmup();
      const mockReranker = vi.mocked(BGEReranker).mock.results[0]!.value;

      await service.rerank('query', results, 1);

      // Verify the conversion to SDK format
      expect(mockReranker.rerank).toHaveBeenCalledWith(
        'query',
        [
          {
            id: 'test-id',
            chunk: {
              id: 'test-id',
              content: 'Test content here',
              metadata: { custom: 'value' },
            },
            score: 0.85,
          },
        ],
        { topK: 1 }
      );
    });

    it('should map reranker results back to SearchResultWithContext', async () => {
      const service = new RerankerService();
      const results: SearchResultWithContext[] = [
        {
          id: 'id-1',
          score: 0.5,
          content: 'Content 1',
          filePath: 'path/to/file1.ts',
          fileType: 'code',
          language: 'typescript',
          lineRange: { start: 1, end: 5 },
          metadata: { key: 'value1' },
        },
        {
          id: 'id-2',
          score: 0.3,
          content: 'Content 2',
          filePath: 'path/to/file2.ts',
          fileType: 'docs',
          language: null,
          lineRange: { start: 10, end: 20 },
          metadata: { key: 'value2' },
        },
      ];

      const reranked = await service.rerank('query', results, 2);

      // Verify all original fields are preserved (except score which is updated)
      reranked.forEach((r) => {
        const original = results.find((orig) => orig.id === r.id);
        expect(original).toBeDefined();
        expect(r.content).toBe(original!.content);
        expect(r.filePath).toBe(original!.filePath);
        expect(r.fileType).toBe(original!.fileType);
        expect(r.language).toBe(original!.language);
        expect(r.lineRange).toEqual(original!.lineRange);
        expect(r.metadata).toEqual(original!.metadata);
      });
    });
  });
});

describe('RerankerService integration with FusionService', () => {
  it('should be importable alongside other search components', async () => {
    // Verify the exports work correctly
    const { RerankerService, FusionService, createFusionService } = await import('../index.js');

    expect(RerankerService).toBeDefined();
    expect(FusionService).toBeDefined();
    expect(createFusionService).toBeDefined();
  });
});
