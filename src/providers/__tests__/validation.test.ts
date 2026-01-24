/**
 * API Key Validation Tests
 *
 * Tests for src/providers/validation.ts
 * Verifies key format validation and error messages.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  validateAnthropicKey,
  validateOpenAIKey,
  validateOllamaHost,
  validateProviderKey,
  getProviderKey,
  AnthropicKeySchema,
  OpenAIKeySchema,
  OllamaHostSchema,
} from '../validation.js';
import { _clearEnvCache } from '../../config/env.js';

describe('Anthropic Key Validation', () => {
  beforeEach(() => {
    _clearEnvCache();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    _clearEnvCache();
    vi.unstubAllEnvs();
  });

  it('accepts valid Anthropic key with sk-ant- prefix', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-abc123xyz');

    const result = validateAnthropicKey();

    expect(result.valid).toBe(true);
  });

  it('accepts older Anthropic key format', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-oldformat123');

    const result = validateAnthropicKey();

    expect(result.valid).toBe(true);
  });

  it('rejects key without sk-ant- prefix', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'wrong-prefix-key');

    const result = validateAnthropicKey();

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('sk-ant-');
      expect(result.setupInstructions).toContain('console.anthropic.com');
    }
  });

  it('returns setup instructions when key is missing', () => {
    const result = validateAnthropicKey();

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('not set');
      expect(result.setupInstructions).toContain('ANTHROPIC_API_KEY');
    }
  });

  it('rejects empty string key', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    const result = validateAnthropicKey();

    expect(result.valid).toBe(false);
  });
});

describe('OpenAI Key Validation', () => {
  beforeEach(() => {
    _clearEnvCache();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    _clearEnvCache();
    vi.unstubAllEnvs();
  });

  it('accepts valid OpenAI key with sk- prefix', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-abc123xyz789');

    const result = validateOpenAIKey();

    expect(result.valid).toBe(true);
  });

  it('accepts project-scoped OpenAI key', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-proj-abc123xyz');

    const result = validateOpenAIKey();

    expect(result.valid).toBe(true);
  });

  it('accepts service account OpenAI key', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-svcacct-abc123');

    const result = validateOpenAIKey();

    expect(result.valid).toBe(true);
  });

  it('rejects key without sk- prefix', () => {
    vi.stubEnv('OPENAI_API_KEY', 'not-an-openai-key');

    const result = validateOpenAIKey();

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('sk-');
    }
  });

  it('returns setup instructions when key is missing', () => {
    const result = validateOpenAIKey();

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('not set');
      expect(result.setupInstructions).toContain('platform.openai.com');
    }
  });
});

describe('Ollama Host Validation', () => {
  beforeEach(() => {
    _clearEnvCache();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    _clearEnvCache();
    vi.unstubAllEnvs();
  });

  it('accepts default localhost URL', () => {
    const result = validateOllamaHost();

    expect(result.valid).toBe(true);
  });

  it('accepts custom HTTP URL', () => {
    vi.stubEnv('OLLAMA_HOST', 'http://192.168.1.100:11434');

    const result = validateOllamaHost();

    expect(result.valid).toBe(true);
  });

  it('accepts HTTPS URL', () => {
    vi.stubEnv('OLLAMA_HOST', 'https://ollama.example.com');

    const result = validateOllamaHost();

    expect(result.valid).toBe(true);
  });

  it('accepts URL with port', () => {
    vi.stubEnv('OLLAMA_HOST', 'http://localhost:8080');

    const result = validateOllamaHost();

    expect(result.valid).toBe(true);
  });

  it('rejects non-URL values', () => {
    vi.stubEnv('OLLAMA_HOST', 'not-a-url');

    const result = validateOllamaHost();

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('URL');
    }
  });
});

describe('validateProviderKey()', () => {
  beforeEach(() => {
    _clearEnvCache();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    _clearEnvCache();
    vi.unstubAllEnvs();
  });

  it('validates anthropic provider', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-valid');

    const result = validateProviderKey('anthropic');

    expect(result.valid).toBe(true);
  });

  it('validates openai provider', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-valid');

    const result = validateProviderKey('openai');

    expect(result.valid).toBe(true);
  });

  it('validates ollama provider', () => {
    const result = validateProviderKey('ollama');

    expect(result.valid).toBe(true);
  });

  it('returns error for missing anthropic key', () => {
    const result = validateProviderKey('anthropic');

    expect(result.valid).toBe(false);
  });
});

describe('getProviderKey()', () => {
  beforeEach(() => {
    _clearEnvCache();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    _clearEnvCache();
    vi.unstubAllEnvs();
  });

  it('returns the key when valid', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-secret123');

    const key = getProviderKey('anthropic');

    expect(key).toBe('sk-ant-secret123');
  });

  it('throws when key is missing', () => {
    expect(() => getProviderKey('anthropic')).toThrow('not set');
  });

  it('throws when key format is invalid', () => {
    vi.stubEnv('OPENAI_API_KEY', 'invalid-format');

    expect(() => getProviderKey('openai')).toThrow('sk-');
  });
});

describe('Schema Validation (unit tests)', () => {
  describe('AnthropicKeySchema', () => {
    it('accepts valid key', () => {
      expect(AnthropicKeySchema.safeParse('sk-ant-test').success).toBe(true);
    });

    it('rejects empty string', () => {
      expect(AnthropicKeySchema.safeParse('').success).toBe(false);
    });

    it('rejects wrong prefix', () => {
      expect(AnthropicKeySchema.safeParse('sk-openai').success).toBe(false);
    });
  });

  describe('OpenAIKeySchema', () => {
    it('accepts sk- prefix', () => {
      expect(OpenAIKeySchema.safeParse('sk-test').success).toBe(true);
    });

    it('accepts sk-proj- prefix', () => {
      expect(OpenAIKeySchema.safeParse('sk-proj-test').success).toBe(true);
    });

    it('rejects wrong prefix', () => {
      expect(OpenAIKeySchema.safeParse('invalid').success).toBe(false);
    });
  });

  describe('OllamaHostSchema', () => {
    it('accepts http URL', () => {
      expect(OllamaHostSchema.safeParse('http://localhost:11434').success).toBe(true);
    });

    it('accepts https URL', () => {
      expect(OllamaHostSchema.safeParse('https://ollama.com').success).toBe(true);
    });

    it('rejects non-URL', () => {
      expect(OllamaHostSchema.safeParse('localhost:11434').success).toBe(false);
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

  it('error messages never contain the actual key', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'wrong-format-secret-key');

    const result = validateAnthropicKey();

    expect(result.valid).toBe(false);
    if (!result.valid) {
      // Error should NOT contain the key value
      expect(result.error).not.toContain('wrong-format-secret-key');
      // Error should contain helpful format info
      expect(result.error).toContain('sk-ant-');
    }
  });

  it('setup instructions never contain the actual key', () => {
    vi.stubEnv('OPENAI_API_KEY', 'my-secret-key-12345');

    const result = validateOpenAIKey();

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.setupInstructions).not.toContain('my-secret-key-12345');
    }
  });
});
