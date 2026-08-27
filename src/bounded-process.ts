import { spawn } from 'node:child_process';

export interface BoundedProcessOptions {
  executable: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMilliseconds: number;
  outputLimitBytes: number;
  killGraceMilliseconds: number;
  onSignal?: (signal: NodeJS.Signals) => void;
}

export interface BoundedProcessResult {
  spawned: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputLimited: boolean;
  output: string;
}

/** Runs one trusted, canonical executable without a shell or a detached process group. */
export async function runBoundedProcess(options: BoundedProcessOptions): Promise<BoundedProcessResult> {
  return new Promise((resolveResult) => {
    let child;
    try {
      child = spawn(options.executable, options.args, {
        cwd: options.cwd,
        detached: false,
        env: options.environment,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      resolveResult({
        spawned: false, code: null, signal: null, timedOut: false, outputLimited: false, output: '',
      });
      return;
    }

    let finished = false;
    let exited = false;
    let code: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let timedOut = false;
    let outputLimited = false;
    let stopping = false;
    let retainedBytes = 0;
    const chunks: Buffer[] = [];
    let forceTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;

    const output = () => Buffer.concat(chunks, retainedBytes).toString('utf8');
    const finish = (spawned = true) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (settleTimer) clearTimeout(settleTimer);
      resolveResult({ spawned, code, signal, timedOut, outputLimited, output: output() });
    };
    const closePipes = () => {
      for (const stream of [child.stdout, child.stderr]) {
        stream?.removeAllListeners('data');
        stream?.on('error', () => undefined);
        stream?.resume();
        stream?.destroy();
      }
    };
    const signalChild = (requested: NodeJS.Signals) => {
      if (exited) return;
      options.onSignal?.(requested);
      try { child.kill(requested); } catch { /* an exit event remains authoritative */ }
    };
    const settleAfterExit = () => {
      settleTimer = setTimeout(() => {
        closePipes();
        finish();
      }, Math.max(100, options.killGraceMilliseconds));
      settleTimer.unref();
    };
    const stop = (reason: 'timeout' | 'output') => {
      if (stopping || exited) return;
      stopping = true;
      timedOut = reason === 'timeout';
      outputLimited = reason === 'output';
      closePipes();
      signalChild('SIGTERM');
      forceTimer = setTimeout(() => {
        if (!exited) signalChild('SIGKILL');
      }, options.killGraceMilliseconds);
      forceTimer.unref();
    };
    const capture = (chunk: Buffer) => {
      const remaining = Math.max(0, options.outputLimitBytes - retainedBytes);
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        chunks.push(Buffer.from(retained));
        retainedBytes += retained.byteLength;
      }
      if (chunk.byteLength > remaining) stop('output');
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    const timeoutTimer = setTimeout(() => stop('timeout'), options.timeoutMilliseconds);
    timeoutTimer.unref();
    child.once('error', () => {
      exited = true;
      clearTimeout(timeoutTimer);
      settleAfterExit();
    });
    child.once('exit', (exitCode, exitSignal) => {
      exited = true;
      code = exitCode;
      signal = exitSignal;
      clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      settleAfterExit();
    });
    child.once('close', (closeCode, closeSignal) => {
      if (!exited) {
        exited = true;
        code = closeCode;
        signal = closeSignal;
      }
      finish();
    });
  });
}
