/**
 * Context Expert - Library Entry Point
 *
 * This module exports low-level utilities for advanced integrations.
 * For most use cases, use the CLI (`ctx`) which provides the full feature set.
 *
 * ## Primary Interface
 *
 * The CLI is the recommended way to use Context Expert:
 * ```bash
 * ctx index ./my-project     # Index a project
 * ctx search "auth"          # Search indexed code
 * ctx ask "How does auth work?"  # Q&A with RAG
 * ctx chat                   # Interactive REPL
 * ```
 *
 * ## Library Exports
 *
 * This module exports database utilities and types for:
 * - Building custom tools on top of Context Expert's storage
 * - Plugin/extension development
 * - Direct database access when CLI is insufficient
 *
 * @example Database access
 * ```typescript
 * import { getDb, runMigrations } from 'context-expert';
 *
 * runMigrations();
 * const db = getDb();
 * const projects = db.prepare('SELECT * FROM projects').all();
 * ```
 *
 * @example Type-safe project queries
 * ```typescript
 * import type { Project, Chunk } from 'context-expert';
 * import { getDb } from 'context-expert';
 *
 * const db = getDb();
 * const project = db.prepare('SELECT * FROM projects WHERE name = ?').get('my-project') as Project;
 * ```
 *
 * @packageDocumentation
 */

// Re-export types for library consumers
export type { GlobalOptions, CommandContext } from './cli/types.js';

// Re-export database module
export {
  getDb,
  closeDb,
  getDbPath,
  getCtxDir,
  runMigrations,
  hasPendingMigrations,
  getAppliedMigrations,
  generateId,
  embeddingToBlob,
  blobToEmbedding,
} from './database/index.js';

export type {
  Project,
  ProjectInput,
  Chunk,
  ChunkInput,
  FileHash,
  FileHashInput,
} from './database/index.js';
