/**
 * File Discovery Types
 *
 * Type definitions for the file indexer module. These types define
 * the contract for scanning directories and returning file metadata.
 */

/**
 * Supported programming languages for syntax-aware processing.
 * Maps to tree-sitter parsers and highlighting.
 */
export type Language =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'ruby'
  | 'php'
  | 'swift'
  | 'kotlin'
  | 'scala'
  | 'html'
  | 'css'
  | 'scss'
  | 'json'
  | 'yaml'
  | 'toml'
  | 'markdown'
  | 'sql'
  | 'shell'
  | 'dockerfile'
  | 'text';

/**
 * File type categories for filtering and processing.
 * - code: Source files that can be parsed for symbols
 * - docs: Documentation and prose (markdown, text)
 * - config: Configuration files (json, yaml, toml)
 * - style: Stylesheets (css, scss)
 * - data: Data files (sql, csv)
 */
export type FileType = 'code' | 'docs' | 'config' | 'style' | 'data';

/**
 * Metadata about a discovered file.
 */
export interface FileInfo {
  /** Absolute path to the file */
  path: string;

  /** Path relative to the scanned root directory */
  relativePath: string;

  /** File extension without the dot (e.g., 'ts', 'js') */
  extension: string;

  /** Detected programming language */
  language: Language;

  /** File type category */
  type: FileType;

  /** File size in bytes */
  size: number;

  /** Last modified timestamp (ISO 8601) */
  modifiedAt: string;
}

/**
 * Options for configuring the file scanner.
 */
export interface ScanOptions {
  /**
   * Maximum directory depth to traverse.
   * - 0: Only scan files in the root directory
   * - Infinity (default): No limit
   */
  maxDepth?: number;

  /**
   * Only include files with these extensions (without dot).
   * If not provided, uses DEFAULT_SUPPORTED_EXTENSIONS.
   * @example ['ts', 'js', 'py']
   */
  extensions?: string[];

  /**
   * Additional glob patterns to ignore (merged with .gitignore).
   * Uses gitignore pattern syntax.
   * @example ['*.log', 'temp/']
   */
  additionalIgnorePatterns?: string[];

  /**
   * Whether to follow symlinks.
   * @default false
   */
  followSymlinks?: boolean;

  /**
   * Callback invoked for each discovered file.
   * Useful for progress reporting.
   */
  onFile?: (file: FileInfo) => void;

  /**
   * Callback invoked when a file or directory is skipped due to errors.
   * @param path - The path that was skipped
   * @param error - The error that occurred
   */
  onError?: (path: string, error: Error) => void;
}

/**
 * Statistics about a completed scan.
 */
export interface ScanStats {
  /** Total number of files discovered */
  totalFiles: number;

  /** Total size of all files in bytes */
  totalSize: number;

  /** Number of files by language */
  byLanguage: Record<Language, number>;

  /** Number of files by type */
  byType: Record<FileType, number>;

  /** Number of files skipped due to errors */
  errorsEncountered: number;

  /** Time taken to scan in milliseconds */
  scanDurationMs: number;
}

/**
 * Result of a directory scan.
 */
export interface ScanResult {
  /** Root directory that was scanned */
  rootPath: string;

  /** All discovered files */
  files: FileInfo[];

  /** Scan statistics */
  stats: ScanStats;
}

/**
 * Extension to language mapping.
 * Maps file extensions (without dot) to their programming language.
 */
export const EXTENSION_TO_LANGUAGE: Record<string, Language> = {
  // TypeScript
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',

  // JavaScript
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',

  // Python
  py: 'python',
  pyw: 'python',
  pyi: 'python',

  // Go
  go: 'go',

  // Rust
  rs: 'rust',

  // Java
  java: 'java',

  // C/C++
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',

  // C#
  cs: 'csharp',

  // Ruby
  rb: 'ruby',
  rake: 'ruby',

  // PHP
  php: 'php',

  // Swift
  swift: 'swift',

  // Kotlin
  kt: 'kotlin',
  kts: 'kotlin',

  // Scala
  scala: 'scala',
  sc: 'scala',

  // Web
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'css',

  // Config
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',

  // Documentation
  md: 'markdown',
  mdx: 'markdown',
  txt: 'text',
  rst: 'text',

  // SQL
  sql: 'sql',

  // Shell
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',

  // Docker
  dockerfile: 'dockerfile',
};

/**
 * Language to file type mapping.
 * Categorizes languages into broader file types.
 */
export const LANGUAGE_TO_TYPE: Record<Language, FileType> = {
  typescript: 'code',
  javascript: 'code',
  python: 'code',
  go: 'code',
  rust: 'code',
  java: 'code',
  c: 'code',
  cpp: 'code',
  csharp: 'code',
  ruby: 'code',
  php: 'code',
  swift: 'code',
  kotlin: 'code',
  scala: 'code',
  html: 'code',
  shell: 'code',
  dockerfile: 'code',

  css: 'style',
  scss: 'style',

  json: 'config',
  yaml: 'config',
  toml: 'config',

  markdown: 'docs',
  text: 'docs',

  sql: 'data',
};

/**
 * Default file extensions to include in scans.
 * Covers most common programming languages and config files.
 */
export const DEFAULT_SUPPORTED_EXTENSIONS = Object.keys(EXTENSION_TO_LANGUAGE);

/**
 * Default patterns to ignore during scanning.
 * These are always applied in addition to .gitignore.
 */
export const DEFAULT_IGNORE_PATTERNS = [
  // Version control
  '.git',
  '.svn',
  '.hg',

  // Dependencies
  'node_modules',
  'vendor',
  'venv',
  '.venv',
  '__pycache__',
  '.tox',
  'bower_components',

  // Build outputs
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.output',
  '.cache',

  // IDE/Editor
  '.idea',
  '.vscode',
  '*.swp',
  '*.swo',
  '*~',

  // OS files
  '.DS_Store',
  'Thumbs.db',

  // Test coverage
  'coverage',
  '.nyc_output',

  // Logs
  '*.log',
  'logs',

  // Environment
  '.env',
  '.env.*',
  '!.env.example',

  // Lock files (large, auto-generated)
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'composer.lock',
];

/**
 * Get the language for a file extension.
 * @param extension - File extension without dot
 * @returns The detected language, or 'text' if unknown
 */
export function getLanguageForExtension(extension: string): Language {
  const normalized = extension.toLowerCase();
  return EXTENSION_TO_LANGUAGE[normalized] ?? 'text';
}

/**
 * Get the file type for a language.
 * @param language - The programming language
 * @returns The file type category
 */
export function getTypeForLanguage(language: Language): FileType {
  return LANGUAGE_TO_TYPE[language];
}
