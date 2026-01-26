/**
 * Tests for gitignore pattern handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  loadGitignoreFile,
  parseGitignoreContent,
  createIgnoreFilter,
  isBinaryFile,
} from '../ignore.js';

// Mock fs module
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

describe('parseGitignoreContent', () => {
  it('parses simple patterns', () => {
    const content = `
node_modules
dist
*.log
`;
    const patterns = parseGitignoreContent(content);
    expect(patterns).toEqual(['node_modules', 'dist', '*.log']);
  });

  it('skips empty lines', () => {
    const content = `
node_modules

dist

`;
    const patterns = parseGitignoreContent(content);
    expect(patterns).toEqual(['node_modules', 'dist']);
  });

  it('skips comment lines', () => {
    const content = `
# This is a comment
node_modules
# Another comment
dist
`;
    const patterns = parseGitignoreContent(content);
    expect(patterns).toEqual(['node_modules', 'dist']);
  });

  it('preserves negation patterns starting with !', () => {
    const content = `
*.log
!important.log
`;
    const patterns = parseGitignoreContent(content);
    expect(patterns).toEqual(['*.log', '!important.log']);
  });

  it('trims whitespace from patterns', () => {
    const content = `  node_modules
  dist  `;
    const patterns = parseGitignoreContent(content);
    expect(patterns).toEqual(['node_modules', 'dist']);
  });
});

describe('loadGitignoreFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array if file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const patterns = loadGitignoreFile('/path/to/.gitignore');

    expect(patterns).toEqual([]);
    expect(existsSync).toHaveBeenCalledWith('/path/to/.gitignore');
  });

  it('reads and parses gitignore file', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('node_modules\ndist\n');

    const patterns = loadGitignoreFile('/path/to/.gitignore');

    expect(patterns).toEqual(['node_modules', 'dist']);
    expect(readFileSync).toHaveBeenCalledWith('/path/to/.gitignore', 'utf-8');
  });

  it('returns empty array on read error', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('Permission denied');
    });

    const patterns = loadGitignoreFile('/path/to/.gitignore');

    expect(patterns).toEqual([]);
  });
});

describe('createIgnoreFilter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false); // No .gitignore by default
  });

  it('ignores default patterns', () => {
    const filter = createIgnoreFilter({
      rootPath: '/project',
      useDefaults: true,
    });

    expect(filter('node_modules/package.json')).toBe(true);
    expect(filter('.git/config')).toBe(true);
    expect(filter('dist/index.js')).toBe(true);
    expect(filter('src/index.ts')).toBe(false);
  });

  it('respects useDefaults: false', () => {
    const filter = createIgnoreFilter({
      rootPath: '/project',
      useDefaults: false,
    });

    // Without defaults, these should NOT be ignored
    expect(filter('node_modules/package.json')).toBe(false);
    expect(filter('dist/index.js')).toBe(false);
    expect(filter('src/index.ts')).toBe(false);
  });

  it('applies additional patterns', () => {
    const filter = createIgnoreFilter({
      rootPath: '/project',
      additionalPatterns: ['*.custom', 'temp/'],
      useDefaults: false,
    });

    expect(filter('file.custom')).toBe(true);
    expect(filter('temp/data.txt')).toBe(true);
    expect(filter('src/index.ts')).toBe(false);
  });

  it('loads patterns from .gitignore', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('custom-ignore/\n*.secret');

    const filter = createIgnoreFilter({
      rootPath: '/project',
      useDefaults: false,
    });

    expect(filter('custom-ignore/file.txt')).toBe(true);
    expect(filter('data.secret')).toBe(true);
    expect(filter('src/index.ts')).toBe(false);
  });

  it('handles absolute paths by converting to relative', () => {
    const filter = createIgnoreFilter({
      rootPath: '/project',
      useDefaults: true,
    });

    // Should work with absolute paths too
    expect(filter('/project/node_modules/package.json')).toBe(true);
    expect(filter('/project/src/index.ts')).toBe(false);
  });

  it('never ignores root path itself', () => {
    const filter = createIgnoreFilter({
      rootPath: '/project',
      useDefaults: true,
    });

    expect(filter('')).toBe(false);
    expect(filter('/project')).toBe(false);
  });

  it('supports negation patterns', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('*.log\n!important.log');

    const filter = createIgnoreFilter({
      rootPath: '/project',
      useDefaults: false,
    });

    expect(filter('debug.log')).toBe(true);
    expect(filter('important.log')).toBe(false); // Negated!
  });
});

describe('isBinaryFile', () => {
  it('identifies image files as binary', () => {
    expect(isBinaryFile('image.png')).toBe(true);
    expect(isBinaryFile('photo.jpg')).toBe(true);
    expect(isBinaryFile('icon.ico')).toBe(true);
    expect(isBinaryFile('graphic.svg')).toBe(true);
  });

  it('identifies archive files as binary', () => {
    expect(isBinaryFile('archive.zip')).toBe(true);
    expect(isBinaryFile('backup.tar')).toBe(true);
    expect(isBinaryFile('compressed.gz')).toBe(true);
  });

  it('identifies executable files as binary', () => {
    expect(isBinaryFile('program.exe')).toBe(true);
    expect(isBinaryFile('library.dll')).toBe(true);
    expect(isBinaryFile('shared.so')).toBe(true);
  });

  it('identifies font files as binary', () => {
    expect(isBinaryFile('font.woff')).toBe(true);
    expect(isBinaryFile('font.woff2')).toBe(true);
    expect(isBinaryFile('font.ttf')).toBe(true);
  });

  it('identifies document files as binary', () => {
    expect(isBinaryFile('document.pdf')).toBe(true);
    expect(isBinaryFile('spreadsheet.xlsx')).toBe(true);
  });

  it('does not identify text files as binary', () => {
    expect(isBinaryFile('script.ts')).toBe(false);
    expect(isBinaryFile('readme.md')).toBe(false);
    expect(isBinaryFile('config.json')).toBe(false);
    expect(isBinaryFile('styles.css')).toBe(false);
  });

  it('handles case insensitivity', () => {
    expect(isBinaryFile('IMAGE.PNG')).toBe(true);
    expect(isBinaryFile('Photo.JPG')).toBe(true);
  });

  it('handles files without extension', () => {
    expect(isBinaryFile('Makefile')).toBe(false);
    expect(isBinaryFile('Dockerfile')).toBe(false);
  });
});
