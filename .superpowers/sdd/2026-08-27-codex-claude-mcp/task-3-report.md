# Task 3 Report: Private Durable Jobs and Detached Claude Runner

## Scope and outcome

Implemented Task 3 only. The change adds private durable job storage, an at-most-two-slot supervisor, a detached runner entrypoint, shell-free Claude Code execution, timeout/output/cancellation enforcement, restart reconciliation, continuation, authenticated UTF-8 result pagination, terminal cleanup, and fake-Claude integration coverage. Task 4 MCP registration remains untouched. No authenticated Claude invocation, hosted mutation, deployment, publication, or external write was performed.

## Files

Production:

- `src/contracts.ts` — strict public job-state timestamp and stable terminal-error invariants.
- `src/job-store.ts` — OS state-root resolution, private atomic files/directories, strict revisioned state/control schemas, CAS locking, terminal-intent recovery, result digest publication, and retention primitives.
- `src/job-service.ts` — submission, deterministic two-slot scheduling, sync/async/auto semantics, ownership reconciliation, status/result/continue/cancel/forget/cleanup/startup/shutdown, and cursor authentication.
- `src/runner-engine.ts` — Claude discovery/version gate, stream-JSON stdin invocation, byte-bounded stream processing, normalized completion/failure, timeout and process-group termination.
- `src/runner.ts` — detached bundle entrypoint with persisted ownership readiness.

Tests and fixtures:

- `test/fixtures/fake-claude.mjs`
- `test/job-store.test.ts`
- `test/job-service.test.ts`
- `test/runner-integration.test.ts`
- `test/runner-main.test.ts`
- `test/contracts.test.ts`
- `test/diagnostics.test.ts`
- `test/stream-parser.test.ts`

## Architecture and security boundaries

- The state root comes from an absolute `CODEX_CLAUDE_MCP_STATE_DIR` override or the macOS/Linux/WSL2 user-state convention. Native Windows is rejected. Root, jobs, and per-job directories are forced to `0700`; cursor keys and job files are `0600`; ineffective modes are detectable for WSL Windows-mounted paths.
- A job is prepared in a private same-parent temporary directory and atomically renamed into `jobs/<opaque-id>` only after all initial files are durable. Public job IDs are validated before path construction.
- The prompt exists at rest only in `request.json`. The runner prepares stream-JSON stdin and immediately removes that file. Raw stdout is counted and parsed in memory but is not persisted, preventing Claude prompt echoes from becoming a second prompt-at-rest copy. Exact prompt echoes in progress/session/result fields are dropped or redacted before publication.
- State updates use a same-directory exclusive update lock, explicit-mode temporary file, file flush, rename, and best-effort directory flush. Revisions provide CAS. Result bytes are flushed before terminal state publishes their SHA-256/version/length. A higher-revision terminal control intent acts as a write-ahead winner and is recoverable after a crash between control and state publication.
- The server launches `runner.mjs` with `process.execPath`, argument arrays, `detached:true`, `shell:false`, ignored stdio, and `unref()`. The nonsecret ownership token and opaque job ID are persisted and passed on runner argv. The runner waits until its persisted PID/token record matches before invoking Claude.
- Claude is discovered from `CODEX_CLAUDE_MCP_CLAUDE_PATH` or `PATH`, checked shell-free with `--version`, and must be semver `>=2.1.0`. Claude is its own detached process group, runs in the canonical workspace, receives the Task 2 argument array, and receives the prompt only through stdin.
- Output accounting caps combined stdout and stderr before UTF-8 decoding at 33,554,432 bytes; bytes beyond the cap are not retained. Stderr is never persisted or exposed. Timeout and output-limit states terminate and reap Claude and cannot later become success.
- The supervisor counts only ownership-proven running jobs, reconciles pending control intents, orphans unverifiable/reused/dead runner identities without killing them, and schedules queued jobs by `created_at,id`.
- Result cursors use an HMAC-protected opaque payload bound to job ID, result SHA-256, result version, and byte offset. Pages are at most 65,536 UTF-8 bytes and do not split a code point.

## RED evidence

1. Initial focused command:

   `npm test -- test/job-store.test.ts test/job-service.test.ts test/runner-integration.test.ts test/contracts.test.ts`

   Exit 1. Three suites failed because `job-store.js`, `job-service.js`, and `runner-engine.js` did not exist; the contract invariant test failed because running without `started_at` was accepted. Existing contract evidence was 27 passed, 1 failed; four test files failed as intended.

2. Concurrent CAS regression:

   `npm test -- test/job-store.test.ts -t 'allows only one concurrent writer'`

   Exit 1. Both same-revision writers fulfilled; expected exactly one. This led to the exclusive same-directory update lock.

