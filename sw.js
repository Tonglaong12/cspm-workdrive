/* CSPM WorkDrive - service worker (offline support)
 * - App page: network first (4s timeout), falls back to the saved copy when offline
 * - Libraries and fonts (CDN): saved on first visit, refreshed in the background
 * - Team photos (Supabase public storage): saved as they are viewed
 * - Supabase API calls are never touched: the app handles offline itself
 * Bump VERSION when this file changes so old caches are removed.
 */
const VERSION = 'v1';
const SHELL_CACHE = 'cspm-shell-' + VERSION;
const RUNTIME_CACHE = 'cspm-runtime-' + VERSION;
const PHOTO_CACHE = 'cspm-photos-' + VERSION;
const PHOTO_LIMIT = 400;

const SHELL_URLS = ['index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Prompt:wght@300;400;500;600;700&display=swap';
const CDN_URLS = [
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://unpkg.com/lucide@latest',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  FONT_CSS
];
const CDN_HOSTS = [
  'cdn.tailwindcss.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

async function fetchCors(url) {
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (res && res.ok) return res;
  } catch (e) {}
  try {
    const res = await fetch(url, { mode: 'no-cors', credentials: 'omit' });
    if (res && (res.ok || res.type === 'opaque')) return res;
  } catch (e) {}
  return null;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await Promise.allSettled(SHELL_URLS.map((u) => shell.add(new Request(u, { cache: 'reload' }))));

    const runtime = await caches.open(RUNTIME_CACHE);
    await Promise.allSettled(CDN_URLS.map(async (u) => {
      const res = await fetchCors(u);
      if (res) await runtime.put(u, res);
    }));

    // Save the Thai + Latin font files so text looks right offline
    try {
      const cssRes = await runtime.match(FONT_CSS, { ignoreVary: true });
      if (cssRes) {
        const css = await cssRes.clone().text();
        const re = /\/\*\s*(thai|latin)\s*\*\/\s*@font-face\s*\{[^}]*?url\((https:[^)]+)\)/g;
        const fontUrls = [];
        let m;
        while ((m = re.exec(css)) !== null) fontUrls.push(m[2]);
        await Promise.allSettled(fontUrls.map(async (u) => {
          const res = await fetchCors(u);
          if (res) await runtime.put(u, res);
        }));
      }
    } catch (e) {}

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = [SHELL_CACHE, RUNTIME_CACHE, PHOTO_CACHE];
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('cspm-') && !keep.includes(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function trimCache(cache, limit) {
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  await Promise.all(keys.slice(0, keys.length - limit).map((k) => cache.delete(k)));
}

async function pageNetworkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await withTimeout(fetch(request), 4000);
    if (res && res.ok) cache.put('index.html', res.clone());
    return res;
  } catch (e) {
    return (await cache.match('index.html', { ignoreSearch: true })) ||
           new Response('ออฟไลน์ และยังไม่เคยเปิดแอพนี้ตอนมีอินเทอร์เน็ต', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function staleWhileRevalidate(event, cacheName, forceCors) {
  const request = event.request;
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request.url, { ignoreVary: true });
  const update = (async () => {
    let res = null;
    if (forceCors) {
      res = await fetchCors(request.url);
    } else {
      try { res = await fetch(request); } catch (e) { res = null; }
    }
    if (res && (res.ok || res.type === 'opaque')) await cache.put(request.url, res.clone());
    return res;
  })();
  event.waitUntil(update.catch(() => {}));
  if (cached) return cached;
  return (await update.catch(() => null)) || new Response('', { status: 504 });
}

async function photoCacheFirst(event) {
  const request = event.request;
  const cache = await caches.open(PHOTO_CACHE);
  const hit = await cache.match(request.url, { ignoreVary: true });
  if (hit) return hit;
  try {
    const res = await fetch(request.url, { mode: 'cors', credentials: 'omit' });
    if (res && res.ok) {
      await cache.put(request.url, res.clone());
      event.waitUntil(trimCache(cache, PHOTO_LIMIT));
    }
    return res;
  } catch (e) {
    return new Response('', { status: 504 });
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.hostname.endsWith('.supabase.co')) {
    if (url.pathname.startsWith('/storage/v1/object/public/')) {
      event.respondWith(photoCacheFirst(event));
    }
    return; // API calls go straight to the network
  }

  if (url.origin === self.location.origin) {
    if (request.mode === 'navigate') {
      event.respondWith(pageNetworkFirst(request));
    } else {
      event.respondWith(staleWhileRevalidate(event, SHELL_CACHE, false));
    }
    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(event, RUNTIME_CACHE, true));
  }
});
