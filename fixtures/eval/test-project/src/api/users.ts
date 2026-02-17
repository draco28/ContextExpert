/**
 * User API Handlers
 *
 * REST CRUD operations for the /api/users endpoint.
 * All handlers require authentication via JWT middleware.
 */

import bcrypt from 'bcrypt';
import { getDatabase } from '../database/connection.js';
import { logger } from '../utils/logger.js';

import type { Request, Response } from 'express';
import type { User } from '../database/schema.js';

/** GET /users — List all users (excludes password_hash) */
export function listUsers(_req: Request, res: Response): void {
  const db = getDatabase();
  const users = db.prepare('SELECT id, email, name, created_at FROM users').all();
  res.json({ users });
}

/** GET /users/:id — Get a single user by ID */
export function getUser(req: Request, res: Response): void {
  const db = getDatabase();
  const user = db
    .prepare('SELECT id, email, name, created_at FROM users WHERE id = ?')
    .get(req.params.id) as Omit<User, 'password_hash'> | undefined;

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  res.json({ user });
}

/** POST /users — Create a new user */
export async function createUser(req: Request, res: Response): Promise<void> {
  const { email, name, password } = req.body;

  if (!email || !name || !password) {
    res.status(400).json({ error: 'email, name, and password are required' });
    return;
  }

  const password_hash = await bcrypt.hash(password, 10);

  const db = getDatabase();
  try {
    const result = db
      .prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)')
      .run(email, name, password_hash);

    logger.info(`User created: ${email} (id: ${result.lastInsertRowid})`);
    res.status(201).json({ id: result.lastInsertRowid, email, name });
  } catch (error) {
    if ((error as Error).message.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'Email already exists' });
    } else {
      throw error;
    }
  }
}

/** DELETE /users/:id — Delete a user by ID */
export function deleteUser(req: Request, res: Response): void {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);

  if (result.changes === 0) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  logger.info(`User deleted: id ${req.params.id}`);
  res.status(204).send();
}
