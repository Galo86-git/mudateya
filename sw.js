// MudateYa Service Worker
// Versión básica: habilita instalación PWA + cache mínimo de assets estáticos.
// Las páginas HTML y llamadas a /api siempre van a la red (network-first) para
// que vos veas siempre datos frescos.

var CACHE_NAME = 'mudateya-v2';
var STATIC_ASSETS = [
  '/icon-192.png',
  '/icon-512.png',
  '/favicon.svg',
  '/manifest.json'
];

// ── Install: precachea los assets estáticos básicos ──
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(STATIC_ASSETS).catch(function(err){
        // Si falla algún asset (ej. icon todavía no deployado), no rompemos el SW
        console.warn('[SW] precache parcial:', err.message);
      });
    })
  );
  // Activar inmediatamente sin esperar a que cierren todas las pestañas
  self.skipWaiting();
});

// ── Activate: limpia caches viejos y toma control ──
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(n){ return n !== CACHE_NAME; })
             .map(function(n){ return caches.delete(n); })
      );
    }).then(function(){ return self.clients.claim(); })
  );
});

// ── Fetch strategy: network-first para HTML y API; cache-first para assets ──
self.addEventListener('fetch', function(event) {
  var req = event.request;
  // Solo manejamos GET — el resto va directo a la red sin tocar
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  // No cacheamos requests cross-origin (Google, Mercado Pago, fonts, etc.)
  if (url.origin !== self.location.origin) return;

  // API y páginas HTML: SIEMPRE intentar red primero (datos frescos)
  // Si la red falla, devolver lo último cacheado (offline degradado)
  var esHTML = req.headers.get('accept') && req.headers.get('accept').indexOf('text/html') !== -1;
  var esAPI  = url.pathname.indexOf('/api/') === 0;

  if (esAPI || esHTML) {
    event.respondWith(
      fetch(req).then(function(response){
        // Cachear copia para fallback offline (solo HTML, no API)
        if (esHTML && response.ok) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function(c){ c.put(req, copy); });
        }
        return response;
      }).catch(function(){
        return caches.match(req).then(function(cached){
          return cached || new Response('Sin conexión y sin caché disponible', { status: 503 });
        });
      })
    );
    return;
  }

  // Assets estáticos (icons, css, js): cache-first con actualización en background
  event.respondWith(
    caches.match(req).then(function(cached) {
      var fetchProm = fetch(req).then(function(response){
        if (response.ok) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function(c){ c.put(req, copy); });
        }
        return response;
      }).catch(function(){ return cached; });
      return cached || fetchProm;
    })
  );
});

// ── PUSH: recibir notificaciones en segundo plano ──
self.addEventListener('push', function(event) {
  var data = {
    titulo: 'MudateYa',
    cuerpo: 'Tenés una novedad',
    link: '/mi-cuenta',
    icono: '/icon-192.png'
  };

  if (event.data) {
    try {
      var parsed = event.data.json();
      data.titulo = parsed.titulo || data.titulo;
      data.cuerpo = parsed.cuerpo || data.cuerpo;
      data.link = parsed.link || data.link;
      data.icono = parsed.icono || data.icono;
    } catch (e) {
      // Si el payload no es JSON, usar el texto crudo como cuerpo
      data.cuerpo = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.titulo, {
      body: data.cuerpo,
      icon: data.icono,
      badge: '/icon-192.png',
      vibrate: [200, 100, 200],
      tag: 'mudateya-notif',
      renotify: true,
      data: { link: data.link }
    })
  );
});

// ── NOTIFICATIONCLICK: abrir la app cuando tocan la notificación ──
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var link = (event.notification.data && event.notification.data.link) || '/mi-cuenta';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(windowClients) {
      // Si la PWA ya está abierta, enfocarla y navegar al link
      for (var i = 0; i < windowClients.length; i++) {
        var c = windowClients[i];
        if (c.url.indexOf(self.location.origin) === 0 && 'focus' in c) {
          c.focus();
          if ('navigate' in c) c.navigate(link);
          return;
        }
      }
      // Si no, abrir nueva ventana
      if (clients.openWindow) {
        return clients.openWindow(link);
      }
    })
  );
});
