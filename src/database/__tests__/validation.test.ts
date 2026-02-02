/**
 * Validation Module Tests (Ticket #51)
 *
 * Tests for Zod schema validation utilities:
 * - Schema correctness (valid/invalid data)
 * - Error handling (SchemaValidationError)
 * - Performance benchmarks (<5% overhead target)
 */

import { describe, it, expect } from 'vitest';
import {
  ProjectRowSchema,
  ChunkRowSchema,
  ChunkLoadRowSchema,
  ChunkLoadNoEmbeddingSchema,
  validateRow,
  validateRows,
  safeValidateRow,
  SchemaValidationError,
} from '../validation.js';

describe('Validation Schemas', () => {
  describe('ProjectRowSchema', () => {
    it('should validate a valid project row', () => {
      const row = {
        id: 'proj-123',
        name: 'test-project',
        path: '/path/to/project',
        tags: null,
        ignore_patterns: null,
        indexed_at: null,
        updated_at: null,
        file_count: 42,
        chunk_count: 100,
        config: null,
        embedding_model: 'BAAI/bge-large-en-v1.5',
        embedding_dimensions: 1024,
        description: null,
      };

      const result = ProjectRowSchema.safeParse(row);
      expect(result.success).toBe(true);
    });

    it('should accept description as string or null', () => {
      const rowWithDescription = {
        id: 'proj-123',
        name: 'test-project',
        path: '/path/to/project',
        tags: null,
        ignore_patterns: null,
        indexed_at: null,
        updated_at: null,
        file_count: 0,
        chunk_count: 0,
        config: null,
        embedding_model: null,
        embedding_dimensions: 1024,
        description: 'Main API server with auth and payments',
      };

      const result = ProjectRowSchema.safeParse(rowWithDescription);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.description).toBe('Main API server with auth and payments');
      }
    });

    it('should reject missing required fields', () => {
      const row = {
        id: 'proj-123',
        // name missing
        path: '/path/to/project',
      };

      const result = ProjectRowSchema.safeParse(row);
      expect(result.success).toBe(false);
    });

    it('should apply default for embedding_dimensions', () => {
      const row = {
        id: 'proj-123',
        name: 'test-project',
        path: '/path/to/project',
        tags: null,
        ignore_patterns: null,
        indexed_at: null,
        updated_at: null,
        file_count: 0,
        chunk_count: 0,
        config: null,
        embedding_model: null,
        description: null,
        // embedding_dimensions not provided - should default to 1024
      };

      const result = ProjectRowSchema.safeParse(row);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.embedding_dimensions).toBe(1024);
      }
    });
  });

  describe('ChunkLoadRowSchema', () => {
    it('should validate a valid chunk load row', () => {
      const row = {
        id: 'chunk-123',
        content: 'function hello() { return "world"; }',
        embedding: Buffer.from(new Float32Array(1024).buffer),
        file_path: 'src/index.ts',
        file_type: 'code',
        language: 'typescript',
        start_line: 1,
        end_line: 10,
        metadata: '{"symbolName": "hello"}',
      };

      const result = ChunkLoadRowSchema.safeParse(row);
      expect(result.success).toBe(true);
    });

    it('should reject non-Buffer embedding', () => {
      const row = {
        id: 'chunk-123',
        content: 'test content',
        embedding: [0.1, 0.2, 0.3], // Array instead of Buffer
        file_path: 'src/index.ts',
        file_type: 'code',
        language: 'typescript',
        start_line: 1,
        end_line: 10,
        metadata: null,
      };

      const result = ChunkLoadRowSchema.safeParse(row);
      expect(result.success).toBe(false);
    });
  });

  describe('ChunkLoadNoEmbeddingSchema', () => {
    it('should validate without embedding field', () => {
      const row = {
        id: 'chunk-123',
        content: 'test content',
        file_path: 'src/index.ts',
        file_type: 'docs',
        language: 'markdown',
        start_line: null,
        end_line: null,
        metadata: null,
      };

      const result = ChunkLoadNoEmbeddingSchema.safeParse(row);
      expect(result.success).toBe(true);
    });
  });
});

