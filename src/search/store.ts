/**
 * Vector Store Manager
 *
 * Manages the lifecycle of InMemoryVectorStore instances:
 * - Lazy loading from SQLite on first search
 * - Project-scoped stores (one per project)
 * - Memory-efficient batch loading
 */

import { InMemoryVectorStore } from '@contextaisdk/rag';
import type Database from 'better-sqlite3';

import { getDb } from '../database/connection.js';
import { blobToEmbedding } from '../database/schema.js';
import {
  ChunkLoadRowSchema,
  validateRows,
  type ChunkLoadRow,
} from '../database/validation.js';
import { safeJsonParse, type Logger, consoleLogger } from '../utils/index.js';
import type { SearchServiceOptions, IndexBuildProgress } from './types.js';

/** Batch size for loading chunks from SQLite (memory efficiency) */
const LOAD_BATCH_SIZE = 1000;

/**
 * Manages vector stores for projects.
 *
 * Uses lazy initialization - stores are only built on first search.
 * Implements singleton pattern per project for memory efficiency.
 *
 * @example
 * ```typescript
 * const manager = getVectorStoreManager();
 * const store = await manager.getStore({
 *   projectId: 'abc-123',
 *   dimensions: 1024,
 * });
 * const results = await store.search(queryEmbedding, { topK: 5 });
 * ```
 */
export class VectorStoreManager {
  /** Cache of initialized stores by project ID */
  private stores = new Map<string, InMemoryVectorStore>();

  /** Tracks in-progress builds to prevent concurrent builds for same project */
  private buildingStores = new Map<string, Promise<InMemoryVectorStore>>();

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
   * Get or create a vector store for a project.
   *
   * Lazy loads from SQLite on first access. Subsequent calls return cached store.
   *
   * @param options - Store configuration including projectId and dimensions
   * @param onProgress - Optional callback for progress updates during loading
   * @param logger - Optional logger for warnings (defaults to console)
   * @returns The initialized vector store
   */
  async getStore(
    options: SearchServiceOptions,
    onProgress?: (progress: IndexBuildProgress) => void,
    logger: Logger = consoleLogger
  ): Promise<InMemoryVectorStore> {
    const { projectId } = options;

    // Return cached store if available
    if (this.stores.has(projectId)) {
      return this.stores.get(projectId)!;
    }

    // Check if store is already being built (prevent concurrent builds)
    if (this.buildingStores.has(projectId)) {
      return this.buildingStores.get(projectId)!;
    }

    // Build new store
    const buildPromise = this.buildStore(options, onProgress, logger);
    this.buildingStores.set(projectId, buildPromise);

    try {
      const store = await buildPromise;
      this.stores.set(projectId, store);
      return store;
    } finally {
      this.buildingStores.delete(projectId);
    }
  }

  /**
   * Build a vector store by loading chunks from SQLite.
   *
   * Loads in batches for memory efficiency.
   */
  private async buildStore(
    options: SearchServiceOptions,
    onProgress?: (progress: IndexBuildProgress) => void,
    logger: Logger = consoleLogger
  ): Promise<InMemoryVectorStore> {
    const {
      projectId,
      dimensions,
      useHNSW = true,
      hnswConfig,
    } = options;

    const db = this.getDatabase();

    // Create store with HNSW configuration
    const store = new InMemoryVectorStore({
      dimensions,
      distanceMetric: 'cosine',
      indexType: useHNSW ? 'hnsw' : 'brute-force',
      hnswConfig: useHNSW
        ? {
            M: hnswConfig?.M ?? 16,
            efConstruction: hnswConfig?.efConstruction ?? 200,
            efSearch: hnswConfig?.efSearch ?? 100,
          }
        : undefined,
      useFloat32: true, // 50% memory savings
    });

    // Get total chunk count for progress reporting
    const countResult = db
      .prepare('SELECT COUNT(*) as count FROM chunks WHERE project_id = ?')
      .get(projectId) as { count: number };
    const totalChunks = countResult.count;

    if (totalChunks === 0) {
      // No chunks to load
      return store;
    }

    // Prepare statement for batch loading
    const stmt = db.prepare<[string, number, number]>(`
      SELECT id, content, embedding, file_path, file_type, language,
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
      const batch: ChunkLoadRow[] = validateRows(
        ChunkLoadRowSchema,
        rawBatch,
        `chunks.project_id=${projectId}`
      );

      if (batch.length === 0) break;

      // Convert to SDK format and insert with dimension validation
      const chunks = batch.map((row) => {
        const embedding = blobToEmbedding(row.embedding);

        // Validate embedding dimensions match expected
        if (embedding.length !== dimensions) {
          throw new Error(
            `Embedding dimension mismatch for chunk ${row.id}: ` +
            `expected ${dimensions} dimensions but found ${embedding.length}. ` +
            `This project may have been indexed with a different embedding model. ` +
            `Re-index with: ctx index <path> --force`
          );
        }

        return {
          id: row.id,
          content: row.content,
          // Convert Float32Array → number[] for SDK
          embedding: Array.from(embedding),
          metadata: {
            filePath: row.file_path,
            fileType: row.file_type,
            language: row.language,
            startLine: row.start_line,
            endLine: row.end_line,
            ...safeJsonParse(row.metadata, {}, (err) => {
              logger.warn(`[VectorStore] Skipping corrupted metadata for chunk ${row.id}: ${err.message}`);
            }),
          },
        };
      });

      await store.insert(chunks);

      loaded += batch.length;
      offset += LOAD_BATCH_SIZE;
    }

    // Final progress update
    onProgress?.({
      phase: 'building',
      loaded: totalChunks,
      total: totalChunks,
    });

    return store;
  }

  /**
   * Check if a store is cached for a project.
   */
  hasStore(projectId: string): boolean {
    return this.stores.has(projectId);
  }

  /**
   * Invalidate cached store for a project.
   *
   * Call this after re-indexing to force rebuild on next search.
   */
  invalidate(projectId: string): void {
    this.stores.delete(projectId);
  }

  /**
   * Clear all cached stores.
   */
  clearAll(): void {
    this.stores.clear();
  }

  /**
   * Get the number of cached stores.
   */
  get cacheSize(): number {
    return this.stores.size;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let managerInstance: VectorStoreManager | null = null;

/**
 * Get the singleton VectorStoreManager instance.
 */
export function getVectorStoreManager(): VectorStoreManager {
  if (!managerInstance) {
    managerInstance = new VectorStoreManager();
  }
  return managerInstance;
}

/**
 * Reset the singleton instance.
 *
 * Useful for testing or when you need to clear all cached stores.
 */
export function resetVectorStoreManager(): void {
  if (managerInstance) {
    managerInstance.clearAll();
    managerInstance = null;
  }
}
