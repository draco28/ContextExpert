/**
 * Chunker Module
 *
 * Document chunking pipeline with dual-track extraction:
 * - Code files → AST-aware extraction (functions, classes, docstrings)
 * - Markdown files → Prose/code block separation
 * - Config files → Direct chunking
 *
 * Usage:
 * ```typescript
 * import { chunkFile, chunkFiles } from './chunker';
 * import { scanDirectory } from './scanner';
 *
 * const { files } = await scanDirectory('./my-project');
 * const chunks = await chunkFiles(files);
 * // chunks ready for embedding
 * ```
 */

// Main chunker functions
export {
  chunkFile,
  chunkFiles,
  // Structured result functions (Ticket #50)
  chunkFileWithResult,
  chunkFilesWithResult,
  type ChunkerConfig,
} from './chunker.js';

// Types
export type {
  ContentType,
  SymbolType,
  ExtractedSegment,
  ChunkResult,
  ChunkOptions,
  ExtractionResult,
  // Structured result types (Ticket #50)
  SkipReason,
  FileChunkResult,
  BatchChunkResult,
} from './types.js';

// Configuration
export {
  CHUNK_CONFIG,
  MAX_FILE_SIZE,
  MIN_CHUNK_SIZE,
  getChunkConfig,
  estimateTokens,
  type ChunkConfig,
} from './config.js';

// Extractors (for advanced use)
export {
  extractCodeSegments,
  extractMarkdownSegments,
  isLanguageSupported,
  isMarkdown,
} from './extractors/index.js';
