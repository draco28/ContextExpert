/**
 * Tests for Provider Configuration Storage
 *
 * Tests the CRUD operations and file I/O for ~/.ctx/providers.json
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadProviders,
  saveProviders,
  addProvider,
  removeProvider,
  setDefaultProvider,
  getProvider,
  getDefaultProvider,
  listProviders,
  hasProviders,
  type ProviderConfig,
  type ProvidersFile,
} from '../providers.js';
import * as paths from '../paths.js';

// ============================================================================
// Test Setup
// ============================================================================

describe('providers', () => {
  let tempDir: string;
  let providersPath: string;

  beforeEach(() => {
    // Create a temporary directory for each test
    tempDir = fs.mkdtempSync(path.join(tmpdir(), 'ctx-test-'));
    providersPath = path.join(tempDir, 'providers.json');

    // Mock the paths module to use our temp directory
    vi.spyOn(paths, 'getProvidersPath').mockReturnValue(providersPath);
    vi.spyOn(paths, 'getCtxDir').mockReturnValue(tempDir);
  });

  afterEach(() => {
    // Clean up temp directory
    vi.restoreAllMocks();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  // ==========================================================================
  // loadProviders
  // ==========================================================================

  describe('loadProviders', () => {
    it('returns empty config when file does not exist', () => {
      const result = loadProviders();
      expect(result).toEqual({ default: null, providers: {} });
    });

    it('loads valid providers file', () => {
      const data: ProvidersFile = {
        default: 'test-provider',
        providers: {
          'test-provider': {
            type: 'anthropic',
            model: 'claude-sonnet-4-20250514',
            apiKey: 'sk-ant-test',
          },
        },
      };
      fs.writeFileSync(providersPath, JSON.stringify(data));

      const result = loadProviders();
      expect(result).toEqual(data);
    });

    it('returns empty config for corrupted JSON', () => {
      fs.writeFileSync(providersPath, 'not valid json {{{');

      const result = loadProviders();
      expect(result).toEqual({ default: null, providers: {} });
    });

    it('returns empty config for invalid schema', () => {
      fs.writeFileSync(providersPath, JSON.stringify({ invalid: 'schema' }));

      const result = loadProviders();
      expect(result).toEqual({ default: null, providers: {} });
    });
  });

  // ==========================================================================
  // saveProviders
  // ==========================================================================

  describe('saveProviders', () => {
    it('creates directory if it does not exist', () => {
      // Remove the temp dir to test creation
      fs.rmSync(tempDir, { recursive: true });

      const data: ProvidersFile = { default: null, providers: {} };
      saveProviders(data);

      expect(fs.existsSync(tempDir)).toBe(true);
      expect(fs.existsSync(providersPath)).toBe(true);
    });

    it('writes valid JSON to file', () => {
      const data: ProvidersFile = {
        default: 'my-provider',
        providers: {
          'my-provider': {
            type: 'openai',
            model: 'gpt-4o',
            apiKey: 'sk-test',
          },
        },
      };

      saveProviders(data);

      const content = fs.readFileSync(providersPath, 'utf-8');
      expect(JSON.parse(content)).toEqual(data);
    });

    it('formats JSON with indentation', () => {
      const data: ProvidersFile = { default: null, providers: {} };
      saveProviders(data);

      const content = fs.readFileSync(providersPath, 'utf-8');
      expect(content).toContain('\n'); // Has newlines (formatted)
    });
  });

  // ==========================================================================
  // addProvider
  // ==========================================================================

  describe('addProvider', () => {
    it('adds a new provider', () => {
      const config: ProviderConfig = {
        type: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        apiKey: 'sk-ant-test',
      };

      addProvider('my-claude', config);

      const result = loadProviders();
      expect(result.providers['my-claude']).toEqual(config);
    });

    it('sets first provider as default', () => {
      const config: ProviderConfig = {
        type: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-test',
      };

      addProvider('first-provider', config);

      const result = loadProviders();
      expect(result.default).toBe('first-provider');
    });

    it('does not change default when adding second provider', () => {
      addProvider('first', { type: 'anthropic', model: 'claude', apiKey: 'key1' });
      addProvider('second', { type: 'openai', model: 'gpt-4', apiKey: 'key2' });

      const result = loadProviders();
      expect(result.default).toBe('first');
    });

    it('throws error for duplicate name', () => {
      addProvider('my-provider', { type: 'anthropic', model: 'claude', apiKey: 'key' });

      expect(() => {
        addProvider('my-provider', { type: 'openai', model: 'gpt-4', apiKey: 'key2' });
      }).toThrow('already exists');
    });

    it('supports openai-compatible type with baseURL', () => {
      const config: ProviderConfig = {
        type: 'openai-compatible',
        model: 'glm-4.7',
        baseURL: 'https://api.z.ai/api/coding/paas/v4',
        apiKey: 'sk-zai-test',
      };

      addProvider('z-ai', config);

      const result = loadProviders();
      expect(result.providers['z-ai']).toEqual(config);
    });
  });

  // ==========================================================================
  // removeProvider
  // ==========================================================================

  describe('removeProvider', () => {
    beforeEach(() => {
      addProvider('provider1', { type: 'anthropic', model: 'claude', apiKey: 'key1' });
      addProvider('provider2', { type: 'openai', model: 'gpt-4', apiKey: 'key2' });
    });

    it('removes an existing provider', () => {
      removeProvider('provider2');

      const result = loadProviders();
      expect(result.providers['provider2']).toBeUndefined();
      expect(result.providers['provider1']).toBeDefined();
    });

    it('reassigns default when removing default provider', () => {
      // provider1 is default (first added)
      removeProvider('provider1');

      const result = loadProviders();
      expect(result.default).toBe('provider2');
    });

    it('sets default to null when removing last provider', () => {
      removeProvider('provider1');
      removeProvider('provider2');

      const result = loadProviders();
      expect(result.default).toBeNull();
    });

    it('throws error for non-existent provider', () => {
      expect(() => {
        removeProvider('non-existent');
      }).toThrow('not found');
    });
  });

  // ==========================================================================
  // setDefaultProvider
  // ==========================================================================

  describe('setDefaultProvider', () => {
    beforeEach(() => {
      addProvider('provider1', { type: 'anthropic', model: 'claude', apiKey: 'key1' });
      addProvider('provider2', { type: 'openai', model: 'gpt-4', apiKey: 'key2' });
    });

    it('sets a new default provider', () => {
      setDefaultProvider('provider2');

      const result = loadProviders();
      expect(result.default).toBe('provider2');
    });

    it('throws error for non-existent provider', () => {
      expect(() => {
        setDefaultProvider('non-existent');
      }).toThrow('not found');
    });
  });

  // ==========================================================================
  // getProvider
  // ==========================================================================

  describe('getProvider', () => {
    it('returns provider config by name', () => {
      const config: ProviderConfig = {
        type: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        apiKey: 'sk-ant-test',
      };
      addProvider('my-claude', config);

      const result = getProvider('my-claude');
      expect(result).toEqual(config);
    });

    it('returns undefined for non-existent provider', () => {
      const result = getProvider('non-existent');
      expect(result).toBeUndefined();
    });
  });

  // ==========================================================================
  // getDefaultProvider
  // ==========================================================================

  describe('getDefaultProvider', () => {
    it('returns null when no providers exist', () => {
      const result = getDefaultProvider();
      expect(result).toBeNull();
    });

    it('returns default provider with name and config', () => {
      const config: ProviderConfig = {
        type: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-test',
      };
      addProvider('my-gpt', config);

      const result = getDefaultProvider();
      expect(result).toEqual({ name: 'my-gpt', config });
    });

    it('returns null if default points to missing provider', () => {
      // Manually create an invalid state
      const data: ProvidersFile = {
        default: 'missing',
        providers: {},
      };
      saveProviders(data);

      const result = getDefaultProvider();
      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // listProviders
  // ==========================================================================

  describe('listProviders', () => {
    it('returns empty array when no providers exist', () => {
      const result = listProviders();
      expect(result).toEqual([]);
    });

    it('returns all providers with isDefault flag', () => {
      addProvider('provider1', { type: 'anthropic', model: 'claude', apiKey: 'key1' });
      addProvider('provider2', { type: 'openai', model: 'gpt-4', apiKey: 'key2' });

      const result = listProviders();
      expect(result).toHaveLength(2);

      const p1 = result.find((p) => p.name === 'provider1');
      const p2 = result.find((p) => p.name === 'provider2');

      expect(p1?.isDefault).toBe(true);
      expect(p2?.isDefault).toBe(false);
    });
  });

  // ==========================================================================
  // hasProviders
  // ==========================================================================

  describe('hasProviders', () => {
    it('returns false when no providers exist', () => {
      expect(hasProviders()).toBe(false);
    });

    it('returns true when providers exist', () => {
      addProvider('test', { type: 'anthropic', model: 'claude', apiKey: 'key' });
      expect(hasProviders()).toBe(true);
    });
  });
});
