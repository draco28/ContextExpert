/**
 * Chunker
 *
 * Main orchestration for the document chunking pipeline.
 * Routes files to appropriate extractors and applies chunking strategies.
 *
 * Architecture:
 * 1. FileInfo → Read content
 * 2. Extract segments (code, docs) based on file type
 * 3. Chunk segments with appropriate strategy
 * 4. Produce ChunkResult[] with metadata
 */

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { RecursiveChunker, type Chunk, type Document } from '@contextaisdk/rag';

import type { FileInfo } from '../types.js';
import type {
  ChunkResult,
  ChunkOptions,
  ExtractedSegment,
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
}

/**
 * Chunk a single file into segments ready for embedding.
 *
 * This is the main entry point for chunking. It:
 * 1. Validates file size (skips files > 500KB)
 * 2. Reads file content
 * 3. Extracts semantic segments (functions, classes, prose sections)
 * 4. Chunks large segments with RecursiveChunker
 * 5. Returns ChunkResult[] with full metadata
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
  // Check file size limit
  if (fileInfo.size > MAX_FILE_SIZE) {
    options.onWarning?.(
      `Skipping large file (${formatSize(fileInfo.size)} > ${formatSize(MAX_FILE_SIZE)})`,
      fileInfo.relativePath
    );
    return [];
  }

  // Read file content
  let content: string;
  try {
    content = await readFile(fileInfo.path, 'utf-8');
  } catch (error) {
    options.onError?.(error as Error, fileInfo.relativePath);
    return [];
  }

  // Skip empty files
  if (!content.trim()) {
    return [];
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
    } else {
      // Too large - use RecursiveChunker to split
      // Note: RecursiveChunker constructor takes separators[], options go to chunk()
      const chunker = new RecursiveChunker();

      const document: Document = {
        id: randomUUID(),
        content: segment.content,
        metadata: {},
        source: fileInfo.relativePath, // Required by Document interface
      };

      segmentChunks = await chunker.chunk(document, {
        chunkSize: chunkConfig.chunkSize,
        chunkOverlap: chunkConfig.chunkOverlap,
        sizeUnit: 'tokens',
      });
    }

    // Map to ChunkResult with full metadata
    for (const chunk of segmentChunks) {
      // Calculate line numbers for this chunk within the segment
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
          totalChunks: 0, // Will be set after all chunks are processed
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

  return chunks;
}

/**
 * Chunk multiple files in batch.
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
