/**
 * Eval Command Tests
 *
 * Tests the parseSince helper function for the ctx eval traces command.
 * The command itself is tested via integration tests since it requires
 * database and Commander.js setup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseSince } from '../eval.js';

describe('parseSince', () => {
  // Fix the current date for deterministic tests
  const NOW = new Date('2026-02-15T12:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses day format (7d)', () => {
    const result = parseSince('7d');
    const expected = new Date('2026-02-08T12:00:00.000Z');
    expect(new Date(result).toISOString()).toBe(expected.toISOString());
  });

  it('parses hour format (24h)', () => {
    const result = parseSince('24h');
    const expected = new Date('2026-02-14T12:00:00.000Z');
    expect(new Date(result).toISOString()).toBe(expected.toISOString());
  });

  it('parses week format (2w)', () => {
    const result = parseSince('2w');
    const expected = new Date('2026-02-01T12:00:00.000Z');
    expect(new Date(result).toISOString()).toBe(expected.toISOString());
  });

  it('parses single day (1d)', () => {
    const result = parseSince('1d');
    const expected = new Date('2026-02-14T12:00:00.000Z');
    expect(new Date(result).toISOString()).toBe(expected.toISOString());
  });

  it('passes through ISO date strings', () => {
    const isoDate = '2026-01-01T00:00:00.000Z';
    expect(parseSince(isoDate)).toBe(isoDate);
  });

  it('passes through partial date strings', () => {
    const dateStr = '2026-01-15';
    expect(parseSince(dateStr)).toBe(dateStr);
  });
});
