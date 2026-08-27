import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { ClaudeHealth } from './protocol.js';

const MINIMUM_VERSION = [2, 1, 0] as const;
const MINIMUM_VERSION_TEXT = '2.1.0' as const;
const MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'] as const;
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

type ProbeResult = { code: number | null; timedOut: boolean; outputLimited: boolean; output: string };
type FeatureSet = ClaudeHealth['features'];

export interface ClaudeHealthOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  now?: () => Date;
  bridgeCounts?: () => Promise<{ runningJobs: number; queuedJobs: number }>;
  timeouts?: { version?: number; help?: number; auth?: number; killGrace?: number };
}

const emptyFeatures = (): FeatureSet => ({
  print: false, stream_json: false, verbose: false, max_turns: false, no_chrome: false,
  inspect_tools: false, plan_permission: false, model: false, effort: false, explicit_resume: false,
  cloud_sessions: false, mcp_config: false, strict_mcp_config: false, disable_nested_mcp: false,
});

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try { process.kill(-pid, signal); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return true;
    return false;
  }
}

async function runProbe(
  executable: string,
  args: string[],
  timeoutMilliseconds: number,
  outputLimitBytes: number,
  killGraceMilliseconds: number,
  environment: NodeJS.ProcessEnv,
): Promise<ProbeResult> {
  return new Promise((resolveProbe) => {
    let child;
    try {
      child = spawn(executable, args, {
        detached: true, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: environment,
      });
    } catch {
      resolveProbe({ code: null, timedOut: false, outputLimited: false, output: '' });
      return;
    }
    let settled = false;
    let stopping = false;
    let timedOut = false;
    let outputLimited = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let forceTimer: NodeJS.Timeout | undefined;
    const stop = (reason: 'timeout' | 'output') => {
      if (stopping || !child.pid) return;
      stopping = true;
      timedOut = reason === 'timeout';
      outputLimited = reason === 'output';
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (!signalGroup(child.pid, 'SIGTERM')) child.kill('SIGTERM');
      forceTimer = setTimeout(() => {
        if (child.pid && !signalGroup(child.pid, 'SIGKILL')) child.kill('SIGKILL');
      }, killGraceMilliseconds);
      forceTimer.unref();
    };
    const timeout = setTimeout(() => stop('timeout'), timeoutMilliseconds);
    timeout.unref();
    const capture = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > outputLimitBytes) { stop('output'); return; }
      chunks.push(Buffer.from(chunk));
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); if (forceTimer) clearTimeout(forceTimer);
      resolveProbe({ code: null, timedOut, outputLimited, output: '' });
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); if (forceTimer) clearTimeout(forceTimer);
      const output = Buffer.concat(chunks, Math.min(bytes, outputLimitBytes)).toString('utf8');
      resolveProbe({ code, timedOut, outputLimited, output });
    });
  });
}

async function executableFile(candidate: string): Promise<string | undefined> {
  try {
    const canonical = await realpath(candidate);
    const metadata = await stat(canonical);
    if (!metadata.isFile()) return undefined;
    await access(canonical, constants.X_OK);
    return canonical;
  } catch { return undefined; }
}

type Discovery =
  | { found: true; path: string; resolution: 'override' | 'path' }
  | { found: false; resolution?: 'override'; status: 'not_found' | 'not_executable' };

async function discoverClaude(environment: NodeJS.ProcessEnv): Promise<Discovery> {
  const hasOverride = Object.prototype.hasOwnProperty.call(environment, 'CODEX_CLAUDE_MCP_CLAUDE_PATH');
  if (hasOverride) {
    const supplied = environment.CODEX_CLAUDE_MCP_CLAUDE_PATH ?? '';
    if (!isAbsolute(supplied)) return { found: false, resolution: 'override', status: 'not_executable' };
    const canonical = await executableFile(supplied);
    if (canonical) return { found: true, path: canonical, resolution: 'override' };
    try { await stat(supplied); return { found: false, resolution: 'override', status: 'not_executable' }; }
    catch { return { found: false, resolution: 'override', status: 'not_found' }; }
  }
  for (const entry of (environment.PATH ?? '').split(delimiter)) {
    if (!entry || !isAbsolute(entry)) continue;
    const canonical = await executableFile(join(entry, 'claude'));
    if (canonical) return { found: true, path: canonical, resolution: 'path' };
  }
  return { found: false, status: 'not_found' };
}

function displayPath(path: string, homeDirectory: string): string {
  const prefix = homeDirectory.endsWith('/') ? homeDirectory : `${homeDirectory}/`;
  return path === homeDirectory ? '~' : path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
}

function parseVersion(output: string): { version?: string; status: 'supported' | 'too_old' | 'malformed' } {
  const match = output.trim().match(/^(?:Claude Code\s+)?v?(\d+)\.(\d+)\.(\d+)(?:\s+\(Claude Code\))?$/);
  if (!match) return { status: 'malformed' };
  const parts = match.slice(1).map(Number);
  const version = parts.join('.');
  for (let index = 0; index < MINIMUM_VERSION.length; index += 1) {
    if (parts[index] > MINIMUM_VERSION[index]) return { version, status: 'supported' };
    if (parts[index] < MINIMUM_VERSION[index]) return { version, status: 'too_old' };
  }
  return { version, status: 'supported' };
}

function includesFlag(help: string, flag: string): boolean {
  return new RegExp(`(?:^|[\\s,])${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s,=])`, 'm').test(help);
}

