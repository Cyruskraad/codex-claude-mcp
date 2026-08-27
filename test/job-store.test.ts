import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
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
});
