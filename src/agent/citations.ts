/**
 * Citation Formatter
 *
 * CLI-optimized formatting for RAG source citations. Transforms RAGSource[]
 * from search results into human-readable text and JSON formats.
 *
 * This module complements the XMLAssembler (which formats context for LLMs)
 * by providing citation output for end users in the terminal.
 *
 * @example
 * ```typescript
 * import { createCitationFormatter, formatCitations } from './citations.js';
 *
 * // Quick formatting
 * const text = formatCitations(result.sources);
 * // "[1] src/auth.ts:42-67 (0.95)
 * //  [2] docs/api.md:15-30 (0.88)"
 *
 * // With factory for reuse
 * const formatter = createCitationFormatter({ style: 'detailed' });
 * console.log(formatter.format(result.sources));
 * ```
 *
 * @packageDocumentation
 */

import { z } from 'zod';
import type { RAGSource } from './types.js';
import { formatScore } from '../search/formatter.js';

// Re-export RAGSource for convenience when using citations module standalone
export type { RAGSource };

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Citation display style for CLI output.
 *
 * - 'compact': Single line with score - "[1] src/auth.ts:42-67 (0.95)"
 * - 'detailed': Multi-line with language info
 * - 'minimal': Just index and path, no score
 */
export type CitationStyle = 'compact' | 'detailed' | 'minimal';

/**
 * Options for formatting citations.
 */
export interface CitationFormatOptions {
  /** Citation display style (default: 'compact') */
  style?: CitationStyle;

  /** Show relevance scores (default: true for compact/detailed, false for minimal) */
  showScores?: boolean;

  /** Show language/file type info (default: true for detailed only) */
  showLanguage?: boolean;

  /** Maximum number of citations to display (default: unlimited) */
  limit?: number;

  /** Show "and N more..." when truncated (default: true) */
  showTruncationHint?: boolean;
}

/**
 * JSON output format for a single citation.
 *
 * Flattened structure for easy consumption by tools like jq.
 */
export interface CitationJSON {
  /** 1-based index for reference (e.g., "[1]") */
  index: number;

  /** File path relative to project root */
  filePath: string;

  /** Starting line number */
  lineStart: number;

  /** Ending line number */
  lineEnd: number;

  /** Relevance score (0-1) */
  score: number;

  /** Programming language or null for non-code */
  language: string | null;

  /** Content type classification */
  fileType: string;
}

/**
 * Complete citations output in JSON format.
 */
export interface CitationsOutputJSON {
  /** Total number of citations */
  count: number;

  /** Array of citation objects */
  citations: CitationJSON[];
}

/**
 * Citation formatter interface returned by factory.
 */
export interface CitationFormatter {
  /** Format citations for CLI text output */
  format(sources: RAGSource[]): string;

  /** Format citations for JSON output */
  formatJSON(sources: RAGSource[]): CitationsOutputJSON;

  /** Format a single citation for text output */
  formatOne(source: RAGSource): string;
}

// ============================================================================
// VALIDATION SCHEMA
// ============================================================================

/**
 * Zod schema for CitationStyle validation.
 */
export const CitationStyleSchema = z.enum(['compact', 'detailed', 'minimal']);

/**
 * Zod schema for CitationFormatOptions validation.
 *
 * Used by createCitationFormatter() to validate configuration.
 */
export const CitationFormatOptionsSchema = z.object({
  style: CitationStyleSchema.optional(),
  showScores: z.boolean().optional(),
  showLanguage: z.boolean().optional(),
  limit: z.number().int().min(0).optional(),
  showTruncationHint: z.boolean().optional(),
});

// ============================================================================
// DEFAULT CONFIGURATION
// ============================================================================

/**
 * Default citation formatter configuration.
 *
 * - Compact style
 * - showScores/showLanguage determined by style if not specified
 * - No limit on citations
 * - Truncation hint enabled
 */
