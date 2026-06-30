import { registerTool } from '$lib/tabs/registry.js';

registerTool({
  id: 'settings',
  label: 'Settings',
  singleton: true,
  component: () => import('./View.svelte')
});
