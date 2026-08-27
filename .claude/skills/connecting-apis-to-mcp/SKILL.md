---
name: connecting-apis-to-mcp
description: "Use when credentials, an API URL, an OpenAPI document, or an observed response must become real Noodle Seed MCP behavior."
---

<!-- noodle-skill version:0.58.0 hash:1e86b8704f407bd3 -->

# connecting-apis-to-mcp

Connect a real API using managed credentials and mappings proven against observed output.

## Use when

- Connect this OpenAPI URL to MCP.
- Use these API credentials for a real connector.

## Do not use when

- Do not use for static local behavior.
- Do not use when credentials or a representative safe read are unavailable.

## Required inputs

- API base URL and authentication scheme.
- Representative safe read.
- User intent and observed response shape.

## Workflow

Read and follow the canonical playbook `references/connect-an-api.md` at `../noodle-seed/references/connect-an-api.md`. It owns the workflow; do not recreate it here or load the command catalog speculatively.
Load `references/authoring-workflow.md` at `../noodle-seed/references/authoring-workflow.md` only when the playbook or observed evidence names that concern.

## Verification evidence

A safe live read returns populated intentionally mapped fields through the effective local target.

## Recovery paths

Separate authentication, transport, response-shape, mapping, and empty-result failures before editing.

## Stop conditions

Stop before live writes without explicit approval, known effect, and a safe target.

## Handoff contract

Pass the selected outcome, explicit target, changed files, commands run, passing evidence, first unproven evidence layer, sanitized failure, remaining authority, and exact next action. The receiving skill continues from that layer; do not restart discovery or discard prior proof.