function parseFeatures(help: string): FeatureSet {
  const inputStream = includesFlag(help, '--input-format') && /--input-format[^\n]*stream-json/.test(help);
  const outputStream = includesFlag(help, '--output-format') && /--output-format[^\n]*stream-json/.test(help);
  return {
    print: includesFlag(help, '-p') || includesFlag(help, '--print'),
    stream_json: inputStream && outputStream,
    verbose: includesFlag(help, '--verbose'),
    max_turns: includesFlag(help, '--max-turns'),
    no_chrome: includesFlag(help, '--no-chrome'),
    inspect_tools: includesFlag(help, '--tools'),
    plan_permission: includesFlag(help, '--permission-mode'),
    model: includesFlag(help, '--model'),
    effort: includesFlag(help, '--effort'),
    explicit_resume: includesFlag(help, '--resume'),
    cloud_sessions: includesFlag(help, '--cloud') && includesFlag(help, '--name'),
    mcp_config: includesFlag(help, '--mcp-config'),
    strict_mcp_config: includesFlag(help, '--strict-mcp-config'),
    disable_nested_mcp: includesFlag(help, '--disallowedTools'),
  };
}

function authStatus(probe: ProbeResult): ClaudeHealth['authentication'] {
  if (probe.timedOut || probe.outputLimited) return { status: 'timeout', ready: false };
  if (probe.code === 0) return { status: 'ready', ready: true };
  const lowered = probe.output.toLowerCase();
  if (/expired|log in again/.test(lowered)) return { status: 'expired', ready: false };
  if (probe.code === 1 || /not logged in|unauthenticated|login required|sign in/.test(lowered)) {
    return { status: 'not_ready', ready: false };
  }
  return { status: 'unknown', ready: false };
}

export async function probeClaudeHealth(options: ClaudeHealthOptions = {}): Promise<ClaudeHealth> {
  const environment = options.environment ?? process.env;
  const now = options.now ?? (() => new Date());
  const counts = await (options.bridgeCounts ?? (async () => ({ runningJobs: 0, queuedJobs: 0 })))();
  const base = {
    checked_at: now().toISOString(), minimum_cli_version: MINIMUM_VERSION_TEXT,
    model_aliases: [...MODEL_ALIASES] as ClaudeHealth['model_aliases'],
    supported_effort_levels: [...EFFORT_LEVELS] as ClaudeHealth['supported_effort_levels'],
    bridge: { running_jobs: counts.runningJobs, queued_jobs: counts.queuedJobs, concurrency_limit: 2 as const },
  };
  const discovery = await discoverClaude(environment);
  if (!discovery.found) {
    const issue = discovery.status === 'not_found' ? 'cli_not_found' as const : 'cli_not_executable' as const;
    return {
      ...base, status: 'unavailable',
      cli: { found: false, ...(discovery.resolution ? { resolution: discovery.resolution } : {}), version_status: discovery.status },
      features: emptyFeatures(), authentication: { status: 'not_checked', ready: false }, issues: [issue],
    };
  }

  const timeouts = options.timeouts ?? {};
  const grace = timeouts.killGrace ?? 100;
  const versionProbe = await runProbe(discovery.path, ['--version'], timeouts.version ?? 2_000, 4_096, grace, environment);
  const issues: ClaudeHealth['issues'] = [];
  let version: string | undefined;
  let versionStatus: ClaudeHealth['cli']['version_status'];
  if (versionProbe.timedOut || versionProbe.outputLimited) {
    versionStatus = 'timeout'; issues.push('probe_timeout');
  } else {
    const parsed = parseVersion(versionProbe.output);
    version = parsed.version; versionStatus = parsed.status;
    if (parsed.status === 'too_old') issues.push('version_too_old');
    if (parsed.status === 'malformed') issues.push('version_malformed');
  }

  let features = emptyFeatures();
  let authentication: ClaudeHealth['authentication'] = { status: 'not_checked', ready: false };
  if (versionStatus === 'supported') {
    const helpProbe = await runProbe(discovery.path, ['--help'], timeouts.help ?? 3_000, 65_536, grace, environment);
    if (helpProbe.timedOut || helpProbe.outputLimited) issues.push('probe_timeout');
    else {
      features = parseFeatures(helpProbe.output);
      if (Object.values(features).some((supported) => !supported)) issues.push('required_feature_missing');
    }
    const authProbe = await runProbe(discovery.path, ['auth', 'status'], timeouts.auth ?? 3_000, 16_384, grace, environment);
    authentication = authStatus(authProbe);
    if (authentication.status === 'timeout') issues.push('probe_timeout');
    else if (authentication.status === 'not_ready') issues.push('authentication_not_ready');
    else if (authentication.status === 'expired') issues.push('authentication_expired');
    else if (authentication.status === 'unknown') issues.push('authentication_unknown');
  }
  const uniqueIssues = [...new Set(issues)];
  const suppliedHome = options.homeDirectory ?? homedir();
  let canonicalHome = suppliedHome;
  try { canonicalHome = await realpath(suppliedHome); } catch { /* display-only fallback */ }
  return {
    ...base,
    status: uniqueIssues.length === 0 && authentication.ready ? 'ready' : 'degraded',
    cli: {
      found: true, path: displayPath(discovery.path, canonicalHome),
      resolution: discovery.resolution, ...(version ? { version } : {}), version_status: versionStatus,
    },
    features, authentication, issues: uniqueIssues,
  };
}
