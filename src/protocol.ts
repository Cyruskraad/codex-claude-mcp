import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ClaudeErrorSchema,
  ClaudeJobSchema,
  ClaudeTaskInputSchema,
  ExecutionSchema,
  type ClaudeError,
  type ClaudeTaskInput,
} from './contracts.js';
import { safeErrorSummary } from './diagnostics.js';
import type { JobResultPage, JobStatusView } from './job-service.js';

const STRICT_MESSAGE = 'Unexpected input property.';

const hasNoControlCharacters = (value: string): boolean => [...value].every((character) => {
  const code = character.codePointAt(0) ?? 0;
  return code > 31 && code !== 127;
});

export const PublicIdentifierSchema = z.string().min(1).max(512)
  .refine(hasNoControlCharacters, 'Identifier may not contain control characters.')
  .refine((value) => !value.startsWith('-'), 'Identifier may not begin with a dash.');
export const CursorSchema = z.string().min(1).max(4096)
  .refine(hasNoControlCharacters, 'Cursor may not contain control characters.')
  .refine((value) => !value.startsWith('-'), 'Cursor may not begin with a dash.');

export const JobStatusViewSchema = z.object({
  job: ClaudeJobSchema,
  progress_tail: z.array(z.string().max(1024)).max(20),
}).strict(STRICT_MESSAGE);
export const JobResultPageSchema = JobStatusViewSchema.extend({
  result: z.string(),
  next_cursor: CursorSchema.optional(),
}).strict(STRICT_MESSAGE);
export const ForgetResultSchema = z.object({
  job_id: PublicIdentifierSchema,
  forgotten: z.literal(true),
  claude_transcript_retained: z.literal(true),
  message: z.string().min(1).max(512),
}).strict(STRICT_MESSAGE);

const HealthIssueSchema = z.enum([
  'cli_not_found', 'cli_not_executable', 'version_too_old', 'version_malformed', 'probe_timeout',
  'required_feature_missing', 'authentication_not_ready', 'authentication_expired', 'authentication_unknown',
]);
export const ClaudeHealthSchema = z.object({
  status: z.enum(['ready', 'degraded', 'unavailable']),
  checked_at: z.string().datetime(),
  minimum_cli_version: z.literal('2.1.0'),
  cli: z.object({
    found: z.boolean(),
    path: z.string().min(1).optional(),
    resolution: z.enum(['override', 'path']).optional(),
    version: z.string().min(1).optional(),
    version_status: z.enum(['supported', 'too_old', 'malformed', 'timeout', 'not_found', 'not_executable']),
  }).strict(STRICT_MESSAGE),
  features: z.object({
    print: z.boolean(), stream_json: z.boolean(), verbose: z.boolean(), max_turns: z.boolean(),
    no_chrome: z.boolean(), inspect_tools: z.boolean(), plan_permission: z.boolean(), model: z.boolean(),
    effort: z.boolean(), explicit_resume: z.boolean(), cloud_sessions: z.boolean(), mcp_config: z.boolean(),
    strict_mcp_config: z.boolean(), disable_nested_mcp: z.boolean(),
  }).strict(STRICT_MESSAGE),
  session_modes: z.object({
    new: z.literal(true), resume: z.literal(true), cloud_attach: z.boolean(), cloud_create: z.literal(false),
  }).strict(STRICT_MESSAGE),
  authentication: z.object({
    status: z.enum(['ready', 'not_ready', 'expired', 'unknown', 'timeout', 'not_checked']),
    ready: z.boolean(),
  }).strict(STRICT_MESSAGE),
  model_aliases: z.tuple([z.literal('sonnet'), z.literal('opus'), z.literal('haiku'), z.literal('fable')]),
  supported_effort_levels: z.tuple([
    z.literal('low'), z.literal('medium'), z.literal('high'), z.literal('xhigh'), z.literal('max'),
  ]),
  bridge: z.object({
    running_jobs: z.number().int().nonnegative(),
    queued_jobs: z.number().int().nonnegative(),
    concurrency_limit: z.literal(2),
  }).strict(STRICT_MESSAGE),
  issues: z.array(HealthIssueSchema),
}).strict(STRICT_MESSAGE);
export type ClaudeHealth = z.infer<typeof ClaudeHealthSchema>;

export interface ProtocolJobService {
  submitTask(input: ClaudeTaskInput): Promise<JobStatusView>;
  getJobStatus(jobId: string): Promise<JobStatusView>;
  getJobResult(jobId: string, cursor?: string): Promise<JobResultPage>;
  continueJob(jobId: string, prompt: string, execution?: ClaudeTaskInput['execution']): Promise<JobStatusView>;
  cancelJob(jobId: string): Promise<JobStatusView>;
  forgetJob(jobId: string): Promise<void>;
}

export interface ClaudeMcpServerDependencies {
  jobs: ProtocolJobService;
  health: () => Promise<ClaudeHealth>;
}

const readOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true,
};
const taskAnnotations: ToolAnnotations = {
  readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false,
};
const localMutationAnnotations: ToolAnnotations = {
  readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true,
};

function success(value: Record<string, unknown>): CallToolResult {
  return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
}

