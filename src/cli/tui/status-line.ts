/**
 * Status Line Renderer
 *
 * Renders a Claude Code-inspired status bar HUD with:
 * - Model name (prominent, first position)
 * - Location (working directory + git branch + dirty indicator)
 * - Context gauge (token usage visualization with bar)
 * - Cost tracker (running USD total)
 * - Turn counter (user-assistant exchange count)
 * - Activity indicator (phase icon + current tool/action)
 *
 * Design principles from agentic CLI UX research:
 * - "Transparency Over Magic" - users must always know what's happening
 * - "Progressive Disclosure" - essential info visible, details on demand
 * - Color encodes meaning (green=safe, yellow=caution, red=danger)
 *
 * @see /Users/draco/projects/Context_Expert/.claude/skills/agentic-cli-ux/SKILL.md
 */

import chalk, { type ChalkInstance } from 'chalk';
import {
  AgentMode,
  AgentPhase,
  type StatusLineState,
} from './types.js';

/** Pattern matching ANSI escape sequences (CSI, DEC save/restore, OSC). */
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\x1b[78]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Default status line state.
 * Provides sensible defaults for initialization.
 */
export const DEFAULT_STATUS_STATE: StatusLineState = {
  mode: AgentMode.PLANNING,
  phase: AgentPhase.IDLE,
  tokens: {
    used: 0,
    total: 200000, // 200k default context window
    warningThreshold: 0.8,
    dangerThreshold: 0.95,
  },
  cost: {
    totalUsd: 0,
  },
  activity: {},
  model: {
    name: 'Unknown',
    provider: 'unknown',
  },
  project: null,
  gitBranch: null,
  gitDirty: false,
  workingDirectory: null,
  turnCount: 0,
};

/**
 * Color configuration for mode indicators.
 * Maps each mode to a chalk color function.
 */
const MODE_COLORS: Record<AgentMode, ChalkInstance> = {
  [AgentMode.PLANNING]: chalk.cyan,
  [AgentMode.EXECUTING]: chalk.yellow,
  [AgentMode.PAUSED]: chalk.gray,
};

/**
 * Mode labels for display.
 */
const MODE_LABELS: Record<AgentMode, string> = {
  [AgentMode.PLANNING]: 'PLAN',
  [AgentMode.EXECUTING]: 'EXEC',
  [AgentMode.PAUSED]: 'WAIT',
};

/**
 * Phase icons for activity spinner.
 * Unicode characters that indicate current activity.
 */
const PHASE_ICONS: Record<AgentPhase, string> = {
  [AgentPhase.THINKING]: '◐', // Rotating moon phases work well
  [AgentPhase.TOOL_USE]: '⚡',
  [AgentPhase.STREAMING]: '▸',
  [AgentPhase.IDLE]: '●',
};

/**
 * Options for StatusLineRenderer.
 */
export interface StatusLineRendererOptions {
  /** Terminal width for truncation (default: 80) */
  terminalWidth?: number;
  /** Show git branch in status (default: true) */
  showGitBranch?: boolean;
  /** Show model name in status (default: true) */
  showModel?: boolean;
  /** Separator between status sections */
  separator?: string;
}

/**
 * Renders the status line for the TUI (Claude Code-inspired layout).
 *
 * Example output:
 * ```
 * claude-3.5-sonnet │ ~/projects/my-project main* │ ████░░░░░░ 42% │ $0.02 │ 3 turns │ ⚡ Reading src/index.ts
 * ```
 */
export class StatusLineRenderer {
  private state: StatusLineState;
  private terminalWidth: number;
  private showGitBranch: boolean;
  /** Whether to show model name in status bar */
  readonly showModel: boolean;
  private separator: string;

  constructor(
    initialState: Partial<StatusLineState> = {},
    options: StatusLineRendererOptions = {}
  ) {
    this.state = { ...DEFAULT_STATUS_STATE, ...initialState };
    this.terminalWidth = options.terminalWidth ?? 80;
    this.showGitBranch = options.showGitBranch ?? true;
    this.showModel = options.showModel ?? true;
    this.separator = options.separator ?? chalk.dim(' │ ');
  }

  /**
   * Update state and return new rendered string.
   *
   * @param partial - Partial state update
   * @returns The rendered status line string
   */
  update(partial: Partial<StatusLineState>): string {
    // Deep merge for nested objects
    this.state = {
      ...this.state,
      ...partial,
      tokens: { ...this.state.tokens, ...(partial.tokens ?? {}) },
      cost: { ...this.state.cost, ...(partial.cost ?? {}) },
      activity: { ...this.state.activity, ...(partial.activity ?? {}) },
      model: { ...this.state.model, ...(partial.model ?? {}) },
    };
    return this.render();
  }

