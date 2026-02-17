/**
 * Eval Command
 *
 * Parent command for evaluation and trace analysis:
 *   ctx eval run --project X         Run batch evaluation against golden dataset
 *   ctx eval run --project X --ragas  Include RAGAS answer quality metrics
 *   ctx eval report --project X      Show eval run history with trend arrows
 *   ctx eval report --project X --last 5  Analyze last 5 runs
 *   ctx eval traces                   List recent interaction traces
 *   ctx eval traces --project X       Filter by project
 *   ctx eval traces --limit 20        Limit results (default: 20)
 *   ctx eval traces --since 7d        Filter by recency (e.g., 7d, 24h, 2w)
 *   ctx eval traces --type ask        Filter by trace type (ask, search, chat)
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as readline from 'node:readline';
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
import { loadGoldenDataset, addGoldenEntry, listGoldenEntries } from '../../eval/golden.js';
import { exportToRagas, writeExport } from '../../eval/exporter.js';
import { PythonEvalBridge } from '../../eval/python-bridge.js';
import { REGRESSION_THRESHOLD, computeTrend, formatTrendReport } from '../../eval/aggregator.js';
import {
  EvalConfigSchema,
  EvalError,
  type EvalTrace,
  type EvalRunSummary,
  type RagasResults,
  type RetrievalMetrics,
} from '../../eval/types.js';
import { CLIError } from '../../errors/index.js';
import { createLLMProvider } from '../../providers/llm.js';
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
 * Extract total token count from trace metadata JSON.
 *
 * ask.ts stores tokensUsed: { prompt, completion, total } in metadata.
 * search/chat traces may not have this field.
 */
function extractTokenCount(metadata: string | null): number | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    const total = parsed?.tokensUsed?.total;
    return typeof total === 'number' && Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
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

  const files = parseRetrievedFiles(trace.retrieved_files);
  const query = truncate(trace.query, 45);
  const latency = `${trace.latency_ms}ms`;
  const traceType = (trace.trace_type ?? '-').padEnd(6);

  const tokens = extractTokenCount(trace.metadata);
  const tokensStr = tokens !== null
    ? String(tokens).padStart(6)
    : chalk.dim('-'.padStart(6));

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
    traceType,
    query.padEnd(47),
    String(files.length).padStart(3) + ' files',
    latency.padStart(7),
    tokensStr,
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
    .option('-t, --type <type>', 'Filter by trace type (ask, search, chat)')
    .action(async (cmdOptions: { project?: string; limit: string; since?: string; type?: string }) => {
      const ctx = getContext();

      // Validate --type if provided
      const validTypes = ['ask', 'search', 'chat'];
      if (cmdOptions.type && !validTypes.includes(cmdOptions.type)) {
        throw new CLIError(
          `Invalid --type value: ${cmdOptions.type}`,
          `Allowed values: ${validTypes.join(', ')}`
        );
      }

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
        trace_type: cmdOptions.type as 'ask' | 'search' | 'chat' | undefined,
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
          'ID        Timestamp           Type    Query                                            Files   Latency  Tokens  Ans  Fb  Langfuse'
        )
      );
      ctx.log(chalk.dim('\u2500'.repeat(150)));

      for (const trace of traces) {
        ctx.log(formatTraceRow(trace));
      }

      ctx.log('');
      ctx.log(chalk.dim(`Showing ${traces.length} trace(s). Use --limit to show more.`));
    });
}

// ============================================================================
// Report Subcommand
// ============================================================================

/**
 * CLI options for `ctx eval report`.
 */
interface ReportCommandOptions {
  project?: string;
  last: string;
}

/**
 * JSON output structure for `ctx eval report --json`.
 */
interface EvalReportOutputJSON {
  project_name: string;
  run_count: number;
  current_run_id: string;
  previous_run_id: string | null;
  trends: Array<{
    metric: string;
    current: number;
    previous: number | null;
    delta: number | null;
    direction: 'up' | 'down' | 'stable';
    is_regression: boolean;
    is_improvement: boolean;
  }>;
  has_regressions: boolean;
  has_improvements: boolean;
}

