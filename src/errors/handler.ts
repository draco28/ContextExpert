/**
 * Error handler for CLI error formatting and display
 *
 * This module provides:
 * - Colored error output for terminal
 * - JSON output for programmatic use
 * - Verbose mode for debugging with stack traces
 */

import chalk from 'chalk';
import { CLIError } from './types.js';

/**
 * Options for error handling behavior
 */
export interface ErrorHandlerOptions {
  /** Show full stack traces */
  verbose?: boolean;
  /** Output as JSON instead of formatted text */
  json?: boolean;
}

/**
 * Structured error for JSON output
 */
export interface ErrorOutput {
  error: string;
  code: number;
  hint?: string;
  stack?: string;
}

/**
 * Format an error for display.
 *
 * Why separate format from handle?
 * - Testability: We can test formatting without process.exit
 * - Flexibility: Can format for logging vs display
 * - Reusability: Same formatting in different contexts
 */
export function formatError(
  error: unknown,
  options: ErrorHandlerOptions = {}
): string {
  const { verbose = false, json = false } = options;

  // Handle CLIError with full context
  if (error instanceof CLIError) {
    if (json) {
      const output: ErrorOutput = {
        error: error.message,
        code: error.code,
        hint: error.hint,
        stack: verbose ? error.stack : undefined,
      };
      return JSON.stringify(output, null, 2);
    }

    // Build formatted output
    const lines: string[] = [];
    lines.push(chalk.red('Error: ') + error.message);

    if (error.hint) {
      lines.push(chalk.dim('Hint: ') + error.hint);
    }

    if (verbose && error.stack) {
      lines.push('');
      lines.push(chalk.dim('Stack trace:'));
      lines.push(chalk.dim(error.stack));
    }

    return lines.join('\n');
  }

  // Handle standard Error
  if (error instanceof Error) {
    if (json) {
      const output: ErrorOutput = {
        error: error.message,
        code: 1,
        stack: verbose ? error.stack : undefined,
      };
      return JSON.stringify(output, null, 2);
    }

    const lines: string[] = [];
    lines.push(chalk.red('Error: ') + error.message);

    if (verbose && error.stack) {
      lines.push('');
      lines.push(chalk.dim('Stack trace:'));
      lines.push(chalk.dim(error.stack));
    } else {
      lines.push(chalk.dim('Hint: ') + 'Run with --verbose for more details');
    }

    return lines.join('\n');
  }

  // Handle unknown error types (string, number, etc.)
  if (json) {
    return JSON.stringify({ error: String(error), code: 1 }, null, 2);
  }

  return chalk.red('Error: ') + String(error);
}

/**
 * Get the exit code for an error.
 *
 * CLIError has a specific code, everything else is 1.
 */
export function getExitCode(error: unknown): number {
  if (error instanceof CLIError) {
    return error.code;
  }
  return 1;
}

/**
 * Handle an error by formatting and exiting.
 *
 * This is the main entry point for error handling.
 * It formats the error, outputs it, and exits with the appropriate code.
 *
 * Why use `never` return type?
 * - Tells TypeScript this function never returns normally
 * - Helps with control flow analysis (code after is unreachable)
 */
export function handleError(
  error: unknown,
  options: ErrorHandlerOptions = {}
): never {
  const formatted = formatError(error, options);
  const code = getExitCode(error);

  // Use stderr for errors (stdout is for normal output)
  console.error(formatted);

  process.exit(code);
}

/**
 * Create a global error handler that can be attached to process events.
 *
 * Usage:
 *   const handler = createGlobalErrorHandler({ verbose: true });
 *   process.on('uncaughtException', handler);
 *   process.on('unhandledRejection', handler);
 *
 * Why wrap in a closure?
 * - Captures options at setup time
 * - Event handlers only receive the error argument
 */
export function createGlobalErrorHandler(
  options: ErrorHandlerOptions = {}
): (error: unknown) => never {
  return (error: unknown) => handleError(error, options);
}
