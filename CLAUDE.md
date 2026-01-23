# Context_Expert - AI Workflow Guide

**Project ID**: 10
**MCP Server**: https://projectpulsemcp.dracodev.dev/mcp
**Dashboard**: https://projectpulse.dracodev.dev/

---

## Quick Start

Just chat naturally with me (Claude Code / Windsurf / Droid):

```
"Implement the user authentication feature"
"Fix the bug in the search API"
"Add tests for the payment module"
```

---

## CRITICAL: Start Every Session Here

### Step 1: Load Context

```
projectpulse_context_load(projectId: 10)
```

This returns:
- All 5 memory banks (project brief, patterns, tech context, active focus, progress)
- Active sessions (check if PAUSED work exists)
- Available resources (personas, skills, SOPs)
- Workflow hints

**If PAUSED session found:** Resume with `projectpulse_agent_session_resume(sessionId)`
**If no session:** Start new with `projectpulse_agent_session_start()`

---

## Daily Workflow

### Morning: Start Work

```
Step 1: Load context
─────────────────────
projectpulse_context_load(projectId: 10)
→ Returns: memory banks, active sessions, available resources

Step 2: Check roadmap position (if using roadmap)
─────────────────────────────────────────────────
projectpulse_sprint_getCurrentPosition(projectId: 10)
→ Returns: phase/sprint with progress

Step 3: Find "todo" tickets to work on (Sprint 16)
──────────────────────────────────────────────────
projectpulse_ticket_search({
  sprintNumber: 1,
  status: ["todo"]  // Only "todo" tickets can be claimed
})
→ Returns: Tickets ready to be claimed by session

Step 4: Start session WITH tickets (Sprint 16: auto-claims)
───────────────────────────────────────────────────────────
projectpulse_agent_session_start({
  projectId: 10,
  name: "Sprint 1 - Feature Implementation",
  activeTicketIds: [42, 43],  // MUST be "todo" status
  plan: "## Today's Plan\n1. Complete API endpoint\n2. Write tests",
  todos: [
    {content: "Complete API endpoint", status: "pending"},
    {content: "Write tests", status: "pending"}
  ]
})
→ System: tickets move to "in-progress", assignee="Claude Code"
```

### During Work

```
1. Work on code → (your normal coding flow - tickets already claimed by session_start)
2. Checkpoint every 15K tokens → agent_session_update({ progress: "..." })
3. Add comments → ticket_addComment({ ticketId: 42, content: "Implemented X, Y, Z" })
```

Note: Tickets were auto-claimed when session started. Don't manually change status.

### End of Day

```
Option A: Session complete → tickets go to in-review for user verification
──────────────────────────────────────────────────────────────────────────
projectpulse_agent_session_end({
  sessionId: "...",
  progress: "Completed API endpoint and tests"
})
→ System: linked tickets auto-move to "in-review"
→ User can verify and drag "in-review" → "done" in Kanban

Option B: Taking a break → tickets stay in-progress
──────────────────────────────────────────────────
projectpulse_agent_session_update({
  sessionId: "...",
  status: "PAUSED"
})
→ Tickets stay in "in-progress", can resume tomorrow
```

### Kanban Drag Rules (Sprint 16)

| User CAN Drag | User CANNOT Drag |
|---------------|------------------|
| backlog → todo | todo → in-progress |
| in-review → done | in-progress → anywhere |

**Why?** Agent sessions control the middle columns to ensure proper work tracking.

---

## Loading Project Resources (via MCP)

### Personas (Expert Roles)

```
# List available personas
projectpulse_persona_list(projectId: 10)

# Load a specific persona
projectpulse_persona_get(projectId: 10, slug: "backend-developer")
```

### Skills (Coding Patterns)

```
# List available skills
projectpulse_skill_list(projectId: 10, category: "framework")

# Load a skill
projectpulse_skill_get(projectId: 10, slug: "react-hooks-patterns")
```

### SOPs (Procedures)

```
# List available SOPs
projectpulse_sop_list(projectId: 10, category: "Development")

# Load an SOP
projectpulse_sop_get(projectId: 10, slug: "git-workflow")
```

---

## Available Personas

| Persona | Slug | Expertise |
|---------|------|-----------|
| DevOps & Release Expert | `devops-release-expert` | npm Publishing, GitHub Actions, Semantic Versioning, CI/CD, Release Management |
| RAG Pipeline Expert | `rag-pipeline-expert` | ContextAI SDK, RAG Pipelines, Vector Search, Embeddings, Reranking |
| SQLite & Storage Expert | `sqlite-storage-expert` | SQLite, better-sqlite3, BLOB Storage, Schema Design, Index Optimization |
| Testing & Quality Expert | `testing-quality-expert` | Vitest, Unit Testing, Integration Testing, CLI Testing, Mocking |
| TypeScript CLI Expert | `typescript-cli-expert` | Commander.js, Node.js CLI, Terminal UI, Argument Parsing, Zod Validation |

---

## Available Skills

