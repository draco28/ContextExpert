/**
 * Git Status Utility Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getGitInfo } from '../git-status.js';
import { execSync } from 'node:child_process';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);

describe('getGitInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return branch name and clean state', () => {
    mockExecSync
      .mockReturnValueOnce('main\n')   // git rev-parse
      .mockReturnValueOnce('');          // git status --porcelain (clean)

    const result = getGitInfo('/some/dir');

    expect(result).toEqual({ branch: 'main', dirty: false });
    expect(mockExecSync).toHaveBeenCalledWith(
      'git rev-parse --abbrev-ref HEAD',
      expect.objectContaining({ cwd: '/some/dir' })
    );
  });

  it('should detect dirty state from porcelain output', () => {
    mockExecSync
      .mockReturnValueOnce('feature/test\n')
      .mockReturnValueOnce(' M src/index.ts\n');  // modified file

    const result = getGitInfo('/some/dir');

    expect(result).toEqual({ branch: 'feature/test', dirty: true });
  });

  it('should return null branch when not in a git repo', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });

    const result = getGitInfo('/not/a/repo');

    expect(result).toEqual({ branch: null, dirty: false });
  });

  it('should treat as clean if git status fails but branch succeeds', () => {
    mockExecSync
      .mockReturnValueOnce('main\n')
      .mockImplementationOnce(() => {
        throw new Error('git status failed');
      });

    const result = getGitInfo('/some/dir');

    expect(result).toEqual({ branch: 'main', dirty: false });
  });

  it('should handle empty branch name', () => {
    mockExecSync
      .mockReturnValueOnce('\n')
      .mockReturnValueOnce('');

    const result = getGitInfo('/some/dir');

    expect(result).toEqual({ branch: null, dirty: false });
  });

  it('should use provided cwd', () => {
    mockExecSync
      .mockReturnValueOnce('main\n')
      .mockReturnValueOnce('');

    getGitInfo('/custom/path');

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: '/custom/path' })
    );
  });

  it('should work without cwd parameter', () => {
    mockExecSync
      .mockReturnValueOnce('main\n')
      .mockReturnValueOnce('');

    const result = getGitInfo();

    expect(result).toEqual({ branch: 'main', dirty: false });
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: undefined })
    );
  });
});
