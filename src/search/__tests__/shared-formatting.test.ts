/**
 * Shared Formatting Utilities Tests
 *
 * Tests for formatSearchResult and matchesFilters utility functions.
 * These are pure functions used by all search services, so testing them
 * thoroughly ensures consistent behavior across the search pipeline.
 */

import { describe, it, expect } from 'vitest';

import { formatSearchResult, matchesFilters } from '../shared-formatting.js';
import type { SearchResultWithContext, SearchQueryOptions } from '../types.js';

describe('formatSearchResult', () => {
  describe('basic formatting', () => {
    it('should format result with complete metadata', () => {
      const result = formatSearchResult('chunk-1', 0.85, 'function auth() {}', {
        filePath: 'src/auth.ts',
        fileType: 'code',
        language: 'typescript',
        startLine: 10,
        endLine: 20,
        projectId: 'proj-1',
      });

      expect(result).toEqual({
        id: 'chunk-1',
        score: 0.85,
        content: 'function auth() {}',
        filePath: 'src/auth.ts',
        fileType: 'code',
        language: 'typescript',
        lineRange: { start: 10, end: 20 },
        metadata: {
          filePath: 'src/auth.ts',
          fileType: 'code',
          language: 'typescript',
          startLine: 10,
          endLine: 20,
          projectId: 'proj-1',
        },
      });
    });
  });

  describe('edge cases - missing metadata', () => {
    it('should handle undefined metadata gracefully', () => {
      const result = formatSearchResult('chunk-1', 0.5, 'some content', undefined);

      expect(result.filePath).toBe('');
      expect(result.fileType).toBe('unknown');
      expect(result.language).toBeNull();
      expect(result.lineRange).toEqual({ start: 0, end: 0 });
      expect(result.metadata).toEqual({});
    });

    it('should handle empty object metadata', () => {
      const result = formatSearchResult('chunk-1', 0.5, 'some content', {});

      expect(result.filePath).toBe('');
      expect(result.fileType).toBe('unknown');
      expect(result.language).toBeNull();
      expect(result.lineRange).toEqual({ start: 0, end: 0 });
    });

    it('should handle metadata with only some fields', () => {
      const result = formatSearchResult('chunk-1', 0.5, 'content', {
        filePath: 'src/file.ts',
        // Missing: fileType, language, startLine, endLine
      });

      expect(result.filePath).toBe('src/file.ts');
      expect(result.fileType).toBe('unknown');
      expect(result.language).toBeNull();
      expect(result.lineRange).toEqual({ start: 0, end: 0 });
    });

    it('should preserve all metadata fields in metadata property', () => {
      const customMetadata = {
        filePath: 'src/file.ts',
        customField: 'custom value',
        nestedObject: { key: 'value' },
      };

      const result = formatSearchResult('chunk-1', 0.5, 'content', customMetadata);

      expect(result.metadata).toEqual(customMetadata);
      expect(result.metadata.customField).toBe('custom value');
    });
  });

  describe('edge cases - unusual values', () => {
    it('should handle zero line numbers', () => {
      const result = formatSearchResult('chunk-1', 0.5, 'content', {
        startLine: 0,
        endLine: 0,
      });

      expect(result.lineRange).toEqual({ start: 0, end: 0 });
    });

    it('should handle negative line numbers', () => {
      // This is invalid data, but should not crash
      const result = formatSearchResult('chunk-1', 0.5, 'content', {
        startLine: -1,
        endLine: -5,
      });

      expect(result.lineRange).toEqual({ start: -1, end: -5 });
    });

    it('should handle very large line numbers', () => {
      const result = formatSearchResult('chunk-1', 0.5, 'content', {
        startLine: 999999,
        endLine: 1000000,
      });

      expect(result.lineRange).toEqual({ start: 999999, end: 1000000 });
    });

    it('should handle empty string content', () => {
      const result = formatSearchResult('chunk-1', 0.5, '', {});

      expect(result.content).toBe('');
    });

    it('should handle Unicode in file paths', () => {
      const result = formatSearchResult('chunk-1', 0.5, 'content', {
        filePath: 'src/认证/身份验证.ts', // Chinese characters
      });

      expect(result.filePath).toBe('src/认证/身份验证.ts');
    });

    it('should handle null language explicitly', () => {
      const result = formatSearchResult('chunk-1', 0.5, 'content', {
        language: null,
      });

      expect(result.language).toBeNull();
    });

    it('should handle score of 0', () => {
      const result = formatSearchResult('chunk-1', 0, 'content', {});

      expect(result.score).toBe(0);
    });

    it('should handle score of 1', () => {
      const result = formatSearchResult('chunk-1', 1, 'content', {});

      expect(result.score).toBe(1);
    });
  });
});

