# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- TOML-based configuration (`context-expert.toml`)

#### Testing & Quality
- 42 test files with vitest
- Coverage thresholds for critical modules (80%+)
- Type-safe codebase with strict TypeScript

### Known Limitations

- **Local embeddings only** - Cloud embedding providers not yet supported
- **Single project scope** - No multi-project workspace support
- **No incremental reranking** - Full rerank on each query
- **Memory usage** - Large codebases may require significant RAM during indexing

[unreleased]: https://github.com/dracodev/context-expert/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dracodev/context-expert/releases/tag/v0.1.0
