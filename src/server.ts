import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import { isCanonicalEntrypoint } from './entrypoint.js';
import { JobService } from './job-service.js';
import { probeClaudeHealth } from './health.js';
import { createClaudeMcpServer, type ClaudeHealth, type ProtocolJobService } from './protocol.js';

export const SERVER_ENTRYPOINT = 'codex-claude-mcp-server';
const TOOL_NAMES = new Set([
  'claude_health', 'claude_task', 'claude_job_status', 'claude_job_result',
  'claude_job_continue', 'claude_job_cancel', 'claude_job_forget',
]);

function sanitizedInboundMessage<T extends JSONRPCMessage>(message: T): T {
  if (!('method' in message) || message.method !== 'tools/call') return message;
  const params = 'params' in message && message.params && typeof message.params === 'object'
    ? message.params as Record<string, unknown> : undefined;
  if (!params || typeof params.name !== 'string' || TOOL_NAMES.has(params.name)) return message;
  return { ...message, params: { ...params, name: '__unknown_tool__' } } as T;
}

class SanitizingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  constructor(private readonly inner: Transport) {}
  get sessionId(): string | undefined { return this.inner.sessionId; }
  setProtocolVersion = (version: string): void => { this.inner.setProtocolVersion?.(version); };
  async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = (message, extra) => this.onmessage?.(sanitizedInboundMessage(message), extra);
    await this.inner.start();
  }
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> { return this.inner.send(message, options); }
  close(): Promise<void> { return this.inner.close(); }
}

interface RuntimeJobService extends ProtocolJobService {
  startup(): Promise<void>;
  shutdown(): Promise<void>;
  store: { list(): Promise<Array<{ job: { state: string } }>> };
}

export interface ClaudeMcpStdioOptions {
  jobs?: RuntimeJobService;
  health?: () => Promise<ClaudeHealth>;
  transport?: Transport;
  installSignalHandlers?: boolean;
}

export async function runClaudeMcpStdio(options: ClaudeMcpStdioOptions = {}): Promise<McpServer> {
  const jobs = options.jobs ?? new JobService();
  await jobs.startup();
  const server = createClaudeMcpServer({
    jobs,
    health: options.health ?? (async () => {
      const records = await jobs.store.list();
      return probeClaudeHealth({
        bridgeCounts: async () => ({
          runningJobs: records.filter((record) => record.job.state === 'running').length,
          queuedJobs: records.filter((record) => record.job.state === 'queued').length,
        }),
      });
    }),
  });
  let stopped = false;
  const closeFromSignal = () => { void server.close().catch(() => undefined); };
  const removeSignalHandlers = () => {
    process.off('SIGINT', closeFromSignal);
    process.off('SIGTERM', closeFromSignal);
  };
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    removeSignalHandlers();
    await jobs.shutdown();
  };
  server.server.onclose = () => { void stop().catch(() => undefined); };
  const transport = new SanitizingTransport(options.transport ?? new StdioServerTransport());
  try { await server.connect(transport); }
  catch (error) { await stop(); throw error; }
  if (options.installSignalHandlers ?? true) {
    process.once('SIGINT', closeFromSignal);
    process.once('SIGTERM', closeFromSignal);
  }
  return server;
}

if (isCanonicalEntrypoint(import.meta.url, process.argv[1])) {
  void runClaudeMcpStdio().catch(() => { process.exitCode = 1; });
}
