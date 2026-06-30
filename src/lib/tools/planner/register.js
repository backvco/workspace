import { registerTool } from '$lib/tabs/registry.js';

// Plan-with-Claude as a first-class tab: chat on the left, a roomy review surface
// on the right. The tab persists per project (server-side), so a planning session
// reopens on any device. Bound to a planner via params().plannerId.
registerTool({
  id: 'planner',
  label: '🧠 Plan',
  singleton: false,
  component: () => import('./View.svelte')
});
