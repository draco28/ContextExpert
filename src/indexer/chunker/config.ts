/**                                                                                                                                                                   
   * Chunker Configuration                                                                                                                                              
   *                                                                                                                                                                    
   * Defines chunk sizes and limits for different content types.                                                                                                        
   * These values are tuned for optimal RAG retrieval quality.                                                                                                          
   */                                                                                                                                                                   
                                                                                                                                                                        
  import type { ContentType } from './types.js';                                                                                                                        
                                                                                                                                                                        
  /**                                                                                                                                                                   
   * Configuration for a specific content type.                                                                                                                         
   */                                                                                                                                                                   
  export interface ChunkConfig {                                                                                                                                        
    /** Target chunk size in tokens */                                                                                                                                  
    chunkSize: number;                                                                                                                                                  
                                                                                                                                                                        
    /** Overlap between consecutive chunks in tokens (~10%) */                                                                                                          
    chunkOverlap: number;                                                                                                                                               
  }                                                                                                                                                                     
                                                                                                                                                                        
  /**                                                                                                                                                                   
   * Chunk configuration by content type.                                                                                                                               
   *                                                                                                                                                                    
   * Rationale for sizes:                                                                                                                                               
   * - code: 512 tokens - Functions are information-dense, smaller chunks                                                                                               
   *   improve retrieval precision for specific implementations                                                                                                         
   * - docs: 1024 tokens - Documentation needs context, larger chunks                                                                                                   
   *   preserve meaning and readability                                                                                                                                 
   * - config: 256 tokens - Config files are self-contained, small chunks                                                                                               
   *   are sufficient for key-value lookups                                                                                                                             
   */                                                                                                                                                                   
  export const CHUNK_CONFIG: Record<ContentType, ChunkConfig> = {                                                                                                       
    code: {                                                                                                                                                             
      chunkSize: 512,                                                                                                                                                   
      chunkOverlap: 50, // ~10%                                                                                                                                         
    },                                                                                                                                                                  
    docs: {                                                                                                                                                             
      chunkSize: 1024,                                                                                                                                                  
      chunkOverlap: 100, // ~10%                                                                                                                                        
    },                                                                                                                                                                  
    config: {                                                                                                                                                           
      chunkSize: 256,                                                                                                                                                   
      chunkOverlap: 25, // ~10%                                                                                                                                         
    },                                                                                                                                                                  
  };                                                                                                                                                                    
                                                                                                                                                                        
  /**                                                                                                                                                                   
   * Maximum file size to process (500KB).                                                                                                                              
   * Files larger than this are skipped with a warning.                                                                                                                 
   *                                                                                                                                                                    
   * Rationale: Very large files (e.g., minified bundles, generated code)                                                                                               
   * are typically not useful for semantic search and would create                                                                                                      
   * too many chunks.                                                                                                                                                   
   */                                                                                                                                                                   
  export const MAX_FILE_SIZE = 500 * 1024; // 500KB                                                                                                                     
                                                                                                                                                                        
  /**                                                                                                                                                                   
   * Minimum content length to create a chunk.                                                                                                                          
   * Segments shorter than this are skipped.                                                                                                                            
   */                                                                                                                                                                   
  export const MIN_CHUNK_SIZE = 10; // characters                                                                                                                       
                                                                                                                                                                        
  /**                                                                                                                                                                   
   * Get chunk configuration for a content type.                                                                                                                        
   *                                                                                                                                                                    
   * @param contentType - The type of content being chunked                                                                                                             
   * @returns Chunk configuration with size and overlap                                                                                                                 
   */                                                                                                                                                                   
  export function getChunkConfig(contentType: ContentType): ChunkConfig {                                                                                               
    return CHUNK_CONFIG[contentType];                                                                                                                                   
  }                                                                                                                                                                     
                                                                                                                                                                        
  /**                                                                                                                                                                   
   * Estimate token count from text.                                                                                                                                    
   * Uses a simple heuristic: ~4 characters per token on average.                                                                                                       
   *                                                                                                                                                                    
   * Note: This is an approximation. For precise token counting,                                                                                                        
   * use the actual tokenizer from the embedding model.                                                                                                                 
   *                                                                                                                                                                    
   * @param text - The text to estimate tokens for                                                                                                                      
   * @returns Estimated token count                                                                                                                                     
   */                                                                                                                                                                   
  export function estimateTokens(text: string): number {                                                                                                                
    // Average of ~4 characters per token for English text                                                                                                              
    // This is a rough estimate; actual tokenization varies by model                                                                                                    
    return Math.ceil(text.length / 4);  
  }