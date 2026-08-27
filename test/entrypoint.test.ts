import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isCanonicalEntrypoint } from '../src/entrypoint.js';

describe('canonical executable entrypoint detection', () => {
  it('matches an invoked symlink alias to the physical module file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-claude-entrypoint-'));
    const physical = join(root, 'physical');
    const alias = join(root, 'alias');
    await mkdir(physical);
    await symlink(physical, alias, 'dir');
    const physicalModule = join(physical, 'server.mjs');
    await writeFile(physicalModule, '');

    expect(isCanonicalEntrypoint(pathToFileURL(physicalModule).href, join(alias, 'server.mjs'))).toBe(true);
  });

  it('returns false without leaking or throwing for missing and malformed paths', () => {
    expect(isCanonicalEntrypoint('not a valid module URL', '/private/nonexistent/secret-entrypoint')).toBe(false);
    expect(isCanonicalEntrypoint(pathToFileURL('/private/nonexistent/module.mjs').href, undefined)).toBe(false);
  });
});
