import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateWorkspace } from '../src/workspace-policy.js';

const created: string[] = [];
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

  it('requires an enclosing Git worktree for write access including a .git file worktree marker', async () => {
    const root = await temporaryDirectory();
    const repo = join(root, 'repo');
    const child = join(repo, 'child');
    await mkdir(child, { recursive: true });

    await expect(validateWorkspace(child, { access: 'write', homeDirectory: join(root, 'home') })).rejects.toMatchObject({
      code: 'write-requires-git',
    });

    await writeFile(join(repo, '.git'), 'gitdir: /private/git/worktrees/example\n');
    const canonicalChild = await realpath(child);
    await expect(validateWorkspace(child, { access: 'write', homeDirectory: join(root, 'home') })).resolves.toEqual({
      canonicalPath: canonicalChild,
    });
  });
});
