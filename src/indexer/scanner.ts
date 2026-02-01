/**
 * File Scanner
 *
 * Main file discovery implementation using fast-glob for directory traversal.
 * Discovers files matching supported extensions while respecting gitignore patterns.
 */

import { statSync } from 'node:fs';
import { resolve, relative, extname, basename } from 'node:path';
import fg from 'fast-glob';

import {
  createIgnoreFilter,
  isBinaryFile,
} from './ignore.js';
import {
  DEFAULT_SUPPORTED_EXTENSIONS,
  getLanguageForExtension,
  getTypeForLanguage,
  type FileInfo,
  type FileType,
  type Language,
  type ScanOptions,
  type ScanResult,
  type ScanStats,
} from './types.js';

// Re-export types for consumers
export type { ScanResult, ScanStats };

/**
 * Scan a directory for files to index.
 *
 * This is the main entry point for file discovery. It:
 * 1. Traverses the directory tree using fast-glob
 * 2. Respects .gitignore and default ignore patterns
 * 3. Filters by supported file extensions
 * 4. Gathers metadata for each discovered file
 *
 * @param rootPath - Directory to scan (absolute or relative path)
 * @param options - Scan configuration options
 * @returns Scan result with files and statistics
 *
 * @example
 * ```ts
 * const result = await scanDirectory('/path/to/project', {
 *   maxDepth: 10,
 *   onFile: (file) => console.log(`Found: ${file.relativePath}`),
 * });
 *
 * console.log(`Discovered ${result.stats.totalFiles} files`);
 * ```
 */
export async function scanDirectory(
  rootPath: string,
  options: ScanOptions = {}
): Promise<ScanResult> {
  const startTime = performance.now();

  // Resolve to absolute path
  const absoluteRoot = resolve(rootPath);

  // Get extensions to scan
  const extensions = options.extensions ?? DEFAULT_SUPPORTED_EXTENSIONS;

  // Build glob patterns for file matching
  // Pattern: **/*.{ts,js,py,...} matches files at any depth
  const patterns = buildGlobPatterns(extensions);

  // Create ignore filter
  const ignoreFilter = createIgnoreFilter({
    rootPath: absoluteRoot,
    additionalPatterns: options.additionalIgnorePatterns,
    useDefaults: true,
  });

  // Track statistics
  const stats: ScanStats = {
    totalFiles: 0,
    totalSize: 0,
    byLanguage: {} as Record<Language, number>,
    byType: {} as Record<FileType, number>,
    errorsEncountered: 0,
    scanDurationMs: 0,
  };

  // Initialize counters
  for (const lang of Object.values(
    {} as Record<string, Language>
  ) as Language[]) {
    stats.byLanguage[lang] = 0;
  }

  const files: FileInfo[] = [];

  try {
    // Use fast-glob to find all matching files
    // We use the stream API for memory efficiency on large directories
    const entries = await fg(patterns, {
      cwd: absoluteRoot,
      absolute: true,
      dot: false, // Don't match dotfiles by default (. prefix)
      onlyFiles: true,
      followSymbolicLinks: options.followSymlinks ?? false,
      deep: options.maxDepth ?? Infinity,
      suppressErrors: true, // Don't throw on permission errors
      // Custom filter to apply ignore patterns
      // fast-glob calls this for each entry
      ignore: [], // We handle ignore ourselves for more control
    });

    // Process each discovered file
    for (const absolutePath of entries) {
      // Get relative path for ignore checking
      const relativePath = relative(absoluteRoot, absolutePath);

      // Apply our ignore filter (includes gitignore + defaults)
      if (ignoreFilter(relativePath)) {
        continue;
      }

      // Skip binary files
      const filename = basename(absolutePath);
      if (isBinaryFile(filename)) {
        continue;
      }

      // Get file metadata
      let fileInfo: FileInfo;
      try {
        fileInfo = getFileInfo(absolutePath, absoluteRoot);
      } catch (error) {
        stats.errorsEncountered++;
        options.onError?.(absolutePath, error as Error);
        continue;
      }

      // Add to results
      files.push(fileInfo);

      // Update statistics
      stats.totalFiles++;
      stats.totalSize += fileInfo.size;
      stats.byLanguage[fileInfo.language] =
        (stats.byLanguage[fileInfo.language] ?? 0) + 1;
      stats.byType[fileInfo.type] = (stats.byType[fileInfo.type] ?? 0) + 1;

      // Invoke callback if provided
      options.onFile?.(fileInfo);
    }
  } catch (error) {
    // If the root directory itself is inaccessible, that's a fatal error
    throw new Error(
      `Failed to scan directory: ${absoluteRoot}. ${(error as Error).message}`
    );
  }

  // Calculate duration
  stats.scanDurationMs = Math.round(performance.now() - startTime);

  return {
    rootPath: absoluteRoot,
    files,
    stats,
  };
}

