/**                                                                                                                                                                   
   * Chunker Types                                                                                                                                                      
   *                                                                                                                                                                    
   * Type definitions for the document chunking pipeline.                                                                                                               
   * Supports dual-track extraction (code vs docs) with AST-aware boundaries.                                                                                           
   */                                                                                                                                                                   
                                                                                                                                                                        
  import type { FileType, Language } from '../types.js';                                                                                                                
                                                                                                                                                                        
  /**                                                                                                                                                                   
   * Content type classification for chunks.                                                                                                                            
   * - code: Source code (functions, classes, methods)                                                                                                                  
   * - docs: Documentation (prose, comments, docstrings)                                                                                                                
   * - config: Configuration files (JSON, YAML, TOML)                                                                                                                   
   */                                                                                                                                                                   
  export type ContentType = 'code' | 'docs' | 'config';                                                                                                                 
                                                                                                                                                                        
  /**                                                                                                                                                                   
   * Symbol types extracted from code AST.                                                                                                                              
   */                                                                                                                                                                   
  export type SymbolType = 'function' | 'class' | 'method' | 'module' | 'interface' | 'type';                                                                           
                                                                                                                                                                        
  /**                                                                                                                                                                   
   * A segment extracted from a file before chunking.                                                                                                                   
   * Represents a semantic unit (function, class, paragraph, code block).                                                                                               
   */                                                                                                                                                                   
  export interface ExtractedSegment {                                                                                                                                   
    /** The extracted text content */                                                                                                                                   
    content: string;                                                                                                                                                    
                                                                                                                                                                        
    /** What type of content this is */                                                                                                                                 
    contentType: ContentType;                                                                                                                                           
                                                                                                                                                                        
    /** Starting line number in original file (1-indexed) */                                                                                                            
    startLine: number;                                                                                                                                                  
                                                                                                                                                                        
    /** Ending line number in original file (1-indexed) */                                                                                                              
    endLine: number;                                                                                                                                                    
                                                                                                                                                                        
    /** Additional metadata about the segment */                                                                                                                        
    metadata: {                                                                                                                                                         
      /** Function/class/method name (for code segments) */                                                                                                             
      symbolName?: string;                                                                                                                                              
                                                                                                                                                                        
      /** Type of symbol (for code segments) */                                                                                                                         
      symbolType?: SymbolType;                                                                                                                                          
                                                                                                                                                                        
      /** Parent symbol name (e.g., class name for a method) */                                                                                                         
      parentSymbol?: string;                                                                                                                                            
                                                                                                                                                                        
      /** Markdown section header (for doc segments from markdown) */                                                                                                   
      sectionHeader?: string;                                                                                                                                           
                                                                                                                                                                        
      /** Language of code block (for code blocks in markdown) */                                                                                                       
      language?: string;                                                                                                                                                
    };                                                                                                                                                                  
  }   

  /**                                                                                                                                                                   
   * Final chunk ready for embedding and storage.                                                                                                                       
   * Matches the database schema for the chunks table.                                                                                                                  
   */                                                                                                                                                                   
  export interface ChunkResult {                                                                                                                                        
    /** UUID primary key */                                                                                                                                             
    id: string;                                                                                                                                                         
                                                                                                                                                                        
    /** The chunk text content */                                                                                                                                       
    content: string;                                                                                                                                                    
                                                                                                                                                                        
    /** Relative path from project root */                                                                                                                              
    file_path: string;                                                                                                                                                  
                                                                                                                                                                        
    /** Original file type (code, docs, config, style, data) */                                                                                                         
    file_type: FileType;                                                                                                                                                
                                                                                                                                                                        
    /** Chunk content type (may differ from file_type for dual-track) */                                                                                                
    content_type: ContentType;                                                                                                                                          
                                                                                                                                                                        
    /** Programming language or format */                                                                                                                               
    language: Language;                                                                                                                                                 
                                                                                                                                                                        
    /** Starting line number in source file (1-indexed) */                                                                                                              
    start_line: number;                                                                                                                                                 
                                                                                                                                                                        
    /** Ending line number in source file (1-indexed) */                                                                                                                
    end_line: number;                                                                                                                                                   
                                                                                                                                                                        
    /** Additional metadata */                                                                                                                                          
    metadata: {                                                                                                                                                         
      /** Original file size in bytes */                                                                                                                                
      originalSize: number;                                                                                                                                             
                                                                                                                                                                        
      /** Position of this chunk within the file (0-indexed) */                                                                                                         
      chunkIndex: number;                                                                                                                                               
                                                                                                                                                                        
      /** Total number of chunks from this file */                                                                                                                      
      totalChunks: number;                                                                                                                                              
                                                                                                                                                                        
      /** Function/class/method context */                                                                                                                              
      symbolName?: string;                                                                                                                                              
                                                                                                                                                                        
      /** Symbol type */                                                                                                                                                
      symbolType?: string;                                                                                                                                              
                                                                                                                                                                        
      /** Parent symbol (e.g., class for method) */                                                                                                                     
      parentSymbol?: string;                                                                                                                                            
                                                                                                                                                                        
      /** Section header context (for markdown) */                                                                                                                      
      sectionHeader?: string;                                                                                                                                           
    };                                                                                                                                                                  
  }                                                                                                                                                                     
                                                                                                                                                                        
  /**                                                                                                                                                                   
   * Options for the chunking process.                                                                                                                                  
   */                                                                                                                                                                   
  export interface ChunkOptions {                                                                                                                                       
    /** Callback invoked for each chunk created */                                                                                                                      
    onChunk?: (chunk: ChunkResult) => void;                                                                                                                             
                                                                                                                                                                        
    /** Callback for warnings (e.g., large files skipped) */                                                                                                            
    onWarning?: (message: string, filePath: string) => void;                                                                                                            
                                                                                                                                                                        
    /** Callback for errors during chunking */                                                                                                                          
    onError?: (error: Error, filePath: string) => void;                                                                                                                 
  }                                                                                                                                                                     
                                                                                                                                                                        
  /**
   * Result of extracting segments from a file.
   */
  export interface ExtractionResult {
    /** Extracted segments */
    segments: ExtractedSegment[];

    /** Original file content (for line number calculation) */
    originalContent: string;
  }