3. Runner bundle entrypoint regression:

   `npm test -- test/runner-main.test.ts`

   Exit 1. All three cases failed with `runDetachedRunnerMain is not a function` before the testable entrypoint existed.

4. Security/lifecycle self-review regressions:

   Focused store/service/runner command exited 1 with six intended failures: path traversal was accepted, unverifiable running work still occupied a slot, an echoed prompt reached result/raw state, and stdout bytes were persisted.

5. Public invariant regression:

   `npm test -- test/contracts.test.ts -t 'enforces running'`

   Exit 1 because queued state still accepted `started_at`.

6. Terminal-intent crash-window regression:

   `npm test -- test/job-store.test.ts -t 'durable terminal intent'`

   Exit 1 because success overwrote a higher-revision cancelled control intent. The terminal-intent WAL/recovery rule then made cancellation win.

## Fresh GREEN evidence

- Focused Task 3: `npm test -- test/job-store.test.ts test/job-service.test.ts test/runner-integration.test.ts test/runner-main.test.ts test/contracts.test.ts` — exit 0; 5 files, 71 tests passed.
- Full suite: `npm test` — exit 0; 10 files, 103 tests passed.
- All-source coverage: `npm run test:coverage` — exit 0; 103 tests passed; 90.69% statements, 94.56% functions, 90.69% lines, 85.21% branches. Gates are 90/90/90/85.
- TypeScript: `npm run typecheck` — exit 0.
- ESLint: `npm run lint` — exit 0.
- Production bundle: `npm run build` — exit 0; `runner.mjs` and `server.mjs` built successfully for Node 20.
- Noodle validation: `npm run validate` — exit 0; canonical envelope `{"ok":true,"data":{}}`.
- Noodle local smoke: `npm run noodle:test` — exit 0 after the loopback permission substitution; canonical success envelope, modern protocol `2026-07-28`, existing authoring-only `authoring_status` surface. Task 4 registration was intentionally not added.

## Deterministic matrix self-review

1. Success: queued/running/succeeded persistence, session, exit, usage, cost, preview, and exact multi-page UTF-8 reconstruction are covered.
2. Malformed stream: stable `failed/malformed-stream`; offending bytes remain private and unexposed.
3. Auth/version: stable auth failure; malformed, too-old, exact-baseline, and newer semantic versions; missing executable path is sanitized.
4. Crash: before-result and after-partial-stream cases cannot publish false success or partial terminal result.
5. Sessions/secrecy: resume, cloud-create, and cloud-attach exact Task 2 arguments; prompt is stdin-only, removed from request storage, and prompt echoes are redacted.
6. Timeout: injected deadline proves TERM, grace, KILL, reap, and sticky `timed_out`.
7. Cancellation: queued and running cancellation, idempotent repeated cancelled cancellation, ownership mismatch/PID-reuse behavior, no unrelated kill, and durable terminal-intent recovery.
8. Output: exact boundary and one-byte-over for stdout and stderr without newline, combined byte accounting, no retention beyond the cap, and `output_limited` termination.
9. Concurrency: three gated jobs prove exactly two run, deterministic third queueing, and promotion after release; concurrent submission publication is atomic.
10. Restart: proven live runner retained; dead/unverifiable identity orphaned without kill; queued work resumes; scheduling does not count unverifiable running work.
11. Execution modes: async, sync, fast auto, and zero-wait auto promotion use one job each.
12. Cleanup: injected clock deletes only terminal work strictly older than seven days based on `finished_at`.
13. Durability: `0700`/`0600`, atomic complete-directory publication, concurrent same-revision CAS, stale revision, corrupt-state sanitization, and terminal WAL race.
14. Continuation: captured explicit session required; workspace/access/model/effort/max-turn ceiling is preserved; no override surface exists.
15. Result/forget: 64 KiB UTF-8 paging, multi-byte boundary, HMAC tamper, wrong-job, stale file/digest, active/missing forget errors, and terminal bridge-directory deletion.

## Platform substitutions and concerns

- The macOS managed sandbox denied negative process-group signaling (`kill EPERM`) in the output-boundary test. Those deterministic tests inject a positive child-PID terminator; the timeout test still proves TERM→KILL→reap ordering. Production remains detached process-group signaling with `kill(-pgid, signal)`. A real unsandboxed macOS/Linux/WSL2 process-group smoke remains for the later live verification task.
- The first Noodle smoke attempt failed only because the sandbox denied binding `127.0.0.1`. The exact same command passed with approved loopback permission.
- WSL2 was not available; ineffective-mode detection is exercised by deliberately weakening mode bits in a temporary state root.
- Per instruction, no real authenticated Claude was invoked. Claude authentication, real CLI compatibility, and OS process-group behavior remain unproven until the later live verification task.
- Noodle smoke reports only the existing authoring tool because Task 4 MCP registration is explicitly out of scope.

