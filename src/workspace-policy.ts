import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, parse, resolve } from 'node:path';
import { ClaudeContractError } from './contracts.js';

export class WorkspacePolicyError extends ClaudeContractError {}

export interface GitProbeResult {
  isWorkTree: boolean;
  isInsideGitDir: boolean;
}

/** Injectable for tests; production uses the Git executable with no shell. */
export type GitProbe = (workspace: string) => Promise<GitProbeResult>;

export interface WorkspacePolicyOptions {
  access?: 'inspect' | 'write';
  homeDirectory?: string;
  gitProbe?: GitProbe;
}

export interface ValidatedWorkspace {
  canonicalPath: string;
}

/** Uses Git's own worktree state rather than trusting a filesystem marker. */
export async function probeGitWorktree(workspace: string): Promise<GitProbeResult> {
  return new Promise((resolveProbe) => {
    let child;
    try {
      child = spawn('git', ['rev-parse', '--is-inside-work-tree', '--is-inside-git-dir'], {
        cwd: workspace,
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolveProbe({ isWorkTree: false, isInsideGitDir: false });
      return;
    }

    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 128) stdout += chunk.toString('utf8').slice(0, 128 - stdout.length);
    });
    child.once('error', () => resolveProbe({ isWorkTree: false, isInsideGitDir: false }));
    child.once('close', (code) => {
      if (code !== 0) {
        resolveProbe({ isWorkTree: false, isInsideGitDir: false });
        return;
      }
      const [isWorkTree, isInsideGitDir] = stdout.trim().split(/\s+/);
      resolveProbe({ isWorkTree: isWorkTree === 'true', isInsideGitDir: isInsideGitDir === 'true' });
    });
  });
}

export async function isInsideGitWorktree(canonicalPath: string, gitProbe: GitProbe = probeGitWorktree): Promise<boolean> {
  const result = await gitProbe(canonicalPath);
  return result.isWorkTree && !result.isInsideGitDir;
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

  const git = await (options.gitProbe ?? probeGitWorktree)(canonicalPath);
  if (git.isInsideGitDir) {
    throw new WorkspacePolicyError('forbidden-workspace', 'Workspace cannot be inside Git metadata.');
  }
  if (options.access === 'write' && !git.isWorkTree) {
    throw new WorkspacePolicyError('write-requires-git', 'Write access requires a Git working tree.');
  }

  return { canonicalPath };
}
