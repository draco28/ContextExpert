/**
 * Table Formatting Utility
 *
 * Creates nicely formatted ASCII tables for CLI output.
 * Uses Unicode box-drawing characters for clean presentation.
 */

import chalk from 'chalk';

/**
 * Column alignment options
 */
export type Alignment = 'left' | 'right' | 'center';

/**
 * Column definition for table
 */
export interface Column {
  /** Header text */
  header: string;
  /** Data key to look up in rows */
  key: string;
  /** Alignment (default: left) */
  align?: Alignment;
  /** Minimum width */
  minWidth?: number;
}

/**
 * Table row data - key-value pairs
 */
export type Row = Record<string, string | number | null | undefined>;

/**
 * Pad a string to a given width with specified alignment
 */
function padString(str: string, width: number, align: Alignment = 'left'): string {
  const strLen = stripAnsi(str).length;
  const padding = width - strLen;

  if (padding <= 0) return str;

  switch (align) {
    case 'right':
      return ' '.repeat(padding) + str;
    case 'center': {
      const left = Math.floor(padding / 2);
      const right = padding - left;
      return ' '.repeat(left) + str + ' '.repeat(right);
    }
    case 'left':
    default:
      return str + ' '.repeat(padding);
  }
}

/**
 * Strip ANSI escape codes from string (for length calculation)
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

/**
 * Calculate column widths based on data
 */
function calculateWidths(columns: Column[], rows: Row[]): number[] {
  return columns.map((col) => {
    // Start with header width
    let maxWidth = col.header.length;

    // Check all data values
    for (const row of rows) {
      const value = row[col.key];
      const strValue = value != null ? String(value) : '';
      const len = stripAnsi(strValue).length;
      if (len > maxWidth) maxWidth = len;
    }

    // Apply minimum width if specified
    if (col.minWidth && maxWidth < col.minWidth) {
      maxWidth = col.minWidth;
    }

    return maxWidth;
  });
}

/**
 * Format data as an ASCII table
 *
 * @example
 * ```ts
 * const columns: Column[] = [
 *   { header: 'Name', key: 'name' },
 *   { header: 'Count', key: 'count', align: 'right' },
 * ];
 * const rows = [
 *   { name: 'Project A', count: 100 },
 *   { name: 'Project B', count: 50 },
 * ];
 * console.log(formatTable(columns, rows));
 * ```
 *
 * Output:
 * ```
 * ┌───────────┬───────┐
 * │ Name      │ Count │
 * ├───────────┼───────┤
 * │ Project A │   100 │
 * │ Project B │    50 │
 * └───────────┴───────┘
 * ```
 */
export function formatTable(columns: Column[], rows: Row[]): string {
  if (columns.length === 0) return '';

  const widths = calculateWidths(columns, rows);
  const lines: string[] = [];

  // Box-drawing characters
  const TOP_LEFT = '┌';
  const TOP_RIGHT = '┐';
  const BOTTOM_LEFT = '└';
  const BOTTOM_RIGHT = '┘';
  const HORIZONTAL = '─';
  const VERTICAL = '│';
  const T_DOWN = '┬';
  const T_UP = '┴';
  const T_LEFT = '├';
  const T_RIGHT = '┤';
  const CROSS = '┼';

  // Build horizontal lines
  const buildHLine = (left: string, middle: string, right: string) => {
    return (
      left +
      widths.map((w) => HORIZONTAL.repeat(w + 2)).join(middle) +
      right
    );
  };

  // Build data row
  const buildRow = (values: string[], isHeader = false) => {
    const cells = columns.map((col, i) => {
      const value = values[i] ?? '';
      const padded = padString(value, widths[i]!, col.align ?? 'left');
      return isHeader ? chalk.bold(padded) : padded;
    });
    return VERTICAL + cells.map((c) => ` ${c} `).join(VERTICAL) + VERTICAL;
  };

  // Top border
  lines.push(buildHLine(TOP_LEFT, T_DOWN, TOP_RIGHT));

  // Header row
  const headers = columns.map((c) => c.header);
  lines.push(buildRow(headers, true));

  // Header separator
  lines.push(buildHLine(T_LEFT, CROSS, T_RIGHT));

  // Data rows
  for (const row of rows) {
    const values = columns.map((col) => {
      const value = row[col.key];
      return value != null ? String(value) : '';
    });
    lines.push(buildRow(values));
  }

  // Bottom border
  lines.push(buildHLine(BOTTOM_LEFT, T_UP, BOTTOM_RIGHT));

  return lines.join('\n');
}
