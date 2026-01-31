/**
 * Tests for gitignore pattern handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  loadGitignoreFile,
  parseGitignoreContent,
  createIgnoreFilter,
  createFastGlobIgnoreFilter,
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

  // ============================================================================
  // Complex Pattern Tests
  // ============================================================================

  describe('complex patterns', () => {
    it('matches double-star glob patterns for any depth', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('**/*.log');

      const filter = createIgnoreFilter({
        rootPath: '/project',
        useDefaults: false,
      });

      // Should match .log files at any depth
      expect(filter('app.log')).toBe(true);
      expect(filter('logs/app.log')).toBe(true);
      expect(filter('deep/nested/path/app.log')).toBe(true);
      // Should not match non-.log files
      expect(filter('app.ts')).toBe(false);
      expect(filter('logs/readme.md')).toBe(false);
    });

    it('distinguishes directory patterns from file patterns', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      // build/ means only directories named build
      // build means both files and directories named build
      vi.mocked(readFileSync).mockReturnValue('build/\ntmp');

      const filter = createIgnoreFilter({
        rootPath: '/project',
        useDefaults: false,
      });

      // build/ pattern - matches directory contents
      expect(filter('build/output.js')).toBe(true);
      expect(filter('build/nested/file.js')).toBe(true);

      // tmp pattern - matches both files and directories
      expect(filter('tmp')).toBe(true);
      expect(filter('tmp/cache.json')).toBe(true);
    });

    it('matches patterns with single-star wildcards', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('*.min.js\ntest-*.ts');

      const filter = createIgnoreFilter({
        rootPath: '/project',
        useDefaults: false,
      });

      expect(filter('bundle.min.js')).toBe(true);
      expect(filter('vendor.min.js')).toBe(true);
      expect(filter('test-utils.ts')).toBe(true);
      expect(filter('test-helpers.ts')).toBe(true);
      // Should not match
      expect(filter('bundle.js')).toBe(false);
      expect(filter('utils.ts')).toBe(false);
    });

    it('matches character class patterns', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('file[0-9].txt\n*.ba[ck]');

      const filter = createIgnoreFilter({
        rootPath: '/project',
        useDefaults: false,
      });

      expect(filter('file1.txt')).toBe(true);
      expect(filter('file9.txt')).toBe(true);
      expect(filter('data.bak')).toBe(true);
      expect(filter('data.bac')).toBe(true);
      // Should not match
      expect(filter('fileA.txt')).toBe(false);
      expect(filter('data.bat')).toBe(false);
    });
  });

  // ============================================================================
  // Advanced Negation Tests
  // ============================================================================

  describe('advanced negation', () => {
    it('handles negation for files in ignored directories', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      // To un-ignore specific files inside an ignored directory,
      // you must first un-ignore the directory path, then the files
      vi.mocked(readFileSync).mockReturnValue('logs/*\n!logs/important.log');

      const filter = createIgnoreFilter({
        rootPath: '/project',
        useDefaults: false,
      });

      // logs/* ignores files in logs/
      expect(filter('logs/debug.log')).toBe(true);
      // But logs/important.log is negated
      expect(filter('logs/important.log')).toBe(false);
    });

    it('handles negation with wildcards', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('*.test.ts\n!critical.test.ts');

      const filter = createIgnoreFilter({
        rootPath: '/project',
        useDefaults: false,
      });

      expect(filter('utils.test.ts')).toBe(true);
      expect(filter('helpers.test.ts')).toBe(true);
      expect(filter('critical.test.ts')).toBe(false); // Negated!
    });

    it('respects pattern order - later patterns override earlier', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      // First ignore all .env, then un-ignore .env.example
      vi.mocked(readFileSync).mockReturnValue('.env*\n!.env.example');

      const filter = createIgnoreFilter({
        rootPath: '/project',
        useDefaults: false,
      });

      expect(filter('.env')).toBe(true);
      expect(filter('.env.local')).toBe(true);
      expect(filter('.env.production')).toBe(true);
      expect(filter('.env.example')).toBe(false); // Un-ignored!
    });

    it('handles layered ignore and negation patterns', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      // Ignore all .env files, un-ignore .env.example, re-ignore .env.example.local
      vi.mocked(readFileSync).mockReturnValue('.env*\n!.env.example\n.env.example.local');

      const filter = createIgnoreFilter({
        rootPath: '/project',
        useDefaults: false,
      });

      expect(filter('.env')).toBe(true); // Ignored by .env*
      expect(filter('.env.local')).toBe(true); // Ignored by .env*
      expect(filter('.env.example')).toBe(false); // Un-ignored
      expect(filter('.env.example.local')).toBe(true); // Re-ignored
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('edge cases', () => {
    it('handles empty .gitignore file', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('');

      const filter = createIgnoreFilter({
        rootPath: '/project',
        useDefaults: false,
      });

      // Nothing should be ignored
      expect(filter('anything.ts')).toBe(false);
      expect(filter('node_modules/pkg.js')).toBe(false);
    });

    it('handles .gitignore with only comments', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(`# This is a comment
# Another comment
# All comments, no patterns
`);

      const filter = createIgnoreFilter({
        rootPath: '/project',
        useDefaults: false,
      });

      // Nothing should be ignored (all lines are comments)
      expect(filter('anything.ts')).toBe(false);
    });

    it('handles .gitignore with only whitespace lines', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('   \n\t\n  \t  \n');

      const filter = createIgnoreFilter({
        rootPath: '/project',
        useDefaults: false,
      });

      expect(filter('file.ts')).toBe(false);
    });

    it('handles patterns with trailing spaces (trimmed)', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('node_modules   \ndist\t\t');

      const filter = createIgnoreFilter({
        rootPath: '/project',
        useDefaults: false,
      });

      expect(filter('node_modules/pkg.js')).toBe(true);
      expect(filter('dist/bundle.js')).toBe(true);
    });

    it('combines defaults, .gitignore, and additional patterns', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('custom-ignore/');

      const filter = createIgnoreFilter({
        rootPath: '/project',
        useDefaults: true, // Include defaults
        additionalPatterns: ['*.custom'], // Add custom pattern
      });

      // Default pattern
      expect(filter('node_modules/pkg.js')).toBe(true);
      // .gitignore pattern
      expect(filter('custom-ignore/file.txt')).toBe(true);
      // Additional pattern
      expect(filter('file.custom')).toBe(true);
      // Not ignored
      expect(filter('src/index.ts')).toBe(false);
    });
  });
});

