/**
 * Retrieve Knowledge Tool Tests
 *
 * Tests the tool that wraps RoutingRAGEngine for the ReAct agent.
 * Verifies:
 * - Correct invocation of RoutingRAGEngine.search()
 * - Getter function pattern (dynamic state access)
 * - Error handling when no engine or projects available
 * - Output format for agent consumption
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRetrieveKnowledgeTool } from '../retrieve-knowledge-tool.js';
import type { RoutingRAGEngine } from '../../routing-rag-engine.js';
import type { ProjectMetadata } from '../../query-router.js';
import type { RoutingRAGResult, RAGSource } from '../../types.js';

// ============================================================================
// Test Helpers
// ============================================================================

function createMockSource(overrides: Partial<RAGSource> = {}): RAGSource {
  return {
    index: 1,
    filePath: 'src/auth.ts',
    lineRange: { start: 42, end: 67 },
    score: 0.95,
    language: 'typescript',
    fileType: 'code',
    ...overrides,
  };
}

function createMockRoutingResult(overrides: Partial<RoutingRAGResult> = {}): RoutingRAGResult {
  return {
    content: '<sources><source id="1">code here</source></sources>',
    estimatedTokens: 150,
    sources: [createMockSource()],
    rawResults: [],
    metadata: {
      retrievalMs: 50,
      assemblyMs: 10,
      totalMs: 60,
      resultsRetrieved: 5,
      resultsAssembled: 1,
      fromCache: false,
    },
    routing: {
      method: 'heuristic',
      projectIds: ['project-1'],
      confidence: 0.9,
      reason: 'Project name detected in query',
    },
    ...overrides,
  };
}

function createMockRoutingEngine(): RoutingRAGEngine {
  return {
    search: vi.fn().mockResolvedValue(createMockRoutingResult()),
    dispose: vi.fn(),
  } as unknown as RoutingRAGEngine;
}

function createMockProjects(): ProjectMetadata[] {
  return [
    {
      id: 'project-1',
      name: 'my-app',
      description: 'A web application',
      tags: ['web', 'typescript'],
      fileCount: 100,
      chunkCount: 500,
    },
  ];
}

// ============================================================================
// Tests
// ============================================================================

describe('createRetrieveKnowledgeTool', () => {
  let mockEngine: RoutingRAGEngine;
  let mockProjects: ProjectMetadata[];

  beforeEach(() => {
    mockEngine = createMockRoutingEngine();
    mockProjects = createMockProjects();
  });

  it('creates a tool with correct name and description', () => {
    const tool = createRetrieveKnowledgeTool(
      () => mockEngine,
      () => mockProjects,
      () => 'project-1'
    );

    expect(tool.name).toBe('retrieve_knowledge');
    expect(tool.description).toContain('Search the indexed codebase');
  });

  it('calls RoutingRAGEngine.search() with correct parameters', async () => {
    const tool = createRetrieveKnowledgeTool(
      () => mockEngine,
      () => mockProjects,
      () => 'project-1'
    );

    const result = await tool.execute(
      { query: 'How does auth work?' },
      {}
    );

    expect(mockEngine.search).toHaveBeenCalledWith(
      'How does auth work?',
      mockProjects,
      'project-1',
      { finalK: 5 }
    );
    expect(result.success).toBe(true);
  });

  it('respects maxResults parameter', async () => {
    const tool = createRetrieveKnowledgeTool(
      () => mockEngine,
      () => mockProjects,
      () => 'project-1'
    );

    await tool.execute(
      { query: 'test query', maxResults: 10 },
      {}
    );

    expect(mockEngine.search).toHaveBeenCalledWith(
      'test query',
      mockProjects,
      'project-1',
      { finalK: 10 }
    );
  });

  it('returns correct output format on success', async () => {
    const tool = createRetrieveKnowledgeTool(
      () => mockEngine,
      () => mockProjects,
      () => 'project-1'
    );

    const result = await tool.execute(
      { query: 'How does auth work?' },
      {}
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      context: '<sources><source id="1">code here</source></sources>',
      sourceCount: 1,
      estimatedTokens: 150,
      sources: [createMockSource()],
      routing: {
        method: 'heuristic',
        projectIds: ['project-1'],
        confidence: 0.9,
        reason: 'Project name detected in query',
      },
      searchTimeMs: 60,
      classification: undefined,
    });
  });

  it('returns error when routing engine is null', async () => {
    const tool = createRetrieveKnowledgeTool(
      () => null,
      () => mockProjects,
      () => 'project-1'
    );

    const result = await tool.execute(
      { query: 'test query' },
      {}
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('No knowledge base available');
  });

  it('returns error when no projects exist', async () => {
    const tool = createRetrieveKnowledgeTool(
      () => mockEngine,
      () => [],
      () => undefined
    );

    const result = await tool.execute(
      { query: 'test query' },
      {}
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('No indexed projects found');
  });

  it('handles RoutingRAGEngine.search() errors gracefully', async () => {
    const failEngine = {
      search: vi.fn().mockRejectedValue(new Error('Search failed: timeout')),
      dispose: vi.fn(),
    } as unknown as RoutingRAGEngine;

    const tool = createRetrieveKnowledgeTool(
      () => failEngine,
      () => mockProjects,
      () => 'project-1'
    );

    const result = await tool.execute(
      { query: 'test query' },
      {}
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Search failed: timeout');
  });

  it('passes classification metadata through to output', async () => {
    const resultWithClassification = createMockRoutingResult({
      classification: {
        type: 'factual',
        confidence: 0.85,
        skippedRetrieval: false,
      },
    });
    (mockEngine.search as ReturnType<typeof vi.fn>).mockResolvedValueOnce(resultWithClassification);

    const tool = createRetrieveKnowledgeTool(
      () => mockEngine,
      () => mockProjects,
      () => 'project-1'
    );

    const result = await tool.execute({ query: 'How does auth work?' }, {});

    expect(result.success).toBe(true);
    expect(result.data!.classification).toEqual({
      type: 'factual',
      confidence: 0.85,
      skippedRetrieval: false,
    });
  });

  it('returns success with empty context when retrieval is skipped', async () => {
    const skippedResult = createMockRoutingResult({
      content: '',
      estimatedTokens: 0,
      sources: [],
      rawResults: [],
      metadata: {
        retrievalMs: 0,
        assemblyMs: 0,
        totalMs: 2,
        resultsRetrieved: 0,
        resultsAssembled: 0,
        fromCache: false,
      },
      classification: {
        type: 'simple',
        confidence: 0.95,
        skippedRetrieval: true,
      },
    });
    (mockEngine.search as ReturnType<typeof vi.fn>).mockResolvedValueOnce(skippedResult);

    const tool = createRetrieveKnowledgeTool(
      () => mockEngine,
      () => mockProjects,
      () => 'project-1'
    );

    const result = await tool.execute({ query: 'hello' }, {});

    // Should return success (not error) so agent doesn't retry
    expect(result.success).toBe(true);
    expect(result.data!.context).toBe('');
    expect(result.data!.sourceCount).toBe(0);
    expect(result.data!.classification).toEqual({
      type: 'simple',
      confidence: 0.95,
      skippedRetrieval: true,
    });
    expect(result.data!.routing.reason).toContain('Retrieval skipped');
    expect(result.data!.routing.reason).toContain('simple');
  });

  it('uses getter functions for dynamic state (supports /focus)', async () => {
    // Start with project-1
    let currentProjectId: string | undefined = 'project-1';
    let currentEngine: RoutingRAGEngine | null = mockEngine;

    const tool = createRetrieveKnowledgeTool(
      () => currentEngine,
      () => mockProjects,
      () => currentProjectId
    );

    // First call with project-1
    await tool.execute({ query: 'test' }, {});
    expect(mockEngine.search).toHaveBeenCalledWith(
      'test', mockProjects, 'project-1', { finalK: 5 }
    );

    // Simulate /focus switch
    currentProjectId = 'project-2';
    vi.mocked(mockEngine.search).mockClear();

    // Second call should use project-2 without recreating the tool
    await tool.execute({ query: 'test' }, {});
    expect(mockEngine.search).toHaveBeenCalledWith(
      'test', mockProjects, 'project-2', { finalK: 5 }
    );
  });
});
