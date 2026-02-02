/**
 * Query Router Tests
 *
 * Tests for QueryIntentClassifier and LLMProjectRouter.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  QueryIntentClassifier,
  LLMProjectRouter,
  createIntentClassifier,
  createProjectRouter,
  type ProjectMetadata,
  type QueryIntent,
} from '../query-router.js';

// ============================================================================
// Test Fixtures
// ============================================================================

const mockProjects: ProjectMetadata[] = [
  {
    id: 'proj-1',
    name: 'api-service',
    description: 'Main REST API with auth and payments',
    tags: ['backend', 'api', 'auth'],
    fileCount: 150,
    chunkCount: 500,
  },
  {
    id: 'proj-2',
    name: 'frontend-app',
    description: 'React web application',
    tags: ['frontend', 'react', 'ui'],
    fileCount: 200,
    chunkCount: 600,
  },
  {
    id: 'proj-3',
    name: 'shared-utils',
    description: 'Shared utility functions',
    tags: ['shared', 'utils'],
    fileCount: 50,
    chunkCount: 100,
  },
];

// ============================================================================
// QueryIntentClassifier Tests
// ============================================================================

describe('QueryIntentClassifier', () => {
  describe('constructor', () => {
    it('should create classifier with default config', () => {
      const classifier = new QueryIntentClassifier();
      expect(classifier.name).toBe('QueryIntentClassifier');
    });

    it('should accept custom name', () => {
      const classifier = new QueryIntentClassifier({ name: 'CustomClassifier' });
      expect(classifier.name).toBe('CustomClassifier');
    });

    it('should accept project names', () => {
      const classifier = new QueryIntentClassifier({
        projectNames: ['api-service', 'frontend-app'],
      });
      const result = classifier.classify('How does api-service handle auth?');
      expect(result.features.mentionedProjects).toContain('api-service');
    });
  });

  describe('updateProjectNames', () => {
    it('should update project names for detection', () => {
      const classifier = new QueryIntentClassifier();
      classifier.updateProjectNames(['new-project']);
      const result = classifier.classify('What is in new-project?');
      expect(result.features.mentionedProjects).toContain('new-project');
    });

    it('should clear old project names', () => {
      const classifier = new QueryIntentClassifier({ projectNames: ['old-project'] });
      classifier.updateProjectNames(['new-project']);
      const result = classifier.classify('What is in old-project?');
      expect(result.features.mentionedProjects).not.toContain('old-project');
    });
  });

  describe('classify - SINGLE_PROJECT intent', () => {
    const classifier = createIntentClassifier(['api-service', 'frontend-app', 'shared-utils']);

    it('should detect single project mention', () => {
      const result = classifier.classify('How does api-service handle authentication?');
      expect(result.intent).toBe('SINGLE_PROJECT');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
      expect(result.targetProjectNames).toEqual(['api-service']);
    });

    it('should be case insensitive for project names', () => {
      const result = classifier.classify('How does API-SERVICE handle errors?');
      expect(result.intent).toBe('SINGLE_PROJECT');
      expect(result.features.mentionedProjects).toContain('api-service');
    });

    it('should detect "this project" indicators', () => {
      const result = classifier.classify('How does authentication work in this project?');
      expect(result.intent).toBe('SINGLE_PROJECT');
      expect(result.features.hasSingleProjectIndicators).toBe(true);
    });

    it('should detect "current project" indicators', () => {
      const result = classifier.classify('What is the structure of the current project?');
      expect(result.intent).toBe('SINGLE_PROJECT');
      expect(result.features.hasSingleProjectIndicators).toBe(true);
    });

    it('should detect "in here" indicator', () => {
      const result = classifier.classify('Show me the error handling in here');
      expect(result.intent).toBe('SINGLE_PROJECT');
    });
  });

  describe('classify - MULTI_PROJECT intent', () => {
    const classifier = createIntentClassifier(['api-service', 'frontend-app', 'shared-utils']);

    it('should detect "compare" keyword', () => {
      const result = classifier.classify('Compare error handling patterns');
      expect(result.intent).toBe('MULTI_PROJECT');
      expect(result.features.hasMultiProjectKeywords).toBe(true);
      expect(result.features.multiProjectKeywords).toContain('compare');
    });

    it('should detect "across" keyword', () => {
      const result = classifier.classify('How is logging done across the codebase?');
      expect(result.intent).toBe('MULTI_PROJECT');
      expect(result.features.multiProjectKeywords).toContain('across');
    });

    it('should detect "all projects" keyword', () => {
      const result = classifier.classify('List all auth methods in all projects');
      expect(result.intent).toBe('MULTI_PROJECT');
      expect(result.features.multiProjectKeywords).toContain('all projects');
    });

    it('should detect "vs" keyword', () => {
      const result = classifier.classify('api-service vs frontend-app error handling');
      expect(result.intent).toBe('MULTI_PROJECT');
      expect(result.features.multiProjectKeywords).toContain('vs');
    });

    it('should detect multiple project mentions without keywords', () => {
      const result = classifier.classify('Show api-service and frontend-app auth code');
      expect(result.intent).toBe('MULTI_PROJECT');
      expect(result.features.mentionedProjects).toHaveLength(2);
    });

    it('should have higher confidence with keywords + multiple projects', () => {
      const result = classifier.classify('Compare api-service and frontend-app');
      expect(result.intent).toBe('MULTI_PROJECT');
      expect(result.confidence).toBeGreaterThanOrEqual(0.95);
    });
  });

  describe('classify - GENERAL intent', () => {
    const classifier = createIntentClassifier(['api-service', 'frontend-app']);

    it('should return GENERAL for ambiguous queries', () => {
      const result = classifier.classify('How does authentication work?');
      expect(result.intent).toBe('GENERAL');
    });

    it('should return GENERAL for general knowledge questions', () => {
      const result = classifier.classify('What is dependency injection?');
      expect(result.intent).toBe('GENERAL');
    });

    it('should have lower confidence for GENERAL intent', () => {
      const result = classifier.classify('Show me the code');
      expect(result.intent).toBe('GENERAL');
      expect(result.confidence).toBeLessThanOrEqual(0.7);
    });
  });

  describe('extractFeatures', () => {
    const classifier = createIntentClassifier(['api-service']);

    it('should count words correctly', () => {
      const features = classifier.extractFeatures('How does auth work in api-service?');
      expect(features.wordCount).toBe(6);
    });

    it('should find multiple mentioned projects', () => {
      const classifier2 = createIntentClassifier(['api', 'frontend']);
      const features = classifier2.extractFeatures('Compare api and frontend');
      expect(features.mentionedProjects).toContain('api');
      expect(features.mentionedProjects).toContain('frontend');
    });

    it('should detect current project reference', () => {
      const features = classifier.extractFeatures('How does this work?', 'api-service');
      // "this" alone doesn't trigger - needs "this project"
      expect(features.refersToCurrentProject).toBe(false);

      const features2 = classifier.extractFeatures('How does api-service work?', 'api-service');
      expect(features2.refersToCurrentProject).toBe(true);
    });
  });
});

// ============================================================================
// LLMProjectRouter Tests
// ============================================================================

describe('LLMProjectRouter', () => {
  describe('constructor', () => {
    it('should create router without LLM provider', () => {
      const router = createProjectRouter(null);
      expect(router).toBeDefined();
    });

    it('should accept custom config', () => {
      const router = createProjectRouter(null, {
        confidenceThreshold: 0.8,
        llmTimeout: 10000,
        maxRetries: 3,
      });
      expect(router).toBeDefined();
    });
  });

  describe('route - heuristic path', () => {
    const router = createProjectRouter(null);

    it('should route single project mention via heuristics', async () => {
      const result = await router.route(
        'How does api-service handle auth?',
        mockProjects,
        undefined
      );

      expect(result.method).toBe('heuristic');
      expect(result.projectIds).toEqual(['proj-1']);
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('should route multi-project query via heuristics', async () => {
      const result = await router.route(
        'Compare api-service and frontend-app',
        mockProjects,
        undefined
      );

      expect(result.method).toBe('heuristic');
      expect(result.projectIds).toContain('proj-1');
      expect(result.projectIds).toContain('proj-2');
    });

    it('should route "compare" keyword to all projects', async () => {
      const result = await router.route(
        'Compare error handling patterns',
        mockProjects,
        undefined
      );

      expect(result.method).toBe('heuristic');
      expect(result.projectIds).toHaveLength(3); // All projects
    });
  });

  describe('route - fallback path', () => {
    const router = createProjectRouter(null);

    it('should fallback to current project for GENERAL queries', async () => {
      const result = await router.route(
        'How does authentication work?',
        mockProjects,
        'proj-1' // current project
      );

      expect(result.method).toBe('fallback_all');
      expect(result.projectIds).toEqual(['proj-1']);
      expect(result.reason).toContain('current project');
    });

    it('should fallback to ALL projects when no current project', async () => {
      const result = await router.route(
        'How does authentication work?',
        mockProjects,
        undefined
      );

      expect(result.method).toBe('fallback_all');
      expect(result.projectIds).toHaveLength(3);
      expect(result.reason).toContain('all projects');
    });

    it('should return empty array when no projects exist', async () => {
      const result = await router.route(
        'How does auth work?',
        [],
        undefined
      );

      expect(result.projectIds).toEqual([]);
      expect(result.reason).toContain('No projects indexed');
    });
  });

  describe('route - LLM path', () => {
    it('should use LLM for GENERAL queries when provider available', async () => {
      const mockLLM = {
        chat: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            projectIds: ['proj-1'],
            confidence: 0.85,
            reasoning: 'Auth is in api-service',
          }),
        }),
        streamChat: vi.fn(),
        name: 'mock',
        model: 'mock-model',
        isAvailable: vi.fn().mockResolvedValue(true),
      };

      const router = createProjectRouter(mockLLM as any);

      const result = await router.route(
        'How does authentication work?',
        mockProjects,
        undefined
      );

      expect(result.method).toBe('llm');
      expect(result.projectIds).toEqual(['proj-1']);
      expect(mockLLM.chat).toHaveBeenCalled();
    });

    it('should fallback when LLM confidence is below threshold', async () => {
      const mockLLM = {
        chat: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            projectIds: ['proj-1'],
            confidence: 0.5, // Below 0.7 threshold
            reasoning: 'Not sure',
          }),
        }),
        streamChat: vi.fn(),
        name: 'mock',
        model: 'mock-model',
        isAvailable: vi.fn().mockResolvedValue(true),
      };

      const router = createProjectRouter(mockLLM as any);

      const result = await router.route(
        'How does authentication work?',
        mockProjects,
        undefined
      );

      expect(result.method).toBe('fallback_all');
      expect(result.projectIds).toHaveLength(3); // All projects
      expect(result.reason).toContain('below threshold');
    });

    it('should fallback when LLM throws error', async () => {
      const mockLLM = {
        chat: vi.fn().mockRejectedValue(new Error('API error')),
        streamChat: vi.fn(),
        name: 'mock',
        model: 'mock-model',
        isAvailable: vi.fn().mockResolvedValue(true),
      };

      const router = createProjectRouter(mockLLM as any);

      const result = await router.route(
        'How does authentication work?',
        mockProjects,
        undefined
      );

      expect(result.method).toBe('fallback_all');
      expect(result.reason).toContain('failed');
    });

    it('should filter invalid project IDs from LLM response', async () => {
      const mockLLM = {
        chat: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            projectIds: ['proj-1', 'invalid-id', 'proj-2'],
            confidence: 0.9,
            reasoning: 'Selected projects',
          }),
        }),
        streamChat: vi.fn(),
        name: 'mock',
        model: 'mock-model',
        isAvailable: vi.fn().mockResolvedValue(true),
      };

      const router = createProjectRouter(mockLLM as any);

      const result = await router.route(
        'How does authentication work?',
        mockProjects,
        undefined
      );

      expect(result.projectIds).toEqual(['proj-1', 'proj-2']);
      expect(result.projectIds).not.toContain('invalid-id');
    });
  });

  describe('updateProjects', () => {
    it('should update internal classifier with new projects', async () => {
      const router = createProjectRouter(null);

      // Initially, 'new-project' is not known
      let result = await router.route(
        'How does new-project work?',
        [{ ...mockProjects[0], id: 'new-id', name: 'new-project' }],
        undefined
      );

      // After routing, it updates and should recognize
      expect(result.projectIds).toEqual(['new-id']);
    });
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Edge Cases', () => {
  const classifier = createIntentClassifier(['api-service', 'frontend-app']);
  const router = createProjectRouter(null);

  it('should handle empty query', () => {
    const result = classifier.classify('');
    expect(result.intent).toBe('GENERAL');
    expect(result.features.wordCount).toBe(1); // Empty split gives ['']
  });

  it('should handle whitespace-only query', () => {
    const result = classifier.classify('   ');
    expect(result.intent).toBe('GENERAL');
  });

  it('should handle very long queries', () => {
    const longQuery = 'How does ' + 'api-service '.repeat(100) + 'work?';
    const result = classifier.classify(longQuery);
    expect(result.intent).toBe('SINGLE_PROJECT');
    expect(result.features.mentionedProjects).toContain('api-service');
  });

  it('should handle special characters in query', () => {
    const result = classifier.classify('What is @auth.handler in api-service?');
    expect(result.intent).toBe('SINGLE_PROJECT');
    expect(result.features.mentionedProjects).toContain('api-service');
  });

  it('should handle project names with hyphens', () => {
    const classifier2 = createIntentClassifier(['my-cool-project']);
    const result = classifier2.classify('Explain my-cool-project architecture');
    expect(result.intent).toBe('SINGLE_PROJECT');
    expect(result.features.mentionedProjects).toContain('my-cool-project');
  });

  it('should not match partial project names', () => {
    const classifier2 = createIntentClassifier(['api']);
    const result = classifier2.classify('The apiHelper function is broken');
    // 'api' should NOT match 'apiHelper'
    expect(result.features.mentionedProjects).not.toContain('api');
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('Integration: Classifier + Router', () => {
  it('should route real-world queries correctly', async () => {
    const router = createProjectRouter(null);

    const testCases: Array<{
      query: string;
      expectedIntent: QueryIntent;
      currentProject?: string;
    }> = [
      {
        query: 'How does the authentication middleware work in api-service?',
        expectedIntent: 'SINGLE_PROJECT',
      },
      {
        query: 'Compare the error handling approaches across all projects',
        expectedIntent: 'MULTI_PROJECT',
      },
      {
        query: 'What is the difference between api-service and frontend-app auth?',
        expectedIntent: 'MULTI_PROJECT',
      },
      {
        query: 'How do I implement a REST endpoint?',
        expectedIntent: 'GENERAL',
      },
      {
        query: 'Show me the code in this project',
        expectedIntent: 'SINGLE_PROJECT',
        currentProject: 'proj-1', // "this project" needs current context
      },
    ];

    for (const { query, expectedIntent, currentProject } of testCases) {
      const result = await router.route(
        query,
        mockProjects,
        currentProject // Pass the actual currentProject value
      );

      // For SINGLE_PROJECT and MULTI_PROJECT, should be heuristic
      // For GENERAL without LLM, should be fallback
      if (expectedIntent === 'GENERAL') {
        expect(result.method).toBe('fallback_all');
      } else {
        expect(result.method).toBe('heuristic');
      }

      // Always should return project IDs (never empty when projects exist)
      expect(result.projectIds.length).toBeGreaterThan(0);
    }
  });
});
