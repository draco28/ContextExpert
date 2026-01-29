# Context_Expert - OpenCode Workflow Guide

**Project ID**: 10
**MCP Server**: https://projectpulsemcp.dracodev.dev/mcp
**Dashboard**: https://projectpulse.dracodev.dev/

---

## Quick Start

Initialize the project session:

```bash
/init
```

Chat with the agent:

```
"Implement the project indexing feature"
"Fix the bug in the search command"
```

---

## 🚀 Daily Workflow

### 1. Load Context (Crucial)

Start every session by loading the project context from ProjectPulse:

```javascript
projectpulse_context_load({ projectId: 10 });
```

This loads the project brief, tech stack, and active tasks into memory.

### 2. Manage Tasks

Use the ProjectPulse ticket system to track work:

```javascript
// Find your tickets
projectpulse_ticket_search({ sprintNumber: 1, status: ['todo'] });

// Start a session for a ticket
projectpulse_agent_session_start({
  projectId: 10,
  name: 'Implement Feature X',
  activeTicketIds: [123],
});
```

---

## 🤖 Specialized Agents

We have specialized agents available as subagents. Invoke them with `@` or let the main agent delegate to them.

| Agent | Mention | Expertise |
|-------|---------|-----------|
| **CLI Architect** | `@cli-architect` | Commander.js, Node.js CLI, Terminal UI, Zod Validation |
| **RAG Engineer** | `@rag-engineer` | ContextAI SDK, RAG Pipelines, Vector Search, Embeddings |
| **Storage Expert** | `@storage-expert` | SQLite, better-sqlite3, BLOB Storage, Schema Design |
| **Test Engineer** | `@test-engineer` | Vitest, Unit Testing, CLI Testing, Mocking |
| **Code Reviewer** | `@code-reviewer` | Code Review, Gap Analysis, ProjectPulse Integration |

Example:

> `@cli-architect` Add a new command to export project data as JSON.

---

## 🧠 Skills & SOPs

Reusable patterns and procedures are available via the `skill` tool.

**Usage:**

```javascript
skill({ name: 'typescript-cli-patterns' });
skill({ name: 'rag-integration' });
skill({ name: 'code-reviewer' });
```

**Available Skills:**

**Framework Skills:**
- `typescript-cli-patterns` - Commander.js patterns, Zod validation, terminal UI
- `rag-integration` - ContextAI SDK RAG pipeline, hybrid retrieval, reranking
- `sqlite-patterns` - BLOB vector storage, schema design, query optimization
- `testing-patterns` - Vitest mocking, async testing, CLI testing
- `error-handling` - Typed errors, recovery hints, retry logic
- `security-checklist` - Security review patterns, input validation

**Workflow Skills:**
- `code-reviewer` - Review tickets in "in-review" status, detect gaps, move tickets (activate with `/review`)

**Standard Operating Procedures (SOPs):**

- `commander-pattern` - CLI command structure and validation
- `contextai-rag-integration` - RAG pipeline setup
- `sqlite-vector-storage` - Vector storage patterns
- `zod-cli-validation` - Input validation
- `streaming-response-pattern` - Streaming LLM responses
- `cli-error-handling` - User-friendly error messages
- `npm-release-sop` - npm publishing
- `add-cli-command-sop` - Adding new commands
- `sqlite-migration-sop` - Database migrations
- `running-tests-sop` - Running the test suite

---

## 🛠 ProjectPulse MCP Tools

Full access to the ProjectPulse ecosystem is available via MCP tools:

- **Knowledge Base**: `projectpulse_knowledge_search`
- **Wiki**: `projectpulse_wiki_search`
- **Roadmap**: `projectpulse_sprint_getCurrentPosition`
- **Kanban**: `projectpulse_kanban_getBoard`
- **Tickets**: `projectpulse_ticket_get`, `projectpulse_ticket_addComment`
- **Agent Sessions**: `projectpulse_agent_session_start`, `projectpulse_agent_session_end`

---

## 📋 Code Review Workflow

The `/review` command activates the code reviewer skill:

```bash
/review [ticket-number]
```

**Workflow:**

1. Load context: `projectpulse_context_load({ projectId: 10 })`
2. Get kanban board: `projectpulse_kanban_getBoard()`
3. For each ticket in "in-review":
   - Get ticket details: `projectpulse_ticket_get()`
   - Analyze git history (git log, git diff)
   - Review code files
   - Check for gaps across 10 categories:
     - Functionality, Testing, Type Safety, API Design
     - Error Handling, Security, Performance
     - Documentation, Accessibility, Code Quality
   - If gaps found: add comment + move to "in-progress"
   - If no gaps: add approval + move to "done"

**Gap Categories:**

All gap categories are checked during review, with gaps categorized based on the ticket's work:
- **Functionality** - Requirements met? Edge cases?
- **Testing** - Tests added? Edge cases covered?
- **Type Safety** - No `any`? Proper generics?
- **API Design** - Interface-first? Consistent?
- **Error Handling** - Proper errors? No swallowing?
- **Security** - Input validation? No injection? Secrets protected?
- **Performance** - No N+1? Proper memoization?
- **Documentation** - JSDoc? Examples? Changelog?
- **Accessibility** - A11y considered?
- **Code Quality** - Readable? No duplication?

---

## Token Efficiency

1. **Load Context First**: Use `projectpulse_context_load({ projectId: 10 })`.
2. **Use Specialized Agents**: They have focused system prompts (e.g., `@cli-architect`).
3. **Load Skills On-Demand**: Don't ask for "all skills", ask for specific ones using `skill()`.

---

## 🎯 Quick Reference

```javascript
// Load project context
projectpulse_context_load({ projectId: 10 })

// Review tickets
/review                    // Review all tickets in "in-review"
/review 5                  // Review specific ticket #5

// Use specialized agents
@cli-architect            // Get help with CLI development
@rag-engineer             // Get help with RAG implementation
@storage-expert           // Get help with database design
@test-engineer            // Get help with testing
@code-reviewer            // Get help with code review

// Load skills
skill({ name: 'typescript-cli-patterns' })
skill({ name: 'rag-integration' })
skill({ name: 'sqlite-patterns' })

// Access knowledge
projectpulse_knowledge_search({ projectId: 10, query: "RAG pipeline" })
projectpulse_wiki_search({ query: "CLI commands" })
```
