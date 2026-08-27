import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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

async function aliasedBundle(source: string): Promise<{ alias: string; root: string; stateRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'codex-claude-aliased-bundle-'));
  const physical = join(root, 'physical');
  const alias = join(root, 'alias');
  await mkdir(physical);
  await symlink(physical, alias, 'dir');
  await copyFile(source, join(physical, basename(source)));
  return { alias: join(alias, basename(source)), root, stateRoot: join(root, 'state') };
}

async function initializeAliasedServer(source: string): Promise<{ name?: string; version?: string }> {
  const bundle = await aliasedBundle(source);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundle.alias],
    cwd: bundle.root,
    env: {
      HOME: process.env.HOME ?? tmpdir(),
      PATH: process.env.PATH ?? '',
      CODEX_CLAUDE_MCP_STATE_DIR: bundle.stateRoot,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'aliased-bundle-test', version: '0.1.0' });
  try {
    await client.connect(transport);
    return client.getServerVersion() ?? {};
  } finally {
    await client.close().catch(() => undefined);
  }
}

describe('self-contained production bundles', () => {
  it.each(['server.mjs', 'runner.mjs'])('%s executes when copied without sibling chunks', async (name) => {
    const source = join(bundleDirectory, name);
    const bundledSource = await readFile(source, 'utf8');
    expect(bundledSource).not.toMatch(/(?:from|import)\s*[(']?["']\.\/(?:chunk-|[^"']+\.mjs)/);
    await expect(executeAlone(source)).resolves.toEqual({ code: 0, signal: null, stderr: '' });
  });

  it('initializes the MCP server when its bundle is invoked through a symlink alias', async () => {
    await expect(initializeAliasedServer(join(bundleDirectory, 'server.mjs'))).resolves.toEqual({
      name: 'codex-claude-mcp', version: '0.1.1',
    });
  });

  it('executes the runner main when its bundle is invoked through a symlink alias', async () => {
    const bundle = await aliasedBundle(join(bundleDirectory, 'runner.mjs'));
    await expect(new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
      const child = spawn(process.execPath, [bundle.alias, '--job-id', 'missing-required-runner-inputs'], {
        cwd: bundle.root, shell: false, stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.once('error', rejectExit);
      child.once('close', (code, signal) => resolveExit({ code, signal }));
    })).resolves.toEqual({ code: 2, signal: null });
  });
});
