import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { ClaudeContractError } from './contracts.js';

export class WorkspacePolicyError extends ClaudeContractError {}

export interface WorkspacePolicyOptions {
  access?: 'inspect' | 'write';
  homeDirectory?: string;
}

export interface ValidatedWorkspace {
  canonicalPath: string;
}

async function pathIsGitMarker(path: string): Promise<boolean> {
  try {
    const marker = await lstat(path);
    if (marker.isDirectory()) return true;
    if (!marker.isFile()) return false;
    return /^gitdir:\s+\S+/m.test(await readFile(path, 'utf8'));
  } catch {
    return false;
  }
}

/** Checks for a normal repository marker or Git's .git-file worktree marker without invoking a shell. */
export async function isInsideGitWorktree(canonicalPath: string): Promise<boolean> {
  let current = canonicalPath;
  for (;;) {
    if (await pathIsGitMarker(join(current, '.git'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export async function validateWorkspace(
  suppliedPath: string,
  options: WorkspacePolicyOptions = {},
): Promise<ValidatedWorkspace> {
  if (!isAbsolute(suppliedPath)) {
    throw new WorkspacePolicyError('invalid-workspace', 'Workspace must be an absolute existing directory.');
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(suppliedPath);
    if (!(await stat(canonicalPath)).isDirectory()) {
      throw new WorkspacePolicyError('invalid-workspace', 'Workspace must be an existing directory.');
    }
  } catch (error) {
    if (error instanceof WorkspacePolicyError) throw error;
    throw new WorkspacePolicyError('invalid-workspace', 'Workspace must be an existing directory.');
  }

  const requestedPath = resolve(suppliedPath);
  if (canonicalPath !== requestedPath) {
    throw new WorkspacePolicyError('forbidden-workspace', 'Workspace cannot traverse a symbolic link.');
  }

  const requestedHome = options.homeDirectory ?? homedir();
  let canonicalHome = resolve(requestedHome);
  try {
    canonicalHome = await realpath(requestedHome);
  } catch {
    // A non-existent injected home path is still safe to compare in tests and callers.
  }
  if (canonicalPath === parse(canonicalPath).root || canonicalPath === canonicalHome) {
    throw new WorkspacePolicyError('forbidden-workspace', 'Workspace is not an allowed target.');
  }

  if (options.access === 'write' && !(await isInsideGitWorktree(canonicalPath))) {
    throw new WorkspacePolicyError('write-requires-git', 'Write access requires a Git working tree.');
  }

  return { canonicalPath };
}
