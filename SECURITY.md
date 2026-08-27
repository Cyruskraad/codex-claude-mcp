# Security policy

## Supported versions

Security fixes are provided for the latest `0.1.x` release until a newer supported series is announced.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/Cyruskraad/codex-claude-mcp/security/advisories/new). Do not open a public issue for an undisclosed vulnerability.

Include the affected version, platform, impact, minimal reproduction, and suggested mitigation when known. Remove credentials, prompts, identities, repository contents, and raw Claude output. You should receive an acknowledgement within seven days. Release timing will depend on severity and the safety of a coordinated fix.

## Security boundary

Claude Code Bridge is a permission-aware local process wrapper, not an OS sandbox. Its controls include canonical workspace validation, Git-only write targets, shell-free spawning, stdin prompt transport, strict empty nested-MCP configuration, Chrome disablement, normal Claude permissions, private durable state, output caps, process ownership checks, and bounded redacted diagnostics.

The bridge cannot protect against every behavior of the local Claude Code executable, the operating system, a malicious repository, or the configured model provider. Use OS isolation for untrusted content and review write-mode changes before committing or pushing.
