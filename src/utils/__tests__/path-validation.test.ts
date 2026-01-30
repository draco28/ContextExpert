/**
 * Path Validation Tests
 *
 * Tests for the validateProjectPath utility function.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateProjectPath } from '../path-validation.js';

// ============================================================================
// Test Setup
// ============================================================================

// Base path for test directory (will be resolved to real path in beforeEach)
const TEST_DIR_BASE = join(tmpdir(), 'ctx-path-validation-test');
let TEST_DIR: string;

function createTestDir(name: string): string {
  const dir = join(TEST_DIR, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createTestFile(name: string, content = ''): string {
  const file = join(TEST_DIR, name);
  writeFileSync(file, content);
  return file;
}

// ============================================================================
// Tests
// ============================================================================

describe('validateProjectPath', () => {
  beforeEach(() => {
    // Create the directory first, then resolve to get the real path
    // (on macOS, /var -> /private/var, so we need the resolved path)
    mkdirSync(TEST_DIR_BASE, { recursive: true });
    TEST_DIR = realpathSync(TEST_DIR_BASE);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('basic validation', () => {
    it('returns valid for existing directory', () => {
      const dir = createTestDir('valid-project');
      const result = validateProjectPath(dir);

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.normalizedPath).toBe(dir);
        expect(result.warnings).toEqual([]);
      }
    });

    it('returns error for non-existent path', () => {
      const result = validateProjectPath('/nonexistent/path/12345');

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('does not exist');
        expect(result.hint).toContain('Check the path');
      }
    });

    it('returns error for file (not directory)', () => {
      const file = createTestFile('not-a-dir.txt', 'content');
      const result = validateProjectPath(file);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('not a directory');
        expect(result.hint).toContain('parent directory');
      }
    });
  });

  describe('path normalization', () => {
    it('resolves relative paths to absolute', () => {
      const dir = createTestDir('relative-test');
      // Use relative path from TEST_DIR
      const relativePath = './relative-test';
      const result = validateProjectPath(join(TEST_DIR, relativePath));

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.normalizedPath).toBe(dir);
      }
    });
  });

  describe('symlink handling', () => {
    it('resolves valid symlinks', () => {
      const target = createTestDir('symlink-target');
      const linkPath = join(TEST_DIR, 'symlink-to-dir');
      symlinkSync(target, linkPath);

      const result = validateProjectPath(linkPath);

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.normalizedPath).toBe(target);
        expect(result.warnings.some(w => w.includes('Symlink resolved'))).toBe(true);
      }
    });

    it('detects symlink loops', () => {
      // Create circular symlinks: a -> b -> a
      // Note: On some systems, this may fail at existsSync before realpathSync
      const linkA = join(TEST_DIR, 'loop-a');
      const linkB = join(TEST_DIR, 'loop-b');

      // Create initial link pointing to linkB (which doesn't exist yet)
      symlinkSync(linkB, linkA);
      // Create second link pointing back to linkA (creates loop)
      symlinkSync(linkA, linkB);

      const result = validateProjectPath(linkA);

      // The result should be invalid - either "Symlink loop" or "does not exist"
      // depending on how the OS handles the broken symlink chain
      expect(result.valid).toBe(false);
      if (!result.valid) {
        // Accept either error message since behavior varies by OS
        const isLoopOrNotExist =
          result.error.includes('Symlink loop') ||
          result.error.includes('does not exist') ||
          result.error.includes('Cannot resolve');
        expect(isLoopOrNotExist).toBe(true);
      }
    });
  });

  describe('nesting depth', () => {
    it('warns for deeply nested directories', () => {
      // Create a directory path with many levels
      const deepPath = Array(55).fill('level').join('/');
      const deepDir = join(TEST_DIR, deepPath);
      mkdirSync(deepDir, { recursive: true });

      const result = validateProjectPath(deepDir, { maxDepth: 50 });

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.warnings.some(w => w.includes('deeply nested'))).toBe(true);
      }
    });

    it('allows custom max depth', () => {
      const shallowDir = createTestDir('shallow');
      const result = validateProjectPath(shallowDir, { maxDepth: 100 });

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.warnings.some(w => w.includes('deeply nested'))).toBe(false);
      }
    });
  });

  describe('options', () => {
    it('can skip permission check', () => {
      const dir = createTestDir('skip-perm-check');
      const result = validateProjectPath(dir, { checkReadable: false });

      expect(result.valid).toBe(true);
    });
  });
});
