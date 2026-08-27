import { isAbsolute } from 'node:path';
import { z } from 'zod';

const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const hasNoControlCharacters = (value: string): boolean => [...value].every((character) => {
  const code = character.codePointAt(0) ?? 0;
  return code > 31 && code !== 127;
});
const explicitIdentifier = z.string().min(1).max(512).refine(hasNoControlCharacters).refine((value) => !value.startsWith('-'));

export const AccessSchema = z.enum(['inspect', 'write']);
export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export const ExecutionSchema = z.object({
  mode: z.enum(['auto', 'sync', 'async']).default('auto'),
  wait_seconds: z.number().int().min(0).max(45).default(45),
  timeout_seconds: z.number().int().min(30).max(7200).default(1800),
});
export const SessionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('new') }),
  z.object({ mode: z.literal('resume'), session_id: explicitIdentifier }),
  z.object({ mode: z.literal('cloud_create'), description: z.string().min(1).max(256).refine(hasNoControlCharacters).optional() }),
  z.object({ mode: z.literal('cloud_attach'), target: explicitIdentifier }),
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
}).strict();

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
export const ClaudeErrorSchema = z.object({
  code: ClaudeErrorCodeSchema,
  message: z.string().min(1).max(1024),
  retryable: z.boolean().optional(),
}).strict();
export type ClaudeError = z.infer<typeof ClaudeErrorSchema>;

const UsageSchema = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));
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
  usage: UsageSchema.optional(),
  total_cost_usd: z.number().finite().nonnegative().optional(),
  result_preview: z.string().max(4096).optional(),
  error: ClaudeErrorSchema.optional(),
}).strict();
export type ClaudeJob = z.infer<typeof ClaudeJobSchema>;

export class ClaudeContractError extends Error {
  readonly code: ClaudeErrorCode;

  constructor(code: ClaudeErrorCode, message: string) {
    super(message);
    this.name = 'ClaudeContractError';
    this.code = code;
  }
}
