/**
 * Tests for Provider REPL Commands
 *
 * Tests the /provider command handlers and provider creation from config.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderConfig } from '../../../config/providers.js';

// Create mock provider result that will be returned
const mockProviderResult = {
  provider: { streamChat: vi.fn() },
  name: 'mock-provider',
  model: 'mock-model',
};

// Mock the provider factories - these must be hoisted
vi.mock('../../../providers/anthropic.js', () => ({
  createAnthropicProvider: vi.fn(async (options: { model: string }) => ({
    provider: { streamChat: vi.fn() },
    name: 'anthropic',
    model: options.model,
  })),
  DEFAULT_ANTHROPIC_MODEL: 'claude-sonnet-4-20250514',
}));

vi.mock('../../../providers/openai.js', () => ({
  createOpenAIProvider: vi.fn(async (options: { model: string }) => ({
    provider: { streamChat: vi.fn() },
    name: 'openai',
    model: options.model,
  })),
  DEFAULT_OPENAI_MODEL: 'gpt-4o',
}));

// Import after mocks are set up
import { createProviderFromConfig } from '../provider-repl.js';
import { createAnthropicProvider } from '../../../providers/anthropic.js';
import { createOpenAIProvider } from '../../../providers/openai.js';

describe('provider-repl', () => {
  beforeEach(() => {
    // Reset call history but keep implementations
    vi.mocked(createAnthropicProvider).mockClear();
    vi.mocked(createOpenAIProvider).mockClear();
  });

  // ==========================================================================
  // createProviderFromConfig
  // ==========================================================================

  describe('createProviderFromConfig', () => {
    it('creates anthropic provider with apiKey', async () => {
      const config: ProviderConfig = {
        type: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        apiKey: 'sk-ant-test-key',
      };

      const result = await createProviderFromConfig('my-claude', config);

      expect(createAnthropicProvider).toHaveBeenCalledWith({
        model: 'claude-sonnet-4-20250514',
        apiKey: 'sk-ant-test-key',
        skipAvailabilityCheck: true,
      });
      expect(result.displayName).toBe('my-claude');
      expect(result.model).toBe('claude-sonnet-4-20250514');
    });

    it('creates openai provider with apiKey', async () => {
      const config: ProviderConfig = {
        type: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-test-key',
      };

      const result = await createProviderFromConfig('my-gpt', config);

      expect(createOpenAIProvider).toHaveBeenCalledWith({
        model: 'gpt-4o',
        apiKey: 'sk-test-key',
        skipAvailabilityCheck: true,
      });
      expect(result.displayName).toBe('my-gpt');
      expect(result.model).toBe('gpt-4o');
    });

    it('creates openai-compatible provider with baseURL', async () => {
      const config: ProviderConfig = {
        type: 'openai-compatible',
        model: 'glm-4.7',
        baseURL: 'https://api.z.ai/api/coding/paas/v4',
        apiKey: 'sk-zai-test',
      };

      const result = await createProviderFromConfig('z-ai', config);

      expect(createOpenAIProvider).toHaveBeenCalledWith({
        model: 'glm-4.7',
        apiKey: 'sk-zai-test',
        baseURL: 'https://api.z.ai/api/coding/paas/v4',
        skipAvailabilityCheck: true,
      });
      expect(result.displayName).toBe('z-ai');
    });

    it('uses custom display name from parameter', async () => {
      const config: ProviderConfig = {
        type: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        apiKey: 'sk-ant-test',
      };

      const result = await createProviderFromConfig('work-claude', config);

      expect(result.displayName).toBe('work-claude');
    });

    it('returns provider object with streamChat method', async () => {
      const config: ProviderConfig = {
        type: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        apiKey: 'sk-ant-test',
      };

      const result = await createProviderFromConfig('test', config);

      expect(result.provider).toBeDefined();
      expect(typeof result.provider.streamChat).toBe('function');
    });

    it('skips availability check for faster creation', async () => {
      const config: ProviderConfig = {
        type: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-test',
      };

      await createProviderFromConfig('test', config);

      expect(createOpenAIProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          skipAvailabilityCheck: true,
        })
      );
    });
  });

  // ==========================================================================
  // Provider type handling
  // ==========================================================================

  describe('provider type handling', () => {
    it('handles all three provider types', async () => {
      const configs: Array<{ name: string; config: ProviderConfig }> = [
        {
          name: 'claude',
          config: { type: 'anthropic', model: 'claude', apiKey: 'key1' },
        },
        {
          name: 'gpt',
          config: { type: 'openai', model: 'gpt-4', apiKey: 'key2' },
        },
        {
          name: 'custom',
          config: {
            type: 'openai-compatible',
            model: 'custom-model',
            baseURL: 'https://custom.api.com',
            apiKey: 'key3',
          },
        },
      ];

      for (const { name, config } of configs) {
        const result = await createProviderFromConfig(name, config);
        expect(result.displayName).toBe(name);
        expect(result.provider).toBeDefined();
      }
    });
  });
});
