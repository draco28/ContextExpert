/**
 * File Reference Parser and Resolver
 *
 * Handles @file syntax in chat queries, allowing users to explicitly
 * include specific files in the context sent to the LLM.
 *
 * @example
 * ```typescript
 * // Parse @-references from user input
 * const refs = parseFileReferences('@auth.ts how does JWT work?');
 * // refs = ['auth.ts']
 *
 * // Resolve references to actual file content
 * const resolved = await resolveFileReferences(projectId, refs);
 * // resolved = [{ pattern: 'auth.ts', matches: [{ path: 'src/auth.ts', content: '...' }] }]
 * ```
 */

import { basename } from 'node:path';
import { getDb, runMigrations } from '../database/index.js';

// ============================================================================
// Types
// ============================================================================

/**
 * A single file match with its content.
 */
export interface FileMatch {
  /** Full path relative to project root */
  filePath: string;
  /** File name (basename) for display */
  fileName: string;
  /** Concatenated content from all chunks of this file */
  content: string;
  /** Number of chunks that make up this file */
  chunkCount: number;
  /** Similarity score (0-1) for fuzzy matching */
  score: number;
}

/**
 * Result of resolving a single @-reference.
 */
export interface ResolvedReference {
  /** The original pattern from the user (e.g., 'auth.ts') */
  pattern: string;
  /** All files that matched the pattern */
  matches: FileMatch[];
  /** Whether the match was exact (basename match) vs fuzzy (substring) */
  isExactMatch: boolean;
}

/**
 * Options for resolving file references.
 */
