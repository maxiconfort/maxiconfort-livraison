# Projet : App Livraison Pro (livraison.maxiconfort.fr)

PWA interne de gestion des livraisons Maxiconfort. Ce dossier est le dépôt git actif (GitHub `maxiconfort/maxiconfort-livraison`, **dépôt PUBLIC**, publié par GitHub Pages + CNAME).

⚠️ **Ce fichier est public (dépôt GitHub public)** : jamais de secret, de PIN, de nom/téléphone/adresse de client, ni de numéro personnel ici.
Le journal détaillé du projet (historique des versions, cas clients, SAV) est dans le dépôt PRIVÉ MAXI BRAIN et chargé ci-dessous pour Claude Code :

@C:/Users/moind/maxiconfort-brain/projets/livraison/CLAUDE-livraison-detail.md

## Stack
- App mono-fichier `maxiconfort-v7.html` + `service-worker.js` (**toujours augmenter `CACHE_VERSION` à chaque déploiement du HTML**).
- Backend Supabase projet `jmvfjtnmebstkzcfnlgp` : tables + RLS par session, Edge Functions (`supabase/functions/`), crons pg_cron.
- Déploiement Edge Functions : `npx supabase functions deploy <nom> --project-ref jmvfjtnmebstkzcfnlgp --no-verify-jwt --use-api` (jeton `SUPABASE_ACCESS_TOKEN` du `.env`).
- Pages publiées : seulement l'app et ses fichiers (voir `_config.yml` : CLAUDE.md, app.apk, supabase/, print-agent/, outils/ sont EXCLUS du site).

## Sécurité (depuis l'incident du 27/09/2026)
- **Clés** : navigateur = clé **publishable** uniquement. Clés **secrètes** (`sb_secret_…`) seulement côté serveur : Edge Functions (injectée par Supabase), `.env` local non versionné (`SUPABASE_SERVICE_ROLE_KEY` = clé dédiée « scripts_locaux », `PRINT_AGENT_SUPABASE_KEY` = clé dédiée « print_agent »). Clés JWT legacy (anon/service_role) **désactivées** et clé de signature HS256 **révoquée** : ne jamais les réactiver.
- Une clé secrète est refusée par Supabase si l'appel ressemble à un navigateur (User-Agent « Mozilla… », ex. PowerShell `Invoke-WebRequest`) : utiliser `-UserAgent 'maxiconfort-admin'` ou Node.
- **Accès aux données** : PIN vérifié côté serveur (RPC `connexion_pin`, empreintes bcrypt dans `secrets_serveur`, 5 échecs / 15 min) → jeton de session 12 h (`sessions_app`, révocable : `deconnexion`, `changer_pin`, `revoquer_sessions`). Toutes les requêtes de l'app envoient `x-app-secret` + `x-session-token`. RLS par rôle : politiques `sess_admin` (tout), `sess_collab` (commandes, tournées, stock, produits ; pas caisse/dépenses/paramètres sensibles), `sess_livreur` (ses livraisons J-2..J+2, ses tournées, son stock camion ; champs clients/montants non modifiables).
- **Secrets serveur** : table `secrets_serveur` (RLS sans politique, aucun droit anon/authenticated) : empreintes PIN, jetons et réglages TikTok, APP_SECRET courant. Les PIN ne sont **jamais** lus par le navigateur.
- **Edge Functions** : contrôle d'appelant `_shared/controle-appelant.ts` : crons = en-tête `x-cron-secret` (secret `INTERNAL_CRON_SECRET`, lu dans Vault par `interne.appel_fonction`) ; fonctions/scripts = clé secrète ; app = `x-app-secret` + session valide du bon rôle. Webhooks : `whatsapp-receive` exige la signature Twilio, `shopify-order-note` la signature HMAC Shopify (secret `SHOPIFY_WEBHOOK_SECRET`, sinon 503). `tiktok-oauth-callback` exige un `state` (lien généré par `node outils/tiktok-lien-autorisation.js`).
- **Tester une fonction à la main** : en-tête `x-cron-secret` (valeur dans `.env`) + corps `{"dryRun":true}`.
- Migration de référence : `supabase/migrations/019_incident_cles_2026-09-27.sql` (sans valeur secrète).

