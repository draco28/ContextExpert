/**
 * Config Module
 *
 * Exports for programmatic config access.
 * CLI users interact via `ctx config` commands.
 */

// Schema and types
export { ConfigSchema, PartialConfigSchema, EmbeddingConfigSchema, SearchConfigSchema } from './schema.js';
export type { Config, PartialConfig } from './schema.js';

// Defaults
export { DEFAULT_CONFIG, CONFIG_TEMPLATE } from './defaults.js';

// Loader functions
export {
  loadConfig,
  getConfigValue,
  setConfigValue,
  listConfig,
  getCtxDir,
  getConfigPath,
} from './loader.js';
