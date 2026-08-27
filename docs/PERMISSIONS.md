# Permissions and security model

Claude Code Bridge is a permission-aware process wrapper, not an operating-system security sandbox.

## Inspect access

Inspect is the default. The bridge limits Claude Code tools to `Read,Glob,Grep` and selects plan permissions. It also rejects unsafe workspace roots, including `/`, the home directory itself, nonexistent paths, and a supplied workspace path that traverses a symbolic link.

Inspection reduces intended capability but cannot provide a kernel-level confinement guarantee. Run untrusted repositories in an OS sandbox or disposable virtual machine when stronger isolation is required.

## Write access

Write must be explicitly selected and the canonical workspace must be a real Git worktree. Unlike inspect mode, write mode does not apply the `Read,Glob,Grep` tool allowlist: Claude Code may request file changes, commands, network access, or other open-world actions through its normal permission system. The bridge never passes `--dangerously-skip-permissions`, `--add-dir`, or equivalent bypasses.

Write mode authorizes only the local edits the user requested. A commit, push, network action, publication, or other external effect requires separate authorization naming its target and scope; never infer a remote, branch, account, or destination. The bridge does not commit or push automatically.

## Disabled integrations

Both access levels disable Chrome and ignore ambient/project MCP configuration by using a strict empty MCP configuration and disallowing nested MCP tools. This prevents a delegated Claude task from silently acquiring unrelated MCP or browser capabilities.

## Process and storage controls

Claude processes use argument arrays with `shell: false`; prompts are delivered only through stdin. Detached process groups support timeout and cancellation. Durable state uses private permissions, atomic writes, lease ownership, stable state transitions, output caps, and orphan recovery.

The bridge deliberately does not log prompts, child environments, credentials, raw authentication identities, or full tool results. See [Privacy](PRIVACY.md) and [Security policy](../SECURITY.md).
