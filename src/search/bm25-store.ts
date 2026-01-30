/**
 * BM25 Store Manager
 *
 * Manages the lifecycle of BM25Retriever instances:
 * - Lazy loading from SQLite on first search
 * - Project-scoped indexes (one per project)
 * - Memory-efficient batch loading
 *
 * Architecture mirrors VectorStoreManager for consistency:
 * - Singleton pattern per project
 * - Concurrent build prevention
 * - Progress reporting during load
 */

import { BM25Retriever } from '@contextaisdk/rag';
import type { Chunk, BM25Document } from '@contextaisdk/rag';
import type Database from 'better-sqlite3';

import { getDb } from '../database/connection.js';
import {
  ChunkLoadNoEmbeddingSchema,
  validateRows,
  type ChunkLoadNoEmbeddingRow,
} from '../database/validation.js';
import { safeJsonParse, type Logger, consoleLogger } from '../utils/index.js';
import type { BM25Config, IndexBuildProgress } from './types.js';

/** Batch size for loading chunks from SQLite (memory efficiency) */
const LOAD_BATCH_SIZE = 1000;

/** Default BM25 parameters (standard values from literature) */
const DEFAULT_BM25_CONFIG: Required<BM25Config> = {
  k1: 1.2,
  b: 0.75,
};

/**
 * Options for initializing a BM25 store.
 */
export interface BM25StoreOptions {
  /** Project ID to scope the index */
  projectId: string;
  /** BM25 configuration options */
  bm25Config?: BM25Config;
}

/**
 * Manages BM25 retrievers for projects.
 *
 * Uses lazy initialization - indexes are only built on first search.
 * Implements singleton pattern per project for memory efficiency.
 *
 * @example
 * ```typescript
 * const manager = getBM25StoreManager();
 * const retriever = await manager.getRetriever({
 *   projectId: 'abc-123',
 * });
 * const results = await retriever.retrieve('PostgreSQL function', { topK: 5 });
 * ```
 */
export class BM25StoreManager {
  /** Cache of initialized retrievers by project ID */
  private retrievers = new Map<string, BM25Retriever>();

  /** Tracks in-progress builds to prevent concurrent builds for same project */
  private buildingRetrievers = new Map<string, Promise<BM25Retriever>>();

  /** Database connection (lazy) */
  private db: Database.Database | null = null;

  /**
   * Get the database connection (lazy initialization).
   */
  private getDatabase(): Database.Database {
    if (!this.db) {
      this.db = getDb();
    }
    return this.db;
  }

  /**
   * Get or create a BM25 retriever for a project.
   *
   * Lazy loads from SQLite on first access. Subsequent calls return cached retriever.
   *
   * @param options - Store configuration including projectId and BM25 config
   * @param onProgress - Optional callback for progress updates during loading
   * @param logger - Optional logger for warnings (defaults to console)
   * @returns The initialized BM25 retriever
   */
  async getRetriever(
    options: BM25StoreOptions,
    onProgress?: (progress: IndexBuildProgress) => void,
    logger: Logger = consoleLogger
  ): Promise<BM25Retriever> {
    const { projectId } = options;

    // Return cached retriever if available
    if (this.retrievers.has(projectId)) {
      return this.retrievers.get(projectId)!;
    }

    // Check if retriever is already being built (prevent concurrent builds)
    if (this.buildingRetrievers.has(projectId)) {
      return this.buildingRetrievers.get(projectId)!;
    }

    // Build new retriever
    const buildPromise = this.buildRetriever(options, onProgress, logger);
    this.buildingRetrievers.set(projectId, buildPromise);

    try {
      const retriever = await buildPromise;
      this.retrievers.set(projectId, retriever);
      return retriever;
    } finally {
      this.buildingRetrievers.delete(projectId);
    }
  }

