/**
 * LLM Provider Factory Tests
 *
 * Tests for src/providers/llm.ts
 * Verifies the factory function and automatic fallback behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { LLMProvider } from '@contextaisdk/core';
import type { Config } from '../../config/schema.js';

// Mock the individual provider factories
vi.mock('../anthropic.js', () => ({
  createAnthropicProvider: vi.fn(),
  DEFAULT_ANTHROPIC_MODEL: 'claude-sonnet-4-20250514',
}));

vi.mock('../openai.js', () => ({
  createOpenAIProvider: vi.fn(),
  DEFAULT_OPENAI_MODEL: 'gpt-4o',
}));

vi.mock('../ollama.js', () => ({
  createOllamaProvider: vi.fn(),
  DEFAULT_OLLAMA_MODEL: 'llama3.2',
}));

// Mock env functions so .env file doesn't affect tests
vi.mock('../../config/env.js', () => ({
  isOpenAICompatibleConfigured: vi.fn().mockReturnValue(false),
  getOpenAICompatibleConfig: vi.fn().mockReturnValue({
    apiKey: undefined,
    baseUrl: undefined,
    model: undefined,
  }),
}));

// Import after mocking
import { createAnthropicProvider } from '../anthropic.js';
import { createOpenAIProvider } from '../openai.js';
import { createOllamaProvider } from '../ollama.js';
import {
  createLLMProvider,
  AllProvidersFailedError,
  type FallbackOptions,
} from '../llm.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

/** Create a minimal mock LLMProvider */
function createMockProvider(name: string): LLMProvider {
  return {
    name,
    model: `${name}-model`,
    chat: vi.fn(),
    streamChat: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

/** Create a minimal test config */
function createTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    default_provider: 'anthropic',
    default_model: 'claude-sonnet-4-20250514',
    embedding: {
      provider: 'huggingface',
      model: 'BAAI/bge-small-en-v1.5',
      batch_size: 32,
    },
    search: {
      top_k: 10,
      rerank: true,
    },
    ...overrides,
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('createLLMProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('primary provider succeeds', () => {
    it('returns primary provider when available', async () => {
      const mockProvider = createMockProvider('anthropic');
      (createAnthropicProvider as Mock).mockResolvedValue({
        provider: mockProvider,
        name: 'anthropic',
        model: 'claude-sonnet-4-20250514',
      });

      const config = createTestConfig({ default_provider: 'anthropic' });
      const result = await createLLMProvider(config);

      expect(result.name).toBe('anthropic');
      expect(result.usedFallback).toBe(false);
      expect(result.requestedProvider).toBe('anthropic');
      expect(result.failedAttempts).toHaveLength(0);
    });

    it('sets usedFallback to false when primary succeeds', async () => {
      const mockProvider = createMockProvider('openai');
      (createOpenAIProvider as Mock).mockResolvedValue({
        provider: mockProvider,
        name: 'openai',
        model: 'gpt-4o',
      });

      const config = createTestConfig({ default_provider: 'openai' });
      const result = await createLLMProvider(config);

      expect(result.usedFallback).toBe(false);
    });

    it('does not call onFallback callback when primary succeeds', async () => {
      const mockProvider = createMockProvider('anthropic');
      (createAnthropicProvider as Mock).mockResolvedValue({
        provider: mockProvider,
        name: 'anthropic',
        model: 'claude-sonnet-4-20250514',
      });

      const onFallback = vi.fn();
      const config = createTestConfig();
      await createLLMProvider(config, { fallback: { onFallback } });

      expect(onFallback).not.toHaveBeenCalled();
    });
  });

  describe('fallback behavior', () => {
    it('falls back to next provider when primary fails validation', async () => {
      // Anthropic fails
      (createAnthropicProvider as Mock).mockRejectedValue(
        new Error('ANTHROPIC_API_KEY not set')
      );

      // OpenAI succeeds
      const mockProvider = createMockProvider('openai');
      (createOpenAIProvider as Mock).mockResolvedValue({
        provider: mockProvider,
        name: 'openai',
        model: 'gpt-4o',
      });

      const config = createTestConfig({ default_provider: 'anthropic' });
      const result = await createLLMProvider(config);

      expect(result.name).toBe('openai');
      expect(result.usedFallback).toBe(true);
      expect(result.requestedProvider).toBe('anthropic');
      expect(result.failedAttempts).toHaveLength(1);
      expect(result.failedAttempts[0].provider).toBe('anthropic');
    });

    it('tries all providers in chain order', async () => {
      // All providers fail
      (createAnthropicProvider as Mock).mockRejectedValue(
        new Error('Anthropic unavailable')
      );
      (createOpenAIProvider as Mock).mockRejectedValue(
        new Error('OpenAI unavailable')
      );
      (createOllamaProvider as Mock).mockRejectedValue(
        new Error('Ollama unavailable')
      );

      const config = createTestConfig({ default_provider: 'anthropic' });

      await expect(createLLMProvider(config)).rejects.toThrow(AllProvidersFailedError);

      // Verify all providers were tried in order
      expect(createAnthropicProvider).toHaveBeenCalledTimes(1);
      expect(createOpenAIProvider).toHaveBeenCalledTimes(1);
      expect(createOllamaProvider).toHaveBeenCalledTimes(1);
    });

    it('calls onFallback with correct arguments', async () => {
      (createAnthropicProvider as Mock).mockRejectedValue(
        new Error('API key missing')
      );

      const mockProvider = createMockProvider('openai');
      (createOpenAIProvider as Mock).mockResolvedValue({
        provider: mockProvider,
        name: 'openai',
        model: 'gpt-4o',
      });

      const onFallback = vi.fn();
      const config = createTestConfig({ default_provider: 'anthropic' });
      await createLLMProvider(config, { fallback: { onFallback } });

      expect(onFallback).toHaveBeenCalledWith(
        'anthropic',
        'openai',
        'API key missing'
      );
    });

    it('calls onProviderFailed for each failure', async () => {
      (createAnthropicProvider as Mock).mockRejectedValue(
        new Error('Anthropic error')
      );
      (createOpenAIProvider as Mock).mockRejectedValue(
        new Error('OpenAI error')
      );

      const mockProvider = createMockProvider('ollama');
      (createOllamaProvider as Mock).mockResolvedValue({
        provider: mockProvider,
        name: 'ollama',
        model: 'llama3.2',
      });

      const onProviderFailed = vi.fn();
      const config = createTestConfig({ default_provider: 'anthropic' });
      await createLLMProvider(config, { fallback: { onProviderFailed } });

      expect(onProviderFailed).toHaveBeenCalledTimes(2);
      expect(onProviderFailed).toHaveBeenNthCalledWith(
        1,
        'anthropic',
        expect.any(Error)
      );
      expect(onProviderFailed).toHaveBeenNthCalledWith(
        2,
        'openai',
        expect.any(Error)
      );
    });

    it('uses default fallback model for each provider', async () => {
      (createAnthropicProvider as Mock).mockRejectedValue(
        new Error('Unavailable')
      );

      const mockProvider = createMockProvider('openai');
      (createOpenAIProvider as Mock).mockResolvedValue({
        provider: mockProvider,
        name: 'openai',
        model: 'gpt-4o',
      });

      const config = createTestConfig({ default_provider: 'anthropic' });
      await createLLMProvider(config);

      // Should use default OpenAI model, not the Anthropic model from config
      expect(createOpenAIProvider).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4o' })
      );
    });
  });

  describe('capability warnings', () => {
    it('calls onCapabilityWarning when falling back to less capable provider', async () => {
      (createAnthropicProvider as Mock).mockRejectedValue(
        new Error('Unavailable')
      );

      const mockProvider = createMockProvider('ollama');
      (createOllamaProvider as Mock).mockResolvedValue({
        provider: mockProvider,
        name: 'ollama',
        model: 'llama3.2',
      });

      // Skip OpenAI in fallback chain
      const config = createTestConfig({
        default_provider: 'anthropic',
        llm: { fallback_providers: ['ollama'] },
      });

      const onCapabilityWarning = vi.fn();
      await createLLMProvider(config, { fallback: { onCapabilityWarning } });

      expect(onCapabilityWarning).toHaveBeenCalledWith({
        fromProvider: 'anthropic',
        toProvider: 'ollama',
        lostCapabilities: expect.arrayContaining(['vision', 'extended-thinking']),
      });
    });
  });

  describe('all providers fail', () => {
    it('throws AllProvidersFailedError', async () => {
      (createAnthropicProvider as Mock).mockRejectedValue(new Error('A'));
      (createOpenAIProvider as Mock).mockRejectedValue(new Error('B'));
      (createOllamaProvider as Mock).mockRejectedValue(new Error('C'));

      const config = createTestConfig({ default_provider: 'anthropic' });

      await expect(createLLMProvider(config)).rejects.toThrow(AllProvidersFailedError);
    });

    it('includes all failed attempts in error', async () => {
      (createAnthropicProvider as Mock).mockRejectedValue(new Error('A'));
      (createOpenAIProvider as Mock).mockRejectedValue(new Error('B'));
      (createOllamaProvider as Mock).mockRejectedValue(new Error('C'));

      const config = createTestConfig({ default_provider: 'anthropic' });

      try {
        await createLLMProvider(config);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AllProvidersFailedError);
        const err = error as AllProvidersFailedError;
        expect(err.attempts).toHaveLength(3);
        expect(err.attempts[0].provider).toBe('anthropic');
        expect(err.attempts[1].provider).toBe('openai');
        expect(err.attempts[2].provider).toBe('ollama');
      }
    });

    it('error message lists all tried providers', async () => {
      (createAnthropicProvider as Mock).mockRejectedValue(new Error('A'));
      (createOpenAIProvider as Mock).mockRejectedValue(new Error('B'));
      (createOllamaProvider as Mock).mockRejectedValue(new Error('C'));

      const config = createTestConfig({ default_provider: 'anthropic' });

      await expect(createLLMProvider(config)).rejects.toThrow(
        /anthropic → openai → ollama/
      );
    });
  });

  describe('configuration', () => {
    it('uses config.llm.fallback_providers when specified', async () => {
      (createAnthropicProvider as Mock).mockRejectedValue(new Error('A'));

      const mockProvider = createMockProvider('ollama');
      (createOllamaProvider as Mock).mockResolvedValue({
        provider: mockProvider,
        name: 'ollama',
        model: 'llama3.2',
      });

      // Custom fallback chain skips OpenAI
      const config = createTestConfig({
        default_provider: 'anthropic',
        llm: { fallback_providers: ['ollama'] },
      });

      await createLLMProvider(config);

      // OpenAI should NOT be tried
      expect(createOpenAIProvider).not.toHaveBeenCalled();
      expect(createOllamaProvider).toHaveBeenCalled();
    });

    it('uses config.llm.fallback_models when specified', async () => {
      (createAnthropicProvider as Mock).mockRejectedValue(new Error('A'));

      const mockProvider = createMockProvider('openai');
      (createOpenAIProvider as Mock).mockResolvedValue({
        provider: mockProvider,
        name: 'openai',
        model: 'gpt-4-turbo',
      });

      const config = createTestConfig({
        default_provider: 'anthropic',
        llm: { fallback_models: { openai: 'gpt-4-turbo' } },
      });

      await createLLMProvider(config);

      expect(createOpenAIProvider).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4-turbo' })
      );
    });

    it('uses default fallback chain when not configured', async () => {
      (createAnthropicProvider as Mock).mockRejectedValue(new Error('A'));

      const mockProvider = createMockProvider('openai');
      (createOpenAIProvider as Mock).mockResolvedValue({
        provider: mockProvider,
        name: 'openai',
        model: 'gpt-4o',
      });

      // No llm config - should use default chain
      const config = createTestConfig({ default_provider: 'anthropic' });
      const result = await createLLMProvider(config);

      expect(result.name).toBe('openai'); // First in default chain after anthropic
    });
  });

  describe('disableFallback option', () => {
    it('throws immediately when primary fails', async () => {
      (createAnthropicProvider as Mock).mockRejectedValue(
        new Error('Unavailable')
      );

      const config = createTestConfig({ default_provider: 'anthropic' });

      await expect(
        createLLMProvider(config, { fallback: { disableFallback: true } })
      ).rejects.toThrow(AllProvidersFailedError);
    });

    it('does not try fallback providers', async () => {
      (createAnthropicProvider as Mock).mockRejectedValue(
        new Error('Unavailable')
      );

      const config = createTestConfig({ default_provider: 'anthropic' });

      try {
        await createLLMProvider(config, { fallback: { disableFallback: true } });
      } catch {
        // Expected to throw
      }

      expect(createOpenAIProvider).not.toHaveBeenCalled();
      expect(createOllamaProvider).not.toHaveBeenCalled();
    });
  });

  describe('model override', () => {
    it('uses options.model for primary provider', async () => {
      const mockProvider = createMockProvider('anthropic');
      (createAnthropicProvider as Mock).mockResolvedValue({
        provider: mockProvider,
        name: 'anthropic',
        model: 'claude-3-opus-20240229',
      });

      const config = createTestConfig({ default_provider: 'anthropic' });
      await createLLMProvider(config, { model: 'claude-3-opus-20240229' });

      expect(createAnthropicProvider).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-3-opus-20240229' })
      );
    });
  });
});