/**
 * Create the `ctx eval report` subcommand.
 *
 * Shows eval run history with metrics table and trend arrows.
 * Queries recent eval runs from SQLite, computes per-metric deltas
 * using the aggregator, and displays a formatted trend report.
 *
 * Reuses computeTrend() and formatTrendReport() from eval/aggregator.ts
 * which were designed specifically for this command.
 */
function createReportSubcommand(
  getContext: () => CommandContext
): Command {
  return new Command('report')
    .description('Show eval run history with metrics and trend arrows')
    .requiredOption('-p, --project <name>', 'Project to report on')
    .option('-l, --last <number>', 'Number of recent runs to analyze', '10')
    .action(async (cmdOptions: ReportCommandOptions) => {
      const ctx = getContext();

      // Step 1: Initialize database
      runMigrations();
      const db = getDatabase();

      // Step 2: Resolve project
      const project = db.getProjectByName(cmdOptions.project!);
      if (!project) {
        throw new CLIError(
          `Project not found: ${cmdOptions.project}`,
          'Run: ctx list  to see available projects'
        );
      }

      // Step 3: Parse --last
      const lastN = parseInt(cmdOptions.last, 10);
      if (isNaN(lastN) || lastN < 1 || lastN > 1000) {
        throw new CLIError(
          'Invalid --last value',
          'Must be a number between 1 and 1000'
        );
      }

      // Step 4: Fetch eval runs
      const runs = db.getEvalRuns(project.id, lastN);

      // Step 5: Handle empty state
      if (runs.length === 0) {
        if (ctx.options.json) {
          console.log(JSON.stringify({
            project_name: cmdOptions.project,
            run_count: 0,
            current_run_id: null,
            previous_run_id: null,
            trends: [],
            has_regressions: false,
            has_improvements: false,
          }, null, 2));
          return;
        }
        ctx.log(chalk.yellow('No eval runs found.'));
        ctx.log(chalk.dim(`Run: ctx eval run --project ${cmdOptions.project}`));
        return;
      }

      // Step 6: Compute trend analysis
      const trend = computeTrend(runs);

      // Step 7: Output
      if (ctx.options.json) {
        const output: EvalReportOutputJSON = {
          project_name: cmdOptions.project!,
          run_count: trend.runCount,
          current_run_id: trend.currentRunId,
          previous_run_id: trend.previousRunId,
          trends: trend.trends.map((t) => ({
            metric: t.metric,
            current: t.current,
            previous: t.previous,
            delta: t.delta,
            direction: t.direction,
            is_regression: t.isRegression,
            is_improvement: t.isImprovement,
          })),
          has_regressions: trend.hasRegressions,
          has_improvements: trend.hasImprovements,
        };
        console.log(JSON.stringify(output, null, 2));
      } else {
        ctx.log('');
        ctx.log(formatTrendReport(trend));
      }
    });
}

// ============================================================================
// Golden Subcommand Helpers
// ============================================================================

/**
 * Safely parse the retrieved_files JSON column from eval_traces.
 *
 * Returns an empty array if the JSON is corrupted or not an array,
 * rather than crashing the command.
 */
