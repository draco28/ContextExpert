/**
 * Search Result Formatter
 *
 * Utilities for formatting search results for CLI display and JSON output.
 * Provides human-readable output with scores, file paths, line numbers,
 * and truncated snippets.
 *
 * @example
 * ```typescript
 * import { formatResult, formatResults, formatResultJSON } from './formatter.js';
 *
 * // Human-readable format
 * const text = formatResult(result);
 * // [0.92] src/search/retriever.ts:45-67
 * //   Implements the hybrid search pipeline using dense vectors...
 *
 * // JSON format
 * const json = formatResultJSON(result);
 * // { score: 0.92, filePath: "...", lineStart: 45, ... }
 * ```
 *
 * @packageDocumentation
 */

import type { SearchResultWithContext, FormatOptions, FormattedResultJSON } from './types.js';

// ============================================================================
// Constants
// ============================================================================

/** Default maximum snippet length in characters */
const DEFAULT_SNIPPET_LENGTH = 200;

/** Indent for snippet content in text output */
const SNIPPET_INDENT = '  ';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Format a similarity score as a 2-decimal string.
 *
 * @param score - Score value (0-1 for cosine similarity)
 * @returns Formatted score string (e.g., "0.92")
 *
 * @example
 * ```typescript
 * formatScore(0.9234)  // "0.92"
 * formatScore(0.1)     // "0.10"
 * formatScore(1)       // "1.00"
 * ```
 */
export function formatScore(score: number): string {
  return score.toFixed(2);
}

/**
 * Truncate content to a maximum length with ellipsis.
 *
 * Handles multi-line content by collapsing newlines to spaces.
 * This makes snippets easier to read in single-line CLI output.
 *
 * @param content - The text content to truncate
 * @param maxLength - Maximum length (default: 200)
 * @returns Truncated content with "..." suffix if truncated
 *
 * @example
 * ```typescript
 * truncateSnippet("Hello world", 5)
 * // "Hello..."
 *
 * truncateSnippet("Line 1\nLine 2", 20)
 * // "Line 1 Line 2"
 * ```
 */
export function truncateSnippet(content: string, maxLength: number = DEFAULT_SNIPPET_LENGTH): string {
  // Collapse newlines and multiple spaces into single spaces
  const normalized = content.replace(/\s+/g, ' ').trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return normalized.slice(0, maxLength) + '...';
}

/**
 * Format line range as "start-end" or just "start" if same.
 */
function formatLineRange(start: number, end: number): string {
  if (start === end) {
    return String(start);
  }
  return `${start}-${end}`;
}

// ============================================================================
// Text Formatting Functions
// ============================================================================

/**
 * Format a single search result for text display.
 *
 * Output format:
 * ```
 * [0.92] src/search/retriever.ts:45-67
 *   Implements the hybrid search pipeline using dense vectors...
 * ```
 *
 * @param result - The search result to format
 * @param options - Formatting options
 * @returns Formatted string for CLI display
 */
export function formatResult(
  result: SearchResultWithContext,
  options: FormatOptions = {}
): string {
  const {
    snippetLength = DEFAULT_SNIPPET_LENGTH,
    showProject = false,
    showScore = true,
    showLineNumbers = true,
  } = options;

  const parts: string[] = [];

  // Score prefix: [0.92]
  if (showScore) {
    parts.push(`[${formatScore(result.score)}]`);
  }

  // Project prefix (for cross-project searches)
  // Prefer projectName for human readability, fallback to projectId
  const projectLabel = result.metadata.projectName ?? result.metadata.projectId;
  if (showProject && projectLabel) {
    parts.push(`[${projectLabel}]`);
  }

  // File path with optional line numbers
  let location = result.filePath;
  if (showLineNumbers && result.lineRange.start > 0) {
    location += `:${formatLineRange(result.lineRange.start, result.lineRange.end)}`;
  }
  parts.push(location);

  // First line: score + location
  const headerLine = parts.join(' ');

  // Second line: indented snippet
  const snippet = truncateSnippet(result.content, snippetLength);
  const snippetLine = SNIPPET_INDENT + snippet;

  return `${headerLine}\n${snippetLine}`;
}

/**
 * Format multiple search results for text display.
 *
 * Results are separated by blank lines for readability.
 *
 * @param results - Array of search results to format
 * @param options - Formatting options (applied to all results)
 * @returns Formatted string with all results
 */
export function formatResults(
  results: SearchResultWithContext[],
  options: FormatOptions = {}
): string {
  if (results.length === 0) {
    return '';
  }

  return results
    .map((result) => formatResult(result, options))
    .join('\n\n');
}

// ============================================================================
// JSON Formatting Functions
// ============================================================================

/**
 * Format a single search result as JSON-serializable object.
 *
 * Flattens nested structures for easier consumption by tools like jq
 * and JavaScript consumers.
 *
 * @param result - The search result to format
 * @param options - Formatting options (only showProject affects output)
 * @returns JSON-serializable result object
 */
export function formatResultJSON(
  result: SearchResultWithContext,
  options: FormatOptions = {}
): FormattedResultJSON {
  const formatted: FormattedResultJSON = {
    score: result.score,
    filePath: result.filePath,
    lineStart: result.lineRange.start,
    lineEnd: result.lineRange.end,
    content: result.content,
    language: result.language,
    fileType: result.fileType,
  };

  // Include project info when cross-project display is enabled
  if (options.showProject) {
    if (result.metadata.projectId) {
      formatted.projectId = result.metadata.projectId as string;
    }
    if (result.metadata.projectName) {
      formatted.projectName = result.metadata.projectName as string;
    }
  }

  return formatted;
}

/**
 * Format multiple search results as JSON-serializable array.
 *
 * @param results - Array of search results to format
 * @param options - Formatting options (only showProject affects output)
 * @returns Array of JSON-serializable result objects
 */
export function formatResultsJSON(
  results: SearchResultWithContext[],
  options: FormatOptions = {}
): FormattedResultJSON[] {
  return results.map((result) => formatResultJSON(result, options));
}
