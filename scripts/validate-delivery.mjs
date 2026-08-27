#!/usr/bin/env node
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

const VERSION = '0.1.0';
const EXPECTED_ASSETS = {
  composerIcon: './assets/composer-icon.png',
  logo: './assets/logo.png',
  logoDark: './assets/logo-dark.png',
};
const ALLOWED_ENVIRONMENT = new Set([
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_CLAUDE_MCP_CLAUDE_PATH',
  'CODEX_CLAUDE_MCP_STATE_DIR', 'HOME', 'PATH', 'XDG_STATE_HOME',
]);
const EXPECTED_ENVIRONMENT = [...ALLOWED_ENVIRONMENT].sort();

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertRegularFile(path, label) {
  const metadata = await lstat(path);
  assert(metadata.isFile() && !metadata.isSymbolicLink(), `${label} must be a regular file.`);
}

async function validatePlugin(pluginRoot) {
  const manifest = JSON.parse(await readFile(join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'));
  assert(manifest.name === 'codex-claude-mcp', 'Plugin name is invalid.');
  assert(manifest.version === VERSION, `Plugin version must remain ${VERSION}.`);
  assert(manifest.interface?.displayName === 'Claude Code Bridge', 'Plugin display name is invalid.');
  assert(manifest.interface?.category === 'Developer Tools', 'Plugin category must be Developer Tools.');
  assert(manifest.interface?.brandColor === '#7C3AED', 'Plugin brand color is invalid.');
  assert(manifest.mcpServers === './.mcp.json' && manifest.skills === './skills/', 'Plugin component paths are invalid.');
  assert(manifest.interface?.privacyPolicyURL === 'https://github.com/Cyruskraad/codex-claude-mcp/blob/main/docs/PRIVACY.md', 'Privacy URL is invalid.');
  assert(!Object.hasOwn(manifest.interface ?? {}, 'termsOfServiceURL'), 'Terms URL must be omitted.');
  for (const [key, path] of Object.entries(EXPECTED_ASSETS)) {
    assert(manifest.interface?.[key] === path, `Plugin ${key} path is invalid.`);
    await assertRegularFile(join(pluginRoot, path), `Plugin ${key}`);
  }

  const config = JSON.parse(await readFile(join(pluginRoot, '.mcp.json'), 'utf8'));
  const server = config.mcpServers?.['claude-code-bridge'];
  assert(server?.command === 'node', 'MCP command must be node.');
  assert(JSON.stringify(server?.args) === JSON.stringify(['./dist/server.mjs']), 'MCP arguments are invalid.');
  assert(server?.cwd === '.', 'MCP cwd must remain plugin-relative.');
  assert(Array.isArray(server?.env_vars), 'MCP env_vars must be an array.');
  assert(new Set(server.env_vars).size === server.env_vars.length, 'MCP env_vars must not contain duplicates.');
  assert(server.env_vars.every((name) => ALLOWED_ENVIRONMENT.has(name)), 'MCP env_vars contains an unsupported variable.');
  assert(JSON.stringify([...server.env_vars].sort()) === JSON.stringify(EXPECTED_ENVIRONMENT), 'MCP env_vars must match the documented minimal allowlist.');

  const distributionFiles = (await readdir(join(pluginRoot, 'dist'))).sort();
  assert(JSON.stringify(distributionFiles) === JSON.stringify(['runner.mjs', 'server.mjs']), 'Plugin dist must contain only runner.mjs and server.mjs.');
  for (const file of distributionFiles) await assertRegularFile(join(pluginRoot, 'dist', file), `Bundle ${file}`);
}

async function validateMarketplace(repositoryRoot) {
  const marketplace = JSON.parse(await readFile(join(repositoryRoot, '.agents/plugins/marketplace.json'), 'utf8'));
  assert(marketplace.name === 'codex-claude-bridge', 'Marketplace name must be codex-claude-bridge.');
  assert(marketplace.interface?.displayName === 'Claude Code Bridge Marketplace', 'Marketplace display name is invalid.');
  const entry = marketplace.plugins?.find((plugin) => plugin.name === 'codex-claude-mcp');
  assert(entry?.source?.source === 'local' && entry?.source?.path === './plugins/codex-claude-mcp', 'Marketplace source is invalid.');
  assert(entry?.category === 'Developer Tools', 'Marketplace category must be Developer Tools.');
  assert(entry?.policy?.installation === 'AVAILABLE' && entry?.policy?.authentication === 'ON_INSTALL', 'Marketplace policy is invalid.');
}

async function main() {
  const repositoryRoot = resolve(import.meta.dirname, '..');
  const pluginRoot = resolve(option('--plugin-root', join(repositoryRoot, 'plugins/codex-claude-mcp')));
  try {
    await validatePlugin(pluginRoot);
    if (!process.argv.includes('--skip-marketplace')) await validateMarketplace(repositoryRoot);
    process.stdout.write('Plugin delivery contract valid.\n');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Plugin delivery validation failed.'}\n`);
    process.exitCode = 1;
  }
}

await main();
