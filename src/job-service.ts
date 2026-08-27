import { createHash, createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import {
  chmod, link, lstat, mkdir, open, readFile, unlink,
} from 'node:fs/promises';
import { platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CLOUD_CREATE_UNSUPPORTED_MESSAGE, ClaudeContractError, type ClaudeJob, type ClaudeTaskInput, parseClaudeTaskInput,
} from './contracts.js';
import {
  JobStore, JobStoreError, RETENTION_MILLISECONDS, type Clock, type InternalJobRecord,
} from './job-store.js';
import { currentProcessIdentity, inspectProcessIdentity, type ProcessIdentityInspector } from './process-identity.js';
import { validateWorkspace, type ValidatedWorkspace } from './workspace-policy.js';

const MAX_CONCURRENT_JOBS = 2;
const RESULT_PAGE_BYTES = 65_536;
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'output_limited', 'orphaned']);

export interface JobStatusView { job: ClaudeJob; progress_tail: string[] }
export interface JobResultPage extends JobStatusView { result: string; next_cursor?: string }

export interface RunnerLaunchRequest { stateRoot: string; jobId: string; runnerToken: string }
export interface RunnerLaunchResult { pid: number; birthIdentity?: string }
export interface RunnerLauncher {
  prepare?(stateRoot: string): Promise<void>;
  launch(request: RunnerLaunchRequest): Promise<RunnerLaunchResult>;
}
export type OwnershipVerifier = (record: InternalJobRecord) => Promise<boolean>;

export interface JobServiceOptions {
  stateRoot?: string;
  clock?: Clock;
  workspaceValidator?: (path: string, options: { access: 'inspect' | 'write' }) => Promise<ValidatedWorkspace>;
  launcher?: RunnerLauncher;
  ownershipVerifier?: OwnershipVerifier;
  processIdentityInspector?: ProcessIdentityInspector;
  idGenerator?: () => string;
  tokenGenerator?: () => string;
  supervisorIntervalMilliseconds?: number;
}

const cursorSchema = z.object({
  jobId: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/), version: z.literal(1), offset: z.number().int().nonnegative(),
}).strict();

function asContractError(error: unknown): never {
  if (error instanceof ClaudeContractError) throw error;
  if (error instanceof JobStoreError) {
    const supported = ['job-not-found', 'job-not-terminal', 'invalid-input'] as const;
    const code = supported.find((candidate) => candidate === error.code) ?? 'internal-error';
    throw new ClaudeContractError(code, error.message);
  }
  throw new ClaudeContractError('internal-error', 'An internal error occurred.');
}

async function spawnCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
    catch { resolve(''); return; }
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < 2048) stdout += chunk.toString('utf8').slice(0, 2048 - stdout.length); });
    child.once('error', () => resolve(''));
    child.once('close', (code) => resolve(code === 0 ? stdout : ''));
  });
}

export async function verifyRunnerOwnership(record: InternalJobRecord, inspector: ProcessIdentityInspector = inspectProcessIdentity): Promise<boolean> {
  const pid = record.runner.pid;
  if (!pid) return false;
  let command = '';
  if (platform() === 'linux') {
    try { command = (await readFile(`/proc/${pid}/cmdline`)).toString('utf8').replaceAll('\0', ' '); } catch { return false; }
  } else if (platform() === 'darwin') {
    command = await spawnCapture('ps', ['-p', String(pid), '-o', 'command=']);
  } else return false;
  if (!command.includes(record.runner.token) || !command.includes(record.job.id)) return false;
  if (record.runner.birthIdentity) {
    const observed = await inspector(pid);
    return observed.state === 'live' && observed.birthIdentity === record.runner.birthIdentity;
  }
  return true;
}

class DetachedRunnerLauncher implements RunnerLauncher {
  private stableRunnerPath?: string;
  constructor(private readonly inspector: ProcessIdentityInspector) {}

