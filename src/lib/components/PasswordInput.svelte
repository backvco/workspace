<script>
  // Password field with a show/hide toggle. Bindable value so callers can validate
  // (length, confirm-match) themselves.
  /** @type {{ value?: string, placeholder?: string }} */
  let { value = $bindable(''), placeholder = 'password' } = $props();
  let show = $state(false);
</script>

<div class="relative">
  <input class="w-full bg-elevated border border-line rounded px-2 py-1.5 pr-12 text-sm"
    type={show ? 'text' : 'password'} {placeholder} autocomplete="new-password" bind:value />
  <button type="button" tabindex="-1"
    class="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted hover:text-content"
    onclick={() => (show = !show)}>{show ? 'Hide' : 'Show'}</button>
</div>
