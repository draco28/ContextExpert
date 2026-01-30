/**
 * Chunker
 *
 * Main orchestration for the document chunking pipeline.
 * Routes files to appropriate extractors and applies chunking strategies.
 *
 * Architecture:
 * 1. FileInfo → Read content
 * 2. Extract segments (code, docs) based on file type
 * 3. Chunk segments with appropriate strategy:
 *    - Code/config → RecursiveChunker (syntax-aware character splitting)
 *    - Docs → SemanticChunker (topic-aware via embedding similarity)
 * 4. Produce ChunkResult[] with metadata
 *
 * Dual-Chunker Strategy:
 * - Code has EXPLICIT structure (AST, braces, indentation)
 * - Docs have IMPLICIT structure (topics, concepts)
 * - Using the right chunker for each produces more coherent chunks
 */

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  RecursiveChunker,
  type Chunk,
  type Document,
  type EmbeddingProvider,
} from '@contextaisdk/rag';
import { SemanticChunker } from '@contextaisdk/rag/chunking';

import type { FileInfo } from '../types.js';
import type {
  ChunkResult,
  ChunkOptions,
  ExtractedSegment,
  FileChunkResult,
  BatchChunkResult,
} from './types.js';
import {
  extractCodeSegments,
  extractMarkdownSegments,
  isLanguageSupported,
  isMarkdown,
} from './extractors/index.js';
import {
  CHUNK_CONFIG,
  MAX_FILE_SIZE,
  MIN_CHUNK_SIZE,
  getChunkConfig,
  estimateTokens,
} from './config.js';

/**
 * Configuration for the chunker.
 */
export interface ChunkerConfig {
  /**
   * Override default chunk sizes.
   * Key is content type, value is { chunkSize, chunkOverlap }.
   */
  chunkSizeOverrides?: Partial<typeof CHUNK_CONFIG>;

  /**
   * Embedding provider for SemanticChunker.
   *
   * When provided, 'docs' segments use SemanticChunker (topic-aware splitting)
   * instead of RecursiveChunker. This produces more cohesive chunks for prose.
   *
   * Create with: `createEmbeddingProvider(config.embedding)`
   */
  embeddingProvider?: EmbeddingProvider;
}

// ============================================================================
// Structured Result Functions (Ticket #50)
// ============================================================================

/**
 * Chunk a single file with structured result reporting.
 *
 * Unlike chunkFile(), this returns a FileChunkResult with:
 * - Explicit success/failure indication
 * - Reason why file was skipped (if applicable)
 * - Warnings collected during processing
 *
 * Use this when you need to distinguish between different failure modes
 * or aggregate error statistics.
 *
 * @param fileInfo - File metadata from discovery
 * @param config - Optional chunker configuration
 * @param options - Callbacks for progress (onChunk only; errors reported in result)
 * @returns FileChunkResult with success, chunks, and error details
 */
