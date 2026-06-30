<script>
  // The agent's live tmux session, embedded. Agents run under their project's ws
  // namespace (session ws_<ns>-<id>), so we point the terminal there.
  import Terminal from '$lib/components/Terminal.svelte';
  /** @type {{ task: any, active?: boolean }} */
  let { task, active = true } = $props();
</script>

{#key task.id}
  <Terminal sessionKey={task.id} wsId={task.ns || 'default'} {active} />
{/key}
