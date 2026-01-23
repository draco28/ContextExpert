/**
 * Context Expert CLI Entry Point
 *
 * This is the main entry point for the `ctx` command.
 * It sets up Commander.js with global options and registers all subcommands.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import type { GlobalOptions, CommandContext } from './types.js';

// Create the root program
const program = new Command();

// Configure the program
program
  .name('ctx')
  .description('Cross-project context agent - unified search and Q&A across codebases')
  .version('0.1.0', '-v, --version', 'Display version number')

  // Global options - available to ALL subcommands
  .option('--verbose', 'Enable verbose output for debugging', false)
  .option('--json', 'Output results as JSON', false)

  // Custom help formatting
  .addHelpText('after', `
${chalk.dim('Examples:')}
  ${chalk.cyan('ctx index ./my-project')}     Index a project for searching
  ${chalk.cyan('ctx ask "How does auth work?"')}  Ask a question across all indexed projects
  ${chalk.cyan('ctx search "login function"')}    Search for code patterns
  ${chalk.cyan('ctx list')}                     List all indexed projects

${chalk.dim('Documentation:')}
  https://github.com/your-org/context-expert
`);

/**
 * Create a command context with logging utilities
 * This is passed to all command handlers
 */
function createContext(options: GlobalOptions): CommandContext {
  return {
    options,
    log: (message: string) => {
      if (!options.json) {
        console.log(message);
      }
    },
    debug: (message: string) => {
      if (options.verbose && !options.json) {
        console.log(chalk.dim(`[debug] ${message}`));
      }
    },
    error: (message: string) => {
      if (options.json) {
        console.error(JSON.stringify({ error: message }));
      } else {
        console.error(chalk.red(`Error: ${message}`));
      }
    },
  };
}

/**
 * Get global options from the program
 * Commander stores options on the Command object after parsing
 */
function getGlobalOptions(): GlobalOptions {
  const opts = program.opts<GlobalOptions>();
  return {
    verbose: opts.verbose ?? false,
    json: opts.json ?? false,
  };
}

// ============================================================================
// PLACEHOLDER COMMANDS
// These demonstrate the command structure - will be replaced with real implementations
// ============================================================================

// Index command - index a project for searching
program
  .command('index <path>')
  .description('Index a project directory for searching')
  .option('-n, --name <name>', 'Project name (defaults to directory name)')
  .option('-t, --tags <tags>', 'Comma-separated tags for organization')
  .action(async (path: string, cmdOptions: { name?: string; tags?: string }) => {
    const ctx = createContext(getGlobalOptions());
    ctx.debug(`Indexing path: ${path}`);
    ctx.debug(`Options: ${JSON.stringify(cmdOptions)}`);

    if (ctx.options.json) {
      console.log(JSON.stringify({
        status: 'placeholder',
        message: 'Index command not yet implemented',
        path,
        options: cmdOptions,
      }));
    } else {
      ctx.log(chalk.yellow('Index command not yet implemented'));
      ctx.log(`Would index: ${chalk.cyan(path)}`);
    }
  });

// List command - list indexed projects
program
  .command('list')
  .alias('ls')
  .description('List all indexed projects')
  .action(async () => {
    const ctx = createContext(getGlobalOptions());
    ctx.debug('Listing projects...');

    if (ctx.options.json) {
      console.log(JSON.stringify({
        status: 'placeholder',
        message: 'List command not yet implemented',
        projects: [],
      }));
    } else {
      ctx.log(chalk.yellow('List command not yet implemented'));
      ctx.log('No projects indexed yet.');
    }
  });

// Ask command - ask a question across indexed projects
program
  .command('ask <question>')
  .description('Ask a question across all indexed projects')
  .option('-p, --project <name>', 'Limit search to specific project')
  .option('-k, --top-k <number>', 'Number of context chunks to retrieve', '5')
  .action(async (question: string, cmdOptions: { project?: string; topK: string }) => {
    const ctx = createContext(getGlobalOptions());
    ctx.debug(`Question: ${question}`);
    ctx.debug(`Options: ${JSON.stringify(cmdOptions)}`);

    if (ctx.options.json) {
      console.log(JSON.stringify({
        status: 'placeholder',
        message: 'Ask command not yet implemented',
        question,
        options: cmdOptions,
      }));
    } else {
      ctx.log(chalk.yellow('Ask command not yet implemented'));
      ctx.log(`Would search for: ${chalk.cyan(question)}`);
    }
  });

// Search command - search for code patterns
program
  .command('search <query>')
  .description('Search for code patterns across indexed projects')
  .option('-p, --project <name>', 'Limit search to specific project')
  .option('-t, --type <type>', 'Filter by file type (e.g., ts, py, md)')
  .action(async (query: string, cmdOptions: { project?: string; type?: string }) => {
    const ctx = createContext(getGlobalOptions());
    ctx.debug(`Query: ${query}`);
    ctx.debug(`Options: ${JSON.stringify(cmdOptions)}`);

    if (ctx.options.json) {
      console.log(JSON.stringify({
        status: 'placeholder',
        message: 'Search command not yet implemented',
        query,
        options: cmdOptions,
      }));
    } else {
      ctx.log(chalk.yellow('Search command not yet implemented'));
      ctx.log(`Would search for: ${chalk.cyan(query)}`);
    }
  });

// ============================================================================
// ERROR HANDLING & EXECUTION
// ============================================================================

// Handle unknown commands gracefully
program.on('command:*', (operands: string[]) => {
  const ctx = createContext(getGlobalOptions());
  ctx.error(`Unknown command: ${operands[0]}`);
  ctx.log('');
  ctx.log(`Run ${chalk.cyan('ctx --help')} to see available commands.`);
  process.exit(1);
});

// Parse arguments and execute
async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    const ctx = createContext(getGlobalOptions());
    if (error instanceof Error) {
      ctx.error(error.message);
      if (ctx.options.verbose) {
        console.error(error.stack);
      }
    } else {
      ctx.error('An unexpected error occurred');
    }
    process.exit(1);
  }
}

main();
