# Contributing

Issues and focused pull requests are welcome. Please discuss large behavioral or security changes before investing in an implementation.

## Development setup

Use Node.js 20.19+ for the production runtime and Node.js 24 for the separate Noodle authoring checks.

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm run test:coverage
npm run validate:all
```

Follow RED–GREEN–REFACTOR for behavior changes. Use the fake Claude executable for automated tests; tests must not require credentials, network access, a paid model call, or a real Claude process. Preserve the stable error contract and add protocol-level coverage when a tool schema or result changes.

Security-sensitive changes should explicitly test path canonicalization, argument-array spawning, prompt secrecy, redaction, file modes, state transitions, process ownership, cancellation, and output bounds as applicable.

## Noodle boundary

Noodle Seed is an offline authoring/validation aid only. Do not link, deploy, change hosted configuration, add hosted credentials, or package generated Noodle corpora. Production remains the bundled local stdio server under `plugins/codex-claude-mcp/`.

## Pull requests

- Keep the public version at `0.1.0` unless the release owner asks for a version change.
- Update documentation and `CHANGELOG.md` for user-visible behavior.
- Do not commit secrets, prompts, raw authentication output, or private Claude results.
- Do not add permission-bypass flags, Chrome, nested MCP, shell execution, or implicit latest-session continuation.
- Confirm the release archive is deterministic and contains only the declared plugin files.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
