#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const VERSION = '0.1.2';
const RELEASE_NAME = `codex-claude-mcp-v${VERSION}`;
const FIXED_TIME = new Date('1980-01-01T00:00:00.000Z');
const PACKAGE_FILES = [
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'assets/composer-icon.png',
  'assets/logo-dark.png',
  'assets/logo.png',
  'dist/runner.mjs',
  'dist/server.mjs',
  'skills/claude-code-bridge/SKILL.md',
].sort();

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function run(command, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { ...options, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => code === 0
      ? accept({ stdout, stderr })
      : reject(new Error(`${command} exited ${code}: ${stderr || stdout}`)));
  });
}

async function removeIfPresent(path) {
  try { await unlink(path); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function isContained(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`));
}

async function trustedPluginRoot(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Plugin root must be a real directory.');
  return realpath(path);
}

async function releaseInput(pluginRoot, path) {
  const expected = resolve(pluginRoot, path);
  const canonical = await realpath(expected);
  if (!isContained(pluginRoot, canonical) || canonical !== expected) {
    throw new Error(`Release input must remain inside the real plugin root: ${path}`);
  }
  const metadata = await lstat(expected);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Release input must be a regular file: ${path}`);
  return expected;
}

async function main() {
  const repositoryRoot = resolve(import.meta.dirname, '..');
  const pluginRoot = await trustedPluginRoot(resolve(option('--plugin-root', join(repositoryRoot, 'plugins/codex-claude-mcp'))));
  const outputDirectory = resolve(option('--output-dir', join(repositoryRoot, 'release')));
  const skipSbom = process.argv.includes('--skip-sbom');
  const inputs = new Map();
  for (const path of PACKAGE_FILES) inputs.set(path, await releaseInput(pluginRoot, path));
  const manifest = JSON.parse(await readFile(inputs.get('.codex-plugin/plugin.json'), 'utf8'));
  if (manifest.name !== 'codex-claude-mcp' || manifest.version !== VERSION) {
    throw new Error(`Plugin manifest must be codex-claude-mcp version ${VERSION}.`);
  }

  await mkdir(outputDirectory, { recursive: true });
  const archive = join(outputDirectory, `${RELEASE_NAME}.zip`);
  const checksum = `${archive}.sha256`;
  await Promise.all([removeIfPresent(archive), removeIfPresent(checksum)]);
  const staging = await mkdtemp(join(tmpdir(), 'codex-claude-release-'));
  try {
    const archiveRoot = join(staging, 'codex-claude-mcp');
    for (const path of PACKAGE_FILES) {
      const destination = join(archiveRoot, path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(inputs.get(path), destination);
      await chmod(destination, 0o644);
      await utimes(destination, FIXED_TIME, FIXED_TIME);
    }
    await run('zip', ['-X', '-q', '-9', archive, ...PACKAGE_FILES.map((path) => `codex-claude-mcp/${path}`)], {
      cwd: staging,
      env: { ...process.env, TZ: 'UTC' },
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(checksum, `${digest}  ${basename(archive)}\n`, { mode: 0o644 });
  if (!skipSbom) {
    await run(process.execPath, [join(repositoryRoot, 'scripts/generate-sbom.mjs'), '--output-dir', outputDirectory], {
      cwd: repositoryRoot,
      env: process.env,
    });
  }
  process.stdout.write(`Created ${archive}\nCreated ${checksum}\n`);
}

await main();
