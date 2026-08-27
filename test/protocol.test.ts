import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '..');
const serverBundle = join(repositoryRoot, 'plugins/codex-claude-mcp/dist/server.mjs');
const fakeClaude = join(repositoryRoot, 'test/fixtures/fake-claude.mjs');
const runFile = promisify(execFile);
const helpWithoutMaxTurns = [
  '-p, --print', '--input-format stream-json', '--output-format stream-json', '--verbose',
  '--no-chrome', '--tools', '--permission-mode', '--model', '--effort', '--resume', '--cloud',
  '--name', '--mcp-config', '--strict-mcp-config', '--disallowedTools',
].join('\n');
type ProtocolSchema = Record<string, unknown> & {
  properties: Record<string, ProtocolSchema>;
  anyOf: ProtocolSchema[];
  required?: string[];
  additionalProperties?: boolean;
};

async function withProtocolClient<T>(
  action: (client: Client) => Promise<T>,
  environment: Record<string, string> = {},
  suppliedStateRoot?: string,
): Promise<T> {
  const stateRoot = suppliedStateRoot ?? await mkdtemp(join(tmpdir(), 'codex-claude-protocol-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverBundle],
    cwd: repositoryRoot,
    env: {
      HOME: process.env.HOME ?? tmpdir(),
      PATH: process.env.PATH ?? '',
      CODEX_CLAUDE_MCP_STATE_DIR: stateRoot,
      ...environment,
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 8_192) stderr += chunk.toString('utf8').slice(0, 8_192 - stderr.length);
  });
  const client = new Client({ name: 'codex-claude-protocol-test', version: '0.1.0' });
  try {
    await client.connect(transport);
    return await action(client);
  } catch (error) {
    if (stderr) throw new Error(`Protocol server failed: ${stderr}`, { cause: error });
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function structured<T>(result: unknown): T {
  return (result as { structuredContent?: unknown }).structuredContent as T;
}

const terminalStates = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'output_limited', 'orphaned']);
async function waitForTerminal(client: Client, jobId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const result = await client.callTool({ name: 'claude_job_status', arguments: { job_id: jobId } });
    const view = structured<{ job: Record<string, unknown> }>(result);
    if (terminalStates.has(String(view.job.state))) return view.job;
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
  }
  throw new Error('Fake Claude job did not reach a terminal state.');
}

async function runServerUntilStdioEof(
  stateRoot: string,
  environment: Record<string, string>,
): Promise<{ pid: number; code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolveExit, rejectExit) => {
    const child = spawn(process.execPath, [serverBundle], {
      cwd: repositoryRoot,
      env: {
        HOME: process.env.HOME ?? tmpdir(), PATH: process.env.PATH ?? '',
        CODEX_CLAUDE_MCP_STATE_DIR: stateRoot, ...environment,
      },
      shell: false,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const pid = child.pid!;
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(0, Math.max(0, 8_192 - stderr.length));
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectExit(new Error('Raw stdio server did not exit after EOF.'));
    }, 3_000);
    child.once('error', rejectExit);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ pid, code, signal, stderr });
    });
    child.stdin.end();
  });
}

