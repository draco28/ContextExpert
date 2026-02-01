/**
 * E2E Test Setup
 *
 * Extends the integration test setup with E2E-specific utilities:
 * - Mock LLM provider factory (deterministic responses with citations)
 * - Citation verification helpers (parse and validate [1], [2] references)
 * - Full workflow helpers
 *
 * Design Philosophy:
 * - Mock only I/O boundaries (embeddings, LLM)
 * - Use real database, filesystem, RAG engine
 * - Tests should be deterministic and fast
 */

import type { ChatMessage, TokenUsage, StreamChunk } from '@contextaisdk/core';
import type { RAGSource } from '../../agent/types.js';

// Re-export types needed by test files
export type { RAGSource };

// ============================================================================
// Re-export from Integration Setup
// ============================================================================

/**
 * Re-exports from the integration test setup.
 *
 * Design Note: E2E tests intentionally build on integration test utilities
 * rather than duplicating them. This creates a layered testing architecture:
 *
 *   Unit Tests → Integration Tests → E2E Tests
 *                      ↑                 ↑
 *                      └── setup.ts ─────┘
 *
 * Benefits:
 * - DRY: Sample project fixtures defined once
 * - Consistency: Same mock embedding provider across test layers
 * - Maintainability: Updates propagate automatically
 */
export {
  createSampleProject,
  createMockEmbeddingProvider,
  getProjectFromDb,
  countChunksInDb,
  getChunkContents,
  DEFAULT_SAMPLE_FILES,
  type SampleFile,
} from '../../cli/__tests__/integration/setup.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for the mock LLM provider.
 */
export interface MockLLMConfig {
  /**
   * Map of keyword patterns to responses.
   * If the user's question contains the keyword (case-insensitive),
   * the corresponding response is returned.
   */
  responses: Map<string, string>;

  /**
   * Default response when no pattern matches.
   */
  defaultResponse: string;

  /**
   * Simulated token usage for metadata verification.
   */
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Result from citation verification.
 */
export interface CitationVerification {
  /** Citation indices found in the response (e.g., [1], [2] → [1, 2]) */
  referencedIndices: number[];

  /** All source indices available from RAG result */
  availableSourceIndices: number[];

  /** True if all referenced citations exist in sources */
  allReferencesValid: boolean;

  /** Sources that were cited in the response */
  citedSources: RAGSource[];

  /** Sources that were NOT cited (available but unused) */
  uncitedSources: RAGSource[];

  /** Citation indices that don't map to any source (errors) */
  invalidReferences: number[];
}

/**
 * Mock LLM provider interface matching the real provider shape.
 */
export interface MockLLMProvider {
  chat: (
    messages: ChatMessage[],
    options?: { maxTokens?: number; temperature?: number }
  ) => Promise<{ content: string; usage?: TokenUsage }>;