## État au 27/09/2026 — Incident clés Supabase (résumé public)
- Découverte le 27/09 : la clé legacy service_role (émise le 14/05) avait été publiée dans le dépôt public de l'outil Leboncoin (25/05, retirée le 30/05 mais restée dans l'historique git et **toujours valide**) ; l'ancien APP_SECRET (historique public de ce dépôt) était encore accepté ; PIN et jetons TikTok lisibles avec les éléments de la page publique.
- Mesures du 27/09 (18h-19h40) : clés legacy désactivées + clé HS256 révoquée ; ancien APP_SECRET retiré ; clés secrètes dédiées ; crons sans clé (Vault) ; contrôle d'appelant sur toutes les Edge Functions ; sessions serveur + RLS par rôle ; PIN serveur et nouveaux PIN ; jetons TikTok côté serveur + `state` OAuth ; CLAUDE.md et app.apk retirés du site ; inscription libre Supabase Auth fermée ; fonctions obsolètes `rapid-processor` et `sms-veille` supprimées. Maintenance de l'app navigateur 19h07 → 19h32.
- Dossier d'incident complet (privé) : `C:\Users\moind\maxiconfort-brain\incidents\2026-09-27-cles-supabase\DOSSIER_INCIDENT.md`.
- ⚠️ L'historique git de ce dépôt public contient encore les anciennes versions de ce fichier et des secrets désormais révoqués.

## GLS : preuves de livraison et alerte « sans premier scan » (28/09/2026)
- Analyse des historiques GLS centralisée dans `supabase/functions/_shared/gls-analyse.ts` (module pur, tests Node : `node --test supabase/tests/*.test.mjs`).
- **gls-sync v15** : une commande ne passe en « livré » que si **tous** ses colis ont une livraison client. Ne comptent pas : « delivered » après un « returned to sender », « delivered » final au dépôt de l'expéditeur (Garonor FR0093 / Noisy) pour un client hors IDF, dépôt en ParcelShop non retiré. Partiel ou retour → commande laissée non livrée, colonnes `gls_livraison_etat` / `gls_livraison_detail` (ex. « livraison partielle 2/3 ») + SMS à Borhen (anti-doublon `gls_alertes`). Mode audit lecture seule : `{"cmdIds":[...]}` ou `{"auditLivres":true,"jours":45}`. Les commandes déjà « livré » ne sont jamais modifiées.
- **alerte-gls-sans-scan** : colis dont l'étiquette a ≥ 24 h sans aucun événement autre que `DATA_RECEIVED` → 1 SMS/jour à Borhen (8 colis max) + copie complète sur Telegram, 1 alerte max par colis et par jour (`gls_alertes`), cache des colis pris en charge (`gls_colis`). Crons `alerte-gls-sans-scan-semaine` (18h Paris lun-ven) et `-samedi` (10h Paris), corps `{"creneau":true}`. Ignorer un colis : note « SANS SCAN OK 00Lxxxxx » (ou « SANS SCAN OK » seul = toute la commande). Test : `{"dryRun":true}`.
- Migration : `supabase/migrations/021_gls_preuves_livraison_avis_litiges.sql`.

## Demandes d'avis : suspension pendant un litige ou un SAV (règle du 28/09/2026)
- Code : `supabase/functions/_shared/avis-garde.ts` (+ `avis-gls.ts`), utilisé par `sms-avis` v2.0 et `sms-avis-relance` v2.1.
- **Aucune demande ni relance** si : note « PAS D AVIS » (manuel = définitif), commande non livrée, livraison GLS partielle/retour (colonne ou relecture GLS en direct juste avant l'envoi), litige ouvert (`litige_statut` non vide et pas `indemnise`/`refuse`), SAV ouvert lié (commande `#SAV…` non livrée/non annulée dont la note cite « cmd origine #NNNN »).
- **Reprise à la clôture** (litige clos — date posée automatiquement dans `litige_clos_at` par un déclencheur — et SAV liés livrés) : **une seule** demande d'avis à J+2 après la dernière clôture (fenêtre de 3 jours), **jamais de relance**. Si une demande était déjà partie avant le litige : rien de plus.
- Le libellé « PAS D AVIS - litige/SAV ouvert (JJ/MM/AAAA). » est une **suspension provisoire** : il bloque tant qu'aucune clôture n'est prouvée, puis il est ignoré (le texte de la note n'est pas modifié). Tout autre « PAS D AVIS » reste une exclusion définitive (mécontentement non résolu).
- Vérifier une liste : `sms-avis` / `sms-avis-relance` avec `{"cmdIds":["#NNNN",...]}` (toujours en test, rien n'est envoyé).

## Pièges connus
- PATCH Supabase via PowerShell : encoder le corps en UTF-8 (`[Text.Encoding]::UTF8.GetBytes`) et URL-encoder `#` en `%23`.
- Variables PowerShell insensibles à la casse (`$p` = `$P`) : ne pas réutiliser un nom pour deux valeurs (incident du 27/09 : chemin local publié à la place de la clé pendant 2 min).
- Agent d'impression (`print-agent/`) : voir le journal détaillé ; il lit `PRINT_AGENT_SUPABASE_KEY` dans `.env`.

Périmètre : l'app de livraison + GLS intégré (étiquettes, suivi). Le site Shopify, l'outil LBC et TikTok ont leurs propres dossiers.
