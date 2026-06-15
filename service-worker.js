// ═══════════════════════════════════════════════════════════════
// MAXICONFORT LIVRAISON PRO - SERVICE WORKER
// v7.5.59 - Suivi logistique : tél client cliquable (appel) + tracking GLS cliquable (suivi colis)
// ═══════════════════════════════════════════════════════════════

const CACHE_VERSION = 'maxiconfort-v7-5-59';
const CACHE_NAME = `maxiconfort-cache-${CACHE_VERSION}`;

// Ressources mises en cache au démarrage (assets statiques)
const STATIC_ASSETS = [
  '/maxiconfort-v7.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-180.png',
  '/favicon.png'
];

// Domaines à NE PAS mettre en cache (toujours requête réseau)
const NETWORK_ONLY_DOMAINS = [
  'supabase.co',
  'supabase.io',
  'sendinblue.com',
  'brevo.com',
  'googleapis.com',
  'maps.google.com'
];

// ─────────────────────────────────────────────
// INSTALLATION : mise en cache des assets
// ─────────────────────────────────────────────
self.addEventListener('install', (event) => {
  console.log('[SW] Installation v' + CACHE_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Mise en cache des assets statiques');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => self.skipWaiting()) // Activation immédiate
      .catch((err) => console.warn('[SW] Erreur cache install:', err))
  );
});

// ─────────────────────────────────────────────
// ACTIVATION : nettoyage des anciens caches
// ─────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log('[SW] Activation v' + CACHE_VERSION);
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key.startsWith('maxiconfort-cache-')) {
            console.log('[SW] Suppression ancien cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim()) // Contrôler les pages ouvertes
  );
});

// ─────────────────────────────────────────────
// FETCH : stratégies de cache
// ─────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Ne pas intercepter les requêtes vers Supabase, Brevo, etc.
  if (NETWORK_ONLY_DOMAINS.some(domain => url.hostname.includes(domain))) {
    return; // Laisser passer la requête normale
  }

  // Stratégie : Network First avec fallback cache
  // (priorité : récupérer la dernière version, mais utiliser le cache si offline)
  if (event.request.method === 'GET') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Si succès, mettre en cache une copie pour usage offline
          if (response.ok && response.status === 200 && response.type === 'basic') {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // Réseau échoué → fallback au cache
          console.log('[SW] Offline - fallback cache pour:', url.pathname);
          return caches.match(event.request).then((cached) => {
            if (cached) return cached;
            // Si pas en cache et HTML, retourner la page principale (SPA fallback)
            if (event.request.destination === 'document' || event.request.headers.get('accept')?.includes('text/html')) {
              return caches.match('/maxiconfort-v7.html');
            }
            // Sinon erreur 503
            return new Response('Offline - ressource indisponible', {
              status: 503,
              statusText: 'Service Unavailable',
              headers: { 'Content-Type': 'text/plain' }
            });
          });
        })
    );
  }
});

// ─────────────────────────────────────────────
// MESSAGE : communication avec la page
// ─────────────────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    caches.keys().then((keys) => {
      keys.forEach((key) => caches.delete(key));
    });
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: CACHE_VERSION });
  }
});

// ─────────────────────────────────────────────
// SYNC BACKGROUND : pour futur (synchro offline)
// ─────────────────────────────────────────────
self.addEventListener('sync', (event) => {
  console.log('[SW] Background sync:', event.tag);
  // Réservé pour futur usage (ex: sync queue offline)
});

console.log('[SW] Script chargé - v' + CACHE_VERSION);
