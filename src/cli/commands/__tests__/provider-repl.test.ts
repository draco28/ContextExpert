/**
 * Tests for Provider REPL Commands
 *
 * Tests the /provider command handlers and provider creation from config.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderConfig } from '../../../config/providers.js';
import type { CommandContext } from '../../types.js';
import type { ChatState } from '../chat.js';

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

// Mock the providers config module
vi.mock('../../../config/providers.js', () => ({
  loadProviders: vi.fn(),
  listProviders: vi.fn(),
  getProvider: vi.fn(),
  removeProvider: vi.fn(),
  setDefaultProvider: vi.fn(),
  addProvider: vi.fn(),
}));

// Track ora spinner output for testing
let spinnerOutput: string[] = [];
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn((msg: string) => {
      spinnerOutput.push(`SUCCESS: ${msg}`);
    }),
    fail: vi.fn((msg: string) => {
      spinnerOutput.push(`FAIL: ${msg}`);
    }),
  })),
}));

// Import after mocks are set up
import { createProviderFromConfig, handleProviderCommand } from '../provider-repl.js';
import { createAnthropicProvider } from '../../../providers/anthropic.js';
import { createOpenAIProvider } from '../../../providers/openai.js';
import * as providersConfig from '../../../config/providers.js';

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

  // ==========================================================================
  // handleProviderCommand - Command Handler Tests
  // ==========================================================================

  describe('handleProviderCommand', () => {
    let mockState: ChatState;
    let mockCtx: CommandContext;
    let logOutput: string[];

    beforeEach(() => {
      logOutput = [];
      spinnerOutput = []; // Reset spinner output
      mockCtx = {
        options: { verbose: false, json: false },
        log: (msg: string) => logOutput.push(msg),
        error: (msg: string) => logOutput.push(`ERROR: ${msg}`),
        debug: vi.fn(),
      };

      // Create async generator for streamChat mock
      async function* mockStreamGenerator() {
        yield { type: 'text', content: 'OK' };
        yield { type: 'done' };
      }

      mockState = {
        currentProject: null,
        conversationContext: { clear: vi.fn(), getMessages: vi.fn(), addMessage: vi.fn(), truncate: vi.fn() } as any,
        ragEngine: null,
        llmProvider: {
          streamChat: vi.fn().mockReturnValue(mockStreamGenerator()),
        },
        providerInfo: { name: 'test-provider', model: 'test-model' },
        config: {} as any,
      };
    });

    describe('/provider list', () => {
      it('shows message when no providers configured', async () => {
        vi.mocked(providersConfig.listProviders).mockReturnValue([]);

        const result = await handleProviderCommand(['list'], mockState, mockCtx);

        expect(result).toBe(true); // Continue REPL
        expect(logOutput.join('\n')).toContain('No providers configured');
      });

      it('lists configured providers with default marker', async () => {
        vi.mocked(providersConfig.listProviders).mockReturnValue([
          {
            name: 'my-claude',
            config: { type: 'anthropic', model: 'claude-sonnet-4-20250514', apiKey: 'key1' },
            isDefault: true,
          },
          {
            name: 'my-gpt',
            config: { type: 'openai', model: 'gpt-4o', apiKey: 'key2' },
            isDefault: false,
          },
        ]);

        await handleProviderCommand(['list'], mockState, mockCtx);

        const output = logOutput.join('\n');
        expect(output).toContain('my-claude');
        expect(output).toContain('my-gpt');
        expect(output).toContain('default');
      });

      it('shows openai-compatible baseURL', async () => {
        vi.mocked(providersConfig.listProviders).mockReturnValue([
          {
            name: 'z-ai',
            config: {
              type: 'openai-compatible',
              model: 'glm-4.7',
              baseURL: 'https://api.z.ai/v4',
              apiKey: 'key',
            },
            isDefault: true,
          },
        ]);

        await handleProviderCommand(['list'], mockState, mockCtx);

        expect(logOutput.join('\n')).toContain('https://api.z.ai/v4');
      });
    });

    describe('/provider help', () => {
      it('shows help text with all subcommands', async () => {
        const result = await handleProviderCommand(['help'], mockState, mockCtx);

        expect(result).toBe(true);
        const output = logOutput.join('\n');
        expect(output).toContain('/provider add');
        expect(output).toContain('/provider list');
        expect(output).toContain('/provider use');
        expect(output).toContain('/provider remove');
        expect(output).toContain('/provider test');
      });

      it('shows help for unknown subcommand', async () => {
        await handleProviderCommand(['unknown'], mockState, mockCtx);

        const output = logOutput.join('\n');
        expect(output).toContain('/provider add');
      });
    });

    describe('/provider use', () => {
      it('shows usage when no name provided', async () => {
        await handleProviderCommand(['use'], mockState, mockCtx);

        expect(logOutput.join('\n')).toContain('Usage: /provider use');
      });

      it('shows error when provider not found', async () => {
        vi.mocked(providersConfig.getProvider).mockReturnValue(undefined);

        await handleProviderCommand(['use', 'nonexistent'], mockState, mockCtx);

        expect(logOutput.join('\n')).toContain('not found');
      });

      it('switches to provider and updates state', async () => {
        vi.mocked(providersConfig.getProvider).mockReturnValue({
          type: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          apiKey: 'key',
        });

        await handleProviderCommand(['use', 'my-claude'], mockState, mockCtx);

        expect(providersConfig.setDefaultProvider).toHaveBeenCalledWith('my-claude');
        expect(mockState.providerInfo.name).toBe('my-claude');
      });
    });

    describe('/provider remove', () => {
      it('shows usage when no name provided', async () => {
        await handleProviderCommand(['remove'], mockState, mockCtx);

        expect(logOutput.join('\n')).toContain('Usage: /provider remove');
      });

      it('shows error when provider not found', async () => {
        vi.mocked(providersConfig.getProvider).mockReturnValue(undefined);

        await handleProviderCommand(['remove', 'nonexistent'], mockState, mockCtx);

        expect(logOutput.join('\n')).toContain('not found');
      });

      it('removes provider and shows confirmation', async () => {
        vi.mocked(providersConfig.getProvider).mockReturnValue({
          type: 'openai',
          model: 'gpt-4o',
          apiKey: 'key',
        });
        vi.mocked(providersConfig.loadProviders).mockReturnValue({
          default: null,
          providers: {},
        });

        await handleProviderCommand(['remove', 'my-gpt'], mockState, mockCtx);

        expect(providersConfig.removeProvider).toHaveBeenCalledWith('my-gpt');
        expect(logOutput.join('\n')).toContain('removed');
      });

      it('warns when removing active provider', async () => {
        mockState.providerInfo.name = 'active-provider';
        vi.mocked(providersConfig.getProvider).mockReturnValue({
          type: 'openai',
          model: 'gpt-4o',
          apiKey: 'key',
        });
        vi.mocked(providersConfig.loadProviders).mockReturnValue({
          default: null,
          providers: {},
        });

        await handleProviderCommand(['remove', 'active-provider'], mockState, mockCtx);

        expect(logOutput.join('\n')).toContain('currently active');
      });
    });

    describe('/provider test', () => {
      it('accepts text chunk as valid response', async () => {
        async function* textGenerator() {
          yield { type: 'text', content: 'OK' };
        }
        mockState.llmProvider.streamChat = vi.fn().mockReturnValue(textGenerator());

        await handleProviderCommand(['test'], mockState, mockCtx);

        expect(spinnerOutput.join('\n')).toContain('working');
      });

      it('accepts content chunk as valid response', async () => {
        async function* contentGenerator() {
          yield { type: 'content', content: 'OK' };
        }
        mockState.llmProvider.streamChat = vi.fn().mockReturnValue(contentGenerator());

        await handleProviderCommand(['test'], mockState, mockCtx);

        expect(spinnerOutput.join('\n')).toContain('working');
      });

      it('accepts usage chunk as valid response (Z.AI compatibility)', async () => {
        async function* usageGenerator() {
          yield { type: 'usage', usage: { totalTokens: 5 } };
        }
        mockState.llmProvider.streamChat = vi.fn().mockReturnValue(usageGenerator());

        await handleProviderCommand(['test'], mockState, mockCtx);

        expect(spinnerOutput.join('\n')).toContain('working');
      });

      it('accepts done chunk as valid response', async () => {
        async function* doneGenerator() {
          yield { type: 'done' };
        }
        mockState.llmProvider.streamChat = vi.fn().mockReturnValue(doneGenerator());

        await handleProviderCommand(['test'], mockState, mockCtx);

        expect(spinnerOutput.join('\n')).toContain('working');
      });

      it('shows error on API failure', async () => {
        mockState.llmProvider.streamChat = vi.fn().mockImplementation(() => {
          throw new Error('API key invalid');
        });

        await handleProviderCommand(['test'], mockState, mockCtx);

        expect(spinnerOutput.join('\n')).toContain('API key invalid');
      });
    });

    describe('subcommand aliases', () => {
      it('recognizes "ls" as alias for "list"', async () => {
        vi.mocked(providersConfig.listProviders).mockReturnValue([]);

        await handleProviderCommand(['ls'], mockState, mockCtx);

        expect(logOutput.join('\n')).toContain('No providers configured');
      });

      it('recognizes "rm" as alias for "remove"', async () => {
        await handleProviderCommand(['rm'], mockState, mockCtx);

        expect(logOutput.join('\n')).toContain('Usage: /provider remove');
      });

      it('recognizes "switch" as alias for "use"', async () => {
        await handleProviderCommand(['switch'], mockState, mockCtx);

        expect(logOutput.join('\n')).toContain('Usage: /provider use');
      });
    });
  });
});
