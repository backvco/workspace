// @ts-nocheck
// Monaco setup + worker wiring (Vite ?worker imports). Imported only client-side
// by the Files/Changes tools, which are lazy-loaded — never hits SSR.
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  }
};

const EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', json: 'json', svelte: 'html', html: 'html',
  css: 'css', scss: 'scss', less: 'less', md: 'markdown', markdown: 'markdown',
  yml: 'yaml', yaml: 'yaml', sh: 'shell', bash: 'shell', py: 'python', go: 'go',
  rs: 'rust', sql: 'sql', toml: 'ini', ini: 'ini', xml: 'xml', dockerfile: 'dockerfile'
};

export function languageForPath(p = '') {
  const base = p.split('/').pop() || '';
  if (base.toLowerCase() === 'dockerfile') return 'dockerfile';
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  return EXT[ext] || 'plaintext';
}

export { monaco };
