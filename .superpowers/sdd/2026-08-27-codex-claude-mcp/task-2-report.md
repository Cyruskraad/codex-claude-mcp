# Task 2 report — contracts and pure helpers

## Files

- `src/contracts.ts` — public Zod contracts, normalized task input, job states/jobs, and stable error codes.
- `src/workspace-policy.ts` — canonical-path policy and shell-free Git worktree detection.
- `src/claude-invocation.ts` — data-only Claude argv/stdin construction.
- `src/stream-parser.ts` — incremental NDJSON event accumulator and safe terminal normalization.
- `src/diagnostics.ts` — diagnostic redaction and error-safe summaries.
- `test/contracts.test.ts`, `test/workspace-policy.test.ts`, `test/claude-invocation.test.ts`, `test/stream-parser.test.ts`, `test/diagnostics.test.ts` — focused contract tests.

## RED evidence

Tests were added before the production modules. The focused command was:

```text
npm test -- test/contracts.test.ts test/workspace-policy.test.ts test/claude-invocation.test.ts test/stream-parser.test.ts test/diagnostics.test.ts
```

It exited nonzero with five expected suite-load failures, each `Cannot find module`: `../src/contracts.js` (two suites), `../src/workspace-policy.js`, `../src/claude-invocation.js`, `../src/stream-parser.js`, and `../src/diagnostics.js`. No tests ran because the intended production modules had not yet been created.

## Implementation

- `ClaudeTaskInputSchema` accepts only an absolute nonempty workspace and a bounded prompt, applies documented access/max-turn/session/execution defaults, bounds execution, and sanitizes model/session values before any invocation can be constructed.
- The job/error schemas provide one stable downstream vocabulary, including all requested states and error codes.
- Workspace validation resolves the supplied absolute path, requires an existing directory, rejects root/home/symlink redirection, preserves the canonical target path, and checks ancestor `.git` directory or `gitdir:` worktree marker without spawning a shell.
- Claude invocations use stream-JSON stdin for the user message only. Local flags constrain MCP/tools; inspect mode uses the exact read-only tool list and plan mode, while write mode has no bypass/allow/accept-edits flags. Explicit resume and cloud modes use the reconciled CLI arguments.
- The stream parser ignores well-formed unknown events, captures only text progress and safe aggregate result metadata, normalizes terminal errors, bounds the progress tail, and throws a line-content-free `malformed-stream` error for malformed nonblank NDJSON.
- Diagnostic helpers redact credential/token patterns, emails, and home prefixes; error summaries only retain stable code/message fields and never serialize prompt, environment, identity, or tool results.

## Validation results

| Command | Result |
| --- | --- |
| Focused `npm test -- test/contracts.test.ts test/workspace-policy.test.ts test/claude-invocation.test.ts test/stream-parser.test.ts test/diagnostics.test.ts` | 5 files passed, 38 tests passed. |
| `npm run test:coverage` | 6 files passed, 39 tests passed; 97.44% statements, 86.06% branches, 100% functions, 97.44% lines (thresholds: 90/85/90/90). |
| `npm run typecheck` | Passed. |
| `npm run lint` | Passed. |
| `npm test` | 6 files passed, 39 tests passed. |
| `npm run build` | Passed; both existing server and runner ESM bundles built. |
| `npm run validate` | `{"ok":true,"data":{}}`. |
| `npm run noodle:test` | Passed after rerunning with loopback-listener permission; emitted `{"ok":true,...}` and exposed only `authoring_status`. The first sandboxed attempt failed with `listen EPERM` on `127.0.0.1`, not with an application failure. |

## Self-review against the brief

- Defaults, input bounds, model safety, explicit session modes, job states, and all stable error codes are exported from a single contracts module.
- Workspace policy checks both supplied and canonical paths; write access requires a Git directory or worktree-file marker and does not broaden a nested target to repository root.
- Invocation construction contains no prompt argv entry, implicit continuation, ambient/project MCP configuration, directory/chrome/bypass/accept-edits escape hatch, or shell behavior.
- Stream parsing is incremental, recognizes requested event families, ignores unknown valid records, withholds tool results, and makes malformed records line-safe.
- Diagnostics omit sensitive process context and redact supported secret/identity/home patterns.
- Production modules do not import `src/noodle-authoring.ts`; no job execution, process spawning, or MCP registration was added.

## Concerns

None for Task 2. The Noodle smoke test requires a local loopback listener, so it needs the normal elevated sandbox permission in this environment. This task intentionally stops before the Task 3 process runner and Task 4 MCP registration layers.

## Fix round 1 — security hardening

### RED evidence

After adding adversarial regression tests, the focused command was:

```text
npm test -- test/contracts.test.ts test/workspace-policy.test.ts test/stream-parser.test.ts test/diagnostics.test.ts
```

It exited nonzero with 12 expected behavioral failures across 45 tests:

