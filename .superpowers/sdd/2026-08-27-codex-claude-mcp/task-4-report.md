# Task 4 report — MCP protocol and health surface

## Outcome

Implemented the bundled TypeScript stdio MCP protocol for `codex-claude-mcp` with all seven public tools, strict schemas, exact annotations, safe normalized results/errors, bounded Claude Code health probes, lifecycle-aware stdio shutdown, and built-bundle SDK client coverage.

## TDD evidence

- Initial built-bundle protocol RED: after adding the first SDK client test and building the pre-Task4 server, `vitest run test/protocol.test.ts` failed with `MCP error -32000: Connection closed`; the prior bundle was only a 167-byte constant export.
- Health RED: a fake executable override still produced the placeholder `unavailable` health result instead of `ready`.
- SDK boundary RED: unknown root keys were echoed in SDK validation (`sk_ant_secret_root_key`), enum values were echoed (`private-effort`), and unknown tool names were reflected.
- Injected-environment RED: health auth remained `ready` instead of the injected `unknown` state because the probe child did not receive the injected environment.
- Runtime cleanup RED: a transport startup error left the injected supervisor running.
- Canonical-home RED: a symlinked home returned the full canonical path instead of `~/claude`.
- Output validation RED: an unexpected `private_output_secret` job field was echoed by SDK output validation.

Each RED was followed by a focused GREEN run before expanding the next behavior.

## Implementation

- Added `src/protocol.ts`:
  - strict reusable input/output schemas;
  - all seven tools with professional names/descriptions and exact annotations;
  - success compatibility output as identical `structuredContent` and JSON `TextContent`;
  - stable code-to-message domain error normalization with no raw messages;
  - explicit continuation schema that cannot accept workspace/access/model/effort/session/max-turn escalation fields;
  - initialization instructions covering health-first use, inspect defaults, explicit write authorization, async jobs, explicit session continuation, cancellation, forgetting, privacy, and the Claude.ai boundary.
- Replaced `src/server.ts` placeholder with:
  - testable runtime dependency injection;
  - real `McpServer` and `StdioServerTransport` startup;
  - an inbound transport decorator that replaces unknown tool names with a fixed sentinel before the SDK can reflect them;
  - supervisor cleanup on transport close, signal close, and transport-start failure without terminating detached jobs;
  - bridge running/queued counts in health.
- Added `src/health.ts` and shared executable/probe primitives:
  - authoritative explicit override then direct absolute-PATH scanning, no shell, shared by health and the actual runner;
  - realpath, regular-file, executable, canonical-home display handling;
  - 2 s/4 KiB version, 3 s/64 KiB help, and 3 s/16 KiB auth probes;
  - one combined stdout/stderr cap, directly owned non-detached probe children, exact-child TERM → grace → KILL, authoritative exit tracking, bounded pipe settlement, and reap;
  - strict semver floor `2.1.0`, conservative required-flag detection, stable auth classification with exit-zero precedence, and no retained raw probe output;
  - aliases and accepted effort values described as bridge capabilities, not account entitlements.
- Pinned `@modelcontextprotocol/sdk` to `1.30.0` and Zod to `3.25.76`.
- Added serial `test:bundle` and build-first full/coverage scripts.
- Extended the fake Claude executable for help/auth/version timeout, flood, combined-stream, and sensitive-output cases.

## Protocol coverage

Built `plugins/codex-claude-mcp/dist/server.mjs` is exercised through SDK `Client` + `StdioClientTransport` for:

- initialize metadata, version, instructions, tools capability;
- exactly seven tool schemas/titles/descriptions/annotations;
- missing/invalid override, version, feature, timeout/cap, and auth health states with identity/credential nonleak;
- sync, auto, and async fake-Claude work through the real detached runner;
- exact prompt-on-stdin behavior and inspect/model/effort/max-turn/resume argv;
- status, 64 KiB UTF-8 pagination, exact reconstruction, altered/cross-job/stale cursor rejection;
- explicit-session continuation and schema-boundary escalation rejection;
- queued/running/repeat cancellation;
- terminal-only forgetting and transcript-retention clarification;
- secret-safe invalid root/nested/enum/workspace/job/cursor/output fields and unknown tools;
- server transport close with detached state preserved and recovered.

## Fresh verification

- `npm run test:coverage`: **165/165 tests passed** across 15 files.
  - statements: **94.53%**
  - lines: **94.53%**
  - functions: **92.51%**
  - branches: **85.53%**
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `node --check plugins/codex-claude-mcp/dist/server.mjs`: passed.
- `node --check plugins/codex-claude-mcp/dist/runner.mjs`: passed.
- `noodle validate --json`: `{"ok":true,"data":{}}`.
- `noodle test --json` with approved loopback bind: passed; modern protocol `2026-07-28`, authoring tool `authoring_status`.
- Plugin Creator `validate_plugin.py plugins/codex-claude-mcp`: passed.
- `git diff --check`: passed.
- `npm ls @modelcontextprotocol/sdk zod --depth=0`: SDK `1.30.0`, Zod `3.25.76`.

## Boundaries not crossed

- No real Claude model task was run.
- No Claude or GitHub authentication was attempted.
- No network, deployment, publication, repository creation, tag, or release action was performed.
- Live authenticated Claude, Linux/WSL2 process-group behavior, local Codex install/UI, and public release remain Task 6 evidence.

## Review fix round 1

### RED evidence