| Skill | Slug | Category | Description |
|-------|------|----------|-------------|
| CLI Error Handling Pattern | `cli-error-handling` | workflow | User-friendly error handling for CLI with actionable messages |
| Streaming Response Pattern | `streaming-response-pattern` | workflow | Streaming LLM responses with real-time output |
| Commander.js CLI Pattern | `commander-pattern` | framework | Standard pattern for defining CLI commands |
| ContextAI SDK RAG Integration | `contextai-rag-integration` | framework | Complete RAG pipeline setup using ContextAI SDK |
| ContextAI SDK Expert Reference | `contextai-sdk-reference` | reference | Comprehensive API reference for ContextAI SDK |
| SQLite BLOB Vector Storage | `sqlite-vector-storage` | framework | Storing vector embeddings as BLOBs in SQLite |
| Zod CLI Validation | `zod-cli-validation` | framework | Validating CLI arguments with Zod schemas |

---

## Roadmap Workflow (Optional)

**Use roadmap for multi-week projects with phases. Skip for single fixes.**

### When to Use Roadmap

- ✅ Greenfield projects with timeline structure
- ✅ Multi-sprint initiatives
- ❌ Single bug fixes (just use tickets)
- ❌ Small improvements (tickets-only is fine)

### Roadmap Tools

| Tool | When to Use |
|------|-------------|
| `roadmap_create` | Once per project, after onboarding |
| `getCurrentPosition` | Start of each work day |
| `getPhaseProgress` | See full phase tree |
| `kanban_moveTicket` | Move tickets across columns (auto-cascades progress) |
| `kanban_getBoard` | Get sprint's Kanban board with all tickets |

### Ticket Scheduling

```
projectpulse_ticket_create({
  projectId: 10,
  title: "Implement feature X",
  kind: "feature",
  sprintNumber: 1,    // Sprint for Kanban board
  estimatedDays: 2    // Estimated duration
})
```

---

## Ticket Workflow

### Ticket Kinds

| User Says | Ticket Kind |
|-----------|-------------|
| "Add feature X" | `feature` |
| "Do X", "Set up X" | `task` |
| "X is broken" | `bug` |
| "X needs refactoring" | `tech_debt` |
| "Concerned about X" | `issue` |

### CRITICAL: Ticket Identification (Sprint 17)

**Users see #123 in the UI** - this is `ticketNumber` (project-scoped).
**DO NOT** use this as `ticketId` - that's a different number (global database ID)!

| User Says | Parameter to Use | Example |
|-----------|------------------|---------|
| "#5", "ticket 5" | `ticketNumber` + `projectId` | `ticket_get({ ticketNumber: 5, projectId: 10 })` |
| (from API response) | `ticketId` | `ticket_update({ ticketId: 42, ... })` |

**Rule**: If USER gave you the number, use `ticketNumber`. If API returned it, use `ticketId`.

### Complete Workflow (6 steps)

| Step | Action | MCP Tool |
|------|--------|----------|
| 1 | Create ticket | `ticket_create` |
| 2 | Add plan | `ticket_update({ customFields: { _implementationContext: {...} } })` |
| 3 | Claim ticket | `ticket_update({ status: "in-progress" })` |
| 4 | Implement | (code tools) |
| 5 | Add comment | `ticket_addComment("Implemented X, Y, Z")` |
| 6 | Close after testing | `ticket_setStatus("closed")` |

---

## Agent Session Lifecycle

### Session States

| Status | Use For |
|--------|---------|
| `IN_PROGRESS` | Actively working |
| `PAUSED` | Breaks, EOD, context compaction |
| `COMPLETED` | Work fully done (CANNOT resume!) |

**CRITICAL**: COMPLETED sessions CANNOT be resumed. Use PAUSED for breaks!

---

## Knowledge & Wiki

### Knowledge Items

```
# Search for existing knowledge
projectpulse_knowledge_search(projectId: 10, query: "authentication")

# Store new knowledge
projectpulse_knowledge_create(projectId: 10, title: "...", content: "...", category: "...")
```

### Wiki Pages

```
# Search wiki
projectpulse_wiki_search(query: "API reference")

# Get wiki page
projectpulse_wiki_get(path: "/guides/api-reference")
```

---

## MCP Tools Reference

| Category | Tools |
|----------|-------|
| **Context** | `context_load`, `context_lookup`, `context_update` |
| **Sessions** | `agent_session_start`, `agent_session_update`, `agent_session_resume`, `agent_session_end` |
| **Tickets** | `ticket_create`, `ticket_search`, `ticket_update`, `ticket_setStatus`, `ticket_addComment`, `ticket_get` |
| **Kanban** | `kanban_moveTicket`, `kanban_getBoard` |
| **Roadmap** | `roadmap_create`, `getCurrentPosition`, `getPhaseProgress`, `updateProgress` |
| **Knowledge** | `knowledge_create`, `knowledge_search`, `knowledge_get` |
| **Wiki** | `wiki_search`, `wiki_get`, `wiki_create`, `wiki_update` |
| **Resources** | `persona_list`, `persona_get`, `skill_list`, `skill_get`, `sop_list`, `sop_get` |
| **Workflows** | `workflow_list`, `workflow_start`, `workflow_executeStep`, `workflow_getStatus` |

---

## Daily Checklist

- [ ] Loaded context via `context_load(projectId: 10)`
- [ ] Resumed PAUSED session OR started new session
- [ ] Checked roadmap position (if using roadmap)
- [ ] Found tickets for current sprint/week
- [ ] Working on feature branch (not main/master)

---

## Dashboard

View all project resources: https://projectpulse.dracodev.dev/projects/10
