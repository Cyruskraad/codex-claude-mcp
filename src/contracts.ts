import { isAbsolute } from 'node:path';
import { z } from 'zod';

const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const hasNoControlCharacters = (value: string): boolean => [...value].every((character) => {
  const code = character.codePointAt(0) ?? 0;
  return code > 31 && code !== 127;
});
const explicitIdentifier = z.string().min(1).max(512).refine(hasNoControlCharacters).refine((value) => !value.startsWith('-'));
const STRICT_MESSAGE = 'Unexpected input property.';
const fixedEnumError: z.ZodErrorMap = () => ({ message: 'Invalid option.' });

export const AccessSchema = z.enum(['inspect', 'write'], { errorMap: fixedEnumError });
export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'], { errorMap: fixedEnumError });
export const ExecutionSchema = z.object({
  mode: z.enum(['auto', 'sync', 'async'], { errorMap: fixedEnumError }).default('auto'),
  wait_seconds: z.number().int().min(0).max(45).default(45),
  timeout_seconds: z.number().int().min(30).max(7200).default(1800),
}).strict(STRICT_MESSAGE);
export const SessionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('new') }).strict(STRICT_MESSAGE),
  z.object({ mode: z.literal('resume'), session_id: explicitIdentifier }).strict(STRICT_MESSAGE),
  z.object({ mode: z.literal('cloud_create'), description: z.string().min(1).max(256).refine(hasNoControlCharacters).optional() }).strict(STRICT_MESSAGE),
  z.object({ mode: z.literal('cloud_attach'), target: explicitIdentifier }).strict(STRICT_MESSAGE),
]);

/** Public task input, before defaults have been applied. */
export const ClaudeTaskInputSchema = z.object({
  workspace: z.string().min(1).refine(isAbsolute, 'Workspace must be an absolute path.'),
  prompt: z.string().min(1).max(100_000),
  access: AccessSchema.default('inspect'),
  model: z.string().max(128).regex(modelPattern, 'Model must be a safe Claude model identifier.').optional(),
  effort: EffortSchema.optional(),
  max_turns: z.number().int().min(1).max(100).default(20),
  session: SessionSchema.default({ mode: 'new' }),
  execution: ExecutionSchema.default({ mode: 'auto', wait_seconds: 45, timeout_seconds: 1800 }),
}).strict(STRICT_MESSAGE);

export type ClaudeTaskInput = z.input<typeof ClaudeTaskInputSchema>;
export type NormalizedClaudeTaskInput = z.output<typeof ClaudeTaskInputSchema>;

export function parseClaudeTaskInput(input: unknown): NormalizedClaudeTaskInput {
  return ClaudeTaskInputSchema.parse(input);
}

export const JobStateSchema = z.enum([
  'queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'output_limited', 'orphaned',
]);
export type JobState = z.infer<typeof JobStateSchema>;

export const ClaudeErrorCodeSchema = z.enum([
  'invalid-input', 'invalid-workspace', 'forbidden-workspace', 'write-requires-git',
  'claude-not-found', 'claude-unsupported', 'auth-required', 'concurrency-limit',
  'job-not-found', 'job-not-terminal', 'malformed-stream', 'claude-failed', 'cancelled',
  'timed-out', 'output-limited', 'orphaned', 'internal-error',
]);
export type ClaudeErrorCode = z.infer<typeof ClaudeErrorCodeSchema>;
export const ClaudeTerminalErrorSubtypeSchema = z.enum([
  'error_during_execution', 'error_max_turns', 'error_max_budget_usd',
  'error_max_structured_output_retries', 'error_invalid_request', 'error_api',
  'error_rate_limit', 'error_auth',
]);
export type ClaudeTerminalErrorSubtype = z.infer<typeof ClaudeTerminalErrorSubtypeSchema>;
export const ClaudeErrorSchema = z.object({
  code: ClaudeErrorCodeSchema,
  message: z.string().min(1).max(1024),
  retryable: z.boolean().optional(),
  subtype: ClaudeTerminalErrorSubtypeSchema.optional(),
}).strict(STRICT_MESSAGE);
export type ClaudeError = z.infer<typeof ClaudeErrorSchema>;

