import { describe, expect, it } from 'vitest';
import {
  ClaudeTaskInputSchema,
  ClaudeJobSchema,
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
    [{ workspace: '/workspace', prompt: 'x', execution: { timeout_seconds: 29 } }],
    [{ workspace: '/workspace', prompt: 'x', execution: { timeout_seconds: 7201 } }],
  ])('rejects invalid required values and bounds: %o', (input) => {
    expect(() => ClaudeTaskInputSchema.parse(input)).toThrow();
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

  it('exports all stable job states and validates a timestamped job', () => {
    expect(JobStateSchema.options).toEqual([
      'queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'output_limited', 'orphaned',
    ]);
    expect(ClaudeJobSchema.parse({
      id: 'job_1', state: 'succeeded', created_at: '2026-08-27T12:00:00.000Z',
      updated_at: '2026-08-27T12:00:01.000Z', workspace: '/repo', access: 'inspect', max_turns: 20,
    })).toMatchObject({ id: 'job_1', state: 'succeeded' });
  });
});
