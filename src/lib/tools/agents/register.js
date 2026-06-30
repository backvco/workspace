import { registerTool } from '$lib/tabs/registry.js';

registerTool({
  id: 'agents',
  label: 'Tickets / Board',
  singleton: true,
  component: () => import('./View.svelte')
});
