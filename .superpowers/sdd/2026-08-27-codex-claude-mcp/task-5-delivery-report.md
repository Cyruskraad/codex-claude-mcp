# Task 5 delivery lane report

## Outcome

Completed the plugin delivery lane for Claude Code Bridge v0.1.0 without editing the skill or PNG assets owned by the parallel lanes. The repository now has a Git-backed Codex marketplace, final plugin/MCP manifests, tracked self-contained bundles, complete public documentation, portable validation and release scripts, pinned-SHA CI, dependency notices, a deterministic plugin-root ZIP/checksum, and a normalized production CycloneDX SBOM.

No network access, authentication, real Claude model task, hosted Noodle operation, GitHub publication, tag, or release mutation was performed.

## Material changes

- Finalized `.codex-plugin/plugin.json` at exact version `0.1.0` with “Claude Code Bridge,” Developer Tools classification, `#7C3AED`, three icon paths, privacy URL, concise capabilities/prompts, and no terms URL.
- Finalized `.mcp.json` with plugin-relative `node ./dist/server.mjs` startup and a narrow environment allowlist: cached login via `HOME` is preferred; standard optional `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` plus discovery/state variables are allowed. No values are embedded.
- Renamed the repo marketplace to the distinctive `codex-claude-bridge` and aligned its category to Developer Tools.
- Set the production engine to Node `>=20.19.0`, pinned `@noodleseed/one` exactly at `0.142.1`, disabled source maps, and unignored only `server.mjs` and `runner.mjs` for clean-clone Git installation.
- Added root and packaged-plugin documentation, MIT license copy, and generated production dependency notices.
- Added deterministic docs, skill, plugin, asset, secret, notices, SBOM, and archive scripts with behavior tests.
- Added pinned-SHA GitHub Actions for Linux/macOS Node 20 runtime gates, Linux-as-WSL2 baseline, Node 24 Noodle offline validation, full/production audits, package/SBOM checks, and Gitleaks.

## RED–GREEN evidence

`test/delivery-scripts.test.ts` was developed against missing behavior and observed failing before each implementation. Final focused result: **8/8 passed**. It proves:

- broken and root-escaping documentation links are rejected;
- the declared plugin-root ZIP is deterministic and excludes maps/undeclared files;
- manifest/MCP/bundle delivery invariants reject source maps;
- PNG dimensions, RGBA alpha, intended-background contrast, and violet/cyan readability at 16/32/128 px;
- secret findings report only file/line and never echo the value;
- notices include production MCP/Zod dependencies and exclude Vitest/Noodle;
- the packaged skill meets the discovery/frontmatter/conciseness structure.

The delivery clean-ZIP smoke also exposed a pre-existing lexical-versus-canonical ESM entrypoint bug for macOS `/var` aliases. Task 4 fixed it in `c9f576a` with focused unit and real aliased-bundle initialization tests; both independent security/compliance re-reviews were clean.

## Final verification

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run test:coverage`: **200/200 passed** across 19 files.
  - statements/lines: **94.96%**
  - functions: **92.85%**
  - branches: **86.44%**
- `node --check` on both production bundles: passed.
- Plugin Creator validation: passed.
- Skill Creator quick validation: passed.
- `npm run validate:all`: plugin, skill, assets, and 20 Markdown files passed.
- `npm run scan:secrets`: passed without emitting matched values.
- `noodle validate --json`: `{"ok":true,"data":{}}`.
- `noodle test --json` with approved loopback bind: passed; modern protocol `2026-07-28`, tool `authoring_status`.
- Full and production `npm audit --offline --json`: zero cached findings. Fresh registry-backed full/production audits are configured in CI because this lane was explicitly offline/no-network.
- Release ZIP generated twice with the same checksum: `2a7a44d119386d7c06d51d872f491741439e519afa465cf340aaddaf63d5dc82`.
- Normalized production SBOM generated twice with the same checksum: `e6cdda71e350ca5d2e41f728aa2835a1f6e94c6d1d587cfa5059b433fdfd5291`.
- `shasum -a 256 -c`: passed; `unzip -t`: passed; exact archive inventory contains 11 declared plugin-root files and no maps, shared chunks, source, Noodle corpora, or generated state.
- Fresh extracted-ZIP stdio smoke: initialized successfully through a macOS temporary path alias, exposed exactly seven tools, and returned sanitized missing-override health without running Claude.
- `git diff --check`: passed.

## Boundaries remaining for Task 6

- Hosted GitHub Actions have not run yet; local workflow YAML and every action SHA shape were validated, but registry-backed audit/Gitleaks/macOS-Linux matrix evidence starts after push.
- Node 20.19, Linux, and WSL2 runtime lanes are configured but not locally available on this Mac; the current local runtime was Node 26.4.0.
- Authenticated Claude health/inspect/write/resume/async/cloud tests remain gated on user re-authentication.
- Local Codex marketplace install, new-task discovery, end-to-end call, and visual plugin UI confirmation remain pending.
- GitHub authentication, public repository creation/push, tag, release publication, and uploaded ZIP/checksum/SBOM remain pending explicit Task 6 execution.
