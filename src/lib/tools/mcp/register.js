import { registerTool } from '$lib/tabs/registry.js';

registerTool({
  id: 'mcp',
  label: 'MCP Manager',
  singleton: true,
  component: () => import('./View.svelte')
});
