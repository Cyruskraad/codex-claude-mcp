# Task 5 supply-chain follow-up report

## Outcome

Completed the narrow release-review follow-up without authentication, publication, a real Claude invocation, hosted Noodle work, or broad dependency overrides.

- Added public package identity metadata for `codex-claude-mcp` `0.1.0`: MIT license, author, repository, and homepage.
- Made CycloneDX generation independent of the checkout directory name by normalizing the root component from `package.json`, remapping its dependency reference, removing volatile fields, and sorting licenses, external references, components, and dependency edges.
- Added a regression that generates from differently named repository roots and asserts byte-identical SBOMs plus the stable `codex-claude-mcp` `0.1.0` MIT identity.
- Pinned direct `esbuild` and the narrowly scoped `tsup > esbuild` override to `0.28.2`; no root/global override or Zod override exists. A clean install resolves the complete esbuild graph to `0.28.2`.
- Added a release validator for the exact reviewed override shape, Noodle `0.142.1`, root Zod `3.25.76`, and every resolved esbuild version.
- Tried the requested five overrides only under `@noodleseed/one`. npm accepted the syntax but could not replace the package's bundled dependencies, so the ineffective overrides were removed rather than broadened or forced.
- Made the production audit a blocking CI gate and retained the full authoring audit as an explicitly named, visible nonblocking diagnostic. `SECURITY.md` and `CONTRIBUTING.md` document why the pinned Noodle-only findings are not shipped in the plugin.

## TDD and compatibility evidence

The delivery regression test was first observed RED for the missing dependency validator and cwd-derived SBOM root name/missing license and references. Final focused delivery result is **10/10 passed**.

After a clean `npm ci`, `npm ls esbuild` reports root `0.28.2` and deduplicated `0.28.2` consumers under tsup, bundle-require, and Vite. The first unprivileged protocol run failed because the macOS sandbox denied process-identity inspection; tracing the suppressed startup exception identified `Current process identity could not be verified`. With the same process-inspection permission required by the pre-existing lifecycle tests, the esbuild `0.28.2` bundle passed:

- standalone/built protocol suite: **26/26**;
- full suite with coverage: **202/202** across 19 files;
- statements/lines: **95.06%**;
- functions: **92.85%**;
- branches: **86.35%**.

Type checking, linting, `npm ls`, both bundle syntax checks, delivery validation, asset validation, docs validation, skill validation, secret scanning, generated-notices diff, Plugin Creator validation, and Skill Creator validation all passed.

## Audit and Noodle evidence

- Online `npm audit --omit=dev --json`: **0 production findings** (blocking release gate).
- Online full `npm audit --json`: **6 development findings**, consisting only of the `@noodleseed/one` aggregate and its bundled `@hono/node-server`, DOMPurify, fast-uri, Hono, and undici packages.
- Offline full and production audits: zero cached findings; the online result above is authoritative for the current registry advisory set.
- Exact Node `24.20.0` Noodle validation: `{"ok":true,"data":{}}`.
- Exact Node `24.20.0` Noodle smoke: modern protocol `2026-07-28`, tool `authoring_status`.

## Release reproducibility

Two consecutive package runs produced identical bytes:

- ZIP SHA-256: `aaa898871680572c13c438896d11512828afb7a5776cf1cdc92fb8e250e09d7a`;
- SBOM SHA-256: `15d1846ea1a3449a288620c29cd1fe97db9c6df73548a3b91d7fb9c8a1d6b9ce`.

The checksum verifier and `unzip -t` passed. The final SBOM root is `codex-claude-mcp` `0.1.0`, MIT, with stable VCS/homepage references. A fresh extracted-ZIP stdio smoke initialized server `codex-claude-mcp` `0.1.0` and discovered exactly the seven declared Claude bridge tools.
