import { registerTool } from '$lib/tabs/registry.js';

registerTool({
  id: 'tools',
  label: 'Tools',
  singleton: true,
  component: () => import('./View.svelte')
});
