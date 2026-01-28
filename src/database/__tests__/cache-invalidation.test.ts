/**
 * Cache Invalidation Integration Tests
 *
 * Tests that deleteProject() properly invalidates search caches.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseOperations } from '../operations.js';
import {
  getVectorStoreManager,
  getBM25StoreManager,
} from '../../search/index.js';

// Mock the search module
vi.mock('../../search/index.js', () => {
  const mockVectorManager = {
    invalidate: vi.fn(),
    stores: new Map(),
  };
  const mockBM25Manager = {
    invalidate: vi.fn(),
    retrievers: new Map(),
  };
  return {
    getVectorStoreManager: vi.fn(() => mockVectorManager),
    getBM25StoreManager: vi.fn(() => mockBM25Manager),
    resetVectorStoreManager: vi.fn(),
    resetBM25StoreManager: vi.fn(),
  };
});

// Mock the database connection
vi.mock('../connection.js', () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({
      get: vi.fn(() => ({ count: 5 })),
      run: vi.fn(() => ({ changes: 1 })),
    })),
    // Mock transaction() to execute the callback immediately and return its result
    transaction: vi.fn((fn) => () => fn()),
  })),
  getDbPath: vi.fn(() => '/mock/path'),
}));

describe('deleteProject cache invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invalidates vector store cache after deleting project', () => {
    const db = new DatabaseOperations();
    const projectId = 'test-project-123';

    db.deleteProject(projectId);

    const vectorManager = getVectorStoreManager();
    expect(vectorManager.invalidate).toHaveBeenCalledTimes(1);
    expect(vectorManager.invalidate).toHaveBeenCalledWith(projectId);
  });

  it('invalidates BM25 store cache after deleting project', () => {
    const db = new DatabaseOperations();
    const projectId = 'test-project-456';

    db.deleteProject(projectId);

    const bm25Manager = getBM25StoreManager();
    expect(bm25Manager.invalidate).toHaveBeenCalledTimes(1);
    expect(bm25Manager.invalidate).toHaveBeenCalledWith(projectId);
  });

  it('invalidates both caches even if project has no chunks', () => {
    const db = new DatabaseOperations();
    const projectId = 'empty-project';

    const result = db.deleteProject(projectId);

    // Should still invalidate caches
    expect(getVectorStoreManager().invalidate).toHaveBeenCalledWith(projectId);
    expect(getBM25StoreManager().invalidate).toHaveBeenCalledWith(projectId);
  });

  it('returns deletion counts along with cache invalidation', () => {
    const db = new DatabaseOperations();
    const projectId = 'project-with-data';

    const result = db.deleteProject(projectId);

    // Verify return value structure (mocked to return 5)
    expect(result).toHaveProperty('chunksDeleted');
    expect(result).toHaveProperty('fileHashesDeleted');
  });
});
