/**
 * API Router
 *
 * Central routing configuration for the Express application.
 * Mounts authentication and user management endpoints.
 * Applies JWT middleware to protected routes.
 */

import express from 'express';
import { authMiddleware } from '../auth/middleware.js';
import { handleLogin } from '../auth/login.js';
import { listUsers, getUser, createUser, deleteUser } from './users.js';
import { logger } from '../utils/logger.js';
import { loadConfig } from '../config/index.js';

const app = express();
app.use(express.json());

// Public routes (no auth required)
app.post('/login', handleLogin);

// Protected routes (JWT required)
app.get('/users', authMiddleware, listUsers);
app.get('/users/:id', authMiddleware, getUser);
app.post('/users', authMiddleware, createUser);
app.delete('/users/:id', authMiddleware, deleteUser);

// Start server
const config = loadConfig();
app.listen(config.port, () => {
  logger.info(`Server running on port ${config.port}`);
});

export default app;
