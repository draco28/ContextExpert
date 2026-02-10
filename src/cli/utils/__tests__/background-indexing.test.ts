/**
 * BackgroundIndexingCoordinator Tests (ticket #108)
 *
 * Verifies the coordinator properly tracks running state and reports
 * accurate status. The original bug caused getStatus() to show "idle"
 * while indexing was actually running due to ANSI/readline conflicts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BackgroundIndexingCoordinator,
  getBackgroundIndexingCoordinator,
  resetBackgroundIndexingCoordinator,
} from '../background-indexing.js';

// Mock the indexer session module
vi.mock('../../../indexer/session.js', () => {
  const { EventEmitter } = require('node:events');

  class MockIndexingSession extends EventEmitter {
    private _status = 'idle';

    isRunning() {
      return this._status === 'running';
    }

    getStatus() {
      return this._status;
    }

    cancel() {
      this._status = 'cancelled';
      this.emit('cancelled');
    }

    async run() {
      this._status = 'running';
      // Simulate async work — don't resolve immediately
      return new Promise(() => {
        // Never resolves in tests; we control lifecycle via events
      });
    }
  }

  return {
    IndexingSession: MockIndexingSession,
    createIndexingSession: vi.fn(() => new MockIndexingSession()),
  };
});

// Mock the status bar
vi.mock('../status-bar.js', () => ({
  StatusBarRenderer: vi.fn(),
  createStatusBar: vi.fn().mockReturnValue({
    show: vi.fn(),
    hide: vi.fn(),
    attach: vi.fn(),
    setStage: vi.fn(),
    update: vi.fn(),
    showSuccess: vi.fn(),
    showError: vi.fn(),
    showCancelled: vi.fn(),
    isActive: vi.fn().mockReturnValue(false),
  }),
}));

describe('BackgroundIndexingCoordinator', () => {
  let coordinator: BackgroundIndexingCoordinator;

  const mockPipelineOptions = {
    projectPath: '/test/path',
    projectName: 'test-project',
    embeddingProvider: { embed: vi.fn() },
    model: 'test-model',
    dimensions: 384,
    databasePath: '/test/db.sqlite',
  };

  beforeEach(() => {
    resetBackgroundIndexingCoordinator();
    coordinator = getBackgroundIndexingCoordinator();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('singleton pattern', () => {
    it('should return the same instance', () => {
      const c1 = getBackgroundIndexingCoordinator();
      const c2 = getBackgroundIndexingCoordinator();
      expect(c1).toBe(c2);
    });

    it('should return new instance after reset', () => {
      const c1 = getBackgroundIndexingCoordinator();
      resetBackgroundIndexingCoordinator();
      const c2 = getBackgroundIndexingCoordinator();
      expect(c1).not.toBe(c2);
    });
  });

  describe('getStatus() accuracy (ticket #108 regression)', () => {
    it('should report running=false when idle', () => {
      const status = coordinator.getStatus();
      expect(status.running).toBe(false);
    });

    it('should report running=true after start', () => {
      coordinator.start({
        pipelineOptions: mockPipelineOptions as any,
        statusBarOptions: { terminalWidth: 80 },
      });

      const status = coordinator.getStatus();
      expect(status.running).toBe(true);
      expect(status.projectName).toBe('test-project');
      expect(status.startedAt).toBeTypeOf('number');
    });

    it('should track isRunning() correctly', () => {
      expect(coordinator.isRunning()).toBe(false);

      coordinator.start({
        pipelineOptions: mockPipelineOptions as any,
        statusBarOptions: { terminalWidth: 80 },
      });

      expect(coordinator.isRunning()).toBe(true);
    });

    it('should prevent double-start', () => {
      coordinator.start({
        pipelineOptions: mockPipelineOptions as any,
        statusBarOptions: { terminalWidth: 80 },
      });

      expect(() => {
        coordinator.start({
          pipelineOptions: mockPipelineOptions as any,
          statusBarOptions: { terminalWidth: 80 },
        });
      }).toThrow('Indexing already in progress');
    });
  });

  describe('cancel', () => {
    it('should return false when nothing is running', () => {
      expect(coordinator.cancel()).toBe(false);
    });

    it('should return true when cancelling active indexing', () => {
      coordinator.start({
        pipelineOptions: mockPipelineOptions as any,
        statusBarOptions: { terminalWidth: 80 },
      });

      expect(coordinator.cancel()).toBe(true);
    });
  });
});
