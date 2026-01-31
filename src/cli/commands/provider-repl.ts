/**
 * Provider REPL Commands
 *
 * Handles /provider subcommands within the chat REPL:
 * - /provider add      - Interactive wizard to configure a new provider
 * - /provider list     - Show all configured providers
 * - /provider use      - Switch to a different provider
 * - /provider remove   - Delete a provider configuration
 * - /provider test     - Test current provider connectivity
 *
 * The wizard flow:
 * 1. Select provider type (anthropic, openai, openai-compatible)
 * 2. Enter provider name
 * 3. Enter base URL (openai-compatible only)
 * 4. Enter model
 * 5. Enter API key
 * 6. Test connection
 * 7. Save on success
 */

import * as readline from 'node:readline';
import chalk from 'chalk';
import ora from 'ora';
import type { CommandContext } from '../types.js';
import type { ChatState } from './chat.js';
import {
  loadProviders,
  addProvider,
  removeProvider,
  setDefaultProvider,
  getProvider,
  listProviders,
  type ProviderConfig,
  type ConfiguredProviderType,
} from '../../config/providers.js';
import {
  createOpenAIProvider,
  DEFAULT_OPENAI_MODEL,
} from '../../providers/openai.js';
import {
  createAnthropicProvider,
  DEFAULT_ANTHROPIC_MODEL,
} from '../../providers/anthropic.js';
import type { LLMProvider } from '@contextaisdk/core';

// ============================================================================
// TYPES
// ============================================================================

/** Result from a provider subcommand */
interface ProviderCommandResult {
  /** Whether the command was handled (always true for valid commands) */
  handled: boolean;
  /** If true, the chat state's provider was updated */
  providerUpdated?: boolean;
}

/** Provider type options for the wizard */
const PROVIDER_TYPES: ConfiguredProviderType[] = [
  'anthropic',
  'openai',
  'openai-compatible',
];

// ============================================================================
// READLINE PROMPT HELPERS
// ============================================================================

/**
 * Prompt for user input with optional default value.
 * Returns a promise that resolves with the user's input.
 */
