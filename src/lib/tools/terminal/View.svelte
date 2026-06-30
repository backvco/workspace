<script>
  // Terminal tab = the reusable Terminal scoped to this tab's id + active project.
  import { useTab } from '$lib/tabs/context.js';
  import { getActiveProject } from '$lib/session.js';
  import { autoTitleTab, markNeedsInput } from '$lib/tabs/store.svelte.js';
  import Terminal from '$lib/components/Terminal.svelte';
  const tab = useTab();
</script>

<Terminal sessionKey={tab.id} wsId={getActiveProject()} active={tab.isActive()}
  onTitle={(t) => autoTitleTab(tab.id, t)}
  onNeedsInput={() => markNeedsInput(tab.id)} />
