import { describe, expect, it } from 'vitest';
import { currentProcessIdentity, inspectProcessIdentity } from '../src/process-identity.js';

describe('OS process birth identity', () => {
  it('rejects invalid identifiers and inspects current and missing processes without throwing', async () => {
    expect(await inspectProcessIdentity(0)).toEqual({ state: 'unknown' });
    expect(await inspectProcessIdentity(Number.NaN)).toEqual({ state: 'unknown' });
    const current = await inspectProcessIdentity(process.pid);
    expect(['live', 'unknown']).toContain(current.state);
    const identity = await currentProcessIdentity(async () => ({ state: 'live', birthIdentity: 'test:birth' }));
    expect(identity).toBe('test:birth');
    expect(await currentProcessIdentity(async () => ({ state: 'dead' }))).toBeUndefined();
    const missing = await inspectProcessIdentity(2_000_000_000);
    expect(['dead', 'unknown']).toContain(missing.state);
  });
});
