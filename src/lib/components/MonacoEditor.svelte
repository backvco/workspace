<script>
  // Single-file Monaco editor. Remount per file via {#key path} in the parent.
  // Ctrl/Cmd-S triggers onSave(currentValue).
  import { onMount, onDestroy } from 'svelte';
  import { monaco, languageForPath } from '$lib/monaco.js';

  let { value = '', path = '', onSave = null } = $props();
  /** @type {HTMLDivElement | undefined} */
  let el = $state();
  /** @type {any} */
  let editor;

  export function getValue() { return editor ? editor.getValue() : value; }

  onMount(() => {
    if (!el) return;
    editor = monaco.editor.create(el, {
      value, language: languageForPath(path), theme: 'vs-dark',
      automaticLayout: true, minimap: { enabled: false }, fontSize: 13,
      scrollBeyondLastLine: false, tabSize: 2
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSave?.(editor.getValue()));
  });
  onDestroy(() => editor?.dispose());
</script>

<div bind:this={el} class="h-full w-full"></div>
