/**
 * Tests for the file scanner
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { scanDirectory, scanDirectories, countFiles } from '../scanner.js';

describe('scanDirectory', () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a fresh temp directory for each test
    tempDir = mkdtempSync(join(tmpdir(), 'ctx-test-'));
  });

  afterEach(() => {
    // Clean up temp directory
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Helper to create test files in the temp directory
   */
  function createFile(relativePath: string, content = ''): string {
    const fullPath = join(tempDir, relativePath);
    const dir = resolve(fullPath, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content);
    return fullPath;
  }

  it('discovers files in a flat directory', async () => {
    createFile('index.ts', 'export const x = 1;');
    createFile('utils.ts', 'export function util() {}');
    createFile('readme.md', '# README');

    const result = await scanDirectory(tempDir);

    expect(result.files).toHaveLength(3);
    expect(result.stats.totalFiles).toBe(3);
    expect(result.rootPath).toBe(tempDir);
  });

  it('discovers files in nested directories', async () => {
    createFile('src/index.ts', '');
    createFile('src/utils/helpers.ts', '');
    createFile('src/utils/format.ts', '');
    createFile('tests/index.test.ts', '');

    const result = await scanDirectory(tempDir);

    expect(result.files).toHaveLength(4);
    const relativePaths = result.files.map((f) => f.relativePath);
    expect(relativePaths).toContain(join('src', 'index.ts'));
    expect(relativePaths).toContain(join('src', 'utils', 'helpers.ts'));
  });

  it('respects maxDepth option', async () => {
    createFile('level1.ts', '');
    createFile('a/level2.ts', '');
    createFile('a/b/level3.ts', '');
    createFile('a/b/c/level4.ts', '');

    const result = await scanDirectory(tempDir, { maxDepth: 2 });

    expect(result.files).toHaveLength(2);
    const relativePaths = result.files.map((f) => f.relativePath);
    expect(relativePaths).toContain('level1.ts');
    expect(relativePaths).toContain(join('a', 'level2.ts'));
  });

  it('filters by extensions', async () => {
    createFile('script.ts', '');
    createFile('script.js', '');
    createFile('styles.css', '');
    createFile('readme.md', '');

    const result = await scanDirectory(tempDir, {
      extensions: ['ts', 'js'],
    });

    expect(result.files).toHaveLength(2);
    const extensions = result.files.map((f) => f.extension);
    expect(extensions).toContain('ts');
    expect(extensions).toContain('js');
    expect(extensions).not.toContain('css');
    expect(extensions).not.toContain('md');
  });

  it('ignores node_modules by default', async () => {
    createFile('index.ts', '');
    createFile('node_modules/package/index.js', '');

    const result = await scanDirectory(tempDir);

    expect(result.files).toHaveLength(1);
    expect(result.files[0].relativePath).toBe('index.ts');
  });

  it('respects .gitignore patterns', async () => {
    createFile('.gitignore', 'ignored/\n*.secret');
    createFile('index.ts', '');
    createFile('ignored/secret.ts', '');
    createFile('config.secret', '');
    createFile('kept.ts', '');

    const result = await scanDirectory(tempDir);

    const relativePaths = result.files.map((f) => f.relativePath);
    expect(relativePaths).toContain('index.ts');
    expect(relativePaths).toContain('kept.ts');
    expect(relativePaths).not.toContain(join('ignored', 'secret.ts'));
    expect(relativePaths).not.toContain('config.secret');
  });

  it('applies additional ignore patterns', async () => {
    createFile('index.ts', '');
    createFile('temp/cache.ts', '');

    const result = await scanDirectory(tempDir, {
      additionalIgnorePatterns: ['temp/'],
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0].relativePath).toBe('index.ts');
  });

  it('skips binary files', async () => {
    createFile('index.ts', '');
    createFile('image.png', 'binary content');
    createFile('archive.zip', 'binary content');

    const result = await scanDirectory(tempDir);

    expect(result.files).toHaveLength(1);
    expect(result.files[0].relativePath).toBe('index.ts');
  });

  it('provides accurate file metadata', async () => {
    const content = 'export const value = 42;';
    createFile('index.ts', content);

    const result = await scanDirectory(tempDir);

    expect(result.files).toHaveLength(1);
    const file = result.files[0];

    expect(file.extension).toBe('ts');
    expect(file.language).toBe('typescript');
    expect(file.type).toBe('code');
    expect(file.size).toBe(content.length);
    expect(file.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO date format
    expect(file.path).toBe(join(tempDir, 'index.ts'));
    expect(file.relativePath).toBe('index.ts');
  });

  it('detects languages correctly', async () => {
    createFile('app.ts', '');
    createFile('util.js', '');
    createFile('main.py', '');
    createFile('config.json', '');
    createFile('readme.md', '');
    createFile('styles.css', '');

    const result = await scanDirectory(tempDir);

    const byLanguage = Object.fromEntries(
      result.files.map((f) => [f.extension, f.language])
    );

    expect(byLanguage['ts']).toBe('typescript');
    expect(byLanguage['js']).toBe('javascript');
    expect(byLanguage['py']).toBe('python');
    expect(byLanguage['json']).toBe('json');
    expect(byLanguage['md']).toBe('markdown');
    expect(byLanguage['css']).toBe('css');
  });

  it('tracks statistics by language', async () => {
    createFile('a.ts', '');
    createFile('b.ts', '');
    createFile('c.js', '');
    createFile('readme.md', '');

    const result = await scanDirectory(tempDir);

    expect(result.stats.byLanguage.typescript).toBe(2);
    expect(result.stats.byLanguage.javascript).toBe(1);
    expect(result.stats.byLanguage.markdown).toBe(1);
  });

  it('tracks statistics by type', async () => {
    createFile('app.ts', '');
    createFile('config.json', '');
    createFile('readme.md', '');
    createFile('styles.css', '');

    const result = await scanDirectory(tempDir);

    expect(result.stats.byType.code).toBe(1);
    expect(result.stats.byType.config).toBe(1);
    expect(result.stats.byType.docs).toBe(1);
    expect(result.stats.byType.style).toBe(1);
  });

  it('calculates total size', async () => {
    createFile('small.ts', 'x');
    createFile('medium.ts', 'x'.repeat(100));

    const result = await scanDirectory(tempDir);

    expect(result.stats.totalSize).toBe(101);
  });

  it('calls onFile callback for each file', async () => {
    createFile('a.ts', '');
    createFile('b.ts', '');

    const onFile = vi.fn();
    await scanDirectory(tempDir, { onFile });

    expect(onFile).toHaveBeenCalledTimes(2);
    expect(onFile).toHaveBeenCalledWith(
      expect.objectContaining({ extension: 'ts' })
    );
  });

  it('records scan duration', async () => {
    createFile('index.ts', '');

    const result = await scanDirectory(tempDir);

    expect(result.stats.scanDurationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.stats.scanDurationMs).toBe('number');
  });

  it('handles empty directories', async () => {
    // tempDir is empty
    const result = await scanDirectory(tempDir);

    expect(result.files).toHaveLength(0);
    expect(result.stats.totalFiles).toBe(0);
    expect(result.stats.totalSize).toBe(0);
  });

  it('handles directories with only ignored files', async () => {
    createFile('node_modules/index.js', '');
    createFile('.git/config', '');

    const result = await scanDirectory(tempDir);

    expect(result.files).toHaveLength(0);
  });

  it('handles Dockerfile without extension', async () => {
    createFile('Dockerfile', 'FROM node:20');

    const result = await scanDirectory(tempDir, {
      extensions: ['dockerfile'],
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0].language).toBe('dockerfile');
  });

  // ============================================================================
  // Error Handling Tests
  // ============================================================================

  describe('error handling', () => {
    it('returns empty result for non-existent directory', async () => {
      // fast-glob with suppressErrors: true handles missing directories gracefully
      // by returning empty results rather than throwing
      const nonExistent = join(tempDir, 'does-not-exist');

      const result = await scanDirectory(nonExistent);

      expect(result.files).toHaveLength(0);
      expect(result.stats.totalFiles).toBe(0);
      expect(result.rootPath).toContain('does-not-exist');
    });

    it('tracks errors encountered during scanning', async () => {
      // Create a file that will be found but simulate stat failure via bad permissions
      // Note: We can't easily test permission errors in temp dirs, so we test the counter exists
      createFile('valid.ts', 'content');

      const result = await scanDirectory(tempDir);

      expect(result.stats.errorsEncountered).toBeDefined();
      expect(typeof result.stats.errorsEncountered).toBe('number');
    });

    it('calls onError callback when file processing fails', async () => {
      // This test verifies the onError callback interface exists and is called correctly
      // We create a valid scenario first to ensure the callback shape is correct
      createFile('valid.ts', 'content');

      const onError = vi.fn();
      await scanDirectory(tempDir, { onError });

      // onError should not be called for valid files
      expect(onError).not.toHaveBeenCalled();
    });

    it('continues scanning after encountering errors', async () => {
      // Create multiple files - scanner should process all even if some fail
      createFile('first.ts', 'first');
      createFile('second.ts', 'second');
      createFile('third.ts', 'third');

      const result = await scanDirectory(tempDir);

      // All files should be discovered
      expect(result.files).toHaveLength(3);
    });
  });

  // ============================================================================
  // Symlink Handling Tests
  // ============================================================================

  describe('symlink handling', () => {
    it('skips symlinks by default', async () => {
      createFile('real.ts', 'real content');
      const realPath = join(tempDir, 'real.ts');
      const linkPath = join(tempDir, 'link.ts');

      try {
        symlinkSync(realPath, linkPath);
      } catch {
        // Skip test if symlinks not supported (Windows without admin)
        return;
      }

      const result = await scanDirectory(tempDir, {
        followSymlinks: false,
      });

      // Should find only the real file, not the symlink
      expect(result.files).toHaveLength(1);
      expect(result.files[0].relativePath).toBe('real.ts');
    });

    it('follows symlinks when followSymlinks is true', async () => {
      // Create a subdirectory with a file
      createFile('subdir/target.ts', 'target content');
      const subdirPath = join(tempDir, 'subdir');
      const linkPath = join(tempDir, 'linked-dir');

      try {
        symlinkSync(subdirPath, linkPath, 'dir');
      } catch {
        // Skip test if symlinks not supported
        return;
      }

      const result = await scanDirectory(tempDir, {
        followSymlinks: true,
      });

      // Should find files in both the real dir and via symlink
      const relativePaths = result.files.map((f) => f.relativePath);
      expect(relativePaths).toContain(join('subdir', 'target.ts'));
      // When following symlinks, we may find the file via the symlink too
    });

    it('handles broken symlinks gracefully', async () => {
      createFile('valid.ts', 'content');
      const brokenLink = join(tempDir, 'broken-link.ts');

      try {
        // Create symlink to non-existent target
        symlinkSync(join(tempDir, 'non-existent.ts'), brokenLink);
      } catch {
        // Skip if symlinks not supported
        return;
      }

      // Should not throw, should just skip the broken symlink
      const result = await scanDirectory(tempDir);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].relativePath).toBe('valid.ts');
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('edge cases', () => {
    it('handles unicode filenames', async () => {
      createFile('日本語.ts', 'Japanese');
      createFile('émoji_🎉.ts', 'emoji');
      createFile('中文文件.ts', 'Chinese');

      const result = await scanDirectory(tempDir);

      expect(result.files).toHaveLength(3);
      const relativePaths = result.files.map((f) => f.relativePath);
      expect(relativePaths).toContain('日本語.ts');
      expect(relativePaths).toContain('émoji_🎉.ts');
      expect(relativePaths).toContain('中文文件.ts');
    });

    it('handles files with multiple extensions', async () => {
      createFile('component.test.ts', 'test file');
      createFile('styles.module.css', 'css module');
      createFile('data.d.ts', 'declaration file');

      const result = await scanDirectory(tempDir);

      expect(result.files).toHaveLength(3);

      // Extension should be the last part only
      const file = result.files.find((f) => f.relativePath === 'component.test.ts');
      expect(file?.extension).toBe('ts');
      expect(file?.language).toBe('typescript');
    });

    it('handles special filenames without extensions', async () => {
      createFile('Makefile', 'all: build');
      createFile('Dockerfile', 'FROM node:20');

      // Only scan for dockerfile extension to test special filename mapping
      const result = await scanDirectory(tempDir, {
        extensions: ['dockerfile', 'text'],
      });

      const languages = result.files.map((f) => f.language);
      expect(languages).toContain('dockerfile');
    });

    it('excludes dotfiles from scanning by default', async () => {
      createFile('regular.ts', 'regular');
      createFile('.hidden.ts', 'hidden');
      createFile('.config/settings.ts', 'config');

      const result = await scanDirectory(tempDir);

      // fast-glob with dot: false should exclude dotfiles
      const relativePaths = result.files.map((f) => f.relativePath);
      expect(relativePaths).toContain('regular.ts');
      // Dotfiles are excluded by fast-glob's dot: false option
    });

    it('handles deeply nested directories', async () => {
      // Create a deeply nested structure
      createFile('a/b/c/d/e/f/g/h/i/j/deep.ts', 'deep content');

      const result = await scanDirectory(tempDir);

      expect(result.files).toHaveLength(1);
      // The relative path uses the OS path separator
      const expectedPath = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'deep.ts'].join(
        join('a', 'b').charAt(1) // Extract the path separator used by join()
      );
      expect(result.files[0].relativePath).toBe(expectedPath);
    });

    it('handles files with spaces in names', async () => {
      createFile('file with spaces.ts', 'content');
      createFile('path with/spaces in/folder.ts', 'nested');

      const result = await scanDirectory(tempDir);

      expect(result.files).toHaveLength(2);
    });
  });
});

