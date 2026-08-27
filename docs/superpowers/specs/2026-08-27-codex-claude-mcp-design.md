# Claude Code Bridge MCP Design

## Goal

Create an independent, local-only Codex plugin that exposes a typed stdio MCP bridge to the installed Claude Code CLI. The bridge supports selectable Claude model and effort, inspected or write-capable tasks, explicit local/cloud sessions, and durable hybrid jobs without automating ordinary Claude.ai chats.

## Architecture

- TypeScript on Node.js 20+ using `@modelcontextprotocol/sdk` and Zod.
- A bundled stdio MCP server starts detached runner processes. Runners invoke `claude` with `shell: false`, write private atomic state, and parse stream-JSON output.
- Noodle Seed is used for local bootstrap and offline validation only. The production bridge is never deployed remotely because it must use the user's local Claude installation, authentication, and workspace.
- The Codex plugin lives at `plugins/codex-claude-mcp/` and is exposed through the repo marketplace at `.agents/plugins/marketplace.json`.

## Public Tools

- `claude_health`
- `claude_task`
- `claude_job_status`
- `claude_job_result`
- `claude_job_continue`
- `claude_job_cancel`
- `claude_job_forget`

`claude_task` requires an absolute workspace and prompt. It accepts `access: inspect|write`, optional model and effort (`low|medium|high|xhigh|max`), `max_turns` from 1 to 100, explicit new/resume/cloud session settings, and `auto|sync|async` execution with bounded wait and runtime timeouts. Inspect mode limits Claude to `Read,Glob,Grep` with plan permissions. Write mode uses Claude's normal permissions. Both isolate nested MCP and disable Chrome.

## Security and Privacy

- Never expose dangerous permission bypass, ambient/project MCP, Chrome, `--add-dir`, or implicit resume.
- Validate and realpath the workspace; reject filesystem root, the home directory itself, missing paths, symlink escapes, and non-Git write targets.
- Send prompts through stdin, never argv. Do not log prompts, environments, credentials, identities, or full results.
- Use a private `0700` state directory and `0600` files. Cap concurrency at two, output at 32 MiB per job, result pages at 64 KiB, and retention at seven days.
- This is a permission-aware wrapper, not an OS sandbox. The write-capable tools advertise conservative MCP annotations.

## Compatibility and Boundaries

- Support macOS, Linux, and Windows through WSL2.
- Default model and effort remain unset. Accept aliases or full Claude model IDs without shell interpolation.
- Ordinary Claude.ai chats, desktop UI automation, native Windows, automatic Git commits/pushes by Claude, nested MCP, remote hosting, and universal plugin-directory submission are out of scope for v1.

## Delivery

Publish `Cyruskraad/codex-claude-mcp` under MIT with Linux/macOS CI, a repo marketplace, professional original icon assets, installation/security/contribution documentation, and a signed-off `v0.1.0` release ZIP, checksum, and SBOM.
