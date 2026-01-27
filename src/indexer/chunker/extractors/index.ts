/**
 * Extractors
 *
 * Content extractors for different file types.
 * Each extractor produces ExtractedSegment[] ready for chunking.
 */

export {
  extractCodeSegments,
  isLanguageSupported,
} from './code-extractor.js';

export {
  extractMarkdownSegments,
  isMarkdown,
} from './markdown-extractor.js';
