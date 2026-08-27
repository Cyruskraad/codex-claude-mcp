import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { JobResultPage, JobStatusView } from '../src/job-service.js';
import type { ClaudeHealth } from '../src/protocol.js';
import { runClaudeMcpStdio } from '../src/server.js';

const health: ClaudeHealth = {
  status: 'unavailable', checked_at: '2026-08-27T12:00:00.000Z', minimum_cli_version: '2.1.0',
  cli: { found: false, version_status: 'not_found' },
  features: {
    print: false, stream_json: false, verbose: false, max_turns: false, no_chrome: false,
    inspect_tools: false, plan_permission: false, model: false, effort: false, explicit_resume: false,
    cloud_sessions: false, mcp_config: false, strict_mcp_config: false, disable_nested_mcp: false,
  },
  authentication: { status: 'not_checked', ready: false }, model_aliases: ['sonnet', 'opus', 'haiku', 'fable'],
  supported_effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  bridge: { running_jobs: 0, queued_jobs: 0, concurrency_limit: 2 }, issues: ['cli_not_found'],
};

class RuntimeJobs {
  starts = 0;
  stops = 0;
  readonly store: { list: () => Promise<Array<{ job: { state: string } }>> };
  constructor(states: string[] = []) {
    this.store = { list: async () => states.map((state) => ({ job: { state } })) };
  }
  async startup(): Promise<void> { this.starts += 1; }
  async shutdown(): Promise<void> { this.stops += 1; }
  async submitTask(): Promise<JobStatusView> { throw new Error('unused'); }
  async getJobStatus(): Promise<JobStatusView> { throw new Error('unused'); }
  async getJobResult(): Promise<JobResultPage> { throw new Error('unused'); }
  async continueJob(): Promise<JobStatusView> { throw new Error('unused'); }
  async cancelJob(): Promise<JobStatusView> { throw new Error('unused'); }
  async forgetJob(): Promise<void> { throw new Error('unused'); }
}

describe('stdio runtime', () => {
  it('starts injected jobs, sanitizes unknown tool names, and shuts supervision down on transport close', async () => {
    const jobs = new RuntimeJobs();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await runClaudeMcpStdio({
      jobs,
      health: async () => health,
      transport: serverTransport,
      installSignalHandlers: false,
    });
    const client = new Client({ name: 'runtime-test', version: '0.1.0' });
    await client.connect(clientTransport);
    expect(jobs.starts).toBe(1);
    const secretName = `unknown_${'private-secret-'.repeat(10)}`;
    const unknown = await client.callTool({ name: secretName, arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown)).not.toContain(secretName);
    await expect(client.callTool({ name: 42 as unknown as string, arguments: {} }))
      .rejects.toMatchObject({ code: -32603 });
    await client.close();
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
    expect(jobs.stops).toBe(1);
    await server.close().catch(() => undefined);
  });

  it('installs and removes process-close handlers around a connected runtime', async () => {
    const jobs = new RuntimeJobs();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const server = await runClaudeMcpStdio({ jobs, health: async () => health, transport: serverTransport });
    const client = new Client({ name: 'runtime-signals-test', version: '0.1.0' });
    await client.connect(clientTransport);
    expect(process.listenerCount('SIGINT')).toBe(beforeInt + 1);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm + 1);
    await client.close();
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
    expect(jobs.stops).toBe(1);
    await server.close().catch(() => undefined);
  });

  it('shuts the supervisor down when transport startup fails', async () => {
    const jobs = new RuntimeJobs();
    await expect(runClaudeMcpStdio({
      jobs,
      health: async () => health,
      installSignalHandlers: false,
      transport: {
        start: async () => { throw new Error('private transport failure'); },
        send: async () => undefined,
        close: async () => undefined,
      },
    })).rejects.toThrow('private transport failure');
    expect(jobs.starts).toBe(1);
    expect(jobs.stops).toBe(1);
  });

  it('derives bridge capacity from injected durable records when using the default health provider', async () => {
    const jobs = new RuntimeJobs(['running', 'queued', 'succeeded']);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const previous = process.env.CODEX_CLAUDE_MCP_CLAUDE_PATH;
    process.env.CODEX_CLAUDE_MCP_CLAUDE_PATH = '/definitely/missing/claude';
    const server = await runClaudeMcpStdio({ jobs, transport: serverTransport, installSignalHandlers: false });
    const client = new Client({ name: 'runtime-default-health-test', version: '0.1.0' });
    try {
      await client.connect(clientTransport);
      const result = await client.callTool({ name: 'claude_health', arguments: {} });
      expect(result.structuredContent).toMatchObject({
        status: 'unavailable', bridge: { running_jobs: 1, queued_jobs: 1, concurrency_limit: 2 },
      });
    } finally {
      if (previous === undefined) delete process.env.CODEX_CLAUDE_MCP_CLAUDE_PATH;
      else process.env.CODEX_CLAUDE_MCP_CLAUDE_PATH = previous;
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});