// ============================================================================
// Structured Result Types (Ticket #50)
// ============================================================================

/**
 * Reason why a file was not fully chunked.
 *
 * These reasons help callers understand WHY chunking didn't produce results,
 * enabling better error reporting and recovery strategies.
 *
 * Note: 'empty' with success=true means the file was valid but had no content.
 */
export type SkipReason =
  | 'too_large'    // File exceeds MAX_FILE_SIZE limit
  | 'empty'        // File has no content (success, just nothing to chunk)
  | 'read_error'   // Could not read file from disk
  | 'parse_error'  // Extraction/parsing failed (tree-sitter, regex, etc.)
  | 'unsupported'; // File type not supported for chunking

/**
 * Result of chunking a single file with full context.
 *
 * Unlike returning just ChunkResult[], this provides:
 * - Explicit success/failure indication
 * - Reason why file was skipped (if applicable)
 * - Warnings collected during processing
 *
 * This enables the pipeline to:
 * - Distinguish "no chunks because empty" from "no chunks because error"
 * - Aggregate error summaries across all files
 * - Provide actionable feedback to users
 */
export interface FileChunkResult {
  /** Relative path of the file (for error messages and reporting) */
  filePath: string;

  /**
   * Whether chunking completed successfully.
   *
   * Note: success=true with empty chunks[] is valid (empty file).
   * success=false means an error occurred that prevented chunking.
   */
  success: boolean;

  /** Chunks produced from this file (may be empty even on success) */
  chunks: ChunkResult[];

  /** If file was skipped or failed, why */
  skipReason?: SkipReason;

  /** Human-readable error message (only present if success=false) */
  error?: string;

  /** Warnings encountered during chunking (non-fatal issues) */
  warnings: string[];
}

/**
 * Aggregated result of chunking multiple files.
 *
 * Provides a summary view suitable for:
 * - Progress reporting ("Indexed X files, Y errors, Z skipped")
 * - Error aggregation (all errors in one place)
 * - Metrics collection (success rate, total chunks, etc.)
 */
export interface BatchChunkResult {
  /** Individual results for each file */
  files: FileChunkResult[];

  /** Count of files that chunked successfully */
  successCount: number;

  /** Count of files that failed or were skipped */
  failureCount: number;

  /** Total chunks produced across all files */
  totalChunks: number;

  /** All warnings aggregated from all files */
  warnings: string[];

  /** All errors aggregated from all files (includes file path) */
  errors: string[];
}   