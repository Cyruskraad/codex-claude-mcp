import { describe, expect, it } from 'vitest';
import {
  ClaudeTaskInputSchema,
  ClaudeJobSchema,
  ClaudeErrorCodeSchema,
  sanitizeClaudeUsage,
  JobStateSchema,
  parseClaudeTaskInput,
} from '../src/contracts.js';

describe('Claude task contracts', () => {
  it('applies all documented defaults after validation', () => {
    expect(parseClaudeTaskInput({ workspace: '/workspace', prompt: 'Inspect this.' })).toEqual({
      workspace: '/workspace',
      prompt: 'Inspect this.',
      access: 'inspect',
      max_turns: 20,
      session: { mode: 'new' },
      execution: { mode: 'auto', wait_seconds: 45, timeout_seconds: 1800 },
    });
  });

  it.each([
    [{ workspace: 'relative', prompt: 'x' }],
    [{ workspace: '', prompt: 'x' }],
    [{ workspace: '/workspace', prompt: '' }],
    [{ workspace: '/workspace', prompt: 'x'.repeat(100_001) }],
    [{ workspace: '/workspace', prompt: 'x', max_turns: 0 }],
    [{ workspace: '/workspace', prompt: 'x', max_turns: 101 }],
    [{ workspace: '/workspace', prompt: 'x', max_turns: 1.5 }],
    [{ workspace: '/workspace', prompt: 'x', execution: { wait_seconds: 46 } }],
    [{ workspace: '/workspace', prompt: 'x', execution: { wait_seconds: -1 } }],
    [{ workspace: '/workspace', prompt: 'x', execution: { wait_seconds: 0.5 } }],
    [{ workspace: '/workspace', prompt: 'x', execution: { timeout_seconds: 29 } }],
    [{ workspace: '/workspace', prompt: 'x', execution: { timeout_seconds: 7201 } }],
    [{ workspace: '/workspace', prompt: 'x', execution: { timeout_seconds: 30.5 } }],
  ])('rejects invalid required values and bounds: %o', (input) => {
    expect(() => ClaudeTaskInputSchema.parse(input)).toThrow();
  });

  it('accepts every numeric boundary and defaults omitted execution fields independently', () => {
    for (const [maxTurns, waitSeconds, timeoutSeconds] of [[1, 0, 30], [100, 45, 7200]]) {
      expect(parseClaudeTaskInput({
        workspace: '/workspace', prompt: 'x'.repeat(100_000), max_turns: maxTurns,
        execution: { wait_seconds: waitSeconds, timeout_seconds: timeoutSeconds },
      })).toMatchObject({ max_turns: maxTurns, execution: { wait_seconds: waitSeconds, timeout_seconds: timeoutSeconds } });
    }
    expect(parseClaudeTaskInput({ workspace: '/workspace', prompt: 'x', execution: { mode: 'sync' } }).execution)
      .toEqual({ mode: 'sync', wait_seconds: 45, timeout_seconds: 1800 });
  });

  it('accepts model aliases and full Claude model identifiers', () => {
    expect(parseClaudeTaskInput({ workspace: '/workspace', prompt: 'x', model: 'sonnet' }).model).toBe('sonnet');
    expect(parseClaudeTaskInput({ workspace: '/workspace', prompt: 'x', model: 'claude-sonnet-4-5-20250929' }).model)
      .toBe('claude-sonnet-4-5-20250929');
  });

  it.each(['-sonnet', 'has space', 'line\nbreak', 'path/model', 'model;whoami', 'x'.repeat(129)])(
    'rejects unsafe model values: %s',
    (model) => {
      expect(() => ClaudeTaskInputSchema.parse({ workspace: '/workspace', prompt: 'x', model })).toThrow();
    },
  );

  it('supports only explicit session modes with safe identifiers', () => {
    expect(parseClaudeTaskInput({
      workspace: '/workspace', prompt: 'x', session: { mode: 'resume', session_id: 'sess_123' },
    }).session).toEqual({ mode: 'resume', session_id: 'sess_123' });
    expect(parseClaudeTaskInput({
      workspace: '/workspace', prompt: 'x', session: { mode: 'cloud_create', description: 'Review batch' },
    }).session).toEqual({ mode: 'cloud_create', description: 'Review batch' });
    expect(parseClaudeTaskInput({
      workspace: '/workspace', prompt: 'x', session: { mode: 'cloud_attach', target: 'cloud_123' },
    }).session).toEqual({ mode: 'cloud_attach', target: 'cloud_123' });

    for (const session of [
      { mode: 'resume', session_id: '' },
      { mode: 'resume', session_id: '-implicit' },
      { mode: 'cloud_attach', target: 'target\u0000bad' },
      { mode: 'cloud_create', description: 'x'.repeat(257) },
    ]) {
      expect(() => ClaudeTaskInputSchema.parse({ workspace: '/workspace', prompt: 'x', session })).toThrow();
    }
  });

  it('rejects unsupported nested execution and session fields instead of stripping them', () => {
    expect(() => ClaudeTaskInputSchema.parse({
      workspace: '/workspace', prompt: 'x', execution: { continue: true },
    })).toThrow();
    for (const session of [
      { mode: 'new', continue: true },
      { mode: 'resume', session_id: 'sess_123', continue: true },
      { mode: 'cloud_create', description: 'Batch', continue: true },
      { mode: 'cloud_attach', target: 'cloud_123', continue: true },
    ]) {
      expect(() => ClaudeTaskInputSchema.parse({ workspace: '/workspace', prompt: 'x', session })).toThrow();
    }
  });

  it('exports all stable job states and validates a timestamped job', () => {
    expect(JobStateSchema.options).toEqual([
      'queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'output_limited', 'orphaned',
    ]);
    expect(ClaudeJobSchema.parse({
      id: 'job_1', state: 'succeeded', created_at: '2026-08-27T12:00:00.000Z',
      updated_at: '2026-08-27T12:00:01.000Z', started_at: '2026-08-27T12:00:00.000Z', finished_at: '2026-08-27T12:00:01.000Z',
      workspace: '/repo', access: 'inspect', max_turns: 20,
    })).toMatchObject({ id: 'job_1', state: 'succeeded' });
    expect(ClaudeErrorCodeSchema.options).toEqual([
      'invalid-input', 'invalid-workspace', 'forbidden-workspace', 'write-requires-git',
      'claude-not-found', 'claude-unsupported', 'auth-required', 'concurrency-limit',
      'job-not-found', 'job-not-terminal', 'malformed-stream', 'claude-failed', 'cancelled',
      'timed-out', 'output-limited', 'orphaned', 'internal-error',
    ]);
  });

  it('enforces running and terminal timestamp/error invariants', () => {
    const base = {
      id: 'job_1', created_at: '2026-08-27T12:00:00.000Z', updated_at: '2026-08-27T12:00:01.000Z',
      workspace: '/repo', access: 'inspect', max_turns: 20,
    };
    expect(() => ClaudeJobSchema.parse({ ...base, state: 'running' })).toThrow();
    expect(() => ClaudeJobSchema.parse({ ...base, state: 'running', started_at: base.created_at, finished_at: base.updated_at })).toThrow();
    expect(() => ClaudeJobSchema.parse({ ...base, state: 'succeeded' })).toThrow();
    expect(() => ClaudeJobSchema.parse({ ...base, state: 'succeeded', finished_at: base.updated_at, error: { code: 'internal-error', message: 'bad' } })).toThrow();
    expect(() => ClaudeJobSchema.parse({ ...base, state: 'cancelled', finished_at: base.updated_at })).toThrow();
    expect(ClaudeJobSchema.parse({ ...base, state: 'cancelled', finished_at: base.updated_at, error: { code: 'cancelled', message: 'Claude job was cancelled.' } }).started_at).toBeUndefined();
    expect(() => ClaudeJobSchema.parse({ ...base, state: 'queued', started_at: base.created_at })).toThrow();
    expect(() => ClaudeJobSchema.parse({ ...base, state: 'failed', finished_at: base.updated_at, error: { code: 'claude-failed', message: 'failed' } })).toThrow();
    expect(() => ClaudeJobSchema.parse({ ...base, state: 'timed_out', started_at: base.created_at, finished_at: base.updated_at, error: { code: 'cancelled', message: 'wrong stable code' } })).toThrow();
  });

  it('rejects unsafe usage metadata rather than persisting arbitrary scalar fields', () => {
    expect(() => ClaudeJobSchema.parse({
      id: 'job_1', state: 'succeeded', created_at: '2026-08-27T12:00:00.000Z',
      updated_at: '2026-08-27T12:00:01.000Z', workspace: '/repo', access: 'inspect', max_turns: 20,
      usage: { input_tokens: 10, prompt: 'private', authorization: 'Bearer synthetic-value', identity: 'user@example.test' },
    })).toThrow();
  });

  it('allows only known aggregate numeric and boolean usage fields from an untrusted stream event', () => {
    expect(sanitizeClaudeUsage({ input_tokens: 10, is_cache_hit: true, prompt: 'private', output_tokens: 'wrong type' }))
      .toEqual({ input_tokens: 10, is_cache_hit: true });
    expect(sanitizeClaudeUsage(null)).toBeUndefined();
  });
});
