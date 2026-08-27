#!/usr/bin/env node
/* global process, Buffer, setInterval, clearInterval */
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const control = process.env.FAKE_CLAUDE_CONTROL_DIR;
const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? 'success';

if (process.env.FAKE_HEALTH_PROBE_RECORD) {
  await appendFile(
    process.env.FAKE_HEALTH_PROBE_RECORD,
    `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() })}\n`,
    { mode: 0o600 },
  );
}

if (process.argv.includes('--version')) {
  if (process.env.FAKE_VERSION_SCENARIO === 'flood') {
    process.stdout.write(Buffer.alloc(4097, 118));
    process.exit(0);
  }
  if (process.env.FAKE_VERSION_SCENARIO === 'hang') {
    process.on('SIGTERM', () => undefined);
    setInterval(() => undefined, 1_000);
    await new Promise(() => undefined);
  }
  process.stdout.write(process.env.FAKE_CLAUDE_VERSION ?? '2.1.0 (Claude Code)\n');
  process.exit(Number(process.env.FAKE_VERSION_EXIT ?? 0));
}

if (process.argv.includes('--help')) {
  if (process.env.FAKE_HELP_SCENARIO === 'flood') {
    await new Promise((resolveWrite) => process.stdout.write(Buffer.alloc(65_537, 104), resolveWrite));
    process.exit(0);
  }
  if (process.env.FAKE_HELP_SCENARIO === 'combined-flood') {
    await Promise.all([
      new Promise((resolveWrite) => process.stdout.write(Buffer.alloc(40_000, 104), resolveWrite)),
      new Promise((resolveWrite) => process.stderr.write(Buffer.alloc(40_000, 101), resolveWrite)),
    ]);
    process.exit(0);
  }
  if (process.env.FAKE_HELP_SCENARIO === 'hang') {
    process.on('SIGTERM', () => undefined);
    setInterval(() => undefined, 1_000);
    await new Promise(() => undefined);
  }
  const completeHelp = [
    '-p, --print', '--input-format stream-json', '--output-format stream-json', '--verbose',
    '--max-turns', '--no-chrome', '--tools', '--permission-mode', '--model', '--effort',
    '--resume', '--cloud', '--name', '--mcp-config', '--strict-mcp-config', '--disallowedTools',
  ].join('\n');
  process.stdout.write(process.env.FAKE_CLAUDE_HELP ?? completeHelp);
  process.exit(Number(process.env.FAKE_HELP_EXIT ?? 0));
}

if (JSON.stringify(process.argv.slice(2)) === JSON.stringify(['-p', '--max-turns', '0'])) {
  const probeScenario = process.env.FAKE_MAX_TURNS_PROBE_SCENARIO ?? 'recognized';
  if (probeScenario === 'slow-recognized-prompt-argument') await delay(2_250);
  if (probeScenario === 'hang') {
    process.on('SIGTERM', () => undefined);
    setInterval(() => undefined, 1_000);
    await new Promise(() => undefined);
  }
  if (probeScenario === 'flood') {
    await new Promise((resolveWrite) => process.stderr.write(Buffer.alloc(4_097, 109), resolveWrite));
    process.exit(1);
  }
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk.toString('utf8');
  if (process.env.FAKE_MAX_TURNS_PROBE_RECORD) {
    await writeFile(
      process.env.FAKE_MAX_TURNS_PROBE_RECORD,
      JSON.stringify({ argv: process.argv.slice(2), stdin }),
      { mode: 0o600 },
    );
  }
  const supplementalOutput = process.env.FAKE_MAX_TURNS_PROBE_OUTPUT ?? '';
  if (probeScenario === 'signal-after-recognized') {
    process.stderr.write('Error: Input must be provided either through stdin or as a positional argument when using --print.', () => {
      process.kill(process.pid, 'SIGTERM');
    });
    await new Promise(() => undefined);
  }
  const outcomes = {
    recognized: [1, 'Error: Input must be provided either through stdin or as a positional argument when using --print.'],
    'recognized-prompt-argument': [1, 'Error: Input must be provided either through stdin or as a prompt argument when using --print'],
    'slow-recognized-prompt-argument': [1, 'Error: Input must be provided either through stdin or as a prompt argument when using --print'],
    unknown: [1, "error: unknown option '--max-turns'"],
    uncertain: [7, 'Unexpected parser failure.'],
    authentication: [1, 'Authentication required.'],
    network: [1, 'Network request failed.'],
    'exit-zero': [0, ''],
    'bare-missing-input': [1, 'Error: Input must be provided.'],
    mixed: [1, "error: unknown option '--max-turns'\nError: Input must be provided either through stdin or as a positional argument when using --print."],
  };
  const [exitCode, output] = outcomes[probeScenario] ?? outcomes.uncertain;
  process.stderr.write(`${output}${supplementalOutput ? `\n${supplementalOutput}` : ''}`);
  process.exit(exitCode);
}

if (process.argv[2] === 'auth' && process.argv[3] === 'status') {
  if (process.env.FAKE_AUTH_SCENARIO === 'hang') {
    process.on('SIGTERM', () => undefined);
    setInterval(() => undefined, 1_000);
    await new Promise(() => undefined);
  }
  process.stdout.write(process.env.FAKE_AUTH_OUTPUT ?? 'signed in\n');
  process.stderr.write(process.env.FAKE_AUTH_ERROR ?? '');
  const exits = { ready: 0, not_ready: 1, expired: 1, unknown: 7 };
  process.exit(exits[process.env.FAKE_AUTH_SCENARIO ?? 'ready'] ?? 7);
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
  case 'controlled-write':
    await writeFile(join(process.cwd(), 'claude-controlled-write.txt'), 'controlled write\n', { mode: 0o600 });
    success();
    break;
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
  case 'combined-bytes': {
    process.stdout.write(Buffer.alloc(Number(process.env.FAKE_STDOUT_BYTES), 120));
    process.stderr.write(Buffer.alloc(Number(process.env.FAKE_STDERR_BYTES), 121));
    break;
  }
  case 'flood': {
    process.on('SIGTERM', () => undefined);
    process.stdout.on('error', () => undefined);
    process.stderr.on('error', () => undefined);
    await new Promise(() => {
      const bytes = Buffer.alloc(64 * 1024, 122);
      setInterval(() => { process.stdout.write(bytes); process.stderr.write(bytes); }, 0);
    });
    break;
  }
  default: process.exitCode = 91;
}
