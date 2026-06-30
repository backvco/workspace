// Per-tab context bridge. A View never reads global active state directly; it
// gets a small accessor from its enclosing TabSlot. Keeps Views portable and
// lets the same component run in many tabs at once.
import { getContext, setContext } from 'svelte';

const TAB_KEY = Symbol('workspace-tab');

/** @param {{ id:string, isActive:()=>boolean, params:()=>object, update:(patch:{title?:string, params?:Record<string,any>})=>void }} ctx */
export function provideTabContext(ctx) {
  setContext(TAB_KEY, ctx);
}

export function useTab() {
  return getContext(TAB_KEY);
}
