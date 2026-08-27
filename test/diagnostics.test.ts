import { describe, expect, it } from 'vitest';
import { redactDiagnostic, safeErrorSummary } from '../src/diagnostics.js';

describe('diagnostic sanitization', () => {
  it('redacts credentials, authorization identities, assignments, emails, and home prefixes', () => {
    const home = '/Users/synthetic-user';
    const value = 'Authorization: Bearer synthetic-token API_KEY=synthetic-value password: synthetic-pass user@company.test /Users/synthetic-user/project';
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
});
