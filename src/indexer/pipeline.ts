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
import { chunkFilesWithResult, type ChunkerConfig } from './chunker/index.js';
import { embedChunks } from './embedder/index.js';
import type { FileInfo } from './types.js';
import type { ChunkResult, BatchChunkResult } from './chunker/types.js';
import type { EmbeddedChunk } from './embedder/types.js';
import { getDatabase } from '../database/index.js';
import { getVectorStoreManager, getBM25StoreManager } from '../search/index.js';
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

  /** Timeout in milliseconds for embedding operations */
  embeddingTimeout?: number;

  /**
   * Batch size for embedding operations (default: 32).
   *
   * Smaller values create more event-loop yield points, improving
   * UI responsiveness during background indexing at a small throughput cost.
   * Recommended: 8 for background/TUI indexing, 32 for foreground CLI.
   */
  embeddingBatchSize?: number;

  /**
   * Use staging table pattern for atomic re-indexing.
   *
   * When true:
   * - New chunks are written to a staging table during indexing
   * - Old chunks continue serving queries until indexing completes
   * - At the end, data is swapped atomically (DELETE old + INSERT new in one transaction)
   *
   * This eliminates the "query gap" during re-indexing where searches would return 0 results.
   * Use this when re-indexing an existing project (--force flag).
   */
  useStaging?: boolean;

  /**
   * AbortSignal for cancellation support.
   *
   * When aborted, the pipeline will stop at the next safe checkpoint
   * (between stages or between batches). Partial data is cleaned up.
   *
   * @example
   * ```typescript
   * const controller = new AbortController();
   * runIndexPipeline({ ...options, signal: controller.signal });
   *
   * // Later, to cancel:
   * controller.abort();
   * ```
   */
  signal?: AbortSignal;

  // Progress callbacks
  onStageStart?: (stage: IndexingStage, total: number) => void;
  onProgress?: (stage: IndexingStage, processed: number, total: number, currentFile?: string) => void;
  onStageComplete?: (stage: IndexingStage, stats: StageStats) => void;
  onWarning?: (message: string, context?: string) => void;
  onError?: (error: Error, context?: string) => void;
}

/**
 * Error thrown when indexing is cancelled via AbortSignal.
 */
export class IndexingCancelledError extends Error {
  constructor() {
    super('Indexing cancelled');
    this.name = 'IndexingCancelledError';
  }
}

/**
 * Check if the abort signal has been triggered.
 * Throws IndexingCancelledError if cancelled.
 *
 * @param signal - AbortSignal to check
 * @throws IndexingCancelledError if signal is aborted
 */
function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new IndexingCancelledError();
  }
}

