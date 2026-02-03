/**
 * Tests for path-completer.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  completeDirectoryPath,
  expandTilde,
  contractTilde,
  isDirectory,
} from '../path-completer.js';

describe('path-completer', () => {
  // Create a temporary test directory structure
  const testDir = join(tmpdir(), 'ctx-path-completer-test');

  beforeAll(() => {
    // Create test directory structure
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, 'src'), { recursive: true });
    mkdirSync(join(testDir, 'src', 'components'), { recursive: true });
    mkdirSync(join(testDir, 'scripts'), { recursive: true });
    mkdirSync(join(testDir, 'tests'), { recursive: true });
    mkdirSync(join(testDir, '.hidden'), { recursive: true });
    mkdirSync(join(testDir, 'node_modules'), { recursive: true });

    // Create a file (should not appear in completion)
    writeFileSync(join(testDir, 'package.json'), '{}');
  });

  afterAll(() => {
    // Clean up test directory
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('expandTilde', () => {
    it('expands ~ to home directory', () => {
      const result = expandTilde('~/foo');
      expect(result).not.toContain('~');
      expect(result).toContain('foo');
    });

    it('leaves non-tilde paths unchanged', () => {
      expect(expandTilde('/usr/local')).toBe('/usr/local');
      expect(expandTilde('./src')).toBe('./src');
    });
  });

  describe('contractTilde', () => {
    it('contracts home directory to ~', () => {
      const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
      const result = contractTilde(`${home}/projects`);
      expect(result).toBe('~/projects');
    });

    it('leaves non-home paths unchanged', () => {
      expect(contractTilde('/usr/local')).toBe('/usr/local');
    });
  });

  describe('completeDirectoryPath', () => {
    it('completes partial directory names', () => {
      const results = completeDirectoryPath(join(testDir, 'sr'));
      expect(results).toContain(join(testDir, 'src/'));
    });

    it('lists directories when path ends with /', () => {
      const results = completeDirectoryPath(testDir + '/');
      expect(results).toContain(join(testDir, 'src/'));
      expect(results).toContain(join(testDir, 'scripts/'));
      expect(results).toContain(join(testDir, 'tests/'));
    });

    it('excludes hidden directories unless explicitly requested', () => {
      const results = completeDirectoryPath(testDir + '/');
      expect(results).not.toContain(join(testDir, '.hidden/'));
    });

    it('includes hidden directories when prefix starts with dot', () => {
      const results = completeDirectoryPath(join(testDir, '.h'));
      // Should include .hidden when explicitly searching for dot-prefixed dirs
      expect(results.some((r) => r.includes('.hidden'))).toBe(true);
    });

    it('excludes node_modules', () => {
      const results = completeDirectoryPath(testDir + '/');
      expect(results).not.toContain(join(testDir, 'node_modules/'));
    });

    it('does not include files', () => {
      const results = completeDirectoryPath(testDir + '/');
      // package.json should not appear
      const hasFile = results.some((r) => r.includes('package.json'));
      expect(hasFile).toBe(false);
    });

    it('is case-insensitive', () => {
      const results = completeDirectoryPath(join(testDir, 'SR'));
      expect(results).toContain(join(testDir, 'src/'));
    });

    it('returns empty array for non-existent path', () => {
      const results = completeDirectoryPath('/nonexistent/path/xyz');
      expect(results).toEqual([]);
    });
  });

  describe('isDirectory', () => {
    it('returns true for directories', () => {
      expect(isDirectory(testDir)).toBe(true);
    });

    it('returns false for files', () => {
      expect(isDirectory(join(testDir, 'package.json'))).toBe(false);
    });

    it('returns false for non-existent paths', () => {
      expect(isDirectory('/nonexistent/path')).toBe(false);
    });
  });
});
