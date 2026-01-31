/**
 * Search Result Formatter Tests
 *
 * Tests for the search result formatting utilities.
 * Covers text output, JSON output, and edge cases.
 */

import { describe, it, expect } from 'vitest';

import {
  formatResult,
  formatResults,
  formatResultJSON,
  formatResultsJSON,
  formatScore,
  truncateSnippet,
} from '../formatter.js';
import type { SearchResultWithContext } from '../types.js';

// ============================================================================
// Test Fixtures
// ============================================================================

/**
 * Create a mock search result for testing.
 */
function createMockResult(overrides: Partial<SearchResultWithContext> = {}): SearchResultWithContext {
  return {
    id: 'chunk-1',
    score: 0.92,
    content: 'Implements the hybrid search pipeline using dense vectors and BM25.',
    filePath: 'src/search/retriever.ts',
    fileType: 'code',
    language: 'typescript',
    lineRange: { start: 45, end: 67 },
    metadata: {},
    ...overrides,
  };
}

// ============================================================================
// formatScore Tests
// ============================================================================

describe('formatScore', () => {
  it('should format score with 2 decimal places', () => {
    expect(formatScore(0.92)).toBe('0.92');
    expect(formatScore(0.9234)).toBe('0.92');
    expect(formatScore(0.9999)).toBe('1.00');
  });

  it('should pad with zeros when needed', () => {
    expect(formatScore(0.1)).toBe('0.10');
    expect(formatScore(0)).toBe('0.00');
    expect(formatScore(1)).toBe('1.00');
  });

  it('should handle edge cases', () => {
    expect(formatScore(0.005)).toBe('0.01'); // Rounds up
    expect(formatScore(0.004)).toBe('0.00'); // Rounds down
  });
});

// ============================================================================
// truncateSnippet Tests
// ============================================================================

describe('truncateSnippet', () => {
  it('should not truncate content shorter than max length', () => {
    expect(truncateSnippet('Hello world', 20)).toBe('Hello world');
  });

  it('should truncate content longer than max length with ellipsis', () => {
    expect(truncateSnippet('Hello world', 5)).toBe('Hello...');
  });

  it('should collapse newlines to spaces', () => {
    expect(truncateSnippet('Line 1\nLine 2\nLine 3', 50))
      .toBe('Line 1 Line 2 Line 3');
  });

  it('should collapse multiple spaces', () => {
    expect(truncateSnippet('Word1    Word2', 50)).toBe('Word1 Word2');
  });

  it('should trim leading and trailing whitespace', () => {
    expect(truncateSnippet('  Hello  ', 50)).toBe('Hello');
  });

  it('should use default length of 200', () => {
    const longContent = 'x'.repeat(250);
    const result = truncateSnippet(longContent);
    expect(result).toBe('x'.repeat(200) + '...');
  });

  it('should handle empty content', () => {
    expect(truncateSnippet('')).toBe('');
    expect(truncateSnippet('   ')).toBe('');
  });

  it('should handle content with mixed whitespace', () => {
    expect(truncateSnippet('Hello\n\n\t  World', 50)).toBe('Hello World');
  });
});

// ============================================================================
// formatResult Tests (Text Output)
// ============================================================================

