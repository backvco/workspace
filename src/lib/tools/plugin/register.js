import { registerTool } from '$lib/tabs/registry.js';

// Generic host slot for an embedded plugin (a paid/closed external tool). The tool
// itself carries no feature logic — it discovers configured plugins from the API and
// embeds one via the auth-gated proxy. Absent any configured plugin it shows an
// empty state, so an OSS-only install is unaffected.
registerTool({
  id: 'plugin',
  label: 'Plugin',
  singleton: true,
  component: () => import('./View.svelte')
});
