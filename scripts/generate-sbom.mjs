#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
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

function sortSbom(sbom) {
  delete sbom.serialNumber;
  if (sbom.metadata) delete sbom.metadata.timestamp;
  sbom.components?.sort((left, right) => String(left['bom-ref']).localeCompare(String(right['bom-ref'])));
  sbom.dependencies?.sort((left, right) => String(left.ref).localeCompare(String(right.ref)));
  for (const dependency of sbom.dependencies ?? []) dependency.dependsOn?.sort();
  return sbom;
}

async function main() {
  const repositoryRoot = resolve(import.meta.dirname, '..');
  const outputDirectory = resolve(option('--output-dir', join(repositoryRoot, 'release')));
  await mkdir(outputDirectory, { recursive: true });
  const sbom = sortSbom(JSON.parse(await npmSbom(repositoryRoot)));
  const output = join(outputDirectory, 'codex-claude-mcp-v0.1.0.cdx.json');
  await writeFile(output, `${JSON.stringify(sbom, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`Created ${output}\n`);
}

await main();
