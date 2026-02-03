/**
 * Path Completer
 *
 * Provides directory path completion for CLI commands like /index.
 * Used by the readline completer to suggest directory paths as the user types.
 *
 * @example
 * ```typescript
 * completeDirectoryPath('./sr');
 * // Returns: ['./src/']
 *
 * completeDirectoryPath('~/proj');
 * // Returns: ['~/projects/', '~/project-backup/']
 * ```
 */

import { readdirSync, statSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Maximum number of completions to return.
 * Prevents overwhelming the user with too many options.
 */
const MAX_COMPLETIONS = 20;

/**
 * Directories to skip during completion.
 * These are typically not useful for indexing.
 */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '__pycache__',
  '.cache',
  '.npm',
  '.yarn',
]);

/**
 * Expand tilde (~) to the user's home directory.
 *
 * @param path - Path that may start with ~
 * @returns Path with ~ expanded to home directory
 */
export function expandTilde(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  if (path === '~') {
    return homedir();
  }
  return path;
}

/**
 * Contract home directory back to tilde for display.
 *
 * @param path - Absolute path that may be under home directory
 * @returns Path with home directory replaced by ~
 */
export function contractTilde(path: string): string {
  const home = homedir();
  if (path.startsWith(home + '/')) {
    return '~' + path.slice(home.length);
  }
  if (path === home) {
    return '~';
  }
  return path;
}

/**
 * Complete a directory path based on partial input.
 *
 * Given a partial path, returns all matching directories.
 * Handles:
 * - Relative paths (./src, ../lib)
 * - Absolute paths (/usr/local)
 * - Tilde expansion (~/projects)
 * - Partial directory names (./sr → ./src/)
 *
 * @param partial - The partial path the user has typed
 * @returns Array of matching directory paths with trailing slash
 *
 * @example
 * ```typescript
 * // User typed: /index ./sr
 * completeDirectoryPath('./sr');
 * // Returns: ['./src/']
 *
 * // User typed: /index ~/
 * completeDirectoryPath('~/');
 * // Returns: ['~/projects/', '~/Documents/', ...]
 * ```
 */
export function completeDirectoryPath(partial: string): string[] {
  // Handle empty input - suggest current directory contents
  if (!partial) {
    return listDirectories('.', '', './');
  }

  // Track if we need to preserve tilde in output
  const hadTilde = partial.startsWith('~');

  // Expand tilde for filesystem operations
  const expanded = expandTilde(partial);

  // Determine the directory to search and the prefix to match
  let searchDir: string;
  let prefix: string;
  let displayPrefix: string;

  // Check if the partial path ends with a slash (user wants contents of that dir)
  if (partial.endsWith('/')) {
    searchDir = expanded;
    prefix = '';
    displayPrefix = partial;
  } else {
    // User is typing a partial directory name
    searchDir = dirname(expanded) || '.';
    prefix = basename(expanded);
    displayPrefix = partial.slice(0, partial.length - prefix.length);
  }

  // List matching directories
  const matches = listDirectories(searchDir, prefix, displayPrefix);

  // If we had tilde, ensure output preserves it
  if (hadTilde && !partial.endsWith('/')) {
    return matches.map((m) => {
      // The displayPrefix already has the tilde if it was in the input
      return m;
    });
  }

  return matches;
}

/**
 * List directories in a given path that match a prefix.
 *
 * @param dir - Directory to search in
 * @param prefix - Prefix to filter directory names (case-insensitive)
 * @param displayPrefix - Prefix to prepend to results for display
 * @returns Array of matching directory paths
 */
function listDirectories(
  dir: string,
  prefix: string,
  displayPrefix: string
): string[] {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const lowerPrefix = prefix.toLowerCase();

    const matches: string[] = [];

    for (const entry of entries) {
      // Only consider directories
      if (!entry.isDirectory()) continue;

      // Skip hidden directories unless user explicitly typed a dot
      if (entry.name.startsWith('.') && !prefix.startsWith('.')) continue;

      // Skip common non-useful directories
      if (SKIP_DIRECTORIES.has(entry.name)) continue;

      // Check if name matches prefix (case-insensitive)
      if (entry.name.toLowerCase().startsWith(lowerPrefix)) {
        matches.push(displayPrefix + entry.name + '/');
      }

      // Stop if we have enough matches
      if (matches.length >= MAX_COMPLETIONS) break;
    }

    // Sort alphabetically for consistent ordering
    return matches.sort((a, b) => a.localeCompare(b));
  } catch {
    // Directory doesn't exist or can't be read
    return [];
  }
}

/**
 * Check if a path exists and is a directory.
 *
 * @param path - Path to check
 * @returns true if path exists and is a directory
 */
export function isDirectory(path: string): boolean {
  try {
    const expanded = expandTilde(path);
    const stats = statSync(expanded);
    return stats.isDirectory();
  } catch {
    return false;
  }
}
