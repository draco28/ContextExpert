/**
 * Database Module
 *
 * SQLite storage for projects and document chunks.
 *
 * @example
 * ```ts
 * import { getDatabase, runMigrations, type Project } from './database/index.js';
 *
 * // Run migrations on startup
 * runMigrations();
 *
 * // Use high-level operations
 * const db = getDatabase();
 * const projects = db.getAllProjects();
 * ```
 */

// Connection management (low-level)
export { getDb, closeDb, getDbPath, getCtxDir } from './connection.js';

// Migration utilities
export { runMigrations, hasPendingMigrations, getAppliedMigrations } from './migrate.js';

// Schema types
export type {
  Project,
  ProjectInput,
  Chunk,
  ChunkInput,
  FileHash,
  FileHashInput,
} from './schema.js';

// Utility functions
export { generateId, embeddingToBlob, blobToEmbedding } from './schema.js';

// High-level database operations
export {
  getDatabase,
  resetDatabase,
  DatabaseOperations,
  type ProjectUpsertInput,
  type ChunkInsertInput,
  type ProjectStatsUpdate,
} from './operations.js';