describe('formatResult', () => {
  it('should format result with score and line range', () => {
    const result = createMockResult();
    const formatted = formatResult(result);

    expect(formatted).toContain('[0.92]');
    expect(formatted).toContain('src/search/retriever.ts:45-67');
    expect(formatted).toContain('Implements the hybrid search pipeline');
  });

  it('should format with single line number when start equals end', () => {
    const result = createMockResult({
      lineRange: { start: 42, end: 42 },
    });
    const formatted = formatResult(result);

    expect(formatted).toContain(':42');
    expect(formatted).not.toContain(':42-42');
  });

  it('should indent snippet on second line', () => {
    const result = createMockResult();
    const lines = formatResult(result).split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^\s{2}/); // 2-space indent
  });

  it('should truncate long snippets', () => {
    const result = createMockResult({
      content: 'x'.repeat(300),
    });
    const formatted = formatResult(result, { snippetLength: 50 });

    expect(formatted).toContain('x'.repeat(50) + '...');
  });

  it('should hide score when showScore is false', () => {
    const result = createMockResult();
    const formatted = formatResult(result, { showScore: false });

    expect(formatted).not.toContain('[0.92]');
    expect(formatted).toContain('src/search/retriever.ts:45-67');
  });

  it('should hide line numbers when showLineNumbers is false', () => {
    const result = createMockResult();
    const formatted = formatResult(result, { showLineNumbers: false });

    expect(formatted).toContain('src/search/retriever.ts');
    expect(formatted).not.toContain(':45-67');
  });

  it('should show project name when showProject is true and metadata has projectId', () => {
    const result = createMockResult({
      metadata: { projectId: 'my-project' },
    });
    const formatted = formatResult(result, { showProject: true });

    expect(formatted).toContain('[my-project]');
  });

  it('should not show project name when metadata lacks projectId', () => {
    const result = createMockResult();
    const formatted = formatResult(result, { showProject: true });

    expect(formatted).not.toContain('[undefined]');
    expect(formatted).not.toContain('[]');
  });

  it('should handle zero line numbers gracefully', () => {
    const result = createMockResult({
      lineRange: { start: 0, end: 0 },
    });
    const formatted = formatResult(result);

    // Should not show ":0" for zero line numbers
    expect(formatted).not.toContain(':0');
    expect(formatted).toContain('src/search/retriever.ts');
  });
});

// ============================================================================
// formatResults Tests (Multiple Results)
// ============================================================================

describe('formatResults', () => {
  it('should format multiple results separated by blank lines', () => {
    const results = [
      createMockResult({ score: 0.92 }),
      createMockResult({ score: 0.87, filePath: 'src/other.ts' }),
    ];
    const formatted = formatResults(results);

    expect(formatted).toContain('[0.92]');
    expect(formatted).toContain('[0.87]');
    expect(formatted).toContain('\n\n'); // Blank line separator
  });

  it('should return empty string for empty array', () => {
    expect(formatResults([])).toBe('');
  });

  it('should apply options to all results', () => {
    const results = [
      createMockResult(),
      createMockResult(),
    ];
    const formatted = formatResults(results, { showScore: false });

    expect(formatted).not.toContain('[0.92]');
  });
});

// ============================================================================
// formatResultJSON Tests
// ============================================================================

describe('formatResultJSON', () => {
  it('should return all required fields', () => {
    const result = createMockResult();
    const json = formatResultJSON(result);

    expect(json.score).toBe(0.92);
    expect(json.filePath).toBe('src/search/retriever.ts');
    expect(json.lineStart).toBe(45);
    expect(json.lineEnd).toBe(67);
    expect(json.content).toContain('hybrid search pipeline');
    expect(json.language).toBe('typescript');
    expect(json.fileType).toBe('code');
  });

  it('should flatten lineRange to lineStart and lineEnd', () => {
    const result = createMockResult();
    const json = formatResultJSON(result);

    expect(json).toHaveProperty('lineStart');
    expect(json).toHaveProperty('lineEnd');
    expect(json).not.toHaveProperty('lineRange');
  });

  it('should include projectId when showProject is true', () => {
    const result = createMockResult({
      metadata: { projectId: 'test-project' },
    });
    const json = formatResultJSON(result, { showProject: true });

    expect(json.projectId).toBe('test-project');
  });

  it('should not include projectId when showProject is false', () => {
    const result = createMockResult({
      metadata: { projectId: 'test-project' },
    });
    const json = formatResultJSON(result, { showProject: false });

    expect(json.projectId).toBeUndefined();
  });

  it('should handle null language', () => {
    const result = createMockResult({
      language: null,
      fileType: 'docs',
    });
    const json = formatResultJSON(result);

    expect(json.language).toBeNull();
  });

  it('should preserve all fileType values', () => {
    const fileTypes: Array<'code' | 'docs' | 'config' | 'unknown'> = [
      'code', 'docs', 'config', 'unknown'
    ];

    for (const fileType of fileTypes) {
      const result = createMockResult({ fileType });
      const json = formatResultJSON(result);
      expect(json.fileType).toBe(fileType);
    }
  });
});

