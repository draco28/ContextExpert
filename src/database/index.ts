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
export {
  runMigrations,
  hasPendingMigrations,
  getAppliedMigrations,
  // State tracking (Ticket #52)
  resetMigrationState,
  isMigrationInitialized,
  getMigrationCount,
} from './migrate.js';

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

// Validation schemas and utilities (Ticket #51)
export {
  // Schemas
  ProjectRowSchema,
  ChunkRowSchema,
  FileHashRowSchema,
  // Types
  type ProjectRow,
  type ChunkRow,
  type FileHashRow,
  // Error class
  SchemaValidationError,
  // Validation functions
  validateRow,
  validateRows,
  safeValidateRow,
} from './validation.js';

// High-level database operations
export {
  getDatabase,
  resetDatabase,
  DatabaseOperations,
  type ProjectUpsertInput,
  type ChunkInsertInput,
  type ProjectStatsUpdate,
} from './operations.js';
