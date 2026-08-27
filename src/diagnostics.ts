import { homedir } from 'node:os';
import { ClaudeErrorCodeSchema, type ClaudeError } from './contracts.js';

export interface DiagnosticOptions {
  homeDirectory?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Removes credentials and direct identities before diagnostics leave the child-process boundary. */
export function redactDiagnostic(value: string, options: DiagnosticOptions = {}): string {
  const homeDirectory = options.homeDirectory ?? homedir();
  let redacted = value;
  if (homeDirectory) redacted = redacted.replace(new RegExp(escapeRegExp(homeDirectory), 'g'), '~');
  return redacted
    .replace(/\bsk-ant-(?:api\d+-)?[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]+/gi, '$1 [redacted]')
    .replace(/\b(Authorization)\s*:\s*(?:Bearer\s+)?[^\s,;]+/gi, '$1: [redacted]')
    .replace(/\b(api[_-]?key|token|secret|password)\b\s*([:=])\s*[^\s,;]+/gi, '$1$2[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]');
}

/** Produces a deliberately small error shape; it never serializes prompt, environment, identity, or tool-result fields. */
export function safeErrorSummary(value: unknown, options: DiagnosticOptions = {}): ClaudeError {
  const record = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  const code = ClaudeErrorCodeSchema.safeParse(record.code).success
    ? record.code as ClaudeError['code']
    : 'internal-error';
  const message = typeof record.message === 'string'
    ? redactDiagnostic(record.message, options)
    : 'An internal error occurred.';
  return { code, message };
}
