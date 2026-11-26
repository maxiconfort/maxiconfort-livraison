// ═══════════════════════════════════════════════════════════════
// MAXICONFORT LIVRAISON PRO - SERVICE WORKER
// v7.5.200 - Fusion de la PR 29 (v7.5.198 : recredit et mouvements manuels du stock par la base, migration 040 revisee) dans le dropshipping (v7.5.199, migration 041 : deduction limitee aux pieces Depot posee sur la 040 revisee) + STOCK TAMPON dropshipping (achats d avance en lots au prix HT reel, premier entre premier sorti) + libelle Depot - stock BMS (27/11/2026)
// v7.5.199 - Dropshipping encadre et provenance de chaque piece (migration 041) : 3 pare-feu du livreur (chargement Depot / fournisseur / camion, enlevement paye avec photo du ticket, livraison piece par piece), stock du camion, page admin Dropshipping (bilan du jour, alertes, fournisseurs, prix HT, references activees) ; inclut la fusion de la PR 29 v7.5.197 dans Commandes filtres (refus definitif de la base garde dans la file corrigee) (27/11/2026)
// v7.5.198 - Recredit a l'annulation et mouvements manuels du stock faits PAR LA BASE (recrediter_stock_livraison, mouvement_stock_produit, migration 040), resultat complet de la deduction restitue au rejeu, fiches produit envoyees sans le stock (sauf creation), stock_deduit tenu par la base (27/11/2026)
// v7.5.197 - Stock d'une livraison deduit PAR LA BASE (fonction deduire_stock_livraison, migration 040), une seule fois par commande ; demande gardee en file et rejouee sans double effet ; calcul du stock sur le telephone supprime (26/11/2026)
// v7.5.196 - Deductions de stock suivies sur l'appareil (reprises apres fermeture), stock_deduit seulement si tous les produits sont enregistres, PATCH du livreur conditionnel (delta), versions anciennes invalidees apres un succes (26/11/2026)
// v7.5.195 - File : contexte de rejeu en parametre (plus de variable globale), fiche relancee garde sa date, fiche admin rejouee sans ecraser un stock plus recent, rotation des lectures du controle admin (26/11/2026)
// v7.5.194 - File : cle par intention (stock livreur / fiche admin), anciens elements jamais retires sans recapitulatif, fiches refusees versionnees et gardees en memoire, verrou du livre jusqu'aux sauvegardes produit, relecture 10 min (26/11/2026)
// v7.5.193 - Livre protege des releves perimees, rejeu par date et role d'origine, nouveaux ecarts controles, purge apres recapitulatif (26/11/2026)
// v7.5.192 - File : erreurs temporaires rejouees, fiches admin conservees, recapitulatif durable, controle admin par lecture en base (26/11/2026)
// v7.5.191 - Livreur : le « livre » remonte de nouveau (file d'attente sans boucle, stock du livreur par PATCH) (26/11/2026)
// v7.5.199 - Commandes, filtres de dates : fusion de la PR 27 (v7.5.198 ; PR 26, PR 25 et PR 24 v7.5.195 incluses : validation de la remise recontrolee par la base, arrets figes) (27/11/2026)
// v7.5.198 - Tableau de bord + menus : fusion de la PR 26 (v7.5.197 ; PR 25 v7.5.196 et PR 24 v7.5.195 incluses : validation de la remise recontrolee par la base, arrets figes) (27/11/2026)
// v7.5.197 - Arrivage : fusion de la PR 25 (v7.5.196, PR 24 v7.5.195 incluse : validation de la remise recontrolee par la base, arrets figes) (27/11/2026)
// v7.5.196 - Habillage style D : fusion de la PR 24 (v7.5.195, derniere correction ciblee : validation recontrolee par la base, arrets figes) (27/11/2026)
// v7.5.195 - Caisse (revue Codex PR 24 sur 59f3a26, derniere correction ciblee) : validation de la remise recontrolee par la base apres le verrou (depenses et arrets), arrets d'une tournee validee figes pour la caisse (27/11/2026)
// v7.5.187 - Tableau de bord + menus : fusion de la PR 26 (v7.5.186 ; PR 25 v7.5.185 et PR 24 v7.5.184 incluses : relecture complete du verrou de caisse) (26/11/2026)
// v7.5.186 - Arrivage : fusion de la PR 25 (v7.5.185, PR 24 v7.5.184 incluse : relecture complete du verrou de caisse) (26/11/2026)
// v7.5.185 - Habillage style D : fusion de la PR 24 (v7.5.184, relecture complete du verrou de caisse) (26/11/2026)
// v7.5.184 - Caisse (revue Codex sur 639f2f5, regle des 10 retours) : rattachement des depenses fige par la base, tournees validees protegees, verrou consultatif partage avec la validation de la remise (26/11/2026)
// v7.5.178 - Fusion de la PR 26 (arrivage v7.5.177 : verification sous le verrou de la reception ; style D v7.5.176 : vert de jour lisible ; caisse v7.5.175 : verrou du point de caisse tenu par la base) dans tableau de bord + menus (26/11/2026)
// v7.5.177 - Arrivage (revue Codex sur ce01159) : resultat indetermine verifie par statut_reception_arrivage (meme verrou que la reception : attend une validation encore en cours) ; fusion du style D v7.5.176 et de la caisse v7.5.175 (26/11/2026)
// v7.5.176 - Habillage style D : vert de jour fonce (#1f7a52, texte blanc >= 4,5:1, WCAG AA) pour boutons, notifications de succes, export CSV, "Especes a remettre" ; tests de contraste des paires de jour ; fusion de la caisse v7.5.175 (26/11/2026)
// v7.5.175 - Caisse (revue Codex sur 437ec1e) : verrou du point de caisse valide tenu par la base (migration 038b, declencheur sur depenses), message clair au livreur en cas de refus (26/11/2026)
// v7.5.174 - Fusion des corrections arrivage v7.5.173, habillage v7.5.172 et caisse v7.5.171 dans tableau de bord + menus ; numero en double corrige (fusion ex-v7.5.164 -> v7.5.166) (26/11/2026)
// v7.5.173 - Arrivage : reponse de validation perdue = resultat indetermine, statut et mouvements relus avant toute nouvelle tentative (revue Codex sur 4e04efd) ; fusion de l'habillage v7.5.172 et de la caisse v7.5.171 (26/11/2026)
// v7.5.172 - Habillage style D : texte des montants positifs lisible en mode nuit (var(--sur-vert)) (revue Codex sur a12696a) ; fusion de la caisse v7.5.171 (26/11/2026)
// v7.5.171 - Caisse (revue Codex sur 3c3aa05) : "Deja paye" reserve aux commandes soldees (admin : motif journalise), livraisons terminees != tournee cloturee, verrou du point de caisse valide sur la liste Finance (26/11/2026)
// v7.5.170 - Tableau de bord : modification temps reel sans identifiant = preuve de chargement retiree ; prix de revient relus apres une mise a jour distante du stock (revue Codex sur d0f6efd) (26/11/2026)
// v7.5.166 - Fusion des corrections arrivages v7.5.163 (creation a prix nul = prix a definir, homonyme refuse ; correction de taux refusee sur rupture de continuite) dans tableau de bord + menus (26/11/2026)
// v7.5.164 - Arrivage : verrou de validation garde pendant toute l'operation (navigation bloquee), banc 039 en echec si pglite manque (revue Codex sur 636f873) (26/11/2026)
// v7.5.163 - Produits : creation a prix nul = prix a definir (non vendable), homonyme d'une reference en attente refuse ; arrivage : correction de taux refusee si le revient a change hors historique (26/11/2026)
// v7.5.162 - Fusion des corrections arrivages v7.5.161 (remise globale figee tant qu'une ligne figee est presente) dans tableau de bord + menus (26/11/2026)
// v7.5.161 - Produits non vendables : remise globale figee tant qu'une ligne figee est presente (base, appli, JARVIS) (26/11/2026)
// v7.5.160 - Tableau de bord : suppression recue par le temps reel retiree de la liste locale (sans identifiant : preuve de chargement complet retiree) (26/11/2026)
// v7.5.159 - Fusion des corrections arrivages v7.5.158 (commande ancienne sans lignes rouverte avec sa ligne d'origine) dans tableau de bord + menus (26/11/2026)
// v7.5.158 - Commande ancienne sans lignes rouverte : ligne d'origine reconstruite telle quelle, plus de rapprochement par premier mot (26/11/2026)
// v7.5.157 - Tableau de bord : evenements temps reel recus pendant le chargement complet rejoues sur l'instantane (preuve refusee si ordre indecidable), lecture paginee par cle (id) (26/11/2026)
// v7.5.156 - Fusion des corrections arrivages v7.5.155 (commande sans lignes controlee par son produit principal) dans tableau de bord + menus (26/11/2026)
// v7.5.155 - Produits non vendables : commande sans lignes controlee par son produit principal (base, appli, JARVIS) (26/11/2026)
// v7.5.154 - Tableau de bord : lecture jusqu'a une page vide (plafond de la base), preuve de chargement complet retiree si la synchronisation n'est plus garantie, valeur au revient partielle signalee (26/11/2026)
// v7.5.153 - Fusion des corrections arrivages v7.5.152 (composant introuvable ou inactif = ensemble non vendable, lignes figees au centime) dans tableau de bord + menus (26/11/2026)
// v7.5.152 - Produits non vendables : composant introuvable ou inactif = ensemble non vendable ; lignes figees gardees telles quelles, comparees au centime (26/11/2026)
// v7.5.151 - Tableau de bord : lectures par periode (la periode affichee gagne toujours), champs echappes, plus d'identifiant dans onclick ; fusion des corrections arrivages v7.5.150 (26/11/2026)
// v7.5.150 - Arrivage : stock dans l'empreinte, quantites figees, revients pagines ; lignes figees comme la base ; catalogue WhatsApp complet (26/11/2026)
// v7.5.149 - Tableau de bord : echec de lecture garde l'avertissement (nouvelle tentative differee ou bouton Reessayer), chargement complet prouve par sbLoadAll (26/11/2026)
// v7.5.148 - Fusion des corrections arrivages v7.5.147 (tous les champs d'une ligne, valorisation de l'apercu reverifiee) dans tableau de bord + menus (26/11/2026)
// v7.5.147 - Produits non vendables : tous les champs d'une ligne examines ; arrivage : valorisation de l'apercu reverifiee par la base (26/11/2026)
// v7.5.146 - Tableau de bord : services exclus des alertes de stock (rupture, stock bas) et de la valeur du stock (26/11/2026)
// v7.5.145 - Fusion des corrections arrivages v7.5.144 (identifiant et nom contradictoires, pagination serveur) dans tableau de bord + menus (26/11/2026)
// v7.5.144 - Produits non vendables : identifiant et nom contradictoires refuses, catalogue serveur lu jusqu'a une page vide (26/11/2026)
// v7.5.143 - Tableau de bord + menus, fusion des corrections arrivages v7.5.142 (26/11/2026)
// v7.5.142 - Arrivages : lignes lues par pages, revient calcule par la base, produits non vendables reconnus par nom (26/11/2026)
// v7.5.136 - Habillage style D : tests du selecteur de periode et du mode nuit (revue Codex sur d9c4e2a) (26/11/2026)
// v7.5.135 - Caisse (revue Codex) : Mixte controle, releve encaisse par arret, depenses uniques/figees/journalisees, refus base != coupure (26/11/2026)
// v7.5.127 - JARVIS : vue Commandes filtree par origine (#jarvis=commandes:all:::TikTok%20Shop) (09/11/2026)
// v7.5.126 - JARVIS : vue Commandes filtree par statut (#jarvis=commandes:all:GLS:en-attente) (09/11/2026)
// v7.5.121 - Appareil de confiance : collab connectee 40 jours sur un ordinateur (05/11/2026)
// v7.5.118 - Ancienne offre : produit retire de la liste de choix, historique et stock conserves (09/10/2026)
// v7.5.105 - Rotation APP_SECRET (14/09/2026, Phase 0.5 MAXI BRAIN)
// v7.5.104 - Liste Commandes : colonne Livreur affiche "GLS" pour les commandes expediees
// ═══════════════════════════════════════════════════════════════

const CACHE_VERSION = 'maxiconfort-v7-5-200';
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
