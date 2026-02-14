import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Config } from '../../config/schema.js';
import { DEFAULT_CONFIG } from '../../config/defaults.js';

// Mock the langfuse-tracer module to avoid real OTel SDK initialization
vi.mock('../langfuse-tracer.js', () => ({
  createLangfuseTracer: vi.fn(() => ({
    trace: vi.fn(() => ({
      span: vi.fn(),
      generation: vi.fn(),
      update: vi.fn(),
      end: vi.fn(),
    })),
    flush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    isRemote: true,
  })),
}));

import { createTracer } from '../factory.js';
import { createLangfuseTracer } from '../langfuse-tracer.js';

describe('createTracer', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear Langfuse env vars
    delete process.env['LANGFUSE_PUBLIC_KEY'];
    delete process.env['LANGFUSE_SECRET_KEY'];
    delete process.env['LANGFUSE_BASE_URL'];
  });

  afterEach(() => {
    // Restore env
    process.env = { ...originalEnv };
  });

  function makeConfig(overrides: Partial<Config['observability']> = {}): Config {
    return {
      ...DEFAULT_CONFIG,
      observability: {
        ...DEFAULT_CONFIG.observability!,
        ...overrides,
      },
    };
  }

  describe('returns NoopTracer when', () => {
    it('observability is disabled', () => {
      const config = makeConfig({ enabled: false });
      const tracer = createTracer(config);
      expect(tracer.isRemote).toBe(false);
      expect(createLangfuseTracer).not.toHaveBeenCalled();
    });

    it('observability config is missing', () => {
      const config = { ...DEFAULT_CONFIG, observability: undefined } as Config;
      const tracer = createTracer(config);
      expect(tracer.isRemote).toBe(false);
    });

    it('no Langfuse keys in config or env', () => {
      const config = makeConfig({ enabled: true });
      const tracer = createTracer(config);
      expect(tracer.isRemote).toBe(false);
      expect(createLangfuseTracer).not.toHaveBeenCalled();
    });

    it('only public key is set (missing secret)', () => {
      const config = makeConfig({
        enabled: true,
        langfuse_public_key: 'pk-lf-test',
      });
      const tracer = createTracer(config);
      expect(tracer.isRemote).toBe(false);
    });

    it('only secret key is set (missing public)', () => {
      const config = makeConfig({
        enabled: true,
        langfuse_secret_key: 'sk-lf-test',
      });
      const tracer = createTracer(config);
      expect(tracer.isRemote).toBe(false);
    });
  });

  describe('returns LangfuseTracer when', () => {
    it('config has both keys', () => {
      const config = makeConfig({
        enabled: true,
        langfuse_public_key: 'pk-lf-test',
        langfuse_secret_key: 'sk-lf-test',
        langfuse_host: 'https://custom.langfuse.com',
      });
      const tracer = createTracer(config);
      expect(tracer.isRemote).toBe(true);
      expect(createLangfuseTracer).toHaveBeenCalledWith({
        publicKey: 'pk-lf-test',
        secretKey: 'sk-lf-test',
        baseUrl: 'https://custom.langfuse.com',
      });
    });

    it('env vars provide both keys', () => {
      process.env['LANGFUSE_PUBLIC_KEY'] = 'pk-lf-env';
      process.env['LANGFUSE_SECRET_KEY'] = 'sk-lf-env';
      const config = makeConfig({ enabled: true });
      const tracer = createTracer(config);
      expect(tracer.isRemote).toBe(true);
      expect(createLangfuseTracer).toHaveBeenCalledWith({
        publicKey: 'pk-lf-env',
        secretKey: 'sk-lf-env',
        baseUrl: 'https://cloud.langfuse.com',
      });
    });
  });

  describe('env var precedence', () => {
    it('env vars override config values', () => {
      process.env['LANGFUSE_PUBLIC_KEY'] = 'pk-lf-env';
      process.env['LANGFUSE_SECRET_KEY'] = 'sk-lf-env';
      const config = makeConfig({
        enabled: true,
        langfuse_public_key: 'pk-lf-config',
        langfuse_secret_key: 'sk-lf-config',
      });
      const tracer = createTracer(config);
      expect(tracer.isRemote).toBe(true);
      expect(createLangfuseTracer).toHaveBeenCalledWith(
        expect.objectContaining({
          publicKey: 'pk-lf-env',
          secretKey: 'sk-lf-env',
        }),
      );
    });

    it('LANGFUSE_BASE_URL overrides config langfuse_host', () => {
      process.env['LANGFUSE_PUBLIC_KEY'] = 'pk-lf-test';
      process.env['LANGFUSE_SECRET_KEY'] = 'sk-lf-test';
      process.env['LANGFUSE_BASE_URL'] = 'https://env.langfuse.com';
      const config = makeConfig({
        enabled: true,
        langfuse_host: 'https://config.langfuse.com',
      });
      createTracer(config);
      expect(createLangfuseTracer).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: 'https://env.langfuse.com',
        }),
      );
    });

    it('uses default host when neither env nor config provides one', () => {
      process.env['LANGFUSE_PUBLIC_KEY'] = 'pk-lf-test';
      process.env['LANGFUSE_SECRET_KEY'] = 'sk-lf-test';
      const config = makeConfig({ enabled: true });
      createTracer(config);
      expect(createLangfuseTracer).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: 'https://cloud.langfuse.com',
        }),
      );
    });
  });
});
