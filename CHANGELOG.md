# Changelog

All notable changes to this project will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-08-27

### Fixed

- Run CLI readiness probes from a stable working directory so Codex marketplace cache refreshes cannot make Claude Code report a deleted-current-directory error as a malformed version.

## [0.1.0] - 2026-08-27

### Added

- Local TypeScript stdio MCP with seven Claude Code bridge tools.
- Permission-aware inspect/write tasks with model, effort, turn, session, and execution controls.
- Explicit new, resumed, and cloud-attach session handling; noninteractive cloud creation returns a stable unsupported-mode error.
- Durable two-job scheduler, bounded paginated output, continuation, cancellation, timeout, orphan recovery, and seven-day retention.
- Sanitized CLI health/version/feature/authentication readiness checks.
- Codex plugin, discoverable bridge skill, abstract violet/cyan icon set, Git marketplace, documentation, CI, deterministic release archive, checksum, and CycloneDX SBOM.

[0.1.1]: https://github.com/Cyruskraad/codex-claude-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/Cyruskraad/codex-claude-mcp/releases/tag/v0.1.0
