/* global self, caches, Response */
/**
 * RaceSight offline shell: network-first GET with cache fallback for same-origin assets and navigations.
 */
const SHELL_CACHE = 'racesight-shell-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(Promise.resolve());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirstWithCacheFallback(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok && request.method === 'GET') {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    if (request.mode === 'navigate') {
      const doc = (await cache.match('/')) || (await cache.match('/index.html'));
      if (doc) {
        return doc;
      }
    }
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname.includes('/user-events')) {
      event.respondWith(networkFirstWithCacheFallback(request));
    }
    return;
  }
  event.respondWith(networkFirstWithCacheFallback(request));
});
