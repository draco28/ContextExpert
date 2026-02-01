/**
 * Integration Test Setup
 *
 * Shared utilities for CLI integration tests that use real SQLite databases.
 *
 * Key concepts:
 * 1. Path Mocking - Override the paths module to redirect database/config
 *    to temp directories, preventing tests from touching ~/.ctx
 * 2. Temp Directory Management - Each test suite creates its own temp directory
 *    that is cleaned up after tests
 * 3. Singleton Reset - Clear cached singletons between tests to ensure
 *    each test starts with fresh state
 * 4. Mock Embedding Provider - Only mock external API calls, use real
 *    database and file system operations
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EmbeddingProvider, EmbeddingResult } from '../../../indexer/embedder/types.js';
import type Database from 'better-sqlite3';

// ============================================================================
// Types
// ============================================================================

/**
 * Sample file to create in a test project.
 */
export interface SampleFile {
  /** Relative path within the project */
  path: string;
  /** File content */
  content: string;
}

// ============================================================================
// Sample Project Fixtures
// ============================================================================

/**
 * Default sample files for a TypeScript project.
 *
 * These files are designed to:
 * 1. Be realistic enough to test the full indexing pipeline
 * 2. Contain distinctive content for search testing
 * 3. Cover different file types (TypeScript, Markdown)
 */
export const DEFAULT_SAMPLE_FILES: SampleFile[] = [
  {
    path: 'src/index.ts',
    content: `/**
 * Main entry point for the application.
 * Exports the core API for user authentication.
 */

export { authenticate } from './auth.js';
export { validateToken } from './token.js';
export type { User, AuthConfig } from './types.js';
`,
  },
  {
    path: 'src/auth.ts',
    content: `/**
 * Authentication module - handles user login and session management.
 */

import type { User, AuthConfig } from './types.js';
import { validateToken } from './token.js';

/**
 * Authenticate a user with email and password.
 *
 * @param email - User's email address
 * @param password - User's password (will be hashed)
 * @returns Authenticated user object or null if auth fails
 */
export async function authenticate(
  email: string,
  password: string,
  config?: AuthConfig
): Promise<User | null> {
  // Hash password and check against stored hash
  const hashedPassword = await hashPassword(password);

  // Query database for user
  const user = await findUserByEmail(email);

  if (!user || user.passwordHash !== hashedPassword) {
    return null;
  }

  return user;
}

async function hashPassword(password: string): Promise<string> {
  // Simulated password hashing
  return 'hashed_' + password;
}

async function findUserByEmail(email: string): Promise<User | null> {
  // Simulated database query
  return null;
}
`,
  },
  {
    path: 'src/token.ts',
    content: `/**
 * Token validation and management.
 */

/**
 * Validate a JWT access token.
 *
 * @param token - The JWT token string to validate
 * @returns True if token is valid and not expired
 */
export function validateToken(token: string): boolean {
  if (!token || token.length < 10) {
    return false;
  }

  // Check token format (simplified)
  const parts = token.split('.');
  if (parts.length !== 3) {
    return false;
  }

  // Check expiration
  try {
    const payload = JSON.parse(atob(parts[1]));
    return payload.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

/**
 * Generate a new access token for a user.
 */
export function generateToken(userId: string, expiresIn: number = 3600): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + expiresIn,
  }));
  const signature = btoa('fake-signature');

  return \`\${header}.\${payload}.\${signature}\`;
}
`,
  },
  {
    path: 'src/types.ts',
    content: `/**
 * Type definitions for the authentication system.
 */

/**
 * Represents an authenticated user.
 */
export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Configuration options for authentication.
 */
export interface AuthConfig {
  /** Token expiration time in seconds */
  tokenExpiry?: number;
  /** Enable refresh token rotation */
  rotateRefreshTokens?: boolean;
  /** Minimum password length */
  minPasswordLength?: number;
}

/**
 * Result of a login attempt.
 */
export interface LoginResult {
  success: boolean;
  user?: User;
  accessToken?: string;
  refreshToken?: string;
  error?: string;
}
`,
  },
  {
    path: 'README.md',
    content: `# Sample Authentication Project

A simple authentication library for testing the CLI indexer.

## Features

- User authentication with email/password
- JWT token validation
- Session management

## Usage

\`\`\`typescript
import { authenticate, validateToken } from './src/index.js';

const user = await authenticate('user@example.com', 'password123');
if (user) {
  console.log('Logged in as:', user.name);
}
\`\`\`
`,
  },
];

