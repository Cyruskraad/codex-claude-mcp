# Claude Code Bridge

Claude Code Bridge is a local, permission-aware MCP server and Codex plugin that lets Codex delegate coding and repository work to an installed Claude Code CLI. It supports explicit model and effort selection, inspect/write access, resumable sessions, cloud Code sessions when the account supports them, and durable synchronous or asynchronous jobs.

The bridge itself runs entirely on your computer. It does not host an MCP service, send data to Noodle Cloud, automate the Claude.ai website, or provide access to ordinary Claude.ai chats. Claude Code still communicates with Anthropic or your configured provider: prompts, repository content Claude reads, tool interactions, session metadata, and generated output may leave your computer under that provider's terms and account settings.

> [!IMPORTANT]
> This is an independent, unofficial open-source project. It is not affiliated with, endorsed by, or sponsored by OpenAI or Anthropic. Codex, GPT, Claude, and Claude Code are trademarks of their respective owners.

## Highlights

- Seven focused MCP tools for health, task launch, status, paginated results, continuation, cancellation, and forgetting bridge data.
- `inspect` access by default with `Read,Glob,Grep` and plan permissions; `write` uses Claude Code's `acceptEdits` permission mode and never bypasses its permission system.
- Explicit model aliases or full Claude model IDs and effort levels from `low` through `max`.
- New, explicitly resumed, cloud-created, and cloud-attached sessions—never an unsafe “continue most recent” operation.
- Private local state, two-job concurrency, 32 MiB raw-output limits, timeouts, cancellation, orphan recovery, and seven-day terminal-job retention.
- Self-contained Node.js bundles for macOS, Linux, and WSL2.

## Requirements

- Node.js 20.19 or newer
- Claude Code CLI 2.1.0 or newer, installed and authenticated
- macOS, Linux, or WSL2; native Windows is not supported in v0.1.0
- A Git worktree for write-mode tasks

## Install

Add this Git-backed marketplace and install the plugin:

```sh
codex plugin marketplace add https://github.com/Cyruskraad/codex-claude-mcp
codex plugin add codex-claude-mcp@codex-claude-bridge
```

Start a new Codex task after installation, then ask Codex to run `claude_health`. Release ZIP and generic stdio installation options are in [Installation](docs/INSTALLATION.md).

## Example

Ask Codex:

> Use Claude Code Bridge to inspect `/absolute/path/to/repo` for concurrency bugs. Use Sonnet with high effort. Do not modify files.

Codex should check health first and call `claude_task` with `access: "inspect"`. For longer jobs it can poll `claude_job_status` and page through `claude_job_result`.

## Documentation

- [Installation](docs/INSTALLATION.md)
- [Configuration](docs/CONFIGURATION.md)
- [Usage and examples](docs/USAGE.md)
- [Permissions and security model](docs/PERMISSIONS.md)
- [Privacy and data flow](docs/PRIVACY.md)
- [Job lifecycle](docs/JOB-LIFECYCLE.md)
- [Troubleshooting and authentication](docs/TROUBLESHOOTING.md)
- [WSL2 setup](docs/WSL2.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## Development

The production runtime is authored in `src/` and bundled to the plugin's `dist/` directory. Noodle Seed is retained only for local authoring validation; no link, deployment, hosted configuration, or directory submission is part of this project.

```sh
npm ci
npm run typecheck
npm run lint
npm run test:coverage
npm run validate:all
```

See [Contributing](CONTRIBUTING.md) for the test and release workflow.

## License

[MIT](LICENSE) © 2026 Cyruskraad.
