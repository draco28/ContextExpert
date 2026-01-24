/**
 * Error handling module for Context_Expert CLI
 *
 * This module exports:
 * - Custom error classes for different error types
 * - Error formatting and handling utilities
 *
 * Usage:
 *   import { ConfigError, handleError } from './errors/index.js';
 *
 *   throw new ConfigError('Invalid option', 'Try: ctx config list');
 */

// Error types
export {
  CLIError,
  FileNotFoundError,
  ConfigError,
  APIKeyError,
  DatabaseError,
  ValidationError,
  NotImplementedError,
} from './types.js';

// Error handling utilities
export {
  formatError,
  getExitCode,
  handleError,
  createGlobalErrorHandler,
  type ErrorHandlerOptions,
  type ErrorOutput,
} from './handler.js';
