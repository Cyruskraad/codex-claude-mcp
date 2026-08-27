import { spawn, type ChildProcess } from 'node:child_process';
import { buildClaudeInvocation } from './claude-invocation.js';
import type { ClaudeError } from './contracts.js';
import { JobStore, JobStoreError } from './job-store.js';
import {
  createClaudeStreamAccumulator, ingestClaudeStreamLine, snapshotClaudeStream, type ClaudeStreamAccumulator,
} from './stream-parser.js';

export const MAX_OUTPUT_BYTES = 33_554_432;
const MIN_CLAUDE_VERSION = [2, 1, 0] as const;

type Signal = 'SIGTERM' | 'SIGKILL';
type CancelDeadline = () => void;

export interface ExecuteRunnerOptions {
  store: JobStore;
  jobId: string;
  runnerToken: string;
  claudePath?: string;
  outputLimitBytes?: number;
  scheduleDeadline?: (callback: () => void, milliseconds: number) => CancelDeadline;
  waitForGrace?: () => Promise<void>;
  terminateProcessGroup?: (pgid: number, signal: Signal) => Promise<void>;
  onClaudeSpawned?: (pid: number) => void;
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function normalizedError(code: ClaudeError['code']): ClaudeError {
  const messages: Record<ClaudeError['code'], string> = {
    'invalid-input': 'Invalid Claude task input.',
    'invalid-workspace': 'Workspace is invalid.',
    'forbidden-workspace': 'Workspace is not allowed.',
    'write-requires-git': 'Write access requires a Git worktree.',
    'claude-not-found': 'Claude Code executable was not found.',
    'claude-unsupported': 'Claude Code version is unsupported.',
    'auth-required': 'Claude Code authentication is required.',
    'concurrency-limit': 'Claude concurrency limit was reached.',
    'job-not-found': 'Claude job was not found.',
    'job-not-terminal': 'Claude job is not terminal.',
    'malformed-stream': 'Claude returned malformed stream output.',
    'claude-failed': 'Claude execution failed.',
    cancelled: 'Claude job was cancelled.',
    'timed-out': 'Claude job timed out.',
    'output-limited': 'Claude output exceeded the byte limit.',
    orphaned: 'Claude runner ownership could not be verified.',
    'internal-error': 'An internal error occurred.',
  };
  return { code, message: messages[code] };
}

function spawnAndCapture(command: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch (error) { reject(error); return; }
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stdout) < 512) stdout += chunk.toString('utf8').slice(0, 512 - Buffer.byteLength(stdout));
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout }));
  });
}

function supportedVersion(output: string): boolean {
  const match = output.trim().match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\D|$)/);
  if (!match) return false;
  const version = match.slice(1).map(Number);
  for (let index = 0; index < MIN_CLAUDE_VERSION.length; index += 1) {
    if (version[index] > MIN_CLAUDE_VERSION[index]) return true;
    if (version[index] < MIN_CLAUDE_VERSION[index]) return false;
  }
  return true;
}

async function defaultTerminateProcessGroup(pgid: number, signal: Signal): Promise<void> {
  try { process.kill(-pgid, signal); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

const defaultScheduleDeadline = (callback: () => void, milliseconds: number): CancelDeadline => {
  const timer = setTimeout(callback, milliseconds);
  timer.unref();
  return () => clearTimeout(timer);
};

const defaultWaitForGrace = () => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, 1_000);
  timer.unref();
});

async function safelyPublishFailure(store: JobStore, jobId: string, code: ClaudeError['code']): Promise<void> {
  try {
    const record = await store.read(jobId);
    if (!['queued', 'running'].includes(record.job.state)) return;
    await store.publishTerminal(jobId, record.revision, { state: 'failed', result: Buffer.alloc(0), error: normalizedError(code) });
  } catch (error) {
    if (!(error instanceof JobStoreError && ['stale-revision', 'terminal-state'].includes(error.code))) throw error;
  }
}

