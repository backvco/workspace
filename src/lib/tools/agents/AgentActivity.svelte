<script>
  // The agent's event history (from agent_events): plan, asks, progress, done…
  import { api } from '$lib/api.js';
  /** @type {{ task: any }} */
  let { task } = $props();

  /** @type {{event:string,message:string,at:string}[]} */
  let events = $state([]);
  let loadedFor = '';
  async function load() { try { events = (await api.agentEvents(task.id)).events; } catch {} }
  $effect(() => { if (task.id !== loadedFor) { loadedFor = task.id; load(); } });

  /** @type {Record<string,string>} */
  const ICON = { plan: '📋', ask: '❓', done: '✅', reviewed: '🔎', progress: '•', notification: '🔔', active: '▶' };
  /** @param {string} at */
  function ago(at) {
    const m = Math.round((Date.now() - new Date(at).getTime()) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
  }
</script>

<div class="p-3 overflow-auto h-full text-sm">
  {#each events as e (e.at + e.event)}
    <div class="flex gap-2 py-1.5 border-b border-line/40">
      <span class="w-5 text-center shrink-0">{ICON[e.event] || '•'}</span>
      <div class="min-w-0 flex-1">
        <div class="text-[11px] text-muted">{e.event} · {ago(e.at)}</div>
        {#if e.message}<div class="text-xs whitespace-pre-wrap break-words">{e.message}</div>{/if}
      </div>
    </div>
  {:else}
    <div class="text-muted text-center py-8 text-xs">No activity yet.</div>
  {/each}
</div>
