/**
 * Tests for the file scanner
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { scanDirectory, countFiles } from '../scanner.js';

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