export function parseRetrievedFiles(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Parse a comma-separated selection string into valid 0-based indices.
 *
 * Warns the user about any invalid entries (non-numeric or out of range)
 * rather than silently discarding them.
 *
 * @param input - Raw user input (e.g., "1,3,abc,5")
 * @param max - Upper bound (exclusive) for valid indices
 * @param ctx - CommandContext for warning output
 * @returns Array of valid 0-based indices
 */
export function parseSelection(
  input: string,
  max: number,
  ctx: CommandContext,
): number[] {
  const rawParts = input.split(',').map((s) => s.trim()).filter(Boolean);
  const parsed = rawParts.map((s) => {
    const num = Number(s);
    return { raw: s, num: Number.isInteger(num) ? num - 1 : NaN };
  });
  const invalid = parsed.filter((p) => isNaN(p.num) || p.num < 0 || p.num >= max);
  if (invalid.length > 0) {
    ctx.warn(`Skipped invalid: ${invalid.map((p) => p.raw).join(', ')}`);
  }
  return parsed
    .map((p) => p.num)
    .filter((i) => !isNaN(i) && i >= 0 && i < max);
}

/**
 * Prompt user for input using readline.
 *
 * Wraps rl.question() in a Promise for async/await usage.
 * Same pattern as provider-repl.ts:77.
 *
 * @param rl - Active readline interface
 * @param question - Prompt text to display
 * @returns User's trimmed input
 */
function promptUser(
  rl: readline.Interface,
  question: string
): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

// ============================================================================
// Golden List Subcommand
// ============================================================================

/**
 * Options for `ctx eval golden list`.
 */
interface GoldenListOptions {
  project?: string;
}

/**
 * Create the `ctx eval golden list` subcommand.
 *
 * Displays all golden dataset entries for a project in a formatted table.
 * Supports --json for machine-readable output.
 */
function createGoldenListSubcommand(
  getContext: () => CommandContext
): Command {
  return new Command('list')
    .description('List golden dataset entries')
    .requiredOption('-p, --project <name>', 'Project name')
    .action(async (cmdOptions: GoldenListOptions) => {
      const ctx = getContext();

      // Step 1: Validate project exists in the database
      resolveProject(cmdOptions.project!);

      // Step 2: Load entries from golden.json
      const entries = listGoldenEntries(cmdOptions.project!);

      // Step 3: Handle empty state
      if (entries.length === 0) {
        if (ctx.options.json) {
          console.log(JSON.stringify({ count: 0, entries: [] }, null, 2));
          return;
        }
        ctx.log(chalk.yellow('No golden entries found.'));
        ctx.log(chalk.dim('Add entries with:'));
        ctx.log(chalk.dim('  ctx eval golden add     --project ' + cmdOptions.project));
        ctx.log(chalk.dim('  ctx eval golden capture  --project ' + cmdOptions.project));
        ctx.log(chalk.dim('  ctx eval golden generate --project ' + cmdOptions.project));
        return;
      }

      // Step 4: JSON output mode
      if (ctx.options.json) {
        console.log(JSON.stringify({ count: entries.length, entries }, null, 2));
        return;
      }

      // Step 5: Formatted table output
      ctx.log(chalk.bold(`Golden Dataset: ${cmdOptions.project}`));
      ctx.log(chalk.dim(`${entries.length} entries`));
      ctx.log('');

      ctx.log(chalk.dim(
        '  ID        Source      Files  Query                                      Tags'
      ));
      ctx.log(chalk.dim('  ' + '\u2500'.repeat(85)));

      for (const entry of entries) {
        const id = entry.id.substring(0, 8);
        const source = entry.source.padEnd(10);
        const fileCount = String(entry.expectedFilePaths?.length ?? 0).padStart(3);
        const query = truncate(entry.query, 40).padEnd(42);
        const tags = entry.tags?.join(', ') || chalk.dim('-');

        ctx.log(`  ${chalk.dim(id)}  ${source}  ${fileCount}  ${query}  ${tags}`);
      }

      ctx.log('');
    });
}

// ============================================================================
// Golden Add Subcommand
// ============================================================================

/**
 * Options for `ctx eval golden add`.
 *
 * In interactive mode only --project is needed; the rest are prompted.
 * In non-interactive mode (--query provided), all fields come from flags.
 */
interface GoldenAddOptions {
  project?: string;
  query?: string;
  files?: string;
  answer?: string;
  tags?: string;
}

/**
 * Create the `ctx eval golden add` subcommand.
 *
 * Two modes:
 * - Interactive: prompts for each field via readline
 * - Non-interactive: reads all fields from CLI flags (for scripting/CI)
 */
function createGoldenAddSubcommand(
  getContext: () => CommandContext
): Command {
  return new Command('add')
    .description('Add a golden entry manually')
    .requiredOption('-p, --project <name>', 'Project name')
    .option('--query <text>', 'Query text (skips interactive prompt)')
    .option('--files <paths>', 'Expected file paths (comma-separated)')
    .option('--answer <text>', 'Expected answer text')
    .option('--tags <tags>', 'Tags (comma-separated)')
    .action(async (cmdOptions: GoldenAddOptions) => {
      const ctx = getContext();
      const projectName = cmdOptions.project!;

      // Validate project exists
      resolveProject(projectName);

      // ── Non-interactive mode (--query flag provided) ─────────────────
      if (cmdOptions.query) {
        const expectedFilePaths = cmdOptions.files
          ? cmdOptions.files.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined;
        const expectedAnswer = cmdOptions.answer || undefined;
        const tags = cmdOptions.tags
          ? cmdOptions.tags.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined;

        const created = addGoldenEntry(projectName, {
          query: cmdOptions.query,
          expectedFilePaths,
          expectedAnswer,
          tags,
          source: 'manual',
        });

        if (ctx.options.json) {
          console.log(JSON.stringify(created, null, 2));
        } else {
          ctx.log(chalk.green(`\u2713 Entry added (ID: ${created.id.substring(0, 8)})`));
        }
        return;
      }

      // ── Interactive mode ─────────────────────────────────────────────
      ctx.log(chalk.bold('Add Golden Entry'));
      ctx.log(chalk.dim('Press Ctrl+C to cancel\n'));

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        // Prompt 1: Query (required)
        const query = await promptUser(rl, chalk.cyan('Query: '));
        if (!query) {
          throw new CLIError('Query cannot be empty', 'Provide a question to test your RAG pipeline');
        }

        // Prompt 2: Expected file paths (comma-separated)
        const filesInput = await promptUser(
          rl,
          chalk.cyan('Expected file paths (comma-separated, or empty): '),
        );
        const expectedFilePaths = filesInput
          ? filesInput.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined;

        // Prompt 3: Expected answer (optional)
        const expectedAnswer =
          (await promptUser(rl, chalk.cyan('Expected answer (optional): '))) || undefined;

        // Prompt 4: Tags (comma-separated, optional)
        const tagsInput = await promptUser(
          rl,
          chalk.cyan('Tags (comma-separated, optional): '),
        );
        const tags = tagsInput
          ? tagsInput.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined;

        // Validate: addGoldenEntry requires at least one expected result
        // (it throws EvalError.datasetInvalid if neither is provided)
        const created = addGoldenEntry(projectName, {
          query,
          expectedFilePaths,
          expectedAnswer,
          tags,
          source: 'manual',
        });

        ctx.log('');
        ctx.log(chalk.green(`\u2713 Entry added (ID: ${created.id.substring(0, 8)})`));
        ctx.log(chalk.dim(`Run: ctx eval golden list --project ${projectName}`));
      } catch (error) {
        if (error instanceof CLIError) throw error;
        if (error instanceof EvalError) {
          throw new CLIError(error.message, 'Provide expectedFilePaths or expectedAnswer');
        }
        throw error;
      } finally {
        rl.close();
      }
    });
}

