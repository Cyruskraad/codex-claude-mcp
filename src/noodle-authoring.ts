import { server, tool, z } from '@noodleseed/one';

/**
 * Noodle's local-only authoring definition. It is not packaged as the bridge
 * runtime and is retained solely for offline bootstrap validation.
 */
export default server('codex_claude_mcp_authoring', {
  instructions: 'Validate local project authoring metadata for the Codex Claude MCP bridge.',
  title: 'Codex Claude MCP Authoring',
  version: '0.1.0',
}, [
  tool('authoring_status', {
    description: 'Report that Noodle validation is limited to local authoring metadata.',
    input: z.object({}),
    output: z.object({ status: z.literal('local-only') }),
    fulfil: () => ({ status: 'local-only' }),
  }),
]);
