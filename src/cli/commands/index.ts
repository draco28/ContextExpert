/**
 * Index Command
 *
 * Indexes a project directory for semantic search.
 * This is the main entry point for adding projects to the context system.
 *
 * Usage:
 *   ctx index <path>              Index a directory
 *   ctx index ./my-project -n app Set custom project name
 *   ctx index . --tags api,core   Add tags for filtering
 *   ctx index . --json            Output progress as NDJSON
 *   ctx index . --verbose         Show detailed per-file progress
 *
 * The indexing pipeline:
 * 1. Scanning - Discover files matching supported extensions
 * 2. Chunking - Split files into semantic segments (functions, paragraphs)
 * 3. Embedding - Compute vector embeddings for each chunk
 * 4. Storing - Save chunks to SQLite for retrieval
 */

import { Command } from 'commander';
import { resolve, basename } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import chalk from 'chalk';

import type { CommandContext } from '../types.js';
import {
  createProgressReporter,
  type IndexPipelineResult,
} from '../utils/progress.js';
import { runIndexPipeline } from '../../indexer/index.js';
import { createEmbeddingProvider } from '../../indexer/embedder/index.js';
import { loadConfig, DEFAULT_CONFIG } from '../../config/index.js';
import { runMigrations, getDatabase } from '../../database/index.js';
import { CLIError } from '../../errors/index.js';

/**
 * Command-specific options.
 */
interface IndexCommandOptions {
  name?: string;
  tags?: string;
  force?: boolean;
}

/**
 * Create the index command.
 *
 * @param getContext - Factory function to get the command context
 * @returns Configured Commander command
 */
export function createIndexCommand(
  getContext: () => CommandContext
): Command {
  return new Command('index')
    .argument('<path>', 'Path to the project directory to index')
    .description('Index a project directory for semantic search')
    .option('-n, --name <name>', 'Project name (defaults to directory name)')
    .option('-t, --tags <tags>', 'Comma-separated tags for organization')
    .option('--force', 'Re-index even if project already exists', false)
    .action(async (path: string, cmdOptions: IndexCommandOptions) => {
      const ctx = getContext();

      // Resolve and validate path
      const projectPath = resolve(path);

      if (!existsSync(projectPath)) {
        throw new CLIError(
          `Path does not exist: ${projectPath}`,
          'Check the path and try again'
        );
      }

      const stat = statSync(projectPath);
      if (!stat.isDirectory()) {
        throw new CLIError(
          `Path is not a directory: ${projectPath}`,
          'ctx index requires a directory path, not a file'
        );
      }

      // Determine project name
      const projectName = cmdOptions.name ?? basename(projectPath);

      // Parse tags
      const tags = cmdOptions.tags
        ? cmdOptions.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : undefined;

      ctx.debug(`Indexing path: ${projectPath}`);
      ctx.debug(`Project name: ${projectName}`);
      if (tags) ctx.debug(`Tags: ${tags.join(', ')}`);

      // Check if project already exists
      const db = getDatabase();
      const existingProject = db.getProjectByPath(projectPath);

      if (existingProject && !cmdOptions.force) {
        throw new CLIError(
          `Project already indexed: ${existingProject.name} (${existingProject.path})`,
          'Use --force to re-index, or choose a different directory'
        );
      }

      // If re-indexing, clear existing chunks
      if (existingProject && cmdOptions.force) {
        ctx.debug(`Re-indexing: clearing ${existingProject.chunk_count} existing chunks`);
        db.deleteProjectChunks(existingProject.id);
      }

      // Ensure database is migrated
      runMigrations();

      // Load configuration
      const config = loadConfig() ?? DEFAULT_CONFIG;
      ctx.debug(`Embedding provider: ${config.embedding.provider}`);
      ctx.debug(`Embedding model: ${config.embedding.model}`);

      // Create progress reporter
      const reporter = createProgressReporter({
        json: ctx.options.json,
        verbose: ctx.options.verbose,
        noColor: !!process.env.NO_COLOR,
        isInteractive: process.stdout.isTTY ?? false,
      });

      // Create embedding provider with progress callback for model loading
      ctx.debug('Initializing embedding provider...');

      let modelLoadingSpinner: ReturnType<typeof import('ora').default> | null = null;
      if (!ctx.options.json && process.stdout.isTTY) {
        const ora = (await import('ora')).default;
        modelLoadingSpinner = ora({
          text: 'Loading embedding model...',
          prefixText: chalk.cyan('Setup'.padEnd(12)),
        }).start();
      }

      let embeddingProvider;
      let embeddingModel: string;
      let embeddingDimensions: number;
      try {
        const result = await createEmbeddingProvider(config.embedding, {
          onProgress: (progress) => {
            if (modelLoadingSpinner) {
              const pct = progress.progress ? ` (${progress.progress}%)` : '';
              modelLoadingSpinner.text = `${progress.status}${pct}`;
            } else if (ctx.options.json) {
              console.log(JSON.stringify({
                type: 'model_loading',
                timestamp: new Date().toISOString(),
                data: progress,
              }));
            }
          },
        });
        embeddingProvider = result.provider;
        embeddingModel = result.model;
        embeddingDimensions = result.dimensions;
        modelLoadingSpinner?.succeed(`Embedding model ready (${embeddingModel}, ${embeddingDimensions}d)`);
      } catch (error) {
        modelLoadingSpinner?.fail('Failed to load embedding model');
        throw new CLIError(
          `Failed to initialize embedding provider: ${(error as Error).message}`,
          'Check your embedding configuration in ~/.ctx/config.toml'
        );
      }

      // Run the indexing pipeline
      let result: IndexPipelineResult;

      try {
        result = await runIndexPipeline({
          projectPath,
          projectName,
          projectId: existingProject?.id,
          embeddingProvider,
          embeddingModel,
          embeddingDimensions,
          chunkerConfig: {
            embeddingProvider, // For SemanticChunker on docs
          },

          // Wire up progress callbacks to the reporter
          onStageStart: (stage, total) => {
            reporter.startStage(stage, total);
          },
          onProgress: (stage, processed, total, currentFile) => {
            reporter.updateProgress(processed, currentFile);
          },
          onStageComplete: (stage, stats) => {
            reporter.completeStage(stats);
          },
          onWarning: (message, context) => {
            reporter.warn(message, context);
          },
          onError: (error, context) => {
            reporter.error(error.message, context);
          },
        });
      } catch (error) {
        throw new CLIError(
          `Indexing failed: ${(error as Error).message}`,
          'Check the error details above and try again'
        );
      }

      // Show final summary
      reporter.showSummary(result);
    });
}
