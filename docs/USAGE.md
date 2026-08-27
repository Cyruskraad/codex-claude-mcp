# Usage

Start with `claude_health`. It reports discovery, version/feature readiness, sanitized authentication readiness, model aliases, supported effort inputs, and current bridge capacity.

## Start a task

`claude_task` accepts an absolute existing workspace, a prompt, and optional access, model, effort, `max_turns`, session, and execution settings.

```json
{
  "workspace": "/absolute/path/to/repository",
  "prompt": "Inspect the retry implementation and identify race conditions. Do not edit files.",
  "access": "inspect",
  "model": "sonnet",
  "effort": "high",
  "max_turns": 20,
  "session": { "mode": "new" },
  "execution": { "mode": "auto", "wait_seconds": 45, "timeout_seconds": 1800 }
}
```

Use `access: "write"` only when the user has authorized edits. Write workspaces must be real Git worktrees. The bridge selects Claude Code's `acceptEdits` mode, which auto-approves file edits and Claude-classified common filesystem commands in the validated workspace; other commands and protected paths remain governed by Claude Code's normal permission rules. Local edit authorization does not authorize a commit, push, network action, publication, or other external effect; each requires separate target-scoped authorization.

Model can be a bridge alias (`sonnet`, `opus`, `haiku`, or `fable`) or a full Claude model ID accepted by the installed CLI. Effort can be `low`, `medium`, `high`, `xhigh`, or `max`. Health reports bridge support, not account entitlement.

## Sessions

```json
{ "mode": "new" }
{ "mode": "resume", "session_id": "explicit-session-id" }
{ "mode": "cloud_create", "description": "Review auth refactor" }
{ "mode": "cloud_attach", "target": "explicit-cloud-target" }
```

The bridge never resumes a “most recent” session. Cloud modes work only when the installed Claude Code version and account support them.

## Asynchronous jobs

Use `execution.mode: "async"` to return immediately, `"sync"` to wait until the job is terminal or `timeout_seconds` expires, or `"auto"` to wait for `wait_seconds` and then return the still-active job asynchronously. In every mode, `timeout_seconds` remains the runner deadline.

Poll `claude_job_status` with `job_id`, then call `claude_job_result`. Results are paginated at UTF-8-safe boundaries; pass the returned opaque `next_cursor` until it is absent.

Continue a captured session with:

```json
{
  "job_id": "job_example",
  "prompt": "Now explain the safest minimal fix.",
  "execution": { "mode": "auto" }
}
```

Continuation preserves the captured workspace, access, model, effort, maximum-turn ceiling, and explicit Claude session ID. It cannot escalate access.

Use `claude_job_cancel` for queued/running work. Use `claude_job_forget` only after a job is terminal; it removes bridge metadata/output but does not delete Claude Code's own transcript.

## Boundaries

Prompts go to Claude over stream-JSON stdin, not command-line arguments. Nested MCP, Chrome, additional directories, and permission-bypass flags are disabled. Do not put credentials or tokens in prompts.
