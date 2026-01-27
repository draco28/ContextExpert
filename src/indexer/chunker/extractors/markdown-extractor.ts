/**
 * Markdown Extractor
 *
 * Uses the marked lexer to extract:
 * - Fenced code blocks → 'code' segments with language info
 * - Prose sections (paragraphs, lists) → 'docs' segments
 *
 * Preserves section headers as context for chunking.
 */

import { marked } from 'marked';

import type { ExtractedSegment, ExtractionResult } from '../types.js';

/**
 * Extract segments from markdown content.
 *
 * Separates code blocks (for code-specific chunking) from prose
 * (for semantic chunking). Tracks section headers as context.
 *
 * @param content - The markdown content
 * @returns Extraction result with segments and original content
 */
export function extractMarkdownSegments(content: string): ExtractionResult {
  const tokens = marked.lexer(content);
  const segments: ExtractedSegment[] = [];
  const lines = content.split('\n');

  // Track the current section header for context
  let currentHeader: string | undefined;

  // Track line position as we process tokens
  let currentLine = 1;

  for (const token of tokens) {
    // Calculate line number from token position
    const tokenLines = countLines(token.raw);
    const startLine = currentLine;
    const endLine = startLine + tokenLines - 1;

    switch (token.type) {
      case 'heading':
        // Update current header context
        currentHeader = token.text;
        // Headers themselves are docs segments
        segments.push({
          content: token.raw.trim(),
          contentType: 'docs',
          startLine,
          endLine,
          metadata: {
            sectionHeader: currentHeader,
          },
        });
        break;

      case 'code':
        // Fenced code blocks → code segments
        segments.push({
          content: token.text,
          contentType: 'code',
          startLine,
          endLine,
          metadata: {
            language: token.lang || 'text',
            sectionHeader: currentHeader,
          },
        });
        break;

      case 'paragraph':
      case 'text':
        // Prose content → docs segments
        if (token.raw.trim()) {
          segments.push({
            content: token.raw.trim(),
            contentType: 'docs',
            startLine,
            endLine,
            metadata: {
              sectionHeader: currentHeader,
            },
          });
        }
        break;

      case 'list':
        // Lists are documentation content
        segments.push({
          content: token.raw.trim(),
          contentType: 'docs',
          startLine,
          endLine,
          metadata: {
            sectionHeader: currentHeader,
          },
        });
        break;

      case 'blockquote':
        // Blockquotes are documentation content
        segments.push({
          content: token.raw.trim(),
          contentType: 'docs',
          startLine,
          endLine,
          metadata: {
            sectionHeader: currentHeader,
          },
        });
        break;

      case 'table':
        // Tables are documentation content
        segments.push({
          content: token.raw.trim(),
          contentType: 'docs',
          startLine,
          endLine,
          metadata: {
            sectionHeader: currentHeader,
          },
        });
        break;

      case 'html':
        // HTML blocks - skip or treat as docs
        if (token.raw.trim()) {
          segments.push({
            content: token.raw.trim(),
            contentType: 'docs',
            startLine,
            endLine,
            metadata: {
              sectionHeader: currentHeader,
            },
          });
        }
        break;

      // Skip these token types (whitespace, hr, etc.)
      case 'space':
      case 'hr':
        break;
    }

    // Advance line counter
    currentLine = endLine + 1;
  }

  // If no segments were extracted, treat entire content as docs
  if (segments.length === 0 && content.trim()) {
    segments.push({
      content: content.trim(),
      contentType: 'docs',
      startLine: 1,
      endLine: lines.length,
      metadata: {},
    });
  }

  return { segments, originalContent: content };
}

/**
 * Count the number of lines in a string.
 */
function countLines(text: string): number {
  if (!text) return 1;
  return text.split('\n').length;
}

/**
 * Check if content is markdown based on extension or content.
 */
export function isMarkdown(extension: string): boolean {
  const mdExtensions = new Set(['md', 'mdx', 'markdown']);
  return mdExtensions.has(extension.toLowerCase());
}
