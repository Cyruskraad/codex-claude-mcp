import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JobService, verifyRunnerOwnership, type RunnerLauncher } from '../src/job-service.js';

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
    idGenerator: (() => { let id = 0; return () => `job_${++id}`; })(),
    tokenGenerator: () => 'ownership_token',
  });
  await service.startup();
  return { root, workspace, service, setNow: (date: Date) => { current = date; } };
}

describe('durable job lifecycle service', () => {
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
        const current = await service.store.read(jobId);
        await service.store.publishTerminal(jobId, current.revision, { state: 'succeeded', result: Buffer.from('done'), exitCode: 0 });
        service.notifyChanged(jobId);
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

  it('cancels queued work and running work only after ownership verification, with sticky terminal state', async () => {
    const killed: number[] = [];
    const { workspace, service } = await setup({ launch: async () => ({ pid: 44, birthIdentity: 'runner-birth' }) });
    const first = await service.submitTask({ workspace, prompt: 'one', execution: { mode: 'async' } });
    await service.store.updateRunner(first.job.id, (await service.store.read(first.job.id)).revision, { claudePgid: 45 });
    service.setOwnershipVerifier(async () => true);
    service.setProcessGroupTerminator(async (pgid) => { killed.push(pgid); });
    expect((await service.cancelJob(first.job.id)).job.state).toBe('cancelled');
    expect(killed).toEqual([45]);

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

    const mismatch = await service.submitTask({ workspace, prompt: 'two', execution: { mode: 'async' } });
    await service.store.updateRunner(mismatch.job.id, (await service.store.read(mismatch.job.id)).revision, { claudePgid: 99 });
    service.setOwnershipVerifier(async () => false);
    await service.cancelJob(mismatch.job.id);
    expect(killed).toEqual([45]);
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
    });
    await restarted.startup();
    expect((await restarted.getJobStatus(live.job.id)).job.state).toBe('running');
    expect((await restarted.getJobStatus(dead.job.id)).job.state).toBe('orphaned');
    expect((await restarted.getJobStatus('job_3')).job.state).toBe('running');
  });

  it('does not count an unverifiable running job as a concurrency slot', async () => {
    const { workspace, service } = await setup();
    const first = await service.submitTask({ workspace, prompt: 'unverifiable', execution: { mode: 'async' } });
    service.setOwnershipVerifier(async () => false);
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
