/**
 * Remove Command
 *
 * Deletes an indexed project and all associated data:
 *   ctx remove <name>         - Remove a project (requires --force)
 *   ctx remove <name> --force - Remove without confirmation
 *
 * CASCADE DELETE automatically removes:
 * - All chunks (via FOREIGN KEY ... ON DELETE CASCADE)
 * - All file_hashes (via FOREIGN KEY ... ON DELETE CASCADE)
 */

import { Command } from 'commander';
import chalk from 'chalk';
import type { CommandContext } from '../types.js';
import { getDatabase } from '../../database/index.js';
import { runMigrations } from '../../database/migrate.js';
import { CLIError } from '../../errors/index.js';

/**
 * Command options for remove command
 */
interface RemoveOptions {
  force?: boolean;
}

/**
 * Estimate storage freed based on chunk count.
 * Uses average chunk size of ~2KB (content + embedding + metadata).
 */
function estimateStorageFreed(chunkCount: number): number {
  const AVG_CHUNK_SIZE_BYTES = 2048; // 2KB per chunk (rough estimate)
  return chunkCount * AVG_CHUNK_SIZE_BYTES;
}

/**
 * Format bytes as human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);

  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

/**
 * Create the remove command
 */
export function createRemoveCommand(
  getContext: () => CommandContext
): Command {
  return new Command('remove')
    .alias('rm')
    .argument('<name>', 'Name of the project to remove')
    .description('Remove an indexed project and all its data')
    .option('-f, --force', 'Skip confirmation prompt')
    .action(async (name: string, options: RemoveOptions) => {
      const ctx = getContext();
      ctx.debug(`Remove command called for project: ${name}`);
      ctx.debug(`Options: ${JSON.stringify(options)}`);

      // Ensure database is initialized
      runMigrations();
      const db = getDatabase();

      // Find the project by name
      const project = db.getProjectByName(name);

      if (!project) {
        throw new CLIError(
          `Project not found: ${name}`,
          'Run: ctx list  to see available projects'
        );
      }

      ctx.debug(`Found project: ${project.id} at ${project.path}`);

      // Confirmation check (unless --force or --json mode)
      if (!options.force && !ctx.options.json) {
        ctx.log(chalk.yellow(`This will permanently delete "${name}" and all indexed data.`));
        ctx.log(`  - ${chalk.dim('Path:')} ${project.path}`);
        ctx.log(`  - ${chalk.dim('Chunks:')} ${project.chunk_count.toLocaleString()}`);
        ctx.log(`  - ${chalk.dim('Files indexed:')} ${project.file_count.toLocaleString()}`);
        ctx.log('');
        ctx.log(`Run with ${chalk.cyan('--force')} to confirm deletion.`);
        process.exitCode = 1;
        return;
      }

      // Perform deletion
      const result = db.deleteProject(project.id);
      const storageFreed = estimateStorageFreed(result.chunksDeleted);

      ctx.debug(`Deleted ${result.chunksDeleted} chunks, ${result.fileHashesDeleted} file hashes`);

      // Output results
      if (ctx.options.json) {
        console.log(JSON.stringify({
          success: true,
          project: {
            id: project.id,
            name: project.name,
            path: project.path,
          },
          deleted: {
            chunks: result.chunksDeleted,
            fileHashes: result.fileHashesDeleted,
          },
          storageFreed: storageFreed,
        }));
      } else {
        ctx.log(`${chalk.green('✓')} Removed project "${chalk.cyan(name)}"`);
        ctx.log(`  - Deleted ${result.chunksDeleted.toLocaleString()} chunks`);
        ctx.log(`  - Deleted ${result.fileHashesDeleted.toLocaleString()} file hashes`);
        ctx.log(`  - Storage freed: ~${formatBytes(storageFreed)}`);
      }
    });
}
