# Context_Expert - AI Agent Resources

**Project ID**: 10
**MCP Server**: https://projectpulsemcp.dracodev.dev/mcp
**Dashboard**: https://projectpulse.dracodev.dev/

---

## Overview

This document catalogs all AI agent resources available for Context_Expert via ProjectPulse MCP.

Resources are loaded on-demand to save tokens. Use `list` tools to discover what's available, then `get` tools to load specific resources when needed.

---

## Available Personas

Personas define expert behaviors and domain knowledge. Load one to adopt its expertise.

### How to Use Personas

```
# List all available personas
projectpulse_persona_list(projectId: 10)

# Load a specific persona
projectpulse_persona_get(projectId: 10, slug: "<persona-slug>")
→ Returns: name, systemPrompt, expertise, rules, skills, tools
```

### Persona Catalog

### DevOps & Release Expert

**Slug**: `devops-release-expert`
**Expertise**: npm Publishing, GitHub Actions, Semantic Versioning, CI/CD, Release Management

Expert in npm package publishing, GitHub Actions CI/CD, and release management for CLI tools

### RAG Pipeline Expert

**Slug**: `rag-pipeline-expert`
**Expertise**: ContextAI SDK, RAG Pipelines, Vector Search, Embeddings, Reranking

Expert in Retrieval-Augmented Generation pipelines using ContextAI SDK for embeddings, retrieval, and reranking

### SQLite & Storage Expert

**Slug**: `sqlite-storage-expert`
**Expertise**: SQLite, better-sqlite3, BLOB Storage, Schema Design, Index Optimization

Expert in SQLite database design, better-sqlite3, and vector storage patterns for local-first applications

### Testing & Quality Expert

**Slug**: `testing-quality-expert`
**Expertise**: Vitest, Unit Testing, Integration Testing, CLI Testing, Mocking

Expert in testing TypeScript CLI applications with Vitest, including unit tests, integration tests, and CLI testing patterns

### TypeScript CLI Expert

**Slug**: `typescript-cli-expert`
**Expertise**: Commander.js, Node.js CLI, Terminal UI, Argument Parsing, Zod Validation

Expert in building Node.js CLI applications with TypeScript, Commander.js, and terminal UI patterns

---

## Available Skills

Skills contain reusable coding patterns, templates, and conventions for the project.

### How to Use Skills

```
# List all skills
projectpulse_skill_list(projectId: 10)

# Filter by category
projectpulse_skill_list(projectId: 10, category: "framework")

# Load a specific skill
projectpulse_skill_get(projectId: 10, slug: "<skill-slug>")
→ Returns: Full content with code examples
```

### Skills by Category

#### framework

| Title | Slug | Description |
|-------|------|-------------|
| ContextAI SDK RAG Integration | `contextai-rag-integration` | Complete RAG pipeline setup using ContextAI SDK with hybrid retrieval, reranking, and agent integration |
| Commander.js CLI Pattern | `commander-pattern` | Standard pattern for defining CLI commands with Commander.js, including options, arguments, and help text |
| SQLite BLOB Vector Storage | `sqlite-vector-storage` | Pattern for storing and retrieving vector embeddings as BLOBs in SQLite using better-sqlite3 |
| Zod CLI Validation | `zod-cli-validation` | Pattern for validating CLI arguments and options using Zod schemas with helpful error messages |

#### workflow

| Title | Slug | Description |
|-------|------|-------------|
| Streaming Response Pattern | `streaming-response-pattern` | Pattern for streaming LLM responses in CLI applications with real-time output and thought visualization |
| CLI Error Handling Pattern | `cli-error-handling` | User-friendly error handling pattern for CLI applications with actionable messages and recovery hints |

---

## Standard Operating Procedures (SOPs)

SOPs provide step-by-step procedures for common tasks.

### How to Use SOPs

```
# List all SOPs
projectpulse_sop_list(projectId: 10)

# Filter by category
projectpulse_sop_list(projectId: 10, category: "Development")

# Load a specific SOP
projectpulse_sop_get(projectId: 10, slug: "<sop-slug>")
→ Returns: Full procedure with steps and checklists
```

### SOPs by Category

#### Deployment

| Title | Slug | Description |
|-------|------|-------------|
| npm Package Release | `npm-release` | Complete procedure for releasing a new version of Context Expert to npm |

#### Development

| Title | Slug | Description |
|-------|------|-------------|
| Adding a New CLI Command | `add-cli-command` | Step-by-step procedure for adding a new command to the Context Expert CLI |
| SQLite Schema Migration | `sqlite-migration` | Procedure for safely modifying the SQLite database schema |

#### Testing

| Title | Slug | Description |
|-------|------|-------------|
| Running Tests | `running-tests` | Standard procedure for running the Context Expert test suite |

---

## Workflow Templates

Workflow templates define multi-step processes for common tasks.

### How to Use Workflows

```
# List available workflows
projectpulse_workflow_list(projectId: 10)

# Start a workflow
projectpulse_workflow_start({
  templateId: 1,
  projectId: 10,
  initialContext: { featureName: "auth" }
})

# Execute current step
projectpulse_workflow_executeStep({ runId: 123, stepResult: {...} })

# Check status
projectpulse_workflow_getStatus({ runId: 123 })
```

---

## Knowledge Base

Project knowledge items store decisions, discoveries, and solutions.

### How to Access Knowledge

```
# Search knowledge
projectpulse_knowledge_search({
  projectId: 10,
  query: "authentication",
  mode: "hybrid"
})

# Get full item
projectpulse_knowledge_get({
  projectId: 10,
  itemId: 123
})
```

---

## Wiki

Project documentation in wiki format.

### How to Access Wiki

```
# Search wiki
projectpulse_wiki_search({ query: "API reference" })

# Get page by path
projectpulse_wiki_get({ path: "/guides/api-reference" })
```

---

## Token-Efficient Loading Pattern

To minimize token usage, follow this pattern:

```
1. Start with context_load (all memory banks)
   → Get project brief, patterns, tech context

2. List resources when needed
   → persona_list, skill_list, sop_list return metadata only (~100 tokens each)

3. Load full content on-demand
   → persona_get, skill_get, sop_get return full content

4. Search before creating
   → knowledge_search, wiki_search to find existing info
```

---

## Dashboard

View and manage all resources:

- **Overview**: https://projectpulse.dracodev.dev/projects/10
- **Personas**: https://projectpulse.dracodev.dev/projects/10/personas
- **Skills**: https://projectpulse.dracodev.dev/projects/10/skills
- **SOPs**: https://projectpulse.dracodev.dev/projects/10/sops
- **Knowledge**: https://projectpulse.dracodev.dev/projects/10/knowledge
