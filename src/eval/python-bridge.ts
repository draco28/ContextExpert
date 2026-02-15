/**
 * Python/RAGAS Bridge
 *
 * Subprocess management for running RAGAS and DeepEval evaluations.
 *
 * Design:
 * - Python scripts embedded as template literal strings (no external .py files)
 * - Results communicated via temp JSON file (not stdout, to avoid buffer limits)
 * - Zod validation on all Python output
 * - 5-minute timeout with stderr capture for debugging
 * - Graceful degradation: checkAvailability() never throws
 *
 * Data flow:
 *   exporter.ts writes JSON  →  python-bridge spawns Python  →
 *   Python reads JSON, runs eval, writes results  →
 *   python-bridge reads + validates results with Zod
 *
 * @see exporter.ts for the input JSON formats (RagasEntry, DeepEvalEntry)
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EvalError } from './types.js';
import type { PythonAvailability, RagasResults, DeepEvalResults } from './types.js';

// ============================================================================
// EXEC FUNCTION TYPE
// ============================================================================

/**
 * Async function that executes a command and returns stdout/stderr.
 * Extracted as a type so tests can inject a mock without fighting promisify.
 */
export type ExecFileFn = (
  cmd: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }
) => Promise<{ stdout: string; stderr: string }>;

/** Default implementation wrapping child_process.execFile in a Promise */
function defaultExecFile(
  cmd: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (error, stdout, stderr) => {
      if (error) {
        // Attach stderr to the error so handleExecError can read it
        Object.assign(error, { stderr });
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

// ============================================================================
// ZOD SCHEMAS — Runtime validation of Python script output
// ============================================================================

/**
 * Validates the JSON that the availability check script prints to stdout.
 * Maps snake_case Python output to our PythonAvailability interface.
 */
const AvailabilityOutputSchema = z.object({
  python_found: z.boolean(),
  python_version: z.string().nullable(),
  ragas_available: z.boolean(),
  ragas_version: z.string().nullable(),
  deepeval_available: z.boolean(),
  deepeval_version: z.string().nullable(),
});

/**
 * Validates RAGAS evaluation results written to the temp output file.
 * Scores are constrained to 0-1 since all RAGAS metrics are normalized.
 */
const RagasOutputSchema = z.object({
  scores: z.record(z.string(), z.number().min(0).max(1)),
  details: z.array(
    z.object({
      question: z.string(),
      scores: z.record(z.string(), z.number()),
    })
  ),
  metadata: z.object({
    duration_seconds: z.number(),
    model_used: z.string(),
    metrics_evaluated: z.array(z.string()),
  }),
});

/**
 * Validates DeepEval evaluation results. Same structure as RAGAS
 * but includes per-metric reasoning strings.
 */
const DeepEvalOutputSchema = z.object({
  scores: z.record(z.string(), z.number().min(0).max(1)),
  details: z.array(
    z.object({
      input: z.string(),
      scores: z.record(z.string(), z.number()),
      reasons: z.record(z.string(), z.string()),
    })
  ),
  metadata: z.object({
    duration_seconds: z.number(),
    model_used: z.string(),
    metrics_evaluated: z.array(z.string()),
  }),
});

// ============================================================================
// EMBEDDED PYTHON SCRIPTS
// ============================================================================

/**
 * Lightweight availability check — prints JSON to stdout.
 * Uses stdout (not a temp file) because the output is tiny and predictable.
 * Targets Python 3.8+ for broad compatibility.
 */
const AVAILABILITY_CHECK_SCRIPT = `
import json, sys
result = {
    "python_found": True,
    "python_version": "%d.%d.%d" % (sys.version_info.major, sys.version_info.minor, sys.version_info.micro),
    "ragas_available": False,
    "ragas_version": None,
    "deepeval_available": False,
    "deepeval_version": None
}
try:
    import ragas
    result["ragas_available"] = True
    result["ragas_version"] = getattr(ragas, "__version__", "unknown")
except ImportError:
    pass
try:
    import deepeval
    result["deepeval_available"] = True
    result["deepeval_version"] = getattr(deepeval, "__version__", "unknown")
except ImportError:
    pass
print(json.dumps(result))
`.trim();

/**
 * RAGAS evaluation runner.
 *
 * Args: <input_json_path> <output_json_path> <metrics_csv> <model_name>
 *
 * Reads RAGAS-format data ({question, answer, contexts, ground_truths}[]),
 * runs evaluation with the specified metrics, and writes results JSON.
 *
 * LLM configuration via environment variables:
 *   OPENAI_API_KEY  — required for LLM-based metrics
 *   OPENAI_BASE_URL — for OpenAI-compatible APIs (e.g., GLM)
 *   RAGAS_MODEL     — model name passed as arg
 */
const RAGAS_RUNNER_SCRIPT = `
import json, sys, time, os

input_path = sys.argv[1]
output_path = sys.argv[2]
metrics_csv = sys.argv[3]
model_name = sys.argv[4]

try:
    from ragas import evaluate
    from ragas.metrics import (
        faithfulness,
        answer_relevancy,
        context_precision,
        context_recall,
    )
    from datasets import Dataset
except ImportError as e:
    print(f"Missing dependency: {e}", file=sys.stderr)
    sys.exit(1)

METRIC_MAP = {
    "faithfulness": faithfulness,
    "answer_relevancy": answer_relevancy,
    "context_precision": context_precision,
    "context_recall": context_recall,
}

# Parse requested metrics
requested = [m.strip() for m in metrics_csv.split(",") if m.strip()]
selected_metrics = []
for name in requested:
    if name in METRIC_MAP:
        selected_metrics.append(METRIC_MAP[name])
    else:
        print(f"Warning: unknown metric '{name}', skipping", file=sys.stderr)

if not selected_metrics:
    print("Error: no valid metrics selected", file=sys.stderr)
    sys.exit(1)

# Load input data
with open(input_path, "r") as f:
    data = json.load(f)

# Configure LLM if using OpenAI-compatible API
if os.environ.get("OPENAI_BASE_URL"):
    os.environ.setdefault("OPENAI_API_BASE", os.environ["OPENAI_BASE_URL"])

start_time = time.time()

# Build HuggingFace Dataset and run evaluation
dataset = Dataset.from_list(data)
result = evaluate(dataset, metrics=selected_metrics)

duration = time.time() - start_time

# Build per-row details
details = []
for i, row in enumerate(data):
    row_scores = {}
    for name in requested:
        if name in METRIC_MAP:
            col = result.to_pandas().get(name)
            if col is not None and i < len(col):
                row_scores[name] = float(col.iloc[i])
    details.append({"question": row.get("question", ""), "scores": row_scores})

# Build aggregate scores
scores = {}
for name in requested:
    if name in METRIC_MAP and name in result:
        scores[name] = float(result[name])

output = {
    "scores": scores,
    "details": details,
    "metadata": {
        "duration_seconds": round(duration, 2),
        "model_used": model_name,
        "metrics_evaluated": list(scores.keys()),
    },
}

with open(output_path, "w") as f:
    json.dump(output, f, indent=2)
`.trim();

/**
 * DeepEval evaluation runner.
 *
 * Args: <input_json_path> <output_json_path> <metrics_csv> <model_name>
 *
 * Reads DeepEval-format data ({input, actual_output, retrieval_context, expected_output}[]),
 * runs evaluation, and writes results JSON with per-metric reasoning.
 */
const DEEPEVAL_RUNNER_SCRIPT = `
import json, sys, time, os

input_path = sys.argv[1]
output_path = sys.argv[2]
metrics_csv = sys.argv[3]
model_name = sys.argv[4]

try:
    from deepeval import evaluate
    from deepeval.test_case import LLMTestCase
    from deepeval.metrics import (
        FaithfulnessMetric,
        AnswerRelevancyMetric,
        ContextualPrecisionMetric,
        ContextualRecallMetric,
    )
except ImportError as e:
    print(f"Missing dependency: {e}", file=sys.stderr)
    sys.exit(1)

METRIC_MAP = {
    "faithfulness": FaithfulnessMetric,
    "answer_relevancy": AnswerRelevancyMetric,
    "contextual_precision": ContextualPrecisionMetric,
    "contextual_recall": ContextualRecallMetric,
}

# Parse requested metrics
requested = [m.strip() for m in metrics_csv.split(",") if m.strip()]
selected_metrics = []
for name in requested:
    if name in METRIC_MAP:
        selected_metrics.append(METRIC_MAP[name](model=model_name, threshold=0.5))
    else:
        print(f"Warning: unknown metric '{name}', skipping", file=sys.stderr)

if not selected_metrics:
    print("Error: no valid metrics selected", file=sys.stderr)
    sys.exit(1)

# Load input data
with open(input_path, "r") as f:
    data = json.load(f)

# Build test cases
test_cases = []
for row in data:
    test_cases.append(LLMTestCase(
        input=row.get("input", ""),
        actual_output=row.get("actual_output", ""),
        retrieval_context=row.get("retrieval_context", []),
        expected_output=row.get("expected_output", ""),
    ))

start_time = time.time()

# Run evaluation
results = evaluate(test_cases=test_cases, metrics=selected_metrics)

duration = time.time() - start_time

# Build per-row details with reasoning
details = []
for i, tc_result in enumerate(results.test_results):
    row_scores = {}
    row_reasons = {}
    for metric_result in tc_result.metrics_data:
        name = metric_result.name
        row_scores[name] = float(metric_result.score) if metric_result.score is not None else 0.0
        row_reasons[name] = metric_result.reason or ""
    details.append({
        "input": data[i].get("input", ""),
        "scores": row_scores,
        "reasons": row_reasons,
    })

# Aggregate scores (mean across test cases)
agg_scores = {}
for name in requested:
    if name in METRIC_MAP:
        values = [d["scores"].get(name, 0.0) for d in details if name in d["scores"]]
        if values:
            agg_scores[name] = round(sum(values) / len(values), 4)

output = {
    "scores": agg_scores,
    "details": details,
    "metadata": {
        "duration_seconds": round(duration, 2),
        "model_used": model_name,
        "metrics_evaluated": list(agg_scores.keys()),
    },
}

with open(output_path, "w") as f:
    json.dump(output, f, indent=2)
`.trim();

// ============================================================================
// DEFAULT TIMEOUT
// ============================================================================

/** 5 minutes — RAGAS evaluations can be slow with many rows + LLM calls */
const DEFAULT_TIMEOUT_MS = 300_000;

/** 10 MB — generous buffer for large evaluation results */
const MAX_BUFFER = 10 * 1024 * 1024;

// ============================================================================
// PYTHON EVAL BRIDGE
// ============================================================================

/**
 * Manages Python subprocess execution for RAGAS and DeepEval evaluations.
 *
 * Usage:
 * ```ts
 * const bridge = new PythonEvalBridge({ pythonPath: config.eval.python_path });
 *
 * const avail = await bridge.checkAvailability();
 * if (avail.ragasAvailable) {
 *   const results = await bridge.runRagas('./eval_data.json', ['faithfulness', 'answer_relevancy']);
 *   console.log(results.scores);
 * }
 * ```
 */
export class PythonEvalBridge {
  private readonly pythonPath: string;
  private readonly ragasModel: string;
  private readonly timeoutMs: number;
  private readonly execFileFn: ExecFileFn;

  constructor(config: {
    pythonPath?: string;
    ragasModel?: string;
    timeoutMs?: number;
    /** @internal Inject a custom exec function for testing */
    execFile?: ExecFileFn;
  } = {}) {
    this.pythonPath = config.pythonPath ?? 'python3';
    this.ragasModel = config.ragasModel ?? 'gpt-4o-mini';
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.execFileFn = config.execFile ?? defaultExecFile;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Check if Python and eval packages are available.
   *
   * Never throws — returns a result with booleans so callers can
   * degrade gracefully (e.g., show "Install ragas: pip install ragas").
   */
  async checkAvailability(): Promise<PythonAvailability> {
    const unavailable: PythonAvailability = {
      pythonFound: false,
      pythonVersion: null,
      ragasAvailable: false,
      ragasVersion: null,
      deepevalAvailable: false,
      deepevalVersion: null,
    };

    try {
      const { stdout } = await this.execPython(AVAILABILITY_CHECK_SCRIPT, []);
      const parsed = AvailabilityOutputSchema.safeParse(JSON.parse(stdout));
      if (!parsed.success) return unavailable;

      return {
        pythonFound: parsed.data.python_found,
        pythonVersion: parsed.data.python_version,
        ragasAvailable: parsed.data.ragas_available,
        ragasVersion: parsed.data.ragas_version,
        deepevalAvailable: parsed.data.deepeval_available,
        deepevalVersion: parsed.data.deepeval_version,
      };
    } catch {
      return unavailable;
    }
  }

  /**
   * Run RAGAS evaluation on exported data.
   *
   * @param dataPath - Path to RAGAS-format JSON (from exporter.ts writeExport)
   * @param metrics  - Metric names: "faithfulness", "answer_relevancy", "context_precision", "context_recall"
   * @returns Validated RAGAS results with aggregate scores, per-row details, and metadata
   * @throws EvalError with code RAGAS_ERROR on any failure
   */
  async runRagas(dataPath: string, metrics: string[]): Promise<RagasResults> {
    this.validateRunArgs(dataPath, metrics);
    const outputPath = this.createTempOutputPath();

    try {
      await this.execPython(
        RAGAS_RUNNER_SCRIPT,
        [dataPath, outputPath, metrics.join(','), this.ragasModel],
        this.buildEvalEnv()
      );

      return await this.readAndValidateOutput(RagasOutputSchema, outputPath, 'RAGAS');
    } finally {
      this.cleanupTempFile(outputPath);
    }
  }

  /**
   * Run DeepEval evaluation on exported data.
   *
   * @param dataPath - Path to DeepEval-format JSON (from exporter.ts writeExport)
   * @param metrics  - Metric names: "faithfulness", "answer_relevancy", "contextual_precision", "contextual_recall"
   * @returns Validated DeepEval results with scores, per-row details + reasoning, and metadata
   * @throws EvalError with code RAGAS_ERROR on any failure
   */
  async runDeepEval(dataPath: string, metrics: string[]): Promise<DeepEvalResults> {
    this.validateRunArgs(dataPath, metrics);
    const outputPath = this.createTempOutputPath();

    try {
      await this.execPython(
        DEEPEVAL_RUNNER_SCRIPT,
        [dataPath, outputPath, metrics.join(','), this.ragasModel],
        this.buildEvalEnv()
      );

      return await this.readAndValidateOutput(DeepEvalOutputSchema, outputPath, 'DeepEval');
    } finally {
      this.cleanupTempFile(outputPath);
    }
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Execute a Python script via the -c flag.
   *
   * Uses execFile (not exec) to avoid shell injection — the script string
   * is passed as an argument, not interpolated into a shell command.
   */
  private async execPython(
    script: string,
    args: string[],
    extraEnv?: Record<string, string>
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      return await this.execFileFn(
        this.pythonPath,
        ['-c', script, ...args],
        {
          timeout: this.timeoutMs,
          maxBuffer: MAX_BUFFER,
          env: { ...process.env, ...extraEnv } as NodeJS.ProcessEnv,
        }
      );
    } catch (error: unknown) {
      this.handleExecError(error);
    }
  }

  /**
   * Translate subprocess errors into descriptive EvalError instances.
   */
  private handleExecError(error: unknown): never {
    // Python not found on PATH
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw EvalError.ragasError(
        `Python not found at "${this.pythonPath}". Install Python 3 or set eval.python_path in config.toml`
      );
    }

    // Subprocess killed by timeout — Node sets killed=true on the error object
    if (error instanceof Error && (error as { killed?: boolean }).killed) {
      throw EvalError.ragasError(
        `Python subprocess timed out after ${this.timeoutMs / 1000}s`
      );
    }

    // Non-zero exit with stderr
    const stderr = (error as { stderr?: string })?.stderr ?? '';
    throw EvalError.ragasError(
      stderr || (error instanceof Error ? error.message : String(error)),
      error instanceof Error ? error : undefined
    );
  }

  /**
   * Build environment variables for eval subprocess.
   * Forwards OpenAI-compatible API keys so Python can call the judge LLM.
   */
  private buildEvalEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    if (process.env['OPENAI_API_KEY']) {
      env['OPENAI_API_KEY'] = process.env['OPENAI_API_KEY'];
    }
    if (process.env['OPENAI_BASE_URL']) {
      env['OPENAI_BASE_URL'] = process.env['OPENAI_BASE_URL'];
    }
    return env;
  }

  /** Validate common arguments for runRagas/runDeepEval */
  private validateRunArgs(dataPath: string, metrics: string[]): void {
    if (!fs.existsSync(dataPath)) {
      throw EvalError.ragasError(`Input data file not found: ${dataPath}`);
    }
    if (metrics.length === 0) {
      throw EvalError.ragasError('No metrics specified');
    }
  }

  /** Read a temp output file and validate with a Zod schema */
  private async readAndValidateOutput<T>(
    schema: z.ZodSchema<T>,
    outputPath: string,
    context: string
  ): Promise<T> {
    if (!fs.existsSync(outputPath)) {
      throw EvalError.ragasError(
        `${context} script completed but produced no output file`
      );
    }

    const raw = await fs.promises.readFile(outputPath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw EvalError.ragasError(
        `${context} output is not valid JSON: ${raw.slice(0, 200)}`
      );
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw EvalError.ragasError(`Invalid ${context} output: ${issues}`);
    }

    return result.data;
  }

  /** Create a unique temp file path for Python script output */
  private createTempOutputPath(): string {
    return path.join(os.tmpdir(), `ctx-eval-${randomUUID()}.json`);
  }

  /** Best-effort cleanup of temp files — never throws */
  private cleanupTempFile(filePath: string): void {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best-effort: file may not exist if Python failed before writing
    }
  }
}

// ============================================================================
// HELPERS
// ============================================================================

/** Type guard for Node.js system errors (ENOENT, EACCES, etc.) */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