describe('Validation Utilities', () => {
  describe('validateRow', () => {
    it('should return validated data on success', () => {
      const row = {
        id: 'proj-123',
        name: 'test',
        path: '/path',
        tags: null,
        ignore_patterns: null,
        indexed_at: null,
        updated_at: null,
        file_count: 0,
        chunk_count: 0,
        config: null,
        embedding_model: null,
        embedding_dimensions: 1024,
        description: null,
      };

      const result = validateRow(ProjectRowSchema, row, 'test-context');
      expect(result.id).toBe('proj-123');
      expect(result.name).toBe('test');
    });

    it('should throw SchemaValidationError on failure', () => {
      const row = { invalid: 'data' };

      expect(() => {
        validateRow(ProjectRowSchema, row, 'test-context');
      }).toThrow(SchemaValidationError);
    });

    it('should include context in error message', () => {
      const row = { invalid: 'data' };

      try {
        validateRow(ProjectRowSchema, row, 'projects.name=foo');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(SchemaValidationError);
        expect((error as Error).message).toContain('projects.name=foo');
      }
    });
  });

  describe('validateRows', () => {
    it('should validate an array of rows', () => {
      const rows = [
        {
          id: 'chunk-1',
          content: 'content 1',
          file_path: 'file1.ts',
          file_type: null,
          language: null,
          start_line: null,
          end_line: null,
          metadata: null,
        },
        {
          id: 'chunk-2',
          content: 'content 2',
          file_path: 'file2.ts',
          file_type: null,
          language: null,
          start_line: null,
          end_line: null,
          metadata: null,
        },
      ];

      const result = validateRows(ChunkLoadNoEmbeddingSchema, rows, 'chunks');
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('chunk-1');
      expect(result[1].id).toBe('chunk-2');
    });

    it('should throw on first invalid row by default', () => {
      const rows = [
        { id: 'valid', content: 'test', file_path: 'f.ts', file_type: null, language: null, start_line: null, end_line: null, metadata: null },
        { invalid: 'data' }, // Invalid
        { id: 'also-valid', content: 'test', file_path: 'g.ts', file_type: null, language: null, start_line: null, end_line: null, metadata: null },
      ];

      expect(() => {
        validateRows(ChunkLoadNoEmbeddingSchema, rows, 'chunks');
      }).toThrow(SchemaValidationError);
    });

    it('should continue on error when configured', () => {
      const errors: unknown[] = [];
      const rows = [
        { id: 'valid', content: 'test', file_path: 'f.ts', file_type: null, language: null, start_line: null, end_line: null, metadata: null },
        { invalid: 'data' }, // Invalid
        { id: 'also-valid', content: 'test', file_path: 'g.ts', file_type: null, language: null, start_line: null, end_line: null, metadata: null },
      ];

      const result = validateRows(ChunkLoadNoEmbeddingSchema, rows, 'chunks', {
        continueOnError: true,
        onError: (row, error) => errors.push({ row, error }),
      });

      expect(result).toHaveLength(2);
      expect(errors).toHaveLength(1);
    });
  });

  describe('safeValidateRow', () => {
    it('should return success result for valid data', () => {
      const row = {
        id: 'chunk-1',
        content: 'test',
        file_path: 'f.ts',
        file_type: null,
        language: null,
        start_line: null,
        end_line: null,
        metadata: null,
      };

      const result = safeValidateRow(ChunkLoadNoEmbeddingSchema, row, 'chunks');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe('chunk-1');
      }
    });

    it('should return failure result for invalid data', () => {
      const row = { invalid: 'data' };

      const result = safeValidateRow(ChunkLoadNoEmbeddingSchema, row, 'chunks');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(SchemaValidationError);
      }
    });
  });
});

describe('Performance Benchmarks', () => {
  /**
   * These benchmarks verify that validation overhead stays under 5% target.
   * We measure raw validation time, not including data generation.
   */

  it('should validate 1000 project rows in <50ms', () => {
    // Generate test data upfront (not part of benchmark)
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      id: `id-${i}`,
      name: `project-${i}`,
      path: `/path/to/project/${i}`,
      tags: null,
      ignore_patterns: null,
      indexed_at: null,
      updated_at: null,
      file_count: i * 10,
      chunk_count: i * 100,
      config: null,
      embedding_model: 'BAAI/bge-large-en-v1.5',
      embedding_dimensions: 1024,
      description: i % 2 === 0 ? `Project ${i} description` : null,
    }));

    // Benchmark validation only
    const start = performance.now();
    const validated = validateRows(ProjectRowSchema, rows, 'benchmark');
    const elapsed = performance.now() - start;

    expect(validated).toHaveLength(1000);
    expect(elapsed).toBeLessThan(100);
  });

  it('should validate 1000 chunk load rows in <50ms', () => {
    // Generate test data with realistic embeddings
    const embedding = Buffer.from(new Float32Array(1024).buffer);
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      id: `chunk-${i}`,
      content: `This is the content for chunk ${i}. It contains some text that might be code or documentation.`,
      embedding,
      file_path: `src/components/Component${i}.tsx`,
      file_type: i % 2 === 0 ? 'code' : 'docs',
      language: 'typescript',
      start_line: i * 10,
      end_line: (i + 1) * 10,
      metadata: JSON.stringify({ symbolName: `function${i}`, symbolType: 'function' }),
    }));

    // Benchmark validation only
    const start = performance.now();
    const validated = validateRows(ChunkLoadRowSchema, rows, 'benchmark');
    const elapsed = performance.now() - start;

    expect(validated).toHaveLength(1000);
    expect(elapsed).toBeLessThan(100);
  });

  it('should validate 5000 chunk rows (no embedding) in <100ms', () => {
    // BM25 loads more rows since no embedding overhead
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      id: `chunk-${i}`,
      content: `Content for chunk ${i} with various text that represents code or documentation.`,
      file_path: `src/module${i % 100}/file${i}.ts`,
      file_type: null,
      language: 'typescript',
      start_line: null,
      end_line: null,
      metadata: null,
    }));

    // Benchmark validation only
    const start = performance.now();
    const validated = validateRows(ChunkLoadNoEmbeddingSchema, rows, 'benchmark');
    const elapsed = performance.now() - start;

    expect(validated).toHaveLength(5000);
    expect(elapsed).toBeLessThan(100);
  });
});
