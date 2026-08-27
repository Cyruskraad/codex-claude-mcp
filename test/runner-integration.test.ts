import { access, chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseClaudeTaskInput } from '../src/contracts.js';
import { JobStore } from '../src/job-store.js';
import { executeRunner } from '../src/runner-engine.js';

const fakeClaude = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const originalEnv = { ...process.env };
const testProcessIdentity = async (pid: number) => ({ state: 'live' as const, birthIdentity: `linux:${pid}` });
const inspectArgs = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--max-turns', '20', '--no-chrome', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--disallowedTools', 'mcp__*', '--tools', 'Read,Glob,Grep', '--permission-mode', 'plan',
];
const writeArgs = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--max-turns', '20', '--no-chrome', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--disallowedTools', 'mcp__*', '--permission-mode', 'acceptEdits',
];

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
  const store = new JobStore({ stateRoot: join(root, 'state'), processIdentityInspector: testProcessIdentity });
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
    expect(JSON.parse(await readFile(join(control, 'argv.json'), 'utf8'))).toEqual([...inspectArgs, '--resume', 'sess_original']);
    expect(await readFile(join(control, 'stdin.txt'), 'utf8')).toContain('super secret prompt');
    expect(JSON.stringify(final)).not.toContain('super secret prompt');
    expect(await readFile(store.paths(running.job.id).rawStdout, 'utf8')).not.toContain('super secret prompt');
    await expect(stat(store.paths(running.job.id).request)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs write access with exactly acceptEdits and no bypass-style permission', async () => {
    const { control, store, running } = await setup('success', { access: 'write' });
    await executeRunner({ store, jobId: running.job.id, runnerToken: 'runner_token', claudePath: fakeClaude });
    const args = JSON.parse(await readFile(join(control, 'argv.json'), 'utf8')) as string[];
    expect(args).toEqual(writeArgs);
    expect(args.filter((argument) => argument === '--permission-mode')).toHaveLength(1);
    for (const forbidden of [
      '--tools', '--dangerously-skip-permissions', 'bypassPermissions', 'auto', 'dontAsk', '--accept-edits',
      '--add-dir', '--chrome',
    ]) {
      expect(args).not.toContain(forbidden);
    }
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

  it.each(['not a version', '2.0.9', '1.99.99', '2.1.0-beta.1', '2.1.0 garbage'])('rejects malformed, prerelease, suffixed, or too-old Claude version %s', async (version) => {
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
    ['empty PATH entry', '', undefined],
    ['dot PATH entry', '.', undefined],
    ['relative PATH entry', 'relative-bin', undefined],
    ['relative explicit override', '/definitely/safe', './claude'],
    ['empty explicit override', '/definitely/safe', ''],
  ] as const)('never executes a repository Claude binary from %s', async (_name, pathValue, explicitOverride) => {
    const { workspace, store, running } = await setup('success');
    const executableDirectory = pathValue === 'relative-bin' ? join(workspace, 'relative-bin') : workspace;
    await mkdir(executableDirectory, { recursive: true });
    const marker = join(workspace, 'claude-executed');
    const maliciousClaude = join(executableDirectory, 'claude');
    await writeFile(maliciousClaude, [
      '#!/bin/sh',
      `/bin/echo executed > '${marker}'`,
      'if [ "$1" = "--version" ]; then /bin/echo "2.1.0 (Claude Code)"; fi',
    ].join('\n'), { mode: 0o700 });
    const previousCwd = process.cwd();
    const environment: NodeJS.ProcessEnv = { ...process.env, PATH: pathValue };
    delete environment.CODEX_CLAUDE_MCP_CLAUDE_PATH;
    process.chdir(workspace);
    try {
      await executeRunner({
        store, jobId: running.job.id, runnerToken: 'runner_token', environment,
        ...(explicitOverride === undefined ? {} : { claudePath: explicitOverride }),
      });
    } finally {
      process.chdir(previousCwd);
    }
    expect((await store.read(running.job.id)).job).toMatchObject({
      state: 'failed', error: { code: 'claude-not-found' },
    });
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    [{ mode: 'cloud_attach', target: 'cloud_target' }, ['--cloud', 'cloud_target']],
  ] as const)('passes exact cloud args for %o while keeping prompt off argv', async (session, expected) => {
    const { control, store, running } = await setup('success', { session });
    await executeRunner({ store, jobId: running.job.id, runnerToken: 'runner_token', claudePath: fakeClaude });
    const args = JSON.parse(await readFile(join(control, 'argv.json'), 'utf8')) as string[];
    expect(args).toEqual([...inspectArgs, ...expected]);
    expect(args.join(' ')).not.toContain('super secret prompt');
  });

  it('enforces an injected deadline with TERM then KILL and a sticky timed-out state', async () => {
    process.env.FAKE_CLAUDE_IGNORE_TERM = '1';
    const { store, running } = await setup('hang');
    let deadline!: () => void;
    const kills: string[] = [];
    let childPid = 0;
    await executeRunner({
      store, jobId: running.job.id, runnerToken: 'runner_token', claudePath: fakeClaude,
      scheduleDeadline: (callback) => { deadline = callback; return () => undefined; },
      runnerPid: 777,
      signalRunnerGroup: async (runnerPid, signal) => {
        expect(runnerPid).toBe(777);
        expect((await store.readControl(running.job.id)).terminalIntent).toBe('timed_out');
        kills.push(signal);
        if (signal === 'SIGKILL') process.kill(childPid, signal);
      },
      waitForGrace: async () => undefined,
      onClaudeSpawned: (pid, topology) => { childPid = pid; expect(topology).toEqual({ detached: false }); deadline(); },
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
    let childPid = 0;
    await executeRunner({
      store, jobId: running.job.id, runnerToken: 'runner_token', claudePath: fakeClaude, outputLimitBytes: limit,
      runnerPid: 888,
      onClaudeSpawned: (pid) => { childPid = pid; },
      signalRunnerGroup: async (runnerPid, signal) => {
        expect(runnerPid).toBe(888);
        try { process.kill(childPid, signal); } catch (error) {
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

  it.each([[16, 16, 'failed'], [16, 17, 'output_limited']] as const)(
    'enforces one combined stdout+stderr cap at the exact boundary (%i + %i)', async (stdoutBytes, stderrBytes, state) => {
      process.env.FAKE_STDOUT_BYTES = String(stdoutBytes);
      process.env.FAKE_STDERR_BYTES = String(stderrBytes);
      const { store, running } = await setup('combined-bytes');
      let childPid = 0;
      await executeRunner({
        store, jobId: running.job.id, runnerToken: 'runner_token', claudePath: fakeClaude, outputLimitBytes: 32,
        runnerPid: 889, onClaudeSpawned: (pid) => { childPid = pid; }, waitForGrace: async () => undefined,
        signalRunnerGroup: async (_pid, signal) => { try { process.kill(childPid, signal); } catch { /* already reaped */ } },
      });
      const final = await store.read(running.job.id);
      expect(final.rawByteCount).toBe(32);
      expect(final.job.state).toBe(state);
    },
  );

  it('stops a sustained no-newline TERM-ignoring flood after durable intent, then orders TERM before KILL', async () => {
    const { store, running } = await setup('flood');
    let childPid = 0;
    const events: string[] = [];
    await executeRunner({
      store, jobId: running.job.id, runnerToken: 'runner_token', claudePath: fakeClaude, outputLimitBytes: 1024,
      runnerPid: 890, onClaudeSpawned: (pid) => { childPid = pid; }, waitForGrace: async () => undefined,
      signalRunnerGroup: async (_pid, signal) => {
        events.push(`${(await store.readControl(running.job.id)).terminalIntent}:${signal}`);
        if (signal === 'SIGKILL') process.kill(childPid, signal);
      },
    });
    expect(events).toEqual(['output_limited:SIGTERM', 'output_limited:SIGKILL']);
    expect((await store.read(running.job.id))).toMatchObject({ rawByteCount: 1024, job: { state: 'output_limited' } });
  });

  it('bounds a hanging version probe by the total job deadline', async () => {
    process.env.FAKE_VERSION_SCENARIO = 'hang';
    const { store, running } = await setup('success');
    let deadline!: () => void;
    let preflightPid = 0;
    const signals: string[] = [];
    await executeRunner({
      store, jobId: running.job.id, runnerToken: 'runner_token', claudePath: fakeClaude, runnerPid: 891,
      scheduleDeadline: (callback) => { deadline = callback; return () => undefined; },
      onPreflightSpawned: (pid) => { preflightPid = pid; setImmediate(deadline); }, waitForGrace: async () => undefined,
      signalRunnerGroup: async (_pid, signal) => { signals.push(signal); if (signal === 'SIGKILL') process.kill(preflightPid, signal); },
    });
    expect(signals.every((signal) => signal === 'SIGTERM' || signal === 'SIGKILL')).toBe(true);
    expect((await store.read(running.job.id)).job.state).toBe('timed_out');
  });

  it('does not spawn Claude when cancellation wins after preflight but before the synchronous spawn', async () => {
    process.env.FAKE_CLAUDE_IGNORE_TERM = '1';
    const { store, running } = await setup('hang');
    const readRequest = store.readRequest.bind(store);
    store.readRequest = async (jobId) => {
      const latest = await store.read(jobId);
      await store.requestTerminalIntent(jobId, latest.revision, 'cancelled');
      return readRequest(jobId);
    };
    let spawned = 0;
    let childPid = 0;
    let deadline!: () => void;
    const signals: string[] = [];
    await executeRunner({
      store, jobId: running.job.id, runnerToken: 'runner_token', claudePath: fakeClaude, runnerPid: 893,
      scheduleDeadline: (callback) => { deadline = callback; return () => undefined; },
      onClaudeSpawned: (pid) => { spawned += 1; childPid = pid; deadline(); },
      signalRunnerGroup: async (_pid, signal) => { signals.push(signal); if (signal === 'SIGKILL') process.kill(childPid, signal); },
      waitForGrace: async () => undefined,
    });
    expect(spawned).toBe(0);
    expect(signals).toEqual([]);
    expect((await store.read(running.job.id)).job.state).toBe('cancelled');
  });

  it('observes service cancellation control and signals only from the live runner', async () => {
    process.env.FAKE_CLAUDE_IGNORE_TERM = '1';
    const { store, running } = await setup('hang');
    let childPid = 0;
    const signals: string[] = [];
    await executeRunner({
      store, jobId: running.job.id, runnerToken: 'runner_token', claudePath: fakeClaude, runnerPid: 892,
      controlPollMilliseconds: 1, waitForGrace: async () => undefined,
      onClaudeSpawned: (pid) => { childPid = pid; void store.requestTerminalIntent(running.job.id, running.revision, 'cancelled'); },
      signalRunnerGroup: async (_pid, signal) => { signals.push(signal); if (signal === 'SIGKILL') process.kill(childPid, signal); },
    });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect((await store.read(running.job.id)).job.state).toBe('cancelled');
  });
});
