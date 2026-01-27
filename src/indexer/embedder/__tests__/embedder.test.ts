/**
 * Embedder Tests
 *
 * Tests for the embedding generation pipeline.
 * Uses mock providers to avoid model downloads in CI.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EmbeddingProvider, EmbeddingResult } from '@contextaisdk/rag';

import { embedChunks, embedChunk, estimateEmbeddingMemory } from '../embedder.js';
import { getModelDimensions } from '../provider.js';
import type { ChunkResult } from '../../chunker/types.js';
import type { FileType, Language } from '../../types.js';

/**
 * Create a mock embedding provider for testing.
 * Returns deterministic embeddings based on text content.
 */
function createMockProvider(
  dimensions: number = 1024,
  options: { shouldFail?: boolean; failOnBatch?: boolean } = {}
): EmbeddingProvider {
  const generateEmbedding = (text: string): number[] => {
    // Generate deterministic embedding based on text hash
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return Array.from({ length: dimensions }, (_, i) => Math.sin(hash + i) * 0.5);
  };

  return {
    name: 'MockProvider',
    dimensions,
    maxBatchSize: 32,

    async embed(text: string): Promise<EmbeddingResult> {
      if (options.shouldFail) {
        throw new Error('Mock provider failure');
      }
      return {
        embedding: generateEmbedding(text),
        tokenCount: Math.ceil(text.length / 4),
        model: 'mock-model',
      };
    },

    async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
      if (options.failOnBatch) {
        throw new Error('Mock batch failure');
      }
      return texts.map((text) => ({
        embedding: generateEmbedding(text),
        tokenCount: Math.ceil(text.length / 4),
        model: 'mock-model',
      }));
    },

    async isAvailable(): Promise<boolean> {
      return !options.shouldFail;
    },
  };
}

/**
 * Create a mock chunk for testing.
 */
function createMockChunk(
  id: string,
  content: string,
  overrides: Partial<ChunkResult> = {}
): ChunkResult {
  return {
    id,
    content,
    file_path: 'test/file.ts',
    file_type: 'code' as FileType,
    content_type: 'code',
    language: 'typescript' as Language,
    start_line: 1,
    end_line: 10,
    metadata: {
      originalSize: content.length,
      chunkIndex: 0,
      totalChunks: 1,
    },
    ...overrides,
  };
}

describe('embedChunks', () => {
  let mockProvider: EmbeddingProvider;

  beforeEach(() => {
    mockProvider = createMockProvider();
  });

  it('should embed an empty array', async () => {
    const result = await embedChunks([], mockProvider);
    expect(result).toEqual([]);
  });

  it('should embed a single chunk', async () => {
    const chunks = [createMockChunk('1', 'function hello() { return "world"; }')];

    const result = await embedChunks(chunks, mockProvider);

    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty('embedding');
    expect(result[0]!.embedding).toBeInstanceOf(Float32Array);
    expect(result[0]!.embedding.length).toBe(1024);
    expect(result[0]!.id).toBe('1');
    expect(result[0]!.content).toBe('function hello() { return "world"; }');
  });

  it('should embed multiple chunks in batches', async () => {
    const chunks = Array.from({ length: 50 }, (_, i) =>
      createMockChunk(`chunk-${i}`, `Content for chunk ${i}`)
    );

    const result = await embedChunks(chunks, mockProvider, { batchSize: 10 });

    expect(result).toHaveLength(50);
    // Verify all chunks have embeddings
    for (const chunk of result) {
      expect(chunk.embedding).toBeInstanceOf(Float32Array);
      expect(chunk.embedding.length).toBe(1024);
    }
  });

  it('should call progress callback', async () => {
    const chunks = Array.from({ length: 20 }, (_, i) =>
      createMockChunk(`chunk-${i}`, `Content ${i}`)
    );

    const progressCalls: Array<{ processed: number; total: number }> = [];

    await embedChunks(chunks, mockProvider, {
      batchSize: 5,
      onProgress: (processed, total) => {
        progressCalls.push({ processed, total });
      },
    });

    // Should have 4 progress calls (20 chunks / 5 batch size)
    expect(progressCalls).toHaveLength(4);
    expect(progressCalls[0]).toEqual({ processed: 5, total: 20 });
    expect(progressCalls[3]).toEqual({ processed: 20, total: 20 });
  });

  it('should handle batch failures with individual fallback', async () => {
    // Create a provider that fails on batch but succeeds on individual calls
    let batchCallCount = 0;
    const failingProvider: EmbeddingProvider = {
      name: 'FailingBatchProvider',
      dimensions: 1024,
      maxBatchSize: 32,
      async embed(text: string): Promise<EmbeddingResult> {
        return {
          embedding: Array.from({ length: 1024 }, () => 0.1),
          tokenCount: 10,
          model: 'mock',
        };
      },
      async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
        batchCallCount++;
        // Fail on first batch call (the main batch), succeed on retries (single items)
        if (batchCallCount === 1 && texts.length > 1) {
          throw new Error('Batch processing failed');
        }
        return texts.map((text) => ({
          embedding: Array.from({ length: 1024 }, () => 0.1),
          tokenCount: 10,
          model: 'mock',
        }));
      },
      async isAvailable(): Promise<boolean> {
        return true;
      },
    };

    const chunks = [
      createMockChunk('1', 'chunk 1'),
      createMockChunk('2', 'chunk 2'),
    ];

    const errors: Array<{ error: Error; chunkId: string }> = [];

    const result = await embedChunks(chunks, failingProvider, {
      onError: (error, chunkId) => errors.push({ error, chunkId }),
    });

    // Should recover via individual embedBatch calls with single items
    expect(result).toHaveLength(2);
  });

  it('should call error callback when all embedding attempts fail', async () => {
    // Provider that always fails
    const alwaysFailingProvider: EmbeddingProvider = {
      name: 'AlwaysFailingProvider',
      dimensions: 1024,
      maxBatchSize: 32,
      async embed(): Promise<EmbeddingResult> {
        throw new Error('Provider failure');
      },
      async embedBatch(): Promise<EmbeddingResult[]> {
        throw new Error('Provider failure');
      },
      async isAvailable(): Promise<boolean> {
        return false;
      },
    };

    const chunks = [createMockChunk('1', 'test content')];
    const errors: Array<{ error: Error; chunkId: string }> = [];

    const result = await embedChunks(chunks, alwaysFailingProvider, {
      onError: (error, chunkId) => errors.push({ error, chunkId }),
    });

    // Chunk should be skipped due to failure
    expect(result).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.chunkId).toBe('1');
  });

  it('should preserve chunk metadata in embedded chunks', async () => {
    const chunk = createMockChunk('test-id', 'test content', {
      file_path: 'src/special/file.ts',
      content_type: 'docs',
      start_line: 42,
      end_line: 100,
      metadata: {
        originalSize: 1000,
        chunkIndex: 5,
        totalChunks: 10,
        symbolName: 'myFunction',
        symbolType: 'function',
      },
    });

    const result = await embedChunks([chunk], mockProvider);

    expect(result[0]!.file_path).toBe('src/special/file.ts');
    expect(result[0]!.content_type).toBe('docs');
    expect(result[0]!.start_line).toBe(42);
    expect(result[0]!.metadata.symbolName).toBe('myFunction');
  });

  it('should convert embeddings to Float32Array', async () => {
    const chunks = [createMockChunk('1', 'test')];

    const result = await embedChunks(chunks, mockProvider);

    // Verify it's actually a Float32Array, not just number[]
    expect(result[0]!.embedding.constructor.name).toBe('Float32Array');
    expect(result[0]!.embedding.BYTES_PER_ELEMENT).toBe(4);
  });
});

