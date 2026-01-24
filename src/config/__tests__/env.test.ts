/**
 * Environment Variable Handler Tests
 *
 * Tests for src/config/env.ts
 * Uses vi.stubEnv() for safe environment variable mocking.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadEnv, getEnv, hasApiKey, getOllamaHost, _clearEnvCache } from '../env.js';

describe('Environment Variable Loading', () => {
  beforeEach(() => {
    _clearEnvCache();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    _clearEnvCache();
    vi.unstubAllEnvs();
  });

  describe('loadEnv()', () => {
    it('loads ANTHROPIC_API_KEY when set', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-key');

      const env = loadEnv();

      expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test-key');
    });

    it('loads OPENAI_API_KEY when set', () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-test-openai-key');

      const env = loadEnv();

      expect(env.OPENAI_API_KEY).toBe('sk-test-openai-key');
    });

    it('returns undefined for missing optional keys', () => {
      const env = loadEnv();

      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
    });

    it('provides default OLLAMA_HOST when not set', () => {
      const env = loadEnv();

      expect(env.OLLAMA_HOST).toBe('http://localhost:11434');
    });

    it('uses custom OLLAMA_HOST when set', () => {
      vi.stubEnv('OLLAMA_HOST', 'http://192.168.1.100:11434');

      const env = loadEnv();

      expect(env.OLLAMA_HOST).toBe('http://192.168.1.100:11434');
    });

    it('caches environment variables after first load', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'initial-value');
      loadEnv(); // First load, caches the value

      // Change the env var (simulating external change)
      vi.stubEnv('ANTHROPIC_API_KEY', 'changed-value');
      const env = loadEnv(); // Should return cached value

      expect(env.ANTHROPIC_API_KEY).toBe('initial-value');
    });

    it('returns fresh values after cache is cleared', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'initial-value');
      loadEnv();

      _clearEnvCache();
      vi.stubEnv('ANTHROPIC_API_KEY', 'new-value');
      const env = loadEnv();

      expect(env.ANTHROPIC_API_KEY).toBe('new-value');
    });
  });

  describe('getEnv()', () => {
    it('returns the value for a specific key', () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-test');

      expect(getEnv('OPENAI_API_KEY')).toBe('sk-test');
    });

    it('returns undefined for unset optional keys', () => {
      expect(getEnv('ANTHROPIC_API_KEY')).toBeUndefined();
    });

    it('returns default for OLLAMA_HOST when unset', () => {
      expect(getEnv('OLLAMA_HOST')).toBe('http://localhost:11434');
    });
  });

  describe('hasApiKey()', () => {
    it('returns true when anthropic key exists', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');

      expect(hasApiKey('anthropic')).toBe(true);
    });

    it('returns true when openai key exists', () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-test');

      expect(hasApiKey('openai')).toBe(true);
    });

    it('returns false when key is missing', () => {
      expect(hasApiKey('anthropic')).toBe(false);
      expect(hasApiKey('openai')).toBe(false);
    });

    it('returns false when key is empty string', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');

      expect(hasApiKey('anthropic')).toBe(false);
    });

    it('returns false when key is only whitespace', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '   ');

      expect(hasApiKey('anthropic')).toBe(false);
    });
  });

  describe('getOllamaHost()', () => {
    it('returns default host when not configured', () => {
      expect(getOllamaHost()).toBe('http://localhost:11434');
    });

    it('returns custom host when configured', () => {
      vi.stubEnv('OLLAMA_HOST', 'https://ollama.example.com');

      expect(getOllamaHost()).toBe('https://ollama.example.com');
    });
  });
});

describe('Security', () => {
  beforeEach(() => {
    _clearEnvCache();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    _clearEnvCache();
    vi.unstubAllEnvs();
  });

  it('hasApiKey never exposes the actual key value', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-secret-key-12345');

    // The function only returns boolean, never the key
    const result = hasApiKey('anthropic');

    expect(typeof result).toBe('boolean');
    expect(result).toBe(true);
    // The key value is never in the result
  });
});
