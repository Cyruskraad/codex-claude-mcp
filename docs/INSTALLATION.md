# Installation

## Prerequisites

Install Node.js 20.19 or newer and the Claude Code CLI. Confirm the CLI is available and authenticate it in the same user environment that runs Codex:

```sh
node --version
claude --version
claude auth status
```

Claude Code Bridge requires Claude Code 2.1.0 or newer. Authentication is owned by Claude Code; the bridge does not collect or store credentials.

## Codex marketplace

Add the public Git repository as a marketplace, then install the plugin:

```sh
codex plugin marketplace add https://github.com/Cyruskraad/codex-claude-mcp
codex plugin add codex-claude-mcp@codex-claude-bridge
```

Start a new Codex task so the MCP tools and `claude-code-bridge` skill are discovered. Ask Codex to run `claude_health` before the first task.

## Release ZIP

Download `codex-claude-mcp-v0.1.3.zip`, its `.sha256` file, and the CycloneDX SBOM from the [v0.1.3 release](https://github.com/Cyruskraad/codex-claude-mcp/releases/tag/v0.1.3). Verify the checksum:

```sh
shasum -a 256 -c codex-claude-mcp-v0.1.3.zip.sha256
```

The ZIP is a standalone plugin-root artifact, not a marketplace catalog. Codex users should use the Git marketplace above. Other stdio clients can extract the ZIP to a stable directory and point directly at its bundled server as shown below.

## Generic stdio MCP client

Point a stdio MCP client at the absolute path of the bundled server:

```json
{
  "mcpServers": {
    "claude-code-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/codex-claude-mcp/dist/server.mjs"]
    }
  }
}
```

The client environment must provide `HOME` and `PATH`. See [Configuration](CONFIGURATION.md) for supported overrides. The MCP server writes protocol data to stdout and keeps diagnostics bounded and sanitized on stderr.

## From source

```sh
git clone https://github.com/Cyruskraad/codex-claude-mcp.git
cd codex-claude-mcp
npm ci
npm run build
npm run validate:all
```

The tracked production bundles make normal Git marketplace installation independent of a local build. Building from source is intended for development and verification.
