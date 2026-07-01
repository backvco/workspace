// Plugin registry. A "plugin" is an external, self-contained service (typically a
// compiled sidecar) that the workspace app embeds as a tool and proxies to. This
// module is config-only: it parses the enabled plugins from cfg.plugins and offers
// lookup. No plugin logic lives in the OSS core — only this generic seam.
//
// Config shape (cfg.plugins), parsed in config.js from WORKSPACE_PLUGINS:
//   [{ name, label, url }]
//   - name:  stable id (used in URLs and as the tool id), e.g. "agentmgr"
//   - label: human tab label, e.g. "Agent Manager"
//   - url:   base URL of the plugin service (its UI + API), e.g. http://127.0.0.1:5330

/** @param {any} cfg @returns {{name:string,label:string,url:string}[]} */
export function listPlugins(cfg) {
  return Array.isArray(cfg.plugins) ? cfg.plugins : [];
}

/** @param {any} cfg @param {string} name */
export function getPlugin(cfg, name) {
  return listPlugins(cfg).find((p) => p.name === name) || null;
}

// Parse the WORKSPACE_PLUGINS env value into the config array. Format is one or
// more `name|label|url` entries separated by commas (or newlines). Kept tiny and
// dependency-free; invalid entries are skipped.
/** @param {string} raw @returns {{name:string,label:string,url:string}[]} */
export function parsePlugins(raw) {
  return String(raw || '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, label, url] = entry.split('|').map((s) => (s || '').trim());
      if (!name || !url) return null;
      return { name, label: label || name, url: url.replace(/\/+$/, '') };
    })
    .filter(Boolean);
}
