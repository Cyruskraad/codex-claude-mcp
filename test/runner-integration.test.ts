import { chmod, mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseClaudeTaskInput } from '../src/contracts.js';
import { JobStore } from '../src/job-store.js';
import { executeRunner } from '../src/runner-engine.js';

const fakeClaude = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const originalEnv = { ...process.env };

beforeAll(async () => chmod(fakeClaude, 0o755));
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

async function setup(scenario: string, overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex-claude-runner-'));
  const workspace = join(root, 'workspace');
  const control = join(root, 'fake-control');
  await mkdir(workspace);
  await mkdir(control);
  process.env.FAKE_CLAUDE_CONTROL_DIR = control;
  process.env.FAKE_CLAUDE_SCENARIO = scenario;
  const store = new JobStore({ stateRoot: join(root, 'state') });
  await store.init();
  const task = parseClaudeTaskInput({ workspace, prompt: 'super secret prompt', execution: { mode: 'async', timeout_seconds: 30 }, ...overrides });
  const queued = await store.create(task, 'job_runner', 'runner_token');
  const running = await store.claim(queued.job.id, queued.revision, { pid: process.pid, birthIdentity: 'test' });
  return { root, workspace, control, store, running };
}

describe('detached Claude runner integration', () => {
  it('validates version, sends exact argv/stdin, deletes request, and publishes normalized success', async () => {
    const { control, store, running } = await setup('success', { session: { mode: 'resume', session_id: 'sess_original' } });
    await executeRunner({ store, jobId: running.job.id, runnerToken: 'runner_token', claudePath: fakeClaude });
    const final = await store.read(running.job.id);
    expect(final.job).toMatchObject({ state: 'succeeded', claude_session_id: 'sess_fake', exit_code: 0, usage: { input_tokens: 3, output_tokens: 4 }, total_cost_usd: 0.012, result_preview: 'héllo 🌍' });
    expect(JSON.parse(await readFile(join(control, 'argv.json'), 'utf8'))).toEqual(expect.arrayContaining(['--resume', 'sess_original']));
    expect(await readFile(join(control, 'stdin.txt'), 'utf8')).toContain('super secret prompt');
    expect(JSON.stringify(final)).not.toContain('super secret prompt');
    expect(await readFile(store.paths(running.job.id).rawStdout, 'utf8')).not.toContain('super secret prompt');
    await expect(stat(store.paths(running.job.id).request)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('redacts a prompt echoed by Claude before persisting public result or raw output', async () => {
    process.env.FAKE_CLAUDE_RESULT = 'prefix super secret prompt suffix';
    const { store, running } = await setup('success');
    await executeRunner({ store, jobId: running.job.id, runnerToken: 'runner_token', claudePath: fakeClaude });
    const final = await store.read(running.job.id);
    expect(JSON.stringify(final)).not.toContain('super secret prompt');
    expect(await readFile(store.paths(running.job.id).result, 'utf8')).toBe('prefix [redacted prompt] suffix');
    expect(await readFile(store.paths(running.job.id).rawStdout, 'utf8')).not.toContain('super secret prompt');
  });

  it.each([
    ['malformed', 'malformed-stream'], ['auth', 'auth-required'], ['crash', 'claude-failed'], ['partial-crash', 'claude-failed'],
  ])('normalizes %s failure without exposing child bytes', async (scenario, code) => {
    const { store, running } = await setup(scenario);
    await executeRunner({ store, jobId: running.job.id, runnerToken: 'runner_token', claudePath: fakeClaude });
    const final = await store.read(running.job.id);
    expect(final.job).toMatchObject({ state: 'failed', error: { code } });
    expect(JSON.stringify(final.job)).not.toMatch(/private|super secret/i);
    expect(await readFile(store.paths(running.job.id).result, 'utf8')).toBe('');
  });

  it.each(['not a version', '2.0.9', '1.99.99'])('rejects malformed or too-old Claude version %s', async (version) => {
    process.env.FAKE_CLAUDE_VERSION = version;
    const { store, running } = await setup('success');
    await executeRunner({ store, jobId: running.job.id, runnerToken: 'runner_token', claudePath: fakeClaude });
    expect((await store.read(running.job.id)).job).toMatchObject({ state: 'failed', error: { code: 'claude-unsupported' } });
  });

  it.each(['3.0.0', '2.2.0', '2.1.1'])('accepts Claude versions newer than the baseline: %s', async (version) => {
    process.env.FAKE_CLAUDE_VERSION = version;
    const { store, running } = await setup('success');
    await executeRunner({ store, jobId: running.job.id, runnerToken: 'runner_token', claudePath: fakeClaude });
    expect((await store.read(running.job.id)).job.state).toBe('succeeded');
  });

  it('normalizes a missing executable without retaining its path', async () => {
    const { store, running } = await setup('success');
    const missing = join(dirname(fakeClaude), 'does-not-exist-private-name');
    await executeRunner({ store, jobId: running.job.id, runnerToken: 'runner_token', claudePath: missing });
    const job = (await store.read(running.job.id)).job;
    expect(job).toMatchObject({ state: 'failed', error: { code: 'claude-not-found' } });
    expect(JSON.stringify(job)).not.toContain('does-not-exist-private-name');
  });

  it.each([
    [{ mode: 'cloud_create', description: 'Safe name' }, ['--cloud', '--name', 'Safe name']],
    [{ mode: 'cloud_attach', target: 'cloud_target' }, ['--cloud', 'cloud_target']],
  ] as const)('passes exact cloud args for %o while keeping prompt off argv', async (session, expected) => {
    const { control, store, running } = await setup('success', { session });
    await executeRunner({ store, jobId: running.job.id, runnerToken: 'runner_token', claudePath: fakeClaude });
    const args = JSON.parse(await readFile(join(control, 'argv.json'), 'utf8')) as string[];
    expect(args.slice(-expected.length)).toEqual(expected);
    expect(args.join(' ')).not.toContain('super secret prompt');
  });

  it('enforces an injected deadline with TERM then KILL and a sticky timed-out state', async () => {
    process.env.FAKE_CLAUDE_IGNORE_TERM = '1';
    const { store, running } = await setup('hang');
    let deadline!: () => void;
    const kills: string[] = [];
    await executeRunner({
      store, jobId: running.job.id, runnerToken: 'runner_token', claudePath: fakeClaude,
      scheduleDeadline: (callback) => { deadline = callback; return () => undefined; },
      terminateProcessGroup: async (_pgid, signal) => { kills.push(signal); if (signal === 'SIGKILL') process.kill(_pgid, signal); },
      waitForGrace: async () => undefined,
      onClaudeSpawned: () => deadline(),
    });
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect((await store.read(running.job.id)).job).toMatchObject({ state: 'timed_out', error: { code: 'timed-out' } });
  });

  it.each([
    ['stdout-bytes', 32, 32, 'failed'],
    ['stdout-bytes', 33, 32, 'output_limited'],
    ['stderr-bytes', 32, 32, 'failed'],
    ['stderr-bytes', 33, 32, 'output_limited'],
  ])('counts byte output without requiring newlines (%s)', async (scenario, bytes, limit, expectedState) => {
    process.env.FAKE_OUTPUT_BYTES = String(bytes);
    const { store, running } = await setup(scenario);
    await executeRunner({
      store, jobId: running.job.id, runnerToken: 'runner_token', claudePath: fakeClaude, outputLimitBytes: limit,
      terminateProcessGroup: async (pgid, signal) => {
        try { process.kill(pgid, signal); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      },
      waitForGrace: async () => undefined,
    });
    const final = await store.read(running.job.id);
    expect(final.rawByteCount).toBe(Math.min(bytes, limit));
    expect(final.job.state).toBe(expectedState);
    expect((await stat(store.paths(running.job.id).rawStdout)).size).toBe(0);
  });
});
