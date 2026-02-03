/**
 * Query Router
 *
 * Smart query routing for multi-project RAG search.
 * Determines which project(s) to search based on query content.
 *
 * Architecture:
 * 1. QueryIntentClassifier - Heuristic classification (zero LLM calls)
 * 2. LLMProjectRouter - LLM-based routing with fallback chain
 *
 * DESIGN PRINCIPLE: The router ALWAYS returns project IDs when projects exist.
 * Fallback chain ensures queries never go without context.
 *
 * @example
 * ```typescript
 * const classifier = new QueryIntentClassifier(['api-service', 'frontend']);
 *
 * classifier.classify('How does auth work in api-service');
 * // { intent: 'SINGLE_PROJECT', targetProjectIds: ['api-service'], confidence: 0.9 }
 *
 * classifier.classify('Compare error handling across projects');
 * // { intent: 'MULTI_PROJECT', confidence: 0.85 }
 * ```
 */

import { z } from 'zod';
import type { LLMProvider } from '@contextaisdk/core';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Query intent for project routing.
 *
 * - SINGLE_PROJECT: Query targets a specific project (mentioned by name)
 * - MULTI_PROJECT: Query needs cross-project search (comparative, "across all")
 * - GENERAL: Ambiguous query, needs LLM routing or defaults to current/all
 */
export type QueryIntent = 'SINGLE_PROJECT' | 'MULTI_PROJECT' | 'GENERAL';

/**
 * Features extracted from a query for intent classification.
 */
export interface IntentFeatures {
  /** Project names mentioned in the query */
  mentionedProjects: string[];
  /** Query contains multi-project keywords (compare, across, etc.) */
  hasMultiProjectKeywords: boolean;
  /** The detected multi-project keywords */
  multiProjectKeywords: string[];
  /** Query contains single-project indicators (this project, current, etc.) */
  hasSingleProjectIndicators: boolean;
  /** Query refers to the currently focused project */
  refersToCurrentProject: boolean;
  /** Word count for complexity assessment */
  wordCount: number;
}

/**
 * Result of intent classification.
 */
export interface IntentClassificationResult {
  /** The classified intent */
  intent: QueryIntent;
  /** Confidence score 0-1 */
  confidence: number;
  /** Extracted features used for classification */
  features: IntentFeatures;
  /** Project names to search (if determined from query) */
  targetProjectNames?: string[];
}

/**
 * Configuration for QueryIntentClassifier.
 */
export interface QueryIntentClassifierConfig {
  /** Known project names for detection */
  projectNames?: string[];
  /** Additional multi-project keywords to detect */
  additionalMultiKeywords?: string[];
  /** Name for this classifier instance (for debugging) */
  name?: string;
}

// ============================================================================
// KEYWORD SETS
// ============================================================================

/**
 * Keywords that indicate cross-project search intent.
 *
 * These trigger MULTI_PROJECT classification even without
 * explicit project name mentions.
 */
const DEFAULT_MULTI_PROJECT_KEYWORDS = new Set([
  'compare',
  'comparison',
  'comparing',
  'versus',
  'vs',
  'across',
  'all projects',
  'every project',
  'both projects',
  'all codebases',
  'each project',
  'different from',
  'differs from',
  'similarities',
  'differences',
  'between',
  'common pattern',
  'shared pattern',
  'consistent',
  'inconsistent',
]);

/**
 * Indicators that query is about the current/focused project.
 *
 * These trigger SINGLE_PROJECT classification when no project
 * name is explicitly mentioned.
 */
const SINGLE_PROJECT_INDICATORS = new Set([
  'this project',
  'this codebase',
  'this repo',
  'this repository',
  'current project',
  'focused project',
  'in here',
  'here',
]);

// ============================================================================
// QueryIntentClassifier
// ============================================================================

/**
 * Heuristic-based query intent classifier.
 *
 * Classifies queries into SINGLE_PROJECT, MULTI_PROJECT, or GENERAL
 * using pattern matching and keyword detection. No LLM calls.
 *
 * Following the ContextAI SDK's QueryClassifier pattern.
 */
export class QueryIntentClassifier {
  readonly name: string;

