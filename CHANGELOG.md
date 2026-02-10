# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-02-10

### Added

- **LLM-Based Query Routing** - Intelligent project routing for multi-project environments using LLM fallback when heuristics are uncertain (#106)
- **AdaptiveRAG Pipeline** - Query-classification-aware search optimization via ContextAI SDK's AdaptiveRAG (#107)
  - SIMPLE queries (greetings) skip retrieval entirely, saving ~200-400ms
  - FACTUAL queries use standard pipeline (topK=5, rerank=true)
  - COMPLEX queries get enhanced search (topK=10, query enhancement)
- **Result Caching** - LRU cache (50 entries, 5-min TTL) on RAGEngineImpl for repeated queries
- **Classification Display** - Query classification tags shown in both REPL and TUI tool result output

### Changed

- Single-project guard skips LLM routing calls when only one project is indexed (optimization)

## [1.2.0] - 2026-02-06

### Added

- **ReAct Chat Agent** - Autonomous reasoning agent that decides when to search, replacing the manual RAG→LLM pipeline
- **Real-time Streaming** - Token-by-token response streaming with reasoning chain visualization in both REPL and TUI modes
- **`retrieve-knowledge` Tool** - RAG-as-a-tool with getter/closure pattern for agent-driven context retrieval
- **Source Citations** - Displayed after agent responses in both REPL and TUI modes
- **Agent Phase Status** - TUI status bar shows agent phases and tool descriptions during execution

### Fixed

- Add user-visible warnings when ChatAgent creation fails
- Wrap REPL agent streaming in try/finally to prevent AbortController leak
- Add agent abort tier to TUI SIGINT handler (3-tier: cancel agent → cancel indexing → exit)
- Graceful max-iterations handling (return last thought instead of error)

## [1.1.0] - 2026-02-06

### Added

- **TUI Chat Mode** - Full terminal UI for `ctx chat` with DECSTBM scroll regions, fixed status bar, and streaming cursor rendering
- **`ctx check` Command** - Pre-flight validation for agent integration workflows
- **`--context-only` Flag** - Retrieve RAG context from `ctx ask` without LLM cost
- **`--ignore` Flag** - Custom ignore patterns via CLI flag and `config.toml` setting
- **Background Indexing** - Real-time progress display with blocking input and status line updates
- **Agent Integration Guide** - Documentation for using ctx as a tool from AI agents (`docs/agent-integration.md`)
- `.env` support for local development testing

### Fixed

- LLM ignoring RAG context in multi-turn conversations
- Empty results handling in `ctx ask --context-only`
- Indexer cancellation bugs and test failures
- Event loop yields to prevent UI freeze during indexing
- Throttled indexing progress updates to prevent input lag
- Provider fallback model access TypeScript error

### Changed

- Skip SemanticChunker and reduce batch size for background indexing (performance)
- Remove CLAUDE.md and AGENTS.md from version control

## [1.0.2] - 2026-02-03

### Fixed

- Inject CLI version from `package.json` at build time via tsup define

## [1.0.1] - 2026-02-03

### Fixed

- Address code review feedback for atomic re-indexing (staging table cleanup, error handling)

## [1.0.0] - 2026-02-03

### Added

#### Multi-Project Search
- **MultiProjectVectorStoreManager** - Cross-project vector search
- **MultiProjectBM25StoreManager** - Cross-project BM25 keyword search
- **MultiProjectFusionService** - Hybrid search combining vector + BM25 results
- **projectId Metadata** - Chunk attribution for cross-project result tracking
- Description column added to projects schema

#### Smart Query Routing
- **RoutingRAGEngine** - Unified routing + search engine
- Automatic query classification for multi-project search
- Project attribution preserved after reranking

#### Chat Enhancements
- `/index` REPL command for in-session indexing
- `/index status` command for indexing progress
- Tab completion, `@file` references, and `/share` export
- Improved empty-database UX messaging

#### Indexer
- **Atomic Re-indexing** - Staging table pattern for safe index rebuilds

### Fixed

- Replaced fragile `for-await` readline with event-based pattern
- TypeScript errors breaking CI
- Project attribution lost after reranking
- Query routing type errors and false positive classification

## [0.1.0] - 2026-02-01

### Added

#### CLI Commands
- `ctx init` - Initialize a new context-expert project with configuration wizard
- `ctx index` - Index codebase files with progress tracking and incremental updates
- `ctx search` - Search indexed content with semantic and keyword matching
- `ctx ask` - Query the codebase using natural language with AI-powered responses

#### Core Features
- **ContextAI SDK Integration** - Full RAG pipeline with embeddings, retrieval, and reranking
- **SQLite Vector Storage** - Local-first vector database using better-sqlite3 with BLOB storage
- **Tree-sitter Code Parsing** - Intelligent code chunking for 8 languages:
  - TypeScript, JavaScript, Python, Go, Rust, Java, C, C++
- **Markdown Processing** - Smart chunking with heading hierarchy preservation
- **Configurable Providers** - Support for local embeddings (Xenova) and Anthropic Claude

#### Developer Experience
- Tab completion support for bash/zsh/fish shells
- Colorized terminal output with progress spinners
- Comprehensive error messages with actionable suggestions
- TOML-based configuration (`~/.ctx/config.toml`)

#### Testing & Quality
- 42 test files with vitest
- Coverage thresholds for critical modules (80%+)
- Type-safe codebase with strict TypeScript

### Known Limitations

- **Local embeddings only** - Cloud embedding providers not yet supported
- **Single project scope** - No multi-project workspace support
- **No incremental reranking** - Full rerank on each query
- **Memory usage** - Large codebases may require significant RAM during indexing

[unreleased]: https://github.com/draco28/ContextExpert/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/draco28/ContextExpert/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/draco28/ContextExpert/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/draco28/ContextExpert/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/draco28/ContextExpert/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/draco28/ContextExpert/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/draco28/ContextExpert/releases/tag/v0.1.0
