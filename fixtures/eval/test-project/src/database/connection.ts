/**
 * Database Connection
 *
 * Singleton pattern for SQLite database access.
 * Initializes schema on first connection using CREATE_TABLES_SQL.
 */

import Database from 'better-sqlite3';
import { loadConfig } from '../config/index.js';
import { CREATE_TABLES_SQL } from './schema.js';
import { logger } from '../utils/logger.js';

let db: Database.Database | null = null;

/**
 * Get or create the database connection.
 *
 * On first call, opens the SQLite file and runs schema migrations.
 * Subsequent calls return the cached connection.
 *
 * @returns SQLite database instance
 */
export function getDatabase(): Database.Database {
  if (db) return db;

  const config = loadConfig();
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(CREATE_TABLES_SQL);

  logger.info(`Database connected at ${config.dbPath}`);
  return db;
}

/**
 * Close the database connection.
 * Used during graceful shutdown.
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}
