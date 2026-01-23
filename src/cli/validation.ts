/**
 * Zod validation schemas for CLI inputs
 *
 * These schemas validate and transform user input from the command line.
 * Commander.js parses arguments, then we validate with Zod for:
 * - Type coercion (string "5" -> number 5)
 * - Default values
 * - Custom validation rules
 * - Helpful error messages
 */

import { z } from 'zod';

// ============================================================================
// GLOBAL OPTIONS SCHEMA
// ============================================================================

export const GlobalOptionsSchema = z.object({
  verbose: z.boolean().default(false),
  json: z.boolean().default(false),
});

export type GlobalOptionsInput = z.input<typeof GlobalOptionsSchema>;
export type GlobalOptionsOutput = z.output<typeof GlobalOptionsSchema>;

// ============================================================================
// INDEX COMMAND SCHEMA
// ============================================================================

export const IndexOptionsSchema = z.object({
  name: z
    .string()
    .min(1, 'Project name cannot be empty')
    .max(100, 'Project name too long (max 100 chars)')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Project name can only contain letters, numbers, hyphens, and underscores')
    .optional(),
  tags: z
    .string()
    .transform((val) => val.split(',').map((t) => t.trim()).filter(Boolean))
    .optional(),
});

export const IndexArgsSchema = z.object({
  path: z
    .string()
    .min(1, 'Path is required'),
});

// ============================================================================
// ASK COMMAND SCHEMA
// ============================================================================

export const AskOptionsSchema = z.object({
  project: z.string().optional(),
  topK: z
    .string()
    .default('5')
    .transform((val) => parseInt(val, 10))
    .refine((val) => !isNaN(val) && val >= 1 && val <= 20, {
      message: 'top-k must be a number between 1 and 20',
    }),
});

export const AskArgsSchema = z.object({
  question: z
    .string()
    .min(3, 'Question must be at least 3 characters')
    .max(1000, 'Question too long (max 1000 chars)'),
});

// ============================================================================
// SEARCH COMMAND SCHEMA
// ============================================================================

export const SearchOptionsSchema = z.object({
  project: z.string().optional(),
  type: z
    .string()
    .regex(/^[a-zA-Z0-9]+$/, 'File type must be alphanumeric (e.g., ts, py, md)')
    .optional(),
});

export const SearchArgsSchema = z.object({
  query: z
    .string()
    .min(1, 'Search query cannot be empty')
    .max(500, 'Search query too long (max 500 chars)'),
});

// ============================================================================
// VALIDATION HELPER
// ============================================================================

/**
 * Validate input with a Zod schema and return a formatted error message
 * if validation fails.
 *
 * @example
 * ```typescript
 * const result = validateInput(IndexOptionsSchema, options);
 * if (!result.success) {
 *   ctx.error(result.error);
 *   process.exit(1);
 * }
 * const validOptions = result.data;
 * ```
 */
export function validateInput<T extends z.ZodSchema>(
  schema: T,
  input: unknown
): { success: true; data: z.output<T> } | { success: false; error: string } {
  const result = schema.safeParse(input);

  if (result.success) {
    return { success: true, data: result.data };
  }

  // Format Zod errors into a readable message
  const errors = result.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${path}${issue.message}`;
    })
    .join('\n  ');

  return { success: false, error: `Validation failed:\n  ${errors}` };
}
