/**
 * Logger Interface for Library Code
 *
 * This provides a generic logging interface that library code can accept
 * via dependency injection. The CLI layer can pass CommandContext-backed
 * implementations, while tests can pass mock loggers.
 *
 * This separates concerns:
 * - Library code: Uses generic Logger interface
 * - CLI code: Uses CommandContext (which satisfies Logger)
 * - Test code: Uses mock or silent loggers
 */

/**
 * Generic logger interface for library code
 *
 * Designed to be compatible with CommandContext so you can pass ctx directly.
 */
export interface Logger {
  /** Log a warning message */
  warn: (message: string) => void;
  /** Log a debug message (optional - not all contexts need debug) */
  debug?: (message: string) => void;
}

/**
 * Default console logger for use when no logger is injected.
 * Falls back to console.warn/console.log for backward compatibility.
 */
export const consoleLogger: Logger = {
  warn: (message: string) => console.warn(message),
  debug: (message: string) => console.log(message),
};

/**
 * Silent logger for tests or when logging should be suppressed.
 */
export const silentLogger: Logger = {
  warn: () => {},
  debug: () => {},
};
