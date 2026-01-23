import { defineConfig } from 'tsup';

export default defineConfig({
  // Entry points - what to build
  entry: {
    cli: 'src/cli/index.ts',      // CLI entry -> dist/cli.js
    index: 'src/index.ts',         // Library entry -> dist/index.js
  },

  // Output format - ESM for modern Node.js
  format: ['esm'],

  // Generate TypeScript declaration files
  dts: true,

  // Enable source maps for debugging
  sourcemap: true,

  // Clean dist/ before each build
  clean: true,

  // Target Node.js 20
  target: 'node20',

  // Add shebang to CLI entry point
  // This makes the file directly executable: ./dist/cli.js
  banner: {
    js: "#!/usr/bin/env node",
  },

  // Don't bundle dependencies - they're installed via npm
  // This keeps the output small and allows shared deps
  noExternal: [],

  // External packages (don't bundle these)
  external: [
    // Node.js built-ins
    'fs', 'path', 'os', 'child_process', 'readline', 'crypto', 'events',
    // Dependencies (installed via npm, not bundled)
    'commander', 'chalk', 'ora', 'zod',
  ],
});
