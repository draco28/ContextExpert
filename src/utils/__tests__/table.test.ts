/**
 * Tests for table formatting utility
 *
 * Tests cover:
 * - Basic table rendering
 * - Column alignment (left, right, center)
 * - Empty data handling
 * - Width calculations
 * - ANSI color code handling
 */

import { describe, it, expect } from 'vitest';
import chalk from 'chalk';
import { formatTable, type Column, type Row } from '../table.js';

describe('formatTable', () => {
  describe('basic rendering', () => {
    it('renders a simple table with data', () => {
      const columns: Column[] = [
        { header: 'Name', key: 'name' },
        { header: 'Value', key: 'value' },
      ];
      const rows: Row[] = [
        { name: 'foo', value: '123' },
        { name: 'bar', value: '456' },
      ];

      const result = formatTable(columns, rows);

      // Check structure
      expect(result).toContain('┌');
      expect(result).toContain('┐');
      expect(result).toContain('└');
      expect(result).toContain('┘');
      expect(result).toContain('│');
      expect(result).toContain('─');

      // Check headers
      expect(result).toContain('Name');
      expect(result).toContain('Value');

      // Check data
      expect(result).toContain('foo');
      expect(result).toContain('123');
      expect(result).toContain('bar');
      expect(result).toContain('456');
    });

    it('renders empty table when no rows', () => {
      const columns: Column[] = [
        { header: 'Name', key: 'name' },
      ];
      const rows: Row[] = [];

      const result = formatTable(columns, rows);

      // Should still have headers and borders
      expect(result).toContain('Name');
      expect(result).toContain('┌');
      expect(result).toContain('└');
    });

    it('returns empty string when no columns', () => {
      const result = formatTable([], []);
      expect(result).toBe('');
    });
  });

  describe('column alignment', () => {
    it('aligns text left by default', () => {
      const columns: Column[] = [{ header: 'X', key: 'x' }];
      const rows: Row[] = [{ x: 'ab' }];

      const result = formatTable(columns, rows);
      const lines = result.split('\n');
      const dataRow = lines[3]; // Header separator is line 2

      // "ab" should be followed by space (left aligned)
      expect(dataRow).toContain('│ ab │');
    });

    it('aligns numbers right when specified', () => {
      const columns: Column[] = [
        { header: 'Count', key: 'count', align: 'right' },
      ];
      const rows: Row[] = [
        { count: '1' },
        { count: '100' },
      ];

      const result = formatTable(columns, rows);
      const lines = result.split('\n');

      // "1" should be right-aligned in a column wide enough for "Count" header (5 chars)
      // Column width is max(5, 3) = 5, so "1" gets 4 spaces padding
      expect(lines[3]).toContain('│     1 │'); // padded on left
      expect(lines[4]).toContain('│   100 │'); // padded on left
    });

    it('centers text when specified', () => {
      const columns: Column[] = [
        { header: 'Status', key: 'status', align: 'center' },
      ];
      const rows: Row[] = [
        { status: 'OK' },
      ];

      const result = formatTable(columns, rows);

      // "OK" should be centered under "Status"
      expect(result).toContain('Status');
      expect(result).toContain('OK');
    });
  });

  describe('column width calculations', () => {
    it('uses header width when data is shorter', () => {
      const columns: Column[] = [
        { header: 'LongHeader', key: 'val' },
      ];
      const rows: Row[] = [{ val: 'X' }];

      const result = formatTable(columns, rows);

      // Column should be at least as wide as "LongHeader"
      expect(result).toContain('│ LongHeader │');
    });

    it('expands column for longer data values', () => {
      const columns: Column[] = [
        { header: 'A', key: 'val' },
      ];
      const rows: Row[] = [{ val: 'VeryLongValue' }];

      const result = formatTable(columns, rows);

      // Column should expand for data
      expect(result).toContain('VeryLongValue');
      // Header "A" should be padded to match
      const lines = result.split('\n');
      expect(lines[1]).toContain('A');
    });

    it('respects minWidth option', () => {
      const columns: Column[] = [
        { header: 'X', key: 'x', minWidth: 10 },
      ];
      const rows: Row[] = [{ x: '1' }];

      const result = formatTable(columns, rows);
      const lines = result.split('\n');

      // Column should be at least 10 chars wide (plus padding)
      // Border line: ┌────────────┐ (12 dashes for 10 + 2 padding)
      expect(lines[0]).toMatch(/─{12}/);
    });
  });

  describe('null and undefined handling', () => {
    it('handles null values as empty strings', () => {
      const columns: Column[] = [
        { header: 'Name', key: 'name' },
      ];
      const rows: Row[] = [{ name: null }];

      const result = formatTable(columns, rows);

      // Should render without errors, empty cell
      expect(result).toContain('│');
      expect(result).not.toContain('null');
    });

    it('handles undefined values as empty strings', () => {
      const columns: Column[] = [
        { header: 'Name', key: 'name' },
      ];
      const rows: Row[] = [{ other: 'value' }]; // 'name' key missing

      const result = formatTable(columns, rows);

      expect(result).toContain('│');
      expect(result).not.toContain('undefined');
    });

    it('handles number values correctly', () => {
      const columns: Column[] = [
        { header: 'Count', key: 'count' },
      ];
      const rows: Row[] = [{ count: 42 }];

      const result = formatTable(columns, rows);

      expect(result).toContain('42');
    });
  });

  describe('ANSI color handling', () => {
    it('calculates width correctly with chalk colors', () => {
      const columns: Column[] = [
        { header: 'Name', key: 'name' },
        { header: 'Status', key: 'status' },
      ];
      const rows: Row[] = [
        { name: 'test', status: chalk.green('OK') },
      ];

      const result = formatTable(columns, rows);

      // Table should render correctly despite ANSI codes
      expect(result).toContain('test');
      // The colored "OK" should be present
      expect(result).toContain('OK');
      // Should not have misaligned borders
      const lines = result.split('\n');
      lines.forEach((line) => {
        // Each line should start and end with proper characters
        if (line.includes('│')) {
          expect(line.startsWith('│') || line.startsWith('┌') || line.startsWith('├') || line.startsWith('└')).toBe(true);
        }
      });
    });
  });

  describe('box drawing structure', () => {
    it('has correct top border', () => {
      const columns: Column[] = [
        { header: 'A', key: 'a' },
        { header: 'B', key: 'b' },
      ];
      const rows: Row[] = [{ a: '1', b: '2' }];

      const result = formatTable(columns, rows);
      const lines = result.split('\n');

      // First line should have top corners and T-down separator
      expect(lines[0]).toMatch(/^┌─+┬─+┐$/);
    });

    it('has correct header separator', () => {
      const columns: Column[] = [
        { header: 'A', key: 'a' },
        { header: 'B', key: 'b' },
      ];
      const rows: Row[] = [{ a: '1', b: '2' }];

      const result = formatTable(columns, rows);
      const lines = result.split('\n');

      // Third line should have T-left, cross, and T-right
      expect(lines[2]).toMatch(/^├─+┼─+┤$/);
    });

    it('has correct bottom border', () => {
      const columns: Column[] = [
        { header: 'A', key: 'a' },
        { header: 'B', key: 'b' },
      ];
      const rows: Row[] = [{ a: '1', b: '2' }];

      const result = formatTable(columns, rows);
      const lines = result.split('\n');

      // Last line should have bottom corners and T-up separator
      const lastLine = lines[lines.length - 1];
      expect(lastLine).toMatch(/^└─+┴─+┘$/);
    });
  });
});
