/**
 * Application Configuration
 *
 * Loads config from environment variables with sensible defaults.
 * Used by database connection, auth middleware, and server startup.
 */

export interface Config {
  port: number;
  dbPath: string;
  jwtSecret: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

let cachedConfig: Config | null = null;

/**
 * Load application configuration from environment variables.
 *
 * @returns Validated config object
 * @throws Error if JWT_SECRET is not set
 */
export function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('JWT_SECRET environment variable is required');
  }

  cachedConfig = {
    port: parseInt(process.env.PORT ?? '3000', 10),
    dbPath: process.env.DB_PATH ?? './data.db',
    jwtSecret,
    logLevel: (process.env.LOG_LEVEL as Config['logLevel']) ?? 'info',
  };

  return cachedConfig;
}
