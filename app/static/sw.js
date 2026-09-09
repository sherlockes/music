const CACHE_NAME = 'music-app-v2.0.7';
const STATIC_CACHE = 'music-static-v2.0.7';
const IMAGE_CACHE = 'music-images-v2.0.7';

const PRECACHE_ASSETS = [
  '/static/css/style.css?v=2.0.7',
  '/static/js/app.js?v=2.0.7',
  '/static/js/player.js?v=2.0.7',
  '/static/js/rclone.js?v=2.0.7',
  '/static/favicon.svg?v=2.0.7',
  '/manifest.json?v=2.0.7'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      return cache.addAll(PRECACHE_ASSETS).catch(err => console.debug("Precache error:", err));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  const currentCaches = [STATIC_CACHE, IMAGE_CACHE, CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (!currentCaches.includes(cache)) {
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Cover image caching (Local extracted covers & Deezer / YT artwork)
  if (url.pathname.startsWith('/api/library/cover') || 
      url.hostname.includes('dzcdn.net') || 
      url.hostname.includes('ytimg.com') ||
      url.hostname.includes('googleusercontent.com')) {
    event.respondWith(
      caches.open(IMAGE_CACHE).then(async cache => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        try {
          const res = await fetch(event.request);
          if (res && res.status === 200) {
            cache.put(event.request, res.clone());
          }
          return res;
        } catch (err) {
          return cached || new Response('', { status: 408 });
        }
      })
    );
    return;
  }

  // ALL other API endpoints, audio streams, docs: NEVER intercept, let browser handle directly
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/docs') || url.pathname.startsWith('/openapi') || url.searchParams.has('v=')) {
    return;
  }

  // HTML Navigation: Network first, fallback to cached index if offline
  if (event.request.mode === 'navigate' || event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/'))
    );
    return;
  }

  // Static Assets (JS, CSS, SVGs, Fonts): Network First, fallback to cache
  event.respondWith(
    fetch(event.request).then(networkResponse => {
      if (networkResponse && networkResponse.status === 200) {
        const clone = networkResponse.clone();
        caches.open(STATIC_CACHE).then(cache => cache.put(event.request, clone));
      }
      return networkResponse;
    }).catch(async () => {
      const cache = await caches.open(STATIC_CACHE);
      return (await cache.match(event.request)) || (await cache.match('/'));
    })
  );
});