const UsageShape = {
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
  reasoning_tokens: z.number().int().nonnegative().optional(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
  cache_creation_5m_input_tokens: z.number().int().nonnegative().optional(),
  cache_creation_1h_input_tokens: z.number().int().nonnegative().optional(),
  is_cache_hit: z.boolean().optional(),
};
/** Only aggregate numerical/boolean usage measurements are safe to expose downstream. */
export const ClaudeUsageSchema = z.object(UsageShape).strict(STRICT_MESSAGE);
export type ClaudeUsage = z.infer<typeof ClaudeUsageSchema>;

export function sanitizeClaudeUsage(value: unknown): ClaudeUsage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const safe: Record<string, number | boolean> = {};
  for (const key of Object.keys(UsageShape) as Array<keyof typeof UsageShape>) {
    if (!(key in record)) continue;
    const parsed = UsageShape[key].safeParse(record[key]);
    if (parsed.success && parsed.data !== undefined) safe[key] = parsed.data;
  }
  return Object.keys(safe).length === 0 ? undefined : ClaudeUsageSchema.parse(safe);
}

export const ClaudeJobSchema = z.object({
  id: z.string().min(1).max(128),
  state: JobStateSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  started_at: z.string().datetime().optional(),
  finished_at: z.string().datetime().optional(),
  workspace: z.string().min(1),
  access: AccessSchema,
  model: z.string().max(128).optional(),
  effort: EffortSchema.optional(),
  max_turns: z.number().int().min(1).max(100),
  claude_session_id: z.string().min(1).max(512).optional(),
  exit_code: z.number().int().nullable().optional(),
  signal: z.string().max(64).nullable().optional(),
  usage: ClaudeUsageSchema.optional(),
  total_cost_usd: z.number().finite().nonnegative().optional(),
  result_preview: z.string().max(4096).optional(),
  error: ClaudeErrorSchema.optional(),
}).strict(STRICT_MESSAGE).superRefine((job, context) => {
  const terminal = ['succeeded', 'failed', 'cancelled', 'timed_out', 'output_limited', 'orphaned'].includes(job.state);
  if (job.state === 'running') {
    if (!job.started_at) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Running jobs require started_at.' });
    if (job.finished_at) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Running jobs forbid finished_at.' });
  }
  if (job.state === 'queued' && job.started_at) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Queued jobs forbid started_at.' });
  }
  if (terminal && !job.finished_at) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Terminal jobs require finished_at.' });
  }
  if (!terminal && job.finished_at) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Nonterminal jobs forbid finished_at.' });
  }
  if (job.state === 'succeeded' && job.error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Successful jobs forbid errors.' });
  }
  if (terminal && job.state !== 'succeeded' && !job.error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unsuccessful terminal jobs require an error.' });
  }
  if (terminal && job.state !== 'cancelled' && !job.started_at) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Terminal jobs reached from running require started_at.' });
  }
  const stableStateErrors: Partial<Record<JobState, ClaudeErrorCode>> = {
    cancelled: 'cancelled', timed_out: 'timed-out', output_limited: 'output-limited', orphaned: 'orphaned',
  };
  if (stableStateErrors[job.state] && job.error?.code !== stableStateErrors[job.state]) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Terminal state requires its stable error code.' });
  }
});
export type ClaudeJob = z.infer<typeof ClaudeJobSchema>;

export class ClaudeContractError extends Error {
  readonly code: ClaudeErrorCode;

  constructor(code: ClaudeErrorCode, message: string) {
    super(message);
    this.name = 'ClaudeContractError';
    this.code = code;
  }
}
