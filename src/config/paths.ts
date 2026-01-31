/**
 * Centralized Path Definitions
 *
 * Single source of truth for all ctx directory paths.
 * All modules should import from here instead of computing paths locally.
 *
 * Directory structure:
 * ~/.ctx/
 * ├── context.db      (SQLite database)
 * ├── config.toml     (User configuration)
 * └── providers.json  (LLM provider configs)
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

// Core path constants - the single source of truth
export const CTX_DIR = join(homedir(), '.ctx');
export const DB_PATH = join(CTX_DIR, 'context.db');
export const CONFIG_PATH = join(CTX_DIR, 'config.toml');
export const PROVIDERS_PATH = join(CTX_DIR, 'providers.json');

/**
 * Get the ctx directory path (~/.ctx)
 * @returns Absolute path to the ctx directory
 */
export function getCtxDir(): string {
  return CTX_DIR;
}

/**
 * Get the database file path (~/.ctx/context.db)
 * @returns Absolute path to the SQLite database
 */
export function getDbPath(): string {
  return DB_PATH;
}

/**
 * Get the config file path (~/.ctx/config.toml)
 * @returns Absolute path to the TOML config file
 */
export function getConfigPath(): string {
  return CONFIG_PATH;
}

/**
 * Get the providers file path (~/.ctx/providers.json)
 * @returns Absolute path to the providers JSON file
 */
export function getProvidersPath(): string {
  return PROVIDERS_PATH;
}
