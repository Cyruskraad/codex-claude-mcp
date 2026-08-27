import { describe, expect, it } from 'vitest';
import { runBoundedProcess } from '../src/bounded-process.js';

describe('bounded direct-child probes', () => {
  it('retains complete fast output emitted immediately before natural exit', async () => {
    const expected = 'v'.repeat(4_000);
    const result = await runBoundedProcess({
      executable: process.execPath,
      args: ['-e', `process.stdout.end(${JSON.stringify(expected)})`],
      environment: process.env,
      timeoutMilliseconds: 500,
      outputLimitBytes: 4_096,
      killGraceMilliseconds: 20,
    });
    expect(result).toMatchObject({ code: 0, signal: null, timedOut: false, outputLimited: false, output: expected });
  });

  it('treats exit as authoritative when inherited pipes close later and sends no signal', async () => {
    const signals: NodeJS.Signals[] = [];
    const started = Date.now();
    const result = await runBoundedProcess({
      executable: process.execPath,
      args: ['-e', [
        "const {spawn}=require('node:child_process')",
        "spawn(process.execPath,['-e','setTimeout(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr]}).unref()",
        "process.stdout.write('ok')",
      ].join(';')],
      environment: process.env,
      timeoutMilliseconds: 200,
      outputLimitBytes: 4_096,
      killGraceMilliseconds: 20,
      onSignal: (signal) => signals.push(signal),
    });

    expect(result).toMatchObject({ code: 0, timedOut: false, outputLimited: false, output: 'ok' });
    expect(signals).toEqual([]);
    expect(Date.now() - started).toBeLessThan(700);
  });

  it('terminates a TERM-resistant direct child with KILL and settles after reap', async () => {
    const signals: NodeJS.Signals[] = [];
    const started = Date.now();
    const result = await runBoundedProcess({
      executable: process.execPath,
      args: ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      environment: process.env,
      timeoutMilliseconds: 150,
      outputLimitBytes: 4_096,
      killGraceMilliseconds: 20,
      onSignal: (signal) => signals.push(signal),
    });

    expect(result).toMatchObject({ code: null, signal: 'SIGKILL', timedOut: true, outputLimited: false });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
