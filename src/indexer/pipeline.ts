/**
 * Index Pipeline
 *
 * Orchestrates the complete indexing workflow:
 * Scan → Chunk → Embed → Store
 *
 * This is the "conductor" that coordinates all the indexing components.
 * It doesn't know HOW to display progress - that's the ProgressReporter's job.
 * It just fires callbacks at the right moments.
 *
 * Design principles:
 * - Each stage has clear start/progress/complete callbacks
 * - Non-fatal errors are collected, not thrown
 * - Statistics are aggregated from all stages
 * - Can be used programmatically (without CLI)
 */

import { randomUUID } from 'node:crypto';
import type { EmbeddingProvider } from '@contextaisdk/rag';

import { scanDirectory, type ScanResult } from './scanner.js';
import { chunkFiles, type ChunkerConfig } from './chunker/index.js';
import { embedChunks } from './embedder/index.js';
import type { FileInfo } from './types.js';
import type { ChunkResult } from './chunker/types.js';
import type { EmbeddedChunk } from './embedder/types.js';
import { getDatabase } from '../database/index.js';
import type { IndexingStage, StageStats, IndexPipelineResult } from '../cli/utils/progress.js';

/**
 * Options for running the index pipeline.
 */
export interface IndexPipelineOptions {
  /** Absolute path to the project directory */
  projectPath: string;

  /** Human-readable project name */
  projectName: string;

  /** Existing project ID (for re-indexing) */
  projectId?: string;

  /** Embedding provider instance */
  embeddingProvider: EmbeddingProvider;

  /** Embedding model name for tracking (e.g., "BAAI/bge-large-en-v1.5") */
  embeddingModel?: string;

  /** Embedding dimensions for tracking (e.g., 1024) */
  embeddingDimensions?: number;

  /** Optional chunker configuration overrides */
  chunkerConfig?: ChunkerConfig;

  // Progress callbacks
  onStageStart?: (stage: IndexingStage, total: number) => void;
  onProgress?: (stage: IndexingStage, processed: number, total: number, currentFile?: string) => void;
  onStageComplete?: (stage: IndexingStage, stats: StageStats) => void;
  onWarning?: (message: string, context?: string) => void;
  onError?: (error: Error, context?: string) => void;
}

/**
 * Run the complete indexing pipeline.
 *
 * This is the main entry point for indexing a project. It:
 * 1. Scans the directory for files
 * 2. Chunks files into semantic segments
 * 3. Embeds chunks using the provided embedding provider
 * 4. Stores embedded chunks in SQLite
 *
 * @example
 * ```typescript
 * const reporter = createProgressReporter({ json: false, verbose: true });
 * const provider = await createEmbeddingProvider(config.embedding);
 *
 * const result = await runIndexPipeline({
 *   projectPath: '/path/to/project',
 *   projectName: 'my-project',
 *   embeddingProvider: provider,
 *   onStageStart: (stage, total) => reporter.startStage(stage, total),
 *   onProgress: (stage, processed, total, file) => reporter.updateProgress(processed, file),
 *   onStageComplete: (stage, stats) => reporter.completeStage(stats),
 *   onWarning: (msg, ctx) => reporter.warn(msg, ctx),
 *   onError: (err, ctx) => reporter.error(err.message, ctx),
 * });
 *
 * reporter.showSummary(result);
 * ```
 */