  streamChat: (
    messages: ChatMessage[],
    options?: { maxTokens?: number; temperature?: number }
  ) => AsyncGenerator<StreamChunk>;
}

// ============================================================================
// Mock LLM Provider
// ============================================================================

/**
 * Default mock responses with embedded citations.
 *
 * These are designed to match the DEFAULT_SAMPLE_FILES content:
 * - auth.ts → authentication, login, password
 * - token.ts → token, JWT, validation
 * - types.ts → User, AuthConfig, interfaces
 */
export const DEFAULT_MOCK_RESPONSES = new Map<string, string>([
  [
    'authentication',
    `The authentication flow works as follows:

1. The \`authenticate\` function in auth.ts [1] takes email and password parameters
2. It hashes the password using an internal \`hashPassword\` function [1]
3. The user is looked up by email in the database [1]
4. If credentials match, the user object is returned

Token validation is handled separately by \`validateToken\` in token.ts [2].`,
  ],
  [
    'token',
    `Token validation is implemented in token.ts [1]:

- Tokens must be at least 10 characters long [1]
- They must have exactly 3 parts separated by dots (JWT format) [1]
- The payload is base64-decoded to extract the expiration time [1]
- If \`exp\` is greater than the current timestamp, the token is valid

You can generate new tokens using \`generateToken(userId, expiresIn)\` [1].`,
  ],
  [
    'user',
    `The User interface is defined in types.ts [1]:

\`\`\`typescript
interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}
\`\`\`

This represents an authenticated user in the system [1].`,
  ],
  [
    'password',
    `Password handling in the authentication module [1]:

1. Passwords are never stored in plaintext
2. The \`hashPassword\` function creates a hash [1]
3. During authentication, the input password is hashed and compared [1]

The minimum password length can be configured via \`AuthConfig.minPasswordLength\` [2].`,
  ],
]);

/**
 * Create a mock LLM provider with deterministic responses.
 *
 * The provider matches user questions against keyword patterns and returns
 * pre-defined responses with embedded citations. This allows testing the
 * full ask/chat flow without hitting real LLM APIs.
 *
 * @param config - Configuration with response patterns
 * @returns Mock provider with chat() and streamChat() methods
 *
 * @example
 * ```typescript
 * const provider = createMockLLMProvider({
 *   responses: DEFAULT_MOCK_RESPONSES,
 *   defaultResponse: 'I could not find relevant information.',
 * });
 *
 * const result = await provider.chat([
 *   { role: 'user', content: 'How does authentication work?' }
 * ]);
 * // Returns the 'authentication' response with [1], [2] citations
 * ```
 */
export function createMockLLMProvider(config: MockLLMConfig): MockLLMProvider {
  const defaultUsage: TokenUsage = config.tokenUsage ?? {
    promptTokens: 150,
    completionTokens: 100,
    totalTokens: 250,
  };

  /**
   * Find the best matching response for a question.
   * Checks each keyword pattern (case-insensitive) against the question.
   */
  const findResponse = (question: string): string => {
    const lowerQuestion = question.toLowerCase();

    for (const [keyword, response] of config.responses) {
      if (lowerQuestion.includes(keyword.toLowerCase())) {
        return response;
      }
    }

    return config.defaultResponse;
  };

  /**
   * Extract the user's question from the messages array.
   * Takes the last user message content.
   */
  const extractQuestion = (messages: ChatMessage[]): string => {
    const userMessages = messages.filter((m) => m.role === 'user');
    const lastUserMessage = userMessages[userMessages.length - 1];
    const content = lastUserMessage?.content;
    if (!content) return '';
    if (typeof content === 'string') return content;
    // Handle MessageContent[] - extract text from text parts
    const textParts = content.filter((p) => p.type === 'text');
    return textParts.map((p) => ('text' in p ? p.text : '')).join('\n');
  };

  return {
    /**
     * Non-streaming chat completion.
     * Used by ask command in --json mode.
     */
    async chat(
      messages: ChatMessage[],
      _options?: { maxTokens?: number; temperature?: number }
    ): Promise<{ content: string; usage?: TokenUsage }> {
      const question = extractQuestion(messages);
      const content = findResponse(question);

      return {
        content,
        usage: defaultUsage,
      };
    },

    /**
     * Streaming chat completion.
     * Used by ask command in text mode and chat command.
     * Yields word-by-word for realistic streaming simulation.
     */
    async *streamChat(
      messages: ChatMessage[],
      _options?: { maxTokens?: number; temperature?: number }
    ): AsyncGenerator<StreamChunk> {
      const question = extractQuestion(messages);
      const content = findResponse(question);

      // Stream word by word (with trailing space) for realistic behavior
      const words = content.split(' ');
      for (let i = 0; i < words.length; i++) {
        const word = words[i]!;
        // Add space after each word except the last
        const chunk = i < words.length - 1 ? word + ' ' : word;
        yield { type: 'text' as const, content: chunk };
      }

      // Yield usage at the end
      yield { type: 'usage' as const, usage: defaultUsage };

      // Signal completion
      yield { type: 'done' as const };
    },
  };
}

// ============================================================================
// Citation Verification
// ============================================================================

/**
 * Extract citation references from text.
 *
 * Parses patterns like [1], [2], [10] from the response text.
 * Returns unique indices in ascending order.
 *
 * @param text - The LLM response text
 * @returns Array of unique citation indices found
 *
 * @example
 * ```typescript
 * extractCitationReferences('See [1] and [2] for details. Also [1].')
 * // Returns [1, 2]
 * ```
 */
export function extractCitationReferences(text: string): number[] {
  const pattern = /\[(\d+)\]/g;
  const matches = text.matchAll(pattern);
  const indices = [...matches].map((m) => parseInt(m[1]!, 10));

  // Return unique indices in ascending order
  return [...new Set(indices)].sort((a, b) => a - b);
}

/**
 * Verify citations in an LLM response against RAG sources.
 *
 * This is the key verification function for E2E tests. It ensures that:
 * 1. All [N] references in the response map to actual sources
 * 2. No invalid references exist (e.g., [99] when only 5 sources)
 * 3. We can track which sources were/weren't cited
 *
 * @param response - The LLM response text containing [1], [2] citations
 * @param sources - RAG sources that were provided to the LLM
 * @returns Verification result with detailed breakdown
 *
 * @example
 * ```typescript
 * const result = verifyCitations(llmResponse, ragResult.sources);
 *
 * expect(result.allReferencesValid).toBe(true);
 * expect(result.invalidReferences).toHaveLength(0);
 * expect(result.citedSources.length).toBeGreaterThan(0);
 * ```
 */
export function verifyCitations(
  response: string,
  sources: RAGSource[]
): CitationVerification {
  const referencedIndices = extractCitationReferences(response);
  const availableSourceIndices = sources.map((s) => s.index);

  // Build a map for quick lookup: index → source
  const sourceMap = new Map(sources.map((s) => [s.index, s]));

  // Categorize references
  const citedSources: RAGSource[] = [];
  const invalidReferences: number[] = [];

  for (const idx of referencedIndices) {
    const source = sourceMap.get(idx);
    if (source) {
      citedSources.push(source);
    } else {
      invalidReferences.push(idx);
    }
  }

  // Find sources that weren't cited
  const citedIndices = new Set(referencedIndices);
  const uncitedSources = sources.filter((s) => !citedIndices.has(s.index));

  return {
    referencedIndices,
    availableSourceIndices,
    allReferencesValid: invalidReferences.length === 0,
    citedSources,
    uncitedSources,
    invalidReferences,
  };
}

// ============================================================================
// Test Output Capture
// ============================================================================

/**
 * Capture console output during test execution.
 *
 * @internal Prefer using `withConsoleCapture()` which guarantees cleanup.
 *
 * Useful for verifying CLI output without actually printing to terminal.
 * Returns a cleanup function to restore original behavior.
 *
 * ⚠️ WARNING: If a test throws before calling restore(), the mock persists.
 * Use `withConsoleCapture()` instead for guaranteed cleanup.
 *
 * @returns Object with captured lines array and restore function
 *
 * @example
 * ```typescript
 * const capture = captureConsoleOutput();
 * try {
 *   console.log('Hello');
 *   console.log('World');
 * } finally {
 *   capture.restore();
 * }
 * expect(capture.lines).toEqual(['Hello', 'World']);
 * ```
 */
export function captureConsoleOutput(): {
  lines: string[];
  restore: () => void;
} {
  const lines: string[] = [];
  const originalLog = console.log;

  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };

