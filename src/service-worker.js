/// <reference lib="webworker" />
// PWA service worker. Network-first for everything (so it never serves a stale
// app or fights vite HMR in dev), with the built assets precached as an offline
// fallback. The /api and /ws paths are never intercepted. In dev, `build`/`files`
// are empty, so this is effectively network-only.
import { build, files, version } from '$service-worker';

const sw = /** @type {ServiceWorkerGlobalScope & typeof globalThis} */ (/** @type {unknown} */ (self));
const CACHE = `ws-cache-${version}`;
const PRECACHE = [...build, ...files];

sw.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await sw.clients.claim();
  })());
});

sw.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never touch the API, websockets, or cross-origin requests.
  if (url.origin !== sw.location.origin || url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Immutable build assets: cache-first.
    if (PRECACHE.includes(url.pathname)) {
      const hit = await cache.match(req);
      if (hit) return hit;
    }
    // Everything else: network-first, falling back to cache when offline.
    try {
      return await fetch(req);
    } catch {
      const hit = await cache.match(req);
      if (hit) return hit;
      throw new Error('offline and not cached');
    }
  })());
});
