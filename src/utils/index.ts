/**
 * Utilities Module
 *
 * Shared utility functions used across the codebase.
 */

// Table formatting for CLI output
export {
  formatTable,
  type Column,
  type Alignment,
  type Row,
} from './table.js';

// Safe JSON parsing
export { safeJsonParse } from './json.js';