describe('matchesFilters', () => {
  // Helper to create a minimal valid result
  const createResult = (
    overrides: Partial<SearchResultWithContext> = {}
  ): SearchResultWithContext => ({
    id: 'chunk-1',
    score: 0.8,
    content: 'test content',
    filePath: 'src/test.ts',
    fileType: 'code',
    language: 'typescript',
    lineRange: { start: 1, end: 10 },
    metadata: { projectId: 'proj-1' },
    ...overrides,
  });

  describe('no filters', () => {
    it('should return true when no filters provided', () => {
      const result = createResult();
      expect(matchesFilters(result, {})).toBe(true);
    });

    it('should return true with empty options object', () => {
      const result = createResult();
      expect(matchesFilters(result, {} as SearchQueryOptions)).toBe(true);
    });
  });

  describe('fileType filter', () => {
    it('should match when fileType matches', () => {
      const result = createResult({ fileType: 'code' });
      expect(matchesFilters(result, { fileType: 'code' })).toBe(true);
    });

    it('should not match when fileType differs', () => {
      const result = createResult({ fileType: 'code' });
      expect(matchesFilters(result, { fileType: 'docs' })).toBe(false);
    });

    it('should match unknown fileType when filtering for unknown', () => {
      const result = createResult({ fileType: 'unknown' });
      expect(matchesFilters(result, { fileType: 'unknown' as 'code' })).toBe(true);
    });
  });

  describe('language filter', () => {
    it('should match when language matches', () => {
      const result = createResult({ language: 'typescript' });
      expect(matchesFilters(result, { language: 'typescript' })).toBe(true);
    });

    it('should not match when language differs', () => {
      const result = createResult({ language: 'typescript' });
      expect(matchesFilters(result, { language: 'python' })).toBe(false);
    });

    it('should not match when result language is null', () => {
      const result = createResult({ language: null });
      expect(matchesFilters(result, { language: 'typescript' })).toBe(false);
    });
  });

  describe('projectIds filter', () => {
    it('should match when projectId in filter list', () => {
      const result = createResult({ metadata: { projectId: 'proj-1' } });
      expect(matchesFilters(result, { projectIds: ['proj-1'] })).toBe(true);
    });

    it('should match when projectId is one of multiple', () => {
      const result = createResult({ metadata: { projectId: 'proj-2' } });
      expect(matchesFilters(result, { projectIds: ['proj-1', 'proj-2', 'proj-3'] })).toBe(
        true
      );
    });

    it('should not match when projectId not in filter list', () => {
      const result = createResult({ metadata: { projectId: 'proj-other' } });
      expect(matchesFilters(result, { projectIds: ['proj-1', 'proj-2'] })).toBe(false);
    });

    it('should not match when result has no projectId in metadata', () => {
      const result = createResult({ metadata: {} });
      expect(matchesFilters(result, { projectIds: ['proj-1'] })).toBe(false);
    });

    it('should not match when result metadata is undefined projectId', () => {
      const result = createResult({ metadata: { projectId: undefined } });
      expect(matchesFilters(result, { projectIds: ['proj-1'] })).toBe(false);
    });

    it('should return true when projectIds array is empty', () => {
      // Empty array means "no filter" - don't filter out anything
      const result = createResult({ metadata: { projectId: 'proj-1' } });
      expect(matchesFilters(result, { projectIds: [] })).toBe(true);
    });
  });

  describe('minScore filter', () => {
    it('should match when score equals minScore', () => {
      const result = createResult({ score: 0.5 });
      expect(matchesFilters(result, { minScore: 0.5 })).toBe(true);
    });

    it('should match when score exceeds minScore', () => {
      const result = createResult({ score: 0.8 });
      expect(matchesFilters(result, { minScore: 0.5 })).toBe(true);
    });

    it('should not match when score below minScore', () => {
      const result = createResult({ score: 0.3 });
      expect(matchesFilters(result, { minScore: 0.5 })).toBe(false);
    });

    it('should handle minScore of 0', () => {
      const result = createResult({ score: 0 });
      expect(matchesFilters(result, { minScore: 0 })).toBe(true);
    });

    it('should handle minScore of 1', () => {
      const result = createResult({ score: 0.99 });
      expect(matchesFilters(result, { minScore: 1 })).toBe(false);
    });

    it('should match perfect score with minScore of 1', () => {
      const result = createResult({ score: 1 });
      expect(matchesFilters(result, { minScore: 1 })).toBe(true);
    });
  });

  describe('combined filters (AND logic)', () => {
    it('should require all filters to pass', () => {
      const result = createResult({
        fileType: 'code',
        language: 'typescript',
        score: 0.8,
        metadata: { projectId: 'proj-1' },
      });

      expect(
        matchesFilters(result, {
          fileType: 'code',
          language: 'typescript',
          minScore: 0.5,
          projectIds: ['proj-1'],
        })
      ).toBe(true);
    });

    it('should fail if any filter fails', () => {
      const result = createResult({
        fileType: 'code',
        language: 'typescript',
        score: 0.8,
        metadata: { projectId: 'proj-1' },
      });

      // Fails language filter
      expect(
        matchesFilters(result, {
          fileType: 'code',
          language: 'python', // Mismatch!
          minScore: 0.5,
          projectIds: ['proj-1'],
        })
      ).toBe(false);
    });

    it('should fail early on first filter mismatch', () => {
      const result = createResult({
        fileType: 'docs', // Mismatch on first filter
        language: 'markdown',
        score: 0.9,
        metadata: { projectId: 'proj-1' },
      });

      expect(
        matchesFilters(result, {
          fileType: 'code',
          language: 'typescript',
          minScore: 0.5,
          projectIds: ['proj-1'],
        })
      ).toBe(false);
    });
  });
});
