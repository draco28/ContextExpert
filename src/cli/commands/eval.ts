/**
 * Eval Command
 *
 * Parent command for evaluation and trace analysis:
 *   ctx eval traces              List recent interaction traces
 *   ctx eval traces --project X  Filter by project
 *   ctx eval traces --limit 20   Limit results (default: 20)
 *   ctx eval traces --since 7d   Filter by recency (e.g., 7d, 24h, 2w)
 */

import { Command } from 'commander';
import chalk from 'chalk';
import type { CommandContext } from '../types.js';
import { getDatabase, runMigrations } from '../../database/index.js';
import type { EvalTrace } from '../../eval/types.js';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Parse --since value into an ISO date string.
 *
 * Supports relative durations (7d, 24h, 2w) and passthrough ISO dates.
 */
export function parseSince(since: string): string {
  const now = new Date();
  const match = since.match(/^(\d+)([dhw])$/);

  if (match) {
    const value = parseInt(match[1]!, 10);
    const unit = match[2]!;

    switch (unit) {
      case 'h':
        now.setHours(now.getHours() - value);
        break;
      case 'd':
        now.setDate(now.getDate() - value);
        break;
      case 'w':
        now.setDate(now.getDate() - value * 7);
        break;
    }
    return now.toISOString();
  }

  // Assume ISO date string passthrough
  return since;
}

/**
 * Truncate a string to maxLen, adding ellipsis if needed.
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}

/**
 * Format a trace for table display.
 */
function formatTraceRow(trace: EvalTrace): string {
  const date = new Date(trace.timestamp);
  const timestamp = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const files = JSON.parse(trace.retrieved_files) as string[];
  const query = truncate(trace.query, 45);
  const latency = `${trace.latency_ms}ms`;
  const method = trace.retrieval_method;

  let feedback = chalk.dim('-');
  if (trace.feedback === 'positive') feedback = chalk.green('+');
  if (trace.feedback === 'negative') feedback = chalk.red('-');

  const hasAnswer = trace.answer ? chalk.green('Y') : chalk.dim('N');
  const langfuse = trace.langfuse_trace_id
    ? chalk.cyan(trace.langfuse_trace_id.substring(0, 8))
    : chalk.dim('-');

  return [
    chalk.dim(trace.id.substring(0, 8)),
    timestamp.padEnd(18),
    query.padEnd(47),
    String(files.length).padStart(3) + ' files',
    latency.padStart(7),
    method.padEnd(6),
    hasAnswer,
    feedback,
    langfuse,
  ].join('  ');
}

// ============================================================================
// Traces Subcommand
// ============================================================================

function createTracesSubcommand(
  getContext: () => CommandContext
): Command {
  return new Command('traces')
    .description('List recent interaction traces from eval_traces')
    .option('-p, --project <name>', 'Filter by project name')
    .option('-l, --limit <number>', 'Maximum traces to show', '20')
    .option('-s, --since <duration>', 'Show traces since (e.g., 7d, 24h, 2w)')
    .action(async (cmdOptions: { project?: string; limit: string; since?: string }) => {
      const ctx = getContext();

      runMigrations();
      const db = getDatabase();

      // Resolve project name to ID
      let projectId: string | undefined;
      if (cmdOptions.project) {
        const project = db.getProjectByName(cmdOptions.project);
        if (!project) {
          ctx.error(`Project not found: ${cmdOptions.project}`);
          return;
        }
        projectId = project.id;
      }

      const limit = parseInt(cmdOptions.limit, 10) || 20;
      const startDate = cmdOptions.since ? parseSince(cmdOptions.since) : undefined;

      const traces = db.getTraces({
        project_id: projectId,
        start_date: startDate,
        limit,
      });

      // JSON output mode
      if (ctx.options.json) {
        console.log(
          JSON.stringify(
            {
              count: traces.length,
              traces: traces.map((t) => ({
                ...t,
                retrieved_files: JSON.parse(t.retrieved_files),
                metadata: t.metadata ? JSON.parse(t.metadata) : null,
              })),
            },
            null,
            2
          )
        );
        return;
      }

      // Empty state
      if (traces.length === 0) {
        ctx.log(chalk.yellow('No traces found.'));
        ctx.log(
          chalk.dim(
            'Traces are recorded automatically when you use ctx ask, ctx search, or ctx chat.'
          )
        );
        return;
      }

      // Table header
      ctx.log(chalk.bold(`Recent Traces (${traces.length})`));
      ctx.log('');
      ctx.log(
        chalk.dim(
          'ID        Timestamp           Query                                            Files   Latency  Method  Ans  Fb  Langfuse'
        )
      );
      ctx.log(chalk.dim('\u2500'.repeat(140)));

      for (const trace of traces) {
        ctx.log(formatTraceRow(trace));
      }

      ctx.log('');
      ctx.log(chalk.dim(`Showing ${traces.length} trace(s). Use --limit to show more.`));
    });
}

// ============================================================================
// Eval Parent Command
// ============================================================================

export function createEvalCommand(
  getContext: () => CommandContext
): Command {
  const evalCmd = new Command('eval')
    .description('Evaluation and trace analysis commands');

  evalCmd.addCommand(createTracesSubcommand(getContext));

  return evalCmd;
}
