import { describe, expect, it, vi } from 'vitest';
import { runDetachedRunnerMain } from '../src/runner.js';

describe('detached runner entrypoint', () => {
  it('rejects incomplete runner arguments without opening state', async () => {
    const storeFactory = vi.fn();
    expect(await runDetachedRunnerMain(['node', 'runner'], { storeFactory })).toBe(2);
    expect(storeFactory).not.toHaveBeenCalled();
  });

  it('waits for its persisted ownership record and executes exactly once', async () => {
    const execute = vi.fn(async () => undefined);
    let reads = 0;
    const store = {
      init: vi.fn(async () => undefined),
      read: vi.fn(async () => {
        reads += 1;
        return reads === 1
          ? { job: { state: 'queued' }, runner: { token: 'token' } }
          : { job: { state: 'running' }, runner: { token: 'token', pid: 321 } };
      }),
    };
    const result = await runDetachedRunnerMain([
      'node', 'runner', '--state-root', '/state', '--job-id', 'job_1', '--runner-token', 'token',
    ], { processId: 321, storeFactory: () => store, execute, wait: async () => undefined, maxAttempts: 2 });
    expect(result).toBe(0);
    expect(store.init).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('stops safely for a terminal job or exhausted readiness attempts', async () => {
    const terminalStore = { init: async () => undefined, read: async () => ({ job: { state: 'cancelled' }, runner: { token: 'token' } }) };
    expect(await runDetachedRunnerMain([
      'node', 'runner', '--state-root', '/state', '--job-id', 'job_1', '--runner-token', 'token',
    ], { storeFactory: () => terminalStore, wait: async () => undefined })).toBe(0);
    const queuedStore = { init: async () => undefined, read: async () => ({ job: { state: 'queued' }, runner: { token: 'token' } }) };
    expect(await runDetachedRunnerMain([
      'node', 'runner', '--state-root', '/state', '--job-id', 'job_1', '--runner-token', 'token',
    ], { storeFactory: () => queuedStore, wait: async () => undefined, maxAttempts: 1 })).toBe(3);
  });
});
