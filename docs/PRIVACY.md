# Privacy

Claude Code Bridge runs locally and has no bridge-operated service or telemetry endpoint.

## Data flow

1. Codex sends a tool request to the local stdio MCP server.
2. The bridge validates and records the job in a private local state directory.
3. A local runner sends the prompt to the installed Claude Code CLI through stream-JSON stdin.
4. Claude Code communicates with Anthropic or the provider configured by the user, under Claude Code's own privacy terms and account settings.
5. The bridge stores bounded job metadata and output locally for lifecycle and pagination.

Prompts never appear in Claude command-line arguments. A durable queued prompt may briefly exist in a dedicated `0600` request file so a detached runner can consume it; that request is removed after consumption or terminal cleanup. The bridge does not log prompts, credentials, child environments, raw authentication identities, or complete tool results.

## Retention and deletion

Terminal bridge jobs are retained for seven days and then cleaned up on startup. `claude_job_forget` deletes the bridge's job metadata and output for a terminal job. It does not delete Claude Code's separate transcript or provider-side records. Manage those through Claude Code and the configured provider.

## Authentication

The bridge asks Claude Code for a bounded, sanitized readiness status. It does not return account identities or raw authentication command output. A normal cached Claude login through `HOME` is preferred. The packaged MCP allowlist can also forward a pre-existing `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` for standard non-interactive authentication; values are never placed in arguments, bridge state, or logs.

## Scope

The project does not provide access to ordinary Claude.ai chats, automate Claude Desktop or a browser, operate remote hosting, or send data to Noodle Cloud. Noodle Seed is used only for offline authoring validation.

Security concerns can be reported under the [security policy](../SECURITY.md).
