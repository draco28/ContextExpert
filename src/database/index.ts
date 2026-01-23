/**
 * Database Module
 *
 * SQLite storage for projects and document chunks.
 *
 * @example
 * ```ts
 * import { getDb, runMigrations, type Project } from './database/index.js';
 *
 * // Run migrations on startup
 * runMigrations();
 *
 * // Use database
 * const db = getDb();
 * const projects = db.prepare('SELECT * FROM projects').all() as Project[];
 * ```
 */

// Connection management
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
