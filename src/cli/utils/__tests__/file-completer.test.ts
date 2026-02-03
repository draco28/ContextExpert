/**
 * Tests for file-completer.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { completeFileName, completeFileNames, getAllProjectFiles } from '../file-completer.js';

// Test data for files
const testFilesProject1 = [
  { file_path: 'src/auth.ts' },
  { file_path: 'src/auth-middleware.ts' },
  { file_path: 'src/utils/auth-helper.ts' },
  { file_path: 'lib/oauth.ts' },
  { file_path: 'src/index.ts' },
  { file_path: 'tests/auth.test.ts' },
];

const testFilesProject2 = [{ file_path: 'src/different.ts' }];

// Mock the database module with a fake implementation
vi.mock('../../../database/index.js', () => {
  return {
    runMigrations: vi.fn(),
    getDb: vi.fn(() => ({
      prepare: vi.fn((sql: string) => ({
        all: vi.fn((...args: unknown[]) => {
          const projectId = args[0] as number;

          // Handle getAllProjectFiles query (just projectId param)
          if (args.length === 1) {
            return projectId === '1' ? testFilesProject1 : projectId === '2' ? testFilesProject2 : [];
          }

          // Handle completeFileName query (projectId, pattern, boostPattern, limit)
          const pattern = (args[1] as string).replace(/%/g, '').toLowerCase();

          const files = projectId === '1' ? testFilesProject1 : projectId === '2' ? testFilesProject2 : [];

          return files.filter((f) => f.file_path.toLowerCase().includes(pattern));
        }),
      })),
    })),
  };
});

describe('file-completer', () => {
  describe('completeFileName', () => {
    it('finds files matching partial name', () => {
      const results = completeFileName('1', 'auth');

      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.fileName === 'auth.ts')).toBe(true);
      expect(results.some((r) => r.fileName === 'auth-middleware.ts')).toBe(true);
    });

    it('returns full path in results', () => {
      const results = completeFileName('1', 'auth.ts');

      const authFile = results.find((r) => r.fileName === 'auth.ts');
      expect(authFile?.fullPath).toBe('src/auth.ts');
    });

    it('matches anywhere in path (not just basename)', () => {
      const results = completeFileName('1', 'oauth');

      expect(results.some((r) => r.fileName === 'oauth.ts')).toBe(true);
    });

    it('is case-insensitive', () => {
      const results = completeFileName('1', 'AUTH');

      expect(results.some((r) => r.fileName === 'auth.ts')).toBe(true);
    });

    it('returns empty for non-matching partial', () => {
      const results = completeFileName('1', 'xyz123');

      expect(results).toEqual([]);
    });

    it('only returns files from the specified project', () => {
      const results = completeFileName('1', 'different');

      // 'different.ts' is in project 2, not project 1
      expect(results).toEqual([]);
    });

    it('returns files from correct project', () => {
      const results = completeFileName('2', 'different');

      expect(results.some((r) => r.fileName === 'different.ts')).toBe(true);
    });
  });

  describe('completeFileNames', () => {
    it('returns deduplicated file names', () => {
      // auth.ts appears in src/ and tests/ (as auth.test.ts, different name)
      // but auth-helper.ts is only in src/utils/
      const results = completeFileNames('1', 'auth');

      // Count occurrences of each name
      const counts = new Map<string, number>();
      for (const name of results) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }

      // Each name should appear only once
      for (const count of counts.values()) {
        expect(count).toBe(1);
      }
    });

    it('returns just file names (basenames)', () => {
      const results = completeFileNames('1', 'index');

      expect(results).toContain('index.ts');
      // Should not contain full path
      expect(results.some((r) => r.includes('/'))).toBe(false);
    });
  });

  describe('getAllProjectFiles', () => {
    it('returns all files for a project', () => {
      const results = getAllProjectFiles('1');

      expect(results.length).toBe(6); // 6 unique files in project 1
      expect(results).toContain('src/auth.ts');
      expect(results).toContain('lib/oauth.ts');
    });

    it('only returns files from specified project', () => {
      const results = getAllProjectFiles('2');

      expect(results.length).toBe(1);
      expect(results).toContain('src/different.ts');
    });

    it('returns empty for non-existent project', () => {
      const results = getAllProjectFiles('999');

      expect(results).toEqual([]);
    });
  });
});
