/**
 * Tests for error handling system
 *
 * Tests cover:
 * - Error class instantiation and properties
 * - Error formatting (text and JSON)
 * - Exit code extraction
 * - Verbose mode (stack traces)
 */

import { describe, it, expect } from 'vitest';
import {
  CLIError,
  FileNotFoundError,
  ConfigError,
  APIKeyError,
  DatabaseError,
  ValidationError,
  NotImplementedError,
  formatError,
  getExitCode,
} from '../index.js';

describe('Error Classes', () => {
  describe('CLIError', () => {
    it('creates error with message only', () => {
      const error = new CLIError('Something went wrong');

      expect(error.message).toBe('Something went wrong');
      expect(error.hint).toBeUndefined();
      expect(error.code).toBe(1);
      expect(error.name).toBe('CLIError');
    });

    it('creates error with message and hint', () => {
      const error = new CLIError('Something went wrong', 'Try this instead');

      expect(error.message).toBe('Something went wrong');
      expect(error.hint).toBe('Try this instead');
      expect(error.code).toBe(1);
    });

    it('creates error with custom exit code', () => {
      const error = new CLIError('Critical failure', 'Reboot', 99);

      expect(error.code).toBe(99);
    });

    it('is instanceof Error', () => {
      const error = new CLIError('test');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(CLIError);
    });

    it('has stack trace', () => {
      const error = new CLIError('test');

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('CLIError');
    });
  });

  describe('FileNotFoundError', () => {
    it('creates error with path', () => {
      const error = new FileNotFoundError('/path/to/file');

      expect(error.message).toBe('Path does not exist: /path/to/file');
      expect(error.hint).toBe('Check the path and try again');
      expect(error.code).toBe(3);
      expect(error.name).toBe('FileNotFoundError');
    });

    it('is instanceof CLIError', () => {
      const error = new FileNotFoundError('/test');

      expect(error).toBeInstanceOf(CLIError);
      expect(error).toBeInstanceOf(FileNotFoundError);
    });
  });

  describe('ConfigError', () => {
    it('creates error with default hint', () => {
      const error = new ConfigError('Invalid option');

      expect(error.message).toBe('Invalid option');
      expect(error.hint).toBe('Run: ctx config list  to see valid options');
      expect(error.code).toBe(2);
      expect(error.name).toBe('ConfigError');
    });

    it('creates error with custom hint', () => {
      const error = new ConfigError('Invalid option', 'Custom hint');

      expect(error.hint).toBe('Custom hint');
    });
  });

  describe('APIKeyError', () => {
    it('creates error with provider name', () => {
      const error = new APIKeyError('OpenAI');

      expect(error.message).toBe('OpenAI API key not configured');
      expect(error.hint).toContain('OPENAI_API_KEY');
      expect(error.code).toBe(4);
      expect(error.name).toBe('APIKeyError');
    });

    it('creates error with custom env var', () => {
      const error = new APIKeyError('Anthropic', 'CLAUDE_API_KEY');

      expect(error.hint).toContain('CLAUDE_API_KEY');
    });
  });

  describe('DatabaseError', () => {
    it('creates error with message', () => {
      const error = new DatabaseError('Connection failed');

      expect(error.message).toBe('Connection failed');
      expect(error.hint).toContain('ctx status');
      expect(error.code).toBe(5);
      expect(error.name).toBe('DatabaseError');
    });

    it('stores cause error', () => {
      const cause = new Error('SQLITE_BUSY');
      const error = new DatabaseError('Database locked', cause);

      expect(error.cause).toBe(cause);
    });
  });

  describe('ValidationError', () => {
    it('creates error with issues', () => {
      const error = new ValidationError('Invalid input', [
        'name: Required',
        'age: Must be positive',
      ]);

      expect(error.message).toBe('Invalid input');
      expect(error.hint).toContain('name: Required');
      expect(error.hint).toContain('age: Must be positive');
      expect(error.issues).toHaveLength(2);
      expect(error.code).toBe(1);
      expect(error.name).toBe('ValidationError');
    });

    it('creates error without issues', () => {
      const error = new ValidationError('Invalid input');

      expect(error.hint).toBe('Check your input and try again');
      expect(error.issues).toHaveLength(0);
    });
  });

  describe('NotImplementedError', () => {
    it('creates error for feature', () => {
      const error = new NotImplementedError('Export to PDF');

      expect(error.message).toBe('Export to PDF is not yet implemented');
      expect(error.hint).toBe('This feature is coming soon');
      expect(error.code).toBe(1);
      expect(error.name).toBe('NotImplementedError');
    });
  });
});

