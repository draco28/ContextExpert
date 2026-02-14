/**
 * Trace Sampling
 *
 * Controls the fraction of interactions recorded to local SQLite.
 * Applied at the command layer before calling insertTrace().
 *
 * At sample_rate=1.0 (default), every interaction is recorded.
 * At 0.0, no interactions are recorded locally.
 * Fractional values use random sampling for statistical accuracy.
 */

/**
 * Check if this interaction should be recorded based on sample_rate.
 *
 * @param sampleRate - Value between 0.0 (never record) and 1.0 (always record)
 * @returns true if this interaction should be recorded
 */
export function shouldRecord(sampleRate: number): boolean {
  if (sampleRate >= 1.0) return true;
  if (sampleRate <= 0.0) return false;
  return Math.random() < sampleRate;
}
