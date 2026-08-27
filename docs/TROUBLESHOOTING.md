# Troubleshooting

## Health reports Claude missing

Run `claude --version` in the same environment as Codex. If Claude is installed outside `PATH`, set `CODEX_CLAUDE_MCP_CLAUDE_PATH` to its absolute executable path and start a new Codex task. Symlink targets are resolved before use.

## Version is unsupported

Upgrade Claude Code to 2.1.0 or newer. `claude_health` also checks the required flags; a newer CLI with missing required features is reported as degraded or unavailable rather than guessed compatible.

## Authentication is not ready or expired

Run these commands directly in your terminal:

```sh
claude auth status
claude auth login
```

Complete the interactive login yourself, then rerun `claude_health`. Do not paste tokens, cookies, API keys, or authentication output into a bridge prompt.

## Write workspace is rejected

Write access requires an absolute, existing, canonical path inside a real Git worktree. The filesystem root, the home directory itself, non-Git directories, and a supplied workspace path that traverses a symbolic link are rejected. Symlinks inside a repository are not an OS confinement boundary. Initialize a repository only if that is appropriate for the project; otherwise use inspect access.

## Job remains queued

The bridge runs two jobs concurrently. Poll status while earlier jobs finish or cancel an in-scope queued/running job. Stale terminal jobs do not consume concurrency.

## Timed out or output limited

Increase `timeout_seconds` up to 7,200 only when the task warrants it. Split broad prompts into smaller tasks. Raw output is capped at 32 MiB and cannot be raised in v0.1.0.

## Orphaned job

An orphan means runner ownership could not be safely verified after interruption or restart. Inspect the bounded result/error, then start a new task or explicitly resume the captured Claude session if a session ID is available.

## Cloud mode fails

Cloud create/attach depends on installed CLI features and account entitlement. Health can verify CLI flag support, but it cannot promise a particular account has cloud Code access.

## State permission error

Ensure the configured state path is absolute, owned by your user, and not a symlink. The bridge enforces private directories and files. For WSL2, keep state on the Linux filesystem; see [WSL2](WSL2.md).

When reporting a bug, include bridge version, OS, Node version, sanitized health status, stable error code, and reproduction steps. Never include prompts, credentials, raw auth output, or private result contents.
