/**
 * List Command
 *
 * Displays all indexed projects with statistics:
 *   ctx list     - Show table of all projects
 *   ctx ls       - Alias for list
 *   ctx list --json - Output as JSON
 */

import { Command } from 'commander';
import chalk from 'chalk';
import type { CommandContext } from '../types.js';
import { getDb, runMigrations, type Project } from '../../database/index.js';
import { formatTable, type Column } from '../../utils/table.js';
import { DatabaseError } from '../../errors/index.js';

/**
 * Format a number with thousand separators
 */
function formatNumber(n: number): string {
  return n.toLocaleString();
}

/**
 * Format a timestamp as relative time (e.g., "2 hours ago")
 */
function formatRelativeTime(isoString: string | null): string {
  if (!isoString) return 'Never';

  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'Just now';
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? '' : 's'} ago`;
  if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
  if (diffDay < 30) {
    const weeks = Math.floor(diffDay / 7);
    return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  }

  // For older dates, show the actual date
  return date.toLocaleDateString();
}

/**
 * Truncate a path for display, showing ~ for home directory
 */
function formatPath(path: string, maxLength = 40): string {
  // Replace home directory with ~
  const homeDir = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
  let displayPath = path;

  if (homeDir && path.startsWith(homeDir)) {
    displayPath = '~' + path.slice(homeDir.length);
  }

  // Truncate if too long
  if (displayPath.length > maxLength) {
    return '...' + displayPath.slice(-(maxLength - 3));
  }

  return displayPath;
}

/**
 * Get all projects from the database
 */
function getProjects(): Project[] {
  try {
    // Ensure database is initialized
    runMigrations();
    const db = getDb();

    // Query all projects, sorted by most recently updated
    const projects = db
      .prepare(
        `SELECT id, name, path, tags, ignore_patterns, indexed_at, updated_at, file_count, chunk_count, config
         FROM projects
         ORDER BY COALESCE(updated_at, indexed_at, datetime('now')) DESC`
      )
      .all() as Project[];

    return projects;
  } catch (error) {
    throw new DatabaseError(
      'Failed to query projects from database',
      error instanceof Error ? error.message : 'Unknown error',
      'Ensure the database is properly initialized'
    );
  }
}

/**
 * Create the list command
 */
export function createListCommand(
  getContext: () => CommandContext
): Command {
  return new Command('list')
    .alias('ls')
    .description('List all indexed projects')
    .action(() => {
      const ctx = getContext();
      ctx.debug('Listing projects...');

      const projects = getProjects();
      ctx.debug(`Found ${projects.length} project(s)`);

      // Handle JSON output
      if (ctx.options.json) {
        const jsonOutput = {
          count: projects.length,
          projects: projects.map((p) => ({
            id: p.id,
            name: p.name,
            path: p.path,
            tags: p.tags ? JSON.parse(p.tags) : [],
            fileCount: p.file_count,
            chunkCount: p.chunk_count,
            indexedAt: p.indexed_at,
            updatedAt: p.updated_at,
          })),
        };
        console.log(JSON.stringify(jsonOutput, null, 2));
        return;
      }

      // Handle empty state
      if (projects.length === 0) {
        ctx.log(chalk.yellow('No projects indexed yet.'));
        ctx.log('');
        ctx.log(chalk.dim('Get started:'));
        ctx.log(`  ${chalk.cyan('ctx index ~/path/to/project --name "my-project"')}`);
        return;
      }

      // Define table columns
      const columns: Column[] = [
        { header: 'Name', key: 'name' },
        { header: 'Path', key: 'path' },
        { header: 'Files', key: 'files', align: 'right' },
        { header: 'Chunks', key: 'chunks', align: 'right' },
        { header: 'Last Updated', key: 'updated' },
      ];

      // Transform projects to table rows
      const rows = projects.map((p) => ({
        name: p.name,
        path: formatPath(p.path),
        files: formatNumber(p.file_count),
        chunks: formatNumber(p.chunk_count),
        updated: formatRelativeTime(p.updated_at ?? p.indexed_at),
      }));

      // Output the table
      ctx.log(formatTable(columns, rows));
      ctx.log('');
      ctx.log(
        chalk.dim(
          `${projects.length} project${projects.length === 1 ? '' : 's'} indexed`
        )
      );
    });
}
