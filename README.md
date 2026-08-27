# Codex Claude MCP

This repository contains a local-only Codex plugin that will bridge Codex to
the locally installed Claude Code CLI. It does not register a remote MCP
server, use Noodle Cloud, or automate Claude.ai.

The runtime is authored in `src/` and bundled into
`plugins/codex-claude-mcp/dist/`:

- `src/server.ts` is the stdio MCP server entrypoint.
- `src/runner.ts` is the detached local Claude CLI runner entrypoint.

The Noodle Seed files are retained solely for offline authoring validation.
Run `npm run validate` and `npm run noodle:test` for that isolated local check;
neither command configures, links, or deploys a hosted service.

For the project toolchain, use:

```sh
npm run typecheck
npm run lint
npm run test:coverage
npm run build
```
