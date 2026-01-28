/**
 * Tests for unified singleton reset utility
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetAll } from '../reset.js';
import {
  getVectorStoreManager,
  resetVectorStoreManager,
  getBM25StoreManager,
  resetBM25StoreManager,
} from '../../search/index.js';
import { getDatabase, resetDatabase, closeDb } from '../../database/index.js';

// Mock the search and database modules
vi.mock('../../search/index.js', () => ({
  getVectorStoreManager: vi.fn(() => ({ stores: new Map() })),
  resetVectorStoreManager: vi.fn(),
  getBM25StoreManager: vi.fn(() => ({ retrievers: new Map() })),
  resetBM25StoreManager: vi.fn(),
}));

vi.mock('../../database/index.js', () => ({
  getDatabase: vi.fn(() => ({})),
  resetDatabase: vi.fn(),
  closeDb: vi.fn(),
}));

describe('resetAll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls all reset functions', () => {
    resetAll();

    expect(resetVectorStoreManager).toHaveBeenCalledTimes(1);
    expect(resetBM25StoreManager).toHaveBeenCalledTimes(1);
    expect(resetDatabase).toHaveBeenCalledTimes(1);
    expect(closeDb).toHaveBeenCalledTimes(1);
  });

  it('calls reset functions in correct order (stores before database)', () => {
    const callOrder: string[] = [];

    vi.mocked(resetVectorStoreManager).mockImplementation(() => {
      callOrder.push('vectorStore');
    });
    vi.mocked(resetBM25StoreManager).mockImplementation(() => {
      callOrder.push('bm25Store');
    });
    vi.mocked(resetDatabase).mockImplementation(() => {
      callOrder.push('database');
    });
    vi.mocked(closeDb).mockImplementation(() => {
      callOrder.push('closeDb');
    });

    resetAll();

    // Verify order: stores first, then database operations, then close connection
    expect(callOrder).toEqual([
      'vectorStore',
      'bm25Store',
      'database',
      'closeDb',
    ]);
  });

  it('can be called multiple times safely', () => {
    resetAll();
    resetAll();
    resetAll();

    expect(resetVectorStoreManager).toHaveBeenCalledTimes(3);
    expect(resetBM25StoreManager).toHaveBeenCalledTimes(3);
    expect(resetDatabase).toHaveBeenCalledTimes(3);
    expect(closeDb).toHaveBeenCalledTimes(3);
  });
});
