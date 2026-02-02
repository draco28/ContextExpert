/**
 * Search Module Errors
 *
 * Custom error classes for search-related failures.
 * All errors extend CLIError for consistent error handling.
 */

import { CLIError } from '../errors/index.js';
import type { EmbeddingValidation } from './types.js';

/**
 * Thrown when cross-project search is attempted with incompatible embedding models.
 *
 * This error occurs when:
 * - Projects have different embedding dimensions (e.g., 768 vs 1024)
 * - Projects use different embedding models (e.g., BGE vs Nomic)
 *
 * The validation result is preserved for programmatic access to details.
 *
 * Exit code 6: Search validation error
 *
 * @example
 * ```typescript
 * const validation = manager.validateProjects(['proj-1', 'proj-2']);
 * if (!validation.valid) {
 *   throw new EmbeddingMismatchError(validation);
 * }
 * ```
 */
export class EmbeddingMismatchError extends CLIError {
  /** The validation result with full error details */
  public readonly validation: EmbeddingValidation;

  constructor(validation: EmbeddingValidation) {
    // Format project names for the error message
    const names = validation.errors!.map((p) => p.projectName).join(', ');
    const expected = validation.expectedModel ?? 'unknown';
    const dims = validation.expectedDimensions ?? 0;

    super(
      `Cannot search across projects with different embedding models`,
      `Expected: ${expected} (${dims} dimensions)\n` +
        `Mismatched: ${names}\n\n` +
        `Suggestion: Re-index projects with the same embedding model.`,
      6 // Exit code 6 for search validation errors
    );
    this.name = 'EmbeddingMismatchError';
    this.validation = validation;
  }
}
