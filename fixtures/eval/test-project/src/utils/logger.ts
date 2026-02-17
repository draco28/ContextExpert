/**
 * Simple Logging Utility
 *
 * Provides structured logging with configurable log levels.
 * Formats messages with ISO timestamps for debugging.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function formatMessage(level: LogLevel, message: string): string {
  return `[${new Date().toISOString()}] ${level.toUpperCase()}: ${message}`;
}

export const logger = {
  setLevel(level: LogLevel): void {
    currentLevel = level;
  },

  debug(message: string): void {
    if (shouldLog('debug')) console.debug(formatMessage('debug', message));
  },

  info(message: string): void {
    if (shouldLog('info')) console.info(formatMessage('info', message));
  },

  warn(message: string): void {
    if (shouldLog('warn')) console.warn(formatMessage('warn', message));
  },

  error(message: string): void {
    if (shouldLog('error')) console.error(formatMessage('error', message));
  },
};
