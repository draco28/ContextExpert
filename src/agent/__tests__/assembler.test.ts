/**
 * Assembler Factory Tests
 *
 * Tests for the createAssembler factory function.
 * Validates configuration handling and SDK integration.
 */

import { describe, it, expect } from 'vitest';
import { XMLAssembler } from '@contextaisdk/rag';
import {
  createAssembler,
  DEFAULT_ASSEMBLER_CONFIG,
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
});
