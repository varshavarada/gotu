// Receives pushes from the server (works with the page closed) and handles the Done / Snooze buttons.
const CACHE = 'gotu-v2';
const FILES = ['./', 'index.html', 'config.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
const T = { WATER: ['💧', 'Water'], EYE_DROPS: ['👁', 'Eye Drops'] };

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// App files: network first (always fresh), cache only as the offline fallback.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(res => {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request)));
});

const refreshPages = () =>
  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => cs.forEach(c => c.postMessage({ refresh: true })));

self.addEventListener('push', e => {
  let d = null;
  try { d = e.data.json(); } catch (err) {}
  const [emoji, label] = (d && T[d.type]) || ['🔔', 'GotU'];
  const time = d ? new Date(d.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  e.waitUntil(self.registration.showNotification(`${emoji} ${label}`, {
    body: d ? (d.followUp ? 'Still waiting: ' : '') + time + ' reminder' : 'Reminder',
    tag: d ? 'r' + d.id : 'gotu', vibrate: [0, 300, 150, 300], icon: 'icon-192.png', badge: 'icon-192.png',
    actions: d ? [{ action: 'done', title: 'Done' }, { action: 'snooze', title: 'Snooze ' + d.snoozeMin + ' min' }] : [],
    data: d || {},
  }).then(refreshPages));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const d = e.notification.data || {};
  if ((e.action === 'done' || e.action === 'snooze') && d.api) {
    e.waitUntil(fetch(`${d.api}/${d.uid}/act`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: d.id, act: e.action }),
    }).then(r => { if (!r.ok) throw new Error(r.status); return refreshPages(); })
      .catch(() => self.registration.showNotification('GotU', { body: 'No connection. Open GotU to confirm.', tag: 'r' + d.id })));
    return;
  }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(cs => (cs.length ? cs[0].focus() : self.clients.openWindow('./'))));
});
