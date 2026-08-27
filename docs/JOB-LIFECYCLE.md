# Job lifecycle

Jobs move through a stable normalized state machine:

```text
queued -> running -> succeeded
                  -> failed
                  -> cancelled
                  -> timed_out
                  -> output_limited
                  -> orphaned
```

Terminal states never transition again.

## Starting and waiting

At most two jobs run concurrently. Additional jobs remain queued. Async mode returns immediately. Sync mode waits until the job is terminal or `timeout_seconds` expires. Auto mode waits for `wait_seconds`, then returns a current job view if work is still active. In every mode, `timeout_seconds` remains the runner deadline; returning an asynchronous job does not detach it from timeout, cancellation, output, or retention controls.

## Status and progress

`claude_job_status` returns normalized job metadata and a small sanitized progress tail. A job includes timestamps, access/model/effort, Claude session ID when emitted, exit information, usage/cost data when emitted, a result preview, and stable errors.

## Results

`claude_job_result` reads immutable terminal output in chunks of no more than 64 KiB. Pagination cursors are opaque, integrity-protected, and bound to a job/result version. Invalid or tampered cursors are rejected. UTF-8 characters are never split across page boundaries.

## Continuation

`claude_job_continue` starts a new bridge job tied to the prior job's captured Claude session. It accepts only `job_id`, a new prompt, and optional execution timing. It preserves workspace, access, model, effort, and maximum-turn ceiling, so continuation cannot become a privilege escalation.

## Cancellation, failure, and recovery

Cancellation records durable intent before the owning runner terminates its own process group gracefully and then forcibly if needed. Timeout and output-limit handling use the same owner-safe boundary. Startup recovery detects unverifiable runner ownership and marks affected jobs orphaned without signaling a process based only on stale persisted identifiers.

## Forgetting

Only terminal jobs can be forgotten. Forgetting removes bridge metadata and output. Claude Code's own transcript remains and must be managed separately.