## Fix round 1: security/lifecycle review repairs

### RED evidence and review corrections

The inherited checkpoint claimed the focused store/service/runner suites were green. Fresh focused execution initially confirmed that claim (`85` tests), but a fresh coverage run exposed an interleaving bug in the scheduler: a new scheduling request returned the promise for an in-flight launcher pass and could be lost. The pre-fix deterministic regression `runs a requested follow-up scheduler pass after an in-flight launch finishes` failed as expected with `expected 'running' to be 'orphaned'`. The minimal fix queues exactly one follow-up pass; its focused execution then passed.

The same fresh full run also revealed that the inherited test `does not count an unverifiable running job as a concurrency slot` overclaimed its fixture: it made *every* runner unverifiable, including the asserted replacement. Continuous reconciliation correctly orphaned that replacement. The regression now marks only the original job dead; it proves the original consumes no slot and a proven-live replacement starts.

### Architecture changes verified in this round

- The server/service never calls `process.kill` and no persisted `claudePgid` exists. Cancellation stores and flushes terminal intent; only the live detached runner signals its own process group after that durable record.
- The runner is detached by the server, while both its version probe and Claude use `detached:false`, sharing the runner’s process group. This explicitly corrects the earlier report statement that “Claude is its own detached process group.” If `SIGKILL` kills the runner, startup finalizes the already-durable terminal intent.
- Scheduler and per-job updates use token/PID/birth-identity leases, reclaim only owners proven dead, and fail closed for bad/replaced locks. The global scheduler lease serializes independent `JobService` instances at the two-job cap.
- State-root/jobs-root symlinks are rejected before chmod, private reads use `O_NOFOLLOW`, stale owned staging prompts and terminal request remnants are removed safely, while unrelated staging is retained.
- The strict version gate rejects prerelease/suffixed output. The preflight probe is bounded by the same durable deadline. Combined stdout/stderr is capped before decoding and streams are destroyed when capped, including TERM-ignoring no-newline floods.

### Regression coverage added or strengthened

- dead/live lock reclaim and replacement-lock preservation; staged prompt cleanup; terminal request-remnant cleanup; final-directory collision;
- two services sharing one root launch at most two jobs; launch-before-record cancellation leaves durable control for the acknowledged runner; coalesced scheduler calls force one follow-up reconciliation pass;
- exact complete argv for resume/cloud modes, strict semver variants, combined sustained stdout/stderr flood, terminal intent before TERM/KILL, runner same-group topology, and deadline during a hanging preflight;
- service cancellation has no signal path, state/jobs roots reject symlinks, and prompt remains absent from public state/output.

### Final verification ledger

Final commands and their exact fresh output are appended after the final rerun below. The intended gates are: focused Task 3 suite; full `npm test`; `npm run test:coverage` at >=90% statements/functions/lines and >=85% branches; `npm run typecheck`; `npm run lint`; `npm run build`; `npm run validate`; and `npm run noodle:test`.

### Remaining live-only concerns

- The fake-Claude suite proves the durable signaling order and same-group spawn topology, but an unsandboxed macOS/Linux/WSL2 smoke is still needed to prove actual group-wide `SIGTERM`/`SIGKILL` delivery.
- No authenticated Claude CLI was invoked, so real installed-CLI compatibility and authentication behavior remain a later live verification concern.
- Noodle smoke only exercises the existing authoring surface; Task 4 MCP tool registration remains outside this task.

### Final fresh command outputs

- `npm test` — exit 0: 10 files passed, 120 tests passed.
- `npm run test:coverage` — exit 0: 10 files passed, 120 tests passed; all-source coverage was 93.37% statements, 95.14% functions, 93.37% lines, and 85.21% branches (gates: 90/90/90/85).
- `npm run typecheck` — exit 0 (`tsc --noEmit`).
- `npm run lint` — exit 0 (`eslint .`).
- `npm run build` — exit 0; Node 20 production bundles `runner.mjs` and `server.mjs` built successfully.
- `npm run validate` — exit 0; canonical envelope `{"ok":true,"data":{}}`.
- `npm run noodle:test` — the sandboxed attempt exited 1 with `listen EPERM: operation not permitted 127.0.0.1`; rerun with approved loopback-only permission exited 0 and returned `{"ok":true,"data":{"endpoint":"http://127.0.0.1:57562/o/local/codex-claude-mcp-authoring/dev/mcp","protocol":{"era":"modern","version":"2026-07-28"},"tools":["authoring_status"]}}`.