/**
 * Special filenames that should be matched even without extensions.
 * Maps the filename (lowercase) to the extension it should be treated as.
 */
const SPECIAL_FILENAMES: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'text',
  rakefile: 'ruby',
  gemfile: 'ruby',
  podfile: 'ruby',
  vagrantfile: 'ruby',
  procfile: 'yaml',
  cakefile: 'text',
  brewfile: 'ruby',
};

/**
 * Build glob patterns for the given extensions.
 * Handles both regular extensions and special filenames.
 *
 * @param extensions - List of extensions to match
 * @returns Array of glob patterns
 */
function buildGlobPatterns(extensions: string[]): string[] {
  const patterns: string[] = [];

  // Standard extension pattern
  if (extensions.length === 1) {
    patterns.push(`**/*.${extensions[0]}`);
  } else if (extensions.length > 0) {
    patterns.push(`**/*.{${extensions.join(',')}}`);
  }

  // Add special filename patterns for requested extensions
  const extensionSet = new Set(extensions.map((e) => e.toLowerCase()));
  for (const [filename, ext] of Object.entries(SPECIAL_FILENAMES)) {
    if (extensionSet.has(ext)) {
      // Match at any depth: **/Dockerfile, Dockerfile
      patterns.push(`**/${filename}`);
      patterns.push(`**/${filename.charAt(0).toUpperCase()}${filename.slice(1)}`);
    }
  }

  return patterns;
}

/**
 * Get file information for a single file.
 *
 * @param absolutePath - Absolute path to the file
 * @param rootPath - Root directory for relative path calculation
 * @returns File metadata
 */
function getFileInfo(absolutePath: string, rootPath: string): FileInfo {
  // Get file stats
  const stat = statSync(absolutePath);

  // Extract extension (without dot)
  let ext = extname(absolutePath).toLowerCase();
  if (ext.startsWith('.')) {
    ext = ext.slice(1);
  }

  // Handle special cases (e.g., Dockerfile has no extension)
  const filename = basename(absolutePath);
  if (ext === '' && filename.toLowerCase() === 'dockerfile') {
    ext = 'dockerfile';
  }

  // Detect language and type
  const language = getLanguageForExtension(ext);
  const type = getTypeForLanguage(language);

  return {
    path: absolutePath,
    relativePath: relative(rootPath, absolutePath),
    extension: ext,
    language,
    type,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

/**
 * Scan multiple directories and merge results.
 *
 * Useful for scanning multiple projects or workspaces.
 * Files are deduplicated by absolute path.
 *
 * @param rootPaths - Array of directories to scan
 * @param options - Scan configuration options
 * @returns Combined scan result
 */
export async function scanDirectories(
  rootPaths: string[],
  options: ScanOptions = {}
): Promise<ScanResult[]> {
  const results: ScanResult[] = [];

  for (const rootPath of rootPaths) {
    const result = await scanDirectory(rootPath, options);
    results.push(result);
  }

  return results;
}

/**
 * Get a quick count of files that would be scanned.
 *
 * Faster than full scan as it doesn't gather metadata.
 * Useful for progress indicators.
 *
 * @param rootPath - Directory to scan
 * @param options - Scan configuration options
 * @returns Number of files that would be scanned
 */
export async function countFiles(
  rootPath: string,
  options: ScanOptions = {}
): Promise<number> {
  const absoluteRoot = resolve(rootPath);
  const extensions = options.extensions ?? DEFAULT_SUPPORTED_EXTENSIONS;

  const patterns = buildGlobPatterns(extensions);

  const ignoreFilter = createIgnoreFilter({
    rootPath: absoluteRoot,
    additionalPatterns: options.additionalIgnorePatterns,
    useDefaults: true,
  });

  const entries = await fg(patterns, {
    cwd: absoluteRoot,
    absolute: false,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: options.followSymlinks ?? false,
    deep: options.maxDepth ?? Infinity,
    suppressErrors: true,
  });

  let count = 0;
  for (const entry of entries) {
    if (!ignoreFilter(entry) && !isBinaryFile(basename(entry))) {
      count++;
    }
  }

  return count;
}