// ============================================================================
// formatResultsJSON Tests
// ============================================================================

describe('formatResultsJSON', () => {
  it('should format multiple results as array', () => {
    const results = [
      createMockResult({ score: 0.92 }),
      createMockResult({ score: 0.87 }),
    ];
    const json = formatResultsJSON(results);

    expect(json).toHaveLength(2);
    expect(json[0]!.score).toBe(0.92);
    expect(json[1]!.score).toBe(0.87);
  });

  it('should return empty array for empty input', () => {
    expect(formatResultsJSON([])).toEqual([]);
  });

  it('should apply options to all results', () => {
    const results = [
      createMockResult({ metadata: { projectId: 'proj-a' } }),
      createMockResult({ metadata: { projectId: 'proj-b' } }),
    ];
    const json = formatResultsJSON(results, { showProject: true });

    expect(json[0]!.projectId).toBe('proj-a');
    expect(json[1]!.projectId).toBe('proj-b');
  });
});

// ============================================================================
// Edge Cases and Integration Tests
// ============================================================================

describe('edge cases', () => {
  it('should handle content with special characters', () => {
    const result = createMockResult({
      content: 'function<T>(x: T[]): T | undefined { return x[0]; }',
    });

    const text = formatResult(result);
    const json = formatResultJSON(result);

    expect(text).toContain('function<T>');
    expect(json.content).toContain('function<T>');
  });

  it('should handle very long file paths', () => {
    const result = createMockResult({
      filePath: 'packages/context-expert/src/very/deep/nested/directory/structure/file.ts',
    });

    const text = formatResult(result);
    expect(text).toContain('packages/context-expert/src/very/deep/nested');
  });

  it('should handle zero score', () => {
    const result = createMockResult({ score: 0 });

    expect(formatResult(result)).toContain('[0.00]');
    expect(formatResultJSON(result).score).toBe(0);
  });

  it('should handle perfect score', () => {
    const result = createMockResult({ score: 1 });

    expect(formatResult(result)).toContain('[1.00]');
    expect(formatResultJSON(result).score).toBe(1);
  });

  it('should handle empty filePath', () => {
    const result = createMockResult({ filePath: '' });

    const text = formatResult(result);
    const json = formatResultJSON(result);

    // Should not crash with empty path
    expect(text).toBeDefined();
    expect(json.filePath).toBe('');
  });

  it('should handle negative line numbers', () => {
    const result = createMockResult({
      lineRange: { start: -1, end: -5 },
    });

    // Should handle gracefully even though this is invalid data
    const text = formatResult(result);
    expect(text).toBeDefined();
  });

  it('should handle Unicode in file paths', () => {
    const result = createMockResult({
      filePath: 'src/认证/身份验证/認證.ts',
    });

    const text = formatResult(result);
    const json = formatResultJSON(result);

    expect(text).toContain('认证');
    expect(json.filePath).toBe('src/认证/身份验证/認證.ts');
  });

  it('should handle very high line numbers', () => {
    const result = createMockResult({
      lineRange: { start: 999999, end: 1000000 },
    });

    const text = formatResult(result);
    const json = formatResultJSON(result);

    expect(text).toContain('999999-1000000');
    expect(json.lineStart).toBe(999999);
    expect(json.lineEnd).toBe(1000000);
  });

  it('should handle content with only whitespace', () => {
    const result = createMockResult({
      content: '   \t\n   \r\n   ',
    });

    const text = formatResult(result);
    // Whitespace should be collapsed/normalized
    expect(text).toBeDefined();
  });

  it('should handle content with emojis', () => {
    const result = createMockResult({
      content: '// TODO: 🚀 implement this feature 💡',
    });

    const text = formatResult(result);
    const json = formatResultJSON(result);

    expect(text).toContain('🚀');
    expect(json.content).toContain('💡');
  });
});
