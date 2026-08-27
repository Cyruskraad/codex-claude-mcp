#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
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
  const workflowDirectory = join(root, '.github', 'workflows');
  const workflowEntries = (await readdir(workflowDirectory, { withFileTypes: true }))
    .filter((entry) => /\.ya?ml$/u.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  assert(workflowEntries.length > 0, 'No GitHub Actions workflows were found.');
  for (const entry of workflowEntries) {
    assert(entry.isFile(), `The GitHub Actions workflow ${entry.name} must be a regular file.`);
  }
  const workflows = await Promise.all(workflowEntries.map((entry) => (
    readFile(join(workflowDirectory, entry.name), 'utf8')
  )));
  const packages = packageLock.packages ?? {};
  const lockRoot = packages[''] ?? {};

  const reviewedActionPins = new Map([
    ['actions/checkout', '11bd71901bbe5b1630ceea73d27597364c9af683'],
    ['actions/setup-node', '49933ea5288caeca8642d1e84afbd3f7d6820020'],
    ['actions/upload-artifact', 'ea165f8d65b6e75b540449e92b4886f43607fa02'],
    ['gitleaks/gitleaks-action', 'ff98106e4c7b2bc287b24eaf42907196329070c7'],
  ]);
  const observedActions = new Set();
  for (const workflow of workflows) {
    for (const match of workflow.matchAll(/^\s*(?:-\s*)?uses:\s*([^@\s]+)@([^\s#]+)/gmu)) {
      const [, action, pin] = match;
      const expectedPin = reviewedActionPins.get(action);
      assert(expectedPin !== undefined, `The CI workflow uses unreviewed action ${action}.`);
      assert(pin === expectedPin, `The CI workflow uses an unreviewed commit for ${action}.`);
      observedActions.add(action);
    }
  }
  for (const action of reviewedActionPins.keys()) {
    assert(observedActions.has(action), `The CI workflow is missing reviewed action ${action}.`);
  }

  const expectedReleaseName = `codex-claude-mcp-v${packageJson.version}`;
  const observedReleaseNames = workflows.flatMap((workflow) => (
    [...workflow.matchAll(/codex-claude-mcp-v\d+\.\d+\.\d+/gu)].map(([name]) => name)
  ));
  assert(observedReleaseNames.length > 0, 'The CI workflow is missing release artifact names.');
  assert(
    observedReleaseNames.every((name) => name === expectedReleaseName),
    `CI release artifact names must match package version ${packageJson.version}.`,
  );

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
