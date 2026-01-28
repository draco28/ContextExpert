/**
 * JSON Utilities
 *
 * Safe JSON parsing with fallback for corrupted data.
 */

/**
 * Safely parse a JSON string with fallback on error.
 *
 * Use this when parsing JSON from external sources (database, files, APIs)
 * where corruption is possible and you want graceful degradation.
 *
 * @param json - The JSON string to parse (can be null/undefined)
 * @param fallback - Value to return if parsing fails
 * @param onError - Optional callback for logging/reporting parse errors
 * @returns Parsed value or fallback
 *
 * @example
 * ```typescript
 * // Basic usage with fallback
 * const metadata = safeJsonParse(row.metadata, {});
 *
 * // With error logging
 * const data = safeJsonParse(jsonString, [], (err, raw) => {
 *   console.warn(`Failed to parse JSON: ${err.message}`);
 * });
 * ```
 */
export function safeJsonParse<T>(
  json: string | null | undefined,
  fallback: T,
  onError?: (error: Error, rawValue: string) => void
): T {
  if (json === null || json === undefined) {
    return fallback;
  }

  try {
    return JSON.parse(json) as T;
  } catch (error) {
    if (onError && error instanceof Error) {
      onError(error, json);
    }
    return fallback;
  }
}
