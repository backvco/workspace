import { registerTool } from '$lib/tabs/registry.js';

registerTool({
  id: 'codeserver',
  label: 'VS Code',
  singleton: true,
  component: () => import('./View.svelte')
});
