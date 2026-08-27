import { spawn, type ChildProcess } from 'node:child_process';
import { buildClaudeInvocation } from './claude-invocation.js';
import { CLOUD_CREATE_UNSUPPORTED_MESSAGE, type ClaudeError } from './contracts.js';
import { resolveClaudeExecutable } from './executable-resolution.js';
import { JobStore, JobStoreError } from './job-store.js';
import { createClaudeStreamAccumulator, ingestClaudeStreamLine, snapshotClaudeStream, type ClaudeStreamAccumulator } from './stream-parser.js';

export const MAX_OUTPUT_BYTES = 33_554_432;
const VERSION_OUTPUT_BYTES = 4_096;
const MIN_CLAUDE_VERSION = [2, 1, 0] as const;
type Signal = 'SIGTERM' | 'SIGKILL';
type TerminalIntent = 'cancelled' | 'timed_out' | 'output_limited';
type CancelDeadline = () => void;

export interface ExecuteRunnerOptions {
  store: JobStore; jobId: string; runnerToken: string; claudePath?: string; outputLimitBytes?: number; runnerPid?: number;
  environment?: NodeJS.ProcessEnv;
  scheduleDeadline?: (callback: () => void, milliseconds: number) => CancelDeadline;
  waitForGrace?: () => Promise<void>;
  signalRunnerGroup?: (runnerPid: number, signal: Signal) => Promise<void>;
  controlPollMilliseconds?: number;
  onPreflightSpawned?: (pid: number) => void;
  onClaudeSpawned?: (pid: number, topology: { detached: false }) => void;
}
interface ProcessResult { code: number | null; signal: NodeJS.Signals | null }

function normalizedError(code: ClaudeError['code']): ClaudeError {
  const messages: Record<ClaudeError['code'], string> = {
    'invalid-input': 'Invalid Claude task input.', 'invalid-workspace': 'Workspace is invalid.',
    'forbidden-workspace': 'Workspace is not allowed.', 'write-requires-git': 'Write access requires a Git worktree.',
    'unsupported-session-mode': CLOUD_CREATE_UNSUPPORTED_MESSAGE,
    'claude-not-found': 'Claude Code executable was not found.', 'claude-unsupported': 'Claude Code version is unsupported.',
    'auth-required': 'Claude Code authentication is required.', 'concurrency-limit': 'Claude concurrency limit was reached.',
    'job-not-found': 'Claude job was not found.', 'job-not-terminal': 'Claude job is not terminal.',
    'malformed-stream': 'Claude returned malformed stream output.', 'claude-failed': 'Claude execution failed.',
    cancelled: 'Claude job was cancelled.', 'timed-out': 'Claude job timed out.',
    'output-limited': 'Claude output exceeded the byte limit.', orphaned: 'Claude runner ownership could not be verified.',
    'internal-error': 'An internal error occurred.',
  };
  return { code, message: messages[code] };
}

export function supportedClaudeVersion(output: string): boolean {
  const match = output.trim().match(/^(?:Claude Code\s+)?v?(\d+)\.(\d+)\.(\d+)(?:\s+\(Claude Code\))?$/);
  if (!match) return false;
  const version = match.slice(1).map(Number);
  for (let index = 0; index < MIN_CLAUDE_VERSION.length; index += 1) {
    if (version[index] > MIN_CLAUDE_VERSION[index]) return true;
    if (version[index] < MIN_CLAUDE_VERSION[index]) return false;
  }
  return true;
}

