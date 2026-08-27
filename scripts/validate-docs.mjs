#!/usr/bin/env node
import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';

const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.agents', '.claude', '.superpowers', 'coverage', 'dist', 'node_modules', 'release',
]);

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function markdownFiles(root, directory = root) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) results.push(...await markdownFiles(root, join(directory, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(join(directory, entry.name));
    }
  }
  return results;
}

function localTargets(markdown) {
  const targets = [];
  for (const match of markdown.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) {
    const target = match[1];
    if (!target || target.startsWith('#') || target.startsWith('<') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    targets.push(decodeURIComponent(target.split('#', 1)[0]));
  }
  return targets.filter(Boolean);
}

async function main() {
  const root = resolve(option('--root', process.cwd()));
  const files = (await markdownFiles(root)).sort();
  const failures = [];
  for (const file of files) {
    const markdown = await readFile(file, 'utf8');
    for (const target of localTargets(markdown)) {
      const candidate = isAbsolute(target) ? target : resolve(dirname(file), target);
      const fromRoot = relative(root, candidate);
      if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
        failures.push(`${file}: link escapes documentation root: ${target}`);
        continue;
      }
      try {
        const metadata = await lstat(candidate);
        if (metadata.isSymbolicLink()) failures.push(`${file}: symlink target is not allowed: ${target}`);
      } catch {
        failures.push(`${file}: missing link target: ${target}`);
      }
    }
  }
  if (failures.length > 0) {
    process.stderr.write(`${failures.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Documentation links valid (${files.length} Markdown files).\n`);
}

await main();
