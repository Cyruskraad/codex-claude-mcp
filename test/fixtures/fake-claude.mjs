#!/usr/bin/env node
/* global process, Buffer, setInterval, clearInterval */
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const control = process.env.FAKE_CLAUDE_CONTROL_DIR;
const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? 'success';

if (process.argv.includes('--version')) {
  process.stdout.write(process.env.FAKE_CLAUDE_VERSION ?? '2.1.0 (Claude Code)\n');
  process.exit(0);
}

if (!control) process.exit(90);
await writeFile(join(control, 'argv.json'), JSON.stringify(process.argv.slice(2)), { mode: 0o600 });

let stdin = '';
for await (const chunk of process.stdin) stdin += chunk.toString('utf8');
await writeFile(join(control, 'stdin.txt'), stdin, { mode: 0o600 });
await writeFile(join(control, 'ready'), 'ready', { mode: 0o600 });

const success = () => {
  process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess_fake' })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'progress', message: 'Working safely' })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: 'result', subtype: 'success', result: process.env.FAKE_CLAUDE_RESULT ?? 'héllo 🌍',
    session_id: 'sess_fake', usage: { input_tokens: 3, output_tokens: 4 }, total_cost_usd: 0.012,
  })}\n`);
};

switch (scenario) {
  case 'success': success(); break;
  case 'malformed': process.stdout.write('{private offending bytes\n'); break;
  case 'auth':
    process.stdout.write(`${JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'private identity' } })}\n`);
    break;
  case 'crash': process.exitCode = 17; break;
  case 'partial-crash':
    process.stdout.write(`${JSON.stringify({ type: 'progress', message: 'partial private detail' })}\n`);
    process.exitCode = 18;
    break;
  case 'hang': {
    process.on('SIGTERM', async () => {
      await appendFile(join(control, 'signals'), 'TERM\n');
      if (process.env.FAKE_CLAUDE_IGNORE_TERM !== '1') process.exit(143);
    });
    await new Promise((resolve) => {
      const interval = setInterval(async () => {
        try {
          await readFile(join(control, 'release'));
          clearInterval(interval);
          resolve();
        } catch { /* readiness-controlled wait */ }
      }, 10);
    });
    success();
    break;
  }
  case 'stdout-bytes': process.stdout.write(Buffer.alloc(Number(process.env.FAKE_OUTPUT_BYTES), 120)); break;
  case 'stderr-bytes': process.stderr.write(Buffer.alloc(Number(process.env.FAKE_OUTPUT_BYTES), 121)); break;
  default: process.exitCode = 91;
}