describe('built MCP protocol', () => {
  it('initializes with durable-work instructions and exactly seven accurately annotated tools', async () => {
    await withProtocolClient(async (client) => {
      expect(client.getServerVersion()).toEqual({ name: 'codex-claude-mcp', version: '0.1.0' });
      expect(client.getServerCapabilities()).toMatchObject({ tools: {} });
      const instructions = client.getInstructions() ?? '';
      expect(instructions).toContain('claude_health');
      expect(instructions).toContain('defaults to inspect');
      expect(instructions).toContain('explicit authorization');
      expect(instructions).toContain('absolute real Git workspace');
      expect(instructions).toContain('Claude transcript remains');
      expect(instructions).not.toContain('ordinary Claude.ai chats');

      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toEqual([
        'claude_health',
        'claude_task',
        'claude_job_status',
        'claude_job_result',
        'claude_job_continue',
        'claude_job_cancel',
        'claude_job_forget',
      ]);
      for (const tool of tools) {
        expect(tool.title).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
        expect(tool.outputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      }
      expect(tools.map((tool) => tool.annotations)).toEqual([
        { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
        { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
        { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
        { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
        { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
        { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
        { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
      ]);

      const task = tools.find((tool) => tool.name === 'claude_task')!;
      expect(task.inputSchema.required).toEqual(['workspace', 'prompt']);
      const taskProperties = (task.inputSchema as unknown as ProtocolSchema).properties;
      expect(taskProperties).toMatchObject({
        prompt: { minLength: 1, maxLength: 100000 },
        access: { enum: ['inspect', 'write'], default: 'inspect' },
        model: { maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$' },
        effort: { enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
        max_turns: { minimum: 1, maximum: 100, default: 20 },
      });
      expect(taskProperties.execution).toEqual({
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['auto', 'sync', 'async'], default: 'auto' },
          wait_seconds: { type: 'integer', minimum: 0, maximum: 45, default: 45 },
          timeout_seconds: { type: 'integer', minimum: 30, maximum: 7200, default: 1800 },
        },
        additionalProperties: false,
        default: { mode: 'auto', wait_seconds: 45, timeout_seconds: 1800 },
      });
      expect(taskProperties.session.default).toEqual({ mode: 'new' });
      expect(taskProperties.session.anyOf.map((variant) => ({
        mode: variant.properties.mode.const,
        required: variant.required,
        strict: variant.additionalProperties,
      }))).toEqual([
        { mode: 'new', required: ['mode'], strict: false },
        { mode: 'resume', required: ['mode', 'session_id'], strict: false },
        { mode: 'cloud_create', required: ['mode'], strict: false },
        { mode: 'cloud_attach', required: ['mode', 'target'], strict: false },
      ]);
      expect(taskProperties.session.anyOf[1].properties.session_id).toMatchObject({ minLength: 1, maxLength: 512 });
      expect(taskProperties.session.anyOf[2].properties.description).toMatchObject({ minLength: 1, maxLength: 256 });

      const continuation = tools.find((tool) => tool.name === 'claude_job_continue')!;
      expect(Object.keys(continuation.inputSchema.properties ?? {}).sort()).toEqual(['execution', 'job_id', 'prompt']);
      expect((continuation.inputSchema as unknown as ProtocolSchema).properties.execution).toMatchObject({
        additionalProperties: false,
        properties: {
          mode: { enum: ['auto', 'sync', 'async'], default: 'auto' },
          wait_seconds: { minimum: 0, maximum: 45, default: 45 },
          timeout_seconds: { minimum: 30, maximum: 7200, default: 1800 },
        },
      });
      for (const name of ['claude_job_status', 'claude_job_cancel', 'claude_job_forget']) {
        const schema = tools.find((tool) => tool.name === name)!.inputSchema;
        expect(schema.properties?.job_id).toMatchObject({ minLength: 1, maxLength: 512 });
      }
      const resultTool = tools.find((tool) => tool.name === 'claude_job_result')!;
      expect(resultTool.inputSchema.properties).toMatchObject({
        job_id: { minLength: 1, maxLength: 512 }, cursor: { minLength: 1, maxLength: 4096 },
      });

      const statusOutput = tools.find((tool) => tool.name === 'claude_job_status')!.outputSchema as unknown as ProtocolSchema;
      expect(statusOutput.properties.job).toMatchObject({
        additionalProperties: false,
        properties: {
          id: { minLength: 1, maxLength: 128 },
          state: { enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'output_limited', 'orphaned'] },
          max_turns: { minimum: 1, maximum: 100 },
          claude_session_id: { minLength: 1, maxLength: 512 },
          result_preview: { maxLength: 4096 },
          usage: { additionalProperties: false },
          error: { additionalProperties: false },
        },
      });
      expect(statusOutput.properties.progress_tail).toMatchObject({ maxItems: 20, items: { maxLength: 1024 } });
      expect((resultTool.outputSchema as unknown as ProtocolSchema).properties.next_cursor).toMatchObject({ minLength: 1, maxLength: 4096 });

      const healthOutput = tools[0].outputSchema as unknown as ProtocolSchema;
      for (const nested of ['cli', 'features', 'authentication', 'bridge']) {
        expect(healthOutput.properties[nested].additionalProperties).toBe(false);
      }
      expect(healthOutput.properties.status.enum).toEqual(['ready', 'degraded', 'unavailable']);
      expect(healthOutput.properties.cli.properties.version_status.enum).toEqual([
        'supported', 'too_old', 'malformed', 'timeout', 'not_found', 'not_executable',
      ]);
      expect(healthOutput.properties.authentication.properties.status.enum).toEqual([
        'ready', 'not_ready', 'expired', 'unknown', 'timeout', 'not_checked',
      ]);
    });
  });

  it('reports bounded sanitized CLI, feature, authentication, and bridge health', async () => {
    const privateValues = [
      'person@example.test',
      '/Users/private-person',
      ['sk', 'ant', 'api03', 'private-secret'].join('-'),
      'Bearer private.token.value',
      'BASIC dXNlcjpwYXNz',
    ];
    await withProtocolClient(async (client) => {
      const result = await client.callTool({ name: 'claude_health', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: 'ready',
        minimum_cli_version: '2.1.0',
        cli: { found: true, path: `~/${fakeClaude.slice((process.env.HOME ?? '').length + 1)}`, resolution: 'override', version: '2.1.0', version_status: 'supported' },
        authentication: { status: 'ready', ready: true },
        bridge: { running_jobs: 0, queued_jobs: 0, concurrency_limit: 2 },
        issues: [],
      });
      expect((result.structuredContent as { features: unknown }).features).toEqual({
        print: true, stream_json: true, verbose: true, max_turns: true, no_chrome: true,
        inspect_tools: true, plan_permission: true, model: true, effort: true, explicit_resume: true,
        cloud_sessions: true, mcp_config: true, strict_mcp_config: true, disable_nested_mcp: true,
      });
      expect(JSON.parse(((result.content as Array<{ text: string }>)[0]).text)).toEqual(result.structuredContent);
      const serialized = JSON.stringify(result);
      for (const value of privateValues) expect(serialized).not.toContain(value);
    }, {
      CODEX_CLAUDE_MCP_CLAUDE_PATH: fakeClaude,
      FAKE_AUTH_OUTPUT: `${privateValues.join('\n')}\n`,
    });
  });

  it('uses a bounded parser-only fallback when the built CLI help omits max-turns', async () => {
    await withProtocolClient(async (client) => {
      const result = await client.callTool({ name: 'claude_health', arguments: {} });
      expect(result.structuredContent).toMatchObject({
        status: 'ready', features: { max_turns: true }, issues: [],
      });
      expect(JSON.stringify(result)).not.toContain('private parser diagnostic');
    }, {
      CODEX_CLAUDE_MCP_CLAUDE_PATH: fakeClaude,
      FAKE_CLAUDE_HELP: helpWithoutMaxTurns,
      FAKE_MAX_TURNS_PROBE_SCENARIO: 'recognized-prompt-argument',
      FAKE_MAX_TURNS_PROBE_OUTPUT: 'private parser diagnostic',
    });
  });

  it.each([
    ['too old', { FAKE_CLAUDE_VERSION: '2.0.99 (Claude Code)' }, 'degraded', 'too_old', 'version_too_old'],
    ['malformed', { FAKE_CLAUDE_VERSION: 'Claude version private@example.test' }, 'degraded', 'malformed', 'version_malformed'],
    ['missing feature', { FAKE_CLAUDE_HELP: '--print --input-format stream-json' }, 'degraded', 'supported', 'required_feature_missing'],
    ['not ready', { FAKE_AUTH_SCENARIO: 'not_ready', FAKE_AUTH_OUTPUT: 'not logged in person@example.test' }, 'degraded', 'supported', 'authentication_not_ready'],
    ['expired', { FAKE_AUTH_SCENARIO: 'expired', FAKE_AUTH_OUTPUT: 'session expired; log in again person@example.test' }, 'degraded', 'supported', 'authentication_expired'],
    ['unknown auth', { FAKE_AUTH_SCENARIO: 'unknown', FAKE_AUTH_OUTPUT: 'profile person@example.test' }, 'degraded', 'supported', 'authentication_unknown'],
  ] as const)('normalizes %s health without returning raw diagnostics', async (_name, scenario, status, versionStatus, issue) => {
    await withProtocolClient(async (client) => {
      const result = await client.callTool({ name: 'claude_health', arguments: {} });
      expect(result.structuredContent).toMatchObject({ status, cli: { version_status: versionStatus } });
      expect((result.structuredContent as { issues: string[] }).issues).toContain(issue);
      expect(JSON.stringify(result)).not.toContain('person@example.test');
    }, { CODEX_CLAUDE_MCP_CLAUDE_PATH: fakeClaude, ...scenario });
  });

  it.each([
    ['a hanging version probe', { FAKE_VERSION_SCENARIO: 'hang' }],
    ['an output-limited version probe', { FAKE_VERSION_SCENARIO: 'flood' }],
  ] as const)('bounds built-bundle health for %s', async (_name, scenario) => {
    const started = Date.now();
    await withProtocolClient(async (client) => {
      const result = await client.callTool({ name: 'claude_health', arguments: {} });
      expect(result.structuredContent).toMatchObject({ status: 'degraded', cli: { version_status: 'timeout' } });
      expect((result.structuredContent as { issues: string[] }).issues).toContain('probe_timeout');
    }, { CODEX_CLAUDE_MCP_CLAUDE_PATH: fakeClaude, ...scenario });
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it.each([
    ['version', { FAKE_VERSION_EXIT: '7' }, 'malformed', 'version_malformed'],
    ['help', { FAKE_HELP_EXIT: '7' }, 'supported', 'required_feature_missing'],
  ] as const)('requires exit zero from built %s probe', async (_name, scenario, versionStatus, issue) => {
    await withProtocolClient(async (client) => {
      const result = await client.callTool({ name: 'claude_health', arguments: {} });
      expect(result.structuredContent).toMatchObject({ status: 'degraded', cli: { version_status: versionStatus } });
      expect((result.structuredContent as { issues: string[] }).issues).toContain(issue);
    }, { CODEX_CLAUDE_MCP_CLAUDE_PATH: fakeClaude, ...scenario });
  });

  it.each([
    [{ mode: 'resume', session_id: 'sess_explicit' }, ['--resume', 'sess_explicit']],
    [{ mode: 'cloud_create', description: 'Cloud description' }, ['--cloud', '--name', 'Cloud description']],
    [{ mode: 'cloud_attach', target: 'cloud_target' }, ['--cloud', 'cloud_target']],
  ] as const)('runs built session form %o with exact arguments', async (session, expectedArguments) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-claude-protocol-session-')));
    const workspace = join(root, 'workspace');
    const control = join(root, 'control');
    await Promise.all([mkdir(workspace), mkdir(control)]);
    await withProtocolClient(async (client) => {
      const result = await client.callTool({
        name: 'claude_task',
        arguments: {
          workspace, prompt: 'session form secret', session, model: 'claude-full-model-id', effort: 'max',
          execution: { mode: 'sync', timeout_seconds: 30 },
        },
      });
      expect(result.isError).not.toBe(true);
      const args = JSON.parse(await readFile(join(control, 'argv.json'), 'utf8')) as string[];
      expect(args).toEqual(expect.arrayContaining([...expectedArguments, '--model', 'claude-full-model-id', '--effort', 'max']));
      expect(args).not.toContain('session form secret');
    }, {
      CODEX_CLAUDE_MCP_CLAUDE_PATH: fakeClaude,
      FAKE_CLAUDE_CONTROL_DIR: control,
      FAKE_CLAUDE_SCENARIO: 'success',
    });
  });

  it.each([
    ['missing override', '/definitely/missing/claude', 'not_found', 'cli_not_found'],
    ['relative override', 'relative/claude', 'not_executable', 'cli_not_executable'],
    ['empty override', '', 'not_executable', 'cli_not_executable'],
  ] as const)('does not fall back from an authoritative %s', async (_name, override, versionStatus, issue) => {
    await withProtocolClient(async (client) => {
      const result = await client.callTool({ name: 'claude_health', arguments: {} });
      expect(result.structuredContent).toMatchObject({
        status: 'unavailable', cli: { found: false, version_status: versionStatus }, authentication: { status: 'not_checked' },
      });
      expect((result.structuredContent as { issues: string[] }).issues).toContain(issue);
    }, { CODEX_CLAUDE_MCP_CLAUDE_PATH: override, PATH: `${join(repositoryRoot, 'test/fixtures')}:${process.env.PATH ?? ''}` });
  });

  it('returns ordinary safe error results for invalid and unknown calls without echoing supplied secrets', async () => {
    const secretPrompt = 'prompt-secret-SHOULD-NOT-ECHO';
    const secretRootKey = 'sk_ant_secret_root_key';
    const secretNestedKey = 'bearer_secret_nested_key';
    const secretToolName = `unknown_${'private_secret_'.repeat(8)}`;
    await withProtocolClient(async (client) => {
      const results = [
        await client.callTool({
          name: 'claude_task',
          arguments: { workspace: '/tmp', prompt: secretPrompt, [secretRootKey]: true },
        }),
        await client.callTool({
          name: 'claude_task',
          arguments: { workspace: '/tmp', prompt: secretPrompt, execution: { mode: 'async', [secretNestedKey]: true } },
        }),
        await client.callTool({
          name: 'claude_job_continue',
          arguments: { job_id: 'job_missing', prompt: secretPrompt, access: 'write' },
        }),
        await client.callTool({ name: secretToolName, arguments: {} }),
        await client.callTool({ name: 'claude_job_status', arguments: { job_id: '-private-job-id' } }),
        await client.callTool({ name: 'claude_job_result', arguments: { job_id: 'job_missing', cursor: '-private-cursor' } }),
        await client.callTool({
          name: 'claude_task',
          arguments: { workspace: 'relative-private-workspace', prompt: secretPrompt, effort: 'private-effort' },
        }),
        await client.callTool({
          name: 'claude_task',
          arguments: { workspace: '/tmp', prompt: secretPrompt, access: 'private-access' },
        }),
        await client.callTool({
          name: 'claude_task',
          arguments: { workspace: '/tmp', prompt: secretPrompt, execution: { mode: 'private-mode' } },
        }),
        await client.callTool({
          name: 'claude_task',
          arguments: { workspace: '/tmp', prompt: secretPrompt, session: { mode: 'private-session' } },
        }),
      ];
      for (const result of results) {
        expect(result.isError).toBe(true);
        expect(result).not.toHaveProperty('structuredContent');
        const serialized = JSON.stringify(result);
        for (const secret of [
          secretPrompt, secretRootKey, secretNestedKey, secretToolName, '-private-job-id', '-private-cursor',
          'relative-private-workspace', 'private-effort', 'private-access', 'private-mode', 'private-session',
        ]) {
          expect(serialized).not.toContain(secret);
        }
      }
    });
  });

  it('runs inspect work through the built detached runner, paginates exact output, and continues only the captured session', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-claude-protocol-task-')));
    const workspace = join(root, 'workspace');
    const control = join(root, 'control');
    const stateRoot = join(root, 'state');
    await Promise.all([mkdir(workspace), mkdir(control), mkdir(stateRoot)]);
    const expected = `${'a'.repeat(65_535)}🌍tail`;
    const environment = {
      CODEX_CLAUDE_MCP_CLAUDE_PATH: fakeClaude,
      FAKE_CLAUDE_CONTROL_DIR: control,
      FAKE_CLAUDE_RESULT: expected,
      FAKE_CLAUDE_SCENARIO: 'success',
    };
    await withProtocolClient(async (client) => {
      const submitted = await client.callTool({
        name: 'claude_task',
        arguments: {
          workspace, prompt: 'private original prompt', access: 'inspect', model: 'sonnet', effort: 'high',
          max_turns: 7, execution: { mode: 'sync', timeout_seconds: 30 },
        },
      });
      if (submitted.isError) throw new Error(JSON.stringify(submitted));
      const firstJob = structured<{ job: { id: string; state: string; claude_session_id?: string } }>(submitted).job;
      expect(firstJob).toMatchObject({ state: 'succeeded', claude_session_id: 'sess_fake' });
      expect(JSON.parse(((submitted.content as Array<{ text: string }>)[0]).text)).toEqual(submitted.structuredContent);

      const firstPageResult = await client.callTool({ name: 'claude_job_result', arguments: { job_id: firstJob.id } });
      const firstPage = structured<{ result: string; next_cursor?: string }>(firstPageResult);
      expect(Buffer.byteLength(firstPage.result)).toBeLessThanOrEqual(65_536);
      expect(firstPage.next_cursor).toBeTruthy();
      const secondPage = structured<{ result: string }>(await client.callTool({
        name: 'claude_job_result', arguments: { job_id: firstJob.id, cursor: firstPage.next_cursor },
      }));
      expect(firstPage.result + secondPage.result).toBe(expected);

      const alteredCursor = await client.callTool({
        name: 'claude_job_result', arguments: { job_id: firstJob.id, cursor: `${firstPage.next_cursor}altered` },
      });
      expect(alteredCursor.isError).toBe(true);
      expect(JSON.stringify(alteredCursor)).not.toContain(`${firstPage.next_cursor}altered`);

      const automatic = await client.callTool({
        name: 'claude_task',
        arguments: { workspace, prompt: 'automatic private prompt', execution: { mode: 'auto', wait_seconds: 2 } },
      });
      const automaticJob = structured<{ job: { id: string; state: string } }>(automatic).job;
      expect(automaticJob.state).toBe('succeeded');
      const crossJob = await client.callTool({
        name: 'claude_job_result', arguments: { job_id: automaticJob.id, cursor: firstPage.next_cursor },
      });
      expect(crossJob.isError).toBe(true);
      await writeFile(join(stateRoot, 'jobs', firstJob.id, 'result.bin'), Buffer.from(expected.replace(/^a/, 'b')));
      const stale = await client.callTool({
        name: 'claude_job_result', arguments: { job_id: firstJob.id, cursor: firstPage.next_cursor },
      });
      expect(stale.isError).toBe(true);

      const continued = await client.callTool({
        name: 'claude_job_continue',
        arguments: { job_id: firstJob.id, prompt: 'private continuation prompt', execution: { mode: 'async' } },
      });
      const continuedJob = structured<{ job: { id: string; state: string } }>(continued).job;
      expect(['queued', 'running', 'succeeded']).toContain(continuedJob.state);
      await waitForTerminal(client, continuedJob.id);
      const argv = JSON.parse(await readFile(join(control, 'argv.json'), 'utf8')) as string[];
      expect(argv).toEqual(expect.arrayContaining([
        '--resume', 'sess_fake', '--tools', 'Read,Glob,Grep', '--permission-mode', 'plan',
        '--model', 'sonnet', '--effort', 'high', '--max-turns', '7', '--no-chrome',
        '--strict-mcp-config', '--disallowedTools', 'mcp__*',
      ]));
      expect(argv).not.toContain('private continuation prompt');
      expect(await readFile(join(control, 'stdin.txt'), 'utf8')).toContain('private continuation prompt');

      const rejectedEscalation = await client.callTool({
        name: 'claude_job_continue',
        arguments: { job_id: firstJob.id, prompt: 'do not echo this secret', access: 'write', model: 'opus' },
      });
      expect(rejectedEscalation.isError).toBe(true);
      expect(JSON.stringify(rejectedEscalation)).not.toContain('do not echo this secret');
    }, environment, stateRoot);
  });

  it('runs and continues write work with exactly acceptEdits and no bypass-style permission', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-claude-protocol-write-')));
    const workspace = join(root, 'workspace');
    const control = join(root, 'control');
    const stateRoot = join(root, 'state');
    await Promise.all([mkdir(workspace), mkdir(control), mkdir(stateRoot)]);
    await runFile('git', ['init', '--quiet', workspace]);
    const environment = {
      CODEX_CLAUDE_MCP_CLAUDE_PATH: fakeClaude,
      FAKE_CLAUDE_CONTROL_DIR: control,
      FAKE_CLAUDE_SCENARIO: 'controlled-write',
    };
    const baseWriteArgs = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--max-turns', '20', '--no-chrome', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--disallowedTools', 'mcp__*', '--permission-mode', 'acceptEdits',
    ];
    await withProtocolClient(async (client) => {
      const submitted = await client.callTool({
        name: 'claude_task',
        arguments: { workspace, prompt: 'authorized local edit', access: 'write', execution: { mode: 'sync' } },
      });
      const firstJob = structured<{ job: { id: string; state: string; claude_session_id?: string } }>(submitted).job;
      expect(firstJob).toMatchObject({ state: 'succeeded', claude_session_id: 'sess_fake' });
      expect(JSON.parse(await readFile(join(control, 'argv.json'), 'utf8'))).toEqual(baseWriteArgs);
      expect(await readFile(join(workspace, 'claude-controlled-write.txt'), 'utf8')).toBe('controlled write\n');
      await expect(access(join(root, 'claude-controlled-write.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

      const continued = await client.callTool({
        name: 'claude_job_continue',
        arguments: { job_id: firstJob.id, prompt: 'continue authorized local edit', execution: { mode: 'sync' } },
      });
      expect(structured<{ job: { state: string } }>(continued).job.state).toBe('succeeded');
      const continuedArgs = JSON.parse(await readFile(join(control, 'argv.json'), 'utf8')) as string[];
      expect(continuedArgs).toEqual([...baseWriteArgs, '--resume', 'sess_fake']);
      expect(continuedArgs.filter((argument) => argument === '--permission-mode')).toHaveLength(1);
      for (const forbidden of [
        '--tools', '--dangerously-skip-permissions', 'bypassPermissions', 'auto', 'dontAsk', '--accept-edits',
        '--add-dir', '--chrome',
      ]) {
        expect(continuedArgs).not.toContain(forbidden);
      }
    }, environment, stateRoot);
  });

  it('supports async status, idempotent queued/running cancellation, and terminal-only forgetting', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-claude-protocol-cancel-')));
    const workspace = join(root, 'workspace');
    const control = join(root, 'control');
    await Promise.all([mkdir(workspace), mkdir(control)]);
    const environment = {
      CODEX_CLAUDE_MCP_CLAUDE_PATH: fakeClaude,
      FAKE_CLAUDE_CONTROL_DIR: control,
      FAKE_CLAUDE_SCENARIO: 'hang',
    };
    await withProtocolClient(async (client) => {
      const ids: string[] = [];
      for (const prompt of ['first private', 'second private', 'queued private']) {
        const result = await client.callTool({
          name: 'claude_task', arguments: { workspace, prompt, execution: { mode: 'async' } },
        });
        ids.push(structured<{ job: { id: string } }>(result).job.id);
      }
      const queuedStatus = structured<{ job: { state: string } }>(await client.callTool({
        name: 'claude_job_status', arguments: { job_id: ids[2] },
      }));
      expect(queuedStatus.job.state).toBe('queued');
      expect(structured<{ bridge: unknown }>(await client.callTool({
        name: 'claude_health', arguments: {},
      })).bridge).toEqual({ running_jobs: 2, queued_jobs: 1, concurrency_limit: 2 });

      const activeForget = await client.callTool({ name: 'claude_job_forget', arguments: { job_id: ids[0] } });
      expect(activeForget.isError).toBe(true);
      expect(JSON.parse(((activeForget.content as Array<{ text: string }>)[0]).text)).toEqual({
        error: { code: 'job-not-terminal', message: 'Claude job is not terminal.' },
      });

      const cancelledQueued = structured<{ job: { state: string } }>(await client.callTool({
        name: 'claude_job_cancel', arguments: { job_id: ids[2] },
      }));
      expect(cancelledQueued.job.state).toBe('cancelled');
      const cancelledRunning = await client.callTool({ name: 'claude_job_cancel', arguments: { job_id: ids[0] } });
      expect(['running', 'cancelled']).toContain(structured<{ job: { state: string } }>(cancelledRunning).job.state);
      expect(await waitForTerminal(client, ids[0])).toMatchObject({ state: 'cancelled' });
      expect(structured<{ job: { state: string } }>(await client.callTool({
        name: 'claude_job_cancel', arguments: { job_id: ids[0] },
      })).job.state).toBe('cancelled');

      const forgotten = await client.callTool({ name: 'claude_job_forget', arguments: { job_id: ids[2] } });
      expect(forgotten.structuredContent).toEqual({
        job_id: ids[2], forgotten: true, claude_transcript_retained: true,
        message: "Bridge job metadata and output were removed; Claude Code's own transcript remains.",
      });
      const missing = await client.callTool({ name: 'claude_job_status', arguments: { job_id: ids[2] } });
      expect(missing.isError).toBe(true);

      await client.callTool({ name: 'claude_job_cancel', arguments: { job_id: ids[1] } });
      await waitForTerminal(client, ids[1]);
    }, environment);
  });

  it('closes the server without deleting a detached job and can recover it from durable state', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-claude-protocol-close-')));
    const workspace = join(root, 'workspace');
    const control = join(root, 'control');
    const stateRoot = join(root, 'state');
    await Promise.all([mkdir(workspace), mkdir(control), mkdir(stateRoot)]);
    const environment = {
      CODEX_CLAUDE_MCP_CLAUDE_PATH: fakeClaude,
      FAKE_CLAUDE_CONTROL_DIR: control,
      FAKE_CLAUDE_SCENARIO: 'hang',
    };
    let jobId = '';
    await withProtocolClient(async (client) => {
      const result = await client.callTool({
        name: 'claude_task', arguments: { workspace, prompt: 'survive transport close', execution: { mode: 'async' } },
      });
      jobId = structured<{ job: { id: string } }>(result).job.id;
    }, environment, stateRoot);
    expect((await stat(join(stateRoot, 'jobs', jobId, 'state.json'))).isFile()).toBe(true);
    const rawExit = await runServerUntilStdioEof(stateRoot, environment);
    expect(rawExit).toMatchObject({ code: 0, signal: null, stderr: '' });
    expect(() => process.kill(rawExit.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect((await stat(join(stateRoot, 'jobs', jobId, 'state.json'))).isFile()).toBe(true);
    await withProtocolClient(async (client) => {
      const status = await client.callTool({ name: 'claude_job_status', arguments: { job_id: jobId } });
      expect(['running', 'cancelled']).toContain(structured<{ job: { state: string } }>(status).job.state);
      await client.callTool({ name: 'claude_job_cancel', arguments: { job_id: jobId } });
      await waitForTerminal(client, jobId);
    }, environment, stateRoot);
  });
});