// ============================================================================
// Golden Capture Subcommand
// ============================================================================

/**
 * Options for `ctx eval golden capture`.
 */
interface GoldenCaptureOptions {
  project?: string;
  limit: string;
  since?: string;
}

/**
 * Create the `ctx eval golden capture` subcommand.
 *
 * Fetches recent traces from eval_traces, displays a numbered list,
 * lets the user select which to promote to golden dataset entries.
 * Trace query → golden query, trace retrieved_files → expectedFilePaths.
 */
function createGoldenCaptureSubcommand(
  getContext: () => CommandContext
): Command {
  return new Command('capture')
    .description('Promote traces to golden dataset entries')
    .requiredOption('-p, --project <name>', 'Project name')
    .option('-l, --limit <number>', 'Maximum traces to show', '20')
    .option('-s, --since <duration>', 'Show traces since (e.g., 7d, 24h, 2w)')
    .action(async (cmdOptions: GoldenCaptureOptions) => {
      const ctx = getContext();
      const projectName = cmdOptions.project!;

      // Step 1: Resolve project to get its database ID
      const project = resolveProject(projectName);

      // Step 2: Fetch traces from SQLite
      runMigrations();
      const db = getDatabase();

      const limit = parseInt(cmdOptions.limit, 10) || 20;
      const startDate = cmdOptions.since ? parseSince(cmdOptions.since) : undefined;

      const traces = db.getTraces({
        project_id: String(project.id),
        start_date: startDate,
        limit,
      });

      // Step 3: Handle empty state
      if (traces.length === 0) {
        ctx.log(chalk.yellow('No traces found.'));
        ctx.log(chalk.dim('Traces are recorded when you use ctx ask, ctx search, or ctx chat.'));
        return;
      }

      // Step 4: Display numbered trace list
      ctx.log(chalk.bold('Recent Traces'));
      ctx.log(chalk.dim('Select traces to promote to golden dataset entries.\n'));

      for (let i = 0; i < traces.length; i++) {
        const trace = traces[i]!;
        const files = parseRetrievedFiles(trace.retrieved_files);
        const timestamp = new Date(trace.timestamp).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });

        ctx.log(
          chalk.cyan(`  ${String(i + 1).padStart(2)}.`) +
          ` ${truncate(trace.query, 60)}`
        );
        ctx.log(chalk.dim(
          `      ${timestamp}  |  ${files.length} files  |  ${trace.latency_ms}ms` +
          (trace.answer ? '  |  has answer' : '')
        ));
        if (files.length > 0) {
          ctx.log(chalk.dim(
            `      Files: ${files.slice(0, 3).join(', ')}` +
            (files.length > 3 ? ` (+${files.length - 3} more)` : '')
          ));
        }
        ctx.log('');
      }

      // Step 5: Interactive selection
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        const selectionInput = await promptUser(
          rl,
          chalk.cyan('Select traces (comma-separated numbers, or "q" to quit): '),
        );

        if (selectionInput.toLowerCase() === 'q' || !selectionInput) {
          ctx.log(chalk.dim('Cancelled.'));
          return;
        }

        // Parse and validate selection
        const selectedIndices = parseSelection(selectionInput, traces.length, ctx);

        if (selectedIndices.length === 0) {
          ctx.log(chalk.yellow('No valid selections.'));
          return;
        }

        // Step 6: Confirm
        const confirm = await promptUser(
          rl,
          chalk.cyan(`Add ${selectedIndices.length} trace(s) to golden dataset? (y/n): `),
        );

        if (confirm.toLowerCase() !== 'y') {
          ctx.log(chalk.dim('Cancelled.'));
          return;
        }

        // Step 7: Create golden entries from selected traces
        const existingQueries = new Set(
          listGoldenEntries(projectName).map((e) => e.query.toLowerCase()),
        );

        let added = 0;
        let skippedDupes = 0;
        for (const idx of selectedIndices) {
          const trace = traces[idx]!;
          const normalized = trace.query.toLowerCase();

          // Skip if already in dataset or already added in this batch
          if (existingQueries.has(normalized)) {
            skippedDupes++;
            continue;
          }

          const files = parseRetrievedFiles(trace.retrieved_files);
          addGoldenEntry(projectName, {
            query: trace.query,
            expectedFilePaths: files.length > 0 ? files : undefined,
            expectedAnswer: trace.answer ?? undefined,
            source: 'captured',
          });

          existingQueries.add(normalized); // prevent batch-internal dupes
          added++;
        }

        ctx.log('');
        ctx.log(chalk.green(`\u2713 Added ${added} golden entries from traces`));
        if (skippedDupes > 0) {
          ctx.log(chalk.yellow(`  Skipped ${skippedDupes} duplicate(s) already in dataset`));
        }
        ctx.log(chalk.dim(`Run: ctx eval golden list --project ${projectName}`));
      } finally {
        rl.close();
      }
    });
}