- `npx vitest run test/bounded-process.test.ts test/health.test.ts test/workspace-policy.test.ts` initially produced three failed files: the bounded-process module was missing; valid-looking version output with exit 7 was incorrectly accepted as supported/ready; valid-looking help output with exit 7 was incorrectly accepted; and unsafe empty/dot PATH entries executed a workspace `git` marker.
- `npx vitest run test/runner-integration.test.ts -t "never executes"` initially failed four marker cases: empty, dot, and relative PATH entries plus a relative explicit Claude override reached the repository-local fake executable and normalized only after execution.
- `npx vitest run test/bundle-artifact.test.ts` initially failed both artifacts because `server.mjs` and `runner.mjs` imported `./chunk-JLSRUHXO.mjs` and could not stand alone.
- The first lifecycle GREEN exposed a flaky fixture whose TERM handler was not installed before timeout. The fixture was corrected to isolate the intended behavior, then a separate fast-write/natural-exit case was added to prove that authoritative `exit` tracking does not discard final buffered output before `close`.

### Fixes

- Added `src/executable-resolution.ts` as the single canonical resolver for health, runner, and Git probes. It treats even an empty Claude override as authoritative, rejects relative overrides, ignores empty/relative PATH entries, and only returns realpath-resolved regular files with execute permission.
- The actual runner now resolves once to a canonical absolute Claude path before preflight and uses that path for both version and task spawns. Its injected environment is used consistently; no workspace-relative executable lookup remains.
- The Git worktree probe now resolves a canonical absolute Git executable outside the workspace lookup, caps combined output, enforces a deadline, and uses the same directly owned bounded-child lifecycle.
- Added `src/bounded-process.ts`: probes are non-detached children, never use negative PGIDs, stop only a directly owned live child, send TERM then KILL after grace when necessary, track `exit` as the no-more-signals authority, drain naturally until `close`, and use bounded settlement for descendant-held pipes.
- Health now requires exit code 0 for both version and help probes. Valid-looking nonzero output yields only stable degraded health fields. Exit-zero authentication remains authoritative over sensitive or misleading prose.
- Set `splitting:false`; both production entrypoints are independently self-contained. Artifact tests copy and execute each `.mjs` alone and reject relative chunk imports.
- Expanded the built SDK-client suite with exact nested execution/session/model/effort/ID/cursor bounds and defaults, strict nested job/result/health outputs, version hang/output-cap/nonzero cases, explicit resume/cloud-create/cloud-attach invocations, and raw stdin EOF shutdown.
- Raw EOF verification observes code 0 / no signal, confirms the server PID is gone, and verifies detached job state remains present and recoverable before cancellation.

### Fresh verification after review fixes

- Focused executable/probe/runner/workspace suite: **71/71 passed**.
- Built protocol plus standalone bundle artifacts: **24/24 passed**.
- `npm test`: **188/188 tests passed** across 17 files.
- `npm run test:coverage`: **188/188 passed**; statements/lines **95.18%**, functions **92.85%**, branches **86.44%**.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed; exactly `server.mjs`, `runner.mjs`, and their source maps, with no shared runtime chunk.
- `node --check` for both production bundles: passed.
- `git diff --check`: passed.
- `npm ls @modelcontextprotocol/sdk zod --depth=0`: SDK **1.30.0**, Zod **3.25.76**.
- `npm exec --offline -- noodle validate --json`: `{"ok":true,"data":{}}`.
- `npm exec --offline -- noodle test --json`: passed on loopback with modern protocol `2026-07-28` and `authoring_status`.
- Plugin Creator validator: passed.

No real Claude model task, authentication, network call, deployment, publication, or repository mutation outside this local Task 4 fix was performed.

## Review fix round 2 — canonical bundle entrypoints

### RED evidence

- The Task 5 clean-ZIP smoke exposed that Node canonicalized an ESM bundle loaded through a directory symlink while `process.argv[1]` retained the alias. The server's lexical URL/path comparison therefore returned false and the executable silently exited without starting stdio MCP.
- After strengthening `test/bundle-artifact.test.ts`, `npm run build && npx vitest run test/bundle-artifact.test.ts` failed **1/4**: the copied server invoked through a symlink alias rejected MCP initialization with `-32000 Connection closed`. The aliased runner evidence already reached its argument validation and returned code 2.
- A focused unit RED also failed to load the not-yet-created shared canonical-entrypoint helper.

### Fix

- Added `src/entrypoint.ts` with one synchronous, exception-safe physical-file predicate. It resolves the invoked argument, converts the module URL, canonicalizes both with `realpathSync.native`, and returns false on any missing/malformed input without logging or returning raw paths.
- `src/server.ts` now guards stdio startup with the canonical predicate, so macOS aliases such as `/var/...` and `/private/var/...`, extracted ZIP paths, and ordinary symlinks initialize the same executable.
- `src/runner.ts` uses the same canonical guard before honoring runner arguments. This preserves intended direct execution through aliases while preventing an imported runner module from accidentally acting on a host process's `--job-id` arguments.
- The standalone artifact suite now proves actual MCP initialize metadata from an aliased copied server, not merely exit code 0, and proves the aliased copied runner reaches its main argument contract.

### Fresh verification after round 2

- Canonical-entrypoint unit tests: **2/2 passed**.
- Standalone copied-bundle artifact tests: **4/4 passed**.
- `npm run test:bundle`: **26/26 passed**, including all 22 built MCP protocol cases.
- `npm test`: **200/200 passed** across 19 files.
- `npm run test:coverage`: **200/200 passed**; statements/lines **95.15%**, functions **92.85%**, branches **86.44%**. `src/entrypoint.ts` is **100%** covered for statements, lines, functions, and branches.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed; server and runner remained independently self-contained.
- `node --check` for both production bundles: passed.

No Task 5 delivery, documentation, manifest, asset, skill, or release-script file was edited by this fix. No network, authentication, live Claude task, deployment, or publication action was performed.
