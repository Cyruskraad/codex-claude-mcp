import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['coverage/**', 'node_modules/**', 'plugins/codex-claude-mcp/dist/**'],
  },
);
