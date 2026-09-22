const CACHE = 'mindmap-v1';
const ASSETS = ['./', './index.html', './app.js', './cloud.mjs', './sync.mjs', './icon.svg', './manifest.webmanifest'].map(p => new URL(p, self.location).href);
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('mindmap-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url); url.search = ''; url.hash = '';
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || !ASSETS.includes(url.href)) return;
  // オンラインなら必ずサーバーに確認して新しい版を取り、オフライン用の控えも更新する
  e.respondWith(fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }).then(res => { if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone())); return res; }).catch(() => caches.match(e.request)));
});
