/**
 * Global CLI options available to all commands
 * These are parsed at the root level and passed down to subcommands
 */
export interface GlobalOptions {
  /** Enable verbose output for debugging */
  verbose: boolean;
  /** Output results as JSON instead of human-readable text */
  json: boolean;
}

/**
 * Context passed to all command handlers
 * Combines parsed options with runtime utilities
 */
export interface CommandContext {
  options: GlobalOptions;
  /** Log a message (respects --json flag) */
  log: (message: string) => void;
  /** Log a debug message (only shown with --verbose) */
  debug: (message: string) => void;
  /** Log an error message */
  error: (message: string) => void;
}
