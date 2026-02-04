/**
 * TUI Module
 *
 * A terminal user interface system for Context_Expert chat mode.
 * Provides fixed screen regions for status, chat, and input.
 *
 * Architecture:
 * - TerminalRegionManager: ANSI scroll regions for fixed layout
 * - StatusLineRenderer: Status bar with mode, context, cost
 * - ChatAreaManager: Scrollable message display
 * - InputManager: Readline wrapper with TUI coordination
 * - TUIController: Orchestrates all components
 *
 * Usage:
 * ```typescript
 * import { TUIController, startTUI } from './tui/index.js';
 *
 * // Simple usage with startTUI
 * const tui = await startTUI({
 *   model: { name: 'Claude 3.5 Sonnet', provider: 'anthropic' },
 *   project: 'my-project',
 *   completer: myTabCompleter,
 *   onLine: async (line) => {
 *     // Handle user input
 *   },
 * });
 *
 * // Or manual control with TUIController
 * const tui = new TUIController({ ... });
 * tui.onLine(handler);
 * tui.start(completer);
 * ```
 */

// Types
export {
  AgentMode,
  AgentPhase,
  type RegionBounds,
  type TokenUsageState,
  type CostState,
  type ActivityState,
  type ModelState,
  type StatusLineState,
  type MessageRole,
  type SourceReference,
  type DisplayMessage,
  type TUIConfig,
  DEFAULT_TUI_CONFIG,
} from './types.js';

// Terminal Region Manager
export {
  TerminalRegionManager,
  createTerminalRegionManager,
  ANSI,
  type TerminalRegionManagerOptions,
  type TerminalRegionManagerEvents,
} from './terminal-regions.js';

// Status Line Renderer
export {
  StatusLineRenderer,
  createStatusLineRenderer,
  toolToDescription,
  DEFAULT_STATUS_STATE,
  type StatusLineRendererOptions,
} from './status-line.js';

// Chat Area Manager
export {
  ChatAreaManager,
  createChatAreaManager,
  type ChatAreaManagerOptions,
} from './chat-area.js';

// Input Manager
export {
  InputManager,
  createInputManager,
  type Completer,
  type InputManagerOptions,
} from './input-manager.js';

// TUI Controller (main integration point)
export {
  TUIController,
  startTUI,
  type StreamChunk,
  type TUIControllerOptions,
  type TUIControllerEvents,
} from './controller.js';
