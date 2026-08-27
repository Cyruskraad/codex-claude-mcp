#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function npmSbom(cwd) {
  return new Promise((accept, reject) => {
    const child = spawn('npm', [
      'sbom', '--package-lock-only', '--omit=dev', '--sbom-format=cyclonedx', '--sbom-type=application',
    ], { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? accept(stdout) : reject(new Error(`npm sbom exited ${code}: ${stderr}`)));
  });
}

function repositoryUrl(repository) {
  const value = typeof repository === 'string' ? repository : repository?.url;
  return value?.replace(/^git\+/, '');
}

function normalizeRoot(sbom, packageJson) {
  const component = sbom.metadata?.component;
  if (!component) throw new Error('npm sbom did not emit a root metadata component');
  const oldReference = component['bom-ref'];
  const reference = `${packageJson.name}@${packageJson.version}`;
  component['bom-ref'] = reference;
  component.type = 'application';
  component.name = packageJson.name;
  component.version = packageJson.version;
  component.description = packageJson.description;
  component.purl = `pkg:npm/${packageJson.name}@${packageJson.version}`;
  component.licenses = [{ license: { id: packageJson.license } }];
  component.externalReferences = [
    { type: 'vcs', url: repositoryUrl(packageJson.repository) },
    { type: 'website', url: packageJson.homepage },
  ].filter((reference) => reference.url);
  for (const dependency of sbom.dependencies ?? []) {
    if (dependency.ref === oldReference) dependency.ref = reference;
    dependency.dependsOn = dependency.dependsOn?.map((item) => item === oldReference ? reference : item);
  }
  return sbom;
}

function sortComponent(component) {
  component.licenses?.sort((left, right) => {
    const a = left.license?.id ?? left.license?.name ?? left.expression ?? '';
    const b = right.license?.id ?? right.license?.name ?? right.expression ?? '';
    return a.localeCompare(b);
  });
  component.externalReferences?.sort((left, right) => (
    `${left.type}:${left.url}`.localeCompare(`${right.type}:${right.url}`)
  ));
}

function sortSbom(sbom) {
  delete sbom.serialNumber;
  if (sbom.metadata) delete sbom.metadata.timestamp;
  sbom.components?.sort((left, right) => String(left['bom-ref']).localeCompare(String(right['bom-ref'])));
  for (const component of [sbom.metadata?.component, ...(sbom.components ?? [])]) {
    if (component) sortComponent(component);
  }
  sbom.dependencies?.sort((left, right) => String(left.ref).localeCompare(String(right.ref)));
  for (const dependency of sbom.dependencies ?? []) dependency.dependsOn?.sort();
  return sbom;
}

async function main() {
  const repositoryRoot = resolve(option('--root', resolve(import.meta.dirname, '..')));
  const outputDirectory = resolve(option('--output-dir', join(repositoryRoot, 'release')));
  await mkdir(outputDirectory, { recursive: true });
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
  const sbom = sortSbom(normalizeRoot(JSON.parse(await npmSbom(repositoryRoot)), packageJson));
  const output = join(outputDirectory, 'codex-claude-mcp-v0.1.0.cdx.json');
  await writeFile(output, `${JSON.stringify(sbom, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`Created ${output}\n`);
}

await main();
