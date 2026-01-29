/**
 * XMLAssembler Factory for Code Context Formatting
 *
 * Provides a factory function that wraps ContextAI SDK's XMLAssembler
 * with code-optimized defaults. This extraction from rag-engine.ts
 * improves testability and centralizes assembler configuration.
 *
 * WHY A FACTORY?
 * - Encapsulates SDK configuration complexity
 * - Enables unit testing without full RAG pipeline
 * - Single source of truth for assembler defaults
 * - Adds deduplication (missing in original inline config)
 *
 * OUTPUT FORMAT:
 * ```xml
 * <sources>
 *   <source id="1" file="src/auth.ts" location="lines 42-67">
 *     function authenticate(user: User) { ... }
 *   </source>
 * </sources>
 * ```
 *
 * @example
 * ```typescript
 * import { createAssembler, DEFAULT_ASSEMBLER_CONFIG } from './assembler';
 *
 * // Use defaults
 * const assembler = createAssembler();
 *
 * // Or customize
 * const customAssembler = createAssembler({
 *   maxTokens: 8000,
 *   ordering: 'relevance',
 * });
 * ```
 */

import { z } from 'zod';
import { XMLAssembler, type OrderingStrategy } from '@contextaisdk/rag';

// Re-export SDK's ordering strategy to avoid type mismatches
// This ensures our type always matches what the SDK expects
export type { OrderingStrategy };

// ============================================================================
// CONFIGURATION SCHEMA
// ============================================================================

/**
 * Zod schema for assembler options validation.
 *
 * Validates:
 * - maxTokens: positive integer between 100 and 32000
 * - ordering: one of 'relevance', 'sandwich', 'chronological'
 * - deduplicationThreshold: number between 0 and 1
 * - includeScores: boolean
 */
export const AssemblerOptionsSchema = z.object({
  maxTokens: z
    .number()
    .int('maxTokens must be an integer')
    .min(100, 'maxTokens must be at least 100')
    .max(32000, 'maxTokens cannot exceed 32000')
    .optional(),

  ordering: z
    .enum(['relevance', 'sandwich', 'chronological'], {
      errorMap: () => ({
        message: "ordering must be 'relevance', 'sandwich', or 'chronological'",
      }),
    })
    .optional(),

  deduplicationThreshold: z
    .number()
    .min(0, 'deduplicationThreshold must be between 0 and 1')
    .max(1, 'deduplicationThreshold must be between 0 and 1')
    .optional(),

  includeScores: z.boolean().optional(),
});

/**
 * Options for creating an XMLAssembler.
 *
 * All options are optional - defaults are optimized for code context.
 * Validated at runtime via Zod schema.
 */
export type AssemblerOptions = z.infer<typeof AssemblerOptionsSchema>;

// ============================================================================
// DEFAULTS
// ============================================================================

/**
 * Default configuration optimized for code context assembly.
 *
 * These values are tuned for typical code search scenarios:
 * - 4000 tokens fits well in 8k-32k context windows
 * - Sandwich ordering improves LLM attention on key results
 * - 0.8 similarity threshold removes near-duplicates
 */
export const DEFAULT_ASSEMBLER_CONFIG: Required<AssemblerOptions> = {
  maxTokens: 4000,
  ordering: 'sandwich',
  deduplicationThreshold: 0.8,
  includeScores: false,
};

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create an XMLAssembler configured for code context.
 *
 * Wraps ContextAI SDK's XMLAssembler with sensible defaults for
 * code search and retrieval. Key features enabled:
 *
 * - **Deduplication**: Removes similar chunks (Jaccard similarity)
 * - **Token budget**: Limits output to fit context window
 * - **Sandwich ordering**: Best results at start AND end
 * - **Rich metadata**: File paths and line numbers in XML
 *
 * @param options - Override default configuration
 * @returns Configured XMLAssembler instance
 *
 * @example
 * ```typescript
 * // Basic usage with defaults
 * const assembler = createAssembler();
 * const result = await assembler.assemble(rerankedResults);
 * console.log(result.content); // XML string
 *
 * // Custom configuration
 * const largeAssembler = createAssembler({
 *   maxTokens: 8000,
 *   ordering: 'chronological',
 *   deduplicationThreshold: 0.9,
 * });
 * ```
 */
export function createAssembler(options?: AssemblerOptions): XMLAssembler {
  // Validate options if provided (throws ZodError with clear message)
  if (options) {
    AssemblerOptionsSchema.parse(options);
  }

  // Merge validated options with defaults
  const config: Required<AssemblerOptions> = {
    ...DEFAULT_ASSEMBLER_CONFIG,
    ...options,
  };

  return new XMLAssembler({
    // XML structure
    rootTag: 'sources',
    sourceTag: 'source',

    // Ordering strategy (no cast needed - we use SDK type directly)
    ordering: config.ordering,

    // Token budget management
    tokenBudget: {
      maxTokens: config.maxTokens,
    },

    // Deduplication (Jaccard similarity)
    deduplication: {
      enabled: true,
      similarityThreshold: config.deduplicationThreshold,
      keepHighestScore: true,
    },

    // Metadata in XML output
    includeFilePath: true, // file="src/auth.ts"
    includeLocation: true, // location="lines 42-67"
    includeScores: config.includeScores, // score="0.95" (usually off)

    // Formatting
    prettyPrint: true, // Indented XML for readability
  });
}
