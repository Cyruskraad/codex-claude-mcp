import { chmod, lstat, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseClaudeTaskInput } from '../src/contracts.js';
import { JobStore, resolveStateRoot } from '../src/job-store.js';

const clock = { now: () => new Date('2026-08-27T12:00:00.000Z') };

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'codex-claude-store-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const store = new JobStore({ stateRoot: join(root, 'state'), clock });
  await store.init();
  const task = parseClaudeTaskInput({ workspace, prompt: 'private prompt' });
  return { root, workspace, store, task };
}

describe('private durable job store', () => {
  it('rejects relative overrides and resolves OS state locations', () => {
    expect(() => resolveStateRoot({ override: 'relative' })).toThrow();
    expect(resolveStateRoot({ platform: 'darwin', homeDirectory: '/Users/test' }))
      .toBe('/Users/test/Library/Application Support/codex-claude-mcp');
    expect(resolveStateRoot({ platform: 'linux', homeDirectory: '/home/test', xdgStateHome: '/state' }))
      .toBe('/state/codex-claude-mcp');
  });

  it('rejects job identifiers that could escape the private jobs directory', async () => {
    const { store } = await setup();
    expect(() => store.paths('../../outside')).toThrow(expect.objectContaining({ code: 'invalid-input' }));
    await expect(store.safeRead('../../outside')).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('creates 0700 directories and 0600 files while keeping the prompt only in request.json', async () => {
    const { store, task } = await setup();
    const record = await store.create(task, 'job_private', 'token_private');
    const paths = store.paths(record.job.id);
    expect((await stat(store.stateRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.directory)).mode & 0o777).toBe(0o700);
    for (const path of [paths.state, paths.control, paths.request, paths.rawStdout]) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(paths.request, 'utf8')).toContain('private prompt');
    for (const path of [paths.state, paths.control, paths.rawStdout]) {
      expect(await readFile(path, 'utf8')).not.toContain('private prompt');
    }
  });

  it('atomically compares revisions and publishes result bytes before terminal state', async () => {
    const { store, task } = await setup();
    const created = await store.create(task, 'job_cas', 'token_cas');
    const running = await store.claim(created.job.id, created.revision, { pid: 123, birthIdentity: 'birth' });
    await expect(store.publishTerminal(running.job.id, created.revision, {
      state: 'succeeded', result: Buffer.from('stale'), exitCode: 0,
    })).rejects.toMatchObject({ code: 'stale-revision' });
    const terminal = await store.publishTerminal(running.job.id, running.revision, {
      state: 'succeeded', result: Buffer.from('exact result'), exitCode: 0,
    });
    expect(terminal.job.state).toBe('succeeded');
    expect(terminal.result).toMatchObject({ byteLength: 12 });
    expect(await readFile(store.paths(running.job.id).result, 'utf8')).toBe('exact result');
  });

  it('allows only one concurrent writer to win the same revision', async () => {
    const { store, task } = await setup();
    const created = await store.create(task, 'job_concurrent', 'token_concurrent');
    const outcomes = await Promise.allSettled([
      store.updateProgress(created.job.id, created.revision, { progressTail: ['left'] }),
      store.updateProgress(created.job.id, created.revision, { progressTail: ['right'] }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect((await store.read(created.job.id)).revision).toBe(1);
  });

  it('lets a durable terminal intent win after a crash between control and state publication', async () => {
    const { store, task } = await setup();
    const queued = await store.create(task, 'job_terminal_wal', 'token_wal');
    const running = await store.claim(queued.job.id, queued.revision, { pid: 321, birthIdentity: 'birth' });
    await writeFile(store.paths(running.job.id).control, JSON.stringify({
      schemaVersion: 1, revision: running.revision + 1, terminalIntent: 'cancelled',
    }), { mode: 0o600 });
    await expect(store.publishTerminal(running.job.id, running.revision, { state: 'succeeded', result: Buffer.from('must lose') }))
      .rejects.toMatchObject({ code: 'terminal-intent' });
    const recovered = await store.recoverTerminalIntent(running.job.id);
    expect(recovered?.job).toMatchObject({ state: 'cancelled', error: { code: 'cancelled' } });
  });

  it('leaves jobs without intent untouched and makes repeated terminal intent safe', async () => {
    const { store, task } = await setup();
    const queued = await store.create(task, 'job_intent_repeat', 'token_repeat');
    expect(await store.recoverTerminalIntent(queued.job.id)).toBeUndefined();
    const first = await store.requestTerminalIntent(queued.job.id, queued.revision, 'cancelled');
    await expect(store.requestTerminalIntent(queued.job.id, first.revision, 'cancelled')).resolves.toMatchObject({ job: { state: 'queued' } });
    await expect(store.requestTerminalIntent(queued.job.id, first.revision, 'timed_out')).rejects.toMatchObject({ code: 'terminal-intent' });
    await store.removeRequest(queued.job.id);
    await expect(store.removeRequest(queued.job.id)).resolves.toBeUndefined();
  });

  it('quarantines corrupt state without exposing its contents', async () => {
    const { store, task } = await setup();
    const created = await store.create(task, 'job_corrupt', 'token_corrupt');
    await writeFile(store.paths(created.job.id).state, '{secret corrupt bytes', { mode: 0o600 });
    const result = await store.safeRead(created.job.id);
    expect(result).toMatchObject({ error: { code: 'internal-error' } });
    expect(JSON.stringify(result)).not.toContain('secret corrupt bytes');
  });

  it('rejects invalid queued success, malformed private requests, and mutation after terminal state', async () => {
    const { store, task } = await setup();
    const queued = await store.create(task, 'job_invalid_transition', 'token_invalid');
    await expect(store.publishTerminal(queued.job.id, queued.revision, { state: 'succeeded', result: Buffer.from('wrong') }))
      .rejects.toMatchObject({ code: 'invalid-state' });
    await writeFile(store.paths(queued.job.id).request, '{}', { mode: 0o600 });
    await expect(store.readRequest(queued.job.id)).rejects.toMatchObject({ code: 'internal-error' });
    const cancelled = await store.setTerminalIntent(queued.job.id, queued.revision, 'cancelled');
    await expect(store.updateProgress(cancelled.job.id, cancelled.revision, { progressTail: ['wrong'] }))
      .rejects.toMatchObject({ code: 'terminal-state' });
  });

  it('detects ineffective private modes such as WSL state placed on a Windows mount', async () => {
    const { store } = await setup();
    await chmod(store.stateRoot, 0o755);
    await expect(store.verifyPrivateModes()).resolves.toEqual(expect.arrayContaining([expect.stringContaining('state root')]));
  });

  it('rejects symlinked state and jobs roots instead of chmod-following them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-claude-symlink-'));
    const target = join(root, 'target');
    await mkdir(target);
    await symlink(target, join(root, 'state'));
    await expect(new JobStore({ stateRoot: join(root, 'state') }).init()).rejects.toMatchObject({ code: 'internal-error' });

    const safeState = join(root, 'safe-state');
    await mkdir(safeState, { mode: 0o700 });
    await symlink(target, join(safeState, 'jobs'));
    await expect(new JobStore({ stateRoot: safeState }).init()).rejects.toMatchObject({ code: 'internal-error' });

    const keyState = join(root, 'key-state');
    await mkdir(keyState, { mode: 0o700 });
    await mkdir(join(keyState, 'cursor.key'), { mode: 0o700 });
    await expect(new JobStore({ stateRoot: keyState }).init()).rejects.toMatchObject({ code: 'internal-error' });
  });

  it('recovers only proven-dead owner locks and never breaks a live or replacement lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-claude-lock-'));
    const staleStore = new JobStore({
      stateRoot: join(root, 'state'), lockWaitMilliseconds: 25,
      leaseOwner: { token: 'self', pid: 1, birthIdentity: 'self-birth' },
      leaseOwnerVerifier: async (owner) => owner.token !== 'dead',
    });
    await staleStore.init();
    await writeFile(join(staleStore.stateRoot, '.scheduler.lock'), JSON.stringify({ token: 'dead', pid: 999, birthIdentity: 'dead-birth' }), { mode: 0o600 });
    await expect(staleStore.withSchedulerLease(async () => 'acquired')).resolves.toBe('acquired');
    await writeFile(join(staleStore.stateRoot, '.scheduler.lock'), JSON.stringify({ token: 'live', pid: 2, birthIdentity: 'live-birth' }), { mode: 0o600 });
    await expect(staleStore.withSchedulerLease(async () => 'wrong')).rejects.toMatchObject({ code: 'lock-unavailable' });
    expect(JSON.parse(await readFile(join(staleStore.stateRoot, '.scheduler.lock'), 'utf8'))).toMatchObject({ token: 'live' });
  });

  it('cleans proven-dead owned staging prompts and terminal request remnants but retains unrelated directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-claude-remnants-'));
    const stateRoot = join(root, 'state');
    const store = new JobStore({
      stateRoot,
      leaseOwner: { token: 'self', pid: 1, birthIdentity: 'self-birth' },
      leaseOwnerVerifier: async (owner) => owner.token !== 'dead',
    });
    await store.init();
    const staging = join(store.jobsRoot, '.create-job_crash-0123456789abcdef');
    await mkdir(staging, { mode: 0o700 });
    await writeFile(join(staging, '.owner.json'), JSON.stringify({ token: 'dead', pid: 999, birthIdentity: 'dead-birth' }), { mode: 0o600 });
    await writeFile(join(staging, 'request.json'), '{"prompt":"private remnant"}', { mode: 0o600 });
    const unrelated = join(store.jobsRoot, '.create-unrelated');
    await mkdir(unrelated);
    const task = parseClaudeTaskInput({ workspace: root, prompt: 'terminal remnant' });
    const queued = await store.create(task, 'job_terminal_remnant', 'token');
    const cancelled = await store.setTerminalIntent(queued.job.id, queued.revision, 'cancelled');
    await writeFile(store.paths(cancelled.job.id).request, '{"prompt":"terminal remnant"}', { mode: 0o600 });

    const restarted = new JobStore({
      stateRoot,
      leaseOwner: { token: 'self2', pid: 1, birthIdentity: 'self-birth' },
      leaseOwnerVerifier: async (owner) => owner.token !== 'dead',
    });
    await restarted.init();
    await expect(lstat(staging)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(restarted.paths(cancelled.job.id).request)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(unrelated)).resolves.toBeTruthy();
  });

  it('rejects final job collisions without replacing existing private state', async () => {
    const { store, task } = await setup();
    await store.create(task, 'job_collision', 'first');
    await expect(store.create(task, 'job_collision', 'second')).rejects.toMatchObject({ code: 'invalid-input' });
    expect((await store.read('job_collision')).runner.token).toBe('first');
  });
});
