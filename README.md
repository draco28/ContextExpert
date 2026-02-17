# Context Expert

[![npm version](https://img.shields.io/npm/v/@contextexpert/cli.svg)](https://www.npmjs.com/package/@contextexpert/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/@contextexpert/cli.svg)](https://nodejs.org)

A cross-project context agent CLI for unified semantic search and RAG-powered Q&A across multiple codebases.

## Features

- **Cross-project indexing** — Index multiple codebases, search by project
- **RAG-powered Q&A** — Ask natural language questions with cited source references
- **Interactive chat** — Multi-turn REPL with conversation context and project focus
- **Hybrid search** — Combines dense vectors + BM25 with Reciprocal Rank Fusion
- **Local-first embeddings** — HuggingFace BGE-large runs locally, no API costs
- **Multi-provider LLMs** — Anthropic (Claude), OpenAI (GPT), or Ollama (local)
- **Smart chunking** — Language-aware code parsing with Tree-sitter AST
- **Result reranking** — BGE cross-encoder for improved relevance
- **ReAct agent** — Autonomous reasoning with tool-use decisions in chat
- **Real-time streaming** — Token-by-token responses with reasoning chain visualization
- **Adaptive RAG** — Query classification (simple/factual/complex) optimizes retrieval
- **Smart routing** — Automatic project selection via heuristic + LLM fallback
- **TUI chat mode** — Three-region terminal UI with status bar and scroll regions
- **Result caching** — LRU cache for repeated queries, reducing latency
- **Evaluation suite** — Batch retrieval quality testing with golden datasets, 6 IR metrics (MRR, Hit Rate, P@K, R@K, NDCG, MAP), trend tracking, and regression detection
- **Observability** — Always-on local trace recording with optional Langfuse v4 cloud sync via OpenTelemetry

## Installation

```bash
npm install -g @contextexpert/cli
```

**Requirements:** Node.js 20.0.0 or higher

## Quick Start

```bash
# 1. Set your API key (for LLM responses)
export ANTHROPIC_API_KEY=sk-ant-...

# 2. Index a project
ctx index ./my-project --name "my-project"

# 3. Search across your codebase
ctx search "authentication middleware"

# 4. Ask questions with RAG
ctx ask "How does the authentication flow work?"

# 5. Start interactive chat
ctx chat
```

## Commands

### `ctx index <path>`

Index a project directory for semantic search.

```bash
ctx index ./my-project --name "backend-api"
ctx index ~/code/frontend --name "frontend" --tags "react,typescript"
ctx index . --force  # Re-index, replacing existing data
```

| Option | Description |
|--------|-------------|
| `--name, -n` | Project name (defaults to directory name) |
| `--tags, -t` | Comma-separated tags for filtering |
| `--force, -f` | Replace existing index for this project |
| `--ignore` | Comma-separated gitignore-style patterns to exclude |

### `ctx list`

List all indexed projects with statistics.

```bash
ctx list
```

Shows project name, file count, chunk count, and index date.

### `ctx search <query>`

Perform hybrid semantic search across indexed projects.

```bash
ctx search "error handling"
ctx search "database connection" --project backend-api
ctx search "authentication" --top 20 --rerank
```

| Option | Description |
|--------|-------------|
| `--project, -p` | Limit search to specific project |
| `--top, -k` | Number of results (default: 10) |
| `--rerank, -r` | Apply BGE cross-encoder reranking |

### `ctx ask <question>`

Ask a question and get a RAG-powered answer with citations.

```bash
ctx ask "How does the payment processing work?"
ctx ask "What API endpoints handle user auth?" --project backend
ctx ask "Explain the caching strategy" --top-k 15 --json
```

| Option | Description |
|--------|-------------|
| `--project, -p` | Limit context to specific project |
| `--top-k, -k` | Number of chunks to retrieve (default: 5) |
| `--context-only` | Return retrieved context without LLM generation |
| `--json` | Output structured JSON response |

### `ctx chat`

Start an interactive REPL for multi-turn conversations.

```bash
ctx chat
```

**REPL Commands:**

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/focus <project>` | Focus RAG search on a specific project |
| `/unfocus` | Clear project focus |
| `/projects` | List all indexed projects |
| `/describe <name>` | Add description/tags for smart routing |
| `/clear` | Clear conversation history |
| `/share [path]` | Export conversation to markdown |
| `/index <path>` | Index a project within the chat session |
| `/provider <sub>` | Manage LLM providers (add, list, use, remove, test) |
| `/exit` | Exit the chat |

#### TUI Mode

On TTY terminals, `ctx chat` launches in **TUI mode** by default — a three-region terminal layout with independent scrolling:

| Region | Description |
|--------|-------------|
| **Chat area** | Scrollable message history and streaming LLM responses |
| **Status bar** | Model name, working directory, git branch, turn counter, session cost |
| **Input area** | readline-powered input with tab completion |

Use `--no-tui` to fall back to the classic readline REPL (also used automatically when stdout is not a TTY, e.g., piping):

```bash
ctx chat --no-tui
```

### `ctx config`

Manage configuration settings.

```bash
ctx config list              # Show all settings
ctx config get default_model # Get specific setting
ctx config set default_model gpt-4o  # Update setting
```

### `ctx status`

Show storage statistics and system health.

```bash
ctx status
```

Displays database size, total chunks, project count, and embedding model info.

### `ctx check <project>`

Pre-flight health check for a project's index readiness.

```bash
ctx check backend-api
ctx check backend-api --json
```

Checks that the project exists, has indexed chunks, the source path is on disk, and the embedding model matches current config. Returns `ready: true/false` in JSON mode. Exit code `1` when not ready.

### `ctx remove <name>`

Delete an indexed project and all its data. Requires `--force` to confirm.

```bash
ctx remove old-project --force
ctx remove old-project --force --json
```

| Option | Description |
|--------|-------------|
| `--force, -f` | Confirm deletion (required) |

### `ctx eval`

Evaluation and observability commands for measuring and monitoring retrieval quality. See the [Eval & Observability Guide](./docs/eval-observability.md) for full documentation.

```bash
# Manage golden dataset
ctx eval golden add --project my-project
ctx eval golden generate --project my-project --count 5
ctx eval golden list --project my-project

# Run evaluation
ctx eval run --project my-project
ctx eval run --project my-project --ragas

# View results
ctx eval report --project my-project
ctx eval traces --since 7d
```

| Subcommand | Description |
|------------|-------------|
| `eval run` | Run batch evaluation against golden dataset |
| `eval report` | Show eval run history with trend arrows |
| `eval traces` | List recent interaction traces |
| `eval golden list` | List golden dataset entries |
| `eval golden add` | Add a golden entry manually |
| `eval golden capture` | Promote traces to golden entries |
| `eval golden generate` | Generate golden entries using LLM |

## Configuration

Configuration is stored in `~/.ctx/config.toml`. The database is stored in `~/.ctx/context.db`.

### Environment Variables

```bash
# Required for LLM providers (set at least one)
export ANTHROPIC_API_KEY=sk-ant-...    # For Claude models
export OPENAI_API_KEY=sk-...            # For GPT models

# Optional
export OLLAMA_HOST=http://localhost:11434  # Custom Ollama URL
export CTX_CONFIG_PATH=~/.ctx/config.toml  # Override config location
export CTX_DB_PATH=~/.ctx/context.db       # Override database location

# Langfuse observability (optional)
export LANGFUSE_PUBLIC_KEY=pk-lf-...       # Langfuse cloud sync
export LANGFUSE_SECRET_KEY=sk-lf-...       # Langfuse cloud sync
export LANGFUSE_BASE_URL=https://cloud.langfuse.com  # Self-hosted override
```

### Config File

```toml
# ~/.ctx/config.toml

# LLM settings
default_model = "claude-sonnet-4-20250514"
default_provider = "anthropic"  # anthropic, openai, or ollama

# Embedding settings (local by default)
[embedding]
provider = "huggingface"
model = "BAAI/bge-large-en-v1.5"
batch_size = 32
timeout_ms = 120000              # Embedding timeout (default: 2 min)
# fallback_provider = "ollama"   # Fallback if primary fails
# fallback_model = "nomic-embed-text"

# Search settings
[search]
top_k = 10
rerank = true  # Use BGE cross-encoder

# RAG pipeline settings (optional - these are defaults)
[rag]
max_tokens = 4000       # Max tokens for LLM context
retrieve_k = 20         # Chunks to retrieve before reranking
final_k = 5             # Chunks to include after reranking
enhance_query = false   # Use LLM to enhance search query
ordering = "sandwich"   # Context ordering: sandwich, chronological, relevance

# Indexing settings (optional)
[indexing]
ignore_patterns = ["*.generated.ts", "migrations/**"]  # Additional gitignore-style patterns

# Evaluation settings (optional)
[eval]
golden_path = "~/.ctx/eval"
default_k = 5

[eval.thresholds]
mrr = 0.7
hit_rate = 0.85
precision_at_k = 0.6

# Observability settings (optional)
[observability]
enabled = true
sample_rate = 1.0
# langfuse_public_key = "pk-lf-..."
# langfuse_secret_key = "sk-lf-..."
# langfuse_host = "https://cloud.langfuse.com"
```

## Providers

### Anthropic (Default)

Claude models offer excellent code understanding and reasoning.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
ctx config set default_provider anthropic
ctx config set default_model claude-sonnet-4-20250514
```

### OpenAI

GPT models as an alternative provider.

```bash
export OPENAI_API_KEY=sk-...
ctx config set default_provider openai
ctx config set default_model gpt-4o
```

### Ollama (Local/Offline)

Run completely offline with local models. No API key required.

```bash
# Install Ollama: https://ollama.ai
ollama pull llama3.2

ctx config set default_provider ollama
ctx config set default_model llama3.2
```

**Note:** Local models may have reduced quality compared to Claude or GPT-4 for complex code questions.

## Development

```bash
# Clone and install
git clone https://github.com/draco28/ContextExpert.git
cd ContextExpert
pnpm install

# Build
pnpm build

# Run tests
pnpm test

# Run CLI locally
pnpm dev -- index ./test-project
```

### Project Structure

```
src/
├── cli/            # Commands + TUI (controller, chat-area, status-line, input)
├── agent/          # RAG engine, ReAct chat agent, query routing, tools
├── search/         # Hybrid search: dense, BM25, fusion, reranking
├── indexer/        # File scanning, chunking (Tree-sitter), embedding pipeline
├── database/       # SQLite schema, operations, migrations
├── eval/           # Golden datasets, batch evaluation, metrics, RAGAS bridge
├── observability/  # Tracer abstraction, Langfuse v4, local trace recording
├── providers/      # LLM providers: Anthropic, OpenAI, Ollama
├── config/         # TOML config loading with Zod validation
├── errors/         # Custom error classes and handler
└── utils/          # Logging, path validation, table formatting
```

## Agent Integration

All commands support `--json` for structured output, making Context Expert a first-class tool for AI agents (Claude Code, Codex, OpenCode, etc.). See the [Agent Integration Guide](./docs/agent-integration.md) for JSON response schemas, recommended workflows, and error handling.

## Evaluation & Observability

Measure retrieval quality with golden datasets and track every interaction with built-in observability. See the [Eval & Observability Guide](./docs/eval-observability.md) for setup, configuration, and the full command reference.

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

[MIT](LICENSE) © 2026