export async function runIndexPipeline(
  options: IndexPipelineOptions
): Promise<IndexPipelineResult> {
  const {
    projectPath,
    projectName,
    embeddingProvider,
    chunkerConfig,
    onStageStart,
    onProgress,
    onStageComplete,
    onWarning,
    onError,
  } = options;

  const pipelineStartTime = performance.now();
  const stageDurations: Partial<Record<IndexingStage, number>> = {};
  const warnings: string[] = [];
  const errors: string[] = [];

  // Generate project ID if not provided
  const projectId = options.projectId ?? randomUUID();

  // Get database connection for storage and size tracking
  const db = getDatabase();
  const dbSizeBefore = db.getDatabaseSize();

  // =========================================================================
  // STAGE 1: SCANNING
  // =========================================================================
  const scanStartTime = performance.now();
  onStageStart?.('scanning', 0); // Unknown total at start

  let scanResult: ScanResult;
  let filesScanned = 0;

  try {
    scanResult = await scanDirectory(projectPath, {
      onFile: (file: FileInfo) => {
        filesScanned++;
        onProgress?.('scanning', filesScanned, 0, file.relativePath);
      },
      onError: (path: string, error: Error) => {
        const msg = `Failed to process: ${error.message}`;
        warnings.push(`${path}: ${msg}`);
        onWarning?.(msg, path);
      },
    });
  } catch (error) {
    // Fatal scan error
    throw error;
  }

  const scanDuration = performance.now() - scanStartTime;
  stageDurations.scanning = Math.round(scanDuration);

  onStageComplete?.('scanning', {
    stage: 'scanning',
    processed: scanResult.files.length,
    total: scanResult.files.length,
    durationMs: Math.round(scanDuration),
    details: {
      totalSize: scanResult.stats.totalSize,
      byLanguage: scanResult.stats.byLanguage,
      byType: scanResult.stats.byType,
    },
  });

  // =========================================================================
  // STAGE 2: CHUNKING
  // =========================================================================
  const chunkStartTime = performance.now();
  onStageStart?.('chunking', scanResult.files.length);

  let chunksCreated: ChunkResult[] = [];
  let filesChunked = 0;
  let lastChunkedFile = '';

  try {
    chunksCreated = await chunkFiles(
      scanResult.files,
      {
        ...chunkerConfig,
        embeddingProvider, // For SemanticChunker on docs
      },
      {
        onChunk: (chunk: ChunkResult) => {
          // Track which file we're on
          if (chunk.file_path !== lastChunkedFile) {
            filesChunked++;
            lastChunkedFile = chunk.file_path;
            onProgress?.('chunking', filesChunked, scanResult.files.length, chunk.file_path);
          }
        },
        onWarning: (message: string, filePath: string) => {
          warnings.push(`${filePath}: ${message}`);
          onWarning?.(message, filePath);
        },
        onError: (error: Error, filePath: string) => {
          errors.push(`${filePath}: ${error.message}`);
          onError?.(error, filePath);
        },
      }
    );
  } catch (error) {
    // Fatal chunking error
    throw error;
  }

  const chunkDuration = performance.now() - chunkStartTime;
  stageDurations.chunking = Math.round(chunkDuration);

  onStageComplete?.('chunking', {
    stage: 'chunking',
    processed: chunksCreated.length,
    total: chunksCreated.length,
    durationMs: Math.round(chunkDuration),
    details: {
      filesProcessed: filesChunked,
    },
  });

  // =========================================================================
  // STAGE 3: EMBEDDING
  // =========================================================================
  const embedStartTime = performance.now();
  onStageStart?.('embedding', chunksCreated.length);

  let embeddedChunks: EmbeddedChunk[] = [];

  try {
    embeddedChunks = await embedChunks(chunksCreated, embeddingProvider, {
      batchSize: 32,
      onProgress: (processed: number, total: number) => {
        onProgress?.('embedding', processed, total);
      },
      onError: (error: Error, chunkId: string) => {
        errors.push(`Chunk ${chunkId}: ${error.message}`);
        onError?.(error, chunkId);
      },
    });
  } catch (error) {
    // Fatal embedding error
    throw error;
  }

  const embedDuration = performance.now() - embedStartTime;
  stageDurations.embedding = Math.round(embedDuration);

  onStageComplete?.('embedding', {
    stage: 'embedding',
    processed: embeddedChunks.length,
    total: chunksCreated.length,
    durationMs: Math.round(embedDuration),
    details: {
      successRate: chunksCreated.length > 0
        ? ((embeddedChunks.length / chunksCreated.length) * 100).toFixed(1) + '%'
        : '100%',
    },
  });

  // =========================================================================
  // STAGE 4: STORING
  // =========================================================================
  const storeStartTime = performance.now();
  onStageStart?.('storing', embeddedChunks.length);

  let chunksStored = 0;

  try {
    // Ensure project exists in database with embedding config
    db.upsertProject({
      id: projectId,
      name: projectName,
      path: projectPath,
      embeddingModel: options.embeddingModel,
      embeddingDimensions: options.embeddingDimensions,
    });

    // Store chunks in batches
    const BATCH_SIZE = 100;
    for (let i = 0; i < embeddedChunks.length; i += BATCH_SIZE) {
      const batch = embeddedChunks.slice(i, i + BATCH_SIZE);

      db.insertChunks(
        projectId,
        batch.map((chunk) => ({
          id: chunk.id,
          content: chunk.content,
          embedding: chunk.embedding,
          filePath: chunk.file_path,
          fileType: chunk.file_type,
          contentType: chunk.content_type,
          language: chunk.language,
          startLine: chunk.start_line,
          endLine: chunk.end_line,
          metadata: chunk.metadata,
        }))
      );

      chunksStored += batch.length;
      onProgress?.('storing', chunksStored, embeddedChunks.length);
    }

    // Update project statistics
    db.updateProjectStats(projectId, {
      fileCount: scanResult.files.length,
      chunkCount: chunksStored,
    });
  } catch (error) {
    // Fatal storage error
    throw error;
  }

  const storeDuration = performance.now() - storeStartTime;
  stageDurations.storing = Math.round(storeDuration);

  onStageComplete?.('storing', {
    stage: 'storing',
    processed: chunksStored,
    total: embeddedChunks.length,
    durationMs: Math.round(storeDuration),
  });

  // Calculate final statistics
  const dbSizeAfter = db.getDatabaseSize();
  const totalDuration = performance.now() - pipelineStartTime;

  return {
    projectId,
    projectName,
    filesIndexed: scanResult.files.length,
    chunksCreated: chunksCreated.length,
    chunksStored,
    totalDurationMs: Math.round(totalDuration),
    stageDurations,
    databaseSizeIncrease: dbSizeAfter - dbSizeBefore,
    warnings,
    errors,
  };
}
