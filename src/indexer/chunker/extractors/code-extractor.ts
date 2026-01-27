/**
 * Code Extractor
 *
 * Uses tree-sitter for multi-language AST parsing to extract:
 * - Documentation comments (JSDoc, docstrings) → 'docs' segments
 * - Code definitions (functions, classes, methods) → 'code' segments
 *
 * Supports: TypeScript, JavaScript, Python (extensible to more languages)
 */

import Parser from 'tree-sitter';
import TypeScriptLang from 'tree-sitter-typescript';
import JavaScriptLang from 'tree-sitter-javascript';
import PythonLang from 'tree-sitter-python';

import type { Language } from '../../types.js';
import type { ExtractedSegment, ExtractionResult } from '../types.js';

// tree-sitter's Language type (compiled parser) vs our Language type (string union)
type TreeSitterLanguage = Parameters<Parser['setLanguage']>[0];

/**
 * Supported languages for tree-sitter parsing.
 */
const SUPPORTED_LANGUAGES = new Set<Language>([
  'typescript',
  'javascript',
  'python',
]);

/**
 * Language to tree-sitter parser mapping.
 */
function getParserLanguage(language: Language): TreeSitterLanguage | null {
  switch (language) {
    case 'typescript':
      return TypeScriptLang.typescript as TreeSitterLanguage;
    case 'javascript':
      return JavaScriptLang as TreeSitterLanguage;
    case 'python':
      return PythonLang as TreeSitterLanguage;
    default:
      return null;
  }
}

/**
 * Check if a language is supported for AST extraction.
 */
export function isLanguageSupported(language: Language): boolean {
  return SUPPORTED_LANGUAGES.has(language);
}

/**
 * Extract segments from code using tree-sitter AST parsing.
 *
 * @param content - The source code content
 * @param language - The programming language
 * @returns Extraction result with segments and original content
 */
export function extractCodeSegments(
  content: string,
  language: Language
): ExtractionResult {
  const parserLang = getParserLanguage(language);

  // Fallback for unsupported languages
  if (!parserLang) {
    return extractWithFallback(content, language);
  }

  // Parse with tree-sitter
  const parser = new Parser();
  parser.setLanguage(parserLang);
  const tree = parser.parse(content);

  const segments: ExtractedSegment[] = [];
  const lines = content.split('\n');

  // Extract based on language
  if (language === 'python') {
    extractPythonSegments(tree.rootNode, content, lines, segments);
  } else {
    // TypeScript/JavaScript
    extractJSSegments(tree.rootNode, content, lines, segments);
  }

  // Sort segments by start line
  segments.sort((a, b) => a.startLine - b.startLine);

  return { segments, originalContent: content };
}

/**
 * Extract segments from JavaScript/TypeScript AST.
 */
function extractJSSegments(
  rootNode: Parser.SyntaxNode,
  _content: string,
  _lines: string[],
  segments: ExtractedSegment[]
): void {
  // Track which ranges we've already extracted to avoid duplicates
  const extractedRanges = new Set<string>();

  // Helper to add a segment if not already extracted
  const addSegment = (segment: ExtractedSegment) => {
    const key = `${segment.startLine}-${segment.endLine}-${segment.contentType}`;
    if (!extractedRanges.has(key)) {
      extractedRanges.add(key);
      segments.push(segment);
    }
  };

  // Extract JSDoc comments (/** ... */)
  const comments = rootNode.descendantsOfType('comment');
  for (const node of comments) {
    const text = node.text;
    // Only extract JSDoc-style comments
    if (text.startsWith('/**') && !text.startsWith('/***')) {
      addSegment({
        content: text,
        contentType: 'docs',
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        metadata: {},
      });
    }
  }

  // Extract functions
  const functions = rootNode.descendantsOfType('function_declaration');
  for (const node of functions) {
    const nameNode = node.childForFieldName('name');
    addSegment({
      content: node.text,
      contentType: 'code',
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      metadata: {
        symbolName: nameNode?.text,
        symbolType: 'function',
      },
    });
  }

  // Extract arrow functions assigned to variables
  const variableDeclarations = rootNode.descendantsOfType('lexical_declaration');
  for (const node of variableDeclarations) {
    const declarator = node.descendantsOfType('variable_declarator')[0];
    if (declarator) {
      const value = declarator.childForFieldName('value');
      if (value?.type === 'arrow_function') {
        const nameNode = declarator.childForFieldName('name');
        addSegment({
          content: node.text,
          contentType: 'code',
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          metadata: {
            symbolName: nameNode?.text,
            symbolType: 'function',
          },
        });
      }
    }
  }

  // Extract classes
  const classes = rootNode.descendantsOfType('class_declaration');
  for (const node of classes) {
    const nameNode = node.childForFieldName('name');
    addSegment({
      content: node.text,
      contentType: 'code',
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      metadata: {
        symbolName: nameNode?.text,
        symbolType: 'class',
      },
    });
  }

  // Extract interfaces (TypeScript)
  const interfaces = rootNode.descendantsOfType('interface_declaration');
  for (const node of interfaces) {
    const nameNode = node.childForFieldName('name');
    addSegment({
      content: node.text,
      contentType: 'code',
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      metadata: {
        symbolName: nameNode?.text,
        symbolType: 'interface',
      },
    });
  }

  // Extract type aliases (TypeScript)
  const typeAliases = rootNode.descendantsOfType('type_alias_declaration');
  for (const node of typeAliases) {
    const nameNode = node.childForFieldName('name');
    addSegment({
      content: node.text,
      contentType: 'code',
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      metadata: {
        symbolName: nameNode?.text,
        symbolType: 'type',
      },
    });
  }
}

