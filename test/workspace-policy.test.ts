import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isInsideGitWorktree, probeGitWorktree, validateWorkspace } from '../src/workspace-policy.js';

const created: string[] = [];
const runGit = (args: string[]) => promisify(execFile)('git', args);
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'codex-claude-contract-'));
  const canonicalDirectory = await realpath(directory);
  created.push(canonicalDirectory);
  return canonicalDirectory;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map(async (directory) => {
    await (await import('node:fs/promises')).rm(directory, { recursive: true, force: true });
  }));
});

describe('workspace policy', () => {
  it('returns the existing directory canonical path without broadening it', async () => {
    const root = await temporaryDirectory();
    const nested = join(root, 'nested');
    await mkdir(nested);
    const canonicalNested = await realpath(nested);

    await expect(validateWorkspace(nested, { homeDirectory: join(root, 'home') })).resolves.toEqual({
      canonicalPath: canonicalNested,
    });
  });

  it.each(['missing', 'file'])('rejects a non-directory workspace: %s', async (kind) => {
    const root = await temporaryDirectory();
    const path = join(root, kind);
    if (kind === 'file') await writeFile(path, 'not a directory');

    await expect(validateWorkspace(path, { homeDirectory: join(root, 'home') })).rejects.toMatchObject({
      code: 'invalid-workspace',
    });
  });

  it('rejects root and the home directory itself', async () => {
    const root = await temporaryDirectory();
    await expect(validateWorkspace('/', { homeDirectory: root })).rejects.toMatchObject({ code: 'forbidden-workspace' });
    await expect(validateWorkspace(root, { homeDirectory: root })).rejects.toMatchObject({ code: 'forbidden-workspace' });
  });

  it('rejects any supplied path whose canonical path changes through a symlink', async () => {
    const root = await temporaryDirectory();
    const actual = join(root, 'actual');
    const link = join(root, 'link');
    await mkdir(actual);
    await symlink(actual, link);

    await expect(validateWorkspace(link, { homeDirectory: join(root, 'home') })).rejects.toMatchObject({
      code: 'forbidden-workspace',
    });
  });

  it('rejects fake Git markers and stale worktree pointers for write access', async () => {
    const root = await temporaryDirectory();
    const repo = join(root, 'repo');
    const child = join(repo, 'child');
    await mkdir(child, { recursive: true });

    await expect(validateWorkspace(child, { access: 'write', homeDirectory: join(root, 'home') })).rejects.toMatchObject({
      code: 'write-requires-git',
    });

    await mkdir(join(repo, '.git'));
    await expect(validateWorkspace(child, { access: 'write', homeDirectory: join(root, 'home') })).rejects.toMatchObject({
      code: 'write-requires-git',
    });

    await rm(join(repo, '.git'), { recursive: true });
    await writeFile(join(repo, '.git'), 'gitdir: /nonexistent/stale-worktree\n');
    await expect(validateWorkspace(child, { access: 'write', homeDirectory: join(root, 'home') })).rejects.toMatchObject({
      code: 'write-requires-git',
    });
  });

  it('accepts nested paths in a real Git repository without broadening them', async () => {
    const root = await temporaryDirectory();
    const repo = join(root, 'repo');
    const child = join(repo, 'child');
    await mkdir(repo);
    await runGit(['init', '--quiet', repo]);
    await mkdir(child);
    const canonicalChild = await realpath(child);
    await expect(validateWorkspace(child, { access: 'write', homeDirectory: join(root, 'home') })).resolves.toEqual({
      canonicalPath: canonicalChild,
    });
  });

  it('accepts a real linked worktree marker but rejects its Git metadata interior', async () => {
    const root = await temporaryDirectory();
    const repo = join(root, 'repo');
    const linked = join(root, 'linked');
    const child = join(linked, 'child');
    await mkdir(repo);
    await runGit(['init', '--quiet', repo]);
    await runGit(['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'init']);
    await runGit(['-C', repo, 'worktree', 'add', '--detach', '--quiet', linked]);
    await mkdir(child);

    await expect(validateWorkspace(child, { access: 'write', homeDirectory: join(root, 'home') })).resolves.toEqual({
      canonicalPath: await realpath(child),
    });
    await expect(validateWorkspace(join(repo, '.git'), { homeDirectory: join(root, 'home') })).rejects.toMatchObject({
      code: 'forbidden-workspace',
    });
  });

  it('uses an injectable Git probe and rejects metadata paths before returning a workspace', async () => {
    const root = await temporaryDirectory();
    const workspace = join(root, 'workspace');
    await mkdir(workspace);

    await expect(validateWorkspace(workspace, {
      homeDirectory: join(root, 'home'),
      gitProbe: async () => ({ isWorkTree: true, isInsideGitDir: true }),
    })).rejects.toMatchObject({ code: 'forbidden-workspace' });
  });

  it('exposes a shell-free Git probe result and evaluates injected worktree state', async () => {
    const root = await temporaryDirectory();
    expect(await probeGitWorktree(root)).toEqual({ isWorkTree: false, isInsideGitDir: false });
    await expect(isInsideGitWorktree(root, async () => ({ isWorkTree: true, isInsideGitDir: false }))).resolves.toBe(true);
    await expect(isInsideGitWorktree(root, async () => ({ isWorkTree: true, isInsideGitDir: true }))).resolves.toBe(false);
  });

  it.each(['', '.', 'relative-bin'])('never executes a workspace Git binary from unsafe PATH entry %j', async (entry) => {
    const root = await temporaryDirectory();
    const marker = join(root, 'git-executed');
    const maliciousGit = join(root, 'git');
    await writeFile(maliciousGit, `#!/bin/sh\n/bin/echo executed > '${marker}'\n/bin/echo true\n/bin/echo false\n`, { mode: 0o700 });
    await chmod(maliciousGit, 0o700);
    const previousPath = process.env.PATH;
    process.env.PATH = entry;
    try {
      await expect(probeGitWorktree(root)).resolves.toEqual({ isWorkTree: false, isInsideGitDir: false });
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it('bounds output and runtime from the resolved absolute Git probe', async () => {
    const root = await temporaryDirectory();
    const bin = join(root, 'bin');
    await mkdir(bin);
    const fakeGit = join(bin, 'git');
    await writeFile(fakeGit, '#!/bin/sh\ntrap "" TERM\nwhile :; do /bin/echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done\n', { mode: 0o700 });
    const started = Date.now();
    await expect(probeGitWorktree(root, {
      environment: { PATH: bin }, timeoutMilliseconds: 50, outputLimitBytes: 128, killGraceMilliseconds: 20,
    })).resolves.toEqual({ isWorkTree: false, isInsideGitDir: false });
    expect(Date.now() - started).toBeLessThan(500);
  });
});
