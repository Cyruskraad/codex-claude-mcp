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
