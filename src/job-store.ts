import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access, chmod, mkdir, open, readFile, readdir, rename, rm, stat, unlink,
} from 'node:fs/promises';
import { homedir, platform as osPlatform } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  AccessSchema, ClaudeErrorSchema, ClaudeJobSchema, EffortSchema, ExecutionSchema, SessionSchema,
  type ClaudeError, type ClaudeJob, type JobState, type NormalizedClaudeTaskInput,
} from './contracts.js';

export const RESULT_VERSION = 1;
export const RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
const JOB_ID_PATTERN = /^job_[A-Za-z0-9_-]{1,123}$/;

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
  claudePgid: z.number().int().positive().optional(),
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
  if (!terminal && record.terminalIntent) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Nonterminal state forbids terminal intent.' });
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
}

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

  constructor(options: JobStoreOptions = {}) {
    this.stateRoot = options.stateRoot ?? resolveStateRoot();
    if (!isAbsolute(this.stateRoot)) throw new JobStoreError('invalid-input', 'State root must be absolute.');
    this.clock = options.clock ?? { now: () => new Date() };
    this.jobsRoot = join(this.stateRoot, 'jobs');
    this.cursorKeyPath = join(this.stateRoot, 'cursor.key');
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

  async init(): Promise<void> {
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    await chmod(this.stateRoot, 0o700);
    await mkdir(this.jobsRoot, { recursive: true, mode: 0o700 });
    await chmod(this.jobsRoot, 0o700);
    try {
      await access(this.cursorKeyPath);
      await chmod(this.cursorKeyPath, 0o600);
    } catch {
      await atomicWrite(this.cursorKeyPath, randomBytes(32));
    }
  }

  async cursorKey(): Promise<Buffer> {
    return readFile(this.cursorKeyPath);
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
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
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
      return InternalJobRecordSchema.parse(JSON.parse(await readFile(this.paths(jobId).state, 'utf8')));
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

  private async commit(record: InternalJobRecord, expectedRevision: number): Promise<InternalJobRecord> {
    return this.withJobLock(record.job.id, () => this.commitUnlocked(record, expectedRevision));
  }

  private async commitUnlocked(
    record: InternalJobRecord,
    expectedRevision: number,
    allowedTerminalIntent?: 'cancelled' | 'timed_out' | 'output_limited',
  ): Promise<InternalJobRecord> {
    const current = await this.read(record.job.id);
    if (current.revision !== expectedRevision) throw new JobStoreError('stale-revision', 'Stored job revision changed.');
    const control = await this.readControl(record.job.id);
    if (control.terminalIntent && control.revision > current.revision && control.terminalIntent !== allowedTerminalIntent) {
      throw new JobStoreError('terminal-intent', 'A durable terminal intent already owns this job.');
    }
    const parsed = InternalJobRecordSchema.parse({ ...record, revision: expectedRevision + 1 });
    await atomicWrite(this.paths(record.job.id).state, JSON.stringify(parsed));
    return parsed;
  }

  private async withJobLock<T>(jobId: string, action: () => Promise<T>): Promise<T> {
    const lockPath = join(this.paths(jobId).directory, '.update.lock');
    const deadline = Date.now() + 5_000;
    let handle;
    for (;;) {
      try {
        handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        await handle.writeFile(`${process.pid}\n`);
        await handle.sync();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new JobStoreError('internal-error', 'Stored job update lock is unavailable.');
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }
    }
    try { return await action(); } finally {
      await handle.close();
      await unlink(lockPath).catch(() => undefined);
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
    return this.commit({ ...current, runner: { ...current.runner, ...runner, heartbeat: this.clock.now().toISOString() } }, expectedRevision);
  }

  async updateProgress(jobId: string, expectedRevision: number, update: { sessionId?: string; progressTail?: string[]; rawByteCount?: number }): Promise<InternalJobRecord> {
    const current = await this.read(jobId);
    if (current.revision !== expectedRevision) throw new JobStoreError('stale-revision', 'Stored job revision changed.');
    assertMutable(current);
    return this.commit({
      ...current,
      job: { ...current.job, updated_at: this.clock.now().toISOString(), ...(update.sessionId ? { claude_session_id: update.sessionId } : {}) },
      ...(update.progressTail ? { progressTail: update.progressTail.slice(-20) } : {}),
      ...(update.rawByteCount !== undefined ? { rawByteCount: update.rawByteCount } : {}),
    }, expectedRevision);
  }

  async readRequest(jobId: string): Promise<string> {
    try {
      const parsed = JSON.parse(await readFile(this.paths(jobId).request, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || typeof (parsed as { prompt?: unknown }).prompt !== 'string') throw new Error();
      return (parsed as { prompt: string }).prompt;
    } catch {
      throw new JobStoreError('internal-error', 'Private Claude request is unavailable.');
    }
  }

  async removeRequest(jobId: string): Promise<void> {
    await rm(this.paths(jobId).request, { force: true });
  }

  async readControl(jobId: string): Promise<z.infer<typeof ControlRecordSchema>> {
    try { return ControlRecordSchema.parse(JSON.parse(await readFile(this.paths(jobId).control, 'utf8'))); }
    catch (error) {
      if (error instanceof JobStoreError) throw error;
      throw new JobStoreError('internal-error', 'Stored Claude control state is invalid.');
    }
  }

  async recoverTerminalIntent(jobId: string): Promise<InternalJobRecord | undefined> {
    const current = await this.read(jobId);
    if (!['queued', 'running'].includes(current.job.state)) return current;
    const control = await this.readControl(jobId);
    if (!control.terminalIntent || control.revision <= current.revision) return undefined;
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

  async setTerminalIntent(jobId: string, expectedRevision: number, state: 'cancelled' | 'timed_out' | 'output_limited'): Promise<InternalJobRecord> {
    return this.publishTerminal(jobId, expectedRevision, { state, result: Buffer.alloc(0), error: terminalError(state) });
  }

  async publishTerminal(jobId: string, expectedRevision: number, publication: TerminalPublication): Promise<InternalJobRecord> {
    return this.withJobLock(jobId, async () => {
      const current = await this.read(jobId);
      if (current.revision !== expectedRevision) throw new JobStoreError('stale-revision', 'Stored job revision changed.');
      assertMutable(current);
      const pendingControl = await this.readControl(jobId);
      if (pendingControl.terminalIntent && pendingControl.revision > current.revision
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
    try { await stat(paths.directory); } catch { throw new JobStoreError('job-not-found', 'Claude job was not found.'); }
    await rm(paths.directory, { recursive: true });
  }

  async verifyPrivateModes(): Promise<string[]> {
    const warnings: string[] = [];
    if (((await stat(this.stateRoot)).mode & 0o077) !== 0) warnings.push('state root permissions are not private; avoid Windows-mounted WSL paths');
    if (((await stat(this.jobsRoot)).mode & 0o077) !== 0) warnings.push('jobs root permissions are not private; avoid Windows-mounted WSL paths');
    return warnings;
  }
}
