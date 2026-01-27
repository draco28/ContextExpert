/**
 * Chunker Module Tests
 *
 * Tests for the document chunking pipeline:
 * - Code extraction (tree-sitter AST parsing)
 * - Markdown extraction (prose/code blocks)
 * - Main chunker orchestration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  extractCodeSegments,
  extractMarkdownSegments,
  isLanguageSupported,
  isMarkdown,
  chunkFile,
  estimateTokens,
} from '../chunker/index.js';
import type { FileInfo } from '../types.js';

// Test fixtures directory
const TEST_DIR = join(tmpdir(), 'ctx-chunker-test-' + Date.now());

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Code Extractor', () => {
  describe('isLanguageSupported', () => {
    it('should support TypeScript', () => {
      expect(isLanguageSupported('typescript')).toBe(true);
    });

    it('should support JavaScript', () => {
      expect(isLanguageSupported('javascript')).toBe(true);
    });

    it('should support Python', () => {
      expect(isLanguageSupported('python')).toBe(true);
    });

    it('should not support unsupported languages', () => {
      expect(isLanguageSupported('rust')).toBe(false);
      expect(isLanguageSupported('go')).toBe(false);
    });
  });

  describe('extractCodeSegments - TypeScript', () => {
    it('should extract JSDoc comments as docs segments', () => {
      const code = `
/**
 * Adds two numbers together.
 * @param a - First number
 * @param b - Second number
 */
function add(a: number, b: number): number {
  return a + b;
}
`;

      const result = extractCodeSegments(code, 'typescript');

      // Should have both docs and code segments
      const docsSegments = result.segments.filter((s) => s.contentType === 'docs');
      const codeSegments = result.segments.filter((s) => s.contentType === 'code');

      expect(docsSegments.length).toBeGreaterThan(0);
      expect(codeSegments.length).toBeGreaterThan(0);

      // JSDoc should be extracted
      const jsdoc = docsSegments[0];
      expect(jsdoc?.content).toContain('Adds two numbers together');
    });

    it('should extract function declarations', () => {
      const code = `
function hello(name: string): string {
  return \`Hello, \${name}!\`;
}
`;

      const result = extractCodeSegments(code, 'typescript');

      const functions = result.segments.filter(
        (s) => s.contentType === 'code' && s.metadata.symbolType === 'function'
      );

      expect(functions.length).toBe(1);
      expect(functions[0]?.metadata.symbolName).toBe('hello');
    });

    it('should extract classes', () => {
      const code = `
class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
}
`;

      const result = extractCodeSegments(code, 'typescript');

      const classes = result.segments.filter(
        (s) => s.contentType === 'code' && s.metadata.symbolType === 'class'
      );

      expect(classes.length).toBe(1);
      expect(classes[0]?.metadata.symbolName).toBe('Calculator');
    });

    it('should extract interfaces', () => {
      const code = `
interface User {
  name: string;
  age: number;
}
`;

      const result = extractCodeSegments(code, 'typescript');

      const interfaces = result.segments.filter(
        (s) => s.contentType === 'code' && s.metadata.symbolType === 'interface'
      );

      expect(interfaces.length).toBe(1);
      expect(interfaces[0]?.metadata.symbolName).toBe('User');
    });

    it('should extract type aliases', () => {
      const code = `
type Status = 'active' | 'inactive' | 'pending';
`;

      const result = extractCodeSegments(code, 'typescript');

      const types = result.segments.filter(
        (s) => s.contentType === 'code' && s.metadata.symbolType === 'type'
      );

      expect(types.length).toBe(1);
      expect(types[0]?.metadata.symbolName).toBe('Status');
    });
  });

  describe('extractCodeSegments - Python', () => {
    it('should extract module docstrings', () => {
      const code = `"""
This module provides utility functions.
"""

def add(a, b):
    return a + b
`;

      const result = extractCodeSegments(code, 'python');

      const docsSegments = result.segments.filter((s) => s.contentType === 'docs');
      expect(docsSegments.length).toBeGreaterThan(0);

      const moduleDoc = docsSegments.find((s) => s.metadata.symbolType === 'module');
      expect(moduleDoc?.content).toContain('utility functions');
    });

    it('should extract function docstrings', () => {
      const code = `
def greet(name):
    """
    Greets a person by name.

    Args:
        name: The name of the person

    Returns:
        A greeting string
    """
    return f"Hello, {name}!"
`;

      const result = extractCodeSegments(code, 'python');

      const docsSegments = result.segments.filter(
        (s) => s.contentType === 'docs' && s.metadata.symbolType === 'function'
      );

      expect(docsSegments.length).toBe(1);
      expect(docsSegments[0]?.content).toContain('Greets a person');
    });

    it('should extract Python functions', () => {
      const code = `
def calculate(x, y):
    return x + y
`;

      const result = extractCodeSegments(code, 'python');

      const functions = result.segments.filter(
        (s) => s.contentType === 'code' && s.metadata.symbolType === 'function'
      );

      expect(functions.length).toBe(1);
      expect(functions[0]?.metadata.symbolName).toBe('calculate');
    });
  });

  describe('extractCodeSegments - Fallback', () => {
    it('should use fallback for unsupported languages', () => {
      const code = `
/* This is a block comment */
fn main() {
    println!("Hello, Rust!");
}
`;

      const result = extractCodeSegments(code, 'rust');

      // Should extract the block comment as docs
      const docsSegments = result.segments.filter((s) => s.contentType === 'docs');
      expect(docsSegments.length).toBeGreaterThan(0);
    });
  });
});

