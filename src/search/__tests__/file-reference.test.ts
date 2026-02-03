/**
 * Tests for file-reference.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseFileReferences,
  stripFileReferences,
  resolveFileReferences,
  formatReferencesAsContext,
  getReferenceSummary,
} from '../file-reference.js';

// Mock database
const mockChunks = [
  { file_path: 'src/auth.ts', chunk_count: 3 },
  { file_path: 'src/auth-middleware.ts', chunk_count: 2 },
  { file_path: 'src/utils/auth-helper.ts', chunk_count: 1 },
  { file_path: 'lib/oauth.ts', chunk_count: 2 },
  { file_path: 'src/index.ts', chunk_count: 1 },
];

const mockContent: Record<string, string[]> = {
  'src/auth.ts': ['// Auth module', 'export function login() {}', 'export function logout() {}'],
  'src/auth-middleware.ts': ['// Middleware', 'export const authMiddleware = () => {}'],
  'lib/oauth.ts': ['// OAuth', 'export class OAuth {}'],
};

vi.mock('../../database/index.js', () => ({
  runMigrations: vi.fn(),
  getDb: vi.fn(() => ({
    prepare: vi.fn((sql: string) => ({
      all: vi.fn((...args: unknown[]) => {
        // Handle file listing query (GROUP BY)
        if (sql.includes('GROUP BY')) {
          return mockChunks;
        }
        // Handle content query (ORDER BY id)
        if (sql.includes('ORDER BY id')) {
          const filePath = args[1] as string;
          const content = mockContent[filePath];
          if (content) {
            return content.map((c) => ({ content: c }));
          }
          return [];
        }
        return [];
      }),
    })),
  })),
}));

describe('file-reference', () => {
  describe('parseFileReferences', () => {
    it('parses single @file reference', () => {
      const refs = parseFileReferences('@auth.ts how does this work?');
      expect(refs).toEqual(['auth.ts']);
    });

    it('parses multiple @file references', () => {
      const refs = parseFileReferences('@auth.ts @utils.ts explain these');
      expect(refs).toEqual(['auth.ts', 'utils.ts']);
    });

    it('handles path references', () => {
      const refs = parseFileReferences('@src/auth.ts what is this?');
      expect(refs).toEqual(['src/auth.ts']);
    });

    it('deduplicates references', () => {
      const refs = parseFileReferences('@auth.ts @auth.ts explain');
      expect(refs).toEqual(['auth.ts']);
    });

    it('returns empty array when no references', () => {
      const refs = parseFileReferences('just a normal question');
      expect(refs).toEqual([]);
    });

    it('ignores @ at end of string with no filename', () => {
      const refs = parseFileReferences('email@');
      // The @ at end shouldn't match since there's no filename after it
      // Actually our regex would match '' - let me check
      expect(refs).toEqual([]);
    });

    it('does not match email addresses', () => {
      // Email addresses should NOT be parsed as file references
      const refs = parseFileReferences('contact user@example.com for help');
      expect(refs).toEqual([]);
    });

    it('matches @file in parenthetical expressions', () => {
      const refs = parseFileReferences('see (@auth.ts) for details');
      expect(refs).toEqual(['auth.ts']);
    });

    it('matches @file after punctuation', () => {
      const refs = parseFileReferences('check this: @config.ts');
      expect(refs).toEqual(['config.ts']);
    });
  });

  describe('stripFileReferences', () => {
    it('removes @file references from input', () => {
      const stripped = stripFileReferences('@auth.ts how does JWT work?');
      expect(stripped).toBe('how does JWT work?');
    });

    it('removes multiple references', () => {
      const stripped = stripFileReferences('@auth.ts @utils.ts explain these files');
      expect(stripped).toBe('explain these files');
    });

    it('normalizes whitespace', () => {
      const stripped = stripFileReferences('@file1.ts   @file2.ts   question');
      expect(stripped).toBe('question');
    });

    it('returns original if no references', () => {
      const stripped = stripFileReferences('normal question');
      expect(stripped).toBe('normal question');
    });
  });

  describe('resolveFileReferences', () => {
    it('resolves exact file name matches', () => {
      const resolved = resolveFileReferences('1', ['auth.ts']);

      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.pattern).toBe('auth.ts');
      expect(resolved[0]!.matches.length).toBeGreaterThan(0);
      expect(resolved[0]!.isExactMatch).toBe(true);
    });

    it('resolves partial matches', () => {
      const resolved = resolveFileReferences('1', ['auth']);

      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.matches.length).toBeGreaterThan(1); // Multiple auth files
    });

    it('returns empty matches for non-existent files', () => {
      const resolved = resolveFileReferences('1', ['nonexistent.xyz']);

      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.matches).toHaveLength(0);
    });

    it('includes file content in matches', () => {
      const resolved = resolveFileReferences('1', ['auth.ts']);

      const authMatch = resolved[0]!.matches.find((m) => m.filePath === 'src/auth.ts');
      expect(authMatch).toBeDefined();
      expect(authMatch!.content).toContain('Auth module');
    });

    it('respects maxMatchesPerPattern option', () => {
      const resolved = resolveFileReferences('1', ['auth'], { maxMatchesPerPattern: 1 });

      expect(resolved[0]!.matches.length).toBe(1);
    });
  });

  describe('formatReferencesAsContext', () => {
    it('formats resolved references as XML', () => {
      const resolved = resolveFileReferences('1', ['auth.ts']);
      const formatted = formatReferencesAsContext(resolved);

      expect(formatted).toContain('<user_referenced_files>');
      expect(formatted).toContain('<referenced_file');
      expect(formatted).toContain('path="src/auth.ts"');
      expect(formatted).toContain('pattern="@auth.ts"');
      expect(formatted).toContain('</referenced_file>');
    });

    it('includes comment for unmatched references', () => {
      const resolved = resolveFileReferences('1', ['nonexistent.ts']);
      const formatted = formatReferencesAsContext(resolved);

      expect(formatted).toContain('<!-- @nonexistent.ts: No matching files found -->');
    });

    it('returns empty string when no resolved references', () => {
      const formatted = formatReferencesAsContext([]);
      expect(formatted).toBe('');
    });
  });

  describe('getReferenceSummary', () => {
    it('summarizes single match', () => {
      // Use full path for exact single match
      const resolved = resolveFileReferences('1', ['src/auth.ts']);
      const summary = getReferenceSummary(resolved);

      expect(summary).toContain('@src/auth.ts');
      expect(summary).toContain('src/auth.ts');
    });

    it('shows "no matches" for unmatched patterns', () => {
      const resolved = resolveFileReferences('1', ['nonexistent.xyz']);
      const summary = getReferenceSummary(resolved);

      expect(summary).toContain('@nonexistent.xyz: no matches');
    });

    it('shows count for multiple matches', () => {
      const resolved = resolveFileReferences('1', ['auth']);
      const summary = getReferenceSummary(resolved);

      // Should show "X files" when multiple matches
      expect(summary).toMatch(/@auth → \d+ files/);
    });
  });
});
