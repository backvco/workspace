// Tool registry. A "tool" is whatever renders inside a tab. New features
// (kanban, planner, ...) register here and instantly become openable as tabs.
const tools = new Map();

/** @param {{ id:string, label:string, icon?:string, singleton?:boolean, component:()=>Promise<any> }} def */
export function registerTool(def) {
  tools.set(def.id, def);
}

/** @param {string} id */
export function getTool(id) {
  return tools.get(id);
}

export function allTools() {
  return [...tools.values()];
}
