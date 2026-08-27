import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

export type ExecutableResolution =
  | { found: true; path: string; resolution: 'override' | 'path' }
  | { found: false; resolution?: 'override'; status: 'not_found' | 'not_executable' };

export interface ExplicitExecutableOverride {
  provided: boolean;
  value?: string;
}

async function canonicalExecutable(candidate: string): Promise<
  | { found: true; path: string }
  | { found: false; status: 'not_found' | 'not_executable' }
> {
  if (!isAbsolute(candidate)) return { found: false, status: 'not_executable' };
  try {
    const canonical = await realpath(candidate);
    const metadata = await stat(canonical);
    if (!metadata.isFile()) return { found: false, status: 'not_executable' };
    await access(canonical, constants.X_OK);
    return { found: true, path: canonical };
  } catch {
    try {
      await stat(candidate);
      return { found: false, status: 'not_executable' };
    } catch {
      return { found: false, status: 'not_found' };
    }
  }
}

export async function resolvePathExecutable(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ExecutableResolution> {
  for (const entry of (environment.PATH ?? '').split(delimiter)) {
    if (!entry || !isAbsolute(entry)) continue;
    const resolved = await canonicalExecutable(join(entry, name));
    if (resolved.found) return { ...resolved, resolution: 'path' };
  }
  return { found: false, status: 'not_found' };
}

export async function resolveClaudeExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  explicitOverride?: ExplicitExecutableOverride,
): Promise<ExecutableResolution> {
  const environmentProvidesOverride = Object.prototype.hasOwnProperty.call(
    environment,
    'CODEX_CLAUDE_MCP_CLAUDE_PATH',
  );
  const override = explicitOverride?.provided
    ? explicitOverride.value ?? ''
    : environmentProvidesOverride
      ? environment.CODEX_CLAUDE_MCP_CLAUDE_PATH ?? ''
      : undefined;
  if (override !== undefined) {
    const resolved = await canonicalExecutable(override);
    return resolved.found
      ? { ...resolved, resolution: 'override' }
      : { ...resolved, resolution: 'override' };
  }
  return resolvePathExecutable('claude', environment);
}
