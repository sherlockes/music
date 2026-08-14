const CACHE_NAME = 'music-app-v1.4.29';
const STATIC_CACHE = 'music-static-v1.4.29';
const IMAGE_CACHE = 'music-images-v1.4.29';

const PRECACHE_ASSETS = [
  '/static/css/style.css?v=1.4.29',
  '/static/js/app.js?v=1.4.29',
  '/static/js/player.js?v=1.4.29',
  '/static/js/rclone.js?v=1.4.29',
  '/static/favicon.svg?v=1.4.29',
  '/manifest.json?v=1.4.29'
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

  // Audio streams must never be intercepted by SW cache (Range requests & chunk streams)
  if (url.pathname.startsWith('/api/stream') || url.searchParams.has('v=')) {
    return;
  }

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

  // API endpoints: Always live network
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // HTML Navigation: Network first, fallback to cached index if offline
  if (event.request.mode === 'navigate' || event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/'))
    );
    return;
  }

  // Static Assets (JS, CSS, SVGs, Fonts): Stale-While-Revalidate
  event.respondWith(
    caches.open(STATIC_CACHE).then(async cache => {
      const cachedResponse = await cache.match(event.request);
      const fetchPromise = fetch(event.request).then(networkResponse => {
        if (networkResponse && networkResponse.status === 200) {
          cache.put(event.request, networkResponse.clone());
        }
        return networkResponse;
      }).catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});