export async function executeRunner(options: ExecuteRunnerOptions): Promise<void> {
  const store = options.store;
  let record = await store.read(options.jobId);
  if (record.job.state !== 'running' || record.runner.token !== options.runnerToken) return;
  const claudePath = options.claudePath ?? process.env.CODEX_CLAUDE_MCP_CLAUDE_PATH ?? 'claude';

  let version;
  try { version = await spawnAndCapture(claudePath, ['--version']); } catch {
    await safelyPublishFailure(store, options.jobId, 'claude-not-found');
    return;
  }
  if (version.code !== 0 || !supportedVersion(version.stdout)) {
    await safelyPublishFailure(store, options.jobId, 'claude-unsupported');
    return;
  }

  let privatePrompt: string;
  try { privatePrompt = await store.readRequest(options.jobId); } catch {
    await safelyPublishFailure(store, options.jobId, 'internal-error');
    return;
  }
  const invocation = buildClaudeInvocation({ ...record.task, prompt: privatePrompt });
  await store.removeRequest(options.jobId);

  let child: ChildProcess;
  try {
    child = spawn(claudePath, invocation.args, {
      cwd: record.task.workspace,
      detached: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    await safelyPublishFailure(store, options.jobId, 'claude-not-found');
    return;
  }
  const pid = child.pid;
  if (!pid) {
    await safelyPublishFailure(store, options.jobId, 'claude-failed');
    return;
  }
  try {
    record = await store.updateRunner(options.jobId, record.revision, { claudePgid: pid });
  } catch (error) {
    await defaultTerminateProcessGroup(pid, 'SIGTERM');
    if (error instanceof JobStoreError && error.code === 'terminal-intent') {
      await store.recoverTerminalIntent(options.jobId);
      return;
    }
    if (!(error instanceof JobStoreError && error.code === 'stale-revision')) throw error;
    return;
  }

  const outputLimit = options.outputLimitBytes ?? MAX_OUTPUT_BYTES;
  const terminate = options.terminateProcessGroup ?? defaultTerminateProcessGroup;
  const waitForGrace = options.waitForGrace ?? defaultWaitForGrace;
  const scheduleDeadline = options.scheduleDeadline ?? defaultScheduleDeadline;
  let reaped = false;
  let rawByteCount = 0;
  let lineBuffer = Buffer.alloc(0);
  let parseError = false;
  let outputLimited = false;
  let timedOut = false;
  let termination: Promise<void> | undefined;
  const accumulator = createClaudeStreamAccumulator();

  const closePromise = new Promise<ProcessResult>((resolve) => {
    child.once('error', () => resolve({ code: null, signal: null }));
    child.once('close', (code, signal) => { reaped = true; resolve({ code, signal }); });
  });

  const terminateAndReap = (intent: 'timed_out' | 'output_limited'): Promise<void> => {
    if (termination) return termination;
    if (intent === 'timed_out') timedOut = true;
    if (intent === 'output_limited') outputLimited = true;
    termination = (async () => {
      await terminate(pid, 'SIGTERM');
      await waitForGrace();
      if (!reaped) await terminate(pid, 'SIGKILL');
    })();
    return termination;
  };

  const consume = async (chunk: Buffer, isStdout: boolean): Promise<void> => {
    if (outputLimited) return;
    const available = Math.max(0, outputLimit - rawByteCount);
    const retained = chunk.subarray(0, available);
    rawByteCount += retained.byteLength;
    if (isStdout && retained.byteLength > 0) {
      if (!parseError) {
        lineBuffer = Buffer.concat([lineBuffer, retained]);
        let newline = lineBuffer.indexOf(10);
        while (newline >= 0) {
          const line = lineBuffer.subarray(0, newline).toString('utf8');
          lineBuffer = lineBuffer.subarray(newline + 1);
          try { ingestClaudeStreamLine(accumulator, line); } catch { parseError = true; lineBuffer = Buffer.alloc(0); }
          newline = lineBuffer.indexOf(10);
        }
      }
    }
    if (chunk.byteLength > available) await terminateAndReap('output_limited');
  };

  let serialized = Promise.resolve();
  child.stdout?.on('data', (chunk: Buffer) => { serialized = serialized.then(() => consume(chunk, true)); });
  child.stderr?.on('data', (chunk: Buffer) => { serialized = serialized.then(() => consume(chunk, false)); });
  child.stdin?.end(invocation.stdin);
  invocation.stdin = '';

  const deadlineMilliseconds = Math.max(0, new Date(record.deadline ?? Date.now()).getTime() - store.clock.now().getTime());
  const cancelDeadline = scheduleDeadline(() => { void terminateAndReap('timed_out'); }, deadlineMilliseconds);
  options.onClaudeSpawned?.(pid);
  const processResult = await closePromise;
  cancelDeadline();
  await serialized;
  await termination;
  if (!parseError && lineBuffer.byteLength > 0 && !outputLimited) {
    try { ingestClaudeStreamLine(accumulator, lineBuffer.toString('utf8')); } catch { parseError = true; }
  }

  try {
    record = await store.updateProgress(options.jobId, record.revision, {
      rawByteCount,
      ...publicProgress(accumulator, privatePrompt),
    });
  } catch (error) {
    if (error instanceof JobStoreError && error.code === 'terminal-intent') {
      await store.recoverTerminalIntent(options.jobId);
      return;
    }
    if (error instanceof JobStoreError && ['stale-revision', 'terminal-state'].includes(error.code)) return;
    throw error;
  }

  const snapshot = snapshotClaudeStream(accumulator);
  const sessionId = snapshot.sessionId?.includes(privatePrompt) ? undefined : snapshot.sessionId;
  if (timedOut) {
    await store.setTerminalIntent(options.jobId, record.revision, 'timed_out');
    return;
  }
  if (outputLimited) {
    await store.setTerminalIntent(options.jobId, record.revision, 'output_limited');
    return;
  }
  if (parseError) {
    await store.publishTerminal(options.jobId, record.revision, { state: 'failed', result: Buffer.alloc(0), error: normalizedError('malformed-stream'), exitCode: processResult.code, signal: processResult.signal });
    return;
  }
  if (processResult.code !== 0 || snapshot.terminal !== 'success' || snapshot.result === undefined) {
    const error = snapshot.error ?? normalizedError('claude-failed');
    await store.publishTerminal(options.jobId, record.revision, { state: 'failed', result: Buffer.alloc(0), error, exitCode: processResult.code, signal: processResult.signal, sessionId });
    return;
  }
  const safeResult = snapshot.result.split(privatePrompt).join('[redacted prompt]');
  privatePrompt = '';
  await store.publishTerminal(options.jobId, record.revision, {
    state: 'succeeded', result: Buffer.from(safeResult), exitCode: processResult.code, signal: processResult.signal,
    sessionId, usage: snapshot.usage, totalCostUsd: snapshot.totalCostUsd,
  });
}

function publicProgress(accumulator: ClaudeStreamAccumulator, prompt: string): { sessionId?: string; progressTail: string[] } {
  const snapshot = snapshotClaudeStream(accumulator);
  const sessionId = snapshot.sessionId && !snapshot.sessionId.includes(prompt) ? snapshot.sessionId : undefined;
  return {
    ...(sessionId ? { sessionId } : {}),
    progressTail: snapshot.progressTail.map((item) => item.split(prompt).join('[redacted prompt]')),
  };
}
