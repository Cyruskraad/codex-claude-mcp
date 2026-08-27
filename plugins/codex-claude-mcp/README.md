# Claude Code Bridge

This plugin contains the self-contained local stdio MCP server, detached runner, Codex skill, and UI assets for Claude Code Bridge v0.1.0.

It requires Node.js 20.19+ and an installed, authenticated Claude Code CLI 2.1.0+. Run `claude_health` before starting work. Inspection is the default; write access must be explicitly authorized and targets a real Git worktree under Claude Code's normal permission system.

The bridge is local-only and does not provide ordinary Claude.ai chat access. Forgetting a bridge job does not delete Claude Code's transcript. Full installation, privacy, permission, and troubleshooting documentation is available in the [public repository](https://github.com/Cyruskraad/codex-claude-mcp).

This is an independent, unofficial project and is not affiliated with OpenAI or Anthropic.

Licensed under the [MIT License](LICENSE).