async function defaultSignalRunnerGroup(runnerPid: number, signal: Signal): Promise<void> {
  try { process.kill(-runnerPid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
const defaultScheduleDeadline = (callback: () => void, milliseconds: number): CancelDeadline => {
  const timer = setTimeout(callback, milliseconds); timer.unref(); return () => clearTimeout(timer);
};
const defaultWaitForGrace = () => new Promise<void>((resolve) => { const timer = setTimeout(resolve, 1_000); timer.unref(); });

async function safelyPublishFailure(store: JobStore, jobId: string, code: ClaudeError['code']): Promise<void> {
  try {
    const record = await store.read(jobId);
    if (!['queued', 'running'].includes(record.job.state)) return;
    const control = await store.readControl(jobId);
    if (control.terminalIntent) { await store.finalizeTerminalIntent(jobId); return; }
    await store.publishTerminal(jobId, record.revision, { state: 'failed', result: Buffer.alloc(0), error: normalizedError(code) });
  } catch (error) {
    if (!(error instanceof JobStoreError && ['stale-revision', 'terminal-state'].includes(error.code))) throw error;
  }
}

export async function executeRunner(options: ExecuteRunnerOptions): Promise<void> {
  const { store } = options;
  let record = await store.read(options.jobId);
  if (record.job.state !== 'running' || record.runner.token !== options.runnerToken) return;
  const environment = options.environment ?? process.env;
  const resolvedClaude = await resolveClaudeExecutable(
    environment,
    options.claudePath === undefined ? undefined : { provided: true, value: options.claudePath },
  );
  if (!resolvedClaude.found) {
    await safelyPublishFailure(store, options.jobId, 'claude-not-found');
    return;
  }
  const claudePath = resolvedClaude.path;
  const runnerPid = options.runnerPid ?? process.pid;
  const signalRunnerGroup = options.signalRunnerGroup ?? defaultSignalRunnerGroup;
  const waitForGrace = options.waitForGrace ?? defaultWaitForGrace;
  const scheduleDeadline = options.scheduleDeadline ?? defaultScheduleDeadline;
  const outputLimit = options.outputLimitBytes ?? MAX_OUTPUT_BYTES;
  let child: ChildProcess | undefined;
  let reaped = true;
  let stopping: Promise<void> | undefined;
  let stopRequested = false;
  let phase: 'preflight' | 'claude' | 'idle' = 'idle';
  let intent: TerminalIntent | undefined;
  let rawByteCount = 0;
  let outputStopped = false;

  const stopOutput = () => {
    if (outputStopped) return;
    outputStopped = true;
    child?.stdout?.pause(); child?.stderr?.pause(); child?.stdout?.destroy(); child?.stderr?.destroy();
  };
  const requestStop = (requested: TerminalIntent): Promise<void> => {
    if (stopping) return stopping;
    stopRequested = true;
    intent = requested;
    stopping = (async () => {
      const latest = await store.read(options.jobId);
      const control = await store.readControl(options.jobId);
      if (!control.terminalIntent) await store.requestTerminalIntent(options.jobId, latest.revision, requested);
      else intent = control.terminalIntent;
      stopOutput();
      if (phase === 'idle' || reaped) return;
      await signalRunnerGroup(runnerPid, 'SIGTERM');
      await waitForGrace();
      if (!reaped) await signalRunnerGroup(runnerPid, 'SIGKILL');
    })();
    return stopping;
  };

  const sigtermHandler = () => { /* runner survives its own group TERM until child close */ };
  process.on('SIGTERM', sigtermHandler);
  const deadlineMilliseconds = Math.max(0, new Date(record.deadline ?? 0).getTime() - store.clock.now().getTime());
  const cancelDeadline = scheduleDeadline(() => { void requestStop('timed_out'); }, deadlineMilliseconds);
  const poll = setInterval(() => {
    void (async () => { if (!intent) { const control = await store.readControl(options.jobId); if (control.terminalIntent) await requestStop(control.terminalIntent); } })().catch(() => undefined);
  }, options.controlPollMilliseconds ?? 25);
  poll.unref();

  const runChild = async (args: string[], spawnOptions: Parameters<typeof spawn>[2], captureVersion = false): Promise<{ result: ProcessResult; version: string }> => {
    let version = '';
    child = spawn(claudePath, args, spawnOptions);
    reaped = false;
    const active = child;
    const close = new Promise<ProcessResult>((resolve) => {
      active.once('error', () => { reaped = true; resolve({ code: null, signal: null }); });
      active.once('close', (code, signal) => { reaped = true; resolve({ code, signal }); });
    });
    if (captureVersion && active.pid) options.onPreflightSpawned?.(active.pid);
    if (captureVersion) {
      const consume = (chunk: Buffer) => {
        if (outputStopped) return;
        const available = VERSION_OUTPUT_BYTES - Buffer.byteLength(version);
        if (chunk.byteLength > available) { void requestStop('output_limited'); return; }
        version += chunk.toString('utf8');
      };
      active.stdout?.on('data', consume); active.stderr?.on('data', consume);
    }
    const result = await close;
    if (child === active) child = undefined;
    return { result, version };
  };

  try {
    let version;
    phase = 'preflight';
    try { version = await runChild(['--version'], { cwd: '/', env: environment, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }, true); }
    catch { await safelyPublishFailure(store, options.jobId, 'claude-not-found'); return; }
    await stopping;
    if (intent || stopRequested) { await store.finalizeTerminalIntent(options.jobId); return; }
    let control = await store.readControl(options.jobId);
    if (control.terminalIntent) { await store.finalizeTerminalIntent(options.jobId); return; }
    if (version.result.code === null) { await safelyPublishFailure(store, options.jobId, 'claude-not-found'); return; }
    if (version.result.code !== 0 || !supportedClaudeVersion(version.version)) { await safelyPublishFailure(store, options.jobId, 'claude-unsupported'); return; }
    let privatePrompt: string;
    try { privatePrompt = await store.readRequest(options.jobId); } catch { await safelyPublishFailure(store, options.jobId, 'internal-error'); return; }
    record = await store.read(options.jobId);
    const invocation = buildClaudeInvocation({ ...record.task, prompt: privatePrompt });
    await store.removeRequest(options.jobId);

    control = await store.readControl(options.jobId);
    if (stopRequested || control.terminalIntent) { await store.finalizeTerminalIntent(options.jobId); return; }

    let parseError = false;
    let lineBuffer = Buffer.alloc(0);
    const accumulator = createClaudeStreamAccumulator();
    let processResult: ProcessResult;
    try {
      phase = 'claude';
      const running = runChild(invocation.args, { cwd: record.task.workspace, detached: false, env: environment, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      if (!child?.pid) { await safelyPublishFailure(store, options.jobId, 'claude-failed'); return; }
      const active = child;
      const consume = (chunk: Buffer, stdout: boolean) => {
        if (outputStopped) return;
        const available = Math.max(0, outputLimit - rawByteCount);
        const retained = chunk.subarray(0, available);
        rawByteCount += retained.byteLength;
        if (stdout && retained.byteLength > 0 && !parseError) {
          lineBuffer = Buffer.concat([lineBuffer, retained]);
          for (let newline = lineBuffer.indexOf(10); newline >= 0; newline = lineBuffer.indexOf(10)) {
            const line = lineBuffer.subarray(0, newline).toString('utf8'); lineBuffer = lineBuffer.subarray(newline + 1);
            try { ingestClaudeStreamLine(accumulator, line); } catch { parseError = true; lineBuffer = Buffer.alloc(0); }
          }
        }
        if (chunk.byteLength > available) { stopOutput(); void requestStop('output_limited'); }
      };
      active.stdout?.on('data', (chunk: Buffer) => consume(chunk, true));
      active.stderr?.on('data', (chunk: Buffer) => consume(chunk, false));
      active.stdin?.end(invocation.stdin); invocation.stdin = '';
      options.onClaudeSpawned?.(active.pid!, { detached: false });
      processResult = (await running).result;
    } catch { await safelyPublishFailure(store, options.jobId, 'claude-not-found'); return; }
    await stopping;
    if (!parseError && lineBuffer.byteLength > 0 && !intent) { try { ingestClaudeStreamLine(accumulator, lineBuffer.toString('utf8')); } catch { parseError = true; } }
    record = await store.read(options.jobId);
    if (record.job.state !== 'running') return;
    try { record = await store.updateProgress(options.jobId, record.revision, { rawByteCount, ...publicProgress(accumulator, privatePrompt) }); }
    catch (error) {
      if (error instanceof JobStoreError && error.code === 'terminal-intent') { await store.finalizeTerminalIntent(options.jobId); return; }
      if (error instanceof JobStoreError && ['stale-revision', 'terminal-state'].includes(error.code)) return;
      throw error;
    }
    if (intent) { await store.finalizeTerminalIntent(options.jobId); return; }
    const snapshot = snapshotClaudeStream(accumulator);
    const sessionId = snapshot.sessionId?.includes(privatePrompt) ? undefined : snapshot.sessionId;
    if (parseError) { await store.publishTerminal(options.jobId, record.revision, { state: 'failed', result: Buffer.alloc(0), error: normalizedError('malformed-stream'), exitCode: processResult.code, signal: processResult.signal }); return; }
    if (processResult.code !== 0 || snapshot.terminal !== 'success' || snapshot.result === undefined) {
      await store.publishTerminal(options.jobId, record.revision, { state: 'failed', result: Buffer.alloc(0), error: snapshot.error ?? normalizedError('claude-failed'), exitCode: processResult.code, signal: processResult.signal, sessionId }); return;
    }
    const safeResult = snapshot.result.split(privatePrompt).join('[redacted prompt]'); privatePrompt = '';
    await store.publishTerminal(options.jobId, record.revision, { state: 'succeeded', result: Buffer.from(safeResult), exitCode: processResult.code, signal: processResult.signal, sessionId, usage: snapshot.usage, totalCostUsd: snapshot.totalCostUsd });
  } finally { phase = 'idle'; cancelDeadline(); clearInterval(poll); process.off('SIGTERM', sigtermHandler); }
}

function publicProgress(accumulator: ClaudeStreamAccumulator, prompt: string): { sessionId?: string; progressTail: string[] } {
  const snapshot = snapshotClaudeStream(accumulator);
  const sessionId = snapshot.sessionId && !snapshot.sessionId.includes(prompt) ? snapshot.sessionId : undefined;
  return { ...(sessionId ? { sessionId } : {}), progressTail: snapshot.progressTail.map((item) => item.split(prompt).join('[redacted prompt]')) };
}