// ============================================================================
// Golden Generate Subcommand
// ============================================================================

/**
 * Options for `ctx eval golden generate`.
 */
interface GoldenGenerateOptions {
  project?: string;
  count: string;
}

/**
 * Shape of a chunk row from the raw SQLite query.
 *
 * We only select the columns we need — notably excluding
 * `embedding` (BLOB, ~4KB per chunk) to keep memory usage low.
 */
interface ChunkRow {
  content: string;
  file_path: string;
  start_line: number | null;
  end_line: number | null;
  language: string | null;
}

/**
 * Create the `ctx eval golden generate` subcommand.
 *
 * Samples random indexed chunks, sends each to the LLM to generate
 * test questions, then presents them for user review before saving.
 */
function createGoldenGenerateSubcommand(
  getContext: () => CommandContext
): Command {
  return new Command('generate')
    .description('Generate golden entries using LLM')
    .requiredOption('-p, --project <name>', 'Project name')
    .option('-n, --count <number>', 'Number of entries to generate', '5')
    .action(async (cmdOptions: GoldenGenerateOptions) => {
      const ctx = getContext();
      const projectName = cmdOptions.project!;
      const targetCount = parseInt(cmdOptions.count, 10) || 5;

      // Step 1: Resolve project and get raw SQLite connection
      const project = resolveProject(projectName);
      runMigrations();
      const db = getDb();

      // Step 2: Sample random chunks (exclude embedding BLOB for efficiency)
      // Schema: src/database/migrations/001-initial.sql — chunks table
      const sampleSize = targetCount * 3; // Over-sample to account for LLM variance
      const chunks = db
        .prepare(
          `SELECT content, file_path, start_line, end_line, language
           FROM chunks
           WHERE project_id = ?
           ORDER BY RANDOM()
           LIMIT ?`
        )
        .all(String(project.id), sampleSize) as ChunkRow[];

      if (chunks.length === 0) {
        throw new CLIError(
          `Project "${projectName}" has no indexed chunks`,
          `Index the project first: ctx index <path> --name ${projectName}`
        );
      }

      // Step 3: Create LLM provider
      const config = loadConfig();
      const { provider, name: providerName, model } = await createLLMProvider(config);
      ctx.debug(`Using LLM: ${providerName} / ${model}`);

      // Step 4: Generate questions from chunks
      if (!ctx.options.json) {
        ctx.log(chalk.dim(`Generating questions from ${chunks.length} chunks using ${providerName}/${model}...\n`));
      }

      // Build dedup set from existing golden entries to avoid duplicates
      const existingQueries = new Set(
        listGoldenEntries(projectName).map((e) => e.query.toLowerCase()),
      );
      const generatedEntries: Array<{ query: string; filePath: string }> = [];

      const ora = (await import('ora')).default;
      const spinner = ctx.options.json
        ? null
        : ora({ text: 'Generating questions...', color: 'cyan' }).start();

      try {
        for (const chunk of chunks) {
          if (generatedEntries.length >= targetCount) break;

          const lineInfo = chunk.start_line && chunk.end_line
            ? `Lines ${chunk.start_line}-${chunk.end_line}`
            : '';
          const langInfo = chunk.language ? ` (${chunk.language})` : '';

          // Truncate chunk content to avoid excessive token usage
          const maxContentLen = 1500;
          if (chunk.content.length > maxContentLen) {
            ctx.debug(`Truncated chunk from ${chunk.file_path} (${chunk.content.length} → ${maxContentLen} chars)`);
          }
          const content = chunk.content.length > maxContentLen
            ? chunk.content.substring(0, maxContentLen) + '\n... (truncated)'
            : chunk.content;

          const response = await provider.chat(
            [
              {
                role: 'user',
                content: `You are generating test questions for a code search evaluation dataset.

Given this code chunk, write 2 specific questions that a developer would ask and this code would answer.
Rules:
- Questions should be natural (how a developer actually asks), not "What does line 5 do?"
- Each question on its own line
- No numbering, no bullet points, no prefixes — just the question text

File: ${chunk.file_path}${langInfo}
${lineInfo}

\`\`\`
${content}
\`\`\`

Questions:`,
              },
            ],
            { maxTokens: 200, temperature: 0.7 },
          );

          // Parse response: one question per non-empty line
          const questions = response.content
            .split('\n')
            .map((q) => q.trim())
            .filter((q) => q.length > 10 && !q.startsWith('#') && !q.startsWith('```'));

          for (const query of questions) {
            if (generatedEntries.length >= targetCount) break;
            const normalized = query.toLowerCase();
            if (existingQueries.has(normalized)) continue;
            if (generatedEntries.some((e) => e.query.toLowerCase() === normalized)) continue;
            generatedEntries.push({ query, filePath: chunk.file_path });
          }

          if (spinner) {
            spinner.text = `Generated ${generatedEntries.length}/${targetCount} questions...`;
          }
        }

        if (spinner) {
          spinner.succeed(`Generated ${generatedEntries.length} questions`);
        }
      } catch (error) {
        if (spinner) spinner.fail('Failed to generate questions');
        throw new CLIError(
          'LLM question generation failed',
          error instanceof Error ? error.message : String(error)
        );
      }

      if (generatedEntries.length === 0) {
        ctx.log(chalk.yellow('No questions were generated. Try with a larger --count or different project.'));
        return;
      }

      // Step 5: Display generated questions for review
      ctx.log('');
      ctx.log(chalk.bold('Generated Questions:\n'));

      for (let i = 0; i < generatedEntries.length; i++) {
        const entry = generatedEntries[i]!;
        ctx.log(chalk.cyan(`  ${String(i + 1).padStart(2)}.`) + ` ${entry.query}`);
        ctx.log(chalk.dim(`      File: ${entry.filePath}`));
        ctx.log('');
      }

      // Step 6: Interactive review
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        const action = await promptUser(
          rl,
          chalk.cyan(`Save all ${generatedEntries.length} entries? (y=yes, n=cancel, s=select): `),
        );

        let toSave = generatedEntries;

        if (action.toLowerCase() === 'n' || !action) {
          ctx.log(chalk.dim('Cancelled.'));
          return;
        }

        if (action.toLowerCase() === 's') {
          const keepInput = await promptUser(
            rl,
            chalk.cyan('Enter numbers to keep (comma-separated): '),
          );

          const keepIndices = parseSelection(keepInput, generatedEntries.length, ctx);

          if (keepIndices.length === 0) {
            ctx.log(chalk.yellow('No valid selections. Cancelled.'));
            return;
          }

          toSave = keepIndices.map((i) => generatedEntries[i]!);
        }

        // Step 7: Save approved entries
        for (const entry of toSave) {
          addGoldenEntry(projectName, {
            query: entry.query,
            expectedFilePaths: [entry.filePath],
            source: 'generated',
          });
        }

        ctx.log('');
        ctx.log(chalk.green(`\u2713 Added ${toSave.length} golden entries`));
        ctx.log(chalk.dim(`Run: ctx eval golden list --project ${projectName}`));
      } finally {
        rl.close();
      }
    });
}

// ============================================================================
// Golden Parent Command
// ============================================================================

/**
 * Create the `ctx eval golden` parent command.
 *
 * Groups golden dataset management subcommands:
 *   ctx eval golden list      List golden dataset entries
 *   ctx eval golden add       Add a golden entry manually
 *   ctx eval golden capture   Promote traces to golden entries
 *   ctx eval golden generate  Generate entries using LLM
 */
function createGoldenCommand(
  getContext: () => CommandContext
): Command {
  const goldenCmd = new Command('golden')
    .description('Manage golden dataset entries');

  goldenCmd.addCommand(createGoldenListSubcommand(getContext));
  goldenCmd.addCommand(createGoldenAddSubcommand(getContext));
  goldenCmd.addCommand(createGoldenCaptureSubcommand(getContext));
  goldenCmd.addCommand(createGoldenGenerateSubcommand(getContext));

  return goldenCmd;
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
  evalCmd.addCommand(createReportSubcommand(getContext));
  evalCmd.addCommand(createTracesSubcommand(getContext));
  evalCmd.addCommand(createGoldenCommand(getContext));

  return evalCmd;
}
