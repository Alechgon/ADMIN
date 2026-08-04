/* SOSER Panel — Service Worker
   - Cachea los archivos de la app para arranque instantáneo (incluso offline).
   - Muestra notificaciones de emergencia (desde la app, o vía push).
   - Al tocar la notificación, abre la app y navega al caso. */
const CACHE = 'soser-admin-v2';
const ASSETS = ['./', 'index.html', 'app.js', 'data.js', 'coords.js', 'icon-192.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {})));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    // borrar cachés viejos de versiones anteriores
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* Estrategia: los archivos de la app se sirven del caché al instante y se
   actualizan en segundo plano (stale-while-revalidate). Las llamadas al
   Apps Script (/exec) NUNCA se cachean: siempre datos frescos. */
self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (e.request.method !== 'GET') return;
  if (url.includes('script.google.com') || url.includes('/exec') || url.includes('googleusercontent') || url.includes('drive.google')) return;
  if (url.includes('cdnjs.cloudflare.com') || url.includes('unpkg.com') || url.includes('openstreetmap') || url.includes('project-osrm')) return;
  // solo cachear mismo origen (los archivos de la app)
  if (new URL(url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cached = await caches.match(e.request);
    const network = fetch(e.request).then(res => {
      if (res && res.status === 200) { const clone = res.clone(); caches.open(CACHE).then(c => c.put(e.request, clone)); }
      return res;
    }).catch(() => cached);
    return cached || network;
  })());
});

/* Notificación empujada desde el servidor (Web Push, opción A) */
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { title: 'SOSER', body: e.data ? e.data.text() : '' }; }
  const title = data.title || '🚨 Emergencia SOSER';
  const options = {
    body: data.body || 'Nueva emergencia registrada',
    tag: data.tag || 'soser-emergencia',
    renotify: true,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { url: data.url || './', encargado: data.encargado || '', id: data.id || '' }
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

/* Clic en la notificación -> enfocar/abrir la app */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if ('focus' in c) { c.postMessage({ type: 'open-case', data: e.notification.data }); return c.focus(); } }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});
