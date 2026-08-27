#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function compareVersions(left, right) {
  const a = left.split(/[.-]/).slice(0, 3).map(Number);
  const b = right.split(/[.-]/).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

async function main() {
  const root = resolve(option('--root', resolve(import.meta.dirname, '..')));
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const packages = packageLock.packages ?? {};
  const lockRoot = packages[''] ?? {};

  assert(packageJson.dependencies?.zod === '3.25.76', 'The root Zod dependency must remain pinned to 3.25.76.');
  assert(packageJson.devDependencies?.['@noodleseed/one'] === '0.142.1', 'Noodle Seed must remain pinned to 0.142.1.');
  assert(packageJson.devDependencies?.esbuild === '0.28.2', 'The direct esbuild build dependency must be pinned to 0.28.2.');
  assert(lockRoot.dependencies?.zod === '3.25.76', 'The lockfile root Zod dependency must remain pinned to 3.25.76.');
  assert(lockRoot.devDependencies?.['@noodleseed/one'] === '0.142.1', 'The lockfile Noodle Seed dependency must remain pinned to 0.142.1.');
  assert(lockRoot.devDependencies?.esbuild === '0.28.2', 'The lockfile esbuild dependency must remain pinned to 0.28.2.');
  assert(
    JSON.stringify(packageJson.overrides) === JSON.stringify({ tsup: { esbuild: '0.28.2' } }),
    'Only the reviewed tsup > esbuild 0.28.2 override is permitted.',
  );

  const esbuildEntries = Object.entries(packages).filter(([path]) => /(?:^|\/)node_modules\/esbuild$/.test(path));
  assert(esbuildEntries.length > 0, 'No resolved esbuild package was found.');
  for (const [path, entry] of esbuildEntries) {
    assert(compareVersions(entry.version, '0.28.1') >= 0, `${path} resolves unsafe esbuild ${entry.version}.`);
  }

  process.stdout.write('Dependency resolutions satisfy the release security policy.\n');
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
