/* SOSER Panel — Service Worker
   - Muestra notificaciones de emergencia (desde la app, o vía push).
   - Al tocar la notificación, abre la app y navega al caso.
   - Listo para Web Push cuando conectes tu servidor (celular/VPS). */
const CACHE = 'soser-admin-v1';

self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });

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
