# Codex Claude MCP

Local-only Codex plugin scaffolding for a permission-aware Claude Code MCP bridge.

The bundled runtime will be built from `src/server.ts` and `src/runner.ts` into
`plugins/codex-claude-mcp/dist/`. Noodle Seed metadata remains only for offline
authoring validation; this project does not link or deploy a hosted runtime.

## Run locally (no account or login)

```sh
noodle dev
```

`noodle dev` starts the local MCP server and hot-reloads on save. Use `noodle devtools` for a
local widget preview and `noodle check` for readiness findings.

## Widget authoring

This is a comprehensive production starter rather than a minimal demo. It ships model-visible and app-only
tools, a resource, prompt, caller-scoped state contract, branded widget, handoff policy, and an embedded
assistant configured through managed variables and a managed secret reference. The widget itself keeps one
purpose and one primary action, with safe prefilling and explicit loading, empty, error, retry, and success states.

- `tool(..., { view })` links the model-visible tool to the React view.
- `tool(..., { visibility: ['app'] })` powers the widget's explicit save action.
- `view.component` links the tool to a React view in `src/views/`.
- `useLayout()` adapts to MCP Apps host context without requiring a host-specific global.
- Keep inline widgets to one primary action and at most one subordinate action; use progressive disclosure
  instead of nested navigation or scrolling.
- Optional host extensions should always be feature-detected and must not be required for baseline use.
- `agent:check:assistant` validates the embedded assistant metadata; configure its managed model values
  before deployment instead of putting credentials in source.
- The assistant's safe `presentation` primitives live in `server.ts`; customize the panel, launcher,
  status header, composer, and message treatment without editing the embed package. The Atlas-style product
  treatment is the supported ceiling.

## Deploy (requires a Noodle Seed account)

```sh
noodle login
noodle deploy --org <org> --app laptop-management-tasks
```

The generated project is fully usable locally before login. Authentication is only required when you
choose to deploy it. Replace the placeholder domain before public distribution. Configure
`ASSISTANT_MODEL_BASE_URL` and `ASSISTANT_MODEL` with `noodle variables set`, and
`ASSISTANT_MODEL_API_KEY` with `noodle secrets set`; those values belong to the Noodle deployment,
not the embedding SaaS environment.

## Embedded assistant

The local MCP author loop above needs no account. A browser embed additionally needs an active deployment
before it can create a deployment-bound backend client:

1. Replace `assistant.allowedOrigins` with exact HTTPS origins. For local browser testing, serve the
   embedding SaaS over framework-supported HTTPS and use an origin such as `https://localhost:3000`;
   `http://localhost`, paths, trailing slashes, and wildcards are invalid.
2. Run `noodle validate --json` and `noodle check --target embedded-assistant --json`, then deploy
   with `noodle deploy`.
3. Run `noodle assistant clients create --name web --org <org> --app laptop-management-tasks --env prod`.
4. Install `@noodleseed/assistant` in the customer web application with its existing package manager.
5. Keep only `NOODLE_SERVICE_URL`, `NOODLE_ASSISTANT_CLIENT_ID`, and
   `NOODLE_ASSISTANT_CLIENT_SECRET` in the authenticated SaaS backend. Never use public/browser-prefixed
   variables for the secret. The backend exchanges its verified user through
   `@noodleseed/assistant/server`; the browser mounts the package root or `/react` export.

Run `noodle commands --json` before scripting flags. The installed Noodle Agent Kit contains the complete
`references/embedded-assistant.md` workflow.

## Agent setup

`noodle init` generated project-local Codex and Claude Code instructions. Commit those files with
`noodle.json`, and refresh them after CLI upgrades with `noodle agents setup --write`.


## Customer identity and delegated APIs

The default server uses standards-based federated OIDC so the same MCP endpoint works from remote MCP clients
and the embedded assistant. Your application team owns the authorization server; Noodle verifies its tokens
but does not add OAuth discovery or registration endpoints in front of it.

For every direct or federated issuer, publish all of the following:

- The path-inserted RFC 8414 metadata URL as direct, unauthenticated HTTP 200 JSON. For issuer
  `https://id.example.com/oauth`, that URL is
  `https://id.example.com/.well-known/oauth-authorization-server/oauth`.
- HTTPS `authorization_endpoint`, `token_endpoint`, `jwks_uri`, and RFC 7591
  `registration_endpoint` values in that metadata.
- Authorization code and refresh-token grants, PKCE `S256`, and public clients by advertising
  `code_challenge_methods_supported: ["S256"]` and
  `token_endpoint_auth_methods_supported: ["none"]`.
- RFC 8707 `resource` handling: validate the exact URL on authorize, code exchange, and refresh, then
  map each approved MCP resource to the stable app/environment audience configured in `customerAuth`.
- A public JWKS containing only public signing keys.

Run `noodle auth doctor src/server.ts` before sharing the endpoint. The doctor is read-only: it verifies
discovery, metadata, capabilities, and JWKS without registering a client.

Verified OIDC callers are classified as customers by the runtime; never add a caller-controlled identity
classification claim. For a customer-owned API, declare connector auth as `delegatedTokenExchange` and
store its client credential with `noodle secrets set`. Use `noodle auth doctor --live` before release to
exercise one credential exchange without invoking a business tool.
