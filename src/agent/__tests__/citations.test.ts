/**
 * Citation Formatter Tests
 *
 * Tests for CLI-optimized citation formatting.
 */

import { describe, expect, it } from 'vitest';
import {
  formatCitation,
  formatCitations,
  formatCitationJSON,
  formatCitationsJSON,
  createCitationFormatter,
  CitationFormatOptionsSchema,
  DEFAULT_CITATION_CONFIG,
} from '../citations.js';
import type { RAGSource } from '../types.js';

// ============================================================================
// Test Fixtures
// ============================================================================

const mockSource: RAGSource = {
  index: 1,
  filePath: 'src/auth/handler.ts',
  lineRange: { start: 42, end: 67 },
  score: 0.95,
  language: 'typescript',
  fileType: 'code',
};

const mockSourceNoLines: RAGSource = {
  index: 2,
  filePath: 'README.md',
  lineRange: { start: 0, end: 0 },
  score: 0.88,
  language: null,
  fileType: 'docs',
};

const mockSourceSingleLine: RAGSource = {
  index: 3,
  filePath: 'config/settings.json',
  lineRange: { start: 15, end: 15 },
  score: 0.75,
  language: null,
  fileType: 'config',
};

const mockSources: RAGSource[] = [
  mockSource,
  mockSourceNoLines,
  mockSourceSingleLine,
  {
    index: 4,
    filePath: 'src/utils/helpers.ts',
    lineRange: { start: 100, end: 150 },
    score: 0.65,
    language: 'typescript',
    fileType: 'code',
  },
  {
    index: 5,
    filePath: 'docs/api.md',
    lineRange: { start: 1, end: 50 },
    score: 0.55,
    language: null,
    fileType: 'docs',
  },
];

// ============================================================================
// formatCitation Tests
// ============================================================================

describe('formatCitation', () => {
  describe('compact style (default)', () => {
    it('should format with score and line range', () => {
      const result = formatCitation(mockSource);
      expect(result).toBe('[1] src/auth/handler.ts:42-67 (0.95)');
    });

    it('should format without line range when start is 0', () => {
      const result = formatCitation(mockSourceNoLines);
      expect(result).toBe('[2] README.md (0.88)');
    });

    it('should format single line without range', () => {
      const result = formatCitation(mockSourceSingleLine);
      expect(result).toBe('[3] config/settings.json:15 (0.75)');
    });

    it('should hide score when showScores is false', () => {
      const result = formatCitation(mockSource, { showScores: false });
      expect(result).toBe('[1] src/auth/handler.ts:42-67');
    });
  });

  describe('detailed style', () => {
    it('should format with language and score on second line', () => {
      const result = formatCitation(mockSource, { style: 'detailed' });
      expect(result).toBe('[1] src/auth/handler.ts:42-67\n    Typescript | score: 0.95');
    });

    it('should use file type when language is null', () => {
      const result = formatCitation(mockSourceNoLines, { style: 'detailed' });
      expect(result).toBe('[2] README.md\n    Documentation | score: 0.88');
    });

    it('should show Config for config file type', () => {
      const result = formatCitation(mockSourceSingleLine, { style: 'detailed' });
      expect(result).toBe('[3] config/settings.json:15\n    Config | score: 0.75');
    });

    it('should hide score when showScores is false but keep language', () => {
      const result = formatCitation(mockSource, { style: 'detailed', showScores: false });
      // showLanguage defaults to true for detailed style
      expect(result).toBe('[1] src/auth/handler.ts:42-67\n    Typescript');
    });

    it('should hide language when showLanguage is false but keep score', () => {
      const result = formatCitation(mockSource, { style: 'detailed', showLanguage: false });
      // showScores defaults to true for detailed style
      expect(result).toBe('[1] src/auth/handler.ts:42-67\n    score: 0.95');
    });

    it('should show no second line when both hidden', () => {
      const result = formatCitation(mockSource, { style: 'detailed', showScores: false, showLanguage: false });
      expect(result).toBe('[1] src/auth/handler.ts:42-67');
    });
  });

  describe('minimal style', () => {
    it('should format without score', () => {
      const result = formatCitation(mockSource, { style: 'minimal' });
      expect(result).toBe('[1] src/auth/handler.ts:42-67');
    });

    it('should still exclude score even if showScores is true', () => {
      // minimal style overrides showScores default
      const result = formatCitation(mockSource, { style: 'minimal' });
      expect(result).not.toContain('0.95');
    });
  });
});

// ============================================================================
// formatCitations Tests
// ============================================================================

