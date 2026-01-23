/**
 * Config Command
 *
 * Manages ~/.ctx/config.toml via CLI:
 *   ctx config get <key>     - Get a specific value
 *   ctx config set <key> <value> - Set a value
 *   ctx config list          - Show all configuration
 *   ctx config path          - Show config file location
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig, getConfigValue, setConfigValue, listConfig, getConfigPath } from '../../config/loader.js';
import type { CommandContext } from '../types.js';

/**
 * Create the config command with all subcommands
 */
export function createConfigCommand(getContext: () => CommandContext): Command {
  const configCmd = new Command('config')
    .description('Manage configuration settings');

  // ctx config get <key>
  configCmd
    .command('get <key>')
    .description('Get a configuration value (e.g., ctx config get embedding.model)')
    .action((key: string) => {
      const ctx = getContext();

      try {
        const value = getConfigValue(key);

        if (value === undefined) {
          ctx.error(`Unknown config key: ${key}`);
          ctx.log('');
          ctx.log(`Run ${chalk.cyan('ctx config list')} to see all available keys.`);
          process.exitCode = 1;
          return;
        }

        if (ctx.options.json) {
          console.log(JSON.stringify({ key, value }));
        } else {
          // Format the value nicely
          const formatted = formatValue(value);
          ctx.log(formatted);
        }
      } catch (error) {
        handleConfigError(ctx, error);
      }
    });

  // ctx config set <key> <value>
  configCmd
    .command('set <key> <value>')
    .description('Set a configuration value (e.g., ctx config set search.top_k 20)')
    .action((key: string, value: string) => {
      const ctx = getContext();

      try {
        setConfigValue(key, value);

        if (ctx.options.json) {
          console.log(JSON.stringify({ success: true, key, value: getConfigValue(key) }));
        } else {
          ctx.log(`${chalk.green('✓')} Set ${chalk.cyan(key)} = ${chalk.yellow(value)}`);
        }
      } catch (error) {
        handleConfigError(ctx, error);
      }
    });

  // ctx config list
  configCmd
    .command('list')
    .alias('ls')
    .description('List all configuration values')
    .action(() => {
      const ctx = getContext();

      try {
        const entries = listConfig();

        if (ctx.options.json) {
          const obj = Object.fromEntries(entries);
          console.log(JSON.stringify(obj, null, 2));
        } else {
          ctx.log(chalk.bold('Configuration:'));
          ctx.log('');

          // Group by top-level key for readability
          let currentGroup = '';
          for (const [key, value] of entries) {
            const group = key.split('.')[0] ?? '';

            // Add spacing between groups
            if (group !== currentGroup) {
              if (currentGroup !== '') ctx.log('');
              currentGroup = group;
            }

            const formatted = formatValue(value);
            ctx.log(`  ${chalk.cyan(key)} = ${chalk.yellow(formatted)}`);
          }

          ctx.log('');
          ctx.log(chalk.dim(`Config file: ${getConfigPath()}`));
        }
      } catch (error) {
        handleConfigError(ctx, error);
      }
    });

  // ctx config path
  configCmd
    .command('path')
    .description('Show the config file location')
    .action(() => {
      const ctx = getContext();
      const configPath = getConfigPath();

      if (ctx.options.json) {
        console.log(JSON.stringify({ path: configPath }));
      } else {
        ctx.log(configPath);
      }
    });

  // ctx config reset (bonus command - useful for troubleshooting)
  configCmd
    .command('reset')
    .description('Reset configuration to defaults')
    .option('-f, --force', 'Skip confirmation prompt')
    .action(async (options: { force?: boolean }) => {
      const ctx = getContext();

      if (!options.force && !ctx.options.json) {
        ctx.log(chalk.yellow('This will reset all configuration to defaults.'));
        ctx.log(`Run with ${chalk.cyan('--force')} to confirm.`);
        process.exitCode = 1;
        return;
      }

      try {
        const fs = await import('node:fs');
        const configPath = getConfigPath();

        if (fs.existsSync(configPath)) {
          fs.unlinkSync(configPath);
        }

        // Reload to create fresh config
        loadConfig(true);

        if (ctx.options.json) {
          console.log(JSON.stringify({ success: true, message: 'Configuration reset to defaults' }));
        } else {
          ctx.log(`${chalk.green('✓')} Configuration reset to defaults`);
        }
      } catch (error) {
        handleConfigError(ctx, error);
      }
    });

  return configCmd;
}

/**
 * Format a value for display
 */
function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

/**
 * Handle config errors with user-friendly messages
 */
function handleConfigError(ctx: CommandContext, error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unknown error';

  if (ctx.options.json) {
    console.error(JSON.stringify({ error: message }));
  } else {
    ctx.error(message);
  }

  process.exitCode = 1;
}
