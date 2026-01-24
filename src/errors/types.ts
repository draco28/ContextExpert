/**
 * Error type definitions for Context_Expert CLI
 *
 * These custom error classes provide:
 * - Actionable error messages with recovery hints
 * - Exit codes for programmatic error handling
 * - Type safety for error handling logic
 */

/**
 * Base class for all CLI errors.
 *
 * Why extend Error?
 * - Inherits stack trace generation
 * - Works with try/catch and instanceof checks
 * - Can be thrown like any Error
 *
 * Why add hint and code?
 * - hint: Tells the user HOW to fix the problem
 * - code: Allows scripts to handle different errors differently
 */
export class CLIError extends Error {
  /** Recovery suggestion shown to the user */
  public readonly hint?: string;

  /** Exit code (1-255, 0 is reserved for success) */
  public readonly code: number;

  constructor(message: string, hint?: string, code: number = 1) {
    super(message);
    // This is required for proper instanceof checks after transpilation
    // Without it, `error instanceof CLIError` might fail
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'CLIError';
    this.hint = hint;
    this.code = code;
  }
}

/**
 * Thrown when a file or directory doesn't exist.
 *
 * Exit code 3: File not found (following common Unix conventions)
 */
export class FileNotFoundError extends CLIError {
  constructor(path: string) {
    super(
      `Path does not exist: ${path}`,
      'Check the path and try again',
      3
    );
    this.name = 'FileNotFoundError';
  }
}

/**
 * Thrown for configuration-related errors.
 *
 * Examples:
 * - Invalid TOML syntax
 * - Missing required config values
 * - Invalid config option names
 *
 * Exit code 2: Configuration error
 */
export class ConfigError extends CLIError {
  constructor(message: string, hint?: string) {
    super(
      message,
      hint ?? 'Run: ctx config list  to see valid options',
      2
    );
    this.name = 'ConfigError';
  }
}

/**
 * Thrown when an API key is missing or invalid.
 *
 * Why a dedicated error class?
 * - API key issues are common and confusing
 * - The hint can show the exact env var to set
 *
 * Exit code 4: API key error
 */
export class APIKeyError extends CLIError {
  constructor(provider: string, envVar?: string) {
    const envVarName = envVar ?? `${provider.toUpperCase()}_API_KEY`;
    super(
      `${provider} API key not configured`,
      `Set the ${envVarName} environment variable or run: ctx config set llm.apiKey <key>`,
      4
    );
    this.name = 'APIKeyError';
  }
}

/**
 * Thrown for database-related errors.
 *
 * Wraps SQLite errors with user-friendly messages.
 *
 * Exit code 5: Database error
 */
export class DatabaseError extends CLIError {
  /** The original database error for debugging */
  public readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(
      message,
      'Try running: ctx status  to check database health',
      5
    );
    this.name = 'DatabaseError';
    this.cause = cause;
  }
}

/**
 * Thrown when input validation fails.
 *
 * Used with Zod schemas to provide detailed field-level errors.
 *
 * Exit code 1: General error (validation is user input error)
 */
export class ValidationError extends CLIError {
  /** Individual validation issues */
  public readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    const hint =
      issues.length > 0
        ? `Issues:\n  ${issues.join('\n  ')}`
        : 'Check your input and try again';
    super(message, hint, 1);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/**
 * Thrown when a command or feature is not implemented.
 *
 * Useful during development to mark placeholder commands.
 *
 * Exit code 1: General error
 */
export class NotImplementedError extends CLIError {
  constructor(feature: string) {
    super(
      `${feature} is not yet implemented`,
      'This feature is coming soon',
      1
    );
    this.name = 'NotImplementedError';
  }
}
