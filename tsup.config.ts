import { defineConfig } from 'tsup';

export default defineConfig({
  clean: true,
  entry: {
    runner: 'src/runner.ts',
    server: 'src/server.ts',
  },
  format: ['esm'],
  noExternal: [/.*/],
  outExtension: () => ({ js: '.mjs' }),
  outDir: 'plugins/codex-claude-mcp/dist',
  sourcemap: true,
  target: 'node20',
});
