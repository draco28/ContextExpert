/**
 * Check Command
 *
 * Pre-flight health check for a project's index readiness:
 *   ctx check <project>         - Show health check results
 *   ctx check <project> --json  - Output as JSON (for agent consumption)
 *
 * Checks performed:
 * 1. Project exists in database
 * 2. Has indexed chunks (error if zero)
 * 3. Source path exists on disk (error if missing)
 * 4. Embedding model matches current config (warning if mismatch)
 * 5. Staleness: compares indexed_at vs file mtimes (warning if stale)
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext } from '../types.js';
import { getDb, runMigrations, type Project } from '../../database/index.js';
import { loadConfig } from '../../config/loader.js';
import { CLIError } from '../../errors/index.js';

// ============================================================================
// Types
// ============================================================================

interface CheckIssue {
  severity: 'error' | 'warning';
  message: string;
  hint: string;
}

interface StalenessInfo {
  filesChanged: number;
  needsReindex: boolean;
  pathExists: boolean;
}

interface CheckResultJSON {
  ready: boolean;
  project: {
    name: string;
    path: string;
    id: string;
  };
  chunkCount: number;
  embeddingModel: string | null;
  embeddingDimensions: number;
  description: string | null;
  issues: CheckIssue[];
  staleness: StalenessInfo;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check how many tracked files have been modified since indexing.
 */
function checkStaleness(projectId: string, projectPath: string): StalenessInfo {
  if (!existsSync(projectPath)) {
    return { filesChanged: 0, needsReindex: false, pathExists: false };
  }

  const db = getDb();

  const fileHashes = db
    .prepare('SELECT file_path, indexed_at FROM file_hashes WHERE project_id = ?')
    .all(projectId) as Array<{ file_path: string; indexed_at: string }>;

  let filesChanged = 0;

  for (const fh of fileHashes) {
    const fullPath = join(projectPath, fh.file_path);
    if (!existsSync(fullPath)) {
      filesChanged++;
      continue;
    }

    try {
      const stat = statSync(fullPath);
      const indexedAt = new Date(fh.indexed_at).getTime();
      const mtimeMs = stat.mtimeMs;

      if (mtimeMs > indexedAt) {
        filesChanged++;
      }
    } catch {
      // Can't stat file - count as changed
      filesChanged++;
    }
  }

  return {
    filesChanged,
    needsReindex: filesChanged > 0,
    pathExists: true,
  };
}

// ============================================================================
// Command Factory
// ============================================================================

/**
 * Create the check command
 */
export function createCheckCommand(
  getContext: () => CommandContext
): Command {
  return new Command('check')
    .argument('<project>', 'Name of the project to check')
    .description('Check project health and index readiness')
    .action((projectName: string) => {
      const ctx = getContext();
      ctx.debug(`Check command for project: ${projectName}`);

      // Ensure database is initialized
      runMigrations();
      const db = getDb();

      // 1. Look up project
      const project = db
        .prepare('SELECT * FROM projects WHERE name = ?')
        .get(projectName) as Project | undefined;

      if (!project) {
        throw new CLIError(
          `Project not found: ${projectName}`,
          'Run: ctx list  to see available projects'
        );
      }

      ctx.debug(`Found project: ${project.id} at ${project.path}`);

      const issues: CheckIssue[] = [];

      // 2. Check chunks
      if (project.chunk_count === 0) {
        issues.push({
          severity: 'error',
          message: 'Project has no indexed chunks',
          hint: `Run: ctx index ${project.path} --name "${project.name}"`,
        });
      }

      // 3. Check path exists
      const pathExists = existsSync(project.path);
      if (!pathExists) {
        issues.push({
          severity: 'error',
          message: `Project path does not exist: ${project.path}`,
          hint: 'Re-index at the new location or remove this project',
        });
      }

      // 4. Check embedding model matches current config
      const config = loadConfig();
      const currentModel = config.embedding.model;
      if (project.embedding_model && project.embedding_model !== currentModel) {
        issues.push({
          severity: 'warning',
          message: `Embedding model mismatch: project uses "${project.embedding_model}", config uses "${currentModel}"`,
          hint: 'Re-index to update embeddings or change config to match',
        });
      }

      // 5. Staleness check
      const staleness = pathExists
        ? checkStaleness(String(project.id), project.path)
        : { filesChanged: 0, needsReindex: false, pathExists: false };

      if (staleness.needsReindex) {
        issues.push({
          severity: 'warning',
          message: `${staleness.filesChanged} file${staleness.filesChanged === 1 ? '' : 's'} changed since last index`,
          hint: `Run: ctx index ${project.path} --name "${project.name}"`,
        });
      }

      // ready = no error-level issues
      const hasErrors = issues.some((i) => i.severity === 'error');
      const ready = !hasErrors;

      // Set exit code if not ready
      if (!ready) {
        process.exitCode = 1;
      }

      // JSON output
      if (ctx.options.json) {
        const output: CheckResultJSON = {
          ready,
          project: {
            name: project.name,
            path: project.path,
            id: String(project.id),
          },
          chunkCount: project.chunk_count,
          embeddingModel: project.embedding_model,
          embeddingDimensions: project.embedding_dimensions,
          description: project.description,
          issues,
          staleness,
        };
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      // Text output
      const lines: string[] = [];

      lines.push(
        chalk.bold(`Project: ${project.name}`) +
        (ready ? chalk.green(' (ready)') : chalk.red(' (not ready)'))
      );
      lines.push(chalk.dim('─'.repeat(40)));
      lines.push(`${chalk.cyan('Path:')}        ${project.path}`);
      lines.push(`${chalk.cyan('Chunks:')}      ${project.chunk_count.toLocaleString()}`);
      lines.push(`${chalk.cyan('Embedding:')}   ${project.embedding_model ?? 'unknown'}`);
      if (project.description) {
        lines.push(`${chalk.cyan('Description:')} ${project.description}`);
      }

      if (issues.length > 0) {
        lines.push('');
        lines.push(chalk.bold('Issues:'));
        for (const issue of issues) {
          const icon = issue.severity === 'error' ? chalk.red('✗') : chalk.yellow('⚠');
          lines.push(`  ${icon} ${issue.message}`);
          lines.push(chalk.dim(`    ${issue.hint}`));
        }
      } else {
        lines.push('');
        lines.push(chalk.green('No issues found. Project is ready for queries.'));
      }

      if (staleness.pathExists && staleness.filesChanged === 0 && project.chunk_count > 0) {
        lines.push('');
        lines.push(chalk.dim('Index is up to date.'));
      }

      ctx.log(lines.join('\n'));
    });
}
