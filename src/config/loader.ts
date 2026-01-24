/**
 * Configuration Loader
 *
 * Handles the complete config lifecycle:
 * 1. Find/create config directory (~/.ctx)
 * 2. Load config.toml if it exists
 * 3. Validate with Zod schema
 * 4. Merge with defaults (user values override defaults)
 * 5. Provide type-safe access
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import TOML from '@iarna/toml';
import { ConfigSchema, PartialConfigSchema, type Config, type PartialConfig } from './schema.js';
import { DEFAULT_CONFIG, CONFIG_TEMPLATE } from './defaults.js';
import { ConfigError } from '../errors/index.js';

/**
 * Get the ctx directory path (~/.ctx)
 * This is the same function used by the database module
 */
export function getCtxDir(): string {
  return path.join(os.homedir(), '.ctx');
}

/**
 * Get the config file path (~/.ctx/config.toml)
 */
export function getConfigPath(): string {
  return path.join(getCtxDir(), 'config.toml');
}

/**
 * Ensure the ~/.ctx directory exists
 */
function ensureCtxDir(): void {
  const ctxDir = getCtxDir();
  if (!fs.existsSync(ctxDir)) {
    fs.mkdirSync(ctxDir, { recursive: true });
  }
}

/**
 * Deep merge two objects, with source values overriding target
 * This handles nested objects properly (unlike Object.assign or spread)
 */
function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceValue = source[key];
    const targetValue = target[key];

    // If both values are objects (not arrays, not null), recurse
    if (
      sourceValue !== undefined &&
      sourceValue !== null &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === 'object' &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      ) as T[keyof T];
    } else if (sourceValue !== undefined) {
      // Direct assignment for primitives or when source has a value
      result[key] = sourceValue as T[keyof T];
    }
  }

  return result;
}

/**
 * Load and parse the config file
 * Returns the merged config (defaults + user overrides)
 *
 * @param createIfMissing - If true, creates default config on first run
 * @throws Error if config file exists but is invalid
 */
export function loadConfig(createIfMissing = true): Config {
  const configPath = getConfigPath();

  // If config doesn't exist, either create it or just use defaults
  if (!fs.existsSync(configPath)) {
    if (createIfMissing) {
      ensureCtxDir();
      fs.writeFileSync(configPath, CONFIG_TEMPLATE, 'utf-8');
    }
    return { ...DEFAULT_CONFIG };
  }

  // Read and parse the TOML file
  const content = fs.readFileSync(configPath, 'utf-8');
  let parsed: unknown;

  try {
    parsed = TOML.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown parse error';
    throw new ConfigError(
      `Invalid TOML in config file: ${message}`,
      `Fix the syntax in ${configPath} or run: ctx config reset --force`
    );
  }

  // Validate against the partial schema (allows missing fields)
  const validationResult = PartialConfigSchema.safeParse(parsed);

  if (!validationResult.success) {
    const issues = validationResult.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(
      `Invalid configuration:\n${issues}`,
      'Run: ctx config reset --force  to restore defaults'
    );
  }

  // Merge user config with defaults
  const userConfig = validationResult.data as PartialConfig;
  return deepMerge(DEFAULT_CONFIG, userConfig as Partial<Config>);
}

/**
 * Get a specific config value by dot-notation path
 * Example: getConfigValue('embedding.model') => 'BAAI/bge-large-en-v1.5'
 */
export function getConfigValue(key: string): unknown {
  const config = loadConfig();
  const parts = key.split('.');

  let current: unknown = config;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Set a specific config value by dot-notation path
 * Writes the change back to the config file
 */
export function setConfigValue(key: string, value: string): void {
  const configPath = getConfigPath();
  ensureCtxDir();

  // Load existing config or start fresh
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf-8');
    config = TOML.parse(content) as Record<string, unknown>;
  }

  // Parse the value (try to convert to appropriate type)
  const parsedValue = parseValue(value);

  // Set the value at the nested path
  const parts = key.split('.');
  if (parts.length === 0) {
    throw new ConfigError(
      'Invalid config key: empty key',
      'Run: ctx config list  to see available keys'
    );
  }

  let current = config;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!; // Safe: loop bounds guarantee valid index
    if (!(part in current) || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  const lastPart = parts[parts.length - 1]!; // Safe: we checked length > 0
  current[lastPart] = parsedValue;

  // Validate the complete config before saving
  const merged = deepMerge(DEFAULT_CONFIG, config as Partial<Config>);
  const validationResult = ConfigSchema.safeParse(merged);

  if (!validationResult.success) {
    const issues = validationResult.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(
      `Invalid value for '${key}':\n${issues}`,
      'Run: ctx config list  to see current values and types'
    );
  }

  // Write back to file
  const tomlContent = TOML.stringify(config as TOML.JsonMap);
  fs.writeFileSync(configPath, tomlContent, 'utf-8');
}

/**
 * Parse a string value into the appropriate type
 * Handles booleans, numbers, and strings
 */
function parseValue(value: string): unknown {
  // Boolean
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;

  // Number
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') return num;

  // String (default)
  return value;
}

/**
 * List all config values in a flat format
 * Returns entries like ['default_model', 'claude-sonnet-4-20250514']
 */
export function listConfig(): Array<[string, unknown]> {
  const config = loadConfig();
  const entries: Array<[string, unknown]> = [];

  function flatten(obj: Record<string, unknown>, prefix = ''): void {
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        flatten(value as Record<string, unknown>, fullKey);
      } else {
        entries.push([fullKey, value]);
      }
    }
  }

  flatten(config);
  return entries;
}
