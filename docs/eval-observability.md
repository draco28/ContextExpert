# Evaluation & Observability Guide

Measure and improve your RAG pipeline's retrieval quality with batch evaluations, and monitor every interaction with always-on observability.

## Table of Contents

- [Quick Start: Test Locally](#quick-start-test-locally)
- [Evaluation System](#evaluation-system)
  - [Golden Datasets](#golden-datasets)
  - [Running Evaluations](#running-evaluations)
  - [Viewing Reports](#viewing-reports)
  - [Metrics Reference](#metrics-reference)
  - [Regression Detection](#regression-detection)
  - [RAGAS Integration (Optional)](#ragas-integration-optional)
- [Observability System](#observability-system)
  - [Local Traces](#local-traces)
  - [Langfuse Cloud (Optional)](#langfuse-cloud-optional)
  - [Trace Sampling](#trace-sampling)
- [Configuration Reference](#configuration-reference)
- [CLI Command Reference](#cli-command-reference)
- [Agent-to-Agent Communication](#agent-to-agent-communication)
- [CI/CD Integration](#cicd-integration)
- [Database Schema](#database-schema)
- [Troubleshooting](#troubleshooting)

---

## Quick Start: Test Locally

Get eval running in under 5 minutes with an indexed project:

```bash
# 1. Build the CLI (if developing locally)
pnpm build

# 2. Verify you have an indexed project
ctx list
# If empty: ctx index ./my-project --name "my-project"

# 3. Create golden dataset entries (pick one method)
# Option A: Manual entry
ctx eval golden add --project my-project \
  --query "How does authentication work?" \
  --files "src/auth/middleware.ts,src/auth/jwt.ts"

# Option B: Auto-generate from indexed chunks using your LLM
ctx eval golden generate --project my-project --count 5

# Option C: Capture from your real usage traces
ctx ask "How does error handling work?" --project my-project
ctx eval golden capture --project my-project

# 4. Run evaluation
ctx eval run --project my-project

# 5. View report with trend arrows
ctx eval report --project my-project

# 6. View interaction traces
ctx eval traces
ctx eval traces --project my-project --since 7d
```

**Optional Langfuse cloud sync:**

```toml
# Add to ~/.ctx/config.toml
[observability]
enabled = true
langfuse_public_key = "pk-lf-..."
langfuse_secret_key = "sk-lf-..."
```

Or via environment variables:

```bash
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
```

**Optional RAGAS answer quality metrics:**

```bash
pip install ragas
export OPENAI_API_KEY=sk-...  # RAGAS uses OpenAI as the judge model
ctx eval run --project my-project --ragas
```

---

## Evaluation System

The evaluation system measures how well your RAG pipeline retrieves relevant code for a given query. It works by comparing retrieval results against a **golden dataset** of known-good query/file pairs.

### Golden Datasets

A golden dataset is a JSON file containing test cases — queries with their expected results. Stored at `~/.ctx/eval/<projectName>/golden.json`.

**Format:**

```json
{
  "version": "1.0",
  "projectName": "my-project",
  "entries": [
    {
      "id": "a1b2c3d4-...",
      "query": "How does authentication work?",
      "expectedFilePaths": ["src/auth/middleware.ts", "src/auth/jwt.ts"],
      "expectedAnswer": "Authentication uses JWT tokens stored in HTTP-only cookies...",
      "tags": ["auth", "critical"],
      "source": "manual"
    }
  ]
}
```

Golden datasets use **file paths** (not chunk IDs), so they survive re-indexing.

**Four ways to populate:**

| Method | Command | Best For |
|--------|---------|----------|
| **Manual** | `ctx eval golden add --project X` | High-quality curated entries |
| **LLM Generation** | `ctx eval golden generate --project X --count N` | Quick bootstrapping |
| **Trace Capture** | `ctx eval golden capture --project X` | Real-world queries from usage |
| **Direct Edit** | Edit `~/.ctx/eval/X/golden.json` | Bulk edits, scripting |

**Sources** track provenance: `manual` (hand-written), `generated` (LLM-created), `captured` (promoted from traces).

### Running Evaluations

```bash
ctx eval run --project my-project
```

This runs every golden dataset entry through your RAG pipeline, compares retrieved files against expected files, and computes 6 retrieval quality metrics.

Example output:

```
Evaluation Results: my-project
Run ID: a1b2c3d4  |  Queries: 10

Metric         Value    Target   Status
------------------------------------------
  MRR            0.850    0.700   PASS
  Hit Rate       0.900    0.850   PASS
  Precision@K    0.720    0.600   PASS
  Recall@K       0.800        -      -
  NDCG           0.830        -      -
  MAP            0.790        -      -

  All 3 threshold metrics passing
```

When there's a previous run to compare against, you'll also see **Change** and **Trend** columns with delta values and directional arrows.

### Viewing Reports

```bash
ctx eval report --project my-project
ctx eval report --project my-project --last 20  # Analyze last 20 runs
```

Shows eval run history with per-metric trends, letting you track quality over time and catch regressions early.

### Metrics Reference

| Metric | What It Measures | Default Threshold |
|--------|-----------------|-------------------|
| **MRR** (Mean Reciprocal Rank) | How quickly we find the first relevant result. MRR=1.0 means the first result is always relevant. | 0.7 |
| **Hit Rate** | Fraction of queries with at least one relevant result in top-k. The most intuitive metric: "do we find anything useful?" | 0.85 |
| **Precision@K** | Fraction of top-k results that are relevant. High precision means few irrelevant results. | 0.6 |
| **Recall@K** | Fraction of all relevant documents found in top-k. High recall means most relevant files are surfaced. | -- |
| **NDCG** (Normalized Discounted Cumulative Gain) | Rank-aware metric that penalizes relevant results at lower positions. Rewards having the best results at the top. | -- |
| **MAP** (Mean Average Precision) | Average precision computed at each relevant result position. Combines precision and recall into a single rank-aware score. | -- |

All values are in [0, 1] range. Higher is better. Only MRR, Hit Rate, and Precision@K have configurable pass/fail thresholds.

### Regression Detection

When comparing to a previous run, metrics are classified as:

| Arrow | Meaning | Threshold |
|-------|---------|-----------|
| Green up arrow | **Improvement** — metric increased by > 5 percentage points | +0.05 |
| Red down arrow | **Regression** — metric decreased by > 5 percentage points | -0.05 |
| Dim right arrow | **Stable** — change within 5 percentage points | +/- 0.05 |

Customize thresholds in your config:

```toml
[eval.thresholds]
mrr = 0.7           # Minimum MRR to pass
hit_rate = 0.85     # Minimum hit rate to pass
precision_at_k = 0.6  # Minimum precision to pass
```

### RAGAS Integration (Optional)

[RAGAS](https://docs.ragas.io/) provides **answer quality** metrics that go beyond retrieval — measuring whether the generated answer is faithful to the context and relevant to the question.

**Prerequisites:**

- Python 3.8+ installed
- RAGAS package: `pip install ragas`
- OpenAI API key (RAGAS uses it as the judge model): `export OPENAI_API_KEY=sk-...`

**Usage:**

```bash
ctx eval run --project my-project --ragas
```

This runs retrieval metrics first, then exports the data and invokes RAGAS via a Python subprocess. Four answer quality metrics are computed:

| Metric | What It Measures |
|--------|-----------------|
| **Faithfulness** | Is the answer grounded in the retrieved context? (no hallucination) |
| **Answer Relevancy** | Does the answer address the actual question? |
| **Context Precision** | Are the retrieved chunks relevant to the question? |
| **Context Recall** | Does the retrieved context contain the information needed to answer? |

**Configuration:**

```toml
[eval]
python_path = "python3"       # Python executable (default: python3)
ragas_model = "gpt-4o-mini"   # Judge model for RAGAS (default: gpt-4o-mini)
```

**Graceful degradation:** If Python is not found or RAGAS is not installed, the command skips answer quality with a warning and still reports retrieval metrics.

---

## Observability System

Observability provides visibility into every RAG interaction — what was queried, what was retrieved, how long it took, and what answer was generated.

### Local Traces

Every `ctx ask`, `ctx search`, and `ctx chat` interaction is **automatically recorded** to the local SQLite database (`eval_traces` table). No configuration needed — this is always on by default.

Each trace captures:

| Field | Description |
|-------|-------------|
| `query` | The user's original question |
| `retrieved_files` | File paths returned by the RAG pipeline |
| `top_k` | Number of results requested |
| `latency_ms` | End-to-end retrieval latency |
| `answer` | LLM-generated answer (null for search-only) |
| `retrieval_method` | dense, bm25, or fusion |
| `trace_type` | ask, search, or chat |
| `metadata` | Token usage, model info, etc. |
| `feedback` | Optional user feedback (positive/negative) |
| `langfuse_trace_id` | Link to Langfuse cloud trace (if configured) |

**View traces:**

```bash
ctx eval traces                           # All recent traces
ctx eval traces --project my-project      # Filter by project
ctx eval traces --since 7d --type ask     # Last 7 days, ask commands only
ctx eval traces --limit 50               # Show more results
```

### Langfuse Cloud (Optional)

For production monitoring, you can sync traces to [Langfuse](https://langfuse.com/) for dashboards, analytics, and team collaboration.

**Architecture:**

```
ctx ask/search/chat
    |
    v
+---------------------------+
| Tracer (factory pattern)  |
|   Config has keys? -----> LangfuseTracer (OTel + Langfuse cloud)
|   No keys? ------------> NoopTracer (zero overhead)
+---------------------------+
    |
    v
RAG pipeline instrumented with child spans:
  - Root trace: "ctx-ask" / "ctx-search" / "ctx-chat-turn"
  - Child span: "rag-engine-search" (query, topK, results)
  - Child generation: LLM call (model, tokens, latency)
```

**Setup:**

1. Create a [Langfuse account](https://cloud.langfuse.com/)
2. Get your API keys from Settings
3. Add to `~/.ctx/config.toml`:

```toml
[observability]
enabled = true
langfuse_public_key = "pk-lf-..."
langfuse_secret_key = "sk-lf-..."
# langfuse_host = "https://cloud.langfuse.com"  # Default, override for self-hosted
```

Or via environment variables (takes precedence over config):

```bash
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
export LANGFUSE_BASE_URL="https://cloud.langfuse.com"  # Optional override
```

The `langfuse_trace_id` column in local SQLite traces links each local record to its Langfuse cloud counterpart for cross-referencing.

### Trace Sampling

For high-traffic deployments, reduce local SQLite disk usage with sampling:

```toml
[observability]
sample_rate = 1.0   # Default: record everything
# sample_rate = 0.5 # Record 50% of interactions
# sample_rate = 0.0 # Disable local recording entirely
```

This controls local SQLite recording only. Langfuse cloud sync has its own sampling via the Langfuse SDK.

---

## Configuration Reference

### `[eval]` Section

```toml
[eval]
# Directory for golden datasets (default: ~/.ctx/eval)
# Structure: <golden_path>/<projectName>/golden.json
golden_path = "~/.ctx/eval"

# Default k for Precision@K, Recall@K, NDCG@K (default: 5)
# Common values: 5 (focused), 10 (comprehensive), 20 (recall-heavy)
default_k = 5

# Python executable path for RAGAS integration (default: python3)
python_path = "python3"

# LLM model for RAGAS answer evaluation (default: gpt-4o-mini)
ragas_model = "gpt-4o-mini"

[eval.thresholds]
# Quality thresholds for pass/fail (all 0-1)
mrr = 0.7
hit_rate = 0.85
precision_at_k = 0.6
```

### `[observability]` Section

```toml
[observability]
# Enable trace recording (default: true)
enabled = true

# Trace sampling rate for local SQLite (default: 1.0 = all)
# 0.5 = 50% of interactions, 0.0 = none
sample_rate = 1.0

# Langfuse cloud sync (optional - omit for local-only mode)
langfuse_public_key = "pk-lf-..."
langfuse_secret_key = "sk-lf-..."
langfuse_host = "https://cloud.langfuse.com"
```

**Environment variable overrides** (take precedence over config.toml):

| Variable | Config Equivalent |
|----------|-------------------|
| `LANGFUSE_PUBLIC_KEY` | `observability.langfuse_public_key` |
| `LANGFUSE_SECRET_KEY` | `observability.langfuse_secret_key` |
| `LANGFUSE_BASE_URL` | `observability.langfuse_host` |

---

## CLI Command Reference

All commands support `--json` for structured output.

### `ctx eval run`

Run batch evaluation against a golden dataset.

```bash
ctx eval run --project <name> [--top-k <N>] [--ragas] [--json]
```

| Option | Description |
|--------|-------------|
| `--project, -p` | Project to evaluate (required) |
| `--top-k, -k` | Override retrieval top-k (1-100, default from config) |
| `--ragas` | Include RAGAS answer quality (requires Python + ragas) |
| `--json` | Output structured JSON |

**JSON output:**

```json
{
  "run_id": "a1b2c3d4-...",
  "project_name": "my-project",
  "timestamp": "2026-02-17T10:30:00.000Z",
  "query_count": 10,
  "metrics": {
    "mrr": 0.850,
    "precision_at_k": 0.700,
    "recall_at_k": 0.800,
    "hit_rate": 0.900,
    "ndcg": 0.820,
    "map": 0.780
  },
  "thresholds": { "mrr": 0.7, "hit_rate": 0.85, "precision_at_k": 0.6 },
  "passed": true,
  "comparison": {
    "previous_run_id": "e5f6g7h8-...",
    "metric_changes": { "mrr": 0.050, "hit_rate": -0.020 }
  },
  "regressions": [],
  "improvements": ["MRR"],
  "ragas": null
}
```

Key fields: `passed` is `true` when all threshold metrics meet targets. `regressions` lists metric names that dropped > 5 points.

---

### `ctx eval report`

Show eval run history with trend analysis.

```bash
ctx eval report --project <name> [--last <N>] [--json]
```

| Option | Description |
|--------|-------------|
| `--project, -p` | Project to report on (required) |
| `--last, -l` | Number of recent runs to analyze (default: 10) |
| `--json` | Output structured JSON |

**JSON output:**

```json
{
  "project_name": "my-project",
  "run_count": 5,
  "current_run_id": "a1b2c3d4-...",
  "previous_run_id": "e5f6g7h8-...",
  "trends": [
    {
      "metric": "mrr",
      "current": 0.85,
      "previous": 0.80,
      "delta": 0.05,
      "direction": "stable",
      "is_regression": false,
      "is_improvement": false
    }
  ],
  "has_regressions": false,
  "has_improvements": false
}
```

---

### `ctx eval traces`

List recent interaction traces.

```bash
ctx eval traces [--project <name>] [--limit <N>] [--since <duration>] [--type <type>] [--json]
```

| Option | Description |
|--------|-------------|
| `--project, -p` | Filter by project name |
| `--limit, -l` | Maximum traces to show (default: 20) |
| `--since, -s` | Filter by recency: `7d`, `24h`, `2w` |
| `--type, -t` | Filter by trace type: `ask`, `search`, `chat` |
| `--json` | Output structured JSON |

**JSON output:**

```json
{
  "count": 5,
  "traces": [
    {
      "id": "uuid",
      "project_id": "uuid",
      "query": "How does auth work?",
      "timestamp": "2026-02-17T10:30:00.000Z",
      "retrieved_files": ["src/auth/middleware.ts"],
      "top_k": 5,
      "latency_ms": 150,
      "answer": "Authentication uses JWT...",
      "retrieval_method": "fusion",
      "feedback": null,
      "metadata": { "tokensUsed": { "total": 950 } },
      "langfuse_trace_id": null,
      "trace_type": "ask"
    }
  ]
}
```

---

### `ctx eval golden list`

List golden dataset entries for a project.

```bash
ctx eval golden list --project <name> [--json]
```

**JSON output:**

```json
{
  "count": 10,
  "entries": [
    {
      "id": "uuid",
      "query": "How does authentication work?",
      "expectedFilePaths": ["src/auth/middleware.ts"],
      "expectedAnswer": null,
      "tags": ["auth"],
      "source": "manual"
    }
  ]
}
```

---

### `ctx eval golden add`

Add a golden entry manually.

```bash
# Interactive mode (prompts for each field)
ctx eval golden add --project <name>

# Non-interactive mode (for scripting/CI)
ctx eval golden add --project <name> \
  --query "How does auth work?" \
  --files "src/auth.ts,src/middleware.ts" \
  --answer "Auth uses JWT tokens" \
  --tags "auth,critical"
```

| Option | Description |
|--------|-------------|
| `--project, -p` | Project name (required) |
| `--query` | Query text (skips interactive prompt) |
| `--files` | Expected file paths (comma-separated) |
| `--answer` | Expected answer text |
| `--tags` | Tags (comma-separated) |

---

### `ctx eval golden capture`

Promote real usage traces to golden dataset entries.

```bash
ctx eval golden capture --project <name> [--limit <N>] [--since <duration>]
```

Shows a numbered list of recent traces. Select which to promote by entering comma-separated numbers. Deduplicates against existing golden entries.

---

### `ctx eval golden generate`

Generate golden entries using your configured LLM.

```bash
ctx eval golden generate --project <name> [--count <N>]
```

Samples random indexed chunks, asks the LLM to generate test questions, and presents them for review before saving. Default count: 5.

---

## Agent-to-Agent Communication

All eval commands support `--json`, making them consumable by other AI agents (Claude Code, Codex, OpenCode, etc.).

### Quality Gate Workflow

An agent modifying search or indexing code can validate its changes:

```bash
# 1. Run eval after code changes
ctx eval run --project my-project --json

# 2. Check the "passed" field
# If passed=false, the agent should investigate regressions

# 3. Check trends over time
ctx eval report --project my-project --json
```

### Debugging Search Quality

An agent investigating poor search results can:

```bash
# View recent traces for a specific command type
ctx eval traces --project my-project --type ask --since 24h --json

# Check golden dataset coverage
ctx eval golden list --project my-project --json
```

### CLAUDE.md Integration

Add eval commands to your project's `CLAUDE.md` to give agents access:

```markdown
### Eval Commands
- Run evaluation: `ctx eval run --project my-project --json`
- Eval trends: `ctx eval report --project my-project --json`
- View traces: `ctx eval traces --project my-project --json`
- Golden entries: `ctx eval golden list --project my-project --json`
```

---

## CI/CD Integration

### GitHub Actions Eval Workflow

The project includes `.github/workflows/eval.yml` which:

- **Triggers on PRs** touching `src/search/`, `src/agent/`, `src/indexer/`, `src/eval/`
- **Runs weekly** (Monday 6 AM UTC) to catch regressions
- **Manual dispatch** for on-demand evaluation
- Runs retrieval eval against test fixtures (no external API keys needed)
- Checks quality thresholds and fails the PR check if below
- Uploads eval results as artifacts for debugging

### Adding Eval to Your CI

```yaml
- name: Run eval
  run: |
    pnpm build
    ctx eval run --project my-project --json > eval-results.json

- name: Check thresholds
  run: node scripts/check-eval-thresholds.js eval-results.json
```

**Environment variable overrides for CI thresholds:**

| Variable | Default | Description |
|----------|---------|-------------|
| `EVAL_THRESHOLD_MRR` | 0.6 | Minimum MRR to pass |
| `EVAL_THRESHOLD_PRECISION` | 0.5 | Minimum Precision@K to pass |
| `EVAL_THRESHOLD_HIT_RATE` | 0.8 | Minimum Hit Rate to pass |

---

## Database Schema

Three tables are created automatically via migration 004:

### `eval_traces`

One row per `ctx ask`/`ctx search`/`ctx chat` interaction.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `project_id` | TEXT FK | References projects.id |
| `query` | TEXT | User's query |
| `timestamp` | TEXT | ISO 8601 |
| `retrieved_files` | TEXT | JSON array of file paths |
| `top_k` | INTEGER | Results requested |
| `latency_ms` | INTEGER | Retrieval latency |
| `answer` | TEXT | LLM answer (nullable) |
| `retrieval_method` | TEXT | dense, bm25, or fusion |
| `feedback` | TEXT | positive/negative (nullable) |
| `metadata` | TEXT | JSON metadata (nullable) |
| `langfuse_trace_id` | TEXT | Langfuse link (nullable) |
| `trace_type` | TEXT | ask, search, or chat (nullable) |

### `eval_runs`

One row per batch evaluation execution.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `project_id` | TEXT FK | References projects.id |
| `timestamp` | TEXT | ISO 8601 |
| `dataset_version` | TEXT | Golden dataset version |
| `query_count` | INTEGER | Queries evaluated |
| `metrics` | TEXT | JSON aggregate metrics |
| `config` | TEXT | JSON RAG config snapshot |
| `notes` | TEXT | Human-readable notes (nullable) |

### `eval_results`

One row per golden entry per eval run.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `eval_run_id` | TEXT FK | References eval_runs.id |
| `query` | TEXT | Query text |
| `expected_files` | TEXT | JSON expected file paths |
| `retrieved_files` | TEXT | JSON actual file paths |
| `latency_ms` | INTEGER | Per-query latency |
| `metrics` | TEXT | JSON per-query metrics |
| `passed` | INTEGER | 0 or 1 (boolean) |

All tables have **CASCADE DELETE** on their foreign keys. Deleting a project removes all its traces, runs, and results.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Golden dataset not found for project" | Create entries: `ctx eval golden add --project X` |
| "Project not found" | Check name: `ctx list` |
| "Project has no indexed chunks" | Index first: `ctx index <path> --name X` |
| Python not found (RAGAS) | Set `[eval] python_path` in config.toml or install Python |
| RAGAS package not installed | Run `pip install ragas` |
| "No traces found" | Use `ctx ask` or `ctx search` first to generate traces |
| Langfuse traces not appearing | Verify API keys are set and `[observability] enabled = true` |
| Low metrics after re-indexing | Golden file paths are relative -- ensure your project path hasn't changed |
| "Invalid --top-k value" | Must be an integer between 1 and 100 |
| "Invalid --type value" | Allowed: `ask`, `search`, `chat` |
