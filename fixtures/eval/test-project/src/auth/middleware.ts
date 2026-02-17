/**
 * Authentication Middleware
 *
 * Verifies JWT tokens from the Authorization header.
 * Attaches decoded user payload to the request on success.
 * Returns 401 Unauthorized on missing or invalid tokens.
 */

import jwt from 'jsonwebtoken';
import { loadConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';

import type { Request, Response, NextFunction } from 'express';

interface AuthPayload {
  userId: number;
  email: string;
}

/**
 * Express middleware that validates JWT bearer tokens.
 *
 * Expects header: Authorization: Bearer <token>
 * On success, sets req.user with { userId, email }.
 * On failure, responds with 401 and error message.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const config = loadConfig();
    const payload = jwt.verify(token, config.jwtSecret) as AuthPayload;
    (req as any).user = payload;
    next();
  } catch (error) {
    logger.warn(`JWT verification failed: ${(error as Error).message}`);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
