# Configuration

Claude Code Bridge intentionally has a small configuration surface.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PATH` | Discovers `claude` and `git`. |
| `HOME` | Locates Claude Code's user-owned authentication/configuration and the standard macOS/Linux state base. |
| `XDG_STATE_HOME` | Selects the standard Linux state base when set. |
| `CODEX_CLAUDE_MCP_CLAUDE_PATH` | Overrides Claude discovery with an absolute executable path. |
| `CODEX_CLAUDE_MCP_STATE_DIR` | Overrides bridge state with an absolute directory. |
| `ANTHROPIC_API_KEY` | Optional standard non-interactive Claude API authentication. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Optional standard non-interactive Claude Code OAuth authentication. |

The packaged Codex configuration allows only these variables. A normal cached `claude auth login` session located through `HOME` is preferred. The two optional non-interactive credential variables are forwarded only when the user has already set them; their values are never command-line arguments, bridge state fields, or logs. Proxy, base-URL, and cloud-provider variables are deliberately omitted because v0.1.x does not test those authentication paths. A generic MCP client may configure a different provider environment under Claude Code's own documentation and should treat every provider value as a credential.

## Claude discovery

An explicit `CODEX_CLAUDE_MCP_CLAUDE_PATH` wins over `PATH`. The bridge resolves the executable to a real absolute path, verifies that it is executable, checks the version and required CLI flags, and reports a home-relative display path when possible. It never invokes a shell.

## State locations

- macOS: `~/Library/Application Support/codex-claude-mcp`
- Linux/WSL2: `${XDG_STATE_HOME:-~/.local/state}/codex-claude-mcp`

The state root is private (`0700`) and job/control/result files are private (`0600`). `CODEX_CLAUDE_MCP_STATE_DIR` must be absolute.

## Defaults and limits

- Access: `inspect`
- Session: new
- Execution: auto; `wait_seconds` defaults to 45 and is configurable from 0 to 45 before auto returns an active job asynchronously
- Timeout: `timeout_seconds` defaults to 1,800 and is configurable from 30 to 7,200; it is the runner deadline in every execution mode and the maximum sync wait
- Maximum turns: 20; configurable from 1 to 100
- Concurrent jobs: 2
- Raw output per job: 32 MiB
- Result page: at most 64 KiB
- Terminal-job retention: 7 days

Model and effort are unset by default, so Claude Code's configured defaults apply. Aliases and account availability remain Claude Code concerns.
