/**
 * Eval Command
 *
 * Parent command for evaluation and trace analysis:
 *   ctx eval run --project X         Run batch evaluation against golden dataset
 *   ctx eval run --project X --ragas  Include RAGAS answer quality metrics
 *   ctx eval traces                   List recent interaction traces
 *   ctx eval traces --project X       Filter by project
 *   ctx eval traces --limit 20        Limit results (default: 20)
 *   ctx eval traces --since 7d        Filter by recency (e.g., 7d, 24h, 2w)
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { CommandContext } from '../types.js';
import { getDatabase, getDb, runMigrations } from '../../database/index.js';
import { loadConfig } from '../../config/loader.js';
import { createRAGEngine } from '../../agent/rag-engine.js';
import { runEval, createEvalRunnerDeps } from '../../eval/runner.js';
import { loadGoldenDataset } from '../../eval/golden.js';
import { exportToRagas, writeExport } from '../../eval/exporter.js';
import { PythonEvalBridge } from '../../eval/python-bridge.js';
import { REGRESSION_THRESHOLD } from '../../eval/aggregator.js';
import {
  EvalConfigSchema,
  EvalError,
  type EvalTrace,
  type EvalRunSummary,
  type RagasResults,
  type RetrievalMetrics,
} from '../../eval/types.js';
import { CLIError } from '../../errors/index.js';
import type { Project } from '../../database/schema.js';

// ============================================================================
// Run Subcommand Types
// ============================================================================

/**
 * CLI options for `ctx eval run`.
 */
interface RunCommandOptions {
  project?: string;
  topK?: string;
  ragas?: boolean;
}

/**
 * A row in the formatted metrics results table.
 */
interface MetricRow {
  name: string;
  value: number;
  target: number | null;
  passed: boolean | null;
  delta?: number;
  direction?: 'up' | 'down' | 'stable';
}

/**
 * JSON output structure for `ctx eval run --json`.
 */
interface EvalRunOutputJSON {
  run_id: string;
  project_name: string;
  timestamp: string;
  query_count: number;
  metrics: RetrievalMetrics;
  thresholds: { mrr: number; hit_rate: number; precision_at_k: number };
  passed: boolean;
  comparison: EvalRunSummary['comparison'] | null;
  regressions: string[];
  improvements: string[];
  ragas: RagasResults | null;
}

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
 * Resolve a project by name from the database.
 *
 * Follows the same pattern as ask.ts and search.ts.
 */
function resolveProject(projectName: string): Project {
  runMigrations();
  const db = getDb();

  const project = db
    .prepare('SELECT * FROM projects WHERE name = ?')
    .get(projectName) as Project | undefined;

  if (!project) {
    throw new CLIError(
      `Project not found: ${projectName}`,
      'Run: ctx list  to see available projects'
    );
  }

  if (!existsSync(project.path)) {
    console.warn(
      chalk.yellow(`Warning: Project path no longer exists: ${project.path}`)
    );
  }

  return project;
}

/**
 * Build metric rows for the results table.
 *
 * Only MRR, Hit Rate, and Precision@K have configurable thresholds.
 * Other metrics (Recall@K, NDCG, MAP) show value and trend but no pass/fail.
 */
export function buildMetricRows(
  metrics: RetrievalMetrics,
  thresholds: { mrr: number; hit_rate: number; precision_at_k: number },
  comparison?: EvalRunSummary['comparison'],
): MetricRow[] {
  const rows: MetricRow[] = [
    { name: 'MRR', value: metrics.mrr, target: thresholds.mrr, passed: metrics.mrr >= thresholds.mrr },
    { name: 'Hit Rate', value: metrics.hit_rate, target: thresholds.hit_rate, passed: metrics.hit_rate >= thresholds.hit_rate },
    { name: 'Precision@K', value: metrics.precision_at_k, target: thresholds.precision_at_k, passed: metrics.precision_at_k >= thresholds.precision_at_k },
    { name: 'Recall@K', value: metrics.recall_at_k, target: null, passed: null },
    { name: 'NDCG', value: metrics.ndcg, target: null, passed: null },
    { name: 'MAP', value: metrics.map, target: null, passed: null },
  ];

  // Add trend data from comparison
  if (comparison?.metric_changes) {
    const changes = comparison.metric_changes;
    const metricKeys: (keyof RetrievalMetrics)[] = [
      'mrr', 'hit_rate', 'precision_at_k', 'recall_at_k', 'ndcg', 'map',
    ];

    for (let i = 0; i < rows.length; i++) {
      const delta = changes[metricKeys[i]!];
      if (delta !== undefined) {
        rows[i]!.delta = delta;
        if (delta > REGRESSION_THRESHOLD) rows[i]!.direction = 'up';
        else if (delta < -REGRESSION_THRESHOLD) rows[i]!.direction = 'down';
        else rows[i]!.direction = 'stable';
      }
    }
  }

  return rows;
}

