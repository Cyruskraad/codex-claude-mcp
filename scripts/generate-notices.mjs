#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import process from 'node:process';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function repositoryUrl(repository) {
  if (typeof repository === 'string') return repository;
  return repository?.url ?? '';
}

async function licenseText(directory, declaredLicense) {
  const names = await readdir(directory);
  const candidate = names.sort().find((name) => /^(?:licen[sc]e|copying)(?:\.|$)/i.test(name));
  if (!candidate) return `No license file was included in the installed package. Declared SPDX expression: ${declaredLicense || 'unknown'}.`;
  return (await readFile(join(directory, candidate), 'utf8'))
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

async function main() {
  const repositoryRoot = resolve(import.meta.dirname, '..');
  const output = resolve(option('--output', join(repositoryRoot, 'plugins/codex-claude-mcp/THIRD_PARTY_NOTICES.md')));
  const lock = JSON.parse(await readFile(join(repositoryRoot, 'package-lock.json'), 'utf8'));
  const modulesRoot = resolve(repositoryRoot, 'node_modules');
  const dependencyMap = new Map();
  for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
    if (!path || metadata.dev === true || !path.includes('node_modules/')) continue;
    const directory = resolve(repositoryRoot, path);
    if (!directory.startsWith(`${modulesRoot}${sep}`)) continue;
    let packageMetadata;
    try { packageMetadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); } catch { continue; }
    const name = packageMetadata.name;
    const version = packageMetadata.version;
    if (!name || !version) continue;
    const dependency = {
      name,
      version,
      license: packageMetadata.license ?? metadata.license ?? 'unknown',
      repository: repositoryUrl(packageMetadata.repository),
      text: await licenseText(directory, packageMetadata.license ?? metadata.license),
    };
    dependencyMap.set(`${name}@${version}`, dependency);
  }
  const dependencies = [...dependencyMap.values()];
  dependencies.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));

  const groups = new Map();
  for (const dependency of dependencies) {
    const key = createHash('sha256').update(dependency.text).digest('hex');
    const group = groups.get(key) ?? { packages: [], text: dependency.text };
    group.packages.push(`${dependency.name} ${dependency.version}`);
    groups.set(key, group);
  }

  const lines = [
    '# Third-party notices',
    '',
    'Claude Code Bridge bundles the following production dependencies. This inventory is generated from `package-lock.json` and the installed production package metadata. The licenses below apply to their respective packages, not to Claude Code Bridge as a whole.',
    '',
    '## Inventory',
    '',
    '| Package | Version | License | Source |',
    '| --- | --- | --- | --- |',
    ...dependencies.map((dependency) => `| ${dependency.name.replaceAll('|', '\\|')} | ${dependency.version} | ${String(dependency.license).replaceAll('|', '\\|')} | ${dependency.repository || 'package registry metadata'} |`),
    '',
    '## License texts',
    '',
  ];
  for (const group of [...groups.values()].sort((left, right) => left.packages[0].localeCompare(right.packages[0]))) {
    lines.push(`### ${group.packages.join(', ')}`, '', '```text', group.text.replaceAll('```', '``` '), '```', '');
  }
  await writeFile(output, `${lines.join('\n').trimEnd()}\n`, { mode: 0o644 });
  process.stdout.write(`Created ${output} (${dependencies.length} production packages).\n`);
}

await main();
