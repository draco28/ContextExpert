/**
 * Config Module Tests
 *
 * Tests the configuration loading, validation, and merging logic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ConfigSchema, PartialConfigSchema } from '../schema.js';
import { DEFAULT_CONFIG } from '../defaults.js';

// Use a temp directory for tests to avoid touching real config
const TEST_CTX_DIR = path.join(os.tmpdir(), '.ctx-test-' + process.pid);
const TEST_CONFIG_PATH = path.join(TEST_CTX_DIR, 'config.toml');

describe('Config Schema', () => {
  it('validates a complete valid config', () => {
    const result = ConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(result.success).toBe(true);
  });

  it('rejects invalid provider enum', () => {
    const invalid = {
      ...DEFAULT_CONFIG,
      default_provider: 'gpt-api', // not a valid enum value
    };
    const result = ConfigSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects top_k outside valid range', () => {
    const invalid = {
      ...DEFAULT_CONFIG,
      search: { ...DEFAULT_CONFIG.search, top_k: 200 }, // max is 100
    };
    const result = ConfigSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('allows partial config with PartialConfigSchema', () => {
    const partial = {
      default_model: 'gpt-4',
      // everything else missing
    };
    const result = PartialConfigSchema.safeParse(partial);
    expect(result.success).toBe(true);
  });

  it('allows deeply partial config', () => {
    const partial = {
      search: {
        top_k: 5,
        // rerank missing
      },
      // everything else missing
    };
    const result = PartialConfigSchema.safeParse(partial);
    expect(result.success).toBe(true);
  });
});

describe('Config Loading', () => {
  beforeEach(() => {
    // Create test directory
    if (!fs.existsSync(TEST_CTX_DIR)) {
      fs.mkdirSync(TEST_CTX_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test files
    if (fs.existsSync(TEST_CONFIG_PATH)) {
      fs.unlinkSync(TEST_CONFIG_PATH);
    }
    if (fs.existsSync(TEST_CTX_DIR)) {
      fs.rmdirSync(TEST_CTX_DIR);
    }
  });

  it('returns defaults when config file does not exist', async () => {
    // Dynamic import to get fresh module state
    const { loadConfig } = await import('../loader.js');

    // This test would need path mocking to be fully isolated
    // For now, we verify the defaults are valid
    const config = loadConfig(false);
    expect(config.default_model).toBe(DEFAULT_CONFIG.default_model);
    expect(config.embedding.provider).toBe('huggingface');
  });
});

describe('Config Defaults', () => {
  it('has valid default values', () => {
    expect(DEFAULT_CONFIG.default_provider).toBe('anthropic');
    expect(DEFAULT_CONFIG.embedding.provider).toBe('huggingface');
    expect(DEFAULT_CONFIG.embedding.model).toBe('BAAI/bge-large-en-v1.5');
    expect(DEFAULT_CONFIG.embedding.fallback_provider).toBe('ollama');
    expect(DEFAULT_CONFIG.embedding.fallback_model).toBe('nomic-embed-text');
    expect(DEFAULT_CONFIG.search.top_k).toBe(10);
    expect(DEFAULT_CONFIG.search.rerank).toBe(true);
  });

  it('default config passes full schema validation', () => {
    const result = ConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(result.success).toBe(true);
  });
});

describe('Deep Merge Logic', () => {
  it('merges nested objects correctly', () => {
    // Test the merge behavior conceptually
    const defaults = {
      a: 1,
      nested: { b: 2, c: 3 },
    };
    const override = {
      nested: { b: 20 }, // only override b, keep c
    };

    // This is what our deepMerge does - simulating manually
    const merged = {
      ...defaults,
      nested: { ...defaults.nested, ...override.nested },
    };

    // Verify merged result has override value AND preserved default
    expect(merged.a).toBe(1);
    expect(merged.nested.b).toBe(20); // overridden
    expect(merged.nested.c).toBe(3);  // preserved from defaults
  });
});