  return {
    lines,
    restore: () => {
      console.log = originalLog;
    },
  };
}

/**
 * Capture stdout.write output during test execution.
 *
 * @internal Prefer using `withStdoutCapture()` which guarantees cleanup.
 *
 * Used for streaming output where console.log isn't used.
 * The ask command uses process.stdout.write for streaming.
 *
 * ⚠️ WARNING: If a test throws before calling restore(), the mock persists.
 * Use `withStdoutCapture()` instead for guaranteed cleanup.
 *
 * @returns Object with captured content string and restore function
 */
export function captureStdout(): {
  getContent: () => string;
  restore: () => void;
} {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);

  // Mock with proper type handling for all overload signatures
  const mockWrite: typeof process.stdout.write = function (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((err?: Error) => void),
    callback?: (err?: Error) => void
  ): boolean {
    // Handle the chunk based on type
    if (typeof chunk === 'string') {
      chunks.push(chunk);
    } else if (chunk instanceof Uint8Array) {
      // Apply encoding if provided as string, otherwise default to utf-8
      const encoding =
        typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf-8';
      chunks.push(Buffer.from(chunk).toString(encoding as BufferEncoding));
    }

    // Call the appropriate callback
    const cb =
      typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (cb) cb();
    return true;
  } as typeof process.stdout.write;

  process.stdout.write = mockWrite;

  return {
    getContent: () => chunks.join(''),
    restore: () => {
      process.stdout.write = originalWrite;
    },
  };
}

// ============================================================================
// Safe Capture Helpers (PREFERRED API)
// ============================================================================

/**
 * Execute a function while capturing stdout, with guaranteed cleanup.
 *
 * This is the PREFERRED API for tests - it wraps capture/restore in try/finally
 * to ensure cleanup happens even if the test throws an exception.
 *
 * @param fn - Function to execute while capturing stdout
 * @returns Object with the function result and captured output
 *
 * @example
 * ```typescript
 * const { output } = await withStdoutCapture(async () => {
 *   await runAskCommand(['How does auth work?', '--project', 'my-project'], ctx);
 * });
 * expect(output).toMatch(/authenticate/i);
 * ```
 */
export async function withStdoutCapture<T>(
  fn: () => T | Promise<T>
): Promise<{ result: T; output: string }> {
  const capture = captureStdout();
  try {
    const result = await fn();
    return { result, output: capture.getContent() };
  } finally {
    capture.restore();
  }
}

/**
 * Execute a function while capturing console.log, with guaranteed cleanup.
 *
 * This is the PREFERRED API for tests - it wraps capture/restore in try/finally
 * to ensure cleanup happens even if the test throws an exception.
 *
 * @param fn - Function to execute while capturing console output
 * @returns Object with the function result and captured lines
 *
 * @example
 * ```typescript
 * const { lines } = await withConsoleCapture(async () => {
 *   await runSearchCommand(['query', '--project', 'my-project'], ctx);
 * });
 * expect(lines.some(l => l.includes('results'))).toBe(true);
 * ```
 */
export async function withConsoleCapture<T>(
  fn: () => T | Promise<T>
): Promise<{ result: T; lines: string[] }> {
  const capture = captureConsoleOutput();
  try {
    const result = await fn();
    return { result, lines: capture.lines };
  } finally {
    capture.restore();
  }
}
