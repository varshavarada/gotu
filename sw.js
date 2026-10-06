// Shows nothing by itself: the page asks it to display notifications and handles taps on Done/Snooze.
const CACHE = 'gotu-v1';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Network first (always get updates), cache as the offline fallback.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then(res => {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request)));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const id = (e.notification.data || {}).id, action = e.action; // '' when the body is tapped
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    if (cs.length) {
      if (action) { cs[0].postMessage({ id, act: action }); return; }
      return cs[0].focus();
    }
    return self.clients.openWindow(action ? `./?act=${action}&id=${id}` : './');
  }));
});