  private readonly projectNames: Set<string>;
  private readonly projectNamesLower: Map<string, string>; // lowercase -> original
  private readonly multiProjectKeywords: Set<string>;

  constructor(config: QueryIntentClassifierConfig = {}) {
    this.name = config.name ?? 'QueryIntentClassifier';

    // Build project name lookup (case-insensitive matching)
    this.projectNames = new Set(config.projectNames ?? []);
    this.projectNamesLower = new Map();
    for (const name of this.projectNames) {
      this.projectNamesLower.set(name.toLowerCase(), name);
    }

    // Build multi-project keywords set
    this.multiProjectKeywords = new Set([
      ...DEFAULT_MULTI_PROJECT_KEYWORDS,
      ...(config.additionalMultiKeywords ?? []).map((k) => k.toLowerCase()),
    ]);
  }

  /**
   * Update known project names.
   * Call this when projects are added/removed.
   */
  updateProjectNames(names: string[]): void {
    this.projectNames.clear();
    this.projectNamesLower.clear();
    for (const name of names) {
      this.projectNames.add(name);
      this.projectNamesLower.set(name.toLowerCase(), name);
    }
  }

  /**
   * Classify query intent without LLM calls.
   */
  classify(query: string, currentProjectName?: string): IntentClassificationResult {
    const features = this.extractFeatures(query, currentProjectName);
    const { intent, confidence } = this.determineIntent(features);

    // Determine target projects if single-project intent
    let targetProjectNames: string[] | undefined;
    if (intent === 'SINGLE_PROJECT' && features.mentionedProjects.length > 0) {
      targetProjectNames = features.mentionedProjects;
    }

    return { intent, confidence, features, targetProjectNames };
  }

  /**
   * Extract classification features from query.
   */
  extractFeatures(query: string, currentProjectName?: string): IntentFeatures {
    const normalized = query.trim().toLowerCase();
    const words = normalized.split(/\s+/);

    // Find mentioned project names
    const mentionedProjects = this.findMentionedProjects(query);

    // Find multi-project keywords
    const multiProjectKeywords = this.findMultiProjectKeywords(normalized);

    // Check for single-project indicators
    const hasSingleProjectIndicators = this.hasSingleProjectIndicators(normalized);

    // Check if referring to current project
    const refersToCurrentProject = currentProjectName
      ? mentionedProjects.some((p) => p.toLowerCase() === currentProjectName.toLowerCase()) ||
        hasSingleProjectIndicators
      : hasSingleProjectIndicators;

    return {
      mentionedProjects,
      hasMultiProjectKeywords: multiProjectKeywords.length > 0,
      multiProjectKeywords,
      hasSingleProjectIndicators,
      refersToCurrentProject,
      wordCount: words.length,
    };
  }

  /**
   * Find project names mentioned in the query.
   */
  private findMentionedProjects(query: string): string[] {
    const mentioned: string[] = [];

    for (const [lowerName, originalName] of this.projectNamesLower) {
      // Word boundary match (case-insensitive)
      const pattern = new RegExp(`\\b${this.escapeRegex(lowerName)}\\b`, 'i');
      if (pattern.test(query)) {
        mentioned.push(originalName);
      }
    }

    return mentioned;
  }

  /**
   * Find multi-project keywords in the query.
   */
  private findMultiProjectKeywords(normalizedQuery: string): string[] {
    const found: string[] = [];

    for (const keyword of this.multiProjectKeywords) {
      if (normalizedQuery.includes(keyword)) {
        found.push(keyword);
      }
    }

    return found;
  }

