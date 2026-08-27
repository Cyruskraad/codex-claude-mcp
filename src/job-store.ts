import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod, link, lstat, mkdir, open, readdir, rename, rm, stat, unlink,
} from 'node:fs/promises';
import { homedir, platform as osPlatform } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  AccessSchema, ClaudeErrorSchema, ClaudeJobSchema, EffortSchema, ExecutionSchema, SessionSchema,
  type ClaudeError, type ClaudeJob, type JobState, type NormalizedClaudeTaskInput,
} from './contracts.js';
import { inspectProcessIdentity, type ProcessIdentityInspector } from './process-identity.js';

export const RESULT_VERSION = 1;
export const RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
const JOB_ID_PATTERN = /^job_[A-Za-z0-9_-]{1,123}$/;
const STAGING_PATTERN = /^\.create-(job_[A-Za-z0-9_-]{1,123})-[a-f0-9]{16}$/;
const LEASE_TEMP_PATTERN = /^\.(?:scheduler|update)\.lock\.lease-[a-f0-9]{16}$/;

export interface LeaseOwner { token: string; pid: number; birthIdentity: string }
export type LeaseOwnerVerifier = (owner: LeaseOwner) => Promise<boolean>;

export interface Clock { now(): Date }

export interface ResolveStateRootOptions {
  override?: string;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  xdgStateHome?: string;
}

export function resolveStateRoot(options: ResolveStateRootOptions = {}): string {
  const override = options.override ?? process.env.CODEX_CLAUDE_MCP_STATE_DIR;
  if (override !== undefined) {
    if (!isAbsolute(override)) throw new JobStoreError('invalid-input', 'State directory override must be absolute.');
    return override;
  }
  const currentPlatform = options.platform ?? osPlatform();
  const homeDirectory = options.homeDirectory ?? homedir();
  if (currentPlatform === 'darwin') return join(homeDirectory, 'Library', 'Application Support', 'codex-claude-mcp');
  if (currentPlatform === 'linux') {
    const base = options.xdgStateHome ?? process.env.XDG_STATE_HOME ?? join(homeDirectory, '.local', 'state');
    if (!isAbsolute(base)) throw new JobStoreError('invalid-input', 'XDG state directory must be absolute.');
    return join(base, 'codex-claude-mcp');
  }
  throw new JobStoreError('invalid-input', 'Native Windows is not supported; use WSL2.');
}

const StoredTaskSchema = z.object({
  workspace: z.string().min(1),
  access: AccessSchema,
  model: z.string().optional(),
  effort: EffortSchema.optional(),
  max_turns: z.number().int().min(1).max(100),
  session: SessionSchema,
  execution: ExecutionSchema,
}).strict();
export type StoredTask = z.infer<typeof StoredTaskSchema>;

const RunnerRecordSchema = z.object({
  token: z.string().min(1),
  pid: z.number().int().positive().optional(),
  heartbeat: z.string().datetime().optional(),
  birthIdentity: z.string().min(1).max(512).optional(),
}).strict();
export type RunnerRecord = z.infer<typeof RunnerRecordSchema>;

const ResultRecordSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().nonnegative(),
  version: z.literal(RESULT_VERSION),
}).strict();

const terminalIntentSchema = z.enum(['cancelled', 'timed_out', 'output_limited']);
const InternalJobRecordSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  job: ClaudeJobSchema,
  task: StoredTaskSchema,
  runner: RunnerRecordSchema,
  deadline: z.string().datetime().optional(),
  rawByteCount: z.number().int().nonnegative(),
  result: ResultRecordSchema.optional(),
  terminalIntent: terminalIntentSchema.optional(),
  progressTail: z.array(z.string().max(1024)).max(20),
}).strict().superRefine((record, context) => {
  const terminal = ['succeeded', 'failed', 'cancelled', 'timed_out', 'output_limited', 'orphaned'].includes(record.job.state);
  if (record.job.state === 'running') {
    if (!record.deadline) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Running state requires a deadline.' });
    if (!record.runner.pid || !record.runner.heartbeat) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Running state requires runner ownership.' });
  }
  if (terminal !== Boolean(record.result)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Terminal state and result metadata must be published together.' });
  if (!terminal && record.terminalIntent) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Nonterminal state forbids published terminal intent.' });
  if (record.terminalIntent && record.terminalIntent !== record.job.state) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Terminal intent must match the terminal state.' });
  }
});
export type InternalJobRecord = z.infer<typeof InternalJobRecordSchema>;

const ControlRecordSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  terminalIntent: terminalIntentSchema.nullable(),
}).strict();

export type TerminalPublication = {
  state: Exclude<JobState, 'queued' | 'running'>;
  result: Buffer;
  error?: ClaudeError;
  exitCode?: number | null;
  signal?: string | null;
  sessionId?: string;
  usage?: ClaudeJob['usage'];
  totalCostUsd?: number;
};

export class JobStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'JobStoreError';
    this.code = code;
  }
}

export interface JobStoreOptions {
  stateRoot?: string;
  clock?: Clock;
  leaseOwner?: LeaseOwner;
  leaseOwnerVerifier?: LeaseOwnerVerifier;
  processIdentityInspector?: ProcessIdentityInspector;
  lockWaitMilliseconds?: number;
}

const leaseOwnerSchema = z.object({ token: z.string().min(1), pid: z.number().int().positive(), birthIdentity: z.string().min(1) }).strict();

async function atomicWrite(path: string, bytes: Buffer | string, mode = 0o600): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close();
  }
  await rename(temporary, path);
  try {
    const parent = await open(join(path, '..'), constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
  } catch { /* best-effort directory flush */ }
}

function terminalError(state: TerminalPublication['state']): ClaudeError | undefined {
  const defaults: Partial<Record<TerminalPublication['state'], ClaudeError>> = {
    cancelled: { code: 'cancelled', message: 'Claude job was cancelled.' },
    timed_out: { code: 'timed-out', message: 'Claude job timed out.' },
    output_limited: { code: 'output-limited', message: 'Claude output exceeded the byte limit.' },
    orphaned: { code: 'orphaned', message: 'Claude runner ownership could not be verified.' },
    failed: { code: 'claude-failed', message: 'Claude execution failed.' },
  };
  return defaults[state];
}

function assertMutable(record: InternalJobRecord): void {
  if (!['queued', 'running'].includes(record.job.state)) throw new JobStoreError('terminal-state', 'Terminal jobs are immutable.');
}

export class JobStore {
  readonly stateRoot: string;
  readonly clock: Clock;
  readonly jobsRoot: string;
  readonly cursorKeyPath: string;
  private leaseOwner?: LeaseOwner;
  private readonly leaseOwnerVerifier: LeaseOwnerVerifier;
  private readonly processIdentityInspector: ProcessIdentityInspector;
  private readonly lockWaitMilliseconds: number;

  constructor(options: JobStoreOptions = {}) {
    this.stateRoot = options.stateRoot ?? resolveStateRoot();
    if (!isAbsolute(this.stateRoot)) throw new JobStoreError('invalid-input', 'State root must be absolute.');
    this.clock = options.clock ?? { now: () => new Date() };
    this.jobsRoot = join(this.stateRoot, 'jobs');
    this.cursorKeyPath = join(this.stateRoot, 'cursor.key');
    this.processIdentityInspector = options.processIdentityInspector ?? inspectProcessIdentity;
    this.leaseOwner = options.leaseOwner;
    this.leaseOwnerVerifier = options.leaseOwnerVerifier ?? (async (owner) => {
      const observed = await this.processIdentityInspector(owner.pid);
      return observed.state === 'unknown' || (observed.state === 'live' && observed.birthIdentity === owner.birthIdentity);
    });
    this.lockWaitMilliseconds = options.lockWaitMilliseconds ?? 5_000;
  }

  paths(jobId: string) {
    if (!JOB_ID_PATTERN.test(jobId)) throw new JobStoreError('invalid-input', 'Claude job identifier is invalid.');
    const directory = join(this.jobsRoot, jobId);
    return {
      directory,
      state: join(directory, 'state.json'),
      control: join(directory, 'control.json'),
      request: join(directory, 'request.json'),
      result: join(directory, 'result.bin'),
      rawStdout: join(directory, 'stdout.raw'),
    };
  }

