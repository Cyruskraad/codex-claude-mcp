import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { platform } from 'node:os';

export type ProcessIdentity = { state: 'live'; birthIdentity: string } | { state: 'dead' | 'unknown' };
export type ProcessIdentityInspector = (pid: number) => Promise<ProcessIdentity>;

function macProcessStart(pid: number): Promise<ProcessIdentity> {
  return new Promise((resolve) => {
    let child;
    try { child = spawn('ps', ['-p', String(pid), '-o', 'lstart='], { shell: false, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
    catch { resolve({ state: 'unknown' }); return; }
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.once('error', () => resolve({ state: 'unknown' }));
    child.once('close', (code) => {
      const birthIdentity = stdout.trim();
      if (code === 0 && birthIdentity) resolve({ state: 'live', birthIdentity: `darwin:${birthIdentity}` });
      else if (code === 1) resolve({ state: 'dead' });
      else resolve({ state: 'unknown' });
    });
  });
}

export const inspectProcessIdentity: ProcessIdentityInspector = async (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'unknown' };
  if (platform() === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const closing = stat.lastIndexOf(')');
      const fields = closing >= 0 ? stat.slice(closing + 2).trim().split(/\s+/) : [];
      const startTicks = fields[19];
      return /^\d+$/.test(startTicks ?? '') ? { state: 'live', birthIdentity: `linux:${startTicks}` } : { state: 'unknown' };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'dead' } : { state: 'unknown' };
    }
  }
  if (platform() === 'darwin') return macProcessStart(pid);
  return { state: 'unknown' };
};

export async function currentProcessIdentity(inspector: ProcessIdentityInspector = inspectProcessIdentity): Promise<string | undefined> {
  const identity = await inspector(process.pid);
  return identity.state === 'live' ? identity.birthIdentity : undefined;
}
