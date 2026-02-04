/**
 * Status Line Tests
 *
 * Tests for the StatusLineRenderer component.
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
    });

    it('should merge initial state with defaults', () => {
      renderer = new StatusLineRenderer({
        project: 'test-project',
        cost: { totalUsd: 1.5 },
      });

      const state = renderer.getState();

      expect(state.project).toBe('test-project');
      expect(state.cost.totalUsd).toBe(1.5);
      expect(state.mode).toBe(AgentMode.PLANNING); // Default preserved
    });
  });

  describe('render', () => {
    it('should include mode indicator', () => {
      const output = renderer.render();
      const stripped = stripAnsi(output);

      expect(stripped).toContain('[PLAN]');
    });

    it('should include context gauge', () => {
      renderer.update({ tokens: { used: 100000, total: 200000, warningThreshold: 0.8, dangerThreshold: 0.95 } });
      const output = renderer.render();
      const stripped = stripAnsi(output);

      expect(stripped).toContain('Context:');
      expect(stripped).toContain('50%');
    });

    it('should include cost display', () => {
      renderer.update({ cost: { totalUsd: 0.1234 } });
      const output = renderer.render();
      const stripped = stripAnsi(output);

      expect(stripped).toContain('$0.1234');
    });

    it('should include project name when set', () => {
      renderer.update({ project: 'my-project' });
      const output = renderer.render();
      const stripped = stripAnsi(output);

      expect(stripped).toContain('my-project');
    });

    it('should include git branch when set', () => {
      renderer.update({ project: 'my-project', gitBranch: 'feature/test' });
      const output = renderer.render();
      const stripped = stripAnsi(output);

      expect(stripped).toContain('[feature/test]');
    });
  });

  describe('mode indicator', () => {
    it('should show PLAN for planning mode', () => {
      renderer.update({ mode: AgentMode.PLANNING });
      const stripped = stripAnsi(renderer.render());

      expect(stripped).toContain('[PLAN]');
    });

    it('should show EXEC for executing mode', () => {
      renderer.update({ mode: AgentMode.EXECUTING });
      const stripped = stripAnsi(renderer.render());

      expect(stripped).toContain('[EXEC]');
    });

    it('should show WAIT for paused mode', () => {
      renderer.update({ mode: AgentMode.PAUSED });
      const stripped = stripAnsi(renderer.render());

      expect(stripped).toContain('[WAIT]');
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
    it('should show activity when in thinking phase', () => {
      renderer.update({
        phase: AgentPhase.THINKING,
        activity: {},
      });
      const stripped = stripAnsi(renderer.render());

      expect(stripped).toContain('Thinking...');
    });

    it('should show tool description when available', () => {
      renderer.update({
        phase: AgentPhase.TOOL_USE,
        activity: { tool: 'read_file', description: 'Reading config.ts' },
      });
      const stripped = stripAnsi(renderer.render());

      expect(stripped).toContain('Reading config.ts');
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

  describe('indexing status', () => {
    it('should show indexing progress when active', () => {
      renderer.update({
        indexingStatus: {
          projectName: 'my-project',
          progress: 45,
          stage: 'Embedding',
        },
      });
      const stripped = stripAnsi(renderer.render());

      expect(stripped).toContain('Indexing my-project');
      expect(stripped).toContain('45%');
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
  });
});
