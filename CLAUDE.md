# Projet : App Livraison Pro (livraison.maxiconfort.fr)

PWA interne de gestion des livraisons Maxiconfort. **Ce dossier est le repo git actif** (GitHub `maxiconfort/maxiconfort-livraison`, déployé via GitHub Pages + CNAME).

## Stack
- App mono-fichier : `maxiconfort-v7.html` (~13 000 lignes, HTML/CSS/JS vanilla)
- Backend : Supabase projet `jmvfjtnmebstkzcfnlgp` (RLS x-app-secret, Edge Functions, pg_cron)
- SMS : Brevo · Cartes : Leaflet/OSRM · PWA : `service-worker.js` (**toujours bumper CACHE_VERSION à chaque déploiement du HTML**)
- Credentials : `.env` (jamais commit) · Déploiement Edge Functions autonome via token Supabase PAT (`SUPABASE_ACCESS_TOKEN` puis `npx supabase functions deploy <nom> --project-ref jmvfjtnmebstkzcfnlgp --no-verify-jwt`)
- Rôles login PIN : admin / CV / LV (livreur mobile)

## État au 11/06/2026 (version v7.5.47)
- **Édition commande SAV (v7.5.47)** : les SAV Reprise/Remboursement (créés sans ligne produit) sont enfin modifiables : le bloc « Produits commandés » est masqué à l'édition d'un SAV (note explicative à la place), la validation « Ajoutez au moins un produit » est sautée, et `saveCmd` préserve produit/lignes/prix/remises/`origine` du SAV (le select Origine n'a pas d'option `SAV - ...` → il aurait effacé le marqueur et réintégré le SAV dans le CA). Bonus : `montantEnc` est désormais préservé sur TOUTE édition (avant, l'UPSERT le remettait à 0 → remboursements SAV et encaissements livreur perdus en base).
- **Perf chargement commandes (v7.5.46)** : les 3 requêtes de chargement des commandes (initial, pagination, polling 30s) utilisent une liste explicite de colonnes (`CMD_SELECT_COLS`, 33 colonnes) au lieu de `select=*`, pour exclure `gls_pdf_base64` (PDF étiquette 50-400 Ko/cmd). Gain mesuré : 0,9 Mo → 216 Ko. Les PDF restent récupérés à la demande via l'action `getLabel` de `gls-create-shipment`. ⚠️ Toute nouvelle colonne de `commandes` utilisée par le mapping doit être ajoutée à `CMD_SELECT_COLS` (sinon HTTP 400 si nom faux, ou champ vide si oubli).
- **Rapport GLS du jour (v7.5.45)** : bouton 🖨️ page Suivi logistique → liste imprimable des étiquettes créées à une date (signatures chauffeur/expéditeur). Nouvelle colonne `commandes.gls_date_etiquette`, remplie par `gls-create-shipment` v5.9 (heure Paris). Les étiquettes d'avant le 11/06/2026 n'ont pas de date → absentes du rapport.
- **Stats Commandes (v7.5.44)** : les SAV (origine `SAV - ...`) sont exclus des badges Aujourd'hui/Semaine/Mois (pas des ventes). Données : 8 dates de livraison corrigées le 11/06 (année 2024/2025 saisie par erreur → exclues à tort du CA par le filtre anti-rétroactif).
- **Règle confirmée par Borhen (11/06/2026)** : les saisies rétroactives (date_livraison < date_commande) restent EXCLUES du CA des badges — ne pas « corriger » ce comportement.
- **Tournées** : refonte v7.5.41→43 (split 2 colonnes, smart actions, cards affichent l'ENCAISSÉ)
- **GLS** : `gls-create-shipment` v5.8 — multi-colis auto (120x190 ensemble = 3 colis [15,5,5], sommier seul = 2), PDF multi-pages, SMS expédition envoyé côté serveur. `gls-sync` v11 fonctionne (creds ShipIT-FARM) pour le suivi auto.
- **SMS automatisés** : Edge Function `sms-auto` + pg_cron — veille 19h Paris + départ 7h Paris (RANOU only, dedupe via `sms_envoyes`). SMS expédition GLS côté serveur. Plus de clients oubliés.
- **Autres Edge Functions** : send-cmd-sms (depart/route/expedition/proche/veille), shopify-sync (cron 10 min), whatsapp-receive (bot commandes IA Claude Haiku, multi-numéros), track-livreur (suivi temps réel client), webhook orders/create (note de préparation bundles)
- Modules en place : Santé société (trésorerie/encours marketplaces/multi-comptes bancaires), Suivi logistique, SAV 4 types (dont Remboursement à impact comptable négatif), optimisation tournée OSRM+2-opt, géofence entrepôt Noisy-le-Grand, app Android Capacitor (GPS background)

## Backlog connu
- Migration Supabase Publishable/Secret Keys 2026
- WhatsApp Business prod (sortir du Sandbox Twilio, rejoin `join join-around` tous les 72h)
- Migration SMS Allmysms/OVH (économie ~50%)
- Colonne `canal_saisie` sur commandes (mesurer l'apport du bot WhatsApp)
- Backup auto Supabase quotidien · UI templates SMS · refactor en modules

## Pièges connus
- PATCH Supabase via PowerShell : encoder UTF-8 manuellement (accents → HTTP 400) et URL-encoder `#` en `%23`
- Intercepteur fetch global ajoute `x-app-secret` aux URLs REST seulement (pas aux Edge Functions, sinon CORS bloque)
- Numéros Borhen : SMS = `+33 7 44 28 93 21` ; WhatsApp bot = `+33 7 51 56 31 13` (ligne SMS morte mais WA actif — ne pas toucher `ALLOWED_WHATSAPP_FROM`)

Périmètre : l'app de livraison + GLS intégré ici (étiquettes, suivi). Le site Shopify (`C:\Users\moind\maxiconfort`), l'outil LBC et TikTok ont leurs propres dossiers.
