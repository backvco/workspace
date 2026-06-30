import { registerTool } from '$lib/tabs/registry.js';

registerTool({
  id: 'terminal',
  label: 'Terminal',
  singleton: false,
  component: () => import('./View.svelte')
});
