/**
 * Context Expert - Library Entry Point
 *
 * This module exports the programmatic API for Context Expert.
 * Use this when integrating Context Expert into other tools or agents.
 *
 * @example
 * ```typescript
 * import { ContextExpert } from 'context-expert';
 *
 * const ctx = new ContextExpert();
 * await ctx.indexProject('./my-project');
 * const results = await ctx.search('authentication');
 * ```
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

// Placeholder for the main API class
// This will be implemented in future tickets
export class ContextExpert {
  constructor() {
    // TODO: Initialize database connection, embeddings, etc.
  }

  async indexProject(_path: string, _options?: { name?: string; tags?: string[] }): Promise<void> {
    throw new Error('Not yet implemented');
  }

  async search(_query: string, _options?: { project?: string; limit?: number }): Promise<unknown[]> {
    throw new Error('Not yet implemented');
  }

  async ask(_question: string, _options?: { project?: string }): Promise<string> {
    throw new Error('Not yet implemented');
  }
}

// Default export for convenience
export default ContextExpert;
