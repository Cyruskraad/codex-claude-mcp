#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve, join } from 'node:path';
import process from 'node:process';

const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.agents', '.claude', '.superpowers', 'coverage', 'node_modules', 'release',
]);
const BINARY_EXTENSIONS = new Set(['.png', '.zip']);
const PATTERNS = [
  ['Anthropic API key', new RegExp(['sk', 'ant', '(?:api03)?', '[A-Za-z0-9_-]{20,}'].join('-'))],
  ['OpenAI API key', new RegExp(['sk', '[A-Za-z0-9]{20,}'].join('-'))],
  ['GitHub token', new RegExp(['ghp', '[A-Za-z0-9]{30,}'].join('_'))],
  ['private key', new RegExp(['BEGIN ', '(?:RSA |EC |OPENSSH )?', 'PRIVATE KEY'].join(''))],
];

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) result.push(...await files(join(directory, entry.name)));
    } else if (entry.isFile() && ![...BINARY_EXTENSIONS].some((extension) => entry.name.endsWith(extension))) {
      result.push(join(directory, entry.name));
    }
  }
  return result;
}

async function main() {
  const root = resolve(option('--root', process.cwd()));
  const findings = [];
  for (const file of (await files(root)).sort()) {
    let content;
    try { content = await readFile(file, 'utf8'); } catch { continue; }
    for (const [label, pattern] of PATTERNS) {
      const match = pattern.exec(content);
      if (!match) continue;
      const line = content.slice(0, match.index).split('\n').length;
      findings.push(`${relative(root, file)}:${line}: possible ${label}`);
    }
  }
  if (findings.length > 0) {
    process.stderr.write(`${findings.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('Secret scan passed.\n');
}

await main();
