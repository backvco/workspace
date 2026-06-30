<script>
  // Read-only side-by-side diff (committed HEAD vs working tree). Remount per
  // file via {#key} in the parent.
  import { onMount, onDestroy } from 'svelte';
  import { monaco, languageForPath } from '$lib/monaco.js';

  let { original = '', modified = '', path = '' } = $props();
  /** @type {HTMLDivElement | undefined} */
  let el = $state();
  /** @type {any} */
  let diff;

  onMount(() => {
    if (!el) return;
    diff = monaco.editor.createDiffEditor(el, {
      theme: 'vs-dark', automaticLayout: true, readOnly: true,
      renderSideBySide: true, minimap: { enabled: false }, fontSize: 13,
      scrollBeyondLastLine: false
    });
    const lang = languageForPath(path);
    diff.setModel({
      original: monaco.editor.createModel(original, lang),
      modified: monaco.editor.createModel(modified, lang)
    });
  });
  onDestroy(() => {
    const m = diff?.getModel();
    m?.original?.dispose();
    m?.modified?.dispose();
    diff?.dispose();
  });
</script>

<div bind:this={el} class="h-full w-full"></div>
