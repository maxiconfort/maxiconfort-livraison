# Synchronisation du stock app ↔ Shopify

État au 30/09/2026 : **préparé, rien n'est écrit dans Shopify**. La référence est un
**comptage physique horodaté** ; Shopify reçoit seulement la quantité « disponible à la vente ».
Correspondances : 55 variantes actives sur 62 reliées `certaine` ; 96 % des lignes des commandes
du site des 30 derniers jours reconnues (voir « Fiches créées le 30/09/2026 »).

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
   (pr11, pr12, pr31). Les sommiers à lattes créés le 30/09 se comptent par couleur.
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

1. ~~Créer les sommiers à lattes et les ensembles du site~~ : fait le 30/09 (voir ci-dessous).
   Reste : ensembles 90×190 et 90×200 (fiche Shopify à corriger), canapé Beige, lit DUO.
2. Relier les lignes de commande non reconnues (alertes `stock-ligne`).
3. Déployer `shopify-sync` v7 :
   `npx supabase@latest functions deploy shopify-sync --project-ref jmvfjtnmebstkzcfnlgp --no-verify-jwt --use-api`
4. Comptage (procédure ci-dessus), puis écriture. Cron éventuel plus tard, pas maintenant.

## Fiches créées le 30/09/2026 (références Shopify)

Chaque fiche a été créée depuis une variante Shopify active (id et SKU dans `remarque`), stock 0
(le stock réel vient du comptage). `dim` porte « (lattes, couleur) » : cela empêche la
« substitution auto » du navigateur (même catégorie + même dimension) de déduire un sommier
tapissier, ou l'autre couleur, à la place d'un sommier à lattes.

**Sommiers à lattes contour cuir PU** (correspondance `certaine` : identité variante/SKU)

| Fiche app | Variante Shopify | SKU |
|---|---|---|
| pr1790762534967 — 90×190 Noir | 62992955834698 | SOM-LAT-90X190-NOIR |
| pr1790762534968 — 90×190 Blanc | 62992955867466 | SOM-LAT-90X190-BLANC |
| pr1790762534969 — 90×200 Blanc | 62992956129610 | SOM-LAT-90X200-BLANC |
| pr1790762534971 — 120×190 Noir | 62992956621130 | SOM-LAT-120X190-NOIR |
| pr1790762534972 — 120×190 Blanc | 62992956653898 | SOM-LAT-120X190-BLANC |
| pr1790762534973 — 140×190 Noir | 62992956916042 | SOM-LAT-140X190-NOIR |
| pr1790762534974 — 140×190 Blanc | 62992956948810 | SOM-LAT-140X190-BLANC |
| pr1790762534975 — 140×200 Noir | 62992957768010 | SOM-LAT-140X200-NOIR |
| pr1790762534976 — 140×200 Blanc | 62992957800778 | SOM-LAT-140X200-BLANC |
| pr1790762534977 — 160×200 Noir | 62992958128458 | SOM-LAT-160X200-NOIR |
| pr1790762534978 — 160×200 Blanc | 62992958161226 | SOM-LAT-160X200-BLANC |
| pr1790762534970 — 180×200 Noir | 62992958751050 | SOM-LAT-180X200-NOIR |

**Ensembles du site** (« Ensemble site … », cat `Ensemble`, à ne pas compter). Ce ne sont pas
des bundles Shopify natifs (`requiresComponents` = false, aucun composant) : la preuve est la
fiche produit (blocs « Le matelas inclus » : épaisseur + dimension ; « Le sommier inclus » :
sommier à lattes, contour cuir PU noir ou blanc, dimension) + l'option « Coloris du sommier ».

| Fiches app (Blanc / Noir) | SKU | Composants |
|---|---|---|
| pr1790762534983 / pr1790762534984 | ENS-120X190-20-LAT-B / -N | pr10 + sommier 120×190 B / N |
| pr1790762534979 / pr1790762534980 | ENS-140X190-20-LAT-B / -N | pr11 + sommier 140×190 B / N |
| pr1790762534981 / pr1790762534982 | ENS-140X190-15-LAT-B / -N | pr1779102614273 + sommier 140×190 B / N |
| pr1790762534985 / pr1790762534986 | ENS-140X200-20-LAT-B / -N | pr1779883554429 + sommier 140×200 B / N |
| pr1790762534987 / pr1790762534988 | ENS-160X200-20-LAT-B / -N | pr12 + sommier 160×200 B / N |

Les ensembles de l'app pr06, pr08 et pr1780615649 (aussi utilisés pour Leboncoin) ne sont
**pas** modifiés : aucune preuve du sommier réellement vendu sur ce canal.

**En attente** (`incertaine` / `absente`, alerte maintenue) :
- Ensembles 90×190 (B/N) et 90×200 15 cm / 20 cm (B) : la fiche Shopify se contredit (bloc
  sommier « Contour : Tissu », méta-description « cuir PU »). Corriger la fiche, puis relier à
  une fiche « Ensemble site » [matelas + sommier à lattes de la couleur] et passer `certaine`.
- Canapé Beige : aucun canapé Beige dans l'app (ne pas relier au Marron pr02).
- Lit superposé DUO et pack DUO : couleur non indiquée sur Shopify.

**Doublons** (rien supprimé) : compter et relier sur pr11 et pr12 (composants de tous les
ensembles, commandes ouvertes, correspondances) ; prnew1780002607 / prnew1780002609 sont
inactifs et référencés nulle part. pr31 / pr32 : garder pr31 (1 commande ouverte, 10 au total) ;
pr32 n'a aucune commande ouverte ni rôle de composant (stock app 2 : à reporter au comptage).

**Alertes** : `gls_alertes` n'a pas d'état « fermée » ; les alertes des variantes devenues
`certaine` (et les alertes `stock-ligne` qui les citaient) ont été préfixées
`[RÉSOLUE 30/09/2026 …]`, sans suppression.

## Revenir en arrière

- Shopify : `{"restaurer": "<lot>", "confirme": "restaurer"}` remet les valeurs sauvegardées
  (compare-and-swap : une variante vendue entre-temps est signalée, pas écrasée).
- `shopify-sync` : redéployer la version précédente depuis git.
- Correspondance : repasser une variante en `incertaine` ou `actif = false`.
- Index 026 : `drop index public.commandes_ref_shopify_unique;`
