// ═══════════════════════════════════════════════════════════════
// MAXICONFORT LIVRAISON PRO - SERVICE WORKER
// v7.5.163 - Produits : creation a prix nul = prix a definir (non vendable), homonyme d'une reference en attente refuse ; arrivage : correction de taux refusee si le revient a change hors historique (26/11/2026)
// v7.5.161 - Produits non vendables : remise globale figee tant qu'une ligne figee est presente (base, appli, JARVIS) (26/11/2026)
// v7.5.158 - Commande ancienne sans lignes rouverte : ligne d'origine reconstruite telle quelle, plus de rapprochement par premier mot (26/11/2026)
// v7.5.155 - Produits non vendables : commande sans lignes controlee par son produit principal (base, appli, JARVIS) (26/11/2026)
// v7.5.152 - Produits non vendables : composant introuvable ou inactif = ensemble non vendable ; lignes figees gardees telles quelles, comparees au centime (26/11/2026)
// v7.5.150 - Arrivage : stock dans l'empreinte, quantites figees, revients pagines ; lignes figees comme la base ; catalogue WhatsApp complet (26/11/2026)
// v7.5.147 - Produits non vendables : tous les champs d'une ligne examines ; arrivage : valorisation de l'apercu reverifiee par la base (26/11/2026)
// v7.5.144 - Produits non vendables : identifiant et nom contradictoires refuses, catalogue serveur lu jusqu'a une page vide (26/11/2026)
// v7.5.142 - Arrivages : lignes lues par pages, revient calcule par la base, produits non vendables reconnus par nom (26/11/2026)
// v7.5.127 - JARVIS : vue Commandes filtree par origine (#jarvis=commandes:all:::TikTok%20Shop) (09/11/2026)
// v7.5.126 - JARVIS : vue Commandes filtree par statut (#jarvis=commandes:all:GLS:en-attente) (09/11/2026)
// v7.5.121 - Appareil de confiance : collab connectee 40 jours sur un ordinateur (05/11/2026)
// v7.5.118 - Ancienne offre : produit retire de la liste de choix, historique et stock conserves (09/10/2026)
// v7.5.105 - Rotation APP_SECRET (14/09/2026, Phase 0.5 MAXI BRAIN)
// v7.5.104 - Liste Commandes : colonne Livreur affiche "GLS" pour les commandes expediees
// ═══════════════════════════════════════════════════════════════

const CACHE_VERSION = 'maxiconfort-v7-5-165';
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
