import { describe, expect, it } from 'vitest';
import { parseClaudeTaskInput } from '../src/contracts.js';
import { buildClaudeInvocation } from '../src/claude-invocation.js';

const input = (overrides: Record<string, unknown> = {}) => parseClaudeTaskInput({
  workspace: '/workspace', prompt: 'Synthetic task instruction', ...overrides,
});

describe('Claude invocation builder', () => {
  it('sends the prompt only as a newline-terminated stream JSON user message', () => {
    const invocation = buildClaudeInvocation(input());
    expect(invocation.stdin).toBe('{"type":"user","message":{"role":"user","content":"Synthetic task instruction"}}\n');
    expect(invocation.args.join(' ')).not.toContain('Synthetic task instruction');
  });

  it('uses a constrained inspect invocation with local MCP denied', () => {
    expect(buildClaudeInvocation(input()).args).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--max-turns', '20', '--no-chrome', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--disallowedTools', 'mcp__*', '--tools', 'Read,Glob,Grep', '--permission-mode', 'plan',
    ]);
  });

  it('uses acceptEdits for write without any bypass-style permission mode or flag', () => {
    const invocation = buildClaudeInvocation(input({ access: 'write', model: 'sonnet', effort: 'high' }));
    expect(invocation.args).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--max-turns', '20', '--no-chrome', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--disallowedTools', 'mcp__*', '--permission-mode', 'acceptEdits',
      '--model', 'sonnet', '--effort', 'high',
    ]);
    expect(invocation.args).not.toContain('--tools');
    for (const forbidden of [
      '--continue', '--add-dir', '--chrome', '--dangerously-skip-permissions',
      'bypassPermissions', 'auto', 'dontAsk', '--accept-edits',
    ]) {
      expect(invocation.args).not.toContain(forbidden);
    }
  });

  it.each([
    [{ mode: 'resume', session_id: 'sess_123' }, ['--resume', 'sess_123']],
    [{ mode: 'cloud_create', description: 'Batch review' }, ['--cloud', '--name', 'Batch review']],
    [{ mode: 'cloud_attach', target: 'cloud_123' }, ['--cloud', 'cloud_123']],
  ] as const)('maps explicit session mode %o to current CLI arguments', (session, expected) => {
    const args = buildClaudeInvocation(input({ session })).args;
    expect(args.slice(-expected.length)).toEqual(expected);
  });
});
