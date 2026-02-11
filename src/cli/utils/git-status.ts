/**
 * Git Status Utility
 *
 * Lightweight git info extraction for the status bar.
 * Uses execSync since these commands complete in ~5ms
 * and only run at TUI init / on project focus change.
 */

import { execSync } from 'node:child_process';

export interface GitInfo {
  /** Current branch name, or null if not in a git repo */
  branch: string | null;
  /** Whether the working tree has uncommitted changes */
  dirty: boolean;
}

/**
 * Get git branch and dirty state for a directory.
 *
 * @param cwd - Directory to check (defaults to process.cwd())
 * @returns Git info, or { branch: null, dirty: false } if not a git repo
 */
export function getGitInfo(cwd?: string): GitInfo {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    let dirty = false;
    try {
      const status = execSync('git status --porcelain', {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      dirty = status.length > 0;
    } catch {
      // git status failed — treat as clean
    }

    return { branch: branch || null, dirty };
  } catch {
    // Not a git repo or git not installed
    return { branch: null, dirty: false };
  }
}
