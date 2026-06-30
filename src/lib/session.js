// The active project id, shared so the API client scopes every request to it
// (sent as the x-workspace-project header). Kept tiny + dependency-free to avoid
// import cycles (api.js reads it; the projects store writes it).
let active = 'default';
export function getActiveProject() { return active; }
/** @param {string} id */
export function setActiveProject(id) { active = id || 'default'; }
