# ADR 001: TUI Architecture for `ctx chat`

**Status**: Accepted
**Date**: 2026-02-05
**Context**: Ticket #109 — TUI Architecture

## Context

The `ctx chat` command used a basic readline REPL. Users needed:
- A fixed status bar showing mode, context gauge, cost, and current activity
- A scrollable chat area for messages and streaming LLM responses
- An input area that stays in place during output scrolling

The challenge is creating a 3-region terminal layout where the chat area scrolls independently while the status bar and input remain fixed.

## Decision

Use **manual ANSI escape sequences** (DECSTBM scroll regions) instead of a terminal UI framework like Ink or Blessed.

### Layout

```
Row 1     +-------------------------------+
          |                               |
          |     Chat Area (scrolls)       |  <- DECSTBM scroll region
          |                               |
Row N-2   +-------------------------------+
Row N-1   | Status Bar (fixed)            |  <- Written via CUP
Row N     | Input Area (fixed, readline)  |  <- readline manages this
```

### Key Technique: DECSTBM Scroll Regions

`CSI n;m r` (Set Top and Bottom Margins) restricts scrolling to rows n through m. Content written to the chat area scrolls within this region; the status bar and input area below the margin boundary stay fixed.

### Cursor Positioning Strategy

- **Status bar updates**: Use `SAVE_CURSOR` / `RESTORE_CURSOR` (DEC private `ESC 7` / `ESC 8`) since they are quick atomic operations
- **Streaming output**: Use **CUP** (`CSI row;col H`) for absolute positioning instead of SAVE/RESTORE, avoiding contention with concurrent status bar updates (DEC terminals have only a single save slot)

## Alternatives Considered

### Ink (React for CLI)

- **Pros**: Declarative component model, handles layout automatically
- **Cons**: React runtime overhead (~300KB bundle), reconciler adds latency for streaming, large dependency tree, doesn't match existing terminal output patterns (chalk, ora)

### Blessed / blessed-contrib

- **Pros**: Full widget toolkit with borders, scrollable panels
- **Cons**: Unmaintained (last release 2017), heavy dependency, complex API for a simple 3-region layout

### Raw alternate screen (no scroll regions)

- **Pros**: Simpler — just redraw the entire screen each frame
- **Cons**: Flickering on fast updates, loses scrollback history, higher CPU for full redraws during streaming

## Consequences

### Positive

- Zero runtime dependencies beyond chalk (already used)
- Full control over cursor positioning and scroll behavior
- Streaming writes directly to stdout with no React reconciliation overhead
- Small code footprint (~450 lines for all TUI components)

### Negative

- More low-level code to maintain (ANSI sequences, region math)
- Must handle edge cases manually (resize, EPIPE, tiny terminals)
- No ready-made widget library for future complex UIs

### Mitigations

- Comprehensive test suite for region bounds, ANSI output, and edge cases
- Constants for all escape sequences (no magic strings)
- `--no-tui` flag provides fallback to classic readline REPL

## References

- [DECSTBM specification](https://gist.github.com/christianparpart/d8a62cc1ab659194337d73e399004036)
- `.claude/CLI Coding Agent UX Research.md` — Research on agentic CLI patterns
