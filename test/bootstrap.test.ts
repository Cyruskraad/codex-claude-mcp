import { describe, expect, it } from 'vitest';
import { RUNNER_ENTRYPOINT } from '../src/runner.js';
import { SERVER_ENTRYPOINT } from '../src/server.js';

describe('runtime bootstrap', () => {
  it('defines separate server and runner bundle entrypoints', () => {
    expect(SERVER_ENTRYPOINT).toBe('codex-claude-mcp-server');
    expect(RUNNER_ENTRYPOINT).toBe('codex-claude-mcp-runner');
  });
});
