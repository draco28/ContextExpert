/**
 * Gitignore Pattern Handling
 *
 * Utilities for loading and applying gitignore-style patterns.
 * Uses the 'ignore' package which implements the full gitignore spec.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';

import { DEFAULT_IGNORE_PATTERNS } from './types.js';

/**
 * Options for creating an ignore filter.
 */
export interface IgnoreFilterOptions {
  /** Root directory containing .gitignore */
  rootPath: string;

  /** Additional patterns to ignore (merged with .gitignore) */
  additionalPatterns?: string[];

  /** Whether to use default ignore patterns */
  useDefaults?: boolean;
}

/**
 * A filter function that tests whether a path should be ignored.
 */
export type IgnoreFilter = (filePath: string) => boolean;

/**
 * Load gitignore patterns from a file.
 * Returns empty array if file doesn't exist.
 *
 * @param gitignorePath - Path to the .gitignore file
 * @returns Array of gitignore patterns
 */
export function loadGitignoreFile(gitignorePath: string): string[] {
  if (!existsSync(gitignorePath)) {
    return [];
  }

  try {
    const content = readFileSync(gitignorePath, 'utf-8');
    return parseGitignoreContent(content);
  } catch {
    // If we can't read the file, just skip it
    return [];
  }
}

/**
 * Parse gitignore file content into an array of patterns.
 * Handles comments and empty lines.
 *
 * @param content - Raw gitignore file content
 * @returns Array of valid patterns
 */
export function parseGitignoreContent(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      // Skip empty lines
      if (line === '') return false;
      // Skip comments (but not negation patterns which start with !)
      if (line.startsWith('#')) return false;
      return true;
    });
}

/**
 * Create an ignore filter function for the given root directory.
 *
 * The filter loads patterns from:
 * 1. DEFAULT_IGNORE_PATTERNS (if useDefaults is true)
 * 2. .gitignore in the root directory
 * 3. Additional patterns passed in options
 *
 * @param options - Configuration for the filter
 * @returns A filter function that returns true if a path should be IGNORED
 *
 * @example
 * ```ts
 * const shouldIgnore = createIgnoreFilter({
 *   rootPath: '/path/to/project',
 *   additionalPatterns: ['*.log'],
 * });
 *
 * if (shouldIgnore('node_modules/package/index.js')) {
 *   console.log('Skipped!');
 * }
 * ```
 */
export function createIgnoreFilter(options: IgnoreFilterOptions): IgnoreFilter {
  const { rootPath, additionalPatterns = [], useDefaults = true } = options;

  // Create ignore instance
  const ig: Ignore = ignore();

  // Add default patterns first (lowest priority)
  if (useDefaults) {
    ig.add(DEFAULT_IGNORE_PATTERNS);
  }

  // Add patterns from .gitignore
  const gitignorePath = join(rootPath, '.gitignore');
  const gitignorePatterns = loadGitignoreFile(gitignorePath);
  if (gitignorePatterns.length > 0) {
    ig.add(gitignorePatterns);
  }

  // Add additional patterns (highest priority)
  if (additionalPatterns.length > 0) {
    ig.add(additionalPatterns);
  }

  // Return filter function
  // The ignore library expects paths relative to the root, using forward slashes
  return (filePath: string): boolean => {
    // Convert to relative path if absolute
    let relativePath = filePath;
    if (filePath.startsWith(rootPath)) {
      relativePath = relative(rootPath, filePath);
    }

    // Normalize path separators to forward slashes (for Windows compatibility)
    if (sep === '\\') {
      relativePath = relativePath.split(sep).join('/');
    }

    // Empty path (root itself) is never ignored
    if (relativePath === '') {
      return false;
    }

    return ig.ignores(relativePath);
  };
}

/**
 * Create a filter function compatible with fast-glob's `ignore` option.
 *
 * fast-glob passes entries with a `path` property (relative to cwd).
 * This adapter converts our ignore filter to work with that format.
 *
 * @param ignoreFilter - The ignore filter created by createIgnoreFilter
 * @returns A function compatible with fast-glob's ignore option
 */
export function createFastGlobIgnoreFilter(
  ignoreFilter: IgnoreFilter
): (entry: { path: string }) => boolean {
  // fast-glob expects: return true to INCLUDE, false to EXCLUDE
  // Our ignoreFilter returns: true if should be IGNORED
  // So we invert: return !ignoreFilter(path)
  return (entry: { path: string }): boolean => {
    return !ignoreFilter(entry.path);
  };
}

/**
 * Check if a filename indicates a binary file that should be skipped.
 * This is a simple heuristic based on common binary extensions.
 *
 * @param filename - The filename to check
 * @returns true if the file appears to be binary
 */
export function isBinaryFile(filename: string): boolean {
  const binaryExtensions = new Set([
    // Images
    'png',
    'jpg',
    'jpeg',
    'gif',
    'bmp',
    'ico',
    'webp',
    'svg',
    'tiff',
    'tif',
    'psd',
    'ai',
    // Audio
    'mp3',
    'wav',
    'ogg',
    'flac',
    'aac',
    'm4a',
    // Video
    'mp4',
    'mov',
    'avi',
    'mkv',
    'webm',
    'wmv',
    'flv',
    // Archives
    'zip',
    'tar',
    'gz',
    'bz2',
    'xz',
    '7z',
    'rar',
    // Executables
    'exe',
    'dll',
    'so',
    'dylib',
    'bin',
    // Fonts
    'woff',
    'woff2',
    'ttf',
    'otf',
    'eot',
    // Documents
    'pdf',
    'doc',
    'docx',
    'xls',
    'xlsx',
    'ppt',
    'pptx',
    // Database
    'db',
    'sqlite',
    'sqlite3',
    // Other
    'wasm',
    'map',
    'min.js',
    'min.css',
  ]);

  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return binaryExtensions.has(ext);
}