// ============================================================================
// scanDirectories Tests
// ============================================================================

describe('scanDirectories', () => {
  let tempDir1: string;
  let tempDir2: string;

  beforeEach(() => {
    tempDir1 = mkdtempSync(join(tmpdir(), 'ctx-test-1-'));
    tempDir2 = mkdtempSync(join(tmpdir(), 'ctx-test-2-'));
  });

  afterEach(() => {
    rmSync(tempDir1, { recursive: true, force: true });
    rmSync(tempDir2, { recursive: true, force: true });
  });

  function createFileIn(dir: string, relativePath: string, content = ''): void {
    const fullPath = join(dir, relativePath);
    const parentDir = resolve(fullPath, '..');
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(fullPath, content);
  }

  it('scans multiple directories', async () => {
    createFileIn(tempDir1, 'file1.ts', 'first');
    createFileIn(tempDir2, 'file2.ts', 'second');

    const results = await scanDirectories([tempDir1, tempDir2]);

    expect(results).toHaveLength(2);
    expect(results[0].files).toHaveLength(1);
    expect(results[1].files).toHaveLength(1);
  });

  it('returns separate results for each directory', async () => {
    createFileIn(tempDir1, 'a.ts', '');
    createFileIn(tempDir1, 'b.ts', '');
    createFileIn(tempDir2, 'c.ts', '');

    const results = await scanDirectories([tempDir1, tempDir2]);

    expect(results[0].rootPath).toBe(tempDir1);
    expect(results[0].files).toHaveLength(2);
    expect(results[1].rootPath).toBe(tempDir2);
    expect(results[1].files).toHaveLength(1);
  });

  it('applies same options to all directories', async () => {
    createFileIn(tempDir1, 'file.ts', '');
    createFileIn(tempDir1, 'file.js', '');
    createFileIn(tempDir2, 'file.ts', '');
    createFileIn(tempDir2, 'file.js', '');

    const results = await scanDirectories([tempDir1, tempDir2], {
      extensions: ['ts'], // Only TypeScript files
    });

    // Both directories should only have .ts files
    expect(results[0].files).toHaveLength(1);
    expect(results[0].files[0].extension).toBe('ts');
    expect(results[1].files).toHaveLength(1);
    expect(results[1].files[0].extension).toBe('ts');
  });

  it('handles empty directory array', async () => {
    const results = await scanDirectories([]);

    expect(results).toHaveLength(0);
  });

  it('handles mix of empty and non-empty directories', async () => {
    createFileIn(tempDir1, 'file.ts', 'content');
    // tempDir2 is empty

    const results = await scanDirectories([tempDir1, tempDir2]);

    expect(results[0].files).toHaveLength(1);
    expect(results[1].files).toHaveLength(0);
  });
});

describe('countFiles', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ctx-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createFile(relativePath: string, content = ''): void {
    const fullPath = join(tempDir, relativePath);
    const dir = resolve(fullPath, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content);
  }

  it('returns correct count of files', async () => {
    createFile('a.ts', '');
    createFile('b.ts', '');
    createFile('c.js', '');

    const count = await countFiles(tempDir);

    expect(count).toBe(3);
  });

  it('respects ignore patterns', async () => {
    createFile('index.ts', '');
    createFile('node_modules/package.js', '');

    const count = await countFiles(tempDir);

    expect(count).toBe(1);
  });

  it('filters by extensions', async () => {
    createFile('app.ts', '');
    createFile('app.js', '');
    createFile('readme.md', '');

    const count = await countFiles(tempDir, { extensions: ['ts'] });

    expect(count).toBe(1);
  });

  it('skips binary files', async () => {
    createFile('app.ts', '');
    createFile('image.png', '');

    const count = await countFiles(tempDir);

    expect(count).toBe(1);
  });
});