// ============================================================================
// createFastGlobIgnoreFilter Tests
// ============================================================================

describe('createFastGlobIgnoreFilter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it('inverts the ignore filter for fast-glob compatibility', () => {
    const filter = createIgnoreFilter({
      rootPath: '/project',
      useDefaults: true,
    });

    const fastGlobFilter = createFastGlobIgnoreFilter(filter);

    // fast-glob expects: true = INCLUDE, false = EXCLUDE
    // Our filter returns: true = IGNORE (exclude)
    // So fastGlobFilter inverts: ignored files return false
    expect(fastGlobFilter({ path: 'node_modules/pkg.js' })).toBe(false); // Excluded
    expect(fastGlobFilter({ path: 'src/index.ts' })).toBe(true); // Included
  });

  it('handles the path property from fast-glob entries', () => {
    const filter = createIgnoreFilter({
      rootPath: '/project',
      additionalPatterns: ['*.log'],
      useDefaults: false,
    });

    const fastGlobFilter = createFastGlobIgnoreFilter(filter);

    // fast-glob passes entries with { path: string }
    expect(fastGlobFilter({ path: 'debug.log' })).toBe(false); // Excluded
    expect(fastGlobFilter({ path: 'app.ts' })).toBe(true); // Included
  });

  it('works with nested paths', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('logs/');

    const filter = createIgnoreFilter({
      rootPath: '/project',
      useDefaults: false,
    });

    const fastGlobFilter = createFastGlobIgnoreFilter(filter);

    expect(fastGlobFilter({ path: 'logs/app.log' })).toBe(false); // Excluded
    expect(fastGlobFilter({ path: 'src/utils.ts' })).toBe(true); // Included
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
