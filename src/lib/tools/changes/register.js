import { registerTool } from '$lib/tabs/registry.js';

registerTool({
  id: 'changes',
  label: 'Changes',
  singleton: false, // multiple Changes tabs so you can watch several repos at once
  component: () => import('./View.svelte')
});