/**
 * Yield to the event loop to allow other async operations to run.
 * This is what makes the REPL responsive during long indexing operations.
 *
 * Uses setImmediate for optimal scheduling in Node.js event loop.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
    embeddingTimeout,
    signal,
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
  checkCancelled(signal);
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
  checkCancelled(signal);
  const chunkStartTime = performance.now();
  onStageStart?.('chunking', scanResult.files.length);

  let chunkResult: BatchChunkResult;
  let filesChunked = 0;
  let lastChunkedFile = '';

  try {
    // Use structured result API for better error tracking
    chunkResult = await chunkFilesWithResult(
      scanResult.files,
      {
        ...chunkerConfig,
        embeddingProvider, // For SemanticChunker on docs
      },
      {
        onChunk: (chunk: ChunkResult) => {
          // Track which file we're on for progress
          if (chunk.file_path !== lastChunkedFile) {
            filesChunked++;
            lastChunkedFile = chunk.file_path;
            onProgress?.('chunking', filesChunked, scanResult.files.length, chunk.file_path);
          }
        },
      }
    );

    // Aggregate warnings and errors from structured result
    warnings.push(...chunkResult.warnings);
    errors.push(...chunkResult.errors);

    // Fire callbacks for warnings/errors (for real-time feedback)
    for (const warning of chunkResult.warnings) {
      const [filePath, ...rest] = warning.split(': ');
      onWarning?.(rest.join(': '), filePath);
    }
    for (const error of chunkResult.errors) {
      const [filePath, ...rest] = error.split(': ');
      onError?.(new Error(rest.join(': ')), filePath);
    }
  } catch (error) {
    // Fatal chunking error
    throw error;
  }

  // Extract chunks from structured result
  const chunksCreated = chunkResult.files.flatMap(f => f.chunks);

  const chunkDuration = performance.now() - chunkStartTime;
  stageDurations.chunking = Math.round(chunkDuration);

  // Build skip reason summary for details
  const skipSummary: Record<string, number> = {};
  for (const file of chunkResult.files) {
    if (file.skipReason) {
      skipSummary[file.skipReason] = (skipSummary[file.skipReason] ?? 0) + 1;
    }
  }

  onStageComplete?.('chunking', {
    stage: 'chunking',
    processed: chunksCreated.length,
    total: chunksCreated.length,
    durationMs: Math.round(chunkDuration),
    details: {
      filesProcessed: chunkResult.successCount,
      filesFailed: chunkResult.failureCount,
      skipReasons: Object.keys(skipSummary).length > 0 ? skipSummary : undefined,
    },
  });

  // =========================================================================
  // STAGE 3: EMBEDDING
  // =========================================================================
  checkCancelled(signal);
  const embedStartTime = performance.now();
  onStageStart?.('embedding', chunksCreated.length);

  let embeddedChunks: EmbeddedChunk[] = [];

  try {
    embeddedChunks = await embedChunks(chunksCreated, embeddingProvider, {
      batchSize: options.embeddingBatchSize ?? 32,
      timeout: embeddingTimeout,
      signal, // Pass signal for cancellation support
      onProgress: (processed: number, total: number) => {
        onProgress?.('embedding', processed, total);
      },
      onError: (error: Error, chunkId: string) => {
        errors.push(`Chunk ${chunkId}: ${error.message}`);
        onError?.(error, chunkId);
      },
    });
  } catch (error) {
    // Fatal embedding error (or cancellation)
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
  checkCancelled(signal);
  const storeStartTime = performance.now();
  onStageStart?.('storing', embeddedChunks.length);

  let chunksStored = 0;
  const useStaging = options.useStaging ?? false;

  try {
    // Ensure project exists in database with embedding config
    db.upsertProject({
      id: projectId,
      name: projectName,
      path: projectPath,
      embeddingModel: options.embeddingModel,
      embeddingDimensions: options.embeddingDimensions,
    });

    // If using staging table pattern for atomic re-indexing:
    // - Create staging table before inserting
    // - Old chunks in main table continue serving queries during indexing
    if (useStaging) {
      db.createChunksStagingTable();
    }

    // Store chunks in batches
    const BATCH_SIZE = 100;
    for (let i = 0; i < embeddedChunks.length; i += BATCH_SIZE) {
      const batch = embeddedChunks.slice(i, i + BATCH_SIZE);

      const chunkData = batch.map((chunk) => ({
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
      }));

      // Insert to staging table (re-indexing) or main table (fresh index)
      if (useStaging) {
        db.insertChunksToStaging(projectId, chunkData);
      } else {
        db.insertChunks(projectId, chunkData);
      }

      chunksStored += batch.length;
      onProgress?.('storing', chunksStored, embeddedChunks.length);

      // Check cancellation and yield to event loop between batches
      // This keeps the REPL responsive during long storage operations
      checkCancelled(signal);
      await yieldToEventLoop();
    }

    // If using staging table: atomically swap old chunks with new chunks
    // This is the critical operation that makes re-indexing "zero-downtime"
    if (useStaging) {
      const swapResult = db.atomicSwapChunks(projectId);
      db.dropChunksStagingTable();

      // Invalidate search caches so they rebuild with new data on next query
      getVectorStoreManager().invalidate(projectId);
      getBM25StoreManager().invalidate(projectId);

      // Log swap details (only visible in verbose mode)
      onWarning?.(`Atomic swap: deleted ${swapResult.deleted} old chunks, inserted ${swapResult.inserted} new chunks`, 'atomic-reindex');
    }

    // Update project statistics
    db.updateProjectStats(projectId, {
      fileCount: scanResult.files.length,
      chunkCount: chunksStored,
    });
  } catch (error) {
    // Clean up staging table on error to avoid orphaned data
    if (useStaging) {
      try {
        db.dropChunksStagingTable();
      } catch (cleanupError) {
        // Log cleanup failure but don't mask the original error
        onWarning?.(
          `Failed to cleanup staging table: ${(cleanupError as Error).message}`,
          'staging-cleanup'
        );
      }
    }
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