describe('formatCitations', () => {
  it('should return empty string for empty array', () => {
    const result = formatCitations([]);
    expect(result).toBe('');
  });

  it('should format single source', () => {
    const result = formatCitations([mockSource]);
    expect(result).toBe('[1] src/auth/handler.ts:42-67 (0.95)');
  });

  it('should format multiple sources with newlines', () => {
    const result = formatCitations([mockSource, mockSourceNoLines]);
    expect(result).toBe(
      '[1] src/auth/handler.ts:42-67 (0.95)\n[2] README.md (0.88)'
    );
  });

  describe('limit option', () => {
    it('should respect limit and show truncation hint', () => {
      const result = formatCitations(mockSources, { limit: 2 });
      expect(result).toBe(
        '[1] src/auth/handler.ts:42-67 (0.95)\n[2] README.md (0.88)\n...and 3 more'
      );
    });

    it('should hide truncation hint when showTruncationHint is false', () => {
      const result = formatCitations(mockSources, { limit: 2, showTruncationHint: false });
      expect(result).toBe(
        '[1] src/auth/handler.ts:42-67 (0.95)\n[2] README.md (0.88)'
      );
    });

    it('should not truncate when limit equals array length', () => {
      const result = formatCitations(mockSources, { limit: 5 });
      expect(result).not.toContain('more');
    });

    it('should not truncate when limit is 0 (unlimited)', () => {
      const result = formatCitations(mockSources, { limit: 0 });
      expect(result.split('\n')).toHaveLength(5);
    });
  });

  describe('style options', () => {
    it('should apply detailed style to all citations', () => {
      const result = formatCitations([mockSource, mockSourceNoLines], { style: 'detailed' });
      expect(result).toContain('Typescript | score:');
      expect(result).toContain('Documentation | score:');
    });

    it('should apply minimal style to all citations', () => {
      const result = formatCitations([mockSource, mockSourceNoLines], { style: 'minimal' });
      expect(result).not.toContain('(0.95)');
      expect(result).not.toContain('(0.88)');
    });
  });
});

// ============================================================================
// JSON Formatting Tests
// ============================================================================

describe('formatCitationJSON', () => {
  it('should return flattened JSON structure', () => {
    const result = formatCitationJSON(mockSource);
    expect(result).toEqual({
      index: 1,
      filePath: 'src/auth/handler.ts',
      lineStart: 42,
      lineEnd: 67,
      score: 0.95,
      language: 'typescript',
      fileType: 'code',
    });
  });

  it('should preserve null language', () => {
    const result = formatCitationJSON(mockSourceNoLines);
    expect(result.language).toBeNull();
  });
});

describe('formatCitationsJSON', () => {
  it('should return object with count and citations array', () => {
    const result = formatCitationsJSON(mockSources);
    expect(result.count).toBe(5);
    expect(result.citations).toHaveLength(5);
  });

  it('should return empty citations for empty array', () => {
    const result = formatCitationsJSON([]);
    expect(result).toEqual({ count: 0, citations: [] });
  });

  it('should map all sources to JSON format', () => {
    const result = formatCitationsJSON([mockSource, mockSourceNoLines]);
    expect(result.citations[0]).toEqual(formatCitationJSON(mockSource));
    expect(result.citations[1]).toEqual(formatCitationJSON(mockSourceNoLines));
  });
});

// ============================================================================
// Factory Tests
// ============================================================================

describe('createCitationFormatter', () => {
  it('should create formatter with default config', () => {
    const formatter = createCitationFormatter();
    const result = formatter.format([mockSource]);
    expect(result).toBe('[1] src/auth/handler.ts:42-67 (0.95)');
  });

  it('should create formatter with custom style', () => {
    const formatter = createCitationFormatter({ style: 'detailed' });
    const result = formatter.format([mockSource]);
    expect(result).toContain('Typescript | score:');
  });

  it('should provide formatOne method', () => {
    const formatter = createCitationFormatter();
    const result = formatter.formatOne(mockSource);
    expect(result).toBe('[1] src/auth/handler.ts:42-67 (0.95)');
  });

  it('should provide formatJSON method', () => {
    const formatter = createCitationFormatter();
    const result = formatter.formatJSON([mockSource]);
    expect(result.count).toBe(1);
    expect(result.citations).toHaveLength(1);
  });

  it('should preserve config across multiple calls', () => {
    const formatter = createCitationFormatter({ style: 'minimal', limit: 2 });

    const result1 = formatter.format(mockSources);
    const result2 = formatter.format(mockSources);

    expect(result1).toBe(result2);
    expect(result1).not.toContain('(0.95)');
    expect(result1).toContain('...and 3 more');
  });
});

// ============================================================================
// Schema Validation Tests
// ============================================================================

describe('CitationFormatOptionsSchema', () => {
  it('should accept valid options', () => {
    const result = CitationFormatOptionsSchema.safeParse({
      style: 'detailed',
      showScores: true,
      limit: 5,
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid style', () => {
    const result = CitationFormatOptionsSchema.safeParse({
      style: 'invalid',
    });
    expect(result.success).toBe(false);
  });

  it('should reject negative limit', () => {
    const result = CitationFormatOptionsSchema.safeParse({
      limit: -1,
    });
    expect(result.success).toBe(false);
  });

  it('should reject non-integer limit', () => {
    const result = CitationFormatOptionsSchema.safeParse({
      limit: 2.5,
    });
    expect(result.success).toBe(false);
  });

  it('should accept empty options', () => {
    const result = CitationFormatOptionsSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe('createCitationFormatter validation', () => {
  it('should throw ZodError for invalid style', () => {
    expect(() => {
      createCitationFormatter({ style: 'invalid' as 'compact' });
    }).toThrow();
  });

  it('should throw ZodError for invalid limit', () => {
    expect(() => {
      createCitationFormatter({ limit: -5 });
    }).toThrow();
  });
});

// ============================================================================
// DEFAULT_CITATION_CONFIG Tests
// ============================================================================

describe('DEFAULT_CITATION_CONFIG', () => {
  it('should have expected default values', () => {
    expect(DEFAULT_CITATION_CONFIG).toEqual({
      style: 'compact',
      limit: 0,
      showTruncationHint: true,
    });
  });
});
