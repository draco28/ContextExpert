/**
 * Context Expert CLI Entry Point
 *
 * This is the main entry point for the `ctx` command.
 * It sets up Commander.js with global options and registers all subcommands.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import type { GlobalOptions, CommandContext } from './types.js';
import { createAskCommand } from './commands/ask.js';
import { createChatCommand } from './commands/chat.js';
import { createConfigCommand } from './commands/config.js';
import { createIndexCommand } from './commands/index.js';
import { createListCommand } from './commands/list.js';
import { createRemoveCommand } from './commands/remove.js';
import { createSearchCommand } from './commands/search.js';
import { createStatusCommand } from './commands/status.js';
import { createCheckCommand } from './commands/check.js';
import { createEvalCommand } from './commands/eval.js';
import {
  handleError,
  createGlobalErrorHandler,
  CLIError,
} from '../errors/index.js';
import {
  validateStartupConfig,
  printStartupValidation,
  getValidationOptionsForCommand,
} from '../config/index.js';

// Version injected at build time via tsup define
const VERSION = process.env.CLI_VERSION ?? '0.0.0';

// Create the root program
const program = new Command();

// Configure the program
program
  .name('ctx')
  .description('Cross-project context agent - unified search and Q&A across codebases')
  .version(VERSION, '-v, --version', 'Display version number')

  // Global options - available to ALL subcommands
  .option('--verbose', 'Enable verbose output for debugging', false)
  .option('--json', 'Output results as JSON', false)

  // Custom help formatting
  .addHelpText('after', `
${chalk.dim('Examples:')}
  ${chalk.cyan('ctx index ./my-project')}        Index a project for searching
  ${chalk.cyan('ctx ask "How does auth work?"')}   Ask a question across all indexed projects
  ${chalk.cyan('ctx search "login function"')}     Search for code patterns
  ${chalk.cyan('ctx list')}                      List all indexed projects
  ${chalk.cyan('ctx config list')}               Show all configuration
  ${chalk.cyan('ctx config set search.top_k 20')} Change a setting

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
    warn: (message: string) => {
      if (!options.json) {
        console.warn(chalk.yellow(`Warning: ${message}`));
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
// IMPLEMENTED COMMANDS
// ============================================================================

// Index command - index a project for searching (implemented)
program.addCommand(createIndexCommand(() => createContext(getGlobalOptions())));

// List command - list indexed projects (implemented)
program.addCommand(createListCommand(() => createContext(getGlobalOptions())));

// Remove command - delete an indexed project and its data (implemented)
program.addCommand(createRemoveCommand(() => createContext(getGlobalOptions())));

// Ask command - RAG-powered Q&A across indexed projects
program.addCommand(createAskCommand(() => createContext(getGlobalOptions())));

// Chat command - interactive multi-turn REPL with RAG
program.addCommand(createChatCommand(() => createContext(getGlobalOptions())));

// Search command - hybrid search (dense + BM25 + RRF fusion)
program.addCommand(createSearchCommand(() => createContext(getGlobalOptions())));

// ============================================================================
// REAL COMMANDS (implemented)
// ============================================================================

// Config command - manage ~/.ctx/config.toml
program.addCommand(createConfigCommand(() => createContext(getGlobalOptions())));

// Status command - show storage statistics and system health
program.addCommand(createStatusCommand(() => createContext(getGlobalOptions())));

// Check command - project health check for agents
program.addCommand(createCheckCommand(() => createContext(getGlobalOptions())));

// Eval command - evaluation and trace analysis
program.addCommand(createEvalCommand(() => createContext(getGlobalOptions())));

// ============================================================================
// ERROR HANDLING & EXECUTION
// ============================================================================

// Handle unknown commands gracefully
program.on('command:*', (operands: string[]) => {
  // Throw a CLIError with a helpful hint
  throw new CLIError(
    `Unknown command: ${operands[0]}`,
    `Run: ctx --help  to see available commands`
  );
});

// Validate API keys before command execution (for commands that need them)
program.hook('preAction', (thisCommand) => {
  const commandName = thisCommand.name();
  const opts = getGlobalOptions();

  // Get validation options based on command
  const validationOptions = getValidationOptionsForCommand(commandName);

  // Skip validation if command doesn't need any providers
  if (validationOptions.skipLLM && validationOptions.skipEmbedding) {
    return;
  }

  // Run validation
  const result = validateStartupConfig(validationOptions);

  // Print errors/warnings (verbose mode shows warnings too)
  if (result.errors.length > 0 || (opts.verbose && result.warnings.length > 0)) {
    printStartupValidation(result, opts.verbose);

    // If there are errors, throw to prevent command execution
    if (result.errors.length > 0) {
      throw new CLIError(
        'Configuration validation failed',
        'Fix the issues above and try again'
      );
    }
  }
});

// Parse arguments and execute
async function main() {
  // Get options for error handler (need to parse first for --verbose/--json)
  // We'll get them again after parsing, but this gives us defaults
  const getErrorOptions = () => {
    const opts = getGlobalOptions();
    return { verbose: opts.verbose, json: opts.json };
  };

  // Set up global error handlers for uncaught exceptions
  // These catch errors that escape all try/catch blocks
  const globalHandler = createGlobalErrorHandler(getErrorOptions());
  process.on('uncaughtException', globalHandler);
  process.on('unhandledRejection', globalHandler);

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    // Use our new error handler with current options
    handleError(error, getErrorOptions());
  }
}

main();
