#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

async function main() {
  const path = resolve(import.meta.dirname, '../plugins/codex-claude-mcp/skills/claude-code-bridge/SKILL.md');
  try {
    const content = await readFile(path, 'utf8');
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(content)?.[1];
    if (!frontmatter) throw new Error('Skill YAML frontmatter is missing.');
    const fields = Object.fromEntries(frontmatter.split('\n').map((line) => {
      const separator = line.indexOf(':');
      return separator === -1 ? [line, ''] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }));
    if (fields.name !== 'claude-code-bridge') throw new Error('Skill name must be claude-code-bridge.');
    if (!fields.description || !/Claude Code/i.test(fields.description) || !/(delegat|workspace|coding|repository)/i.test(fields.description)) {
      throw new Error('Skill description must provide an automatic Claude Code delegation trigger.');
    }
    const words = content.replace(/^---[\s\S]*?---/, '').trim().split(/\s+/).length;
    if (words > 800) throw new Error('Skill must remain concise (at most 800 words).');
    process.stdout.write('Claude Code Bridge skill structure valid.\n');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Skill validation failed.'}\n`);
    process.exitCode = 1;
  }
}

await main();
