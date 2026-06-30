import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    // BUILD_OUT lets bin/deploy-ui build into a staging dir and swap it into place
    // atomically, so the running server never reads a half-written build/.
    adapter: adapter({ out: process.env.BUILD_OUT || 'build' }),
    paths: { relative: false }
  }
};