describe('Markdown Extractor', () => {
  describe('isMarkdown', () => {
    it('should recognize markdown extensions', () => {
      expect(isMarkdown('md')).toBe(true);
      expect(isMarkdown('mdx')).toBe(true);
      expect(isMarkdown('markdown')).toBe(true);
    });

    it('should not recognize non-markdown extensions', () => {
      expect(isMarkdown('txt')).toBe(false);
      expect(isMarkdown('ts')).toBe(false);
    });
  });

  describe('extractMarkdownSegments', () => {
    it('should extract code blocks as code segments', () => {
      const markdown = `
# Introduction

Here's some code:

\`\`\`typescript
const x = 1;
console.log(x);
\`\`\`
`;

      const result = extractMarkdownSegments(markdown);

      const codeSegments = result.segments.filter((s) => s.contentType === 'code');
      expect(codeSegments.length).toBe(1);
      expect(codeSegments[0]?.content).toContain('const x = 1');
      expect(codeSegments[0]?.metadata.language).toBe('typescript');
    });

    it('should extract prose as docs segments', () => {
      const markdown = `
# Getting Started

This is a paragraph of text explaining how to use the library.

## Installation

Run the following command to install.
`;

      const result = extractMarkdownSegments(markdown);

      const docsSegments = result.segments.filter((s) => s.contentType === 'docs');
      expect(docsSegments.length).toBeGreaterThan(0);

      // Should capture prose
      const proseSegment = docsSegments.find((s) =>
        s.content.includes('paragraph of text')
      );
      expect(proseSegment).toBeDefined();
    });

    it('should track section headers as context', () => {
      const markdown = `
# API Reference

## Methods

The following methods are available.

\`\`\`javascript
api.get('/users');
\`\`\`
`;

      const result = extractMarkdownSegments(markdown);

      const codeSegment = result.segments.find((s) => s.contentType === 'code');
      expect(codeSegment?.metadata.sectionHeader).toBe('Methods');
    });

    it('should handle lists', () => {
      const markdown = `
## Features

- Feature one
- Feature two
- Feature three
`;

      const result = extractMarkdownSegments(markdown);

      const listSegment = result.segments.find((s) =>
        s.content.includes('Feature one')
      );
      expect(listSegment).toBeDefined();
      expect(listSegment?.contentType).toBe('docs');
    });
  });
});