export interface ResolveOptions {
  /** Maximum number of matches per pattern (default: 3) */
  maxMatchesPerPattern?: number;
  /** Maximum total content length in characters (default: 50000) */
  maxTotalContentLength?: number;
  /** Minimum score threshold for fuzzy matches (default: 0.3) */
  minScore?: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Regex to match @file references in user input.
 * Matches @filename or @path/to/file patterns.
 *
 * Design:
 * - Negative lookbehind `(?<![a-zA-Z0-9])` avoids email addresses
 * - Character class `[^\s@()\[\]{},;:!?'"]+` captures filename/path
 * - Excludes trailing punctuation that's likely sentence structure
 *
 * Examples:
 * - `user@example.com` → no match (@ preceded by alphanumeric)
 * - `@auth.ts` → matches "auth.ts"
 * - `(@file.ts)` → matches "file.ts" (excludes parens)
 * - `@src/utils.ts, and more` → matches "src/utils.ts" (excludes comma)
 */
const FILE_REFERENCE_REGEX = /(?<![a-zA-Z0-9])@([^\s@()\[\]{},;:!?'"]+)/g;

/**
 * Default options for resolving references.
 */
const DEFAULT_OPTIONS: Required<ResolveOptions> = {
  maxMatchesPerPattern: 3,
  maxTotalContentLength: 50000,
  minScore: 0.3,
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Parse @file references from user input.
 *
 * Extracts all @filename patterns from the input string.
 * The @ symbol is not included in the returned patterns.
 *
 * @param input - User's question/message
 * @returns Array of file patterns (without @ prefix)
 *
 * @example
 * ```typescript
 * parseFileReferences('@auth.ts how does this work?');
 * // ['auth.ts']
 *
 * parseFileReferences('@src/auth.ts @utils/helper.ts explain these');
 * // ['src/auth.ts', 'utils/helper.ts']
 *
 * parseFileReferences('no references here');
 * // []
 * ```
 */
export function parseFileReferences(input: string): string[] {
  const matches: string[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  FILE_REFERENCE_REGEX.lastIndex = 0;

  while ((match = FILE_REFERENCE_REGEX.exec(input)) !== null) {
    const pattern = match[1];
    if (pattern && pattern.length > 0) {
      matches.push(pattern);
    }
  }

  // Deduplicate (in case user references same file twice)
  return [...new Set(matches)];
}

/**
 * Remove @file references from user input.
 *
 * Returns the input with all @filename patterns removed,
 * which is useful for sending the "clean" question to the LLM.
 *
 * @param input - User's question with @-references
 * @returns Question with @-references removed
 *
 * @example
 * ```typescript
 * stripFileReferences('@auth.ts how does JWT work?');
 * // 'how does JWT work?'
 * ```
 */
export function stripFileReferences(input: string): string {
  return input.replace(FILE_REFERENCE_REGEX, '').replace(/\s+/g, ' ').trim();
}

/**
 * Resolve @file references to actual file content.
 *
 * For each pattern, searches the project's indexed files for matches
 * and retrieves their content from chunks.
 *
 * @param projectId - The project to search within
 * @param patterns - Array of file patterns to resolve
 * @param options - Resolution options
 * @returns Array of resolved references with file content
 */
export function resolveFileReferences(
  projectId: number,
  patterns: string[],
  options: ResolveOptions = {}
): ResolvedReference[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const results: ResolvedReference[] = [];
  let totalContentLength = 0;

  for (const pattern of patterns) {
    // Find matching files
    const matches = findMatchingFiles(projectId, pattern, opts.maxMatchesPerPattern);

    // Filter by score threshold
    const qualifiedMatches = matches.filter((m) => m.score >= opts.minScore);

    // Check if we have an exact basename match
    const isExactMatch = qualifiedMatches.some(
      (m) => m.fileName.toLowerCase() === pattern.toLowerCase()
    );

    // Get content for each match (respecting total length limit)
    const matchesWithContent: FileMatch[] = [];

    for (const match of qualifiedMatches) {
      // Check if adding this file would exceed limit
      if (totalContentLength >= opts.maxTotalContentLength) {
        break;
      }

      const content = getFileContent(projectId, match.filePath);
      const truncatedContent = truncateContent(
        content,
        opts.maxTotalContentLength - totalContentLength
      );

      totalContentLength += truncatedContent.length;

      matchesWithContent.push({
        ...match,
        content: truncatedContent,
      });
    }

    results.push({
      pattern,
      matches: matchesWithContent,
      isExactMatch,
    });
  }

  return results;
}

/**
 * Format resolved references as context for the LLM.
 *
 * Creates a structured text block that can be prepended to RAG context.
 *
 * @param resolved - Array of resolved references
 * @returns Formatted context string
 */
export function formatReferencesAsContext(resolved: ResolvedReference[]): string {
  const sections: string[] = [];

  for (const ref of resolved) {
    if (ref.matches.length === 0) {
      sections.push(`<!-- @${ref.pattern}: No matching files found -->`);
      continue;
    }

    for (const match of ref.matches) {
      sections.push(
        `<referenced_file path="${match.filePath}" pattern="@${ref.pattern}">\n${match.content}\n</referenced_file>`
      );
    }
  }

  if (sections.length === 0) {
    return '';
  }

  return `<user_referenced_files>\n${sections.join('\n\n')}\n</user_referenced_files>`;
}

/**
 * Get a summary of resolved references for display to the user.
 *
 * @param resolved - Array of resolved references
 * @returns Human-readable summary
 */
export function getReferenceSummary(resolved: ResolvedReference[]): string {
  const parts: string[] = [];

  for (const ref of resolved) {
    if (ref.matches.length === 0) {
      parts.push(`@${ref.pattern}: no matches`);
    } else if (ref.matches.length === 1) {
      parts.push(`@${ref.pattern} → ${ref.matches[0]!.filePath}`);
    } else {
      const paths = ref.matches.map((m) => m.fileName).join(', ');
      parts.push(`@${ref.pattern} → ${ref.matches.length} files (${paths})`);
    }
  }

  return parts.join(' | ');
}

// ============================================================================
// Internal Functions
// ============================================================================

/**
 * Find files matching a pattern using fuzzy search.
 *
 * Scoring:
 * - Exact basename match: 1.0
 * - Basename starts with pattern: 0.8
 * - Basename contains pattern: 0.6
 * - Path contains pattern: 0.4
 */
function findMatchingFiles(
  projectId: number,
  pattern: string,
  limit: number
): Omit<FileMatch, 'content'>[] {
  try {
    runMigrations();
    const db = getDb();

    const normalizedPattern = pattern.toLowerCase();

    // Get all distinct file paths for this project
    const rows = db
      .prepare(
        `
        SELECT DISTINCT file_path, COUNT(*) as chunk_count
        FROM chunks
        WHERE project_id = ?
        GROUP BY file_path
        `
      )
      .all(projectId) as Array<{ file_path: string; chunk_count: number }>;

    // Score and filter matches
    const scored: Array<Omit<FileMatch, 'content'>> = [];

    for (const row of rows) {
      const filePath = row.file_path;
      const fileName = basename(filePath);
      const lowerPath = filePath.toLowerCase();
      const lowerName = fileName.toLowerCase();

      let score = 0;

      // Exact basename match (highest priority)
      if (lowerName === normalizedPattern) {
        score = 1.0;
      }
      // Basename starts with pattern
      else if (lowerName.startsWith(normalizedPattern)) {
        score = 0.8;
      }
      // Basename contains pattern
      else if (lowerName.includes(normalizedPattern)) {
        score = 0.6;
      }
      // Full path contains pattern
      else if (lowerPath.includes(normalizedPattern)) {
        score = 0.4;
      }

      if (score > 0) {
        scored.push({
          filePath,
          fileName,
          chunkCount: row.chunk_count,
          score,
        });
      }
    }

    // Sort by score (descending), then by path length (shorter = more specific)
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.filePath.length - b.filePath.length;
    });

    return scored.slice(0, limit);
  } catch (error) {
    console.error('Error finding matching files:', error);
    return [];
  }
}

/**
 * Get the full content of a file by concatenating its chunks.
 */
function getFileContent(projectId: number, filePath: string): string {
  try {
    runMigrations();
    const db = getDb();

    // Get all chunks for this file, ordered by their position
    const rows = db
      .prepare(
        `
        SELECT content
        FROM chunks
        WHERE project_id = ? AND file_path = ?
        ORDER BY id
        `
      )
      .all(projectId, filePath) as Array<{ content: string }>;

    // Concatenate chunks
    return rows.map((r) => r.content).join('\n\n');
  } catch (error) {
    console.error('Error getting file content:', error);
    return '';
  }
}

/**
 * Truncate content to a maximum length, preserving complete lines.
 */
function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }

  // Find the last newline before the limit
  const truncated = content.slice(0, maxLength);
  const lastNewline = truncated.lastIndexOf('\n');

  if (lastNewline > maxLength * 0.8) {
    // If we can keep at least 80% of the content with a clean break
    return truncated.slice(0, lastNewline) + '\n\n[... content truncated ...]';
  }

  return truncated + '\n\n[... content truncated ...]';
}
