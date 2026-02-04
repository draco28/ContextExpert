/**
 * TUI Demo Script
 *
 * Quick visual test of TUI components without needing the full chat system.
 * Run with: npx tsx src/cli/tui/__tests__/demo.ts
 */

import { TerminalRegionManager, ANSI } from '../terminal-regions.js';
import { StatusLineRenderer, toolToDescription } from '../status-line.js';
import { AgentMode, AgentPhase } from '../types.js';
import chalk from 'chalk';

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

async function demo(): Promise<void> {
  const stdout = process.stdout;
  const cols = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;

  console.log(chalk.bold('\n=== TUI Component Demo ===\n'));

  // ─────────────────────────────────────────
  // Demo 1: Status Line Renderer
  // ─────────────────────────────────────────
  console.log(chalk.cyan.bold('1. Status Line Renderer'));
  console.log(chalk.dim(`   Terminal: ${cols}x${rows}`));
  console.log();

  const status = new StatusLineRenderer(
    {
      mode: AgentMode.PLANNING,
      phase: AgentPhase.IDLE,
      model: { name: 'Claude 3.5 Sonnet', provider: 'anthropic' },
      project: 'my-project',
      gitBranch: 'feature/tui',
      tokens: { used: 0, total: 200000, warningThreshold: 0.8, dangerThreshold: 0.95 },
      cost: { totalUsd: 0 },
    },
    { terminalWidth: cols }
  );

  const states = [
    { label: 'Idle (Planning)', update: {} },
    { label: 'Thinking...', update: { phase: AgentPhase.THINKING as const } },
    { label: 'Tool use', update: { phase: AgentPhase.TOOL_USE as const, activity: { tool: 'search_files', description: 'Searching for "handleAuth"' } } },
    { label: 'Streaming', update: { phase: AgentPhase.STREAMING as const, activity: {} } },
    { label: 'Executing mode', update: { mode: AgentMode.EXECUTING as const, phase: AgentPhase.IDLE as const } },
    { label: 'Context 42%', update: { tokens: { used: 84000, total: 200000, warningThreshold: 0.8, dangerThreshold: 0.95 } } },
    { label: 'Context 80% (warning)', update: { tokens: { used: 160000, total: 200000, warningThreshold: 0.8, dangerThreshold: 0.95 } } },
    { label: 'Context 96% (danger)', update: { tokens: { used: 192000, total: 200000, warningThreshold: 0.8, dangerThreshold: 0.95 } } },
    { label: 'Cost $0.50', update: { cost: { totalUsd: 0.5 } } },
    { label: 'Cost $1.50 (high)', update: { cost: { totalUsd: 1.5 } } },
    { label: 'With indexing', update: { indexingStatus: { projectName: 'my-project', progress: 67, stage: 'Embedding' } } },
  ];

  for (const { label, update } of states) {
    const rendered = status.update(update);
    console.log(`   ${chalk.dim(label.padEnd(25))} ${rendered}`);
    await sleep(50);
  }

  console.log();

  // ─────────────────────────────────────────
  // Demo 2: Tool Descriptions
  // ─────────────────────────────────────────
  console.log(chalk.cyan.bold('2. Tool Action Descriptions'));
  console.log();

  const tools = [
    { tool: 'read_file', args: { path: 'src/auth/jwt.ts' } },
    { tool: 'search_files', args: { pattern: 'TODO' } },
    { tool: 'execute_command', args: { command: 'npm test --run src/cli/tui/' } },
    { tool: 'web_fetch', args: { url: 'https://docs.anthropic.com/api' } },
    { tool: 'glob', args: { pattern: '**/*.test.ts' } },
    { tool: 'unknown_tool', args: {} },
  ];

  for (const { tool, args } of tools) {
    const desc = toolToDescription(tool, args);
    console.log(`   ${chalk.dim(tool.padEnd(20))} -> ${chalk.yellow(desc)}`);
  }

  console.log();

  // ─────────────────────────────────────────
  // Demo 3: Region Layout
  // ─────────────────────────────────────────
  console.log(chalk.cyan.bold('3. Region Layout'));
  console.log();
  console.log(`   Terminal size: ${cols}x${rows}`);
  console.log(`   Chat area:    rows 1-${rows - 2} (${rows - 2} lines scrollable)`);
  console.log(`   Status bar:   row ${rows - 1} (fixed)`);
  console.log(`   Input area:   row ${rows} (fixed, readline)`);
  console.log();

  // ─────────────────────────────────────────
  // Demo 4: Layout Mockup
  // ─────────────────────────────────────────
  console.log(chalk.cyan.bold('4. Layout Mockup'));
  console.log();

  const mockWidth = Math.min(cols - 4, 70);
  const border = '\u2500'.repeat(mockWidth);

  const pad = (text: string, width: number): string => {
    const visible = stripAnsi(text).length;
    const needed = Math.max(0, width - visible);
    return text + ' '.repeat(needed);
  };

  console.log(`   \u250c${border}\u2510`);
  console.log(`   \u2502${' '.repeat(mockWidth)}\u2502`);
  console.log(`   \u2502  ${pad(chalk.green('You:') + ' How does auth work?', mockWidth - 2)}\u2502`);
  console.log(`   \u2502${' '.repeat(mockWidth)}\u2502`);
  console.log(`   \u2502  ${pad(chalk.cyan('Assistant:') + ' The auth flow uses JWT', mockWidth - 2)}\u2502`);
  console.log(`   \u2502  ${pad('tokens stored in httpOnly cookies.', mockWidth - 2)}\u2502`);
  console.log(`   \u2502${' '.repeat(mockWidth)}\u2502`);
  console.log(`   \u2502  ${pad(chalk.dim('Sources:'), mockWidth - 2)}\u2502`);
  console.log(`   \u2502  ${pad(chalk.cyan('[1]') + ' src/auth/jwt.ts', mockWidth - 2)}\u2502`);
  console.log(`   \u2502${' '.repeat(mockWidth)}\u2502`);
  console.log(`   \u251c${border}\u2524`);

  // Render a status line for the mockup
  const statusLine = status.update({
    mode: AgentMode.PLANNING,
    phase: AgentPhase.IDLE,
    tokens: { used: 84000, total: 200000, warningThreshold: 0.8, dangerThreshold: 0.95 },
    cost: { totalUsd: 0.0234 },
    indexingStatus: undefined,
  });
  console.log(`   \u2502 ${pad(statusLine, mockWidth - 1)}\u2502`);

  console.log(`   \u251c${border}\u2524`);
  console.log(`   \u2502  ${pad(chalk.green('[my-project]') + '> ' + chalk.dim('_'), mockWidth - 2)}\u2502`);
  console.log(`   \u2514${border}\u2518`);

  console.log();

  // ─────────────────────────────────────────
  // Demo 5: ANSI Reference
  // ─────────────────────────────────────────
  console.log(chalk.cyan.bold('5. Key ANSI Sequences'));
  console.log();
  console.log(`   Scroll region (1-${rows - 2}):  ${chalk.dim(JSON.stringify(ANSI.setScrollRegion(1, rows - 2)))}`);
  console.log(`   Cursor to status:    ${chalk.dim(JSON.stringify(ANSI.cursorTo(rows - 1)))}`);
  console.log(`   Begin sync update:   ${chalk.dim(JSON.stringify(ANSI.BEGIN_SYNC))}`);
  console.log(`   End sync update:     ${chalk.dim(JSON.stringify(ANSI.END_SYNC))}`);

  console.log();
  console.log(chalk.bold.green('\u2713 All TUI components rendering correctly!'));
  console.log();
  console.log(chalk.dim('To test the full interactive TUI, run in your terminal:'));
  console.log(chalk.cyan('  ctx chat --tui'));
  console.log();
}

demo().catch(console.error);
