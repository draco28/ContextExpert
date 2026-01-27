/**
 * File Indexer Module
 *
 * This module provides file discovery capabilities for the Context Expert CLI.
 * It scans project directories, respects gitignore patterns, and returns
 * metadata about discovered files.
 *
 * @example
 * ```ts
 * import { scanDirectory, DEFAULT_SUPPORTED_EXTENSIONS } from './indexer';
 *
 * const result = await scanDirectory('/path/to/project', {
 *   maxDepth: 10,
 *   onFile: (file) => console.log(`Found: ${file.relativePath}`),
 * });
 *
 * console.log(`Discovered ${result.stats.totalFiles} files`);
 * console.log(`Languages: ${Object.keys(result.stats.byLanguage).join(', ')}`);
 * ```
 */

// Main scanner functions
export { scanDirectory, scanDirectories, countFiles } from './scanner.js';

// Ignore pattern utilities
export {
  createIgnoreFilter,
  createFastGlobIgnoreFilter,
  loadGitignoreFile,
  parseGitignoreContent,
  isBinaryFile,
  type IgnoreFilter,
  type IgnoreFilterOptions,
} from './ignore.js';

// Types and constants
export {
  // Types
  type Language,
  type FileType,
  type FileInfo,
  type ScanOptions,
  type ScanStats,
  type ScanResult,

  // Constants
  EXTENSION_TO_LANGUAGE,
  LANGUAGE_TO_TYPE,
  DEFAULT_SUPPORTED_EXTENSIONS,
  DEFAULT_IGNORE_PATTERNS,

  // Utility functions
  getLanguageForExtension,
  getTypeForLanguage,
} from './types.js';

// Chunker module
export {
  // Main functions
  chunkFile,
  chunkFiles,
  type ChunkerConfig,

  // Types
  type ContentType,
  type SymbolType,
  type ExtractedSegment,
  type ChunkResult,
  type ChunkOptions,
  type ExtractionResult,

  // Configuration
  CHUNK_CONFIG,
  MAX_FILE_SIZE,
  MIN_CHUNK_SIZE,
  getChunkConfig,
  estimateTokens,
  type ChunkConfig,

  // Extractors (for advanced use)
  extractCodeSegments,
  extractMarkdownSegments,
  isLanguageSupported,
  isMarkdown,
} from './chunker/index.js';

// Embedder module
export {
  // Provider factory
  createEmbeddingProvider,
  getModelDimensions,

  // Embedder orchestration
  embedChunks,
  embedChunk,
  estimateEmbeddingMemory,

  // Types
  type EmbeddingConfig,
  type EmbeddedChunk,
  type EmbedderOptions,
  type ProviderOptions,
  type ModelLoadProgress,
  type EmbeddingProvider,
  type EmbeddingResult,
} from './embedder/index.js';

// Pipeline orchestration
export {
  runIndexPipeline,
  type IndexPipelineOptions,
} from './pipeline.js';
