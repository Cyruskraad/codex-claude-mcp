# WSL2

WSL2 is supported through the Linux runtime path. Native Windows is not supported in v0.1.x.

## Setup

Install Node.js 20.19+ and Claude Code inside the WSL2 distribution, not only on Windows. Authenticate the Linux installation and run Codex/MCP in that same distribution.

Keep repositories and bridge state on the native Linux filesystem, such as `~/src/project`, rather than `/mnt/c/...`. Linux paths provide the ownership, mode, atomic rename, hard-link, and process behavior the bridge validates.

```sh
node --version
claude --version
claude auth status
git -C ~/src/project rev-parse --show-toplevel
```

## Manual smoke test

After installation:

1. Start a new Codex task and run `claude_health`.
2. Run an inspect-only task against a disposable Git repository under the Linux home directory.
3. Run a controlled write task that creates one known file, review it, then remove the disposable repository.
4. Start an async task, poll status, page its result, and test cancellation on a separate long-running disposable task.
5. Resume an explicit captured session ID.

The GitHub Actions Linux lane is the automated WSL2 compatibility baseline. This manual smoke test remains required because hosted Linux does not reproduce WSL2's Windows interop and mounted-filesystem behavior.
