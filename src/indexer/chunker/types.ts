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