  private async ensureLeaseOwner(): Promise<LeaseOwner> {
    if (this.leaseOwner) return this.leaseOwner;
    const identity = await this.processIdentityInspector(process.pid);
    if (identity.state !== 'live') throw new JobStoreError('internal-error', 'Current process identity could not be verified.');
    this.leaseOwner = { token: randomBytes(16).toString('hex'), pid: process.pid, birthIdentity: identity.birthIdentity };
    return this.leaseOwner;
  }

  private async cleanupLeaseTemps(directory: string): Promise<void> {
    let names: string[];
    try { names = await readdir(directory); } catch { return; }
    for (const name of names) {
      if (!LEASE_TEMP_PATTERN.test(name)) continue;
      const candidate = join(directory, name);
      try {
        const metadata = await lstat(candidate);
        if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
        const lease = await this.readLease(candidate);
        if (lease.kind === 'valid' && !(await this.leaseOwnerVerifier(lease.owner))) await unlink(candidate);
      } catch { /* retain anything unsafe or concurrently removed */ }
    }
  }

  private async cleanupLeaseTempsForJobs(): Promise<void> {
    let names: string[];
    try { names = await readdir(this.jobsRoot); } catch { return; }
    for (const name of names) {
      if (!JOB_ID_PATTERN.test(name)) continue;
      const directory = join(this.jobsRoot, name);
      try {
        const metadata = await lstat(directory);
        if (metadata.isDirectory() && !metadata.isSymbolicLink()) await this.cleanupLeaseTemps(directory);
      } catch { /* retain unsafe job directories */ }
    }
  }