  async prepare(stateRoot: string): Promise<void> {
    if (this.stableRunnerPath) return;
    const sourcePath = fileURLToPath(new URL('./runner.mjs', import.meta.url));
    let sourceHandle;
    try {
      sourceHandle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let source: Buffer;
    try {
      const metadata = await sourceHandle.stat();
      if (!metadata.isFile() || metadata.size > 4 * 1024 * 1024) throw new Error('Runner artifact is unsafe.');
      source = await sourceHandle.readFile();
    } finally { await sourceHandle.close(); }

    const digest = createHash('sha256').update(source).digest('hex');
    const runtimeRoot = join(stateRoot, 'runtime');
    try { await mkdir(runtimeRoot, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const runtimeMetadata = await lstat(runtimeRoot);
    if (!runtimeMetadata.isDirectory() || runtimeMetadata.isSymbolicLink()) throw new Error('Runner runtime directory is unsafe.');
    await chmod(runtimeRoot, 0o700);

    const target = join(runtimeRoot, `runner-${digest}.mjs`);
    const temporary = join(runtimeRoot, `.runner-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
    let temporaryHandle;
    try {
      temporaryHandle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await temporaryHandle.writeFile(source);
      await temporaryHandle.sync();
    } finally { await temporaryHandle?.close(); }
    try {
      try { await link(temporary, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { await unlink(temporary).catch(() => undefined); }

    const targetMetadata = await lstat(target);
    if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink()) throw new Error('Runner artifact is unsafe.');
    const targetHandle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    let targetDigest: string;
    try { targetDigest = createHash('sha256').update(await targetHandle.readFile()).digest('hex'); }
    finally { await targetHandle.close(); }
    if (targetDigest !== digest) throw new Error('Runner artifact failed integrity verification.');
    await chmod(target, 0o600);
    this.stableRunnerPath = target;
  }

  async launch(request: RunnerLaunchRequest): Promise<RunnerLaunchResult> {
    await this.prepare(request.stateRoot);
    const runnerPath = this.stableRunnerPath;
    if (!runnerPath) throw new Error('Runner artifact is unavailable.');
    const child = spawn(process.execPath, [
      runnerPath, '--state-root', request.stateRoot, '--job-id', request.jobId, '--runner-token', request.runnerToken,
    ], { cwd: '/', detached: true, shell: false, stdio: 'ignore', windowsHide: true });
    if (!child.pid) throw new Error('Runner did not start.');
    child.unref();
    const identity = await this.inspector(child.pid);
    if (identity.state !== 'live') throw new Error('Runner identity could not be verified.');
    return { pid: child.pid, birthIdentity: identity.birthIdentity };
  }
}

export class JobService {
  readonly store: JobStore;
  private readonly clock: Clock;
  private readonly workspaceValidator: NonNullable<JobServiceOptions['workspaceValidator']>;
  private readonly launcher: RunnerLauncher;
  private ownershipVerifier: OwnershipVerifier;
  private readonly processIdentityInspector: ProcessIdentityInspector;
  private ownProcessBirthIdentity?: string;
  private readonly idGenerator: () => string;
  private readonly tokenGenerator: () => string;
  private readonly events = new EventEmitter();
  private supervisor?: NodeJS.Timeout;
  private readonly supervisorIntervalMilliseconds: number;
  private scheduling?: Promise<void>;
  private rescheduleRequested = false;
  private acceptance: Promise<void> = Promise.resolve();

  constructor(options: JobServiceOptions = {}) {
    this.processIdentityInspector = options.processIdentityInspector ?? inspectProcessIdentity;
    this.store = new JobStore({ stateRoot: options.stateRoot, clock: options.clock, processIdentityInspector: this.processIdentityInspector });
    this.clock = options.clock ?? this.store.clock;
    this.workspaceValidator = options.workspaceValidator ?? ((path, policy) => validateWorkspace(path, policy));
    this.launcher = options.launcher ?? new DetachedRunnerLauncher(this.processIdentityInspector);
    this.ownershipVerifier = options.ownershipVerifier ?? verifyRunnerOwnership;
    this.idGenerator = options.idGenerator ?? (() => `job_${randomBytes(18).toString('base64url')}`);
    this.tokenGenerator = options.tokenGenerator ?? (() => randomBytes(24).toString('base64url'));
    this.supervisorIntervalMilliseconds = options.supervisorIntervalMilliseconds ?? 250;
  }

  setOwnershipVerifier(verifier: OwnershipVerifier): void { this.ownershipVerifier = verifier; }

  private async ownBirthIdentity(): Promise<string> {
    if (this.ownProcessBirthIdentity) return this.ownProcessBirthIdentity;
    const identity = await currentProcessIdentity(this.processIdentityInspector);
    if (!identity) throw new JobStoreError('internal-error', 'Current process identity could not be verified.');
    this.ownProcessBirthIdentity = identity;
    return identity;
  }

  private async runnerLiveness(record: InternalJobRecord): Promise<'live' | 'dead' | 'unknown'> {
    if (!record.runner.pid) return 'dead';
    const observed = await this.processIdentityInspector(record.runner.pid);
    if (observed.state !== 'live') return observed.state;
    const launching = record.runner.birthIdentity?.match(/^launching:(.+)$/);
    if (launching) return observed.birthIdentity === launching[1] ? 'live' : 'dead';
    return (await this.ownershipVerifier(record)) ? 'live' : 'dead';
  }

  async startup(): Promise<void> {
    await this.store.init();
    await this.launcher.prepare?.(this.store.stateRoot);
    await this.cleanup();
    for (const record of await this.store.list()) {
      if (record.job.state !== 'running') continue;
      const liveness = await this.runnerLiveness(record);
      const control = await this.store.readControl(record.job.id);
      if (control.terminalIntent) {
        if (liveness !== 'dead') continue;
        await this.store.finalizeTerminalIntent(record.job.id);
        continue;
      }
      if (liveness !== 'dead') continue;
      try {
        await this.store.publishTerminal(record.job.id, record.revision, {
          state: 'orphaned', result: Buffer.alloc(0), error: { code: 'orphaned', message: 'Claude runner ownership could not be verified.' },
        });
      } catch (error) {
        if (!(error instanceof JobStoreError && error.code === 'stale-revision')) throw error;
      }
    }
    await this.schedule();
    if (!this.supervisor) {
      this.supervisor = setInterval(() => { void this.supervise(); }, this.supervisorIntervalMilliseconds);
      this.supervisor.unref();
    }
  }

  private async supervise(): Promise<void> {
    await this.schedule();
    await this.cleanup();
    const records = await this.store.list();
    for (const record of records) if (TERMINAL_STATES.has(record.job.state)) this.notifyChanged(record.job.id);
  }

  async shutdown(): Promise<void> {
    if (this.supervisor) clearInterval(this.supervisor);
    this.supervisor = undefined;
  }

  async submitTask(input: ClaudeTaskInput): Promise<JobStatusView> {
    const parsed = parseClaudeTaskInput(input);
    if (parsed.session.mode === 'cloud_create') {
      throw new ClaudeContractError('unsupported-session-mode', CLOUD_CREATE_UNSUPPORTED_MESSAGE);
    }
    const workspace = await this.workspaceValidator(parsed.workspace, { access: parsed.access });
    const task = { ...parsed, workspace: workspace.canonicalPath };
    const previousAcceptance = this.acceptance;
    let releaseAcceptance!: () => void;
    this.acceptance = new Promise<void>((resolve) => { releaseAcceptance = resolve; });
    await previousAcceptance;
    let record: InternalJobRecord;
    try {
      record = await this.store.create(task, this.idGenerator(), this.tokenGenerator());
      await this.schedule();
    } finally { releaseAcceptance(); }
    if (task.execution.mode === 'async') return this.getJobStatus(record.job.id);
    const waitMilliseconds = (task.execution.mode === 'sync' ? task.execution.timeout_seconds : task.execution.wait_seconds) * 1000;
    return this.waitForTerminal(record.job.id, waitMilliseconds);
  }

  async schedule(): Promise<void> {
    if (this.scheduling) {
      this.rescheduleRequested = true;
      return this.scheduling;
    }
    this.scheduling = (async () => {
      do {
        this.rescheduleRequested = false;
        await this.scheduleInternal();
      } while (this.rescheduleRequested);
    })().finally(() => { this.scheduling = undefined; });
    return this.scheduling;
  }

  private async scheduleInternal(): Promise<void> {
    const claimed = await this.store.withSchedulerLease(async () => {
      const records = await this.store.list();
      const launches: InternalJobRecord[] = [];
      let running = 0;
      for (const record of records.filter((candidate) => candidate.job.state === 'running')) {
        try {
          const liveness = await this.runnerLiveness(record);
          const control = await this.store.readControl(record.job.id);
          if (control.terminalIntent) {
            if (liveness !== 'dead') running += 1;
            else await this.store.finalizeTerminalIntent(record.job.id);
          } else if (liveness !== 'dead') running += 1;
          else await this.store.publishTerminal(record.job.id, record.revision, {
            state: 'orphaned', result: Buffer.alloc(0), error: { code: 'orphaned', message: 'Claude runner ownership could not be verified.' },
          });
        } catch (error) {
          if (!(error instanceof JobStoreError && error.code === 'stale-revision')) throw error;
        }
      }
      for (const queued of records.filter((record) => record.job.state === 'queued')) {
        const control = await this.store.readControl(queued.job.id);
        if (control.terminalIntent) {
          await this.store.finalizeTerminalIntent(queued.job.id);
          continue;
        }
        if (running >= MAX_CONCURRENT_JOBS) break;
        launches.push(await this.store.claim(queued.job.id, queued.revision, { pid: process.pid, birthIdentity: `launching:${await this.ownBirthIdentity()}` }));
        running += 1;
      }
      return launches;
    });
    for (const job of claimed) {
      try {
        const launched = await this.launcher.launch({ stateRoot: this.store.stateRoot, jobId: job.job.id, runnerToken: job.runner.token });
        const latest = await this.store.read(job.job.id);
        if (latest.job.state === 'running') await this.store.updateRunner(latest.job.id, latest.revision, launched);
      } catch {
        const latest = await this.store.read(job.job.id);
        if (latest.job.state === 'running') {
          await this.store.publishTerminal(latest.job.id, latest.revision, {
            state: 'failed', result: Buffer.alloc(0), error: { code: 'internal-error', message: 'Claude runner could not be started.' },
          });
        }
      }
    }
  }

  notifyChanged(jobId: string): void {
    this.events.emit(jobId);
    void this.schedule();
    void this.cleanup();
  }

  async getJobStatus(jobId: string): Promise<JobStatusView> {
    try {
      const record = await this.store.read(jobId);
      return { job: record.job, progress_tail: [...record.progressTail] };
    } catch (error) { return asContractError(error); }
  }

  private async waitForTerminal(jobId: string, milliseconds: number): Promise<JobStatusView> {
    let status = await this.getJobStatus(jobId);
    if (TERMINAL_STATES.has(status.job.state) || milliseconds <= 0) return status;
    await new Promise<void>((resolve) => {
      const changed = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { this.events.off(jobId, changed); resolve(); }, milliseconds);
      timer.unref();
      this.events.once(jobId, changed);
    });
    status = await this.getJobStatus(jobId);
    return status;
  }

  async cancelJob(jobId: string): Promise<JobStatusView> {
    let record: InternalJobRecord;
    try { record = await this.store.read(jobId); } catch (error) { return asContractError(error); }
    if (record.job.state === 'cancelled') return { job: record.job, progress_tail: record.progressTail };
    if (TERMINAL_STATES.has(record.job.state)) throw new ClaudeContractError('job-not-terminal', 'Terminal Claude job cannot be cancelled.');
    try {
      await this.store.requestTerminalIntent(jobId, record.revision, 'cancelled');
      if (record.job.state === 'queued') record = (await this.store.finalizeTerminalIntent(jobId)) ?? record;
      else record = await this.store.read(jobId);
    } catch (error) { return asContractError(error); }
    this.notifyChanged(jobId);
    return { job: record.job, progress_tail: record.progressTail };
  }

  async continueJob(jobId: string, prompt: string, execution: ClaudeTaskInput['execution'] = { mode: 'auto' }): Promise<JobStatusView> {
    let source: InternalJobRecord;
    try { source = await this.store.read(jobId); } catch (error) { return asContractError(error); }
    if (!TERMINAL_STATES.has(source.job.state)) throw new ClaudeContractError('job-not-terminal', 'Continuation requires a terminal Claude job.');
    if (!source.job.claude_session_id) throw new ClaudeContractError('invalid-input', 'Continuation requires an explicit captured Claude session.');
    return this.submitTask({
      workspace: source.task.workspace, prompt, access: source.task.access,
      ...(source.task.model ? { model: source.task.model } : {}),
      ...(source.task.effort ? { effort: source.task.effort } : {}),
      max_turns: source.task.max_turns,
      session: { mode: 'resume', session_id: source.job.claude_session_id },
      execution,
    });
  }

  async getJobResult(jobId: string, cursor?: string): Promise<JobResultPage> {
    let record: InternalJobRecord;
    try { record = await this.store.read(jobId); } catch (error) { return asContractError(error); }
    if (!TERMINAL_STATES.has(record.job.state) || !record.result) throw new ClaudeContractError('job-not-terminal', 'Claude job result is not available.');
    const key = await this.store.cursorKey();
    let offset = 0;
    if (cursor) {
      try {
        const [payload, suppliedMac, extra] = cursor.split('.');
        if (!payload || !suppliedMac || extra) throw new Error();
        const expectedMac = createHmac('sha256', key).update(payload).digest('base64url');
        if (suppliedMac !== expectedMac) throw new Error();
        const parsed = cursorSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
        if (parsed.jobId !== jobId || parsed.digest !== record.result.sha256 || parsed.version !== record.result.version) throw new Error();
        offset = parsed.offset;
      } catch { throw new ClaudeContractError('invalid-input', 'Result cursor is invalid.'); }
    }
    const bytes = await this.store.readResult(jobId);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== record.result.byteLength || digest !== record.result.sha256 || offset > bytes.byteLength) {
      throw new ClaudeContractError('invalid-input', 'Result cursor is stale.');
    }
    let end = Math.min(bytes.byteLength, offset + RESULT_PAGE_BYTES);
    while (end < bytes.byteLength && end > offset && (bytes[end] & 0xc0) === 0x80) end -= 1;
    if (end === offset && end < bytes.byteLength) {
      end = Math.min(bytes.byteLength, offset + RESULT_PAGE_BYTES);
      while (end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80) end += 1;
    }
    const page: JobResultPage = { job: record.job, progress_tail: [...record.progressTail], result: bytes.subarray(offset, end).toString('utf8') };
    if (end < bytes.byteLength) {
      const payload = Buffer.from(JSON.stringify({ jobId, digest: record.result.sha256, version: record.result.version, offset: end })).toString('base64url');
      page.next_cursor = `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
    }
    return page;
  }

  async forgetJob(jobId: string): Promise<void> {
    let record: InternalJobRecord;
    try { record = await this.store.read(jobId); } catch (error) { return asContractError(error); }
    if (!TERMINAL_STATES.has(record.job.state)) throw new ClaudeContractError('job-not-terminal', 'Only terminal Claude jobs can be forgotten.');
    await this.store.remove(jobId);
  }

  async cleanup(): Promise<void> {
    const cutoff = this.clock.now().getTime() - RETENTION_MILLISECONDS;
    for (const record of await this.store.list()) {
      if (!TERMINAL_STATES.has(record.job.state) || !record.job.finished_at) continue;
      if (new Date(record.job.finished_at).getTime() < cutoff) {
        try {
          await this.store.remove(record.job.id);
        } catch (error) {
          if (!(error instanceof JobStoreError && error.code === 'job-not-found')) throw error;
        }
      }
    }
  }
}
