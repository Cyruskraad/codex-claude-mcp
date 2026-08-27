# Claude Code Bridge MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, validate, install-test, and publish a local Codex MCP plugin that safely orchestrates Claude Code tasks.

**Architecture:** A TypeScript stdio MCP server delegates each request to a detached runner that invokes the local Claude Code CLI through argument arrays and stream-JSON stdin. The plugin bundles both entrypoints, a workflow skill, original icons, and a repo marketplace; private state provides restart-safe hybrid jobs.

**Tech Stack:** Node.js 20+, TypeScript, `@modelcontextprotocol/sdk`, Zod, Vitest, tsup, ESLint, Noodle Seed, Codex Plugin Creator.

**Spec:** `docs/superpowers/specs/2026-08-27-codex-claude-mcp-design.md`

## Global Constraints

- Repository: public `Cyruskraad/codex-claude-mcp`, MIT, version `0.1.0`.
- Runtime: local stdio only; never link or deploy with Noodle Cloud.
- Platforms: macOS, Linux, and WSL2; Node.js 20 or newer.
- Never pass prompts on argv, use `shell: true`, expose bypass permissions, enable Chrome/nested MCP, or log prompts/environments/credentials/full results.
- Defaults: inspect access, new local session, auto execution, 20 turns, 45-second wait, 1,800-second runtime, two concurrent jobs, 32 MiB output, seven-day retention.
- Write work requires an absolute realpath-resolved Git workspace; reject `/`, the home directory itself, non-Git write targets, missing paths, and symlink escapes.
- Production code follows RED-GREEN-REFACTOR. Tests must visibly fail for the intended reason before implementation.
- Coverage gates: 90% lines/functions/statements and 85% branches.

---

### Task 1: Bootstrap project and plugin package

**Produces:** project toolchain, repo marketplace, plugin skeleton, build scripts, design/process artifacts, and baseline validation.

- [ ] Run the public `noodle init --json` cold-start route, parse its result, read the generated project-local Noodle Seed skill completely, and choose its offline validation route only.
- [ ] Scaffold `plugins/codex-claude-mcp/` and `.agents/plugins/marketplace.json` with Plugin Creator using skills, assets, and MCP companions.
- [ ] Configure Node 20+, TypeScript, Vitest coverage, tsup entrypoints, ESLint, package scripts, `.gitignore`, MIT license, and placeholder-free plugin/marketplace metadata.
- [ ] Validate the initial plugin skeleton and commit the task.

### Task 2: Define schemas, workspace policy, Claude arguments, and stream parsing

**Produces:** validated public input/output types and pure runtime helpers used by the runner and MCP layer.

- [ ] Write failing tests for every schema default/bound, model sanitization, workspace realpath policy, Claude argv invariants, stream event parsing, unknown events, result normalization, and stable errors.
- [ ] Run the focused tests and confirm failures are caused by missing production modules.
- [ ] Implement the minimum schemas and pure helpers; prompts must be encoded only as supported stream-JSON stdin messages.
- [ ] Run focused and full tests, refactor while green, and commit the task.

### Task 3: Implement private durable jobs and detached Claude runner

**Produces:** atomic private state, concurrency/retention/output enforcement, detached execution, cancellation, orphan recovery, and fake-Claude integration coverage.

- [ ] Write failing tests using a fake Claude executable for success, malformed JSON, auth failure, unsupported versions, crashes, hangs, resume/cloud-attach arguments, rejected noninteractive cloud creation, prompt secrecy, timeout, cancellation, output limit, cleanup, concurrency, orphan recovery, and auto promotion.
- [ ] Run focused tests and verify expected RED failures.
- [ ] Implement state storage, queue/supervisor services, detached runner, process-group cancellation, atomic updates, cleanup, and paginated output.
- [ ] Run focused and full tests, refactor while green, and commit the task.

### Task 4: Expose and bundle the MCP protocol

**Produces:** all seven tools, accurate annotations, normalized results/errors, server instructions, and protocol-level stdio tests.

- [ ] Write failing SDK client tests for initialization, instructions, tool list, schemas, annotations, valid calls, invalid calls, continuation non-escalation, cancellation, forgetting, and result pagination.
- [ ] Run the protocol tests and confirm expected RED failures.
- [ ] Implement tool registration and handlers over the job services; build self-contained server/runner bundles into the plugin.
- [ ] Run protocol, integration, unit, type, lint, and build checks; commit the task.

### Task 5: Add the Codex skill, brand assets, and professional documentation

**Produces:** tested `claude-code-bridge` skill, final plugin manifest, abstract-bridge icon family, and complete user/developer/security docs.

- [ ] Run baseline pressure scenarios without the new skill and record the observed failures.
- [ ] Create the concise automatically discoverable skill, validate it, rerun the scenarios with the skill, and close demonstrated gaps.
- [ ] Generate the original transparent violet/cyan abstract-bridge artwork, inspect it, export 512 px logo and composer assets, and verify 16/32/128 px readability on light/dark backgrounds.
- [ ] Add README, installation and generic stdio configuration, examples, permissions/privacy/job lifecycle, troubleshooting/authentication, WSL2, SECURITY, CONTRIBUTING, CHANGELOG, independence disclaimer, and release packaging.
- [ ] Run plugin, skill, documentation-link, build, and asset validations; commit the task.

### Task 6: Verify live behavior, review, and publish v0.1.0

**Produces:** release-quality verification evidence, installed-plugin smoke test, public GitHub repository, and v0.1.0 release artifacts.

- [ ] Run the complete clean verification matrix, enforce coverage, audit dependencies/secrets, generate the release ZIP, checksum, and SBOM, and verify archive contents.
- [ ] After user Claude authentication, run health plus disposable-repo inspect, write, resume, async, and supported cloud-attach smoke tests using a session created interactively in Claude Code.
- [ ] Install the repo marketplace/plugin in Codex, test tool discovery and one end-to-end call in a new task, and visually verify the icon.
- [ ] Re-run Claude Advisor for adversarial review and resolve blocker/major findings.
- [ ] Restore exact version `0.1.0`, validate a clean Git state, and commit.
- [ ] After user GitHub CLI authentication, create and push public `Cyruskraad/codex-claude-mcp`, tag `v0.1.0`, publish ZIP/checksum/SBOM, and verify the release remotely.