/**
 * Create a sample project with TypeScript files for testing.
 *
 * @param projectDir - Directory to create the project in
 * @param files - Optional custom files (defaults to DEFAULT_SAMPLE_FILES)
 */
export function createSampleProject(
  projectDir: string,
  files: SampleFile[] = DEFAULT_SAMPLE_FILES
): void {
  for (const file of files) {
    const filePath = join(projectDir, file.path);
    const dir = join(filePath, '..');

    // Ensure parent directory exists
    mkdirSync(dir, { recursive: true });

    // Write the file
    writeFileSync(filePath, file.content, 'utf-8');
  }
}

// ============================================================================
// Mock Embedding Provider
// ============================================================================

/**
 * Create a deterministic mock embedding provider.
 *
 * Why mock only the embedding provider?
 * - External API calls are slow and require credentials
 * - Embeddings don't need to be semantically meaningful for integration tests
 * - We verify the database stores and retrieves them correctly
 *
 * The mock uses a hash-based approach to generate consistent embeddings
 * for the same text input, which allows search tests to work predictably.
 *
 * @param dimensions - Embedding dimensions (default: 1024 to match BGE-large)
 */
export function createMockEmbeddingProvider(dimensions: number = 1024): EmbeddingProvider {
  /**
   * Generate a deterministic embedding from text.
   *
   * Uses the sum of character codes as a seed, then generates
   * a vector using sin() for smooth, bounded values in [-0.5, 0.5].
   */
  const generateEmbedding = (text: string): Float32Array => {
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const embedding = new Float32Array(dimensions);

    for (let i = 0; i < dimensions; i++) {
      // Use sin() for values in [-1, 1], scale to [-0.5, 0.5]
      embedding[i] = Math.sin(hash + i) * 0.5;
    }

    return embedding;
  };

  return {
    name: 'MockEmbeddingProvider',
    dimensions,
    maxBatchSize: 32,

    async embed(text: string): Promise<EmbeddingResult> {
      return {
        embedding: generateEmbedding(text),
        tokenCount: text.split(/\s+/).length,
      };
    },

    async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
      return texts.map((text) => ({
        embedding: generateEmbedding(text),
        tokenCount: text.split(/\s+/).length,
      }));
    },
  };
}

// ============================================================================
// Database Verification Helpers
// ============================================================================

/**
 * Verify a project exists in the database and return it.
 *
 * @param db - better-sqlite3 Database instance
 * @param name - Project name to look up
 */
export function getProjectFromDb(
  db: Database.Database,
  name: string
): { id: string; name: string; path: string; chunk_count: number; file_count: number } | undefined {
  return db
    .prepare('SELECT id, name, path, chunk_count, file_count FROM projects WHERE name = ?')
    .get(name) as { id: string; name: string; path: string; chunk_count: number; file_count: number } | undefined;
}

/**
 * Count chunks for a project in the database.
 *
 * @param db - better-sqlite3 Database instance
 * @param projectId - Project ID to count chunks for
 */
export function countChunksInDb(db: Database.Database, projectId: string): number {
  const result = db
    .prepare('SELECT COUNT(*) as count FROM chunks WHERE project_id = ?')
    .get(projectId) as { count: number };
  return result.count;
}

/**
 * Get all chunk contents for a project (for search verification).
 *
 * @param db - better-sqlite3 Database instance
 * @param projectId - Project ID
 */
export function getChunkContents(db: Database.Database, projectId: string): string[] {
  const rows = db
    .prepare('SELECT content FROM chunks WHERE project_id = ?')
    .all(projectId) as Array<{ content: string }>;
  return rows.map((r) => r.content);
}
