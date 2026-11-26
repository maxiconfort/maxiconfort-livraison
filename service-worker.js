// ═══════════════════════════════════════════════════════════════
// MAXICONFORT LIVRAISON PRO - SERVICE WORKER
// v7.5.198 - Recredit a l'annulation et mouvements manuels du stock faits PAR LA BASE (recrediter_stock_livraison, mouvement_stock_produit, migration 040), resultat complet de la deduction restitue au rejeu, fiches produit envoyees sans le stock (sauf creation), stock_deduit tenu par la base (27/11/2026)
// v7.5.197 - Stock d'une livraison deduit PAR LA BASE (fonction deduire_stock_livraison, migration 040), une seule fois par commande ; demande gardee en file et rejouee sans double effet ; calcul du stock sur le telephone supprime (26/11/2026)
// v7.5.196 - Deductions de stock suivies sur l'appareil (reprises apres fermeture), stock_deduit seulement si tous les produits sont enregistres, PATCH du livreur conditionnel (delta), versions anciennes invalidees apres un succes (26/11/2026)
// v7.5.195 - File : contexte de rejeu en parametre (plus de variable globale), fiche relancee garde sa date, fiche admin rejouee sans ecraser un stock plus recent, rotation des lectures du controle admin (26/11/2026)
// v7.5.194 - File : cle par intention (stock livreur / fiche admin), anciens elements jamais retires sans recapitulatif, fiches refusees versionnees et gardees en memoire, verrou du livre jusqu'aux sauvegardes produit, relecture 10 min (26/11/2026)
// v7.5.193 - Livre protege des releves perimees, rejeu par date et role d'origine, nouveaux ecarts controles, purge apres recapitulatif (26/11/2026)
// v7.5.192 - File : erreurs temporaires rejouees, fiches admin conservees, recapitulatif durable, controle admin par lecture en base (26/11/2026)
// v7.5.191 - Livreur : le « livre » remonte de nouveau (file d'attente sans boucle, stock du livreur par PATCH) (26/11/2026)
// v7.5.127 - JARVIS : vue Commandes filtree par origine (#jarvis=commandes:all:::TikTok%20Shop) (09/11/2026)
// v7.5.126 - JARVIS : vue Commandes filtree par statut (#jarvis=commandes:all:GLS:en-attente) (09/11/2026)
// v7.5.121 - Appareil de confiance : collab connectee 40 jours sur un ordinateur (05/11/2026)
// v7.5.118 - Ancienne offre : produit retire de la liste de choix, historique et stock conserves (09/10/2026)
// v7.5.105 - Rotation APP_SECRET (14/09/2026, Phase 0.5 MAXI BRAIN)
// v7.5.104 - Liste Commandes : colonne Livreur affiche "GLS" pour les commandes expediees
// ═══════════════════════════════════════════════════════════════

const CACHE_VERSION = 'maxiconfort-v7-5-198';
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
