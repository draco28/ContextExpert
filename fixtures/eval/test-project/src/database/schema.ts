/**
 * Database Schema
 *
 * SQLite table definitions for users and sessions.
 * Provides TypeScript interfaces matching each table's columns.
 */

export const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
`;

export interface User {
  id: number;
  email: string;
  password_hash: string;
  name: string;
  created_at: string;
}

export interface Session {
  id: string;
  user_id: number;
  token: string;
  expires_at: string;
  created_at: string;
}
