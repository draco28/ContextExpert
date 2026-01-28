/**
 * Test Utilities - Unified Reset
 *
 * Provides a single function to reset all singletons for test isolation.
 *
 * ORDER MATTERS:
 * 1. Reset search stores first (they cache data from the database)
 * 2. Reset database operations singleton
 * 3. Close database connection last
 *
 * @example
 * ```typescript
 * import { resetAll } from '../test-utils/index.js';
 *
 * beforeEach(() => {
 *   resetAll();
 *   vi.clearAllMocks();
 * });
 * ```
 */

import { resetVectorStoreManager, resetBM25StoreManager } from '../search/index.js';
import { resetDatabase, closeDb } from '../database/index.js';

/**
 * Reset all application singletons for test isolation.
 *
 * This function ensures clean state between tests by:
 * 1. Clearing all cached vector stores
 * 2. Clearing all cached BM25 indexes
 * 3. Resetting the database operations singleton
 * 4. Closing the database connection
 *
 * Call this in `beforeEach` for complete isolation, or `afterAll` for cleanup.
 */
export function resetAll(): void {
  // Step 1: Clear search caches first (they depend on database data)
  resetVectorStoreManager();
  resetBM25StoreManager();

  // Step 2: Reset database operations singleton
  resetDatabase();

  // Step 3: Close database connection last
  closeDb();
}