export async function chunkFileWithResult(
  fileInfo: FileInfo,
  config: ChunkerConfig = {},
  options: Pick<ChunkOptions, 'onChunk'> = {}
): Promise<FileChunkResult> {
  const warnings: string[] = [];

  // Check file size limit
  if (fileInfo.size > MAX_FILE_SIZE) {
    const sizeMsg = `${formatSize(fileInfo.size)} > ${formatSize(MAX_FILE_SIZE)}`;
    return {
      filePath: fileInfo.relativePath,
      success: false,
      chunks: [],
      skipReason: 'too_large',
      error: `File too large (${sizeMsg})`,
      warnings,
    };
  }

  // Read file content
  let content: string;
  try {
    content = await readFile(fileInfo.path, 'utf-8');
  } catch (error) {
    return {
      filePath: fileInfo.relativePath,
      success: false,
      chunks: [],
      skipReason: 'read_error',
      error: (error as Error).message,
      warnings,
    };
  }

  // Empty files are success (valid file, just no content)
  if (!content.trim()) {
    return {
      filePath: fileInfo.relativePath,
      success: true,
      chunks: [],
      skipReason: 'empty',
      warnings,
    };
  }

  // Extract segments based on file type
  const segments = extractSegments(content, fileInfo);

  // Chunk each segment
  const chunks: ChunkResult[] = [];
  let chunkIndex = 0;

  for (const segment of segments) {
    // Skip very small segments
    if (segment.content.length < MIN_CHUNK_SIZE) {
      continue;
    }

    // Get chunk configuration for this content type
    const chunkConfig = config.chunkSizeOverrides?.[segment.contentType]
      ?? getChunkConfig(segment.contentType);

    // Estimate token count
    const tokenCount = estimateTokens(segment.content);

    let segmentChunks: Chunk[];

    if (tokenCount <= chunkConfig.chunkSize) {
      // Small enough - keep as single chunk
      segmentChunks = [{
        id: randomUUID(),
        content: segment.content,
        metadata: {},
      }];
    } else if (segment.contentType === 'docs' && config.embeddingProvider) {
      // Docs content with embedding provider → use SemanticChunker
      const semanticChunker = new SemanticChunker({
        embeddingProvider: config.embeddingProvider,
        similarityThreshold: 0.5,
        minChunkSize: 100,
        maxChunkSize: chunkConfig.chunkSize,
      });

      const document: Document = {
        id: randomUUID(),
        content: segment.content,
        metadata: {},
        source: fileInfo.relativePath,
      };

      segmentChunks = await semanticChunker.chunk(document, {
        chunkSize: chunkConfig.chunkSize,
        chunkOverlap: chunkConfig.chunkOverlap,
        sizeUnit: 'tokens',
      });
    } else {
      // Code/config content OR no embedding provider → use RecursiveChunker
      const recursiveChunker = new RecursiveChunker();

      const document: Document = {
        id: randomUUID(),
        content: segment.content,
        metadata: {},
        source: fileInfo.relativePath,
      };

      segmentChunks = await recursiveChunker.chunk(document, {
        chunkSize: chunkConfig.chunkSize,
        chunkOverlap: chunkConfig.chunkOverlap,
        sizeUnit: 'tokens',
      });
    }

    // Map to ChunkResult with full metadata
    for (const chunk of segmentChunks) {
      const { startLine, endLine } = computeLineNumbers(
        segment.content,
        chunk.content,
        segment.startLine
      );

      const result: ChunkResult = {
        id: chunk.id,
        content: chunk.content,
        file_path: fileInfo.relativePath,
        file_type: fileInfo.type,
        content_type: segment.contentType,
        language: fileInfo.language,
        start_line: startLine,
        end_line: endLine,
        metadata: {
          originalSize: fileInfo.size,
          chunkIndex,
          totalChunks: 0,
          symbolName: segment.metadata.symbolName,
          symbolType: segment.metadata.symbolType,
          parentSymbol: segment.metadata.parentSymbol,
          sectionHeader: segment.metadata.sectionHeader,
        },
      };

      chunks.push(result);
      options.onChunk?.(result);
      chunkIndex++;
    }
  }

  // Update totalChunks in all chunk metadata
  for (const chunk of chunks) {
    chunk.metadata.totalChunks = chunks.length;
  }

  return {
    filePath: fileInfo.relativePath,
    success: true,
    chunks,
    warnings,
  };
}

/**
 * Chunk multiple files with aggregated result reporting.
 *
 * Returns a BatchChunkResult with:
 * - Per-file results (success/failure for each)
 * - Aggregate counts (successCount, failureCount, totalChunks)
 * - All warnings and errors collected
 *
 * @param files - Array of file info objects
 * @param config - Optional chunker configuration
 * @param options - Callbacks for progress (onChunk only)
 * @returns BatchChunkResult with aggregated statistics
 */
export async function chunkFilesWithResult(
  files: FileInfo[],
  config: ChunkerConfig = {},
  options: Pick<ChunkOptions, 'onChunk'> = {}
): Promise<BatchChunkResult> {
  const fileResults: FileChunkResult[] = [];
  let successCount = 0;
  let failureCount = 0;
  const allWarnings: string[] = [];
  const allErrors: string[] = [];

  for (const file of files) {
    const result = await chunkFileWithResult(file, config, options);
    fileResults.push(result);

    if (result.success) {
      successCount++;
    } else {
      failureCount++;
      if (result.error) {
        allErrors.push(`${result.filePath}: ${result.error}`);
      }
    }

    // Prefix warnings with file path for context
    for (const warning of result.warnings) {
      allWarnings.push(`${result.filePath}: ${warning}`);
    }
  }

  return {
    files: fileResults,
    successCount,
    failureCount,
    totalChunks: fileResults.reduce((sum, r) => sum + r.chunks.length, 0),
    warnings: allWarnings,
    errors: allErrors,
  };
}