const stableMessages: Record<ClaudeError['code'], string> = {
  'invalid-input': 'Invalid Claude bridge input.', 'invalid-workspace': 'Workspace is invalid.',
  'forbidden-workspace': 'Workspace is not allowed.', 'write-requires-git': 'Write access requires a Git worktree.',
  'unsupported-session-mode': 'Cloud session creation is unavailable through this noninteractive bridge; create it in Claude Code and use cloud_attach.',
  'claude-not-found': 'Claude Code executable was not found.', 'claude-unsupported': 'Claude Code version is unsupported.',
  'auth-required': 'Claude Code authentication is required.', 'concurrency-limit': 'Claude job capacity is unavailable.',
  'job-not-found': 'Claude job was not found.', 'job-not-terminal': 'Claude job is not terminal.',
  'malformed-stream': 'Claude returned malformed stream output.', 'claude-failed': 'Claude execution failed.',
  cancelled: 'Claude job was cancelled.', 'timed-out': 'Claude job timed out.',
  'output-limited': 'Claude output exceeded the byte limit.', orphaned: 'Claude runner ownership could not be verified.',
  'internal-error': 'An internal error occurred.',
};

function failure(error: unknown): CallToolResult {
  const summarized = safeErrorSummary(error);
  const safe: ClaudeError = { code: summarized.code, message: stableMessages[summarized.code] };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: ClaudeErrorSchema.parse(safe) }) }] };
}

function guarded<TArgs, TResult extends Record<string, unknown>>(
  handler: (args: TArgs) => Promise<TResult>,
): (args: TArgs) => Promise<CallToolResult> {
  return async (args) => {
    try { return success(await handler(args)); }
    catch (error) { return failure(error); }
  };
}

export const SERVER_INSTRUCTIONS = [
  'Call claude_health first to verify the local Claude Code CLI and authentication.',
  'claude_task starts durable local work and defaults to inspect access.',
  'Write access requires explicit authorization and an absolute real Git workspace.',
  'Use claude_job_status and claude_job_result for asynchronous jobs.',
  'Continue only the recorded explicit session; continuation cannot increase privileges.',
  'Cancel stops queued or running bridge work.',
  'Forget permanently removes only bridge metadata and output; the Claude transcript remains.',
  'Errors exclude prompts, environments, credentials, raw CLI diagnostics, and full tool events.',
  'This bridge does not provide access to Claude.ai chat conversations.',
].join(' ');

export function createClaudeMcpServer(dependencies: ClaudeMcpServerDependencies): McpServer {
  const server = new McpServer(
    { name: 'codex-claude-mcp', version: '0.1.1' },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {} } },
  );

  server.registerTool('claude_health', {
    title: 'Check Claude Code Bridge Health',
    description: 'Check the local Claude Code CLI, required features, authentication readiness, and bridge capacity without running a model task.',
    inputSchema: z.object({}).strict(STRICT_MESSAGE), outputSchema: ClaudeHealthSchema, annotations: readOnlyAnnotations,
  }, guarded(async () => dependencies.health() as unknown as Record<string, unknown>));

  server.registerTool('claude_task', {
    title: 'Start Claude Code Task',
    description: 'Start new local, explicitly resumed, or cloud-attached Claude Code work in a validated local workspace.',
    inputSchema: ClaudeTaskInputSchema, outputSchema: JobStatusViewSchema, annotations: taskAnnotations,
  }, guarded(async (input) => dependencies.jobs.submitTask(input) as unknown as Record<string, unknown>));

  const jobIdInput = z.object({ job_id: PublicIdentifierSchema }).strict(STRICT_MESSAGE);
  server.registerTool('claude_job_status', {
    title: 'Get Claude Job Status',
    description: 'Return normalized state and a small progress tail for a durable Claude Code job.',
    inputSchema: jobIdInput, outputSchema: JobStatusViewSchema, annotations: readOnlyAnnotations,
  }, guarded(async ({ job_id }) => dependencies.jobs.getJobStatus(job_id) as unknown as Record<string, unknown>));

  server.registerTool('claude_job_result', {
    title: 'Read Claude Job Result',
    description: 'Read one bounded, cursor-paginated result chunk for a terminal Claude Code job.',
    inputSchema: z.object({ job_id: PublicIdentifierSchema, cursor: CursorSchema.optional() }).strict(STRICT_MESSAGE),
    outputSchema: JobResultPageSchema, annotations: readOnlyAnnotations,
  }, guarded(async ({ job_id, cursor }) => dependencies.jobs.getJobResult(job_id, cursor) as unknown as Record<string, unknown>));

  server.registerTool('claude_job_continue', {
    title: 'Continue Claude Job Session',
    description: 'Continue the captured explicit Claude session while preserving its workspace and access ceiling.',
    inputSchema: z.object({
      job_id: PublicIdentifierSchema,
      prompt: z.string().min(1).max(100_000),
      execution: ExecutionSchema.optional(),
    }).strict(STRICT_MESSAGE),
    outputSchema: JobStatusViewSchema, annotations: taskAnnotations,
  }, guarded(async ({ job_id, prompt, execution }) => dependencies.jobs.continueJob(job_id, prompt, execution) as unknown as Record<string, unknown>));

  server.registerTool('claude_job_cancel', {
    title: 'Cancel Claude Job',
    description: 'Request cancellation of a queued or running Claude Code job.',
    inputSchema: jobIdInput, outputSchema: JobStatusViewSchema, annotations: localMutationAnnotations,
  }, guarded(async ({ job_id }) => dependencies.jobs.cancelJob(job_id) as unknown as Record<string, unknown>));

  server.registerTool('claude_job_forget', {
    title: 'Forget Claude Bridge Job',
    description: 'Permanently remove terminal bridge metadata and output while retaining Claude Code\'s own transcript.',
    inputSchema: jobIdInput, outputSchema: ForgetResultSchema, annotations: localMutationAnnotations,
  }, guarded(async ({ job_id }) => {
    await dependencies.jobs.forgetJob(job_id);
    return {
      job_id, forgotten: true, claude_transcript_retained: true,
      message: 'Bridge job metadata and output were removed; Claude Code\'s own transcript remains.',
    };
  }));

  return server;
}
