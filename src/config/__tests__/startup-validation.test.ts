/**
 * Startup Validation Tests
 *
 * Tests for CLI startup configuration validation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateStartupConfig,
  getValidationOptionsForCommand,
  COMMANDS_REQUIRING_LLM,
  COMMANDS_REQUIRING_EMBEDDING,
} from '../startup-validation.js';

// ============================================================================
// Mocks
// ============================================================================

// Mock the config loader
vi.mock('../loader.js', () => ({
  loadConfig: vi.fn(),
}));

// Mock the validation module
vi.mock('../../providers/validation.js', () => ({
  validateProviderKey: vi.fn(),
}));

// Mock the env module
vi.mock('../env.js', () => ({
  hasApiKey: vi.fn(),
  SETUP_INSTRUCTIONS: {
    anthropic: 'Set ANTHROPIC_API_KEY in your environment',
    openai: 'Set OPENAI_API_KEY in your environment',
  },
}));

import { loadConfig } from '../loader.js';
import { validateProviderKey } from '../../providers/validation.js';
import { hasApiKey } from '../env.js';

// ============================================================================
// Tests
// ============================================================================

describe('validateStartupConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('when all keys are valid', () => {
    it('returns valid result', () => {
      vi.mocked(loadConfig).mockReturnValue({
        default_provider: 'anthropic',
        default_model: 'claude-sonnet-4-20250514',
        embedding: {
          provider: 'huggingface',
          model: 'bge-small',
          batch_size: 32,
        },
        search: { top_k: 10, rerank: false },
      });
      vi.mocked(validateProviderKey).mockReturnValue({ valid: true });

      const result = validateStartupConfig();

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('when LLM provider key is invalid', () => {
    it('returns error for anthropic', () => {
      vi.mocked(loadConfig).mockReturnValue({
        default_provider: 'anthropic',
        default_model: 'claude-sonnet-4-20250514',
        embedding: {
          provider: 'huggingface',
          model: 'bge-small',
          batch_size: 32,
        },
        search: { top_k: 10, rerank: false },
      });
      vi.mocked(validateProviderKey).mockReturnValue({
        valid: false,
        error: 'API key not set',
        setupInstructions: 'Set ANTHROPIC_API_KEY',
      });

      const result = validateStartupConfig();

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Anthropic');
    });

    it('skips validation for ollama (no key needed)', () => {
      vi.mocked(loadConfig).mockReturnValue({
        default_provider: 'ollama',
        default_model: 'llama3.2',
        embedding: {
          provider: 'huggingface',
          model: 'bge-small',
          batch_size: 32,
        },
        search: { top_k: 10, rerank: false },
      });

      const result = validateStartupConfig();

      // Should not call validateProviderKey for ollama
      expect(vi.mocked(validateProviderKey)).not.toHaveBeenCalledWith('ollama');
      expect(result.valid).toBe(true);
    });
  });

  describe('when embedding provider key is invalid', () => {
    it('skips validation for huggingface (local)', () => {
      vi.mocked(loadConfig).mockReturnValue({
        default_provider: 'ollama',
        default_model: 'llama3.2',
        embedding: {
          provider: 'huggingface',
          model: 'bge-small',
          batch_size: 32,
        },
        search: { top_k: 10, rerank: false },
      });

      const result = validateStartupConfig();

      // Should not check for openai key when using huggingface
      expect(result.valid).toBe(true);
    });

    it('returns error for openai embedding without key', () => {
      vi.mocked(loadConfig).mockReturnValue({
        default_provider: 'ollama',
        default_model: 'llama3.2',
        embedding: {
          provider: 'openai',
          model: 'text-embedding-3-small',
          batch_size: 32,
        },
        search: { top_k: 10, rerank: false },
      });
      vi.mocked(hasApiKey).mockReturnValue(false);

      const result = validateStartupConfig();

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('OpenAI'))).toBe(true);
    });
  });

  describe('skip options', () => {
    it('skips LLM validation when skipLLM is true', () => {
      vi.mocked(loadConfig).mockReturnValue({
        default_provider: 'anthropic',
        default_model: 'claude-sonnet-4-20250514',
        embedding: {
          provider: 'huggingface',
          model: 'bge-small',
          batch_size: 32,
        },
        search: { top_k: 10, rerank: false },
      });
      vi.mocked(validateProviderKey).mockReturnValue({
        valid: false,
        error: 'Key not set',
        setupInstructions: 'Set it',
      });

      const result = validateStartupConfig({ skipLLM: true });

      // Even though key is invalid, we skipped validation
      expect(result.valid).toBe(true);
    });

    it('skips embedding validation when skipEmbedding is true', () => {
      vi.mocked(loadConfig).mockReturnValue({
        default_provider: 'ollama',
        default_model: 'llama3.2',
        embedding: {
          provider: 'openai',
          model: 'text-embedding-3-small',
          batch_size: 32,
        },
        search: { top_k: 10, rerank: false },
      });
      vi.mocked(hasApiKey).mockReturnValue(false);

      const result = validateStartupConfig({ skipEmbedding: true });

      // Even though openai key is missing, we skipped validation
      expect(result.valid).toBe(true);
    });
  });

  describe('when config cannot be loaded', () => {
    it('uses defaults and continues validation', () => {
      vi.mocked(loadConfig).mockImplementation(() => {
        throw new Error('Config file not found');
      });
      vi.mocked(validateProviderKey).mockReturnValue({ valid: true });

      // Should not throw, should use defaults
      const result = validateStartupConfig();

      expect(result).toBeDefined();
    });
  });
});

describe('getValidationOptionsForCommand', () => {
  it('requires LLM for ask command', () => {
    const options = getValidationOptionsForCommand('ask');
    expect(options.skipLLM).toBe(false);
  });

  it('requires LLM for chat command', () => {
    const options = getValidationOptionsForCommand('chat');
    expect(options.skipLLM).toBe(false);
  });

  it('requires embedding for index command', () => {
    const options = getValidationOptionsForCommand('index');
    expect(options.skipEmbedding).toBe(false);
  });

  it('skips both for list command', () => {
    const options = getValidationOptionsForCommand('list');
    expect(options.skipLLM).toBe(true);
    expect(options.skipEmbedding).toBe(true);
  });

  it('skips both for config command', () => {
    const options = getValidationOptionsForCommand('config');
    expect(options.skipLLM).toBe(true);
    expect(options.skipEmbedding).toBe(true);
  });
});

describe('command requirements', () => {
  it('COMMANDS_REQUIRING_LLM includes expected commands', () => {
    expect(COMMANDS_REQUIRING_LLM).toContain('ask');
    expect(COMMANDS_REQUIRING_LLM).toContain('chat');
    expect(COMMANDS_REQUIRING_LLM).not.toContain('list');
    expect(COMMANDS_REQUIRING_LLM).not.toContain('index');
  });

  it('COMMANDS_REQUIRING_EMBEDDING includes expected commands', () => {
    expect(COMMANDS_REQUIRING_EMBEDDING).toContain('index');
    expect(COMMANDS_REQUIRING_EMBEDDING).not.toContain('ask');
    expect(COMMANDS_REQUIRING_EMBEDDING).not.toContain('list');
  });
});
