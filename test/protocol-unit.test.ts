import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { ClaudeJob, ClaudeTaskInput } from '../src/contracts.js';
import type { JobResultPage, JobStatusView } from '../src/job-service.js';
import {
  createClaudeMcpServer, type ClaudeHealth, type ProtocolJobService,
} from '../src/protocol.js';

const now = '2026-08-27T12:00:00.000Z';
const succeededJob = (id: string): ClaudeJob => ({
  id, state: 'succeeded', created_at: now, updated_at: now, started_at: now, finished_at: now,
  workspace: '/tmp/workspace', access: 'inspect', max_turns: 20, claude_session_id: 'sess_test', exit_code: 0,
});
const status = (id = 'job_test'): JobStatusView => ({ job: succeededJob(id), progress_tail: ['done'] });
const health: ClaudeHealth = {
  status: 'ready', checked_at: now, minimum_cli_version: '2.1.0',
  cli: { found: true, path: '/usr/local/bin/claude', resolution: 'path', version: '2.1.0', version_status: 'supported' },
  features: {
    print: true, stream_json: true, verbose: true, max_turns: true, no_chrome: true,
    inspect_tools: true, plan_permission: true, model: true, effort: true, explicit_resume: true,
    cloud_sessions: true, mcp_config: true, strict_mcp_config: true, disable_nested_mcp: true,
  },
  session_modes: { new: true, resume: true, cloud_attach: true, cloud_create: false },
  authentication: { status: 'ready', ready: true },
  model_aliases: ['sonnet', 'opus', 'haiku', 'fable'],
  supported_effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  bridge: { running_jobs: 0, queued_jobs: 0, concurrency_limit: 2 }, issues: [],
};

class RecordingJobs implements ProtocolJobService {
  submitted?: ClaudeTaskInput;
  continuation?: { jobId: string; prompt: string; execution?: ClaudeTaskInput['execution'] };
  forgotten?: string;
  async submitTask(input: ClaudeTaskInput): Promise<JobStatusView> { this.submitted = input; return status(); }
  async getJobStatus(jobId: string): Promise<JobStatusView> {
    if (jobId === 'job_error') throw { code: 'invalid-workspace', message: 'private workspace and token' };
    if (jobId === 'job_output_error') {
      return { ...status(jobId), job: { ...succeededJob(jobId), private_output_secret: true } } as JobStatusView;
    }
    return status(jobId);
  }
  async getJobResult(jobId: string): Promise<JobResultPage> { return { ...status(jobId), result: 'result page' }; }
  async continueJob(jobId: string, prompt: string, execution?: ClaudeTaskInput['execution']): Promise<JobStatusView> {
    this.continuation = { jobId, prompt, execution }; return status('job_continued');
  }
  async cancelJob(jobId: string): Promise<JobStatusView> { return status(jobId); }
  async forgetJob(jobId: string): Promise<void> { this.forgotten = jobId; }
}

async function withInMemoryClient<T>(
  jobs: RecordingJobs,
  action: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createClaudeMcpServer({ jobs, health: async () => health });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'protocol-unit-client', version: '0.1.0' });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return await action(client);
  } finally {
    await client.close();
    await server.close().catch(() => undefined);
  }
}

function expectCompatibleSuccess(result: Record<string, unknown>): void {
  expect(result.isError).not.toBe(true);
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content).toHaveLength(1);
  expect(JSON.parse(content[0].text)).toEqual(result.structuredContent);
}

describe('MCP server factory', () => {
  it('normalizes every successful handler and delegates normalized task and continuation inputs', async () => {
    const jobs = new RecordingJobs();
    await withInMemoryClient(jobs, async (client) => {
      const results = [
        await client.callTool({ name: 'claude_health', arguments: {} }),
        await client.callTool({ name: 'claude_task', arguments: { workspace: '/tmp/workspace', prompt: 'inspect' } }),
        await client.callTool({ name: 'claude_job_status', arguments: { job_id: 'job_test' } }),
        await client.callTool({ name: 'claude_job_result', arguments: { job_id: 'job_test' } }),
        await client.callTool({
          name: 'claude_job_continue',
          arguments: { job_id: 'job_test', prompt: 'continue', execution: { mode: 'async' } },
        }),
        await client.callTool({ name: 'claude_job_cancel', arguments: { job_id: 'job_test' } }),
        await client.callTool({ name: 'claude_job_forget', arguments: { job_id: 'job_test' } }),
      ];
      for (const result of results) expectCompatibleSuccess(result as Record<string, unknown>);
      expect(jobs.submitted).toMatchObject({
        workspace: '/tmp/workspace', prompt: 'inspect', access: 'inspect', max_turns: 20,
        session: { mode: 'new' }, execution: { mode: 'auto', wait_seconds: 45, timeout_seconds: 1800 },
      });
      expect(jobs.continuation).toEqual({
        jobId: 'job_test', prompt: 'continue', execution: { mode: 'async', wait_seconds: 45, timeout_seconds: 1800 },
      });
      expect(jobs.forgotten).toBe('job_test');
    });
  });

  it('maps domain failures to stable bounded JSON without structured content or raw diagnostics', async () => {
    await withInMemoryClient(new RecordingJobs(), async (client) => {
      const result = await client.callTool({ name: 'claude_job_status', arguments: { job_id: 'job_error' } });
      expect(result.isError).toBe(true);
      expect(result).not.toHaveProperty('structuredContent');
      expect(JSON.parse(((result.content as Array<{ text: string }>)[0]).text)).toEqual({
        error: { code: 'invalid-workspace', message: 'Workspace is invalid.' },
      });
      expect(JSON.stringify(result)).not.toMatch(/private workspace|token/i);
      const invalidOutput = await client.callTool({
        name: 'claude_job_status', arguments: { job_id: 'job_output_error' },
      });
      expect(invalidOutput.isError).toBe(true);
      expect(JSON.stringify(invalidOutput)).not.toContain('private_output_secret');
    });
  });
});
