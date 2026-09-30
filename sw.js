/* SISMO·MONITOR — service worker
 * Estrategia:
 *  - Cascarón de la app (HTML, íconos, librería 3D): caché primero
 *    → carga instantánea e inicio sin conexión.
 *  - Datos sísmicos (USGS, proxy, espejo, Supabase): SIEMPRE red, nunca caché
 *    → un panel de tiempo real jamás debe mostrar datos viejos como frescos.
 * Al actualizar la web, sube también este archivo cambiando VERSION.
 */
const VERSION = 'v44';
const CACHE = 'sismo-monitor-' + VERSION;

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-ciclon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'
];

// dominios de datos en vivo: no interceptar jamás
// (incluye las teselas satelitales, para no inflar la caché con imágenes)
const DATOS_VIVOS = [
  'earthquake.usgs.gov',
  'supabase.co',
  'script.google.com',
  'script.googleusercontent.com',
  'sismosve.rafnixg.dev',
  'seismicportal.eu',
  'arcgisonline.com',
  'cartocdn.com',
  'gibs.earthdata.nasa.gov',
  'freeipapi.com',
  'bigdatacloud.net'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('sismo-monitor-') && k !== CACHE)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // datos en vivo: directo a la red, sin tocar
  if (DATOS_VIVOS.some(d => url.hostname.endsWith(d))) return;

  // navegación (abrir la app): red primero, caché como respaldo sin conexión
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(r => {
          const copia = r.clone();
          caches.open(CACHE).then(c => c.put('./index.html', copia));
          return r;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // resto del cascarón (íconos, librerías, fuentes): caché primero
  e.respondWith(
    caches.match(e.request).then(hit =>
      hit || fetch(e.request).then(r => {
        if (r.ok && (url.protocol === 'https:')) {
          const copia = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copia));
        }
        return r;
      })
    )
  );
});

/* ================= Notificaciones Web Push ================= */
self.addEventListener('push', e => {
  let data = { title: 'SISMO·MONITOR', body: 'Nuevo sismo registrado' };
  try {
    if (e.data) data = e.data.json();
  } catch(err) {
    if (e.data) data.body = e.data.text();
  }

  const options = {
    body: data.body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    vibrate: [200, 100, 200],
    data: {
      url: data.url || './'
    }
  };

  e.waitUntil(
    self.registration.showNotification(data.title || 'SISMO·MONITOR', options)
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(e.notification.data.url || './');
    })
  );
});
