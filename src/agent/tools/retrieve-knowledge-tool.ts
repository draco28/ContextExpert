/**
 * Retrieve Knowledge Tool
 *
 * A ReAct agent tool that wraps RoutingRAGEngine for context-aware
 * knowledge retrieval. The agent calls this tool when it determines
 * that searching the indexed codebase would help answer the user's question.
 *
 * KEY DESIGN: Uses getter functions (not direct references) so the tool
 * automatically reflects the current project context when the user runs
 * /focus to switch projects.
 *
 * WHY NOT USE SDK's createRetrieveKnowledgeTool?
 * The SDK tool expects a simple RAGEngineInterface.search(query, options).
 * Our RoutingRAGEngine.search() takes 4 params (query, projects,
 * currentProjectId, options) for multi-project routing. Creating our
 * own tool avoids an impedance mismatch adapter.
 */

import { z } from 'zod';
import { defineTool, type Tool, type ToolResult } from '@contextaisdk/core';
import type { RoutingRAGEngine } from '../routing-rag-engine.js';
import type { ProjectMetadata } from '../query-router.js';
import type { RAGSource, RoutingRAGResult } from '../types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Output type for the retrieve_knowledge tool.
 *
 * Includes everything needed for:
 * - LLM consumption (context string)
 * - UI display (sourceCount, timing)
 * - Observability/eval (full sources, routing metadata)
 */
export interface RetrieveKnowledgeOutput {
  /** XML-formatted context string for LLM consumption */
  context: string;
  /** Number of source chunks retrieved */
  sourceCount: number;
  /** Estimated token count of assembled context */
  estimatedTokens: number;
  /** Source attributions for citations */
  sources: RAGSource[];
  /** Routing decision metadata */
  routing: {
    method: string;
    projectIds: string[];
    confidence: number;
    reason: string;
  };
  /** Total search time in milliseconds */
  searchTimeMs: number;
}

// ============================================================================
// Input Schema
// ============================================================================

const retrieveKnowledgeInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'Search query for the indexed codebase. Be specific and include ' +
        'relevant technical terms, function names, or file names. ' +
        'Example: "How does the authentication middleware validate JWT tokens?"'
    ),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe(
      'Number of code chunks to retrieve. Use 3-5 for focused questions, ' +
        '8-10 for broad topics. Default: 5'
    ),
});

// ============================================================================
// Tool Factory
// ============================================================================

/**
 * Create a retrieve_knowledge tool for the ReAct agent.
 *
 * Uses getter functions instead of direct references so the tool
 * automatically reflects state changes (e.g., /focus project switch).
 *
 * @param getRoutingEngine - Returns current RoutingRAGEngine (null if unavailable)
 * @param getAllProjects - Returns current list of indexed projects
 * @param getCurrentProjectId - Returns currently focused project ID (undefined if unfocused)
 */
export function createRetrieveKnowledgeTool(
  getRoutingEngine: () => RoutingRAGEngine | null | undefined,
  getAllProjects: () => ProjectMetadata[],
  getCurrentProjectId: () => string | undefined
): Tool {
  return defineTool({
    name: 'retrieve_knowledge',
    description:
      'Search the indexed codebase for relevant code and documentation.\n\n' +
      'Use this tool when the user asks about:\n' +
      '- How code works, architecture, or implementation details\n' +
      '- Specific files, functions, classes, or patterns\n' +
      '- Debugging, troubleshooting, or understanding behavior\n' +
      '- Configuration, APIs, or integration points\n\n' +
      'Do NOT use for:\n' +
      '- Simple greetings or small talk\n' +
      '- General programming concepts you already know\n' +
      '- Questions where you already have sufficient context from previous searches',
    parameters: retrieveKnowledgeInputSchema,
    timeout: 30000,

    execute: async (
      input: z.infer<typeof retrieveKnowledgeInputSchema>,
      _context
    ): Promise<ToolResult<RetrieveKnowledgeOutput>> => {
      const routingEngine = getRoutingEngine();

      if (!routingEngine) {
        return {
          success: false,
          error:
            'No knowledge base available. The user needs to index a project first with "ctx index <path>".',
        };
      }

      const projects = getAllProjects();
      if (projects.length === 0) {
        return {
          success: false,
          error: 'No indexed projects found. Index a project first with "ctx index <path>".',
        };
      }

      try {
        const result: RoutingRAGResult = await routingEngine.search(
          input.query,
          projects,
          getCurrentProjectId(),
          { finalK: input.maxResults ?? 5 }
        );

        return {
          success: true,
          data: {
            context: result.content,
            sourceCount: result.sources.length,
            estimatedTokens: result.estimatedTokens,
            sources: result.sources,
            routing: {
              method: result.routing.method,
              projectIds: result.routing.projectIds,
              confidence: result.routing.confidence,
              reason: result.routing.reason,
            },
            searchTimeMs: result.metadata.totalMs,
          },
        };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : 'Knowledge retrieval failed unexpectedly',
        };
      }
    },
  });
}
