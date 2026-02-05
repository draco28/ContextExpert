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
| `/focus <project>` | Limit context to a project |
| `/unfocus` | Search all projects again |
| `/projects` | List indexed projects |
| `/clear` | Clear conversation history |
| `/provider <name>` | Switch LLM provider |
| `/exit` | Exit the chat session |

#### TUI Mode

On TTY terminals, `ctx chat` launches in **TUI mode** by default — a three-region terminal layout with independent scrolling:

| Region | Description |
|--------|-------------|
| **Chat area** | Scrollable message history and streaming LLM responses |
| **Status bar** | Mode indicator, context gauge, session cost, current activity |
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

# Search settings
[search]
top_k = 10
rerank = true  # Use BGE cross-encoder

# RAG settings (optional - these are defaults)
[rag]
max_tokens = 4000       # Max tokens for LLM context
retrieve_k = 20         # Chunks to retrieve before reranking
final_k = 5             # Chunks to include after reranking
enhance_query = false   # Use LLM to enhance search query
ordering = "sandwich"   # Context ordering: sandwich, chronological, relevance
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
├── cli/        # Command definitions (index, ask, chat, etc.)
├── agent/      # RAG engine and citation handling
├── indexer/    # File scanning, chunking, embedding pipeline
├── search/     # Hybrid retrieval and vector storage
├── database/   # SQLite schema and operations
├── providers/  # LLM and embedding provider setup
└── config/     # Configuration loading and defaults
```

For architecture details, see [SPEC.md](./SPEC.md).

## Agent Integration

All commands support `--json` for structured output, making Context Expert a first-class tool for AI agents (Claude Code, Codex, OpenCode, etc.). See the [Agent Integration Guide](./docs/agent-integration.md) for JSON response schemas, recommended workflows, and error handling.

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

[MIT](LICENSE) © 2026

