import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';

// Set WORKSPACE_PUBLIC_HOST when the dev server is reached through a TLS reverse
// proxy under a public hostname (so the vite host check + HMR target match it).
// Left unset, the dev server just runs on localhost.
const PUBLIC_HOST = process.env.WORKSPACE_PUBLIC_HOST || '';

export default {
  plugins: [tailwindcss(), sveltekit()],
  // monaco-editor is intentionally a large vendor chunk; raise the warning ceiling
  // above it so the build output isn't noisy about an expected big bundle.
  build: { chunkSizeWarningLimit: 6000 },
  server: {
    host: '127.0.0.1',
    port: 5300,
    strictPort: true,
    allowedHosts: PUBLIC_HOST ? [PUBLIC_HOST] : undefined,
    // Behind a TLS proxy, HMR rides the same host over wss on 443.
    hmr: PUBLIC_HOST ? { host: PUBLIC_HOST, clientPort: 443, protocol: 'wss' } : undefined,
    // /api and /ws are served by workspace-api; proxy in dev so the UI is
    // same-origin without depending on a reverse proxy during local work.
    proxy: {
      '/api': { target: 'http://127.0.0.1:5301', changeOrigin: true },
      '/ws': { target: 'http://127.0.0.1:5301', ws: true, changeOrigin: true }
    }
  }
};
