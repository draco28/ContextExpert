/**
 * TUI Types and Interfaces
 *
 * Core type definitions for the TUI system including:
 * - Agent mode and phase enums for state management
 * - Status line state structure
 * - Terminal region definitions
 * - Configuration options
 */

/**
 * Agent operating mode.
 * Determines what actions are allowed and visual styling.
 *
 * These modes implement "mode-based trust boundaries" - a UX pattern
 * that reduces automation anxiety by making it visually obvious
 * whether the agent can modify files.
 */
export enum AgentMode {
  /** Read-only exploration - safe, can't modify files */
  PLANNING = 'planning',
  /** Write access enabled - can modify files */
  EXECUTING = 'executing',
  /** Suspended, waiting for user input */
  PAUSED = 'paused',
}

/**
 * Current activity phase within a mode.
 * Used for spinner/activity indicator states.
 */
export enum AgentPhase {
  /** Processing input, reasoning about response */
  THINKING = 'thinking',
  /** Executing a tool (file read, search, etc.) */
  TOOL_USE = 'tool_use',
  /** Streaming LLM response to output */
  STREAMING = 'streaming',
  /** Waiting for user input */
  IDLE = 'idle',
}

/**
 * Terminal region coordinates.
 * Used by TerminalRegionManager to track layout positions.
 */
export interface RegionBounds {
  /** First row of the region (1-indexed) */
  startRow: number;
  /** Last row of the region (1-indexed) */
  endRow: number;
}

/**
 * Token usage tracking for context gauge display.
 */
export interface TokenUsageState {
  /** Tokens used in current conversation */
  used: number;
  /** Total context window size */
  total: number;
  /** Threshold for yellow warning (e.g., 0.8 = 80%) */
  warningThreshold: number;
  /** Threshold for red danger (e.g., 0.95 = 95%) */
  dangerThreshold: number;
}

/**
 * Cost tracking for status bar display.
 */
export interface CostState {
  /** Total cost in USD for current session */
  totalUsd: number;
  /** Optional budget limit - triggers warnings when approached */
  budgetUsd?: number;
}

/**
 * Current activity description for status bar.
 */
export interface ActivityState {
  /** Current tool being used (e.g., 'read_file', 'search') */
  tool?: string;
  /** Human-readable description (e.g., 'Reading src/index.ts') */
  description?: string;
}

/**
 * Model information for status bar.
 */
export interface ModelState {
  /** Display name (e.g., 'Claude 3.5 Sonnet') */
  name: string;
  /** Provider name (e.g., 'anthropic', 'openai') */
  provider: string;
}

/**
 * Complete status line state.
 * All information needed to render the status bar.
 */
export interface StatusLineState {
  /** Current agent mode (determines color/styling) */
  mode: AgentMode;
  /** Current activity phase (for spinner states) */
  phase: AgentPhase;
  /** Token/context usage */
  tokens: TokenUsageState;
  /** Session cost tracking */
  cost: CostState;
  /** Current activity (tool usage) */
  activity: ActivityState;
  /** Active model info */
  model: ModelState;
  /** Currently focused project name (null = no project) */
  project: string | null;
  /** Current git branch (null = not in git repo) */
  gitBranch: string | null;
  /** Background indexing progress (if active) */
  indexingStatus?: {
    projectName: string;
    progress: number;
    stage: string;
  };
}

/**
 * Chat message roles.
 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'info';

/**
 * RAG source reference for citations.
 */
export interface SourceReference {
  /** File path relative to project root */
  path: string;
  /** Line numbers if applicable */
  lines?: { start: number; end: number };
  /** Relevance score (0-1) */
  score?: number;
  /** Snippet of matched content */
  snippet?: string;
}

/**
 * Chat message for display in the chat area.
 */
export interface DisplayMessage {
  /** Unique message ID */
  id: string;
  /** Message role (determines styling) */
  role: MessageRole;
  /** Message content (may contain markdown) */
  content: string;
  /** When the message was created */
  timestamp: Date;
  /** RAG sources (for assistant messages) */
  sources?: SourceReference[];
  /** Is this message currently being streamed? */
  isStreaming?: boolean;
}

/**
 * TUI configuration options.
 */
export interface TUIConfig {
  /** Status bar configuration */
  statusBar: {
    /** Position relative to screen */
    position: 'top' | 'bottom';
    /** Height in lines (usually 1-2) */
    height: number;
  };
  /** Chat area configuration */
  chatArea: {
    /** Enable markdown rendering */
    enableMarkdown: boolean;
    /** Timestamp format (null = no timestamps) */
    timestampFormat?: string;
  };
  /** Input area configuration */
  inputArea: {
    /** Height in lines */
    height: number;
    /** Allow multi-line input (for pasting) */
    multilineEnabled: boolean;
  };
  /** Color configuration */
  colors: {
    /** Mode indicator colors */
    modeColors: Record<AgentMode, string>;
  };
}

/**
 * Default TUI configuration.
 * Provides sensible defaults based on Claude Code and agentic CLI UX research.
 */
export const DEFAULT_TUI_CONFIG: TUIConfig = {
  statusBar: {
    position: 'bottom',
    height: 1,
  },
  chatArea: {
    enableMarkdown: true,
    timestampFormat: undefined, // No timestamps by default
  },
  inputArea: {
    height: 1,
    multilineEnabled: true,
  },
  colors: {
    modeColors: {
      [AgentMode.PLANNING]: 'cyan',
      [AgentMode.EXECUTING]: 'yellow',
      [AgentMode.PAUSED]: 'gray',
    },
  },
};
