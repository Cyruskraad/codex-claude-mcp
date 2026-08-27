import type { NormalizedClaudeTaskInput } from './contracts.js';

export interface ClaudeInvocation {
  args: string[];
  stdin: string;
}

const EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} });

/** Builds only data for a shell-free spawn; the prompt deliberately exists only in the stream-JSON stdin message. */
export function buildClaudeInvocation(input: NormalizedClaudeTaskInput): ClaudeInvocation {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', String(input.max_turns),
    '--no-chrome',
    '--strict-mcp-config',
    '--mcp-config', EMPTY_MCP_CONFIG,
    '--disallowedTools', 'mcp__*',
  ];

  if (input.access === 'inspect') {
    args.push('--tools', 'Read,Glob,Grep', '--permission-mode', 'plan');
  } else {
    args.push('--permission-mode', 'acceptEdits');
  }
  if (input.model) args.push('--model', input.model);
  if (input.effort) args.push('--effort', input.effort);

  switch (input.session.mode) {
    case 'resume':
      args.push('--resume', input.session.session_id);
      break;
    case 'cloud_create':
      args.push('--cloud');
      if (input.session.description) args.push('--name', input.session.description);
      break;
    case 'cloud_attach':
      args.push('--cloud', input.session.target);
      break;
    case 'new':
      break;
  }

  return {
    args,
    stdin: `${JSON.stringify({ type: 'user', message: { role: 'user', content: input.prompt } })}\n`,
  };
}
