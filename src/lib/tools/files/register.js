import { registerTool } from '$lib/tabs/registry.js';

registerTool({
  id: 'files',
  label: 'Files',
  singleton: true,
  component: () => import('./View.svelte')
});
