/**
 * Status Line Tests
 *
 * Tests for the StatusLineRenderer component (Claude Code-inspired layout).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  StatusLineRenderer,
  createStatusLineRenderer,
  toolToDescription,
  DEFAULT_STATUS_STATE,
} from '../status-line.js';
import { AgentMode, AgentPhase } from '../types.js';

// Helper to strip ANSI codes for easier assertions
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('StatusLineRenderer', () => {
  let renderer: StatusLineRenderer;

  beforeEach(() => {
    renderer = new StatusLineRenderer();
  });

  describe('initialization', () => {
    it('should create with default state', () => {
      const state = renderer.getState();

      expect(state.mode).toBe(AgentMode.PLANNING);
      expect(state.phase).toBe(AgentPhase.IDLE);
      expect(state.tokens.used).toBe(0);
      expect(state.cost.totalUsd).toBe(0);
      expect(state.turnCount).toBe(0);
      expect(state.gitDirty).toBe(false);
      expect(state.workingDirectory).toBeNull();
    });

    it('should merge initial state with defaults', () => {
      renderer = new StatusLineRenderer({
        project: 'test-project',
        cost: { totalUsd: 1.5 },
        turnCount: 5,
      });

      const state = renderer.getState();

      expect(state.project).toBe('test-project');
      expect(state.cost.totalUsd).toBe(1.5);
      expect(state.turnCount).toBe(5);
      expect(state.mode).toBe(AgentMode.PLANNING); // Default preserved
    });
  });

  describe('render', () => {
    it('should include model name when set', () => {
      renderer.update({ model: { name: 'claude-3.5-sonnet', provider: 'anthropic' } });
      const stripped = stripAnsi(renderer.render());

      expect(stripped).toContain('claude-3.5-sonnet');
    });

    it('should not include model name when set to Unknown', () => {
      const stripped = stripAnsi(renderer.render());

      // Default model is 'Unknown', should not be rendered
      expect(stripped).not.toContain('Unknown');
    });

    it('should not include model name when showModel is false', () => {
      const r = new StatusLineRenderer(
        { model: { name: 'claude-3.5-sonnet', provider: 'anthropic' } },
        { showModel: false, terminalWidth: 120 }
      );
      const stripped = stripAnsi(r.render());

      expect(stripped).not.toContain('claude-3.5-sonnet');
    });

    it('should include context gauge', () => {
      renderer.update({ tokens: { used: 100000, total: 200000, warningThreshold: 0.8, dangerThreshold: 0.95 } });
      const output = renderer.render();
      const stripped = stripAnsi(output);

      expect(stripped).toContain('50%');
    });

    it('should include cost display with 2 decimal places', () => {
      renderer.update({ cost: { totalUsd: 0.1234 } });
      const output = renderer.render();
      const stripped = stripAnsi(output);

      expect(stripped).toContain('$0.12');
    });

    it('should include location when project is set', () => {
      renderer.update({ project: 'my-project' });
      const stripped = stripAnsi(renderer.render());

      expect(stripped).toContain('my-project');
    });

    it('should prefer workingDirectory over project in location', () => {
      renderer = new StatusLineRenderer(
        { project: 'my-project', workingDirectory: '~/projects/my-project' },
        { terminalWidth: 120 }
      );
      const stripped = stripAnsi(renderer.render());

      expect(stripped).toContain('~/projects/my-project');
    });

    it('should include git branch without brackets', () => {
      renderer = new StatusLineRenderer(
        { project: 'my-project', gitBranch: 'feature/test' },
        { terminalWidth: 120 }
      );
      const stripped = stripAnsi(renderer.render());

      expect(stripped).toContain('feature/test');
      expect(stripped).not.toContain('[feature/test]');
    });

    it('should show git dirty indicator', () => {
      renderer = new StatusLineRenderer(
        { project: 'my-project', gitBranch: 'main', gitDirty: true },
        { terminalWidth: 120 }
      );
      const stripped = stripAnsi(renderer.render());

      expect(stripped).toContain('main*');
    });

    it('should not show dirty indicator when clean', () => {
      renderer = new StatusLineRenderer(
        { project: 'my-project', gitBranch: 'main', gitDirty: false },
        { terminalWidth: 120 }
      );
      const stripped = stripAnsi(renderer.render());

      expect(stripped).toContain('main');
      expect(stripped).not.toContain('main*');
    });

    it('should include turn count', () => {
      renderer.update({ turnCount: 3 });
      const stripped = stripAnsi(renderer.render());

      expect(stripped).toContain('3 turns');
    });

    it('should singularize turn count for 1', () => {
      renderer.update({ turnCount: 1 });
      const stripped = stripAnsi(renderer.render());

      expect(stripped).toContain('1 turn');
      expect(stripped).not.toContain('1 turns');
    });

    it('should not include mode indicator', () => {
      // Mode indicator has been removed from the layout
      const stripped = stripAnsi(renderer.render());

      expect(stripped).not.toContain('[PLAN]');
      expect(stripped).not.toContain('[EXEC]');
      expect(stripped).not.toContain('[WAIT]');
    });
  });

  describe('context gauge', () => {
    it('should show warning at 80% threshold', () => {
      renderer.update({
        tokens: {
          used: 160000,
          total: 200000,
          warningThreshold: 0.8,
          dangerThreshold: 0.95,
        },
      });
      const stripped = stripAnsi(renderer.render());

      expect(stripped).toContain('80%');
    });

    it('should cap at 100%', () => {
      renderer.update({
        tokens: {
          used: 250000,
          total: 200000,
          warningThreshold: 0.8,
          dangerThreshold: 0.95,
        },
      });
      const stripped = stripAnsi(renderer.render());

      // Should show as 125% but the bar should be capped
      expect(stripped).toContain('125%');
    });
  });

  describe('activity indicator', () => {
    it('should show phase icon with activity when thinking', () => {
      renderer = new StatusLineRenderer(
        { phase: AgentPhase.THINKING, activity: {} },
        { terminalWidth: 120 }
      );
      const stripped = stripAnsi(renderer.render());

      expect(stripped).toContain('◐ Thinking...');
    });

    it('should show phase icon with tool description', () => {
      renderer = new StatusLineRenderer(
        {
          phase: AgentPhase.TOOL_USE,
          activity: { tool: 'read_file', description: 'Reading config.ts' },
        },
        { terminalWidth: 120 }
      );
      const stripped = stripAnsi(renderer.render());

      expect(stripped).toContain('⚡ Reading config.ts');
    });

    it('should show streaming icon when streaming', () => {
      renderer = new StatusLineRenderer(
        { phase: AgentPhase.STREAMING, activity: {} },
        { terminalWidth: 120 }
      );
      const stripped = stripAnsi(renderer.render());

      expect(stripped).toContain('▸ Responding...');
    });

    it('should not show activity when idle', () => {
      renderer.update({
        phase: AgentPhase.IDLE,
        activity: { description: 'Should not show' },
      });
      const stripped = stripAnsi(renderer.render());

      expect(stripped).not.toContain('Should not show');
    });
  });

  describe('segment-level truncation', () => {
    it('should drop rightmost segments when overflowing', () => {
      // Very narrow terminal — force overflow
      const narrow = new StatusLineRenderer(
        {
          model: { name: 'claude-3.5-sonnet', provider: 'anthropic' },
          workingDirectory: '~/projects/my-long-project-name',
          gitBranch: 'feature/very-long-branch-name',
          phase: AgentPhase.TOOL_USE,
          activity: { tool: 'read_file', description: 'Reading a very long file path' },
        },
        { terminalWidth: 40 }
      );

      const output = narrow.render();
      const stripped = stripAnsi(output);

      // Model name (leftmost, highest priority) should always be present
      expect(stripped).toContain('claude-3.5-sonnet');

      // Output should not exceed terminal width
      expect(stripped.length).toBeLessThanOrEqual(40);
    });

    it('should preserve model name when segments are dropped', () => {
      const narrow = new StatusLineRenderer(
        {
          model: { name: 'claude-3.5-sonnet', provider: 'anthropic' },
          workingDirectory: '~/projects/my-long-project-name',
          phase: AgentPhase.TOOL_USE,
          activity: { tool: 'read_file', description: 'Reading very long file path' },
          indexingStatus: { projectName: 'proj', progress: 50, stage: 'Embedding' },
        },
        { terminalWidth: 40 }
      );

      const output = narrow.render();
      const stripped = stripAnsi(output);

      // Model name should be preserved (first segment, highest priority)
      expect(stripped).toContain('claude-3.5-sonnet');

      // Activity or indexing (rightmost segments) should be dropped
      expect(stripped).not.toContain('Reading very long file path');
    });
  });

  describe('indexing status', () => {
    it('should show indexing progress when active', () => {
      // Use a wide renderer so the indexing segment isn't truncated
      const wideRenderer = new StatusLineRenderer({}, { terminalWidth: 120 });
      wideRenderer.update({
        indexingStatus: {
          projectName: 'my-project',
          progress: 45,
          stage: 'Embedding',
        },
      });
      const stripped = stripAnsi(wideRenderer.render());

      expect(stripped).toContain('Indexing my-project');
      expect(stripped).toContain('45%');
    });
  });

  describe('full layout integration', () => {
    it('should render complete Claude Code-style layout', () => {
      const r = new StatusLineRenderer(
        {
          model: { name: 'claude-3.5-sonnet', provider: 'anthropic' },
          workingDirectory: '~/projects/my-app',
          gitBranch: 'main',
          gitDirty: true,
          tokens: { used: 84000, total: 200000, warningThreshold: 0.8, dangerThreshold: 0.95 },
          cost: { totalUsd: 0.05 },
          turnCount: 3,
        },
        { terminalWidth: 120 }
      );

      const stripped = stripAnsi(r.render());

      // All segments should be present in order
      expect(stripped).toContain('claude-3.5-sonnet');
      expect(stripped).toContain('~/projects/my-app');
      expect(stripped).toContain('main*');
      expect(stripped).toContain('42%');
      expect(stripped).toContain('$0.05');
      expect(stripped).toContain('3 turns');

      // Model name should come first
      const modelIdx = stripped.indexOf('claude-3.5-sonnet');
      const pathIdx = stripped.indexOf('~/projects/my-app');
      const costIdx = stripped.indexOf('$0.05');
      expect(modelIdx).toBeLessThan(pathIdx);
      expect(pathIdx).toBeLessThan(costIdx);
    });
  });
});

describe('createStatusLineRenderer', () => {
  it('should create renderer with factory function', () => {
    const renderer = createStatusLineRenderer(
      { project: 'test' },
      { terminalWidth: 120 }
    );

    expect(renderer).toBeInstanceOf(StatusLineRenderer);
    expect(renderer.getState().project).toBe('test');
  });
});

describe('toolToDescription', () => {
  it('should generate description for read_file', () => {
    const desc = toolToDescription('read_file', { path: 'src/index.ts' });
    expect(desc).toBe('Reading src/index.ts');
  });

  it('should generate description for search_files', () => {
    const desc = toolToDescription('search_files', { pattern: 'TODO' });
    expect(desc).toBe('Searching for "TODO"');
  });

  it('should generate description for web_fetch', () => {
    const desc = toolToDescription('web_fetch', { url: 'https://example.com/api' });
    expect(desc).toBe('Fetching example.com');
  });

  it('should fallback for unknown tools', () => {
    const desc = toolToDescription('custom_tool', {});
    expect(desc).toBe('Using custom_tool');
  });
});

describe('DEFAULT_STATUS_STATE', () => {
  it('should have sensible defaults', () => {
    expect(DEFAULT_STATUS_STATE.mode).toBe(AgentMode.PLANNING);
    expect(DEFAULT_STATUS_STATE.phase).toBe(AgentPhase.IDLE);
    expect(DEFAULT_STATUS_STATE.tokens.total).toBe(200000);
    expect(DEFAULT_STATUS_STATE.tokens.warningThreshold).toBe(0.8);
    expect(DEFAULT_STATUS_STATE.cost.totalUsd).toBe(0);
    expect(DEFAULT_STATUS_STATE.turnCount).toBe(0);
    expect(DEFAULT_STATUS_STATE.gitDirty).toBe(false);
    expect(DEFAULT_STATUS_STATE.workingDirectory).toBeNull();
  });
});
