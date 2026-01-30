/**
 * Path Validation Utilities
 *
 * Comprehensive validation for project paths with structured results.
 * Used by commands that accept directory paths (index, search, etc.)
 */

import { resolve, sep } from 'node:path';
import { existsSync, statSync, realpathSync, accessSync, constants } from 'node:fs';

// ============================================================================
// Types
// ============================================================================

/**
 * Result of path validation.
 *
 * Uses discriminated union to force callers to handle both success and failure.
 * Warnings are returned even on success for non-fatal issues.
 */
export type PathValidationResult =
  | { valid: true; normalizedPath: string; warnings: string[] }
  | { valid: false; error: string; hint: string };

/**
 * Configuration options for path validation.
 */
export interface PathValidationOptions {
  /** Maximum directory nesting depth (default: 50) */
  maxDepth?: number;
  /** Whether to check read permissions (default: true) */
  checkReadable?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_DEPTH = 50;

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate a project path for indexing operations.
 *
 * Performs comprehensive checks:
 * 1. Path existence
 * 2. Is a directory (not a file)
 * 3. Symlink resolution (detects loops)
 * 4. Read permissions
 * 5. Nesting depth (warns if too deep)
 *
 * @param inputPath - Path to validate (relative or absolute)
 * @param options - Validation options
 * @returns Structured result with normalized path or error details
 *
 * @example
 * const result = validateProjectPath('./my-project');
 * if (result.valid) {
 *   console.log(`Using path: ${result.normalizedPath}`);
 *   result.warnings.forEach(w => console.warn(w));
 * } else {
 *   console.error(result.error);
 *   console.log(result.hint);
 * }
 */
export function validateProjectPath(
  inputPath: string,
  options: PathValidationOptions = {}
): PathValidationResult {
  const { maxDepth = DEFAULT_MAX_DEPTH, checkReadable = true } = options;
  const warnings: string[] = [];

  // Step 1: Resolve to absolute path
  const absolutePath = resolve(inputPath);

  // Step 2: Check existence
  if (!existsSync(absolutePath)) {
    return {
      valid: false,
      error: `Path does not exist: ${absolutePath}`,
      hint: 'Check the path and try again. Use an absolute path to avoid ambiguity.',
    };
  }

  // Step 3: Resolve symlinks and detect loops
  let realPath: string;
  try {
    realPath = realpathSync(absolutePath);
  } catch (error) {
    // realpathSync throws ELOOP for symlink loops
    const errCode = (error as NodeJS.ErrnoException).code;
    if (errCode === 'ELOOP') {
      return {
        valid: false,
        error: `Symlink loop detected at: ${absolutePath}`,
        hint: 'The path contains circular symlinks. Remove or fix the symlink loop.',
      };
    }
    // Other errors (permissions during resolution, etc.)
    return {
      valid: false,
      error: `Cannot resolve path: ${absolutePath}`,
      hint: `System error: ${(error as Error).message}`,
    };
  }

  // Step 4: Verify it's a directory
  let stat;
  try {
    stat = statSync(realPath);
  } catch (error) {
    return {
      valid: false,
      error: `Cannot access path: ${realPath}`,
      hint: `System error: ${(error as Error).message}`,
    };
  }

  if (!stat.isDirectory()) {
    return {
      valid: false,
      error: `Path is not a directory: ${realPath}`,
      hint: 'ctx index requires a directory path, not a file. Provide the parent directory.',
    };
  }

  // Step 5: Check read permissions
  if (checkReadable) {
    try {
      accessSync(realPath, constants.R_OK);
    } catch {
      return {
        valid: false,
        error: `Permission denied: cannot read ${realPath}`,
        hint: 'Check file permissions. You may need to run: chmod +r <path>',
      };
    }
  }

  // Step 6: Check nesting depth (warning only, not an error)
  const depth = realPath.split(sep).filter(Boolean).length;
  if (depth > maxDepth) {
    warnings.push(
      `Directory is deeply nested (${depth} levels). This may cause performance issues or stack overflow during indexing.`
    );
  }

  // Step 7: Note if symlink resolved to different path (informational)
  if (absolutePath !== realPath) {
    warnings.push(`Symlink resolved: ${absolutePath} → ${realPath}`);
  }

  return {
    valid: true,
    normalizedPath: realPath,
    warnings,
  };
}
