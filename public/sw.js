// Hum Dono service worker: app shell cache, and Web Push (new message, incoming call) shown even when the app is closed.
const CACHE = 'humdono-v7';
const SHELL = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/') || u.pathname.startsWith('/media/')) return;
  e.respondWith(
    fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request))
  );
});

// ---------- Web Push ----------
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = {}; }
  event.waitUntil(handlePush(d));
});

async function handlePush(d) {
  if (d.type === 'call-end') {
    const rings = await self.registration.getNotifications({ tag: 'call' });
    rings.forEach((n) => n.close());
    await self.registration.showNotification('Hum Dono', { tag: 'call-end', silent: true });
    (await self.registration.getNotifications({ tag: 'call-end' })).forEach((n) => n.close());
    return;
  }
  const isCall = d.type === 'call';
  const opts = {
    body: d.body || 'Naya message 💌',
    tag: isCall ? 'call' : 'msg',
    renotify: true,
    icon: '/icons/icon-192.svg',
    badge: '/icons/icon-192.svg',
    timestamp: Date.now(),
    data: { type: d.type || 'msg', callId: d.callId || null },
  };
  if (isCall) {
    Object.assign(opts, {
      requireInteraction: true,
      vibrate: [400, 200, 400, 200, 400],
      actions: [{ action: 'accept', title: 'Uthao 💚' }, { action: 'decline', title: 'Kato' }],
    });
  }
  await self.registration.showNotification(d.title || 'Hum Dono 💕', opts);
}

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  event.notification.close();
  const action = event.action || (data.type === 'call' ? 'open' : 'chat');
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => w.visibilityState === 'visible') || wins[0];
    if (win) {
      try { await win.focus(); } catch {}
      win.postMessage({ type: 'push-action', action, callId: data.callId || null });
      return;
    }
    const q = new URLSearchParams({ pa: action });
    if (data.callId) q.set('call', data.callId);
    try { await self.clients.openWindow('/?' + q.toString()); } catch {}
  })());
});
