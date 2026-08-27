import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '..');
const bundleDirectory = join(repositoryRoot, 'plugins/codex-claude-mcp/dist');

async function executeAlone(source: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  const root = await mkdtemp(join(tmpdir(), 'codex-claude-single-bundle-'));
  const copy = join(root, basename(source));
  await copyFile(source, copy);
  const stateRoot = join(root, 'state');
  return new Promise((resolveExecution, rejectExecution) => {
    const child = spawn(process.execPath, [copy], {
      cwd: root,
      env: { ...process.env, CODEX_CLAUDE_MCP_STATE_DIR: stateRoot },
      shell: false,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(0, Math.max(0, 8_192 - stderr.length));
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectExecution(new Error(`Standalone bundle did not exit: ${basename(source)}`));
    }, 3_000);
    child.once('error', rejectExecution);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolveExecution({ code, signal, stderr });
    });
    child.stdin.end();
  });
}

describe('self-contained production bundles', () => {
  it.each(['server.mjs', 'runner.mjs'])('%s executes when copied without sibling chunks', async (name) => {
    const source = join(bundleDirectory, name);
    const bundledSource = await readFile(source, 'utf8');
    expect(bundledSource).not.toMatch(/(?:from|import)\s*[(']?["']\.\/(?:chunk-|[^"']+\.mjs)/);
    await expect(executeAlone(source)).resolves.toEqual({ code: 0, signal: null, stderr: '' });
  });
});
