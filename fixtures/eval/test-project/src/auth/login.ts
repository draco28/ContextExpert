/**
 * Login Handler
 *
 * Authenticates users with email and password.
 * Uses bcrypt for secure password comparison and JWT for token generation.
 */

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { loadConfig } from '../config/index.js';
import { getDatabase } from '../database/connection.js';
import { logger } from '../utils/logger.js';

import type { Request, Response } from 'express';
import type { User } from '../database/schema.js';

/**
 * Handle POST /login requests.
 *
 * Validates email/password credentials against the database.
 * Returns a signed JWT token on success (expires in 24 hours).
 * Returns 401 on invalid credentials, 400 on missing fields.
 */
export async function handleLogin(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  const db = getDatabase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as User | undefined;

  if (!user) {
    logger.warn(`Login attempt for unknown email: ${email}`);
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const passwordValid = await bcrypt.compare(password, user.password_hash);

  if (!passwordValid) {
    logger.warn(`Failed login attempt for: ${email}`);
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const config = loadConfig();
  const token = jwt.sign(
    { userId: user.id, email: user.email },
    config.jwtSecret,
    { expiresIn: '24h' }
  );

  logger.info(`User logged in: ${email}`);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
}