  /**
   * Build a BM25 retriever by loading chunks from SQLite.
   *
   * Loads in batches for memory efficiency.
   */
  private async buildRetriever(
    options: BM25StoreOptions,
    onProgress?: (progress: IndexBuildProgress) => void,
    logger: Logger = consoleLogger
  ): Promise<BM25Retriever> {
    const { projectId, bm25Config } = options;

    const db = this.getDatabase();

    // Merge with defaults
    const config: Required<BM25Config> = {
      ...DEFAULT_BM25_CONFIG,
      ...bm25Config,
    };

    // Create BM25 retriever with config (index built separately)
    const retriever = new BM25Retriever({
      k1: config.k1,
      b: config.b,
    });

    // Get total chunk count for progress reporting
    const countResult = db
      .prepare('SELECT COUNT(*) as count FROM chunks WHERE project_id = ?')
      .get(projectId) as { count: number };
    const totalChunks = countResult.count;

    // Collect all documents for BM25 indexing
    const documents: BM25Document[] = [];

    if (totalChunks === 0) {
      // No chunks to load - build empty index and return
      retriever.buildIndex([]);
      return retriever;
    }

    // Prepare statement for batch loading (no embedding column needed)
    const stmt = db.prepare<[string, number, number]>(`
      SELECT id, content, file_path, file_type, language,
             start_line, end_line, metadata
      FROM chunks
      WHERE project_id = ?
      ORDER BY id
      LIMIT ? OFFSET ?
    `);

    let loaded = 0;
    let offset = 0;

    // Load in batches
    while (loaded < totalChunks) {
      onProgress?.({
        phase: 'loading',
        loaded,
        total: totalChunks,
      });

      const rawBatch = stmt.all(projectId, LOAD_BATCH_SIZE, offset);
      const batch: ChunkLoadNoEmbeddingRow[] = validateRows(
        ChunkLoadNoEmbeddingSchema,
        rawBatch,
        `chunks.project_id=${projectId}`
      );

      if (batch.length === 0) break;

      // Convert to BM25Document format (requires id, content, and chunk)
      for (const row of batch) {
        const chunk: Chunk = {
          id: row.id,
          content: row.content,
          metadata: {
            filePath: row.file_path,
            fileType: row.file_type,
            language: row.language,
            startLine: row.start_line,
            endLine: row.end_line,
            ...safeJsonParse(row.metadata, {}, (err) => {
              logger.warn(`[BM25Store] Skipping corrupted metadata for chunk ${row.id}: ${err.message}`);
            }),
          },
        };

        documents.push({
          id: row.id,
          content: row.content,
          chunk,
        });
      }

      loaded += batch.length;
      offset += LOAD_BATCH_SIZE;
    }

    // Final progress update - building index
    onProgress?.({
      phase: 'building',
      loaded: totalChunks,
      total: totalChunks,
    });

    // Build the BM25 index with all documents
    retriever.buildIndex(documents);

    return retriever;
  }

  /**
   * Check if a retriever is cached for a project.
   */
  hasRetriever(projectId: string): boolean {
    return this.retrievers.has(projectId);
  }

  /**
   * Invalidate cached retriever for a project.
   *
   * Call this after re-indexing to force rebuild on next search.
   */
  invalidate(projectId: string): void {
    this.retrievers.delete(projectId);
  }

  /**
   * Clear all cached retrievers.
   */
  clearAll(): void {
    this.retrievers.clear();
  }

  /**
   * Get the number of cached retrievers.
   */
  get cacheSize(): number {
    return this.retrievers.size;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let managerInstance: BM25StoreManager | null = null;

/**
 * Get the singleton BM25StoreManager instance.
 */
export function getBM25StoreManager(): BM25StoreManager {
  if (!managerInstance) {
    managerInstance = new BM25StoreManager();
  }
  return managerInstance;
}

/**
 * Reset the singleton instance.
 *
 * Useful for testing or when you need to clear all cached retrievers.
 */
export function resetBM25StoreManager(): void {
  if (managerInstance) {
    managerInstance.clearAll();
    managerInstance = null;
  }
}
