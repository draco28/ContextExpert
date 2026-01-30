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

// Path constants (for direct access without function call)
export { CTX_DIR, DB_PATH, CONFIG_PATH } from './paths.js';

// Environment variables
export {
  loadEnv,
  getEnv,
  hasApiKey,
  getOllamaHost,
  SETUP_INSTRUCTIONS,
  EnvSchema,
  _clearEnvCache,
} from './env.js';
export type { EnvVars } from './env.js';

// Startup validation
export {
  validateStartupConfig,
  printStartupValidation,
  getValidationOptionsForCommand,
  COMMANDS_REQUIRING_LLM,
  COMMANDS_REQUIRING_EMBEDDING,
} from './startup-validation.js';
export type {
  StartupValidationResult,
  StartupValidationOptions,
} from './startup-validation.js';
