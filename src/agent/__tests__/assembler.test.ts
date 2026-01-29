/**
 * Assembler Factory Tests
 *
 * Tests for the createAssembler factory function.
 * Validates configuration handling, input validation, and SDK integration.
 */

import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { XMLAssembler } from '@contextaisdk/rag';
import {
  createAssembler,
  DEFAULT_ASSEMBLER_CONFIG,
  AssemblerOptionsSchema,
  type AssemblerOptions,
} from '../assembler.js';

describe('createAssembler', () => {
  describe('factory function', () => {
    it('should return an XMLAssembler instance', () => {
      const assembler = createAssembler();
      expect(assembler).toBeInstanceOf(XMLAssembler);
    });

    it('should work without any options (uses defaults)', () => {
      const assembler = createAssembler();
      expect(assembler).toBeDefined();
      expect(assembler.name).toBe('XMLAssembler');
    });

    it('should accept partial options', () => {
      const assembler = createAssembler({ maxTokens: 8000 });
      expect(assembler).toBeInstanceOf(XMLAssembler);
    });

    it('should accept all options', () => {
      const options: AssemblerOptions = {
        maxTokens: 6000,
        ordering: 'relevance',
        deduplicationThreshold: 0.9,
        includeScores: true,
      };
      const assembler = createAssembler(options);
      expect(assembler).toBeInstanceOf(XMLAssembler);
    });
  });

  describe('DEFAULT_ASSEMBLER_CONFIG', () => {
    it('should have expected default values', () => {
      expect(DEFAULT_ASSEMBLER_CONFIG).toEqual({
        maxTokens: 4000,
        ordering: 'sandwich',
        deduplicationThreshold: 0.8,
        includeScores: false,
      });
    });

    it('should be a complete configuration (all fields defined)', () => {
      // TypeScript enforces Required<AssemblerOptions>, but let's verify at runtime
      expect(DEFAULT_ASSEMBLER_CONFIG.maxTokens).toBeDefined();
      expect(DEFAULT_ASSEMBLER_CONFIG.ordering).toBeDefined();
      expect(DEFAULT_ASSEMBLER_CONFIG.deduplicationThreshold).toBeDefined();
      expect(DEFAULT_ASSEMBLER_CONFIG.includeScores).toBeDefined();
    });
  });

  describe('ordering strategies', () => {
    it('should accept "sandwich" ordering', () => {
      const assembler = createAssembler({ ordering: 'sandwich' });
      expect(assembler).toBeInstanceOf(XMLAssembler);
    });

    it('should accept "relevance" ordering', () => {
      const assembler = createAssembler({ ordering: 'relevance' });
      expect(assembler).toBeInstanceOf(XMLAssembler);
    });

    it('should accept "chronological" ordering', () => {
      const assembler = createAssembler({ ordering: 'chronological' });
      expect(assembler).toBeInstanceOf(XMLAssembler);
    });
  });

  describe('token budget', () => {
    it('should accept custom maxTokens', () => {
      const assembler = createAssembler({ maxTokens: 2000 });
      expect(assembler).toBeInstanceOf(XMLAssembler);
    });

    it('should accept large token budgets', () => {
      const assembler = createAssembler({ maxTokens: 16000 });
      expect(assembler).toBeInstanceOf(XMLAssembler);
    });
  });

  describe('deduplication', () => {
    it('should accept custom deduplication threshold', () => {
      const assembler = createAssembler({ deduplicationThreshold: 0.7 });
      expect(assembler).toBeInstanceOf(XMLAssembler);
    });

    it('should accept threshold at boundaries', () => {
      expect(() => createAssembler({ deduplicationThreshold: 0 })).not.toThrow();
      expect(() => createAssembler({ deduplicationThreshold: 1 })).not.toThrow();
    });
  });

  describe('score inclusion', () => {
    it('should accept includeScores: true', () => {
      const assembler = createAssembler({ includeScores: true });
      expect(assembler).toBeInstanceOf(XMLAssembler);
    });

    it('should accept includeScores: false', () => {
      const assembler = createAssembler({ includeScores: false });
      expect(assembler).toBeInstanceOf(XMLAssembler);
    });
  });

  describe('input validation', () => {
    it('should throw ZodError for negative maxTokens', () => {
      expect(() => createAssembler({ maxTokens: -100 })).toThrow(ZodError);
    });

    it('should throw ZodError for maxTokens below minimum (100)', () => {
      expect(() => createAssembler({ maxTokens: 50 })).toThrow(ZodError);
    });

    it('should throw ZodError for maxTokens above maximum (32000)', () => {
      expect(() => createAssembler({ maxTokens: 50000 })).toThrow(ZodError);
    });

    it('should throw ZodError for non-integer maxTokens', () => {
      expect(() => createAssembler({ maxTokens: 1000.5 })).toThrow(ZodError);
    });

    it('should throw ZodError for deduplicationThreshold below 0', () => {
      expect(() => createAssembler({ deduplicationThreshold: -0.1 })).toThrow(ZodError);
    });

    it('should throw ZodError for deduplicationThreshold above 1', () => {
      expect(() => createAssembler({ deduplicationThreshold: 1.5 })).toThrow(ZodError);
    });

    it('should throw ZodError for invalid ordering strategy', () => {
      // @ts-expect-error - Testing runtime validation of invalid value
      expect(() => createAssembler({ ordering: 'invalid' })).toThrow(ZodError);
    });

    it('should provide helpful error message for invalid maxTokens', () => {
      try {
        createAssembler({ maxTokens: -100 });
      } catch (error) {
        expect(error).toBeInstanceOf(ZodError);
        const zodError = error as ZodError;
        expect(zodError.errors[0].message).toContain('100');
      }
    });
  });

  describe('AssemblerOptionsSchema', () => {
    it('should validate valid options', () => {
      const result = AssemblerOptionsSchema.safeParse({
        maxTokens: 4000,
        ordering: 'sandwich',
        deduplicationThreshold: 0.8,
        includeScores: false,
      });
      expect(result.success).toBe(true);
    });

    it('should validate empty options (all optional)', () => {
      const result = AssemblerOptionsSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should reject invalid ordering', () => {
      const result = AssemblerOptionsSchema.safeParse({ ordering: 'random' });
      expect(result.success).toBe(false);
    });
  });

  describe('configuration behavior', () => {
    it('should create assembler with "sources" root tag', async () => {
      const assembler = createAssembler();

      // Assemble minimal input to verify XML structure
      const result = await assembler.assemble([
        {
          id: 'test-1',
          chunk: {
            id: 'test-1',
            content: 'Test content',
            metadata: { filePath: 'test.ts', startLine: 1, endLine: 10 },
          },
          score: 0.9,
        },
      ]);

      expect(result.content).toContain('<sources>');
      expect(result.content).toContain('</sources>');
    });

    it('should create assembler with "source" tags for each chunk', async () => {
      const assembler = createAssembler();

      const result = await assembler.assemble([
        {
          id: 'test-1',
          chunk: {
            id: 'test-1',
            content: 'Test content',
            metadata: { filePath: 'test.ts' },
          },
          score: 0.9,
        },
      ]);

      expect(result.content).toContain('<source');
      expect(result.content).toContain('</source>');
    });

    it('should include file path in output', async () => {
      const assembler = createAssembler();

      const result = await assembler.assemble([
        {
          id: 'test-1',
          chunk: {
            id: 'test-1',
            content: 'Test content',
            metadata: { filePath: 'src/auth.ts' },
          },
          score: 0.9,
        },
      ]);

      expect(result.content).toContain('src/auth.ts');
    });

    it('should respect token budget', async () => {
      // Create assembler with very small budget
      const assembler = createAssembler({ maxTokens: 100 });

      // Try to assemble large content
      const largeContent = 'x'.repeat(1000); // ~250 tokens
      const result = await assembler.assemble([
        {
          id: 'test-1',
          chunk: {
            id: 'test-1',
            content: largeContent,
            metadata: { filePath: 'test.ts' },
          },
          score: 0.9,
        },
      ]);

      // Token estimate should be within budget
      expect(result.estimatedTokens).toBeLessThanOrEqual(150); // Some overhead
    });

    it('should not include scores when includeScores is false', async () => {
      const assembler = createAssembler({ includeScores: false });

      const result = await assembler.assemble([
        {
          id: 'test-1',
          chunk: {
            id: 'test-1',
            content: 'Test content',
            metadata: { filePath: 'test.ts' },
          },
          score: 0.95,
        },
      ]);

      // Should not have score attribute
      expect(result.content).not.toContain('score="0.95"');
    });

    it('should include scores when includeScores is true', async () => {
      const assembler = createAssembler({ includeScores: true });

      const result = await assembler.assemble([
        {
          id: 'test-1',
          chunk: {
            id: 'test-1',
            content: 'Test content',
            metadata: { filePath: 'test.ts' },
          },
          score: 0.95,
        },
      ]);

      // Should have score attribute
      expect(result.content).toContain('score=');
    });
  });
});
