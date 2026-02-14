/**
 * Sampling Utility Tests
 *
 * Tests the shouldRecord() function that gates local SQLite trace recording.
 * Verifies boundary conditions (0.0, 1.0) and statistical distribution
 * for fractional sample rates.
 */

import { describe, it, expect } from 'vitest';
import { shouldRecord } from '../sampling.js';

describe('shouldRecord', () => {
  it('always records at sample_rate 1.0', () => {
    // Run multiple times to ensure consistency
    for (let i = 0; i < 100; i++) {
      expect(shouldRecord(1.0)).toBe(true);
    }
  });

  it('always records at sample_rate > 1.0', () => {
    expect(shouldRecord(1.5)).toBe(true);
    expect(shouldRecord(100)).toBe(true);
  });

  it('never records at sample_rate 0.0', () => {
    for (let i = 0; i < 100; i++) {
      expect(shouldRecord(0.0)).toBe(false);
    }
  });

  it('never records at sample_rate < 0.0', () => {
    expect(shouldRecord(-0.5)).toBe(false);
    expect(shouldRecord(-1)).toBe(false);
  });

  it('respects fractional sample_rate (statistical)', () => {
    // Run 1000 trials at 50% — should be roughly 400-600
    let recorded = 0;
    const trials = 1000;
    for (let i = 0; i < trials; i++) {
      if (shouldRecord(0.5)) recorded++;
    }

    // Expect within 3 standard deviations (99.7% confidence)
    // stddev = sqrt(n * p * (1-p)) = sqrt(1000 * 0.5 * 0.5) ≈ 15.8
    // 3σ ≈ 47.4, so range: 500 ± 48 → [452, 548] with some margin
    expect(recorded).toBeGreaterThan(350);
    expect(recorded).toBeLessThan(650);
  });

  it('records approximately 10% at sample_rate 0.1', () => {
    let recorded = 0;
    const trials = 1000;
    for (let i = 0; i < trials; i++) {
      if (shouldRecord(0.1)) recorded++;
    }

    // 10% of 1000 = 100, expect roughly 30-170
    expect(recorded).toBeGreaterThan(30);
    expect(recorded).toBeLessThan(200);
  });
});