  /**
   * Check if query has single-project indicators.
   */
  private hasSingleProjectIndicators(normalizedQuery: string): boolean {
    for (const indicator of SINGLE_PROJECT_INDICATORS) {
      if (normalizedQuery.includes(indicator)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Determine intent from extracted features.
   *
   * Note: We require project mentions for MULTI_PROJECT classification to
   * prevent false positives. A query like "compare error handling" without
   * project mentions should be treated as GENERAL, not MULTI_PROJECT.
   */
  private determineIntent(features: IntentFeatures): { intent: QueryIntent; confidence: number } {
    // Priority 1: Multiple projects explicitly mentioned
    if (features.mentionedProjects.length >= 2) {
      return { intent: 'MULTI_PROJECT', confidence: 0.95 };
    }

    // Priority 2: Multi-project keywords WITH at least one project mentioned
    if (features.hasMultiProjectKeywords && features.mentionedProjects.length > 0) {
      return { intent: 'MULTI_PROJECT', confidence: 0.85 };
    }

    // Priority 3: Exactly one project mentioned
    if (features.mentionedProjects.length === 1) {
      return { intent: 'SINGLE_PROJECT', confidence: 0.9 };
    }

    // Priority 4: Single-project indicators ("this project", etc.)
    if (features.hasSingleProjectIndicators) {
      return { intent: 'SINGLE_PROJECT', confidence: 0.85 };
    }

    // Priority 5: Multi-project keywords WITHOUT project mentions → GENERAL
    // (User likely wants general advice, not cross-project search)
    if (features.hasMultiProjectKeywords) {
      return { intent: 'GENERAL', confidence: 0.6 };
    }

    // Default: GENERAL - needs LLM-based routing or fallback
    return { intent: 'GENERAL', confidence: 0.5 };
  }

  /**
   * Escape special regex characters.
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

// ============================================================================
// LLM PROJECT ROUTER TYPES
// ============================================================================

/**
 * Project metadata for LLM routing decisions.
 */
export interface ProjectMetadata {
  /** Project ID (UUID) */
  id: string;
  /** Project name */
  name: string;
  /** User-provided description (from /describe command) */
  description: string | null;
  /** User-provided tags for categorization */
  tags: string[];
  /** Number of files in project */
  fileCount: number;
  /** Number of indexed chunks */
  chunkCount: number;
}

/**
 * LLM routing response schema.
 *
 * The LLM returns this JSON structure to indicate which
 * projects should be searched.
 */
export const LLMRoutingResponseSchema = z.object({
  projectIds: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().optional(),
});

export type LLMRoutingResponse = z.infer<typeof LLMRoutingResponseSchema>;

/**
 * Result from the project router.
 */
export interface RoutingResult {
  /** Project IDs to search */
  projectIds: string[];
  /** Routing method used */
  method: 'heuristic' | 'llm' | 'fallback_all';
  /** Confidence in routing decision */
  confidence: number;
  /** Human-readable explanation of routing decision */
  reason: string;
}

/**
 * Configuration for LLMProjectRouter.
 */
export interface LLMProjectRouterConfig {
  /** Minimum confidence to trust LLM routing (default: 0.7) */
  confidenceThreshold?: number;
  /** Timeout for LLM call in ms (default: 5000) */
  llmTimeout?: number;
  /** Maximum retries for LLM call (default: 1) */
  maxRetries?: number;
}

// ============================================================================
// LLMProjectRouter
// ============================================================================

const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
const DEFAULT_LLM_TIMEOUT = 5000;
const DEFAULT_MAX_RETRIES = 1;

/**
 * LLM routing prompt template.
 *
 * {{PROJECTS}} is replaced with project metadata list.
 * {{QUERY}} is replaced with the user's query.
 */
const ROUTING_PROMPT_TEMPLATE = `You are a query router for a multi-project code search system.

Given a user query and available project metadata, determine which project(s) should be searched.

Available Projects:
{{PROJECTS}}

User Query: {{QUERY}}

Respond with JSON only (no markdown):
{
  "projectIds": ["<project-id-1>", ...],
  "confidence": <0.0-1.0>,
  "reasoning": "<brief explanation>"
}

Rules:
- If query clearly targets a specific project, return that project with high confidence
- If query is comparative or mentions multiple projects, return all relevant projects
- If unsure which project, return empty projectIds with low confidence
- Consider project descriptions and tags when matching
- Never make up project IDs - only use ones from the list above`;

/**
 * LLM-based project router with robust fallback chain.
 *
 * Routing pipeline:
 * 1. Heuristic classification via QueryIntentClassifier (instant, free)
 * 2. LLM routing for GENERAL queries (if provider available)
 * 3. Fallback to current project or ALL projects (never fails)
 *
 * DESIGN: ALWAYS returns project IDs when projects exist.
 * The fallback chain ensures queries never go without context.
 */
export class LLMProjectRouter {
  private readonly intentClassifier: QueryIntentClassifier;
  private readonly llmProvider: LLMProvider | null;
  private readonly confidenceThreshold: number;
  private readonly llmTimeout: number;
  private readonly maxRetries: number;

  constructor(llmProvider: LLMProvider | null, config: LLMProjectRouterConfig = {}) {
    this.llmProvider = llmProvider;
    this.intentClassifier = new QueryIntentClassifier();
    this.confidenceThreshold = config.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    this.llmTimeout = config.llmTimeout ?? DEFAULT_LLM_TIMEOUT;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  /**
   * Update known projects for heuristic classification.
   * Call this when projects are added/removed.
   */
  updateProjects(projects: ProjectMetadata[]): void {
    this.intentClassifier.updateProjectNames(projects.map((p) => p.name));
  }

  /**
   * Route a query to appropriate projects.
   *
   * CRITICAL: Always returns project IDs when projects exist.
   * The fallback chain ensures no query goes without context.
   */
  async route(
    query: string,
    projects: ProjectMetadata[],
    currentProjectId?: string
  ): Promise<RoutingResult> {
    // Edge case: No projects indexed
    if (projects.length === 0) {
      return {
        projectIds: [],
        method: 'fallback_all',
        confidence: 1.0,
        reason: 'No projects indexed',
      };
    }

    // Update classifier with current project names
    this.intentClassifier.updateProjectNames(projects.map((p) => p.name));

    // Find current project name for context
    const currentProject = projects.find((p) => p.id === currentProjectId);

    // Step 1: Heuristic classification
    const classification = this.intentClassifier.classify(query, currentProject?.name);

    // Fast path: Single project clearly identified by name
    if (classification.intent === 'SINGLE_PROJECT' && classification.targetProjectNames) {
      const targetIds = this.resolveProjectIds(classification.targetProjectNames, projects);
      if (targetIds.length > 0) {
        return {
          projectIds: targetIds,
          method: 'heuristic',
          confidence: classification.confidence,
          reason: `Query targets project: ${classification.features.mentionedProjects.join(', ')}`,
        };
      }
    }

    // Fast path: "this project" indicators with a current project
    if (
      classification.intent === 'SINGLE_PROJECT' &&
      classification.features.hasSingleProjectIndicators &&
      currentProjectId
    ) {
      return {
        projectIds: [currentProjectId],
        method: 'heuristic',
        confidence: classification.confidence,
        reason: 'Query refers to current project',
      };
    }

    // Fast path: Multi-project query
    if (classification.intent === 'MULTI_PROJECT') {
      // Search mentioned projects or ALL if none mentioned
      const targetIds =
        classification.features.mentionedProjects.length > 0
          ? this.resolveProjectIds(classification.features.mentionedProjects, projects)
          : projects.map((p) => p.id);

      return {
        projectIds: targetIds,
        method: 'heuristic',
        confidence: classification.confidence,
        reason: `Multi-project query: ${classification.features.multiProjectKeywords.join(', ') || 'multiple projects mentioned'}`,
      };
    }

    // Step 2: GENERAL intent - try LLM routing
    if (this.llmProvider) {
      try {
        const llmResult = await this.routeWithLLM(query, projects);

        // Trust LLM if confidence is high enough
        if (llmResult.confidence >= this.confidenceThreshold && llmResult.projectIds.length > 0) {
          return {
            projectIds: llmResult.projectIds,
            method: 'llm',
            confidence: llmResult.confidence,
            reason: llmResult.reasoning ?? 'LLM routing',
          };
        }

        // LLM returned low confidence - fall back to ALL
        return {
          projectIds: projects.map((p) => p.id),
          method: 'fallback_all',
          confidence: llmResult.confidence,
          reason: `LLM confidence ${llmResult.confidence.toFixed(2)} below threshold ${this.confidenceThreshold}`,
        };
      } catch (error) {
        // LLM failed - fall back to ALL
        return {
          projectIds: projects.map((p) => p.id),
          method: 'fallback_all',
          confidence: 0.5,
          reason: `LLM routing failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
      }
    }

    // Step 3: No LLM available - fallback based on context
    // If there's a current project, use it
    if (currentProjectId) {
      return {
        projectIds: [currentProjectId],
        method: 'fallback_all',
        confidence: 0.6,
        reason: 'Using current project (no LLM available for routing)',
      };
    }

    // Last resort: search ALL projects
    return {
      projectIds: projects.map((p) => p.id),
      method: 'fallback_all',
      confidence: 0.5,
      reason: 'Searching all projects (no routing signal)',
    };
  }

  /**
   * Route using LLM with timeout and retry.
   */
  private async routeWithLLM(
    query: string,
    projects: ProjectMetadata[]
  ): Promise<LLMRoutingResponse> {
    const prompt = this.buildRoutingPrompt(query, projects);

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.callLLMWithTimeout(prompt);
        // Parse and validate response
        return this.parseRoutingResponse(response, projects);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Continue to retry
      }
    }

    throw lastError ?? new Error('LLM routing failed after retries');
  }

  /**
   * Call LLM with timeout that properly cleans up on success or failure.
   */
  private async callLLMWithTimeout(prompt: string): Promise<string> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`LLM routing timed out after ${this.llmTimeout}ms`)),
        this.llmTimeout
      );
    });

    // Suppress unhandled rejection if timeout fires after race settles.
    // This doesn't prevent the rejection from affecting Promise.race().
    timeoutPromise.catch(() => {});

    try {
      const result = await Promise.race([this.callLLM(prompt), timeoutPromise]);
      return result;
    } finally {
      // Clean up timeout to prevent unhandled rejection
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  /**
   * Build the routing prompt with project metadata.
   */
  private buildRoutingPrompt(query: string, projects: ProjectMetadata[]): string {
    const projectList = projects
      .map((p) => {
        const tags = p.tags.length > 0 ? ` [tags: ${p.tags.join(', ')}]` : '';
        const desc = p.description ? ` - ${p.description}` : '';
        return `- ${p.name} (id: ${p.id})${desc}${tags}`;
      })
      .join('\n');

    return ROUTING_PROMPT_TEMPLATE.replace('{{PROJECTS}}', projectList).replace('{{QUERY}}', query);
  }

  /**
   * Call the LLM provider.
   */
  private async callLLM(prompt: string): Promise<string> {
    if (!this.llmProvider) {
      throw new Error('No LLM provider available');
    }

    const response = await this.llmProvider.chat(
      [{ role: 'user', content: prompt }],
      {
        maxTokens: 256,
        temperature: 0.1, // Low temperature for deterministic routing
      }
    );

    return response.content;
  }

  /**
   * Parse LLM response with validation.
   */
  private parseRoutingResponse(
    response: string,
    projects: ProjectMetadata[]
  ): LLMRoutingResponse {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in LLM response');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const validated = LLMRoutingResponseSchema.parse(parsed);

    // Filter to only valid project IDs (return new object, don't mutate validated)
    const validIds = new Set(projects.map((p) => p.id));
    const filteredProjectIds = validated.projectIds.filter((id) => validIds.has(id));

    // Set confidence to 0 if all projects were invalid (LLM hallucinated IDs).
    // This prevents misleading downstream code that checks confidence thresholds.
    const adjustedConfidence = filteredProjectIds.length === 0 ? 0 : validated.confidence;

    return {
      ...validated,
      projectIds: filteredProjectIds,
      confidence: adjustedConfidence,
    };
  }

  /**
   * Resolve project names to IDs.
   */
  private resolveProjectIds(names: string[], projects: ProjectMetadata[]): string[] {
    const nameToId = new Map(projects.map((p) => [p.name.toLowerCase(), p.id]));
    return names
      .map((name) => nameToId.get(name.toLowerCase()))
      .filter((id): id is string => id !== undefined);
  }

}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

/**
 * Create a QueryIntentClassifier from project names.
 *
 * Convenience factory for common use case.
 */
export function createIntentClassifier(projectNames: string[]): QueryIntentClassifier {
  return new QueryIntentClassifier({ projectNames });
}

/**
 * Create an LLMProjectRouter.
 *
 * @param llmProvider - LLM provider for routing (optional, falls back to heuristics)
 * @param config - Router configuration
 */
export function createProjectRouter(
  llmProvider: LLMProvider | null,
  config?: LLMProjectRouterConfig
): LLMProjectRouter {
  return new LLMProjectRouter(llmProvider, config);
}