  /**
   * Get current state.
   */
  getState(): StatusLineState {
    return { ...this.state };
  }

  /**
   * Set terminal width for truncation calculations.
   */
  setTerminalWidth(width: number): void {
    this.terminalWidth = width;
  }

  /**
   * Render the complete status line as a formatted string.
   *
   * Segment order (left = highest priority for truncation survival):
   * 1. Model name
   * 2. Location (path + branch + dirty)
   * 3. Context gauge (visual bar)
   * 4. Cost
   * 5. Turn count
   * 6. Activity (with phase icon)
   * 7. Indexing status
   */
  render(): string {
    const parts: string[] = [];

    // Model name (first position, most prominent)
    const modelPart = this.renderModel();
    if (modelPart) {
      parts.push(modelPart);
    }

    // Location (working directory + git branch + dirty)
    const locationPart = this.renderLocation();
    if (locationPart) {
      parts.push(locationPart);
    }

    // Context gauge
    parts.push(this.renderContextGauge());

    // Cost
    parts.push(this.renderCost());

    // Turn count
    parts.push(this.renderTurns());

    // Activity (if active, with phase icon)
    const activityPart = this.renderActivity();
    if (activityPart) {
      parts.push(activityPart);
    }

    // Background indexing status (if active)
    const indexingPart = this.renderIndexingStatus();
    if (indexingPart) {
      parts.push(indexingPart);
    }

    // Progressive truncation: drop rightmost (least important) segments
    // until the line fits, preserving chalk colors on remaining segments.
    let line = parts.join(this.separator);
    while (parts.length > 1 && this.visibleLength(line) > this.terminalWidth) {
      parts.pop();
      line = parts.join(this.separator);
    }

    // Final character-level truncation only if a single segment overflows
    return this.truncate(line);
  }

  /**
   * Render model name.
   * Returns null if showModel is false or model is unknown.
   */
  private renderModel(): string | null {
    if (!this.showModel) {
      return null;
    }

    const { model } = this.state;
    if (!model.name || model.name === 'Unknown') {
      return null;
    }

    return chalk.bold(model.name);
  }

  /**
   * Render working directory path and git branch with dirty indicator.
   * Prefers workingDirectory over project name.
   */
  private renderLocation(): string | null {
    const { workingDirectory, project, gitBranch, gitDirty } = this.state;

    // Prefer workingDirectory; fall back to project name
    const pathDisplay = workingDirectory ?? project;
    if (!pathDisplay) {
      return null;
    }

    let display = chalk.bold(pathDisplay);

    if (this.showGitBranch && gitBranch) {
      const branchStr = gitDirty ? `${gitBranch}*` : gitBranch;
      display += ' ' + chalk.cyan(branchStr);
    }

    return display;
  }

  /**
   * Render the context gauge (token usage visualization).
   *
   * Visual design:
   * - Green when < 60% used
   * - Yellow when 60-80% used (warning zone)
   * - Red when > 80% used (danger zone)
   * - Bar uses █ (filled) and ░ (empty) characters
   */
  private renderContextGauge(): string {
    const { tokens } = this.state;
    const percentage = tokens.total > 0 ? tokens.used / tokens.total : 0;
    const percentDisplay = Math.round(percentage * 100);

    // Visual bar width (10 characters is a good balance)
    const barWidth = 10;
    const filledCount = Math.round(barWidth * Math.min(percentage, 1));
    const emptyCount = barWidth - filledCount;

    // Choose color based on thresholds
    let barColor: ChalkInstance;
    if (percentage >= tokens.dangerThreshold) {
      barColor = chalk.red;
    } else if (percentage >= tokens.warningThreshold) {
      barColor = chalk.yellow;
    } else if (percentage >= 0.6) {
      barColor = chalk.yellow;
    } else {
      barColor = chalk.green;
    }

    const filledBar = barColor('█'.repeat(filledCount));
    const emptyBar = chalk.dim('░'.repeat(emptyCount));
    const percentStr = barColor(`${percentDisplay}%`);

    return `Context: ${filledBar}${emptyBar} ${percentStr}`;
  }