- arbitrary `prompt`, authorization, and identity usage fields were present in a stream snapshot and accepted by `ClaudeJobSchema`;
- nested `execution` and all session branches stripped unsupported `continue` fields instead of rejecting them;
- a fake `.git` directory and an injected Git-metadata result were accepted;
- Basic/custom Authorization material and prefixed environment assignments were not fully redacted, and a 2,000-character error summary was not bounded;
- error terminal state was overwritten by a later success, post-terminal progress was appended, and known subtypes were not retained safely.

The initial real-Git test helper invoked `execFile` without its executable argument and failed before exercising Git; it was corrected to invoke `git` with argument arrays. The intended security failures remained reproducible.

### Changes

- Replaced open usage records with the exported strict `ClaudeUsageSchema` and `sanitizeClaudeUsage`. Only allowlisted aggregate integer/boolean fields are accepted; unknown, string, malformed, and sensitive fields are rejected for jobs and dropped from stream events.
- Made `ExecutionSchema` and every discriminated session branch strict. Nested unsupported keys now produce validation errors.
- Added an optional safe terminal-error subtype to the public error contract. Stream parsing has a strict known-subtype map, preserves no raw error values, makes the first terminal transition immutable, and ignores all post-terminal events.
- Replaced filesystem Git-marker trust with `git rev-parse --is-inside-work-tree --is-inside-git-dir`, launched using an argument array and `shell:false`. The probe is injectable, fake/stale markers fail, real repositories and linked worktrees pass, and Git metadata directories are forbidden.
- Authorization headers are redacted to end-of-line regardless of authentication scheme; prefixed `*_API_KEY`, `*_TOKEN`, `*_SECRET`, and `*_PASSWORD` assignments are redacted. Error-safe messages are redacted then capped at 1,024 characters.

### GREEN and final validation

| Command | Result |
| --- | --- |
| Focused `npm test -- test/contracts.test.ts test/workspace-policy.test.ts test/stream-parser.test.ts test/diagnostics.test.ts` | 4 files passed, 48 tests passed. |
| `npm run test:coverage` | 6 files passed, 55 tests passed; 98.17% statements, 85.61% branches, 100% functions, 98.17% lines. All configured global thresholds passed. |
| `npm run typecheck` | Passed. |
| `npm run lint` | Passed. |
| `npm test` | 6 files passed, 55 tests passed. |
| `npm run build` | Passed; existing server and runner ESM bundles built. |
| `npm run validate` | `{"ok":true,"data":{}}`. |
| `npm run noodle:test` | Passed with normal loopback-listener permission and returned `{"ok":true,...}`. |

### Regression self-review and compatibility

- Usage is now one source of truth: strict persisted job schema and lossy stream sanitization share the same allowlist. No unsafe usage string has a public path.
- The Git probe does not use a shell, does not expand arguments, and returns the requested nested canonical workspace rather than a repository root. Linked worktrees are proved through an actual `git worktree add` fixture.
- Terminal state is first-write-wins. Known safe subtypes are additive optional data on `ClaudeError`; raw child error text is never kept.
- Public compatibility is preserved for existing valid inputs and snapshots: `gitProbe` and error `subtype` are optional additions. The intentional breaking behavior is rejecting previously ignored nested keys and unsafe `ClaudeJob.usage` fields, as required by this security fix.
- No production module imports the Noodle authoring-only entrypoint; no execution or MCP-registration behavior was added.

## Fix round 2 — quoted assignment redaction

### RED evidence

Added a diagnostics-only test for double-quoted, single-quoted escaped-character, newline-delimited, comma/semicolon-adjacent, and unquoted secret assignments. The focused command:

```text
npm test -- test/diagnostics.test.ts
```

initially exited nonzero: `CUSTOM_PASSWORD="synthetic secret with spaces"` became `CUSTOM_PASSWORD=[redacted] secret with spaces"`, proving that the prior unquoted-only value matcher leaked the quoted tail.

### Change and GREEN evidence

The assignment matcher now consumes one complete double-quoted value, one complete single-quoted value, including escaped characters, or an existing unquoted value. It stops before comma, semicolon, whitespace for unquoted values, or newline, preserving subsequent unrelated fields.

| Command | Result |
| --- | --- |
| Focused `npm test -- test/diagnostics.test.ts` | 1 file passed, 5 tests passed. |
| `npm run test:coverage` | 6 files passed, 56 tests passed; 98.17% statements, 85.61% branches, 100% functions, 98.17% lines. |
| `npm run typecheck` | Passed. |
| `npm run lint` | Passed. |
| `npm run build` | Passed. |
| `npm run validate` | `{"ok":true,"data":{}}`. |

### Regression self-review

- Quoted values are consumed as a single redaction unit; escaped quote characters do not terminate that unit.
- Unquoted values retain their prior comma/semicolon/whitespace boundaries.
- Newline is excluded from quoted matching, so a following line remains intact.
- The change is local to diagnostic sanitization and does not affect task input, stream, workspace, invocation, execution, or MCP boundaries.
