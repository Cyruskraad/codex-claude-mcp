import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
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
      name: 'codex-claude-mcp', version: '0.1.3', mcpServers: './.mcp.json', skills: './skills/',
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
  it('pins the build-tool graph to a safe resolved esbuild version', async () => {
    const { stdout, stderr } = await execute(process.execPath, [
      join(repositoryRoot, 'scripts/validate-dependencies.mjs'), '--root', repositoryRoot,
    ]);
    expect(stdout).toBe('Dependency resolutions satisfy the release security policy.\n');
    expect(stderr).toBe('');
  });

  it('rejects release artifact names that disagree with the package version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-bridge-release-version-'));
    await Promise.all([
      copyFile(join(repositoryRoot, 'package.json'), join(root, 'package.json')),
      copyFile(join(repositoryRoot, 'package-lock.json'), join(root, 'package-lock.json')),
      mkdir(join(root, '.github', 'workflows'), { recursive: true }),
    ]);
    const workflow = await readFile(join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    await writeFile(
      join(root, '.github', 'workflows', 'ci.yml'),
      workflow.replaceAll('codex-claude-mcp-v0.1.3', 'codex-claude-mcp-v9.9.9'),
    );

    await expect(execute(process.execPath, [
      join(repositoryRoot, 'scripts/validate-dependencies.mjs'), '--root', root,
    ])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('CI release artifact names must match package version 0.1.3.'),
    });
  });

  it('rejects an unreviewed GitHub Actions commit pin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-bridge-action-pins-'));
    await Promise.all([
      copyFile(join(repositoryRoot, 'package.json'), join(root, 'package.json')),
      copyFile(join(repositoryRoot, 'package-lock.json'), join(root, 'package-lock.json')),
      mkdir(join(root, '.github', 'workflows'), { recursive: true }),
    ]);
    const workflow = await readFile(join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    await writeFile(
      join(root, '.github', 'workflows', 'ci.yml'),
      workflow.replaceAll(
        'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
        'actions/setup-node@0000000000000000000000000000000000000000',
      ),
    );

    await expect(execute(process.execPath, [
      join(repositoryRoot, 'scripts/validate-dependencies.mjs'), '--root', root,
    ])).rejects.toMatchObject({ code: 1 });
  });

  it('rejects an unreviewed shorthand GitHub Action', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-bridge-action-shorthand-'));
    await Promise.all([
      copyFile(join(repositoryRoot, 'package.json'), join(root, 'package.json')),
      copyFile(join(repositoryRoot, 'package-lock.json'), join(root, 'package-lock.json')),
      mkdir(join(root, '.github', 'workflows'), { recursive: true }),
    ]);
    const workflow = await readFile(join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    await writeFile(
      join(root, '.github', 'workflows', 'ci.yml'),
      `${workflow}\n- uses: unreviewed/action@v1\n`,
    );

    await expect(execute(process.execPath, [
      join(repositoryRoot, 'scripts/validate-dependencies.mjs'), '--root', root,
    ])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('The CI workflow uses unreviewed action unreviewed/action.'),
    });
  });

  it('rejects an unreviewed action in a second workflow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-bridge-secondary-workflow-'));
    await Promise.all([
      copyFile(join(repositoryRoot, 'package.json'), join(root, 'package.json')),
      copyFile(join(repositoryRoot, 'package-lock.json'), join(root, 'package-lock.json')),
      mkdir(join(root, '.github', 'workflows'), { recursive: true }),
    ]);
    await Promise.all([
      copyFile(
        join(repositoryRoot, '.github', 'workflows', 'ci.yml'),
        join(root, '.github', 'workflows', 'ci.yml'),
      ),
      writeFile(
        join(root, '.github', 'workflows', 'secondary.yaml'),
        'jobs:\n  review:\n    steps:\n      - uses: unreviewed/action@v1\n',
      ),
    ]);

    await expect(execute(process.execPath, [
      join(repositoryRoot, 'scripts/validate-dependencies.mjs'), '--root', root,
    ])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('The CI workflow uses unreviewed action unreviewed/action.'),
    });
  });

  it('generates byte-identical SBOMs with stable root metadata from differently named roots', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'claude-bridge-sbom-'));
    const roots = [join(fixture, 'alpha-repository'), join(fixture, 'renamed-clean-clone')];
    const outputs = [join(fixture, 'first-output'), join(fixture, 'second-output')];
    for (const root of roots) {
      await mkdir(root, { recursive: true });
      await copyFile(join(repositoryRoot, 'package.json'), join(root, 'package.json'));
      await copyFile(join(repositoryRoot, 'package-lock.json'), join(root, 'package-lock.json'));
    }

    await Promise.all(roots.map((root, index) => execute(process.execPath, [
      join(repositoryRoot, 'scripts/generate-sbom.mjs'), '--root', root, '--output-dir', outputs[index],
    ])));
    const files = await Promise.all(outputs.map((output) => readFile(
      join(output, 'codex-claude-mcp-v0.1.3.cdx.json'), 'utf8',
    )));
    expect(files[1]).toBe(files[0]);

    const sbom = JSON.parse(files[0]) as {
      metadata: { component: {
        name: string; version: string; description: string;
        licenses: Array<{ license: { id: string } }>;
        externalReferences: Array<{ type: string; url: string }>;
      } };
    };
    expect(sbom.metadata.component).toMatchObject({
      name: 'codex-claude-mcp',
      version: '0.1.3',
      description: 'A local Codex MCP bridge for permission-aware Claude Code tasks.',
      licenses: [{ license: { id: 'MIT' } }],
      externalReferences: [
        { type: 'vcs', url: 'https://github.com/Cyruskraad/codex-claude-mcp.git' },
        { type: 'website', url: 'https://github.com/Cyruskraad/codex-claude-mcp#readme' },
      ],
    });
  }, 15_000);

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

  it('rejects documentation links that escape through a symlinked parent directory', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'claude-bridge-doc-parent-symlink-'));
    const root = join(fixture, 'repository');
    const outside = join(fixture, 'outside');
    await Promise.all([mkdir(join(root, 'docs'), { recursive: true }), mkdir(outside, { recursive: true })]);
    await writeFile(join(outside, 'target.md'), '# Outside\n');
    await symlink(outside, join(root, 'docs', 'escape'), 'dir');
    await writeFile(join(root, 'README.md'), '[outside](docs/escape/target.md)\n');

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
    const first = await readFile(join(output, 'codex-claude-mcp-v0.1.3.zip.sha256'), 'utf8');
    await execute(process.execPath, command);
    const second = await readFile(join(output, 'codex-claude-mcp-v0.1.3.zip.sha256'), 'utf8');
    expect(second).toBe(first);

    const { stdout } = await execute('unzip', [
      '-Z1', join(output, 'codex-claude-mcp-v0.1.3.zip'),
    ]);
    const entries = stdout.trim().split('\n');
    expect(entries).toContain('codex-claude-mcp/dist/server.mjs');
    expect(entries).toContain('codex-claude-mcp/dist/runner.mjs');
    expect(entries).not.toContain('codex-claude-mcp/dist/server.mjs.map');
    expect(entries.every((entry) => entry.startsWith('codex-claude-mcp/'))).toBe(true);
  });

  it('rejects a symlinked plugin root', async () => {
    const plugin = await makePluginFixture();
    const fixture = resolve(plugin, '..');
    const rootAlias = join(fixture, 'plugin-alias');
    await symlink(plugin, rootAlias, 'dir');
    await expect(execute(process.execPath, [
      join(repositoryRoot, 'scripts/package-release.mjs'),
      '--plugin-root', rootAlias,
      '--output-dir', join(fixture, 'root-alias-release'),
      '--skip-sbom',
    ])).rejects.toMatchObject({ code: 1 });
  });

  it('rejects a symlinked release-input parent directory', async () => {
    const plugin = await makePluginFixture();
    const fixture = resolve(plugin, '..');
    const outsideAssets = join(fixture, 'outside-assets');
    await rename(join(plugin, 'assets'), outsideAssets);
    await symlink(outsideAssets, join(plugin, 'assets'), 'dir');
    await expect(execute(process.execPath, [
      join(repositoryRoot, 'scripts/package-release.mjs'),
      '--plugin-root', plugin,
      '--output-dir', join(fixture, 'parent-alias-release'),
      '--skip-sbom',
    ])).rejects.toMatchObject({ code: 1 });
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

  it.each([
    ['Anthropic versioned key', ['sk', 'ant', 'api04', 'abcdefghijklmnopqrstuvwxyz123456'].join('-')],
    ['Anthropic opaque key', ['sk', 'ant', 'abcdefghijklmnopqrstuvwxyz123456'].join('-')],
    ['OpenAI project key', ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz123456'].join('-')],
    ['GitHub fine-grained token', `${['github', 'pat'].join('_')}_abcdefghijklmnopqrstuvwxyz1234567890`],
    ['GitHub OAuth token', `${['gho'].join('')}_abcdefghijklmnopqrstuvwxyz1234567890`],
  ])('detects a fake-format %s without echoing it', async (_label, secret) => {
    const root = await mkdtemp(join(tmpdir(), 'claude-bridge-secret-family-'));
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

  it('accepts short token-like documentation placeholders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-bridge-secret-benign-'));
    const placeholders = [
      ['sk', 'ant', 'api03', 'short'].join('-'),
      ['sk', 'proj', 'short'].join('-'),
      `${['github', 'pat'].join('_')}_short`,
      `${['gho'].join('')}_short`,
    ];
    await writeFile(join(root, 'safe.txt'), `${placeholders.join('\n')}\n`);
    const { stdout, stderr } = await execute(process.execPath, [
      join(repositoryRoot, 'scripts/scan-secrets.mjs'), '--root', root,
    ]);
    expect(stdout).toBe('Secret scan passed.\n');
    expect(stderr).toBe('');
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
