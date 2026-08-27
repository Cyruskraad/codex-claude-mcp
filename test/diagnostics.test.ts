import { describe, expect, it } from 'vitest';
import { redactDiagnostic, safeErrorSummary } from '../src/diagnostics.js';

describe('diagnostic sanitization', () => {
  it('redacts credentials, authorization identities, assignments, emails, and home prefixes', () => {
    const home = '/Users/synthetic-user';
    const value = 'Bearer synthetic-token API_KEY=synthetic-value password: synthetic-pass user@company.test /Users/synthetic-user/project';
    const redacted = redactDiagnostic(value, { homeDirectory: home });

    expect(redacted).not.toContain('synthetic-token');
    expect(redacted).not.toContain('synthetic-value');
    expect(redacted).not.toContain('synthetic-pass');
    expect(redacted).not.toContain('user@company.test');
    expect(redacted).not.toContain(home);
    expect(redacted).toContain('[redacted]');
    expect(redacted).toContain('~/project');
  });

  it('creates error-safe summaries that omit prompts, environments, identities, and tool results', () => {
    const summary = safeErrorSummary({
      code: 'claude-failed', message: 'Bearer synthetic-token failed for user@company.test',
      prompt: 'Synthetic private prompt', environment: { API_KEY: 'synthetic-value' },
      tool_result: { content: 'sensitive' },
    });

    expect(summary).toEqual({ code: 'claude-failed', message: 'Bearer [redacted] failed for [redacted-email]' });
  });

  it('redacts complete Authorization values for Basic, custom, and Bearer schemes plus prefixed secret assignments', () => {
    for (const value of [
      'Authorization: Basic synthetic-basic-value',
      'Authorization: Custom synthetic-custom-value',
      'Authorization: Bearer synthetic-bearer-value',
      'ANTHROPIC_API_KEY=synthetic-api-value CUSTOM_PASSWORD:synthetic-password-value',
    ]) {
      const redacted = redactDiagnostic(value);
      expect(redacted).not.toMatch(/synthetic-(basic|custom|bearer|api|password)-value/);
    }
  });

  it('truncates an error-safe summary after redaction to the public error message bound', () => {
    const summary = safeErrorSummary({ code: 'claude-failed', message: 'x'.repeat(2_000) });
    expect(summary.message).toHaveLength(1024);
  });

  it('redacts complete quoted and unquoted environment-style assignment values without crossing delimiters', () => {
    const cases = [
      {
        value: 'CUSTOM_PASSWORD="synthetic secret with spaces", status=public; next=visible',
        expected: 'CUSTOM_PASSWORD=[redacted], status=public; next=visible',
      },
      {
        value: "CUSTOM_SECRET='synthetic secret with an \\'escaped quote\\''; next=visible",
        expected: 'CUSTOM_SECRET=[redacted]; next=visible',
      },
      {
        value: 'CUSTOM_TOKEN="synthetic secret with spaces"\nnext=visible',
        expected: 'CUSTOM_TOKEN=[redacted]\nnext=visible',
      },
      {
        value: 'ANTHROPIC_API_KEY=synthetic-unquoted, next=visible; final=public',
        expected: 'ANTHROPIC_API_KEY=[redacted], next=visible; final=public',
      },
    ];

    for (const { value, expected } of cases) {
      expect(redactDiagnostic(value)).toBe(expected);
    }
  });

  it('uses stable fallbacks for non-errors, unknown codes, empty messages, and an empty injected home', () => {
    expect(safeErrorSummary(null)).toEqual({ code: 'internal-error', message: 'An internal error occurred.' });
    expect(safeErrorSummary({ code: 'future-code', message: '' })).toEqual({ code: 'internal-error', message: 'An internal error occurred.' });
    expect(redactDiagnostic('plain diagnostic', { homeDirectory: '' })).toBe('plain diagnostic');
  });
});
