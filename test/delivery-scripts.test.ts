import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, '..');

async function makePluginFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'claude-bridge-delivery-'));
  const plugin = join(root, 'plugin');
  await Promise.all([
    mkdir(join(plugin, '.codex-plugin'), { recursive: true }),
    mkdir(join(plugin, 'assets'), { recursive: true }),
    mkdir(join(plugin, 'dist'), { recursive: true }),
    mkdir(join(plugin, 'skills', 'claude-code-bridge'), { recursive: true }),
  ]);
  const files: Record<string, string> = {
    '.codex-plugin/plugin.json': `${JSON.stringify({
      name: 'codex-claude-mcp', version: '0.1.0', mcpServers: './.mcp.json', skills: './skills/',
      interface: {
        displayName: 'Claude Code Bridge', category: 'Developer Tools', brandColor: '#7C3AED',
        composerIcon: './assets/composer-icon.png', logo: './assets/logo.png', logoDark: './assets/logo-dark.png',
        privacyPolicyURL: 'https://github.com/Cyruskraad/codex-claude-mcp/blob/main/docs/PRIVACY.md',
      },
    })}\n`,
    '.mcp.json': `${JSON.stringify({ mcpServers: { 'claude-code-bridge': {
      command: 'node', args: ['./dist/server.mjs'], cwd: '.', env_vars: [
        'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_CLAUDE_MCP_CLAUDE_PATH',
        'CODEX_CLAUDE_MCP_STATE_DIR', 'HOME', 'PATH', 'XDG_STATE_HOME',
      ],
    } } })}\n`,
    'assets/composer-icon.png': 'composer',
    'assets/logo-dark.png': 'dark',
    'assets/logo.png': 'logo',
    'dist/runner.mjs': 'export {};\n',
    'dist/server.mjs': 'export {};\n',
    'skills/claude-code-bridge/SKILL.md': '---\nname: claude-code-bridge\n---\n',
    'LICENSE': 'MIT\n',
    'README.md': '# Plugin\n',
    'THIRD_PARTY_NOTICES.md': '# Notices\n',
  };
  await Promise.all(Object.entries(files).map(([path, content]) => writeFile(join(plugin, path), content)));
  return plugin;
}

describe('delivery scripts', () => {
  it('rejects broken relative links while accepting valid repository documentation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-bridge-docs-'));
    await writeFile(join(root, 'README.md'), '[missing](docs/MISSING.md)\n');

    await expect(execute(process.execPath, [
      join(repositoryRoot, 'scripts/validate-docs.mjs'), '--root', root,
    ])).rejects.toMatchObject({ code: 1 });

    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs', 'MISSING.md'), '# Present\n');
    const { stdout, stderr } = await execute(process.execPath, [
      join(repositoryRoot, 'scripts/validate-docs.mjs'), '--root', root,
    ]);
    expect(stdout).toBe('Documentation links valid (2 Markdown files).\n');
    expect(stderr).toBe('');
  });

  it('rejects documentation links that escape the repository root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-bridge-doc-escape-'));
    await writeFile(join(root, 'README.md'), '[outside](/etc/passwd)\n');
    await expect(execute(process.execPath, [
      join(repositoryRoot, 'scripts/validate-docs.mjs'), '--root', root,
    ])).rejects.toMatchObject({ code: 1 });
  });

  it('creates a deterministic plugin-root archive and excludes undeclared files', async () => {
    const plugin = await makePluginFixture();
    const output = join(plugin, '..', 'release');
    await writeFile(join(plugin, 'dist', 'server.mjs.map'), 'secret source map');

    const command = [
      join(repositoryRoot, 'scripts/package-release.mjs'),
      '--plugin-root', plugin,
      '--output-dir', output,
      '--skip-sbom',
    ];
    await execute(process.execPath, command);
    const first = await readFile(join(output, 'codex-claude-mcp-v0.1.0.zip.sha256'), 'utf8');
    await execute(process.execPath, command);
    const second = await readFile(join(output, 'codex-claude-mcp-v0.1.0.zip.sha256'), 'utf8');
    expect(second).toBe(first);

    const { stdout } = await execute('unzip', [
      '-Z1', join(output, 'codex-claude-mcp-v0.1.0.zip'),
    ]);
    const entries = stdout.trim().split('\n');
    expect(entries).toContain('codex-claude-mcp/dist/server.mjs');
    expect(entries).toContain('codex-claude-mcp/dist/runner.mjs');
    expect(entries).not.toContain('codex-claude-mcp/dist/server.mjs.map');
    expect(entries.every((entry) => entry.startsWith('codex-claude-mcp/'))).toBe(true);
  });

  it('validates the release contract and rejects source maps', async () => {
    const plugin = await makePluginFixture();
    const command = [
      join(repositoryRoot, 'scripts/validate-delivery.mjs'), '--plugin-root', plugin, '--skip-marketplace',
    ];
    const { stdout, stderr } = await execute(process.execPath, command);
    expect(stdout).toBe('Plugin delivery contract valid.\n');
    expect(stderr).toBe('');

    await writeFile(join(plugin, 'dist', 'runner.mjs.map'), 'map');
    await expect(execute(process.execPath, command)).rejects.toMatchObject({ code: 1 });
  });

  it('validates the shipped icon alpha and small-size readability', async () => {
    const { stdout, stderr } = await execute(process.execPath, [
      join(repositoryRoot, 'scripts/validate-assets.mjs'),
      '--assets', join(repositoryRoot, 'plugins/codex-claude-mcp/assets'),
    ]);
    expect(stdout).toBe('Plugin icon assets valid at 16, 32, and 128 px.\n');
    expect(stderr).toBe('');

    const root = await mkdtemp(join(tmpdir(), 'claude-bridge-bad-icon-'));
    await writeFile(join(root, 'logo.png'), 'not a png');
    await writeFile(join(root, 'logo-dark.png'), 'not a png');
    await writeFile(join(root, 'composer-icon.png'), 'not a png');
    await expect(execute(process.execPath, [
      join(repositoryRoot, 'scripts/validate-assets.mjs'), '--assets', root,
    ])).rejects.toMatchObject({ code: 1 });
  });

  it('reports secret locations without echoing secret values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-bridge-secret-scan-'));
    const secret = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
    await writeFile(join(root, 'unsafe.txt'), `credential=${secret}\n`);
    try {
      await execute(process.execPath, [join(repositoryRoot, 'scripts/scan-secrets.mjs'), '--root', root]);
      throw new Error('scan unexpectedly passed');
    } catch (error) {
      const failure = error as { code?: number; stderr?: string };
      expect(failure.code).toBe(1);
      expect(failure.stderr).toContain('unsafe.txt:1');
      expect(failure.stderr).not.toContain(secret);
    }
  });

  it('generates production-only dependency notices', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-bridge-notices-'));
    const output = join(root, 'THIRD_PARTY_NOTICES.md');
    await execute(process.execPath, [
      join(repositoryRoot, 'scripts/generate-notices.mjs'), '--output', output,
    ]);
    const notices = await readFile(output, 'utf8');
    expect(notices).toContain('@modelcontextprotocol/sdk 1.30.0');
    expect(notices).toContain('zod 3.25.76');
    expect(notices).not.toContain('vitest 3.2.7');
    expect(notices).not.toContain('@noodleseed/one');
  });

  it('accepts the packaged skill discovery contract', async () => {
    const { stdout, stderr } = await execute(process.execPath, [join(repositoryRoot, 'scripts/validate-skill.mjs')]);
    expect(stdout).toBe('Claude Code Bridge skill structure valid.\n');
    expect(stderr).toBe('');
  });
});
