# Synchronisation du stock app ↔ Shopify

État au 30/09/2026 : **préparé, rien n'écrit dans Shopify**. Le stock de l'app est la
référence ; Shopify reçoit seulement la quantité « disponible à la vente ».

## Pièces

| Élément | Rôle | État |
|---|---|---|
| Table `stock_correspondance` (migration 024) | variante Shopify → produit de l'app (`app_produit_id`), `actif`, `note` | créée, pré-remplie |
| `shopify-sync` v7 | import des commandes du site avec `produitId` + propagation des annulations | code prêt, **non déployé** |
| `stock-sync-shopify` | calcule (et, sur confirmation, écrit) la quantité « available » de Shopify | déployée, **lecture seule par défaut** |
| `_shared/stock-logique.ts` | calculs purs (testables sous Node) | — |

La table n'est accessible qu'au serveur (RLS sans politique publique).

## Formule

- **Réservé** d'un produit simple = somme des quantités des commandes de l'app **ni livrées
  ni annulées** (tous canaux : site, Leboncoin, TikTok, SAV…) dont le stock n'est pas encore
  déduit. Une ligne « ensemble » réserve ses composants. Les lignes du site importées sans
  `produitId` sont reliées via la commande Shopify. S'y ajoutent les commandes Shopify
  ouvertes pas encore importées.
- **Disponible** simple = stock − réservé ; ensemble = min(disponible composant ÷ quantité requise).
- **Cible Shopify « available »** = max(0, disponible). Négatif = survente signalée.

Pas de double comptage : on fixe une valeur **absolue** (idempotent). Une commande du site
non expédiée est dans « committed » chez Shopify et « réservée » dans l'app : comme on écrit
`available = disponible app` (et non `disponible − committed`), elle n'est retirée qu'une fois.
Les bundles Shopify (« Pack … ») ne sont jamais écrits : Shopify les calcule depuis leurs composants.

## Appels (serveur, clé secrète)

```
POST /functions/v1/stock-sync-shopify   {}                                         -> tableau, rien écrit
POST /functions/v1/stock-sync-shopify   {"apply":true,"confirme":"apres-comptage"} -> écrit
POST /functions/v1/shopify-sync         {"dryRun":true,"jours":30}                 -> liste seulement
```

## À faire après le comptage (dans l'ordre)

1. **Créer les composants manquants** dans l'app : sommiers à lattes contour cuir PU par taille
   et couleur (90×190 N/B, 90×200 B, 120×190 N/B, 140×190 N/B, 140×200 N/B, 160×200 N/B,
   180×200 N) ; donner des composants aux ensembles qui n'en ont pas (140×190 15 cm,
   140×200 20 cm, 160×200 20 cm) ; supprimer les doublons (matelas 140×190×20 et
   160×200×20 en double, sommier tapissier 160×200 en double).
2. **Compléter `stock_correspondance`** (variantes sans produit, et notes « approx. » : les
   ensembles N/B doivent pointer vers un ensemble dont le sommier a la bonne couleur).
3. **Nettoyer les statuts** : passer « livré » les commandes déjà parties (étiquette GLS faite
   mais encore « en attente » dans l'app — listées par `stock-sync-shopify` dans
   `site_expediees_non_livrees`). Sinon elles restent réservées et seront déduites une 2e fois
   à la livraison alors qu'elles ne sont plus dans le stock compté.
4. **Saisir le stock compté** dans l'app.
5. **Déployer `shopify-sync` v7** :
   `npx supabase@latest functions deploy shopify-sync --project-ref jmvfjtnmebstkzcfnlgp --no-verify-jwt --use-api`
6. **Lancer `stock-sync-shopify` sans apply**, relire le tableau (aucune survente, écarts cohérents),
   puis avec `{"apply":true,"confirme":"apres-comptage"}`.
7. **Cron toutes les 15 min** (nouvelle migration) : `*/15 * * * *` →
   `interne.appel_fonction('stock-sync-shopify', '{"apply":true,"confirme":"apres-comptage"}'::jsonb, 150000)`.

## Revenir en arrière

- Cron : `select cron.unschedule('<nom du job>');`
- `shopify-sync` : redéployer la version précédente (`git checkout <commit v6> -- supabase/functions/shopify-sync`
  puis déployer). Les commandes déjà importées gardent leur `produitId` (sans effet négatif).
- Shopify : les écritures sont des « corrections » d'« available » (historique d'inventaire Shopify,
  référence `gid://maxiconfort-livraison/StockSync/…`) ; on peut remettre les quantités à la main
  ou désactiver le suivi. Aucune écriture n'a eu lieu avant la validation du comptage.
- Correspondance : mettre `actif = false` sur une variante pour l'exclure, ou vider `app_produit_id`.
