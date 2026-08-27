export const RUNNER_ENTRYPOINT = 'codex-claude-mcp-runner';

import { JobStore } from './job-store.js';
import { executeRunner } from './runner-engine.js';

function argument(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

interface RunnerMainStore {
  init(): Promise<void>;
  read(jobId: string): Promise<{ job: { state: string }; runner: { token: string; pid?: number } }>;
}

interface RunnerMainDependencies {
  processId?: number;
  storeFactory?: (stateRoot: string) => RunnerMainStore;
  execute?: (options: { store: JobStore; jobId: string; runnerToken: string }) => Promise<void>;
  wait?: () => Promise<void>;
  maxAttempts?: number;
}

export async function runDetachedRunnerMain(argv: string[], dependencies: RunnerMainDependencies = {}): Promise<number> {
  const stateRoot = argument(argv, '--state-root');
  const jobId = argument(argv, '--job-id');
  const runnerToken = argument(argv, '--runner-token');
  if (!stateRoot || !jobId || !runnerToken) return 2;
  const store = (dependencies.storeFactory ?? ((root) => new JobStore({ stateRoot: root })))(stateRoot);
  const processId = dependencies.processId ?? process.pid;
  const wait = dependencies.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
  await store.init();
  for (let attempts = 0; attempts < (dependencies.maxAttempts ?? 500); attempts += 1) {
    const record = await store.read(jobId);
    if (record.job.state === 'running' && record.runner.pid === processId && record.runner.token === runnerToken) {
      const execute = dependencies.execute ?? executeRunner;
      await execute({ store: store as JobStore, jobId, runnerToken });
      return 0;
    }
    if (record.job.state !== 'queued' && record.job.state !== 'running') return 0;
    await wait();
  }
  return 3;
}

if (process.argv.includes('--job-id')) {
  void runDetachedRunnerMain(process.argv)
    .then((code) => { process.exitCode = code; })
    .catch(() => { process.exitCode = 1; });
}