function prompt(
  rl: readline.Interface,
  question: string,
  defaultValue?: string
): Promise<string> {
  return new Promise((resolve) => {
    const displayQuestion = defaultValue
      ? `${question} [${defaultValue}]: `
      : `${question}: `;

    rl.question(displayQuestion, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/**
 * Prompt for selection from a numbered list.
 * Returns the selected option.
 */
function promptSelect<T extends string>(
  rl: readline.Interface,
  question: string,
  options: T[]
): Promise<T> {
  return new Promise((resolve) => {
    console.log(question);
    options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));

    rl.question('Enter number: ', (answer) => {
      const idx = parseInt(answer.trim(), 10) - 1;
      if (idx >= 0 && idx < options.length) {
        resolve(options[idx]!);
      } else {
        // Default to first option if invalid
        resolve(options[0]!);
      }
    });
  });
}

// ============================================================================
// PROVIDER CREATION FROM CONFIG
// ============================================================================

/**
 * Create an LLM provider instance from a stored ProviderConfig.
 * This bypasses environment variable lookup by passing the apiKey directly.
 *
 * @param name - Provider name (for display purposes)
 * @param config - Stored provider configuration
 * @returns Object with provider instance and metadata
 */
export async function createProviderFromConfig(
  name: string,
  config: ProviderConfig
): Promise<{ provider: LLMProvider; displayName: string; model: string }> {
  switch (config.type) {
    case 'anthropic': {
      const result = await createAnthropicProvider({
        model: config.model,
        apiKey: config.apiKey,
        skipAvailabilityCheck: true, // We'll test separately if needed
      });
      return {
        provider: result.provider,
        displayName: name,
        model: result.model,
      };
    }

    case 'openai': {
      const result = await createOpenAIProvider({
        model: config.model,
        apiKey: config.apiKey,
        skipAvailabilityCheck: true,
      });
      return {
        provider: result.provider,
        displayName: name,
        model: result.model,
      };
    }

    case 'openai-compatible': {
      // OpenAI-compatible uses OpenAI provider with custom baseURL
      const result = await createOpenAIProvider({
        model: config.model,
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        skipAvailabilityCheck: true,
      });
      return {
        provider: result.provider,
        displayName: name,
        model: result.model,
      };
    }

    default: {
      // TypeScript exhaustiveness check
      const _exhaustive: never = config;
      throw new Error(`Unknown provider type: ${(_exhaustive as ProviderConfig).type}`);
    }
  }
}

// ============================================================================
// SUBCOMMAND HANDLERS
// ============================================================================

/**
 * /provider add - Interactive wizard to add a new provider.
 *
 * Flow:
 * 1. Select type (anthropic, openai, openai-compatible)
 * 2. Enter name
 * 3. Enter base URL (openai-compatible only)
 * 4. Enter model
 * 5. Enter API key
 * 6. Test connection
 * 7. Save on success
 */
async function handleProviderAdd(
  state: ChatState,
  ctx: CommandContext
): Promise<ProviderCommandResult> {
  const rl = state.rl;
  if (!rl) {
    ctx.error('Cannot run interactive wizard without readline interface');
    return { handled: true };
  }

  ctx.log('');
  ctx.log(chalk.bold('Add New LLM Provider'));
  ctx.log('');

  // Step 1: Select provider type
  const providerType = await promptSelect(
    rl,
    'Select provider type:',
    PROVIDER_TYPES
  );

  // Step 2: Provider name
  const defaultName =
    providerType === 'openai-compatible' ? 'my-provider' : providerType;
  const name = await prompt(rl, 'Provider name', defaultName);

  // Check if name already exists
  const existing = getProvider(name);
  if (existing) {
    ctx.error(`Provider "${name}" already exists.`);
    ctx.log(chalk.dim('Choose a different name or use /provider remove first.'));
    return { handled: true };
  }

  // Step 3: Base URL (openai-compatible only)
  let baseURL: string | undefined;
  if (providerType === 'openai-compatible') {
    baseURL = await prompt(rl, 'API Base URL');
    if (!baseURL) {
      ctx.error('Base URL is required for openai-compatible providers.');
      return { handled: true };
    }
    // Basic URL validation
    try {
      new URL(baseURL);
    } catch {
      ctx.error('Invalid URL format.');
      return { handled: true };
    }
  }

  // Step 4: Model
  let defaultModel = '';
  switch (providerType) {
    case 'anthropic':
      defaultModel = DEFAULT_ANTHROPIC_MODEL;
      break;
    case 'openai':
      defaultModel = DEFAULT_OPENAI_MODEL;
      break;
    case 'openai-compatible':
      defaultModel = ''; // No sensible default for custom APIs
      break;
  }
  const model = await prompt(rl, 'Model', defaultModel);
  if (!model) {
    ctx.error('Model is required.');
    return { handled: true };
  }

  // Step 5: API Key
  const apiKey = await prompt(rl, 'API Key');
  if (!apiKey) {
    ctx.error('API key is required.');
    return { handled: true };
  }

  // Step 6: Build config and test connection
  let config: ProviderConfig;
  switch (providerType) {
    case 'anthropic':
      config = { type: 'anthropic', model, apiKey };
      break;
    case 'openai':
      config = { type: 'openai', model, apiKey };
      break;
    case 'openai-compatible':
      config = { type: 'openai-compatible', model, apiKey, baseURL: baseURL! };
      break;
  }

  // Test the connection
  const spinner = ora({
    text: 'Testing connection...',
    color: 'cyan',
  }).start();

  try {
    const { provider } = await createProviderFromConfig(name, config);

    // Send a minimal test request
    const stream = provider.streamChat(
      [{ role: 'user', content: 'Say "OK" and nothing else.' }],
      { maxTokens: 10 }
    );

    let gotResponse = false;
    for await (const chunk of stream) {
      if (chunk.type === 'text' && chunk.content) {
        gotResponse = true;
        break;
      }
    }

    if (!gotResponse) {
      spinner.fail('Provider responded but returned no content.');
      ctx.log(chalk.dim('Check the model name and API key.'));
      return { handled: true };
    }

    spinner.succeed('Connection successful!');
  } catch (error) {
    spinner.fail(
      `Connection failed: ${error instanceof Error ? error.message : String(error)}`
    );
    ctx.log(chalk.dim('Check your API key, base URL, and model name.'));
    return { handled: true };
  }

  // Step 7: Save the provider
  try {
    addProvider(name, config);
    ctx.log('');
    ctx.log(chalk.green(`✓ Provider "${name}" configured successfully!`));

    // Check if it became the default
    const providers = loadProviders();
    if (providers.default === name) {
      ctx.log(chalk.dim('  (set as default provider)'));
    }
    ctx.log('');
  } catch (error) {
    ctx.error(
      `Failed to save provider: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return { handled: true };
}

/**
 * /provider list - Show all configured providers.
 */
async function handleProviderList(
  _state: ChatState,
  ctx: CommandContext
): Promise<ProviderCommandResult> {
  const providers = listProviders();

  ctx.log('');
  if (providers.length === 0) {
    ctx.log(chalk.yellow('No providers configured.'));
    ctx.log(chalk.dim('Run /provider add to add one.'));
  } else {
    ctx.log(chalk.bold('Configured Providers:'));
    ctx.log('');
    for (const { name, config, isDefault } of providers) {
      const defaultMarker = isDefault ? chalk.green(' (default)') : '';
      const typeLabel =
        config.type === 'openai-compatible'
          ? `openai-compatible @ ${config.baseURL}`
          : config.type;

      ctx.log(`  ${chalk.cyan(name)}${defaultMarker}`);
      ctx.log(`    Type: ${typeLabel}`);
      ctx.log(`    Model: ${config.model}`);
    }
  }
  ctx.log('');

  return { handled: true };
}

/**
 * /provider use <name> - Switch to a different provider.
 * Also sets it as the new default.
 */
async function handleProviderUse(
  args: string[],
  state: ChatState,
  ctx: CommandContext
): Promise<ProviderCommandResult> {
  if (args.length === 0) {
    ctx.log(chalk.yellow('Usage: /provider use <name>'));
    ctx.log(chalk.dim('Run /provider list to see available providers.'));
    return { handled: true };
  }

  const name = args.join(' ');
  const config = getProvider(name);

  if (!config) {
    ctx.error(`Provider "${name}" not found.`);
    ctx.log(chalk.dim('Run /provider list to see available providers.'));
    return { handled: true };
  }

  // Create the new provider
  const spinner = ora({
    text: `Switching to ${name}...`,
    color: 'cyan',
  }).start();

  try {
    const result = await createProviderFromConfig(name, config);

    // Update ChatState with the new provider
    state.llmProvider = result.provider;
    state.providerInfo = { name: result.displayName, model: result.model };

    // Set as new default
    setDefaultProvider(name);

    spinner.succeed(`Switched to ${chalk.cyan(name)} (${config.model})`);

    return { handled: true, providerUpdated: true };
  } catch (error) {
    spinner.fail(
      `Failed to switch: ${error instanceof Error ? error.message : String(error)}`
    );
    return { handled: true };
  }
}

/**
 * /provider remove <name> - Delete a provider configuration.
 */
async function handleProviderRemove(
  args: string[],
  state: ChatState,
  ctx: CommandContext
): Promise<ProviderCommandResult> {
  if (args.length === 0) {
    ctx.log(chalk.yellow('Usage: /provider remove <name>'));
    return { handled: true };
  }

  const name = args.join(' ');

  // Check if it exists
  const config = getProvider(name);
  if (!config) {
    ctx.error(`Provider "${name}" not found.`);
    return { handled: true };
  }

  // Warn if removing the currently active provider
  if (state.providerInfo.name === name) {
    ctx.log(
      chalk.yellow(
        `Warning: "${name}" is currently active. Restart chat to use a different provider.`
      )
    );
  }

  try {
    removeProvider(name);
    ctx.log(chalk.green(`✓ Provider "${name}" removed.`));

    // Show new default if applicable
    const providers = loadProviders();
    if (providers.default) {
      ctx.log(chalk.dim(`  New default: ${providers.default}`));
    }
  } catch (error) {
    ctx.error(
      `Failed to remove: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return { handled: true };
}

/**
 * /provider test - Test the current provider connectivity.
 */
async function handleProviderTest(
  state: ChatState,
  _ctx: CommandContext
): Promise<ProviderCommandResult> {
  const { name, model } = state.providerInfo;

  const spinner = ora({
    text: `Testing ${name}/${model}...`,
    color: 'cyan',
  }).start();

  try {
    // Send a minimal test request
    const stream = state.llmProvider.streamChat(
      [{ role: 'user', content: 'Say "OK" and nothing else.' }],
      { maxTokens: 10 }
    );

    let gotResponse = false;
    for await (const chunk of stream) {
      if (chunk.type === 'text' && chunk.content) {
        gotResponse = true;
        break;
      }
    }

    if (gotResponse) {
      spinner.succeed(chalk.green(`Provider ${name} is working.`));
    } else {
      spinner.fail(chalk.yellow('Provider responded but returned no content.'));
    }
  } catch (error) {
    spinner.fail(
      `Test failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return { handled: true };
}

/**
 * /provider help - Show subcommand help.
 */
async function handleProviderHelp(
  _state: ChatState,
  ctx: CommandContext
): Promise<ProviderCommandResult> {
  ctx.log('');
  ctx.log(chalk.bold('Provider Commands:'));
  ctx.log('');
  ctx.log(
    `  ${chalk.green('/provider add')}           Add a new provider (interactive wizard)`
  );
  ctx.log(
    `  ${chalk.green('/provider list')}          List all configured providers`
  );
  ctx.log(
    `  ${chalk.green('/provider use')} ${chalk.cyan('<name>')}    Switch to a provider`
  );
  ctx.log(
    `  ${chalk.green('/provider remove')} ${chalk.cyan('<name>')} Remove a provider`
  );
  ctx.log(
    `  ${chalk.green('/provider test')}          Test current provider connectivity`
  );
  ctx.log('');
  return { handled: true };
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Handle /provider command and route to appropriate subcommand.
 *
 * @param args - Arguments after "/provider" (e.g., ["add"], ["use", "my-provider"])
 * @param state - Current chat state
 * @param ctx - Command context for logging
 * @returns true to continue REPL
 */
export async function handleProviderCommand(
  args: string[],
  state: ChatState,
  ctx: CommandContext
): Promise<boolean> {
  const subcommand = args[0]?.toLowerCase() ?? 'help';
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'add':
    case 'new':
      await handleProviderAdd(state, ctx);
      break;

    case 'list':
    case 'ls':
      await handleProviderList(state, ctx);
      break;

    case 'use':
    case 'switch':
      await handleProviderUse(subArgs, state, ctx);
      break;

    case 'remove':
    case 'rm':
    case 'delete':
      await handleProviderRemove(subArgs, state, ctx);
      break;

    case 'test':
      await handleProviderTest(state, ctx);
      break;

    case 'help':
    default:
      await handleProviderHelp(state, ctx);
      break;
  }

  return true; // Continue REPL
}
