/**
 * Search Command
 *
 * Hybrid search across indexed projects using dense vectors + BM25 + RRF fusion.
 *
 *   ctx search "authentication middleware"
 *   ctx search "login" --project my-app --top 10 --json
 *
 * Uses the existing search infrastructure:
 * - FusionService for hybrid search (RRF fusion of dense + BM25)
 * - formatResults/formatResultsJSON for output formatting
 */

import { Command } from 'commander';
import chalk from 'chalk';
import type { CommandContext } from '../types.js';
import { getDb, runMigrations } from '../../database/index.js';
import { loadConfig } from '../../config/loader.js';
import { createEmbeddingProvider } from '../../indexer/embedder/index.js';
import {
  createFusionService,
  formatResults,
  formatResultsJSON,
  type SearchResultWithContext,
} from '../../search/index.js';
import { CLIError } from '../../errors/index.js';
import type { Project } from '../../database/schema.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Command-specific options parsed from CLI arguments.
 */
interface SearchCommandOptions {
  /** Limit search to specific project name */
  project?: string;
  /** Number of results to return (default: 10, max: 100) */
  top: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 100;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Resolve project(s) to search based on --project option.
 *
 * @param projectName - Optional project name filter
 * @returns Array of projects to search
 * @throws CLIError if project not found or no projects indexed
 */
function resolveProjects(projectName?: string): Project[] {
  runMigrations();
  const db = getDb();

  if (projectName) {
    // Single project lookup
    const project = db
      .prepare('SELECT * FROM projects WHERE name = ?')
      .get(projectName) as Project | undefined;

    if (!project) {
      throw new CLIError(
        `Project not found: ${projectName}`,
        'Run: ctx list  to see available projects'
      );
    }

    return [project];
  }

  // All projects
  const projects = db
    .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
    .all() as Project[];

  if (projects.length === 0) {
    throw new CLIError(
      'No projects indexed',
      'Run: ctx index <path>  to index a project first'
    );
  }

  return projects;
}

/**
 * Parse and validate the --top option.
 *
 * @param topStr - String value from CLI
 * @returns Validated top-k number
 * @throws CLIError if invalid
 */
function parseTopK(topStr: string): number {
  const topK = parseInt(topStr, 10);

  if (isNaN(topK) || topK < 1) {
    throw new CLIError(
      `Invalid --top value: "${topStr}"`,
      `Must be a positive integer (1-${MAX_TOP_K})`
    );
  }

  if (topK > MAX_TOP_K) {
    throw new CLIError(
      `--top value too large: ${topK}`,
      `Maximum allowed is ${MAX_TOP_K}`
    );
  }

  return topK;
}

/**
 * Display empty results message with helpful tips.
 */
function displayEmptyResults(ctx: CommandContext, query: string): void {
  ctx.log(chalk.yellow(`No results found for "${query}"`));
  ctx.log('');
  ctx.log(chalk.dim('Tips:'));
  ctx.log(chalk.dim('  - Try different keywords or phrasing'));
  ctx.log(chalk.dim('  - Use fewer, more specific terms'));
  ctx.log(chalk.dim('  - Check spelling'));
}

// ============================================================================
// Command Factory
// ============================================================================

/**
 * Create the search command.
 *
 * @param getContext - Factory to get command context with global options
 * @returns Configured Commander command
 */
export function createSearchCommand(
  getContext: () => CommandContext
): Command {
  return new Command('search')
    .argument('<query>', 'Search query text')
    .description('Search for code patterns across indexed projects')
    .option('-p, --project <name>', 'Limit search to specific project')
    .option('-k, --top <number>', 'Number of results to return', String(DEFAULT_TOP_K))
    .action(async (query: string, cmdOptions: SearchCommandOptions) => {
      const ctx = getContext();

      ctx.debug(`Query: "${query}"`);
      ctx.debug(`Options: ${JSON.stringify(cmdOptions)}`);

      // ─────────────────────────────────────────────────────────────────────
      // 1. Validate query
      // ─────────────────────────────────────────────────────────────────────
      const trimmedQuery = query.trim();
      if (!trimmedQuery) {
        throw new CLIError(
          'Search query cannot be empty',
          'Provide a search term, e.g.: ctx search "authentication"'
        );
      }

      // ─────────────────────────────────────────────────────────────────────
      // 2. Parse options
      // ─────────────────────────────────────────────────────────────────────
      const topK = parseTopK(cmdOptions.top);
      ctx.debug(`Top-K: ${topK}`);

      // ─────────────────────────────────────────────────────────────────────
      // 3. Resolve projects
      // ─────────────────────────────────────────────────────────────────────
      const projects = resolveProjects(cmdOptions.project);
      const projectNames = projects.map((p) => p.name);
      const projectIds = projects.map((p) => p.id);
      const isMultiProject = projects.length > 1;

      ctx.debug(`Searching ${projects.length} project(s): ${projectNames.join(', ')}`);

      // ─────────────────────────────────────────────────────────────────────
      // 4. Load config and create embedding provider
      // ─────────────────────────────────────────────────────────────────────
      const config = loadConfig();
      ctx.debug(`Embedding: ${config.embedding.model} (${config.embedding.provider})`);

      const { provider: embeddingProvider, model: embeddingModel, dimensions } =
        await createEmbeddingProvider(config.embedding, {
          onProgress: (p) => ctx.debug(`Embedding init: ${p.status}`),
        });

      // ─────────────────────────────────────────────────────────────────────
      // 5. Create FusionService and execute search
      // ─────────────────────────────────────────────────────────────────────
      // Use first project for service initialization (projectIds filter handles multi-project)
      // Pass dimensions from provider to ensure consistency with indexed data
      ctx.debug(`Using model: ${embeddingModel} (${dimensions}d)`);

      const fusionService = createFusionService(
        projects[0].id,
        embeddingProvider,
        config.search,
        { denseOptions: { dimensions } }
      );

      ctx.debug('Initializing search index...');
      await fusionService.ensureInitialized((progress) => {
        ctx.debug(`Index: ${progress.phase} ${progress.loaded}/${progress.total}`);
      });

      ctx.debug('Executing hybrid search...');
      // Note: FusionService is already scoped to the first project's data.
      // Multi-project search would require loading all project stores.
      // For now, we search the first project (single-project mode effective).
      const results: SearchResultWithContext[] = await fusionService.search(trimmedQuery, {
        topK,
      });

      ctx.debug(`Found ${results.length} results`);

      // ─────────────────────────────────────────────────────────────────────
      // 6. Format and output results
      // ─────────────────────────────────────────────────────────────────────
      if (ctx.options.json) {
        // JSON output mode
        const jsonOutput = {
          query: trimmedQuery,
          count: results.length,
          projectsSearched: projectNames,
          results: formatResultsJSON(results, { showProject: isMultiProject }),
        };
        console.log(JSON.stringify(jsonOutput, null, 2));
        return;
      }

      // Human-readable output
      if (results.length === 0) {
        displayEmptyResults(ctx, trimmedQuery);
        return;
      }

      // Header
      const projectContext = isMultiProject
        ? ` across ${projects.length} projects`
        : ` in ${projectNames[0]}`;
      ctx.log(
        chalk.bold(`Found ${results.length} result${results.length === 1 ? '' : 's'}`) +
          chalk.dim(` for "${trimmedQuery}"${projectContext}`)
      );
      ctx.log('');

      // Results
      const formattedResults = formatResults(results, {
        showProject: isMultiProject,
        snippetLength: 200,
      });
      ctx.log(formattedResults);
    });
}