/**
 * Format the results table for terminal display.
 */
export function formatResultsTable(
  summary: EvalRunSummary,
  metricRows: MetricRow[],
): string {
  const lines: string[] = [];
  const hasComparison = !!summary.comparison;

  // Header
  lines.push(chalk.bold(`Evaluation Results: ${summary.project_name}`));
  lines.push(chalk.dim(`Run ID: ${summary.run_id.substring(0, 8)}  |  Queries: ${summary.query_count}`));
  lines.push('');

  // Column headers
  if (hasComparison) {
    lines.push(chalk.dim('Metric         Value    Target   Status   Change   Trend'));
    lines.push(chalk.dim('\u2500'.repeat(60)));
  } else {
    lines.push(chalk.dim('Metric         Value    Target   Status'));
    lines.push(chalk.dim('\u2500'.repeat(42)));
  }

  // Rows
  for (const row of metricRows) {
    const name = row.name.padEnd(13);
    const value = row.value.toFixed(3).padStart(7);
    const target = row.target !== null ? row.target.toFixed(3).padStart(7) : chalk.dim('    -  ');
    const status = row.passed === true
      ? chalk.green(' PASS')
      : row.passed === false
        ? chalk.red(' FAIL')
        : chalk.dim('    -');

    if (hasComparison && row.delta !== undefined) {
      const change = ((row.delta >= 0 ? '+' : '') + row.delta.toFixed(3)).padStart(7);
      const arrow = row.direction === 'up'
        ? chalk.green(' \u2191')
        : row.direction === 'down'
          ? chalk.red(' \u2193')
          : chalk.dim(' \u2192');
      lines.push(`  ${name}  ${value}  ${target}  ${status}  ${change}  ${arrow}`);
    } else {
      lines.push(`  ${name}  ${value}  ${target}  ${status}`);
    }
  }

  lines.push('');

  // Regression/improvement summary
  if (hasComparison) {
    const regressions = metricRows.filter((r) => r.direction === 'down');
    const improvements = metricRows.filter((r) => r.direction === 'up');

    if (regressions.length > 0) {
      lines.push(chalk.red(`  Regressions (${regressions.length}): ${regressions.map((r) => r.name).join(', ')}`));
    }
    if (improvements.length > 0) {
      lines.push(chalk.green(`  Improvements (${improvements.length}): ${improvements.map((r) => r.name).join(', ')}`));
    }
    if (regressions.length === 0 && improvements.length === 0) {
      lines.push(chalk.dim('  All metrics stable'));
    }
    lines.push('');
  }

  return lines.join('\n');
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
// Run Subcommand
// ============================================================================

/**
 * Create the `ctx eval run` subcommand.
 *
 * Orchestrates batch evaluation: loads golden dataset, runs RAG search
 * per entry, computes retrieval metrics, displays formatted results,
 * and optionally invokes the Python/RAGAS bridge for answer quality.
 */
function createRunSubcommand(
  getContext: () => CommandContext
): Command {
  return new Command('run')
    .description('Run batch evaluation against golden dataset')
    .option('-p, --project <name>', 'Project to evaluate')
    .option('-k, --top-k <number>', 'Override retrieval top-k (default from config)')
    .option('--ragas', 'Include RAGAS answer quality evaluation (requires Python)')
    .action(async (cmdOptions: RunCommandOptions) => {
      const ctx = getContext();

      try {
        // ── Step 1: Validate options ──────────────────────────────────────
        if (!cmdOptions.project) {
          throw new CLIError(
            'Project name required',
            'Usage: ctx eval run --project <name>'
          );
        }

        let topK: number | undefined;
        if (cmdOptions.topK) {
          topK = parseInt(cmdOptions.topK, 10);
          if (isNaN(topK) || topK < 1 || topK > 100) {
            throw new CLIError(
              'Invalid --top-k value',
              'Must be an integer between 1 and 100'
            );
          }
        }

        // ── Step 2: Resolve project ───────────────────────────────────────
        const project = resolveProject(cmdOptions.project);
        ctx.debug(`Project resolved: ${project.name} (ID: ${project.id})`);

        // ── Step 3: Load config and create dependencies ───────────────────
        const config = loadConfig();
        const evalConfig = EvalConfigSchema.parse(config.eval ?? {});
        ctx.debug(`Eval config: default_k=${evalConfig.default_k}`);

        const db = getDatabase();

        // Create RAG engine for search
        if (!ctx.options.json) {
          ctx.log(chalk.dim('Initializing RAG engine...'));
        }
        const ragEngine = await createRAGEngine(config, String(project.id));
        const evalDeps = createEvalRunnerDeps(ragEngine, db, config);

        // ── Step 4: Run evaluation ────────────────────────────────────────
        let summary: EvalRunSummary;

        if (!ctx.options.json) {
          const ora = (await import('ora')).default;
          const spinner = ora({
            text: `Running evaluation for ${cmdOptions.project}...`,
            color: 'cyan',
          }).start();

          try {
            summary = await runEval(
              { projectName: cmdOptions.project, topK },
              evalDeps,
            );
            spinner.succeed(
              `Evaluation complete (${summary.query_count} queries)`
            );
          } catch (error) {
            spinner.fail('Evaluation failed');
            throw error;
          }
        } else {
          summary = await runEval(
            { projectName: cmdOptions.project, topK },
            evalDeps,
          );
        }

        // ── Step 5: Build metric rows ─────────────────────────────────────
        const metricRows = buildMetricRows(
          summary.metrics,
          evalConfig.thresholds,
          summary.comparison,
        );

        // ── Step 6: RAGAS integration (optional) ──────────────────────────
        let ragasResults: RagasResults | null = null;

        if (cmdOptions.ragas) {
          ragasResults = await runRagasEval(
            ctx,
            cmdOptions.project,
            summary,
            evalConfig,
            db,
          );
        }

        // ── Step 7: Output results ────────────────────────────────────────
        if (ctx.options.json) {
          const allPassed = metricRows
            .filter((r) => r.passed !== null)
            .every((r) => r.passed);

          const output: EvalRunOutputJSON = {
            run_id: summary.run_id,
            project_name: summary.project_name,
            timestamp: summary.timestamp,
            query_count: summary.query_count,
            metrics: summary.metrics,
            thresholds: evalConfig.thresholds,
            passed: allPassed,
            comparison: summary.comparison ?? null,
            regressions: metricRows.filter((r) => r.direction === 'down').map((r) => r.name),
            improvements: metricRows.filter((r) => r.direction === 'up').map((r) => r.name),
            ragas: ragasResults,
          };

          console.log(JSON.stringify(output, null, 2));
        } else {
          // Display formatted results table
          ctx.log('');
          ctx.log(formatResultsTable(summary, metricRows));

          // Display RAGAS results if available
          if (ragasResults) {
            ctx.log(chalk.bold('  RAGAS Answer Quality:'));
            ctx.log('');
            for (const [metric, score] of Object.entries(ragasResults.scores)) {
              const formatted = score.toFixed(3);
              const color = score >= 0.7 ? chalk.green : score >= 0.5 ? chalk.yellow : chalk.red;
              ctx.log(`    ${metric.padEnd(22)} ${color(formatted)}`);
            }
            ctx.log('');
            ctx.log(
              chalk.dim(
                `    Model: ${ragasResults.metadata.model_used} | Duration: ${ragasResults.metadata.duration_seconds.toFixed(1)}s`
              )
            );
            ctx.log('');
          }

          // Overall pass/fail
          const failedMetrics = metricRows.filter((r) => r.passed === false);
          if (failedMetrics.length > 0) {
            ctx.log(
              chalk.red(`  \u2717 ${failedMetrics.length} metric(s) below threshold: ${failedMetrics.map((r) => r.name).join(', ')}`)
            );
          } else {
            const thresholdMetrics = metricRows.filter((r) => r.passed !== null);
            ctx.log(chalk.green(`  \u2713 All ${thresholdMetrics.length} threshold metrics passing`));
          }
          ctx.log('');
        }
      } catch (error) {
        if (error instanceof CLIError) {
          throw error;
        }
        if (error instanceof EvalError) {
          throw new CLIError(error.message, `Error code: ${error.code}`);
        }
        throw new CLIError(
          'Evaluation failed',
          error instanceof Error ? error.message : String(error)
        );
      }
    });
}

/**
 * Run RAGAS evaluation via Python bridge.
 *
 * Checks Python/RAGAS availability, exports golden data to temp JSON,
 * invokes the RAGAS subprocess, and returns results.
 * Gracefully degrades if Python or RAGAS is unavailable.
 */
async function runRagasEval(
  ctx: CommandContext,
  projectName: string,
  summary: EvalRunSummary,
  evalConfig: ReturnType<typeof EvalConfigSchema.parse>,
  db: ReturnType<typeof getDatabase>,
): Promise<RagasResults | null> {
  const bridge = new PythonEvalBridge({
    pythonPath: evalConfig.python_path,
    ragasModel: evalConfig.ragas_model,
  });

  // Check availability
  if (!ctx.options.json) {
    ctx.log(chalk.dim('  Checking Python/RAGAS availability...'));
  }

  const avail = await bridge.checkAvailability();

  if (!avail.pythonFound) {
    if (!ctx.options.json) {
      ctx.warn('Python not found — skipping RAGAS evaluation');
      ctx.log(chalk.dim(`  Looked for: ${evalConfig.python_path}`));
    }
    return null;
  }

  if (!avail.ragasAvailable) {
    if (!ctx.options.json) {
      ctx.warn('RAGAS package not installed — skipping answer quality evaluation');
      ctx.log(chalk.dim('  Install: pip install ragas'));
    }
    return null;
  }

  // Export golden dataset + eval results for RAGAS
  const dataset = loadGoldenDataset(projectName);
  const evalResults = db.getEvalResults(summary.run_id);

  const sourceEntries = dataset.entries.map((golden) => {
    const result = evalResults.find((r) => r.query === golden.query);
    return { golden, evalResult: result };
  });

  const ragasData = exportToRagas(sourceEntries);
  const tempDir = path.join(os.tmpdir(), 'ctx-eval');
  if (!existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const tempPath = path.join(tempDir, `ragas-${randomUUID()}.json`);
  writeExport(ragasData, tempPath);

  try {
    if (!ctx.options.json) {
      const ora = (await import('ora')).default;
      const spinner = ora({
        text: 'Running RAGAS evaluation...',
        color: 'magenta',
      }).start();

      try {
        const results = await bridge.runRagas(tempPath, [
          'faithfulness',
          'answer_relevancy',
          'context_precision',
          'context_recall',
        ]);
        spinner.succeed('RAGAS evaluation complete');
        return results;
      } catch (error) {
        spinner.fail('RAGAS evaluation failed');
        ctx.warn(error instanceof Error ? error.message : String(error));
        return null;
      }
    } else {
      return await bridge.runRagas(tempPath, [
        'faithfulness',
        'answer_relevancy',
        'context_precision',
        'context_recall',
      ]);
    }
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Ignore cleanup errors
    }
  }
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

  evalCmd.addCommand(createRunSubcommand(getContext));
  evalCmd.addCommand(createTracesSubcommand(getContext));

  return evalCmd;
}