describe('formatError', () => {
  describe('text output', () => {
    it('formats CLIError with hint', () => {
      const error = new CLIError('Failed', 'Try again');
      const output = formatError(error);

      expect(output).toContain('Error:');
      expect(output).toContain('Failed');
      expect(output).toContain('Hint:');
      expect(output).toContain('Try again');
    });

    it('formats CLIError without hint', () => {
      const error = new CLIError('Failed');
      const output = formatError(error);

      expect(output).toContain('Error:');
      expect(output).toContain('Failed');
      expect(output).not.toContain('Hint:');
    });

    it('formats standard Error with verbose hint', () => {
      const error = new Error('Something broke');
      const output = formatError(error);

      expect(output).toContain('Error:');
      expect(output).toContain('Something broke');
      expect(output).toContain('--verbose');
    });

    it('shows stack trace in verbose mode', () => {
      const error = new CLIError('Failed', 'Try again');
      const output = formatError(error, { verbose: true });

      expect(output).toContain('Stack trace:');
      expect(output).toContain('CLIError');
    });

    it('formats unknown error types', () => {
      const output = formatError('string error');

      expect(output).toContain('Error:');
      expect(output).toContain('string error');
    });
  });

  describe('JSON output', () => {
    it('formats CLIError as JSON', () => {
      const error = new ConfigError('Bad config', 'Fix it');
      const output = formatError(error, { json: true });
      const parsed = JSON.parse(output);

      expect(parsed.error).toBe('Bad config');
      expect(parsed.code).toBe(2);
      expect(parsed.hint).toBe('Fix it');
      expect(parsed.stack).toBeUndefined();
    });

    it('includes stack in JSON verbose mode', () => {
      const error = new CLIError('Failed');
      const output = formatError(error, { json: true, verbose: true });
      const parsed = JSON.parse(output);

      expect(parsed.stack).toBeDefined();
      expect(parsed.stack).toContain('CLIError');
    });

    it('formats standard Error as JSON', () => {
      const error = new Error('Oops');
      const output = formatError(error, { json: true });
      const parsed = JSON.parse(output);

      expect(parsed.error).toBe('Oops');
      expect(parsed.code).toBe(1);
    });

    it('formats unknown error as JSON', () => {
      const output = formatError(42, { json: true });
      const parsed = JSON.parse(output);

      expect(parsed.error).toBe('42');
      expect(parsed.code).toBe(1);
    });
  });
});

describe('getExitCode', () => {
  it('returns code from CLIError', () => {
    expect(getExitCode(new CLIError('test', undefined, 42))).toBe(42);
    expect(getExitCode(new FileNotFoundError('/x'))).toBe(3);
    expect(getExitCode(new ConfigError('bad'))).toBe(2);
    expect(getExitCode(new APIKeyError('OpenAI'))).toBe(4);
    expect(getExitCode(new DatabaseError('locked'))).toBe(5);
  });

  it('returns 1 for standard Error', () => {
    expect(getExitCode(new Error('test'))).toBe(1);
  });

  it('returns 1 for unknown types', () => {
    expect(getExitCode('string')).toBe(1);
    expect(getExitCode(null)).toBe(1);
    expect(getExitCode(undefined)).toBe(1);
  });
});
