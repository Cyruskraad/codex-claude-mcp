import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeClaudeHealth } from '../src/health.js';

const fakeClaude = resolve(import.meta.dirname, 'fixtures/fake-claude.mjs');
const nodeBin = dirname(process.execPath);
const completeEnvironment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PATH: `${nodeBin}:${process.env.PATH ?? ''}`,
  CODEX_CLAUDE_MCP_CLAUDE_PATH: fakeClaude,
  ...overrides,
});
const helpWithoutMaxTurns = [
  '-p, --print', '--input-format stream-json', '--output-format stream-json', '--verbose',
  '--no-chrome', '--tools', '--permission-mode', '--model', '--effort', '--resume', '--cloud',
  '--name', '--mcp-config', '--strict-mcp-config', '--disallowedTools',
].join('\n');

describe('Claude health probe', () => {
  it('confirms max-turns with a prompt-free parser probe when current help omits it', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-claude-health-max-turns-')));
    const record = join(root, 'probe.json');
    const health = await probeClaudeHealth({
      environment: completeEnvironment({
        FAKE_CLAUDE_HELP: helpWithoutMaxTurns,
        FAKE_MAX_TURNS_PROBE_SCENARIO: 'recognized',
        FAKE_MAX_TURNS_PROBE_RECORD: record,
      }),
    });

    expect(health).toMatchObject({
      status: 'ready', features: { max_turns: true }, issues: [],
    });
    expect(JSON.parse(await readFile(record, 'utf8'))).toEqual({
      argv: ['-p', '--max-turns', '0'], stdin: '',
    });
  });

  it('accepts the exact missing-input diagnostic emitted by Claude Code 2.1.247', async () => {
    const health = await probeClaudeHealth({
      environment: completeEnvironment({
        FAKE_CLAUDE_HELP: helpWithoutMaxTurns,
        FAKE_MAX_TURNS_PROBE_SCENARIO: 'recognized-prompt-argument',
      }),
    });

    expect(health).toMatchObject({ status: 'ready', features: { max_turns: true }, issues: [] });
  });

  it('allows a bounded four-second default for a cold max-turns parser probe', async () => {
    const started = Date.now();
    const health = await probeClaudeHealth({
      environment: completeEnvironment({
        FAKE_CLAUDE_HELP: helpWithoutMaxTurns,
        FAKE_MAX_TURNS_PROBE_SCENARIO: 'slow-recognized-prompt-argument',
      }),
    });

    expect(health).toMatchObject({ status: 'ready', features: { max_turns: true }, issues: [] });
    expect(Date.now() - started).toBeLessThan(4_500);
  });

  it.each([
    ['an unknown option response', 'unknown'],
    ['an ambiguous failure', 'uncertain'],
    ['an authentication failure', 'authentication'],
    ['a network failure', 'network'],
    ['an unexpected zero exit', 'exit-zero'],
    ['a signalled process after recognized-looking text', 'signal-after-recognized'],
    ['a generic missing-input response', 'bare-missing-input'],
    ['mixed unknown-option and recognized-looking text', 'mixed'],
  ] as const)('keeps max-turns unsupported after %s', async (_name, scenario) => {
    const health = await probeClaudeHealth({
      environment: completeEnvironment({
        FAKE_CLAUDE_HELP: helpWithoutMaxTurns,
        FAKE_MAX_TURNS_PROBE_SCENARIO: scenario,
        FAKE_MAX_TURNS_PROBE_OUTPUT: 'private parser diagnostic person@example.test',
      }),
    });

    expect(health.status).toBe('degraded');
    expect(health.features.max_turns).toBe(false);
    expect(health.issues).toContain('required_feature_missing');
    expect(JSON.stringify(health)).not.toMatch(/private|person@example/i);
  });

  it('does not run the parser fallback when help already advertises max-turns', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-claude-health-no-max-probe-')));
    const record = join(root, 'unexpected-probe.json');
    const health = await probeClaudeHealth({
      environment: completeEnvironment({
        FAKE_MAX_TURNS_PROBE_SCENARIO: 'recognized',
        FAKE_MAX_TURNS_PROBE_RECORD: record,
      }),
    });

    expect(health).toMatchObject({ status: 'ready', features: { max_turns: true }, issues: [] });
    await expect(readFile(record, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['a timed-out max-turns parser probe', 'hang'],
    ['a byte-limited max-turns parser probe', 'flood'],
  ] as const)('bounds and conservatively rejects %s', async (_name, scenario) => {
    const started = Date.now();
    const health = await probeClaudeHealth({
      environment: completeEnvironment({
        FAKE_CLAUDE_HELP: helpWithoutMaxTurns,
        FAKE_MAX_TURNS_PROBE_SCENARIO: scenario,
      }),
      timeouts: { maxTurns: 250, killGrace: 20 },
    });

    expect(health.status).toBe('degraded');
    expect(health.features.max_turns).toBe(false);
    expect(health.issues).toContain('probe_timeout');
    expect(health.issues).toContain('required_feature_missing');
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('passes only the injected probe environment and gives exit zero precedence over sensitive auth prose', async () => {
    const injected = await probeClaudeHealth({
      environment: completeEnvironment({
        FAKE_AUTH_SCENARIO: 'unknown',
        FAKE_AUTH_OUTPUT: 'private injected profile person@example.test',
      }),
    });
    expect(injected.authentication).toEqual({ status: 'unknown', ready: false });
    const health = await probeClaudeHealth({
      environment: completeEnvironment({
        FAKE_AUTH_SCENARIO: 'ready',
        FAKE_AUTH_OUTPUT: 'session expired; log in again person@example.test sk-ant-api03-private',
      }),
      homeDirectory: '/unrelated-home',
      bridgeCounts: async () => ({ runningJobs: 2, queuedJobs: 3 }),
    });
    expect(health).toMatchObject({
      status: 'ready', authentication: { status: 'ready', ready: true },
      bridge: { running_jobs: 2, queued_jobs: 3, concurrency_limit: 2 },
    });
    expect(JSON.stringify(health)).not.toMatch(/person@example|sk-ant|expired|log in again/i);
  });

  it.each([
    ['a timed-out version probe', { FAKE_VERSION_SCENARIO: 'hang' }, 'probe_timeout'],
    ['a byte-limited version probe', { FAKE_VERSION_SCENARIO: 'flood' }, 'probe_timeout'],
    ['a timed-out help probe', { FAKE_HELP_SCENARIO: 'hang' }, 'probe_timeout'],
    ['a byte-limited help probe', { FAKE_HELP_SCENARIO: 'flood' }, 'probe_timeout'],
    ['a combined-stream byte-limited help probe', { FAKE_HELP_SCENARIO: 'combined-flood' }, 'probe_timeout'],
    ['a timed-out auth probe', { FAKE_AUTH_SCENARIO: 'hang' }, 'probe_timeout'],
  ] as const)('bounds and reaps %s', async (_name, scenario, issue) => {
    const started = Date.now();
    const health = await probeClaudeHealth({
      environment: completeEnvironment(scenario),
      timeouts: { version: 250, help: 250, auth: 250, killGrace: 20 },
    });
    expect(health.issues).toContain(issue);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('skips empty and relative PATH entries and selects a canonical executable from an absolute entry', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-claude-health-path-')));
    const bin = join(root, 'bin');
    await mkdir(bin);
    await symlink(fakeClaude, join(bin, 'claude'));
    const health = await probeClaudeHealth({
      environment: {
        PATH: `${['', 'relative-bin', bin, nodeBin].join(':')}`,
        FAKE_AUTH_SCENARIO: 'ready',
      },
      homeDirectory: '/unrelated-home',
    });
    expect(health).toMatchObject({
      status: 'ready', cli: { found: true, path: fakeClaude, resolution: 'path', version_status: 'supported' },
    });
  });

  it.each([
    ['too-old version', { FAKE_CLAUDE_VERSION: '2.0.99 (Claude Code)' }, 'too_old', 'version_too_old', 'not_checked'],
    ['malformed version', { FAKE_CLAUDE_VERSION: 'private malformed version' }, 'malformed', 'version_malformed', 'not_checked'],
    ['missing feature', { FAKE_CLAUDE_HELP: '--print --input-format stream-json' }, 'supported', 'required_feature_missing', 'ready'],
    ['not-ready auth', { FAKE_AUTH_SCENARIO: 'not_ready', FAKE_AUTH_OUTPUT: 'not logged in' }, 'supported', 'authentication_not_ready', 'not_ready'],
    ['expired auth', { FAKE_AUTH_SCENARIO: 'expired', FAKE_AUTH_OUTPUT: 'session expired; log in again' }, 'supported', 'authentication_expired', 'expired'],
    ['unknown auth', { FAKE_AUTH_SCENARIO: 'unknown', FAKE_AUTH_OUTPUT: 'private profile' }, 'supported', 'authentication_unknown', 'unknown'],
  ] as const)('normalizes %s to stable health fields', async (_name, scenario, versionStatus, issue, authentication) => {
    const health = await probeClaudeHealth({ environment: completeEnvironment(scenario) });
    expect(health.status).toBe('degraded');
    expect(health.cli.version_status).toBe(versionStatus);
    expect(health.authentication.status).toBe(authentication);
    expect(health.issues).toContain(issue);
    expect(JSON.stringify(health)).not.toContain('private');
  });

  it('rejects valid-looking version output when the version command exits nonzero', async () => {
    const health = await probeClaudeHealth({
      environment: completeEnvironment({ FAKE_VERSION_EXIT: '7' }),
    });
    expect(health).toMatchObject({
      status: 'degraded',
      cli: { found: true, version_status: 'malformed' },
      authentication: { status: 'not_checked', ready: false },
      issues: ['version_malformed'],
    });
    expect(health.cli).not.toHaveProperty('version');
  });

  it('rejects complete-looking help output when the help command exits nonzero', async () => {
    const health = await probeClaudeHealth({
      environment: completeEnvironment({ FAKE_HELP_EXIT: '7' }),
    });
    expect(health.status).toBe('degraded');
    expect(health.features).toEqual(expect.objectContaining({ print: false, stream_json: false, explicit_resume: false }));
    expect(health.issues).toContain('required_feature_missing');
  });

  it.each([
    ['missing', '/definitely/missing/claude', 'not_found', 'cli_not_found'],
    ['relative', 'relative/claude', 'not_executable', 'cli_not_executable'],
    ['empty', '', 'not_executable', 'cli_not_executable'],
  ] as const)('keeps a %s explicit override authoritative', async (_name, override, status, issue) => {
    const health = await probeClaudeHealth({
      environment: { PATH: `${dirname(fakeClaude)}:${nodeBin}`, CODEX_CLAUDE_MCP_CLAUDE_PATH: override },
    });
    expect(health).toMatchObject({ status: 'unavailable', cli: { found: false, version_status: status } });
    expect(health.issues).toEqual([issue]);
  });

  it('classifies an existing non-executable override without falling back', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-claude-health-file-')));
    const candidate = join(root, 'claude');
    await writeFile(candidate, '#!/bin/sh\n', { mode: 0o600 });
    const health = await probeClaudeHealth({
      environment: { PATH: `${dirname(fakeClaude)}:${nodeBin}`, CODEX_CLAUDE_MCP_CLAUDE_PATH: candidate },
    });
    expect(health).toMatchObject({
      status: 'unavailable', cli: { found: false, resolution: 'override', version_status: 'not_executable' },
      issues: ['cli_not_executable'],
    });
  });

  it('shortens an executable under the canonical home even when the supplied home is a symlink', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-claude-health-home-')));
    const canonicalHome = join(root, 'canonical-home');
    const linkedHome = join(root, 'linked-home');
    await mkdir(canonicalHome);
    await symlink(canonicalHome, linkedHome);
    const executable = join(canonicalHome, 'claude');
    await copyFile(fakeClaude, executable);
    await chmod(executable, 0o755);
    const health = await probeClaudeHealth({
      environment: completeEnvironment({ CODEX_CLAUDE_MCP_CLAUDE_PATH: join(linkedHome, 'claude') }),
      homeDirectory: linkedHome,
    });
    expect(health.cli.path).toBe('~/claude');
  });
});