// ============================================================================
// Legacy Functions (Backward Compatible)
// ============================================================================

/**
 * Chunk a single file into segments ready for embedding.
 *
 * This is the backward-compatible entry point. It delegates to
 * chunkFileWithResult() and converts the result to the legacy format
 * (ChunkResult[] with callback-based error reporting).
 *
 * For new code, prefer chunkFileWithResult() which provides explicit
 * success/failure information.
 *
 * @param fileInfo - File metadata from discovery
 * @param config - Optional chunker configuration
 * @param options - Callbacks for progress/errors
 * @returns Array of chunks ready for embedding
 */
export async function chunkFile(
  fileInfo: FileInfo,
  config: ChunkerConfig = {},
  options: ChunkOptions = {}
): Promise<ChunkResult[]> {
  const result = await chunkFileWithResult(fileInfo, config, { onChunk: options.onChunk });

  // Fire legacy callbacks based on result
  if (!result.success && result.error) {
    options.onError?.(new Error(result.error), result.filePath);
  }

  // Convert skipReason to warning for large files (legacy behavior)
  if (result.skipReason === 'too_large' && result.error) {
    options.onWarning?.(result.error, result.filePath);
  }

  // Forward any warnings
  for (const warning of result.warnings) {
    options.onWarning?.(warning, result.filePath);
  }

  return result.chunks;
}

/**
 * Chunk multiple files in batch.
 *
 * This is the backward-compatible batch function. It delegates to
 * chunkFilesWithResult() and converts the result to the legacy format.
 *
 * For new code, prefer chunkFilesWithResult() which provides:
 * - Per-file success/failure information
 * - Aggregate statistics
 * - All errors and warnings collected
 *
 * @param files - Array of file info objects
 * @param config - Optional chunker configuration
 * @param options - Callbacks for progress/errors
 * @returns Array of all chunks from all files
 */
export async function chunkFiles(
  files: FileInfo[],
  config: ChunkerConfig = {},
  options: ChunkOptions = {}
): Promise<ChunkResult[]> {
  const allChunks: ChunkResult[] = [];

  for (const file of files) {
    const chunks = await chunkFile(file, config, options);
    allChunks.push(...chunks);
  }

  return allChunks;
}

/**
 * Extract segments from file content based on type.
 */
function extractSegments(content: string, fileInfo: FileInfo): ExtractedSegment[] {
  // Config files → treat as single segment
  if (fileInfo.type === 'config') {
    return [{
      content,
      contentType: 'config',
      startLine: 1,
      endLine: content.split('\n').length,
      metadata: {},
    }];
  }

  // Markdown files → use markdown extractor
  if (isMarkdown(fileInfo.extension)) {
    return extractMarkdownSegments(content).segments;
  }

  // Code files with AST support → use code extractor
  if (isLanguageSupported(fileInfo.language)) {
    return extractCodeSegments(content, fileInfo.language).segments;
  }

  // Unsupported code files → use fallback code extraction
  return extractCodeSegments(content, fileInfo.language).segments;
}

/**
 * Compute line numbers for a chunk within a segment.
 */
function computeLineNumbers(
  segmentContent: string,
  chunkContent: string,
  segmentStartLine: number
): { startLine: number; endLine: number } {
  // Find where this chunk starts within the segment
  const chunkStartOffset = segmentContent.indexOf(chunkContent);

  if (chunkStartOffset === -1) {
    // Chunk not found (shouldn't happen) - use segment boundaries
    const chunkLines = chunkContent.split('\n').length;
    return {
      startLine: segmentStartLine,
      endLine: segmentStartLine + chunkLines - 1,
    };
  }

  // Count lines before the chunk start
  const linesBeforeChunk = segmentContent.slice(0, chunkStartOffset).split('\n').length - 1;
  const startLine = segmentStartLine + linesBeforeChunk;

  // Count lines in the chunk
  const chunkLines = chunkContent.split('\n').length;
  const endLine = startLine + chunkLines - 1;

  return { startLine, endLine };
}

/**
 * Format file size in human-readable form.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
