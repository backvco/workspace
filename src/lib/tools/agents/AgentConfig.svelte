<script>
  // The agent's configuration. Behavioral config (model, permission, goal) is
  // fixed at spawn — to change it, talk to the agent in the Console, or stop and
  // relaunch. Shown read-only with that guidance.
  /** @type {{ task: any }} */
  let { task } = $props();

  /** @param {number} ms */
  const when = (ms) => (ms ? new Date(ms).toLocaleString() : '—');
  /** @type {[string, any][]} */
  let rows = $derived([
    ['Goal', task.goal || '—'],
    ['Done when', task.criteria || '—'],
    ...(task.steps ? [['Steps', task.steps]] : []),
    ...(task.context ? [['Context', task.context]] : []),
    ['Directory', task.dir],
    ['Worktree', task.worktree || '(none — runs in place)'],
    ['Branch', task.branch || '—'],
    ['Role', task.role || '—'],
    ['Model', task.model || 'auto'],
    ['Permission', task.permission || 'guarded'],
    ['Created', when(task.createdAt)]
  ]);
</script>

<div class="p-4 overflow-auto h-full text-sm space-y-3">
  <dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2">
    {#each rows as [k, v] (k)}
      <dt class="text-muted">{k}</dt>
      <dd class="min-w-0 break-words whitespace-pre-wrap">{v}</dd>
    {/each}
  </dl>
  <p class="text-[11px] text-muted border-t border-line pt-3">
    Model, permission and the task prompt are set when the agent starts. To adjust a running agent,
    open <span class="text-content">Console</span> and tell it directly, or Stop it and launch a new one.
  </p>
</div>