/**
 * Extract segments from Python AST.
 */
function extractPythonSegments(
  rootNode: Parser.SyntaxNode,
  _content: string,
  _lines: string[],
  segments: ExtractedSegment[]
): void {
  const extractedRanges = new Set<string>();

  const addSegment = (segment: ExtractedSegment) => {
    const key = `${segment.startLine}-${segment.endLine}-${segment.contentType}`;
    if (!extractedRanges.has(key)) {
      extractedRanges.add(key);
      segments.push(segment);
    }
  };

  // Extract module-level docstrings
  const moduleBody = rootNode.children;
  if (moduleBody.length > 0) {
    const firstChild = moduleBody[0];
    if (firstChild?.type === 'expression_statement') {
      const expr = firstChild.firstChild;
      if (expr?.type === 'string') {
        addSegment({
          content: expr.text,
          contentType: 'docs',
          startLine: expr.startPosition.row + 1,
          endLine: expr.endPosition.row + 1,
          metadata: {
            symbolType: 'module',
          },
        });
      }
    }
  }

  // Extract functions and their docstrings
  const functions = rootNode.descendantsOfType('function_definition');
  for (const node of functions) {
    const nameNode = node.childForFieldName('name');
    const body = node.childForFieldName('body');

    // Check for docstring as first statement in body
    if (body && body.children.length > 0) {
      const firstStmt = body.children[0];
      if (firstStmt?.type === 'expression_statement') {
        const expr = firstStmt.firstChild;
        if (expr?.type === 'string') {
          // Extract docstring as separate docs segment
          addSegment({
            content: expr.text,
            contentType: 'docs',
            startLine: expr.startPosition.row + 1,
            endLine: expr.endPosition.row + 1,
            metadata: {
              symbolName: nameNode?.text,
              symbolType: 'function',
            },
          });
        }
      }
    }

    // Extract the function itself
    addSegment({
      content: node.text,
      contentType: 'code',
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      metadata: {
        symbolName: nameNode?.text,
        symbolType: 'function',
      },
    });
  }

  // Extract classes
  const classes = rootNode.descendantsOfType('class_definition');
  for (const node of classes) {
    const nameNode = node.childForFieldName('name');
    const body = node.childForFieldName('body');

    // Check for class docstring
    if (body && body.children.length > 0) {
      const firstStmt = body.children[0];
      if (firstStmt?.type === 'expression_statement') {
        const expr = firstStmt.firstChild;
        if (expr?.type === 'string') {
          addSegment({
            content: expr.text,
            contentType: 'docs',
            startLine: expr.startPosition.row + 1,
            endLine: expr.endPosition.row + 1,
            metadata: {
              symbolName: nameNode?.text,
              symbolType: 'class',
            },
          });
        }
      }
    }

    // Extract the class itself
    addSegment({
      content: node.text,
      contentType: 'code',
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      metadata: {
        symbolName: nameNode?.text,
        symbolType: 'class',
      },
    });
  }
}

/**
 * Fallback extraction using regex for unsupported languages.
 * Extracts block comments and treats remaining content as code.
 */
function extractWithFallback(
  content: string,
  _language: Language
): ExtractionResult {
  const segments: ExtractedSegment[] = [];
  const lines = content.split('\n');

  // Extract block comments (/* ... */ or /** ... */)
  const blockCommentRegex = /\/\*\*?[\s\S]*?\*\//g;
  let match;

  while ((match = blockCommentRegex.exec(content)) !== null) {
    const startOffset = match.index;
    const endOffset = startOffset + match[0].length;

    // Calculate line numbers
    const startLine = content.slice(0, startOffset).split('\n').length;
    const endLine = content.slice(0, endOffset).split('\n').length;

    segments.push({
      content: match[0],
      contentType: 'docs',
      startLine,
      endLine,
      metadata: {},
    });
  }

  // If no segments extracted, treat entire file as one code segment
  if (segments.length === 0) {
    segments.push({
      content,
      contentType: 'code',
      startLine: 1,
      endLine: lines.length,
      metadata: {
        symbolType: 'module',
      },
    });
  }

  return { segments, originalContent: content };
}