  /**
   * Render the cost display.
   *
   * Colors:
   * - Green when < $0.50
   * - Yellow when $0.50-$1.00
   * - Red when > $1.00
   *
   * Shows budget progress if budget is set.
   */
  private renderCost(): string {
    const { cost } = this.state;
    const total = cost.totalUsd;

    // Format to 2 decimal places for compact display
    const formatted = total.toFixed(2);

    // Choose color based on cost
    let color: ChalkInstance;
    if (total >= 1.0) {
      color = chalk.red;
    } else if (total >= 0.5) {
      color = chalk.yellow;
    } else {
      color = chalk.green;
    }

    let display = color(`$${formatted}`);

    // Add budget indicator if set
    if (cost.budgetUsd !== undefined && cost.budgetUsd > 0) {
      const budgetPercent = Math.round((total / cost.budgetUsd) * 100);
      display += chalk.dim(` / $${cost.budgetUsd.toFixed(2)}`);
      if (budgetPercent >= 90) {
        display += chalk.red.bold(` (${budgetPercent}%!)`);
      } else if (budgetPercent >= 70) {
        display += chalk.yellow(` (${budgetPercent}%)`);
      }
    }

    return display;
  }

  /**
   * Render the turn counter.
   */
  private renderTurns(): string {
    const { turnCount } = this.state;
    return chalk.dim(`${turnCount} turn${turnCount !== 1 ? 's' : ''}`);
  }

  /**
   * Render current activity description with phase icon prefix.
   * Returns null if no activity is in progress.
   */
  private renderActivity(): string | null {
    const { activity, phase } = this.state;

    // Only show activity when actively doing something
    if (phase === AgentPhase.IDLE) {
      return null;
    }

    const icon = PHASE_ICONS[phase];
    let text: string;

    if (activity.description) {
      text = activity.description;
    } else if (activity.tool) {
      text = `Using ${activity.tool}...`;
    } else {
      // Phase-based generic messages
      switch (phase) {
        case AgentPhase.THINKING:
          text = 'Thinking...';
          break;
        case AgentPhase.STREAMING:
          text = 'Responding...';
          break;
        case AgentPhase.TOOL_USE:
          text = 'Working...';
          break;
        default:
          return null;
      }
    }

    return chalk.dim(`${icon} ${text}`);
  }

  /**
   * Render background indexing status.
   */
  private renderIndexingStatus(): string | null {
    const { indexingStatus } = this.state;

    if (!indexingStatus) {
      return null;
    }

    const { projectName, progress, stage } = indexingStatus;
    const percent = Math.round(progress);

    return chalk.blue(`📦 Indexing ${projectName}: ${stage} ${percent}%`);
  }

  /**
   * Measure visible width of a string, excluding ANSI escape sequences.
   */
  private visibleLength(str: string): number {
    return str.replace(ANSI_ESCAPE_PATTERN, '').length;
  }

  /**
   * Truncate string to fit terminal width.
   * Strips ANSI codes to measure visible width, then truncates plain text
   * on overflow. Only used as a last resort when even a single segment
   * overflows — segment-level truncation in render() handles the common case.
   */
  private truncate(str: string): string {
    const visible = str.replace(ANSI_ESCAPE_PATTERN, '');
    if (visible.length <= this.terminalWidth) {
      return str;
    }
    // Strip ANSI and truncate plain text to avoid cutting mid-escape
    return visible.slice(0, this.terminalWidth - 1) + '…';
  }
}

/**
 * Create a pre-configured status line renderer.
 */
export function createStatusLineRenderer(
  initialState?: Partial<StatusLineState>,
  options?: StatusLineRendererOptions
): StatusLineRenderer {
  return new StatusLineRenderer(initialState, options);
}

/**
 * Utility: Convert tool name to human-readable description.
 *
 * @example
 * toolToDescription('read_file', { path: 'src/index.ts' })
 * // => 'Reading src/index.ts'
 */
export function toolToDescription(tool: string, args?: Record<string, unknown>): string {
  const descriptions: Record<string, (args?: Record<string, unknown>) => string> = {
    read_file: (a) => `Reading ${a?.path ?? 'file'}`,
    write_file: (a) => `Writing ${a?.path ?? 'file'}`,
    edit_file: (a) => `Editing ${a?.path ?? 'file'}`,
    search_files: (a) => `Searching for "${a?.pattern ?? 'pattern'}"`,
    execute_command: (a) => `Running: ${String(a?.command ?? 'command').slice(0, 30)}...`,
    web_fetch: (a) => {
      try {
        const url = new URL(String(a?.url ?? ''));
        return `Fetching ${url.hostname}`;
      } catch {
        return 'Fetching URL';
      }
    },
    glob: (a) => `Finding ${a?.pattern ?? 'files'}`,
    grep: (a) => `Searching for "${a?.pattern ?? 'pattern'}"`,
    retrieve_knowledge: (a) => `Searching: "${String(a?.query ?? 'codebase').slice(0, 40)}"`,
  };

  const descriptor = descriptions[tool];
  return descriptor ? descriptor(args) : `Using ${tool}`;
}
