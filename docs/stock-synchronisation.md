# Synchronisation du stock app ↔ Shopify

État au 30/09/2026 : **préparé, rien n'est écrit dans Shopify**. La référence est un
**comptage physique horodaté** ; Shopify reçoit seulement la quantité « disponible à la vente ».

## Pièces

| Élément | Rôle | État |
|---|---|---|
| `stock_correspondance` (024, 025) | variante Shopify → produit app, `fiabilite` (certaine / incertaine / absente), `motif` | appliquée, remplie |
| `stock_comptage`, `stock_comptage_lignes` (025) | comptage (début, fin, statut brouillon/validé) et quantités comptées par produit | appliquée, vide |
| `stock_comptage_commandes` (025) | instantané figé à la validation : situation de chaque commande | appliquée |
| `stock_entrees` (025) | réassorts et retours **constatés au dépôt** après le comptage | appliquée, vide |
| `stock_sauvegarde_shopify` (025) | valeurs Shopify sauvegardées avant chaque écriture | appliquée |
| index unique `commandes_ref_shopify_unique` (026) | une commande du site ne peut pas être importée deux fois | appliqué |
| `shopify-sync` v7 | import avec `produitId` (correspondances **certaines** seulement) + annulations | code prêt, **non déployé** |
| `stock-sync-shopify` v2 | calcul, contrôle, écriture sur confirmation | déployée, **lecture seule par défaut** |

Toutes ces tables sont accessibles au serveur seulement (RLS sans politique ; l'éditeur de
tables du tableau de bord Supabase y a accès). Aucune donnée client.

## Règles

- **Aucune correspondance par supposition.** Seule une correspondance `certaine` (même taille,
  épaisseur, couleur, type de sommier) sert à l'import des commandes et à l'écriture Shopify.
  Une variante `incertaine` / `absente`, ou un ensemble dont **un seul** composant n'est pas
  compté ou pas relié `certaine`, est exclu de l'écriture et génère une alerte
  (`gls_alertes`, type `stock-correspondance`, clé stable `variante-<id>` / `composants-<id>`).
- **Une commande ne passe « livré »** que par gls-sync (tous les colis livrés) ou par une preuve de
  livraison RANOU. Shopify « fulfilled » = étiquette créée, **pas** une expédition.
- `produits.stock` n'est **plus** utilisé pour le calcul (modifié par le navigateur à la
  livraison, alors que gls-sync livre côté serveur sans déduction).

## Formule (recalculée entièrement à chaque passage : idempotente)

- Situation de chaque commande, figée à la validation du comptage :
  - `sortie_avant` : partie du dépôt avant `debut` (livrée un jour antérieur, tous les colis GLS
    pris en charge avant `debut`, chargée dans le camion avant `debut`) ;
  - `dans_stock` : encore au dépôt à `fin` ;
  - `a_verifier` : un mouvement (prise en charge GLS, livraison, chargement, retour, annulation)
    tombe **entre** `debut` et `fin`, ou suivi GLS illisible → alerte `stock-comptage`, produits
    concernés exclus de l'écriture jusqu'à décision.
- **disponible (produit simple)** = compté − Σ quantités des commandes **non annulées** qui
  consomment le stock compté (toutes sauf `sortie_avant`, y compris celles créées après le
  comptage et les commandes Shopify pas encore importées) + entrées de `stock_entrees` après `fin`.
- **disponible (ensemble)** = min(disponible composant ÷ quantité requise).
- **proposé Shopify « available »** = max(0, disponible). Négatif = survente (alerte).
- Une annulation retire simplement la commande de la somme ; une commande n'est comptée qu'une fois.
- Pas de double comptage avec Shopify : on fixe une valeur **absolue** d'« available » ; la
  commande du site non expédiée est dans « committed » chez Shopify, qui ne la retire pas une
  seconde fois d'« available ».
- Les retours (colis GLS revenus, reprises SAV, commandes revenues au dépôt après le comptage)
  ne sont **jamais** réintégrés automatiquement : alerte `stock-retour`, puis saisie dans
  `stock_entrees` une fois constatés au dépôt.
- `mouvements_stock` ne contient que des mouvements camion (`chargement`, `retour_depot`, par
  libellé) et aucune entrée fournisseur ; ces mouvements sont « bruités » (cocher/décocher crée
  des paires). Ils ne servent que pour les commandes non livrées ou livrées le jour du comptage.

## Procédure le jour du comptage

1. **Créer le comptage** (tableau de bord Supabase, table `stock_comptage`) : `debut` = heure
   de début réelle, `fin` = heure de fin réelle, `statut` = `brouillon`, `saisi_par`.
2. **Saisir les lignes** (`stock_comptage_lignes`) : une ligne par produit **simple** de l'app
   (matelas, sommier, lit, canapé…), `quantite` comptée. Ne pas compter les ensembles : ils sont
   calculés depuis leurs composants. Pour les doublons de l'app, compter sur le produit relié
   (pr11, pr12, pr31/pr32 à trancher).
3. **Aperçu** (rien écrit) : `{"apercu_comptage": <id>}` → liste `a_verifier` / `dans_stock`.
   Puis `{"comptage_id": <id>}` → tableau complet (brouillon, non figé).
4. **Valider** : `{"valider_comptage": <id>, "confirme": "valider"}` → instantané figé, comptage
   non modifiable. Trancher chaque `a_verifier` dans `stock_comptage_commandes` (`situation` =
   `sortie_avant` ou `dans_stock`, `decision_par`, `decision_at`).
5. **Lire le tableau** : `{}` ou `{"comptage_id": <id>}`. Par variante : compté, réservations
   restantes, disponible, Shopify actuel (available / committed / on_hand), proposé, fiabilité,
   exclusions, détail des composants pour un ensemble.
6. **Décider**. Pour écrire :
   `{"apply": true, "confirme": "apres-comptage", "comptage_id": <id>}` → sauvegarde des valeurs
   Shopify (`stock_sauvegarde_shopify`, `lot` renvoyé) puis écriture des seules variantes
   `certaine` non exclues. Refusé tant qu'une ligne de commande n'est pas reconnue (sauf
   `"accepter_lignes_non_reconnues": true`).

Appel (serveur, clé secrète) : `POST /functions/v1/stock-sync-shopify` avec le JSON ci-dessus.
Tester la chaîne sans comptage : `{"simulation": {"debut": "...", "fin": "..."}, "alertes": false}`
(quantités = ancien stock de l'app, jamais d'écriture).

## À faire avant la première écriture

1. Créer dans l'app les composants manquants (sommiers à lattes contour cuir PU par taille et
   couleur) et donner des composants exacts aux ensembles concernés ; puis passer les
   correspondances concernées en `certaine` (avec `motif`).
2. Relier les lignes de commande non reconnues (alertes `stock-ligne`).
3. Déployer `shopify-sync` v7 :
   `npx supabase@latest functions deploy shopify-sync --project-ref jmvfjtnmebstkzcfnlgp --no-verify-jwt --use-api`
4. Comptage (procédure ci-dessus), puis écriture. Cron éventuel plus tard, pas maintenant.

## Revenir en arrière

- Shopify : `{"restaurer": "<lot>", "confirme": "restaurer"}` remet les valeurs sauvegardées
  (compare-and-swap : une variante vendue entre-temps est signalée, pas écrasée).
- `shopify-sync` : redéployer la version précédente depuis git.
- Correspondance : repasser une variante en `incertaine` ou `actif = false`.
- Index 026 : `drop index public.commandes_ref_shopify_unique;`