describe('Configuration', () => {
  describe('estimateTokens', () => {
    it('should estimate tokens from text length', () => {
      // ~4 characters per token
      const text = 'a'.repeat(100);
      const tokens = estimateTokens(text);

      expect(tokens).toBe(25); // 100 / 4
    });

    it('should round up token count', () => {
      const text = 'hello'; // 5 characters
      const tokens = estimateTokens(text);

      expect(tokens).toBe(2); // ceil(5 / 4) = 2
    });
  });
});

describe('Chunker Integration', () => {
  it('should chunk a TypeScript file', async () => {
    // Create a test file
    const filePath = join(TEST_DIR, 'test.ts');
    const content = `
/**
 * A simple calculator class.
 */
class Calculator {
  /**
   * Adds two numbers.
   */
  add(a: number, b: number): number {
    return a + b;
  }

  /**
   * Subtracts two numbers.
   */
  subtract(a: number, b: number): number {
    return a - b;
  }
}
`;
    writeFileSync(filePath, content);

    const fileInfo: FileInfo = {
      path: filePath,
      relativePath: 'test.ts',
      extension: 'ts',
      language: 'typescript',
      type: 'code',
      size: Buffer.byteLength(content),
      modifiedAt: new Date().toISOString(),
    };

    const chunks = await chunkFile(fileInfo);

    // Should produce multiple chunks (docs + code)
    expect(chunks.length).toBeGreaterThan(0);

    // Each chunk should have proper metadata
    for (const chunk of chunks) {
      expect(chunk.file_path).toBe('test.ts');
      expect(chunk.language).toBe('typescript');
      expect(chunk.metadata.totalChunks).toBe(chunks.length);
    }
  });

  it('should chunk a Markdown file', async () => {
    const filePath = join(TEST_DIR, 'readme.md');
    const content = `
# Project Name

This is a sample project.

## Installation

\`\`\`bash
npm install
\`\`\`

## Usage

Import and use the library:

\`\`\`typescript
import { hello } from 'project';
hello('world');
\`\`\`
`;
    writeFileSync(filePath, content);

    const fileInfo: FileInfo = {
      path: filePath,
      relativePath: 'readme.md',
      extension: 'md',
      language: 'markdown',
      type: 'docs',
      size: Buffer.byteLength(content),
      modifiedAt: new Date().toISOString(),
    };

    const chunks = await chunkFile(fileInfo);

    // Should have both code and docs chunks
    const codeChunks = chunks.filter((c) => c.content_type === 'code');
    const docsChunks = chunks.filter((c) => c.content_type === 'docs');

    expect(codeChunks.length).toBeGreaterThan(0);
    expect(docsChunks.length).toBeGreaterThan(0);
  });

  it('should skip large files', async () => {
    const filePath = join(TEST_DIR, 'large.ts');
    // Create a file larger than MAX_FILE_SIZE (500KB)
    const content = 'a'.repeat(600 * 1024);
    writeFileSync(filePath, content);

    const warnings: string[] = [];

    const fileInfo: FileInfo = {
      path: filePath,
      relativePath: 'large.ts',
      extension: 'ts',
      language: 'typescript',
      type: 'code',
      size: Buffer.byteLength(content),
      modifiedAt: new Date().toISOString(),
    };

    const chunks = await chunkFile(fileInfo, {}, {
      onWarning: (msg) => warnings.push(msg),
    });

    expect(chunks.length).toBe(0);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('Skipping large file');
  });

  it('should preserve line numbers through chunking', async () => {
    const filePath = join(TEST_DIR, 'lines.ts');
    const content = `// Line 1
// Line 2
// Line 3
function test() {
  // Line 5
  return true;
}
`;
    writeFileSync(filePath, content);

    const fileInfo: FileInfo = {
      path: filePath,
      relativePath: 'lines.ts',
      extension: 'ts',
      language: 'typescript',
      type: 'code',
      size: Buffer.byteLength(content),
      modifiedAt: new Date().toISOString(),
    };

    const chunks = await chunkFile(fileInfo);

    // All chunks should have valid line numbers
    for (const chunk of chunks) {
      expect(chunk.start_line).toBeGreaterThan(0);
      expect(chunk.end_line).toBeGreaterThanOrEqual(chunk.start_line);
    }
  });
});
