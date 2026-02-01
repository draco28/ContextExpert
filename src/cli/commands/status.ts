/**
 * Status Command
 *
 * Displays storage statistics and system health:
 *   ctx status         - Show system status
 *   ctx status --json  - Output as JSON
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { statSync, existsSync } from 'node:fs';
import type { CommandContext } from '../types.js';
import { getDb, runMigrations, getDbPath } from '../../database/index.js';
import { loadConfig, getConfigPath } from '../../config/loader.js';
import { DatabaseError } from '../../errors/index.js';

/**
 * Statistics returned from the database
 */
interface DbStats {
  projectCount: number;
  totalChunks: number;
}

/**
 * Format bytes to human-readable size (e.g., "127.4 MB")
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Format a path with ~ for home directory
 */
function formatPath(filePath: string): string {
  const homeDir = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
  if (homeDir && filePath.startsWith(homeDir)) {
    return '~' + filePath.slice(homeDir.length);
  }
  return filePath;
}

/**
 * Format a number with thousand separators
 */
function formatNumber(n: number): string {
  return n.toLocaleString();
}

/**
 * Get aggregate statistics from the database
 */
function getDbStats(): DbStats {
  try {
    runMigrations();
    const db = getDb();

    // Get aggregate statistics with a single query
    const stats = db
      .prepare(
        `SELECT
           COUNT(*) as project_count,
           COALESCE(SUM(chunk_count), 0) as total_chunks
         FROM projects`
      )
      .get() as { project_count: number; total_chunks: number };

    return {
      projectCount: stats.project_count,
      totalChunks: stats.total_chunks,
    };
  } catch (error) {
    throw new DatabaseError(
      'Failed to query database statistics',
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Get the database file size in bytes
 */
function getDbFileSize(): number {
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    return 0;
  }

  const stats = statSync(dbPath);
  return stats.size;
}

/**
 * Create the status command
 */
export function createStatusCommand(
  getContext: () => CommandContext
): Command {
  return new Command('status')
    .description('Show storage statistics and system health')
    .action(() => {
      const ctx = getContext();
      ctx.debug('Fetching system status...');

      // Gather all statistics
      const dbStats = getDbStats();
      const dbSize = getDbFileSize();
      const dbPath = getDbPath();
      const configPath = getConfigPath();

      // Load config for embedding/provider info
      const config = loadConfig();

      ctx.debug(`Projects: ${dbStats.projectCount}, Chunks: ${dbStats.totalChunks}`);

      // Handle JSON output
      if (ctx.options.json) {
        const jsonOutput = {
          projects: dbStats.projectCount,
          totalChunks: dbStats.totalChunks,
          database: {
            path: dbPath,
            size: dbSize,
            sizeFormatted: formatBytes(dbSize),
          },
          embedding: {
            provider: config.embedding.provider,
            model: config.embedding.model,
          },
          llm: {
            provider: config.default_provider,
            model: config.default_model,
          },
          config: {
            path: configPath,
          },
        };
        console.log(JSON.stringify(jsonOutput, null, 2));
        return;
      }

      // Build formatted output
      const lines: string[] = [];

      lines.push(chalk.bold('Context Expert Status'));
      lines.push(chalk.dim('─'.repeat(35)));

      // Core statistics
      lines.push(`${chalk.cyan('Projects:')}     ${formatNumber(dbStats.projectCount)}`);
      lines.push(`${chalk.cyan('Total Chunks:')} ${formatNumber(dbStats.totalChunks)}`);
      lines.push(
        `${chalk.cyan('Database:')}     ${formatBytes(dbSize)} (${formatPath(dbPath)})`
      );

      // Configuration info
      lines.push('');
      lines.push(
        `${chalk.cyan('Embeddings:')}   ${config.embedding.model} (${config.embedding.provider})`
      );
      lines.push(
        `${chalk.cyan('Provider:')}     ${config.default_provider} (${config.default_model})`
      );
      lines.push(`${chalk.cyan('Config:')}       ${formatPath(configPath)}`);

      // Empty state hint
      if (dbStats.projectCount === 0) {
        lines.push('');
        lines.push(chalk.yellow('No projects indexed.'));
        lines.push(`Run ${chalk.cyan('ctx index <path>')} to get started.`);
      }

      ctx.log(lines.join('\n'));
    });
}