export const DEFAULT_CITATION_CONFIG = {
  style: 'compact' as CitationStyle,
  limit: 0, // 0 = no limit
  showTruncationHint: true,
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Format line range as "start-end" or just "start" if single line.
 *
 * @internal
 */
function formatLineRange(start: number, end: number): string {
  if (start === end || end <= 0) {
    return String(start);
  }
  return `${start}-${end}`;
}

/**
 * Get human-readable display name for language/file type.
 *
 * @internal
 */
function formatLanguageDisplay(language: string | null, fileType: string): string {
  if (language) {
    // Capitalize first letter for display
    return language.charAt(0).toUpperCase() + language.slice(1);
  }

  // Fall back to file type
  switch (fileType) {
    case 'code':
      return 'Code';
    case 'docs':
      return 'Documentation';
    case 'config':
      return 'Config';
    default:
      return 'Unknown';
  }
}

// ============================================================================
// CORE FORMATTING FUNCTIONS
// ============================================================================

/**
 * Format a single citation for CLI display.
 *
 * @param source - RAGSource from search result
 * @param options - Formatting options
 * @returns Formatted citation string
 *
 * @example
 * ```typescript
 * formatCitation(source, { style: 'compact' })
 * // "[1] src/auth.ts:42-67 (0.95)"
 *
 * formatCitation(source, { style: 'detailed' })
 * // "[1] src/auth.ts:42-67
 * //     TypeScript | score: 0.95"
 *
 * formatCitation(source, { style: 'minimal' })
 * // "[1] src/auth.ts:42-67"
 * ```
 */
export function formatCitation(
  source: RAGSource,
  options: CitationFormatOptions = {}
): string {
  const style = options.style ?? DEFAULT_CITATION_CONFIG.style;

  // Determine defaults based on style when not explicitly set
  // - showScores: true for compact/detailed, false for minimal
  // - showLanguage: true for detailed, false for others
  const showScores = options.showScores ?? (style !== 'minimal');
  const showLanguage = options.showLanguage ?? (style === 'detailed');

  // Build location string: "src/auth.ts:42-67"
  const location =
    source.lineRange.start > 0
      ? `${source.filePath}:${formatLineRange(source.lineRange.start, source.lineRange.end)}`
      : source.filePath;

  switch (style) {
    case 'minimal':
      return `[${source.index}] ${location}`;

    case 'detailed': {
      const parts: string[] = [];
      if (showLanguage) {
        parts.push(formatLanguageDisplay(source.language, source.fileType));
      }
      if (showScores) {
        parts.push(`score: ${formatScore(source.score)}`);
      }
      const detailLine = parts.length > 0 ? `\n    ${parts.join(' | ')}` : '';
      return `[${source.index}] ${location}${detailLine}`;
    }

    case 'compact':
    default: {
      const scorePart = showScores ? ` (${formatScore(source.score)})` : '';
      return `[${source.index}] ${location}${scorePart}`;
    }
  }
}

/**
 * Format multiple citations for CLI display.
 *
 * @param sources - Array of RAGSource from search result
 * @param options - Formatting options
 * @returns Formatted citations block with optional truncation hint
 *
 * @example
 * ```typescript
 * formatCitations(sources)
 * // "[1] src/auth.ts:42-67 (0.95)
 * //  [2] src/users.ts:10-25 (0.88)
 * //  [3] src/middleware.ts:5-15 (0.82)"
 *
 * formatCitations(sources, { limit: 2, showTruncationHint: true })
 * // "[1] src/auth.ts:42-67 (0.95)
 * //  [2] src/users.ts:10-25 (0.88)
 * //  ...and 3 more"
 * ```
 */
export function formatCitations(
  sources: RAGSource[],
  options: CitationFormatOptions = {}
): string {
  if (sources.length === 0) {
    return '';
  }

  const config = { ...DEFAULT_CITATION_CONFIG, ...options };

  // Apply limit if configured
  const limit = config.limit > 0 ? config.limit : sources.length;
  const displaySources = sources.slice(0, limit);
  const truncatedCount = sources.length - displaySources.length;

  // Format each citation
  const lines = displaySources.map((source) => formatCitation(source, config));

  // Add truncation hint if needed
  if (truncatedCount > 0 && config.showTruncationHint) {
    lines.push(`...and ${truncatedCount} more`);
  }

  return lines.join('\n');
}

// ============================================================================
// JSON FORMATTING FUNCTIONS
// ============================================================================

/**
 * Format a single citation as JSON-serializable object.
 *
 * @param source - RAGSource from search result
 * @returns JSON-serializable citation object
 */
export function formatCitationJSON(source: RAGSource): CitationJSON {
  return {
    index: source.index,
    filePath: source.filePath,
    lineStart: source.lineRange.start,
    lineEnd: source.lineRange.end,
    score: source.score,
    language: source.language,
    fileType: source.fileType,
  };
}

/**
 * Format all citations as JSON-serializable output.
 *
 * @param sources - Array of RAGSource from search result
 * @returns Complete citations output object
 */
export function formatCitationsJSON(sources: RAGSource[]): CitationsOutputJSON {
  return {
    count: sources.length,
    citations: sources.map(formatCitationJSON),
  };
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create a citation formatter with configuration.
 *
 * Factory pattern consistent with createAssembler(). Validates options
 * via Zod schema and returns a configured formatter object.
 *
 * @param options - Override default configuration
 * @returns Configured formatter object
 * @throws {z.ZodError} If options are invalid
 *
 * @example
 * ```typescript
 * const formatter = createCitationFormatter({ style: 'detailed' });
 *
 * // Use throughout your code
 * console.log(formatter.format(result.sources));
 *
 * // JSON output for --json flag
 * if (options.json) {
 *   console.log(JSON.stringify(formatter.formatJSON(result.sources), null, 2));
 * }
 * ```
 */
export function createCitationFormatter(
  options?: CitationFormatOptions
): CitationFormatter {
  // Validate options if provided
  if (options) {
    CitationFormatOptionsSchema.parse(options);
  }

  const config = { ...DEFAULT_CITATION_CONFIG, ...options };

  return {
    format(sources: RAGSource[]): string {
      return formatCitations(sources, config);
    },

    formatJSON(sources: RAGSource[]): CitationsOutputJSON {
      return formatCitationsJSON(sources);
    },

    formatOne(source: RAGSource): string {
      return formatCitation(source, config);
    },
  };
}