  async init(): Promise<void> {
    await this.ensureLeaseOwner();
    try {
      const existing = await lstat(this.stateRoot);
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new JobStoreError('internal-error', 'Private state root is unsafe.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    }
    await chmod(this.stateRoot, 0o700);
    try {
      const existing = await lstat(this.jobsRoot);
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new JobStoreError('internal-error', 'Private jobs root is unsafe.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { await mkdir(this.jobsRoot, { mode: 0o700 }); }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
    }
    await chmod(this.jobsRoot, 0o700);
    try {
      const key = await lstat(this.cursorKeyPath);
      if (!key.isFile() || key.isSymbolicLink()) throw new JobStoreError('internal-error', 'Private cursor key is unsafe.');
      await chmod(this.cursorKeyPath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      let keyHandle;
      try {
        keyHandle = await open(this.cursorKeyPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        await keyHandle.writeFile(randomBytes(32)); await keyHandle.sync();
      } catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError; }
      finally { await keyHandle?.close(); }
    }
    await this.cleanupLeaseTemps(this.stateRoot);
    await this.cleanupLeaseTempsForJobs();
    await this.cleanupCrashRemnants();
    const warnings = await this.verifyPrivateModes();
    if (warnings.length > 0) throw new JobStoreError('internal-error', 'Private state permissions are ineffective.');
  }

  async cursorKey(): Promise<Buffer> {
    const handle = await open(this.cursorKeyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return await handle.readFile(); } finally { await handle.close(); }
  }

  async readResult(jobId: string): Promise<Buffer> {
    try {
      const handle = await open(this.paths(jobId).result, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { return await handle.readFile(); } finally { await handle.close(); }
    } catch { throw new JobStoreError('internal-error', 'Private Claude result is unavailable.'); }
  }

  async create(task: NormalizedClaudeTaskInput, id: string, runnerToken: string): Promise<InternalJobRecord> {
    const finalPaths = this.paths(id);
    const directory = join(this.jobsRoot, `.create-${id}-${randomBytes(8).toString('hex')}`);
    const paths = {
      directory,
      state: join(directory, 'state.json'),
      control: join(directory, 'control.json'),
      request: join(directory, 'request.json'),
      result: join(directory, 'result.bin'),
      rawStdout: join(directory, 'stdout.raw'),
    };
    try {
      await lstat(finalPaths.directory);
      throw new JobStoreError('invalid-input', 'Claude job identifier already exists.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
    await atomicWrite(join(directory, '.owner.json'), JSON.stringify(await this.ensureLeaseOwner()));
    const now = this.clock.now().toISOString();
    const storedTask: StoredTask = {
      workspace: task.workspace,
      access: task.access,
      ...(task.model ? { model: task.model } : {}),
      ...(task.effort ? { effort: task.effort } : {}),
      max_turns: task.max_turns,
      session: task.session,
      execution: task.execution,
    };
    const job: ClaudeJob = ClaudeJobSchema.parse({
      id, state: 'queued', created_at: now, updated_at: now, workspace: task.workspace,
      access: task.access, ...(task.model ? { model: task.model } : {}),
      ...(task.effort ? { effort: task.effort } : {}), max_turns: task.max_turns,
    });
    const record = InternalJobRecordSchema.parse({
      schemaVersion: 1, revision: 0, job, task: storedTask, runner: { token: runnerToken },
      rawByteCount: 0, progressTail: [],
    });
    await atomicWrite(paths.request, JSON.stringify({ prompt: task.prompt }));
    await atomicWrite(paths.rawStdout, Buffer.alloc(0));
    await atomicWrite(paths.control, JSON.stringify({ schemaVersion: 1, revision: 0, terminalIntent: null }));
    await atomicWrite(paths.state, JSON.stringify(record));
    await rename(directory, finalPaths.directory);
    try {
      const parent = await open(this.jobsRoot, constants.O_RDONLY);
      try { await parent.sync(); } finally { await parent.close(); }
    } catch { /* best-effort jobs directory flush */ }
    return record;
  }

  async read(jobId: string): Promise<InternalJobRecord> {
    try {
      const paths = this.paths(jobId);
      const directory = await lstat(paths.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('unsafe');
      const handle = await open(paths.state, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { return InternalJobRecordSchema.parse(JSON.parse((await handle.readFile()).toString('utf8'))); }
      finally { await handle.close(); }
    } catch (error) {
      if (error instanceof JobStoreError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new JobStoreError('job-not-found', 'Claude job was not found.');
      throw new JobStoreError('internal-error', 'Stored Claude job state is invalid.');
    }
  }

  async safeRead(jobId: string): Promise<InternalJobRecord | { error: ClaudeError }> {
    try { return await this.read(jobId); } catch (error) {
      if (error instanceof JobStoreError && ['job-not-found', 'invalid-input'].includes(error.code)) throw error;
      return { error: { code: 'internal-error', message: 'Stored Claude job state is invalid.' } };
    }
  }

  async list(): Promise<InternalJobRecord[]> {
    let names: string[];
    try { names = await readdir(this.jobsRoot); } catch { return []; }
    const records: InternalJobRecord[] = [];
    for (const name of names) {
      if (!JOB_ID_PATTERN.test(name)) continue;
      try {
        const candidate = await this.safeRead(name);
        if ('job' in candidate) records.push(candidate);
      } catch (error) {
        if (!(error instanceof JobStoreError && error.code === 'job-not-found')) throw error;
      }
    }
    return records.sort((left, right) => left.job.created_at.localeCompare(right.job.created_at) || left.job.id.localeCompare(right.job.id));
  }

  private async commit(record: InternalJobRecord, expectedRevision: number, allowedTerminalIntent?: 'cancelled' | 'timed_out' | 'output_limited'): Promise<InternalJobRecord> {
    return this.withJobLock(record.job.id, () => this.commitUnlocked(record, expectedRevision, allowedTerminalIntent));
  }

  private async commitUnlocked(
    record: InternalJobRecord,
    expectedRevision: number,
    allowedTerminalIntent?: 'cancelled' | 'timed_out' | 'output_limited',
  ): Promise<InternalJobRecord> {
    const current = await this.read(record.job.id);
    if (current.revision !== expectedRevision) throw new JobStoreError('stale-revision', 'Stored job revision changed.');
    const control = await this.readControl(record.job.id);
    if (control.terminalIntent && control.terminalIntent !== allowedTerminalIntent) {
      throw new JobStoreError('terminal-intent', 'A durable terminal intent already owns this job.');
    }
    const parsed = InternalJobRecordSchema.parse({ ...record, revision: expectedRevision + 1 });
    await atomicWrite(this.paths(record.job.id).state, JSON.stringify(parsed));
    return parsed;
  }

  private async withJobLock<T>(jobId: string, action: () => Promise<T>): Promise<T> {
    return this.withLease(join(this.paths(jobId).directory, '.update.lock'), action);
  }

  async withSchedulerLease<T>(action: () => Promise<T>): Promise<T> {
    return this.withLease(join(this.stateRoot, '.scheduler.lock'), action);
  }

  private async readLease(path: string): Promise<{ kind: 'missing' | 'invalid' } | { kind: 'valid'; owner: LeaseOwner }> {
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) return { kind: 'invalid' };
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { return { kind: 'valid', owner: leaseOwnerSchema.parse(JSON.parse((await handle.readFile()).toString('utf8'))) }; }
      finally { await handle.close(); }
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'invalid' };
    }
  }

  private async withLease<T>(path: string, action: () => Promise<T>): Promise<T> {
    const leaseOwner = await this.ensureLeaseOwner();
    const owner = { ...leaseOwner, token: `${leaseOwner.token}:${randomBytes(8).toString('hex')}` };
    const deadline = Date.now() + this.lockWaitMilliseconds;
    let acquired = false;
    for (;;) {
      const temporary = `${path}.lease-${randomBytes(8).toString('hex')}`;
      try {
        let handle;
        try {
          handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
          await handle.writeFile(JSON.stringify(owner));
          await handle.sync();
        } finally { await handle?.close(); }
        await link(temporary, path);
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await this.readLease(path);
        if (existing.kind === 'valid' && !(await this.leaseOwnerVerifier(existing.owner))) {
          const replacement = await this.readLease(path);
          if (replacement.kind === 'valid' && replacement.owner.token === existing.owner.token) await unlink(path).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) throw new JobStoreError('lock-unavailable', 'Private state lease is unavailable.');
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      if (acquired) break;
    }
    try { return await action(); } finally {
      const replacement = await this.readLease(path);
      if (replacement.kind === 'valid' && replacement.owner.token === owner.token) await unlink(path).catch(() => undefined);
    }
  }

  async claim(jobId: string, expectedRevision: number, runner: Pick<RunnerRecord, 'pid' | 'birthIdentity'>): Promise<InternalJobRecord> {
    const current = await this.read(jobId);
    if (current.revision !== expectedRevision) throw new JobStoreError('stale-revision', 'Stored job revision changed.');
    if (current.job.state !== 'queued') throw new JobStoreError('invalid-state', 'Only queued jobs can be claimed.');
    const now = this.clock.now();
    return this.commit({
      ...current,
      job: { ...current.job, state: 'running', started_at: now.toISOString(), updated_at: now.toISOString() },
      runner: { ...current.runner, ...runner, heartbeat: now.toISOString() },
      deadline: new Date(now.getTime() + current.task.execution.timeout_seconds * 1000).toISOString(),
    }, expectedRevision);
  }

  async updateRunner(jobId: string, expectedRevision: number, runner: Partial<Omit<RunnerRecord, 'token'>>): Promise<InternalJobRecord> {
    const current = await this.read(jobId);
    if (current.revision !== expectedRevision) throw new JobStoreError('stale-revision', 'Stored job revision changed.');
    assertMutable(current);
    const control = await this.readControl(jobId);
    return this.commit({ ...current, runner: { ...current.runner, ...runner, heartbeat: this.clock.now().toISOString() } }, expectedRevision, control.terminalIntent ?? undefined);
  }

  async updateProgress(jobId: string, expectedRevision: number, update: { sessionId?: string; progressTail?: string[]; rawByteCount?: number }): Promise<InternalJobRecord> {
    const current = await this.read(jobId);
    if (current.revision !== expectedRevision) throw new JobStoreError('stale-revision', 'Stored job revision changed.');
    assertMutable(current);
    const control = await this.readControl(jobId);
    return this.commit({
      ...current,
      job: { ...current.job, updated_at: this.clock.now().toISOString(), ...(update.sessionId ? { claude_session_id: update.sessionId } : {}) },
      ...(update.progressTail ? { progressTail: update.progressTail.slice(-20) } : {}),
      ...(update.rawByteCount !== undefined ? { rawByteCount: update.rawByteCount } : {}),
    }, expectedRevision, control.terminalIntent ?? undefined);
  }

  async readRequest(jobId: string): Promise<string> {
    try {
      const handle = await open(this.paths(jobId).request, constants.O_RDONLY | constants.O_NOFOLLOW);
      let contents: string;
      try { contents = (await handle.readFile()).toString('utf8'); } finally { await handle.close(); }
      const parsed = JSON.parse(contents) as unknown;
      if (!parsed || typeof parsed !== 'object' || typeof (parsed as { prompt?: unknown }).prompt !== 'string') throw new Error();
      return (parsed as { prompt: string }).prompt;
    } catch {
      throw new JobStoreError('internal-error', 'Private Claude request is unavailable.');
    }
  }

  async removeRequest(jobId: string): Promise<void> {
    const path = this.paths(jobId).request;
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new JobStoreError('internal-error', 'Private request path is unsafe.');
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async readControl(jobId: string): Promise<z.infer<typeof ControlRecordSchema>> {
    try {
      const handle = await open(this.paths(jobId).control, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { return ControlRecordSchema.parse(JSON.parse((await handle.readFile()).toString('utf8'))); }
      finally { await handle.close(); }
    }
    catch (error) {
      if (error instanceof JobStoreError) throw error;
      throw new JobStoreError('internal-error', 'Stored Claude control state is invalid.');
    }
  }

  async recoverTerminalIntent(jobId: string): Promise<InternalJobRecord | undefined> {
    const current = await this.read(jobId);
    if (!['queued', 'running'].includes(current.job.state)) return current;
    const control = await this.readControl(jobId);
    if (!control.terminalIntent) return undefined;
    try {
      return await this.publishTerminal(jobId, current.revision, {
        state: control.terminalIntent,
        result: Buffer.alloc(0),
        error: terminalError(control.terminalIntent),
      });
    } catch (error) {
      if (error instanceof JobStoreError && error.code === 'stale-revision') return this.read(jobId);
      throw error;
    }
  }

  async requestTerminalIntent(jobId: string, expectedRevision: number, state: 'cancelled' | 'timed_out' | 'output_limited'): Promise<InternalJobRecord> {
    return this.withJobLock(jobId, async () => {
      const current = await this.read(jobId);
      if (current.revision !== expectedRevision) throw new JobStoreError('stale-revision', 'Stored job revision changed.');
      assertMutable(current);
      const previous = await this.readControl(jobId);
      if (previous.terminalIntent && previous.terminalIntent !== state) throw new JobStoreError('terminal-intent', 'A durable terminal intent already owns this job.');
      await atomicWrite(this.paths(jobId).control, JSON.stringify({ schemaVersion: 1, revision: expectedRevision + 1, terminalIntent: state }));
      return current;
    });
  }

  async finalizeTerminalIntent(jobId: string): Promise<InternalJobRecord | undefined> {
    return this.recoverTerminalIntent(jobId);
  }

  async setTerminalIntent(jobId: string, expectedRevision: number, state: 'cancelled' | 'timed_out' | 'output_limited'): Promise<InternalJobRecord> {
    await this.requestTerminalIntent(jobId, expectedRevision, state);
    const finalized = await this.recoverTerminalIntent(jobId);
    if (!finalized) throw new JobStoreError('internal-error', 'Durable terminal intent could not be finalized.');
    return finalized;
  }

  async publishTerminal(jobId: string, expectedRevision: number, publication: TerminalPublication): Promise<InternalJobRecord> {
    return this.withJobLock(jobId, async () => {
      const current = await this.read(jobId);
      if (current.revision !== expectedRevision) throw new JobStoreError('stale-revision', 'Stored job revision changed.');
      assertMutable(current);
      const pendingControl = await this.readControl(jobId);
      if (pendingControl.terminalIntent
        && pendingControl.terminalIntent !== publication.state) {
        throw new JobStoreError('terminal-intent', 'A durable terminal intent already owns this job.');
      }
      if (current.job.state === 'queued' && publication.state !== 'cancelled') {
        throw new JobStoreError('invalid-state', 'Queued jobs may only be cancelled.');
      }
      const digest = createHash('sha256').update(publication.result).digest('hex');
      await atomicWrite(this.paths(jobId).result, publication.result);
      const now = this.clock.now().toISOString();
      const error = publication.state === 'succeeded' ? undefined : ClaudeErrorSchema.parse(publication.error ?? terminalError(publication.state));
      const job = ClaudeJobSchema.parse({
        ...current.job,
        state: publication.state,
        updated_at: now,
        finished_at: now,
        ...(publication.exitCode !== undefined ? { exit_code: publication.exitCode } : {}),
        ...(publication.signal !== undefined ? { signal: publication.signal } : {}),
        ...(publication.sessionId ? { claude_session_id: publication.sessionId } : {}),
        ...(publication.usage ? { usage: publication.usage } : {}),
        ...(publication.totalCostUsd !== undefined ? { total_cost_usd: publication.totalCostUsd } : {}),
        ...(publication.state === 'succeeded' ? {} : { error }),
        ...(publication.state === 'succeeded' ? { result_preview: publication.result.toString('utf8').slice(0, 4096) } : {}),
      });
      const intent = publication.state === 'cancelled' || publication.state === 'timed_out' || publication.state === 'output_limited'
        ? publication.state : undefined;
      if (intent) {
        const control = ControlRecordSchema.parse({ schemaVersion: 1, revision: expectedRevision + 1, terminalIntent: intent });
        await atomicWrite(this.paths(jobId).control, JSON.stringify(control));
      }
      const terminal = await this.commitUnlocked({
        ...current,
        job,
        result: { sha256: digest, byteLength: publication.result.byteLength, version: RESULT_VERSION },
        ...(intent ? { terminalIntent: intent } : {}),
      }, expectedRevision, intent);
      await this.removeRequest(jobId);
      return terminal;
    });
  }

  async remove(jobId: string): Promise<void> {
    const paths = this.paths(jobId);
    try {
      const metadata = await lstat(paths.directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new JobStoreError('internal-error', 'Private job directory is unsafe.');
    } catch (error) {
      if (error instanceof JobStoreError) throw error;
      throw new JobStoreError('job-not-found', 'Claude job was not found.');
    }
    await rm(paths.directory, { recursive: true });
  }

  private async cleanupCrashRemnants(): Promise<void> {
    for (const name of await readdir(this.jobsRoot)) {
      const staging = name.match(STAGING_PATTERN);
      if (staging) {
        const directory = join(this.jobsRoot, name);
        try {
          const metadata = await lstat(directory);
          if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
          const ownerPath = join(directory, '.owner.json');
          const handle = await open(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          let owner: LeaseOwner;
          try { owner = leaseOwnerSchema.parse(JSON.parse((await handle.readFile()).toString('utf8'))); }
          finally { await handle.close(); }
          if (!(await this.leaseOwnerVerifier(owner))) await rm(directory, { recursive: true });
        } catch { /* invalid or unverifiable staging is retained fail-closed */ }
        continue;
      }
      if (!JOB_ID_PATTERN.test(name)) continue;
      try {
        const record = await this.read(name);
        if (!['queued', 'running'].includes(record.job.state)) await this.removeRequest(name);
      } catch { /* corrupt entries are retained for diagnosis */ }
    }
  }

  async verifyPrivateModes(): Promise<string[]> {
    const warnings: string[] = [];
    if (((await stat(this.stateRoot)).mode & 0o077) !== 0) warnings.push('state root permissions are not private; avoid Windows-mounted WSL paths');
    if (((await stat(this.jobsRoot)).mode & 0o077) !== 0) warnings.push('jobs root permissions are not private; avoid Windows-mounted WSL paths');
    if (((await stat(this.cursorKeyPath)).mode & 0o077) !== 0) warnings.push('cursor key permissions are not private; avoid Windows-mounted WSL paths');
    return warnings;
  }
}
