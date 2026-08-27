import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JobService, verifyRunnerOwnership, type RunnerLauncher } from '../src/job-service.js';

const testProcessIdentity = async (pid: number) => ({ state: 'live' as const, birthIdentity: `linux:${pid}` });

async function setup(launcher?: RunnerLauncher, now = new Date('2026-08-27T12:00:00.000Z')) {
  const root = await mkdtemp(join(tmpdir(), 'codex-claude-service-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  let current = now;
  const service = new JobService({
    stateRoot: join(root, 'state'),
    clock: { now: () => current },
    workspaceValidator: async (path) => ({ canonicalPath: path }),
    launcher: launcher ?? { launch: async () => ({ pid: 10, birthIdentity: 'b10' }) },
    ownershipVerifier: async () => true,
    processIdentityInspector: testProcessIdentity,
    idGenerator: (() => { let id = 0; return () => `job_${++id}`; })(),
    tokenGenerator: () => 'ownership_token',
  });
  await service.startup();
  return { root, workspace, service, setNow: (date: Date) => { current = date; } };
}

describe('durable job lifecycle service', () => {
  it('rejects cloud creation before workspace validation, persistence, scheduling, or spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-claude-cloud-create-reject-'));
    const stateRoot = join(root, 'state-must-not-exist');
    let validations = 0;
    let launches = 0;
    const service = new JobService({
      stateRoot,
      workspaceValidator: async (path) => { validations += 1; return { canonicalPath: path }; },
      launcher: { launch: async () => { launches += 1; return { pid: 99, birthIdentity: 'never' }; } },
      processIdentityInspector: testProcessIdentity,
    });
    const secret = 'private-cloud-create-description';

    let rejection: unknown;
    try {
      await service.submitTask({
        workspace: '/private/nonexistent/workspace', prompt: 'private prompt',
        session: { mode: 'cloud_create', description: secret }, execution: { mode: 'async' },
      });
    } catch (error) { rejection = error; }

    expect(rejection).toMatchObject({
      code: 'unsupported-session-mode',
      message: 'Cloud session creation is unavailable through this noninteractive bridge; create it in Claude Code and use cloud_attach.',
    });
    expect(String((rejection as Error).message)).not.toContain(secret);
    expect(validations).toBe(0);
    expect(launches).toBe(0);
    await expect(stat(stateRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs no more than two jobs and deterministically schedules the third after a slot is released', async () => {
    const launches: string[] = [];
    const launcher: RunnerLauncher = { launch: async (request) => { launches.push(request.jobId); return { pid: launches.length, birthIdentity: `b${launches.length}` }; } };
    const { workspace, service } = await setup(launcher);
    const jobs = await Promise.all([1, 2, 3].map((n) => service.submitTask({ workspace, prompt: `p${n}`, execution: { mode: 'async' } })));
    expect(jobs.map((entry) => entry.job.state)).toEqual(['running', 'running', 'queued']);
    expect(launches).toEqual(['job_1', 'job_2']);
    await service.store.publishTerminal('job_1', (await service.store.read('job_1')).revision, { state: 'succeeded', result: Buffer.from('one'), exitCode: 0 });
    await service.schedule();
    expect((await service.getJobStatus('job_3')).job.state).toBe('running');
    expect(launches).toEqual(['job_1', 'job_2', 'job_3']);
  });

  it('supports async, sync, fast auto, and auto promotion without duplicating a job', async () => {
    const holder: { service?: JobService } = {};
    const launcher: RunnerLauncher = { launch: async ({ jobId }) => {
      setImmediate(async () => {
        const service = holder.service;
        if (!service) return;
        for (;;) {
          const current = await service.store.read(jobId);
          if (current.job.state !== 'running') return;
          try {
            await service.store.publishTerminal(jobId, current.revision, { state: 'succeeded', result: Buffer.from('done'), exitCode: 0 });
            service.notifyChanged(jobId);
            return;
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'stale-revision')) throw error;
          }
        }
      });
      return { pid: 11, birthIdentity: 'b11' };
    } };
    const context = await setup(launcher);
    holder.service = context.service;
    const sync = await context.service.submitTask({ workspace: context.workspace, prompt: 'sync', execution: { mode: 'sync', timeout_seconds: 30 } });
    expect(sync.job.state).toBe('succeeded');
    const fast = await context.service.submitTask({ workspace: context.workspace, prompt: 'auto', execution: { mode: 'auto', wait_seconds: 45, timeout_seconds: 30 } });
    expect(fast.job.state).toBe('succeeded');
    expect((await context.service.store.list()).map((item) => item.job.id)).toEqual(['job_1', 'job_2']);

    const waiting = await setup({ launch: async () => ({ pid: 12, birthIdentity: 'b12' }) });
    const promoted = await waiting.service.submitTask({ workspace: waiting.workspace, prompt: 'later', execution: { mode: 'auto', wait_seconds: 0, timeout_seconds: 30 } });
    expect(promoted.job.state).toBe('running');
    expect((await waiting.service.store.list()).length).toBe(1);
  });

  it('cancels via durable control only and never signals a persisted process identity', async () => {
    const { workspace, service } = await setup({ launch: async () => ({ pid: 44, birthIdentity: 'runner-birth' }) });
    const first = await service.submitTask({ workspace, prompt: 'one', execution: { mode: 'async' } });
    service.setOwnershipVerifier(async () => true);
    expect((await service.cancelJob(first.job.id)).job.state).toBe('running');
    expect((await service.store.readControl(first.job.id)).terminalIntent).toBe('cancelled');
    await service.store.finalizeTerminalIntent(first.job.id);
    expect((await service.getJobStatus(first.job.id)).job.state).toBe('cancelled');

    const queueContext = await setup({ launch: async () => ({ pid: 70, birthIdentity: 'queued-test' }) });
    await queueContext.service.submitTask({ workspace: queueContext.workspace, prompt: 'occupy one', execution: { mode: 'async' } });
    await queueContext.service.submitTask({ workspace: queueContext.workspace, prompt: 'occupy two', execution: { mode: 'async' } });
    const queued = await queueContext.service.submitTask({ workspace: queueContext.workspace, prompt: 'cancel while queued', execution: { mode: 'async' } });
    expect(queued.job.state).toBe('queued');
    const cancelledQueued = (await queueContext.service.cancelJob(queued.job.id)).job;
    expect(cancelledQueued.state).toBe('cancelled');
    expect(cancelledQueued).not.toHaveProperty('started_at');
    await expect(stat(queueContext.service.store.paths(queued.job.id).request)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await service.cancelJob(first.job.id)).job.state).toBe('cancelled');
    await expect(stat(service.store.paths(first.job.id).request)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes count and claim across two service instances sharing one state root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-claude-global-cap-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const launches: string[] = [];
    const make = (prefix: string) => new JobService({
      stateRoot: join(root, 'state'), workspaceValidator: async (path) => ({ canonicalPath: path }),
      launcher: { launch: async ({ jobId }) => { launches.push(jobId); return { pid: 100 + launches.length, birthIdentity: jobId }; } },
      ownershipVerifier: async () => true,
      processIdentityInspector: testProcessIdentity,
      idGenerator: (() => { let id = 0; return () => `job_${prefix}_${++id}`; })(),
    });
    const left = make('left');
    const right = make('right');
    await Promise.all([left.startup(), right.startup()]);
    await Promise.all([
      left.submitTask({ workspace, prompt: 'l1', execution: { mode: 'async' } }),
      right.submitTask({ workspace, prompt: 'r1', execution: { mode: 'async' } }),
      left.submitTask({ workspace, prompt: 'l2', execution: { mode: 'async' } }),
      right.submitTask({ workspace, prompt: 'r2', execution: { mode: 'async' } }),
    ]);
    expect(launches).toHaveLength(2);
    expect((await left.store.list()).filter((record) => record.job.state === 'running')).toHaveLength(2);
    await Promise.all([left.shutdown(), right.shutdown()]);
  });

  it('keeps a launch handoff owned and carries cancellation control to the acknowledged runner', async () => {
    let release!: () => void;
    let launched!: () => void;
    const launchStarted = new Promise<void>((resolve) => { launched = resolve; });
    const launchReleased = new Promise<void>((resolve) => { release = resolve; });
    const { workspace, service } = await setup({ launch: async () => {
      launched(); await launchReleased; return { pid: 404, birthIdentity: 'runner-404' };
    } });
    const submission = service.submitTask({ workspace, prompt: 'race', execution: { mode: 'async' } });
    await launchStarted;
    const pending = (await service.store.list()).find((record) => record.task.workspace === workspace)!;
    expect(pending.runner.birthIdentity).toMatch(/^launching:/);
    expect((await service.cancelJob(pending.job.id)).job.state).toBe('running');
    release();
    await submission;
    const handedOff = await service.store.read(pending.job.id);
    expect(handedOff.runner).toMatchObject({ pid: 404, birthIdentity: 'runner-404' });
    expect((await service.store.readControl(pending.job.id)).terminalIntent).toBe('cancelled');
  });

  it('runs a requested follow-up scheduler pass after an in-flight launch finishes', async () => {
    let release!: () => void;
    let started!: () => void;
    const launchStarted = new Promise<void>((resolve) => { started = resolve; });
    const launchReleased = new Promise<void>((resolve) => { release = resolve; });
    const { workspace, service } = await setup({ launch: async () => {
      started(); await launchReleased; return { pid: 405, birthIdentity: 'runner-405' };
    } });
    const submission = service.submitTask({ workspace, prompt: 'reschedule', execution: { mode: 'async' } });
    await launchStarted;
    service.setOwnershipVerifier(async () => false);
    const requestedPass = service.schedule();
    release();
    await Promise.all([submission, requestedPass]);
    const [record] = await service.store.list();
    expect(record.job.state).toBe('orphaned');
  });

  it('retains a proven-live runner while its durable terminal intent awaits runner handling', async () => {
    const { workspace, service } = await setup();
    const submitted = await service.submitTask({ workspace, prompt: 'runner owns cancellation', execution: { mode: 'async' } });
    const record = await service.store.read(submitted.job.id);
    await service.store.requestTerminalIntent(record.job.id, record.revision, 'cancelled');
    await service.schedule();
    expect((await service.getJobStatus(record.job.id)).job.state).toBe('running');
  });

  it('retains proven live runners, orphans unverifiable runners without killing, and resumes queued work on startup', async () => {
    const launched: string[] = [];
    const base = await setup({ launch: async ({ jobId }) => { launched.push(jobId); return { pid: 50, birthIdentity: 'live' }; } });
    const live = await base.service.submitTask({ workspace: base.workspace, prompt: 'live', execution: { mode: 'async' } });
    const dead = await base.service.submitTask({ workspace: base.workspace, prompt: 'dead', execution: { mode: 'async' } });
    await base.service.submitTask({ workspace: base.workspace, prompt: 'queued', execution: { mode: 'async' } });
    const restarted = new JobService({
      stateRoot: base.service.store.stateRoot,
      clock: { now: () => new Date('2026-08-27T12:01:00.000Z') },
      workspaceValidator: async (path) => ({ canonicalPath: path }),
      launcher: { launch: async ({ jobId }) => { launched.push(jobId); return { pid: 60, birthIdentity: 'new' }; } },
      ownershipVerifier: async (record) => record.job.id === live.job.id,
      processIdentityInspector: testProcessIdentity,
    });
    await restarted.startup();
    expect((await restarted.getJobStatus(live.job.id)).job.state).toBe('running');
    expect((await restarted.getJobStatus(dead.job.id)).job.state).toBe('orphaned');
    expect((await restarted.getJobStatus('job_3')).job.state).toBe('running');
  });

  it('uses matching OS-format birth identities across service instances without false orphaning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-claude-cross-process-identity-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const inspector = async (pid: number) => {
      if (pid === 701) return { state: 'live' as const, birthIdentity: 'linux:554433' };
      if (pid === 702) return { state: 'live' as const, birthIdentity: 'linux:998877' };
      return { state: 'live' as const, birthIdentity: 'linux:112233' };
    };
    const left = new JobService({
      stateRoot: join(root, 'state'), workspaceValidator: async (path) => ({ canonicalPath: path }),
      launcher: { launch: async () => ({ pid: 701, birthIdentity: 'launching:linux:554433' }) },
      ownershipVerifier: async () => false, processIdentityInspector: inspector,
      idGenerator: (() => { let id = 0; return () => `job_identity_${++id}`; })(),
    });
    await left.startup();
    const live = await left.submitTask({ workspace, prompt: 'matching identity', execution: { mode: 'async' } });
    const stale = await left.submitTask({ workspace, prompt: 'mismatched identity', execution: { mode: 'async' } });
    const staleRecord = await left.store.read(stale.job.id);
    await left.store.updateRunner(stale.job.id, staleRecord.revision, { pid: 702, birthIdentity: 'launching:linux:554433' });
    const right = new JobService({
      stateRoot: left.store.stateRoot, workspaceValidator: async (path) => ({ canonicalPath: path }),
      launcher: { launch: async () => ({ pid: 703, birthIdentity: 'linux:112233' }) },
      ownershipVerifier: async () => false, processIdentityInspector: inspector,
    });
    await right.startup();
    expect((await right.getJobStatus(live.job.id)).job.state).toBe('running');
    expect((await right.getJobStatus(stale.job.id)).job.state).toBe('orphaned');
    await Promise.all([left.shutdown(), right.shutdown()]);
  });

  it('retains an uninspectable launch handoff instead of falsely orphaning it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-claude-unknown-identity-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const liveInspector = async (pid: number) => ({
      state: 'live' as const,
      birthIdentity: pid === 799 ? 'linux:554433' : 'linux:112233',
    });
    const first = new JobService({
      stateRoot: join(root, 'state'), workspaceValidator: async (path) => ({ canonicalPath: path }),
      launcher: { launch: async () => ({ pid: 799, birthIdentity: 'launching:linux:554433' }) },
      ownershipVerifier: async () => false, processIdentityInspector: liveInspector,
    });
    await first.startup();
    const submitted = await first.submitTask({ workspace, prompt: 'unknown identity', execution: { mode: 'async' } });
    const restarted = new JobService({
      stateRoot: first.store.stateRoot, workspaceValidator: async (path) => ({ canonicalPath: path }),
      launcher: { launch: async () => ({ pid: 800, birthIdentity: 'linux:112233' }) },
      ownershipVerifier: async () => false,
      processIdentityInspector: async (pid) => pid === 799
        ? { state: 'unknown' as const }
        : { state: 'live' as const, birthIdentity: 'linux:112233' },
    });
    await restarted.startup();
    expect((await restarted.getJobStatus(submitted.job.id)).job.state).toBe('running');
    await Promise.all([first.shutdown(), restarted.shutdown()]);
  });

  it('does not count an unverifiable running job as a concurrency slot', async () => {
    const { workspace, service } = await setup();
    const first = await service.submitTask({ workspace, prompt: 'unverifiable', execution: { mode: 'async' } });
    service.setOwnershipVerifier(async (record) => record.job.id !== first.job.id);
    await service.schedule();
    expect((await service.getJobStatus(first.job.id)).job.state).toBe('orphaned');
    const replacement = await service.submitTask({ workspace, prompt: 'replacement', execution: { mode: 'async' } });
    expect(replacement.job.state).toBe('running');
  });

  it('continues only captured explicit sessions while preserving the original access ceiling', async () => {
    const { workspace, service } = await setup();
    const original = await service.submitTask({ workspace, prompt: 'original', access: 'inspect', model: 'sonnet', effort: 'high', max_turns: 7, execution: { mode: 'async' } });
    let record = await service.store.read(original.job.id);
    record = await service.store.updateProgress(original.job.id, record.revision, { sessionId: 'sess_captured' });
    await service.store.publishTerminal(original.job.id, record.revision, { state: 'succeeded', result: Buffer.from('old'), exitCode: 0 });
    const continued = await service.continueJob(original.job.id, 'continue privately', { mode: 'async' });
    const stored = await service.store.read(continued.job.id);
    expect(stored.task).toMatchObject({ access: 'inspect', model: 'sonnet', effort: 'high', max_turns: 7, session: { mode: 'resume', session_id: 'sess_captured' } });
    const noSession = await service.submitTask({ workspace, prompt: 'none', execution: { mode: 'async' } });
    const noSessionRecord = await service.store.read(noSession.job.id);
    await service.store.publishTerminal(noSession.job.id, noSessionRecord.revision, { state: 'failed', result: Buffer.alloc(0), error: { code: 'claude-failed', message: 'Claude execution failed.' } });
    await expect(service.continueJob(noSession.job.id, 'retry', { mode: 'async' })).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('paginates exact UTF-8 bytes with bound cursors and forgets terminal bridge data only', async () => {
    const { workspace, service } = await setup();
    const submitted = await service.submitTask({ workspace, prompt: 'page', execution: { mode: 'async' } });
    const record = await service.store.read(submitted.job.id);
    const result = `${'a'.repeat(65_535)}🌍tail`;
    await service.store.publishTerminal(submitted.job.id, record.revision, { state: 'succeeded', result: Buffer.from(result), exitCode: 0 });
    const first = await service.getJobResult(submitted.job.id);
    expect(Buffer.byteLength(first.result)).toBeLessThanOrEqual(65_536);
    const second = await service.getJobResult(submitted.job.id, first.next_cursor);
    expect(first.result + second.result).toBe(result);
    await expect(service.getJobResult(submitted.job.id, `${first.next_cursor}tamper`)).rejects.toMatchObject({ code: 'invalid-input' });
    const other = await service.submitTask({ workspace, prompt: 'other', execution: { mode: 'async' } });
    const otherRecord = await service.store.read(other.job.id);
    await service.store.publishTerminal(other.job.id, otherRecord.revision, { state: 'succeeded', result: Buffer.from('other'), exitCode: 0 });
    await expect(service.getJobResult(other.job.id, first.next_cursor)).rejects.toMatchObject({ code: 'invalid-input' });
    await writeFile(service.store.paths(submitted.job.id).result, Buffer.from(result.replace(/^a/, 'b')));
    await expect(service.getJobResult(submitted.job.id, first.next_cursor)).rejects.toMatchObject({ code: 'invalid-input' });
    await service.forgetJob(submitted.job.id);
    await expect(service.getJobStatus(submitted.job.id)).rejects.toMatchObject({ code: 'job-not-found' });
  });

  it('rejects forgetting active jobs and reports missing jobs with stable errors', async () => {
    const { workspace, service } = await setup();
    const active = await service.submitTask({ workspace, prompt: 'active', execution: { mode: 'async' } });
    await expect(service.forgetJob(active.job.id)).rejects.toMatchObject({ code: 'job-not-terminal' });
    await expect(service.forgetJob('job_missing')).rejects.toMatchObject({ code: 'job-not-found' });
    await expect(service.getJobStatus('../../outside')).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('normalizes launcher failure, active result/continuation, terminal cancellation, and corrupt status', async () => {
    let launches = 0;
    const { workspace, service } = await setup({ launch: async () => {
      launches += 1;
      if (launches === 1) throw new Error('private launcher detail');
      return { pid: 80, birthIdentity: 'b80' };
    } });
    const failed = await service.submitTask({ workspace, prompt: 'first', execution: { mode: 'async' } });
    expect(failed.job).toMatchObject({ state: 'failed', error: { code: 'internal-error' } });
    const active = await service.submitTask({ workspace, prompt: 'second', execution: { mode: 'async' } });
    await expect(service.getJobResult(active.job.id)).rejects.toMatchObject({ code: 'job-not-terminal' });
    await expect(service.continueJob(active.job.id, 'not yet')).rejects.toMatchObject({ code: 'job-not-terminal' });
    const current = await service.store.read(active.job.id);
    await service.store.publishTerminal(active.job.id, current.revision, { state: 'succeeded', result: Buffer.from('small'), exitCode: 0 });
    expect((await service.getJobResult(active.job.id)).next_cursor).toBeUndefined();
    await expect(service.cancelJob(active.job.id)).rejects.toMatchObject({ code: 'job-not-terminal' });
    await writeFile(service.store.paths(active.job.id).state, '{corrupt private state');
    await expect(service.getJobStatus(active.job.id)).rejects.toMatchObject({ code: 'internal-error' });
    await service.startup();
    await service.shutdown();
    await service.shutdown();
  });

  it('verifies runner ownership from live process evidence and rejects missing or mismatched identity', async () => {
    const { workspace, service } = await setup();
    const submitted = await service.submitTask({ workspace, prompt: 'ownership', execution: { mode: 'async' } });
    const record = await service.store.read(submitted.job.id);
    expect(await verifyRunnerOwnership({ ...record, runner: { token: 'none' } })).toBe(false);
    expect(await verifyRunnerOwnership({ ...record, runner: { token: 'definitely-not-in-current-cmdline', pid: process.pid } })).toBe(false);
    expect(await verifyRunnerOwnership({ ...record, runner: { token: process.argv[1] ?? 'vitest', pid: process.pid, birthIdentity: 'wrong-birth' }, job: { ...record.job, id: process.argv[1] ?? 'vitest' } })).toBe(false);
  });

  it('cleans only terminal jobs older than seven days by finished_at', async () => {
    const { workspace, service, setNow } = await setup();
    const old = await service.submitTask({ workspace, prompt: 'old', execution: { mode: 'async' } });
    let oldRecord = await service.store.read(old.job.id);
    oldRecord = await service.store.publishTerminal(old.job.id, oldRecord.revision, { state: 'succeeded', result: Buffer.from('old'), exitCode: 0 });
    setNow(new Date('2026-09-03T12:00:00.001Z'));
    const active = await service.submitTask({ workspace, prompt: 'active', execution: { mode: 'async' } });
    await service.cleanup();
    await expect(service.getJobStatus(oldRecord.job.id)).rejects.toMatchObject({ code: 'job-not-found' });
    expect((await service.getJobStatus(active.job.id)).job.state).toBe('running');
  });
});
