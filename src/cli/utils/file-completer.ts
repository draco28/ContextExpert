/**
 * File Completer
 *
 * Provides file name completion for @-references in chat queries.
 * Searches the indexed file paths for a given project.
 *
 * @example
 * ```typescript
 * // User types: @auth<TAB>
 * completeFileName(projectId, 'auth');
 * // Returns: ['auth.ts', 'auth-middleware.ts', 'auth/index.ts']
 * ```
 */

import { basename } from 'node:path';
import { getDb, runMigrations } from '../../database/index.js';

/**
 * Maximum number of file completions to return.
 */
const MAX_FILE_COMPLETIONS = 15;

/**
 * Result of a file completion query.
 */
export interface FileCompletionResult {
  /** The file name (basename) for display */
  fileName: string;
  /** The full path relative to project root */
  fullPath: string;
}

/**
 * Get file paths from a project that match a partial name.
 *
 * Searches the chunks table for distinct file paths that contain
 * the partial string (case-insensitive). This finds files that have
 * been indexed, not all files in the project.
 *
 * @param projectId - The project ID to search within
 * @param partial - The partial file name to match
 * @returns Array of matching file completion results
 *
 * @example
 * ```typescript
 * // Project has: src/auth.ts, src/auth-middleware.ts, lib/oauth.ts
 * completeFileName(1, 'auth');
 * // Returns: [
 * //   { fileName: 'auth.ts', fullPath: 'src/auth.ts' },
 * //   { fileName: 'auth-middleware.ts', fullPath: 'src/auth-middleware.ts' },
 * //   { fileName: 'oauth.ts', fullPath: 'lib/oauth.ts' }
 * // ]
 * ```
 */
export function completeFileName(
  projectId: string,
  partial: string
): FileCompletionResult[] {
  try {
    runMigrations();
    const db = getDb();

    // Normalize partial for matching
    const normalizedPartial = partial.toLowerCase();

    // Query for distinct file paths matching the partial
    // We use LIKE with % wildcards for substring matching
    const rows = db
      .prepare(
        `
        SELECT DISTINCT file_path
        FROM chunks
        WHERE project_id = ?
          AND LOWER(file_path) LIKE ?
        ORDER BY
          -- Prioritize exact basename matches
          CASE WHEN LOWER(file_path) LIKE ? THEN 0 ELSE 1 END,
          -- Then by path length (shorter = more specific)
          LENGTH(file_path)
        LIMIT ?
        `
      )
      .all(
        projectId,
        `%${normalizedPartial}%`, // Substring match anywhere in path
        `%/${normalizedPartial}%`, // Boost matches at start of filename
        MAX_FILE_COMPLETIONS
      ) as Array<{ file_path: string }>;

    return rows.map((row) => ({
      fileName: basename(row.file_path),
      fullPath: row.file_path,
    }));
  } catch (error) {
    // Database not available or query failed
    console.error('File completion failed:', error);
    return [];
  }
}

/**
 * Get just the file names (basenames) for completion.
 *
 * This is a convenience wrapper that returns only the file names,
 * which is what the readline completer needs.
 *
 * @param projectId - The project ID to search within
 * @param partial - The partial file name to match
 * @returns Array of matching file names
 */
export function completeFileNames(
  projectId: string,
  partial: string
): string[] {
  const results = completeFileName(projectId, partial);

  // Deduplicate by fileName (same file name might appear in multiple directories)
  // We want to show unique names first
  const seen = new Set<string>();
  const uniqueNames: string[] = [];

  for (const result of results) {
    if (!seen.has(result.fileName)) {
      seen.add(result.fileName);
      uniqueNames.push(result.fileName);
    }
  }

  return uniqueNames;
}

/**
 * Get all indexed file paths for a project.
 *
 * Used for more advanced file matching (like fuzzy search).
 * Returns full paths, not just file names.
 *
 * @param projectId - The project ID
 * @returns Array of all indexed file paths
 */
export function getAllProjectFiles(projectId: string): string[] {
  try {
    runMigrations();
    const db = getDb();

    const rows = db
      .prepare(
        `
        SELECT DISTINCT file_path
        FROM chunks
        WHERE project_id = ?
        ORDER BY file_path
        `
      )
      .all(projectId) as Array<{ file_path: string }>;

    return rows.map((row) => row.file_path);
  } catch {
    return [];
  }
}