describe('embedChunk', () => {
  it('should embed a single chunk', async () => {
    const provider = createMockProvider();
    const chunk = createMockChunk('single', 'single chunk content');

    const result = await embedChunk(chunk, provider);

    expect(result).not.toBeNull();
    expect(result!.id).toBe('single');
    expect(result!.embedding).toBeInstanceOf(Float32Array);
  });

  it('should return null on failure', async () => {
    const provider = createMockProvider(1024, { shouldFail: true });
    const chunk = createMockChunk('fail', 'will fail');

    const result = await embedChunk(chunk, provider);

    expect(result).toBeNull();
  });
});

describe('estimateEmbeddingMemory', () => {
  it('should estimate memory for embeddings', () => {
    // 100 chunks × 1024 dimensions × 4 bytes + overhead
    const estimate = estimateEmbeddingMemory(100, 1024);

    // Each embedding: 1024 × 4 + 100 overhead = 4196 bytes
    // 100 chunks × 4196 = 419,600 bytes
    expect(estimate).toBeGreaterThan(400000);
    expect(estimate).toBeLessThan(500000);
  });

  it('should use default dimensions of 1024', () => {
    const withDefault = estimateEmbeddingMemory(10);
    const withExplicit = estimateEmbeddingMemory(10, 1024);

    expect(withDefault).toBe(withExplicit);
  });
});

describe('getModelDimensions', () => {
  it('should return correct dimensions for BGE models', () => {
    expect(getModelDimensions('BAAI/bge-large-en-v1.5')).toBe(1024);
    expect(getModelDimensions('Xenova/bge-large-en-v1.5')).toBe(1024);
    expect(getModelDimensions('bge-base-en-v1.5')).toBe(768);
    expect(getModelDimensions('bge-small-en-v1.5')).toBe(384);
  });

  it('should return correct dimensions for Ollama models', () => {
    expect(getModelDimensions('nomic-embed-text')).toBe(768);
    expect(getModelDimensions('mxbai-embed-large')).toBe(1024);
  });

  it('should return correct dimensions for OpenAI models', () => {
    expect(getModelDimensions('text-embedding-3-large')).toBe(3072);
    expect(getModelDimensions('text-embedding-3-small')).toBe(1536);
    expect(getModelDimensions('text-embedding-ada-002')).toBe(1536);
  });

  it('should return default 1024 for unknown models', () => {
    expect(getModelDimensions('unknown-model')).toBe(1024);
  });
});
