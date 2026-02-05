# Agent Integration Guide

How to use Context Expert (`ctx`) as a tool from AI agents (Claude Code, Codex, OpenCode, etc.).

All commands support `--json` for structured output. Always use `--json` when calling `ctx` programmatically.

## Setup

### Requirements

1. Install: `npm install -g @contextexpert/cli`
2. Set an API key for the LLM provider:
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...   # or
   export OPENAI_API_KEY=sk-...
   ```
3. Index at least one project:
   ```bash
   ctx index /path/to/project --name "my-project"
   ```

### Verify Installation

```bash
ctx status --json
```

Returns version, database stats, and provider config. If this works, you're ready.

## Recommended Workflow

```
1. ctx status --json          # System health
2. ctx list --json            # Available projects
3. ctx check <project> --json # Pre-flight validation
4. ctx ask "..." --context-only --json --project <name>  # Get context (no LLM cost)
   # or
   ctx ask "..." --json --project <name>  # Full RAG + LLM answer
```

## Command Reference

### `ctx status --json`

System health and version info.

```json
{
  "version": "1.0.2",
  "nodeVersion": "v20.11.0",
  "platform": "darwin",
  "projects": 3,
  "totalChunks": 5432,
  "database": {
    "path": "/Users/you/.ctx/context.db",
    "size": 134217728,
    "sizeFormatted": "128 MB"
  },
  "embedding": {
    "provider": "huggingface",
    "model": "BAAI/bge-large-en-v1.5"
  },
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514"
  },
  "config": {
    "path": "/Users/you/.ctx/config.toml"
  }
}
```

---

### `ctx list --json`

List all indexed projects with metadata.

```json
{
  "count": 2,
  "projects": [
    {
      "id": "uuid-1",
      "name": "backend-api",
      "path": "/home/user/projects/backend",
      "tags": ["typescript", "api"],
      "fileCount": 150,
      "chunkCount": 1200,
      "indexedAt": "2026-01-15T10:00:00.000Z",
      "updatedAt": "2026-01-20T15:30:00.000Z",
      "embeddingModel": "BAAI/bge-large-en-v1.5",
      "embeddingDimensions": 1024,
      "description": "Express API with auth and payments"
    }
  ]
}
```

Key fields for agents:
- `embeddingModel` / `embeddingDimensions` — verify compatibility before querying
- `chunkCount` — 0 means project needs indexing
- `description` — useful for routing queries to the right project

---

### `ctx check <project> --json`

Pre-flight health check. Use before `ctx ask` to avoid wasted LLM calls.

```json
{
  "ready": true,
  "project": {
    "name": "backend-api",
    "path": "/home/user/projects/backend",
    "id": "uuid-1"
  },
  "chunkCount": 1200,
  "embeddingModel": "BAAI/bge-large-en-v1.5",
  "embeddingDimensions": 1024,
  "description": "Express API with auth and payments",
  "issues": [],
  "staleness": {
    "filesChanged": 0,
    "needsReindex": false,
    "pathExists": true
  }
}
```

**`ready` field**: `true` when no error-level issues exist. Warnings (stale files, model mismatch) don't block readiness.

**Exit code**: `1` when `ready` is `false`.

**Possible issues**:

| Severity | Condition | Meaning |
|----------|-----------|---------|
| `error` | `chunkCount === 0` | Project has no indexed content |
| `error` | `pathExists === false` | Source directory was moved/deleted |
| `warning` | Embedding model mismatch | Config model differs from indexed model |
| `warning` | `filesChanged > 0` | Files modified since last index |

---

### `ctx ask <question> --json`

Full RAG pipeline: retrieves context, generates LLM answer with citations.

```bash
ctx ask "How does authentication work?" --project backend-api --json
```

```json
{
  "question": "How does authentication work?",
  "answer": "Authentication uses JWT tokens...",
  "sources": [
    {
      "index": 1,
      "filePath": "src/auth/middleware.ts",
      "lineStart": 45,
      "lineEnd": 67,
      "score": 0.92,
      "language": "typescript",
      "fileType": "code"
    }
  ],
  "metadata": {
    "projectSearched": "backend-api",
    "retrievalMs": 150,
    "assemblyMs": 25,
    "generationMs": 2300,
    "totalMs": 2475,
    "tokensUsed": {
      "promptTokens": 800,
      "completionTokens": 150,
      "totalTokens": 950
    },
    "model": "claude-sonnet-4-20250514",
    "provider": "anthropic"
  }
}
```

**Empty results**: Returns `"answer": null`, `"sources": []`, `"model": null`.

| Option | Description |
|--------|-------------|
| `--project, -p` | Limit to a specific project |
| `--top-k, -k` | Number of chunks to retrieve (default: 5, max: 20) |

---

### `ctx ask <question> --context-only --json`

Retrieves RAG context **without making an LLM call**. Use this when the calling agent has its own LLM and just needs the relevant code context.

```bash
ctx ask "How does authentication work?" --context-only --project backend-api --json
```

```json
{
  "question": "How does authentication work?",
  "context": "<sources>\n  <source id=\"1\" file=\"src/auth/middleware.ts\" lines=\"45-67\" score=\"0.92\">\n    // code content\n  </source>\n</sources>",
  "estimatedTokens": 500,
  "sources": [
    {
      "index": 1,
      "filePath": "src/auth/middleware.ts",
      "lineStart": 45,
      "lineEnd": 67,
      "score": 0.92,
      "language": "typescript",
      "fileType": "code"
    }
  ],
  "metadata": {
    "projectSearched": "backend-api",
    "retrievalMs": 150,
    "assemblyMs": 25,
    "totalMs": 180
  }
}
```

Key differences from full `ctx ask`:
- No `answer` field — returns `context` (XML-formatted) instead
- No `generationMs`, `tokensUsed`, `model`, or `provider` in metadata
- No LLM API call — only costs are local embedding for query

The `context` field contains XML that can be injected directly into your own LLM prompt.

---

### `ctx search <query> --json`

Raw hybrid search without LLM generation. Returns matching code chunks.

```bash
ctx search "authentication middleware" --project backend-api --json
```

```json
{
  "query": "authentication middleware",
  "count": 5,
  "projectsSearched": ["backend-api"],
  "results": [
    {
      "score": 0.92,
      "filePath": "src/auth/middleware.ts",
      "lineStart": 45,
      "lineEnd": 67,
      "content": "export function authenticate(req, res, next) { ... }",
      "language": "typescript",
      "fileType": "code",
      "projectId": "uuid-1",
      "projectName": "backend-api"
    }
  ]
}
```

| Option | Description |
|--------|-------------|
| `--project, -p` | Limit to a specific project |
| `--top, -k` | Number of results (default: 10) |
| `--rerank, -r` | Apply BGE cross-encoder reranking |

---

### `ctx remove <name> --force --json`

Delete a project index. **Requires `--force`** in both text and JSON modes.

```bash
ctx remove old-project --force --json
```

**Success** (exit code 0):
```json
{
  "success": true,
  "project": {
    "id": "uuid-1",
    "name": "old-project",
    "path": "/home/user/projects/old"
  },
  "deleted": {
    "chunks": 500,
    "fileHashes": 150
  },
  "storageFreed": 1024000
}
```

**Without `--force`** (exit code 1, written to stderr):
```json
{
  "error": "confirmation_required",
  "action": "remove",
  "project": {
    "name": "old-project",
    "path": "/home/user/projects/old",
    "chunkCount": 500,
    "fileCount": 150
  },
  "hint": "Use --force to confirm deletion"
}
```

---

### `ctx config` subcommands

```bash
ctx config get default_model --json     # {"key":"default_model","value":"claude-sonnet-4-20250514"}
ctx config set search.top_k 20 --json   # {"success":true,"key":"search.top_k","value":20}
ctx config list --json                  # {"default_model":"...","embedding.provider":"..."}
ctx config path --json                  # {"path":"/Users/you/.ctx/config.toml"}
```

---

## Error Handling

All errors write JSON to **stderr** (not stdout) when `--json` is active.

```json
{
  "error": "Project not found: nonexistent",
  "code": 1,
  "hint": "Run: ctx list  to see available projects"
}
```

With `--verbose --json`, a `stack` field is added:

```json
{
  "error": "Project not found: nonexistent",
  "code": 1,
  "hint": "Run: ctx list  to see available projects",
  "stack": "CLIError: Project not found...\n    at resolveProject..."
}
```

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | General error, confirmation required, or project not ready |

Check both exit code and parse stdout/stderr for complete status.

## Example: CLAUDE.md Snippet

Add this to your project's `CLAUDE.md` to give Claude Code access to your indexed codebases:

```markdown
## Context Expert

Search and query indexed codebases using `ctx`:

- Check health: `ctx check my-project --json`
- Get context: `ctx ask "question" --context-only --project my-project --json`
- Search code: `ctx search "query" --project my-project --json`

The `--context-only` flag returns RAG context without LLM costs.
The `context` field in the response contains XML sources you can use directly.
```
