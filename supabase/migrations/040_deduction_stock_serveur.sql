-- 040 (26/11/2026, révisée le 27/11 : règle des 10 retours, relecture complète) : STOCK — les mouvements de stock de
-- l'application passent PAR LA BASE (décision de Borhen du 26/11/2026, « GO » à la solution A, confirmé à 22 h 15 ; PR 29) :
--   * le retrait d'une livraison, UNE SEULE FOIS par commande (public.deduire_stock_livraison) ;
--   * le recrédit à l'annulation, calculé depuis les sorties RÉELLEMENT journalisées (public.recrediter_stock_livraison) ;
--   * les entrées / sorties / corrections manuelles du bureau (public.mouvement_stock_produit).
--
-- RETOUR ARRIÈRE (à exécuter tel quel dans l'éditeur SQL si besoin ; ne supprime ni ne modifie aucune donnée de stock ni
-- aucune commande) :
--   drop trigger if exists commandes_stock_deduit_garde on public.commandes;
--   drop trigger if exists produits_stock_garde on public.produits;
--   drop function if exists interne.l040_stock_deduit_garde();
--   drop function if exists interne.l040_stock_garde();
--   drop function if exists public.mouvement_stock_produit(text, text, integer, text, text);
--   drop function if exists public.recrediter_stock_livraison(text, boolean);
--   drop function if exists public.deduire_stock_livraison(text);
--   drop function if exists interne.l040_rejeu(text, text);
--   drop function if exists interne.l040_stocks(text[]);
--   drop function if exists interne.l040_verrous_requis(text[]);
--   drop function if exists interne.l040_par_fonction();
--   drop function if exists interne.l040_strict();
--   drop function if exists interne.l040_trouver_produit(text, text);
--   drop function if exists interne.l040_dim_compatible(text, text);
--   drop function if exists interne.l040_dim(text);
--   drop function if exists interne.l040_qte(jsonb);
--   drop function if exists interne.l040_qte_max();   -- v7.5.206 (branche du dropshipping, PR 30) : borne ligne × composant
--   (Les tables public.stock_sorties_livraison, public.stock_operations et interne.l040_reglages peuvent rester : ce sont
--    des journaux et un réglage ; les supprimer n'efface aucun stock.)
--   Puis revenir à l'application v7.5.196 (elle calcule de nouveau le stock sur le téléphone).
--
-- ORDRE DE MISE EN SERVICE (obligatoire) : 038b (PR 24) → 039 (PR 26) → CETTE 040 → PUIS l'application v7.5.198 (PR 29),
-- puis, quand TOUS les téléphones sont en v7.5.198, le MODE STRICT (une ligne SQL, voir « COMPATIBILITÉ »).
-- Appli v7.5.198 en ligne sans la 040 : rien n'est perdu (demandes gardées en file sur les téléphones, rejouées dès que
-- les fonctions existent ; « mise à jour de la base en attente » affiché une fois), mais aucun stock ne bouge entre-temps.
--
-- PROBLÈME (10 retours de Codex sur la PR 29) : le téléphone calculait le nouveau stock (stock lu − quantité) et l'envoyait
-- en valeur absolue. Un envoi au résultat incertain (réponse perdue, application fermée pendant l'envoi, deux appareils) ne
-- peut être ni rejoué sans risquer un double effet, ni abandonné sans risquer une perte ; et une fiche produit envoyée avec
-- un stock lu plus tôt écrase un mouvement plus récent. Un téléphone ne peut pas garantir cela SEUL.
--
-- 1. DÉDUCTION — public.deduire_stock_livraison(p_cmd_id), une seule transaction :
--   a. session vérifiée (admin, collaboratrice, ou livreur PROPRIÉTAIRE de la commande, même règle que la politique
--      sess_livreur de la migration 019 : livreur de la commande = livreur de la session, date de livraison à ±2 jours) ;
--      une commande d'un autre livreur répond « commande_introuvable » (comme la politique : elle lui est invisible) ;
--   b. verrou de la commande (verrou consultatif par identifiant, puis FOR UPDATE de la ligne) : deux appels simultanés
--      s'attendent ; le second voit stock_deduit = vrai ;
--   c. stock_deduit déjà vrai → { ok: true, deja: true } SANS RIEN TOUCHER, AVEC le résultat COMPLET de la première
--      déduction (retraits, manques, produits introuvables) conservé dans public.stock_operations et restitué à l'identique
--      (réserve Codex n° 1 sur f25b1f1 : une réponse perdue ne fait plus perdre l'alerte d'insuffisance) ; stocks_actuels
--      donne le stock courant des produits retirés ;
--   d. commande pas « livré » → refus clair { ok: false, erreur: 'commande_non_livree' } (rien n'est touché) ;
--   e. VERROUS STABLES (réserve Codex n° 4) : produits des lignes verrouillés (ordre des identifiants), PUIS composition
--      des ensembles et catégories des composants relues SOUS VERROU ; si elles demandent d'autres produits, les verrous
--      sont relâchés (sous-transaction annulée) et repris sur l'ensemble agrandi, toujours dans l'ordre des identifiants
--      (au plus 6 passes ; sinon « composition_instable », rien n'est touché, l'appli renvoie plus tard). Aucun verrou
--      n'est donc jamais pris hors ordre, et toutes les lectures utilisées sont faites sous verrou ; un substitut n'est
--      choisi que parmi les produits verrouillés ;
--   f. quantités calculées comme stkDeduireStock de l'application v7.5.196 (voir « FIDÉLITÉ ») ; stock jamais négatif :
--      nouveau stock = max(0, stock − quantité) ; ce qui manque est renvoyé (manques) ;
--   g. chaque sortie est écrite dans le journal public.stock_sorties_livraison (ajout seul) et le résultat complet dans
--      public.stock_operations ; stock_deduit = vrai ; tout ou rien (la moindre erreur annule tout).
--   Réponse : { ok, deja, stock_deduit, operation_id, retraits: [{produit_id, nom, qte, demande, stock_avant, stock_apres,
--   composant_de, substitue_de}], manques: [{produit_id, nom, raison, demande, retire, manque}], stocks_actuels: {id: stock} }.
--
-- 2. RECRÉDIT — public.recrediter_stock_livraison(p_cmd_id, p_suppression) (réserve Codex n° 2) : administrateur ou
--   collaboratrice ; même verrou que la déduction. Rend au stock EXACTEMENT les quantités sorties par la dernière déduction
--   de la commande (journal stock_sorties_livraison : produit réellement retiré, substitut compris, quantité réellement
--   retirée — un retrait partiel ne rend que ce qui a été retiré), remet stock_deduit à faux, écrit l'opération. UNE SEULE
--   FOIS par déduction : rejoué, il répond « deja » avec le même résultat. Refus : commande encore « livré » en base
--   (« commande_encore_livree » : le statut doit être enregistré avant), commande déduite par une ANCIENNE version de
--   l'appli (« sans_journal » : quantités inconnues, rien n'est touché, à corriger à la main). p_suppression = vrai
--   (suppression d'une commande livrée) : la commande encore présente est SUPPRIMÉE PAR LA FONCTION, dans la même
--   transaction, avant le recrédit (v7.5.208, avis chatgpt-review sur 8905a30 : jamais de recrédit pour une commande qui
--   reste livrée ; suppression refusée par la base → « suppression_refusee », rien n'est recrédité) ; commande déjà
--   supprimée : recrédit depuis le journal. v7.5.209 (avis chatgpt-review sur 3fefbc9) : commande supprimée par la fonction
--   alors qu'elle était déduite ou livrée SANS déduction journalisée (ancienne version de l'appli) : suppression maintenue,
--   rien recrédité, réponse { ok, recredit_manuel_requis: true, produits: [{produit_id, nom, qte}] } écrite au journal
--   stock_operations (rejouée à l'identique) ; l'appli prévient le bureau (recrédit à faire à la main).
--
-- 3. MOUVEMENT MANUEL — public.mouvement_stock_produit(p_produit_id, p_type, p_qte, p_motif, p_cle) (réserve Codex n° 3) :
--   administrateur ou collaboratrice ; entree / retour (+qte), sortie (−qte, jamais sous 0), correction (stock = qte,
--   correction explicite du bureau). Calculé PAR LA BASE sur le stock verrouillé (jamais une valeur lue plus tôt) ;
--   IDEMPOTENT par la clé p_cle choisie par l'appareil (rejoué : « deja », même résultat).
--
-- 4. GARDES (déclencheurs ; ils ne REFUSENT JAMAIS une écriture : aucune erreur, aucun code HTTP nouveau) :
--   * commandes_stock_deduit_garde : stock_deduit VRAI → FAUX n'est accepté que de la fonction de recrédit. Une sauvegarde
--     ordinaire (POST merge-duplicates d'une commande, file rejouée, ancien téléphone, copie périmée de l'administrateur)
--     qui renverrait faux est corrigée en vrai, le reste de l'écriture est enregistré (sinon une demande renvoyée déduirait
--     une 2e fois). L'appli v7.5.198 n'envoie plus du tout stock_deduit (champ tenu par la base). L'en-tête
--     x-stock-recredit de la version précédente de cette PR est SUPPRIMÉ (remplacé par la fonction de recrédit).
--   * produits_stock_garde : en MODE STRICT, une écriture d'une session de l'application qui change produits.stock hors des
--     fonctions ci-dessus est ignorée pour ce champ (le reste de la fiche est enregistré) ; en mode strict, stock_deduit
--     FAUX → VRAI hors fonction est aussi ignoré.
--   COMPATIBILITÉ (mode TRANSITOIRE, par défaut) : les téléphones encore en v7.5.196 / v7.5.197 calculent et écrivent
--   eux-mêmes le stock et posent stock_deduit = vrai : ces écritures restent ACCEPTÉES (sinon leurs livraisons seraient
--   perdues). L'appli v7.5.198, elle, n'écrit plus JAMAIS le stock d'une fiche existante (fiches envoyées sans le champ
--   stock, sauf à la création ; mouvements par la fonction). Quand tous les téléphones sont en v7.5.198, passer en mode
--   strict (une ligne, réversible avec actif = false) :
--     update interne.l040_reglages set actif = true where cle = 'strict_toutes_versions';
--   Les programmes serveur (sans session de l'application : stock-sync-shopify, JARVIS, éditeur SQL) ne sont jamais
--   concernés.
--
-- FIDÉLITÉ à stkDeduireStock (application v7.5.196) :
--   * lignes de la commande (commandes.lignes : produitId, nom ou produit, qte) ; sans lignes : commandes.produit + qte ;
--   * quantité = max(1, partie entière de qte) (Math.max(1, parseInt(qte) || 1)) ;
--   * produit retrouvé par son identifiant, sinon par son nom (repli de stkTrouverProduit : nom identique, ou nom de la ligne
--     qui contient le nom du produit, ou nom du produit qui contient les deux premiers mots de la ligne ; produits actifs) ;
--   * ENSEMBLE (produits.composants non vide) : ce sont ses COMPOSANTS qui sont retirés (qte du composant × quantité),
--     jamais l'ensemble lui-même ; pas de descente dans un composant qui serait lui-même un ensemble (comme l'appli) ;
--   * SUBSTITUTION AUTOMATIQUE : composant en stock insuffisant → produit de même catégorie, même dimension (même règle de
--     comparaison que l'appli), actif, dont le stock suffit ;
--   * produit ou composant introuvable : ignoré (comme l'appli), mais SIGNALÉ dans « manques » (raison) et conservé.
--   DIFFÉRENCES VOULUES (plus sûres), documentées :
--   * à égalité, le plus petit identifiant (ordre stable, le même sur tous les appareils) ; un nom identique passe avant un
--     nom seulement « contenu » ; un produit au nom vide ne « correspond » plus à n'importe quelle ligne ;
--   * l'identifiant d'un produit désactivé est reconnu (l'appli ne chargeait que les produits actifs) ;
--   * substitution : jamais un produit « non vendable » (colonne vendable de la 039, si elle existe), et seulement parmi les
--     produits verrouillés (catégorie lue sous verrou) ;
--   * le journal est écrit EN BASE (l'appli ne gardait ses « sorties livraison » qu'en mémoire).
--
-- JOURNAUX : public.stock_sorties_livraison (une ligne par produit retiré) et public.stock_operations (une ligne par
-- opération : déduction, recrédit, mouvement ; résultat complet). mouvements_stock n'est PAS utilisée : elle ne contient
-- que des mouvements camion (migration 025) lus par stock-sync-shopify et JARVIS. Lecture : administrateur et
-- collaboratrice ; écriture : uniquement par les fonctions ; ni modification ni suppression.
--
-- LIMITES : la règle des ±2 jours du livreur s'applique aussi ici (téléphone hors ligne plus de 2 jours après la date de
-- livraison : demande refusée, à faire par le bureau). En mode transitoire, un téléphone en ANCIENNE version peut encore
-- écrire un stock périmé (comme avant la 040) : d'où le mode strict dès que tous les téléphones sont à jour. Le verrouillage
-- concurrent n'a été vérifié que sur une base jetable à UNE connexion (pglite) : l'ordre des verrous et la relecture sous
-- verrou sont vérifiés dans le texte des fonctions et par des modifications faites entre deux appels.
-- Aucune donnée existante n'est modifiée par cette migration.

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 1. Journaux (ajout seul) et réglage du mode strict
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.stock_sorties_livraison (
  id bigint generated always as identity primary key,
  cmd_id text not null,
  produit_id text not null,
  produit_nom text,
  qte_demandee integer not null check (qte_demandee >= 1),
  qte_retiree integer not null check (qte_retiree >= 0),
  stock_avant integer,
  stock_apres integer not null check (stock_apres >= 0),
  composant_de text,          -- identifiant de l'ensemble livré quand le produit retiré est un de ses composants
  substitue_de text,          -- identifiant du composant en rupture remplacé automatiquement par ce produit
  acteur text,                -- rôle de la session (et livreur) qui a demandé la déduction
  cree_at timestamptz not null default now()
);
create index if not exists stock_sorties_livraison_cmd_idx on public.stock_sorties_livraison (cmd_id, id);
comment on table public.stock_sorties_livraison is 'Sorties de stock des livraisons, écrites UNIQUEMENT par public.deduire_stock_livraison (migration 040). Ajout seul.';

create table if not exists public.stock_operations (
  id bigint generated always as identity primary key,
  nature text not null check (nature in ('deduction', 'recredit', 'mouvement')),
  cmd_id text,                -- déduction / recrédit
  produit_id text,            -- mouvement manuel
  cle text unique,            -- mouvement manuel : clé d'idempotence choisie par l'appareil
  sortie_max bigint,          -- dernière sortie (stock_sorties_livraison.id) couverte par cette déduction / ce recrédit
  resultat jsonb not null,    -- résultat COMPLET renvoyé à l'appareil (restitué à l'identique en cas de rejeu)
  acteur text,
  cree_at timestamptz not null default now()
);
create index if not exists stock_operations_cmd_idx on public.stock_operations (cmd_id, id);
comment on table public.stock_operations is 'Opérations de stock de l''application (déduction, recrédit, mouvement manuel), écrites UNIQUEMENT par les fonctions de la migration 040. Ajout seul.';

do $$
declare t text;
begin
  foreach t in array array['stock_sorties_livraison', 'stock_operations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('revoke all on sequence public.%I from public, anon, authenticated', t || '_id_seq');
    execute format('grant select on table public.%I to anon', t);
    execute format('drop policy if exists sess_lecture on public.%I', t);
    execute format('create policy sess_lecture on public.%I for select to anon using ((select public.session_role()) in (''admin'', ''collab''))', t);
  end loop;
end $$;

create or replace function interne.l040_journal_fige() returns trigger
language plpgsql as $$
begin
  raise exception '% : ajout seul (ni modification ni suppression)', tg_table_name;
end $$;
drop trigger if exists stock_sorties_livraison_fige on public.stock_sorties_livraison;
create trigger stock_sorties_livraison_fige before update or delete on public.stock_sorties_livraison
  for each row execute function interne.l040_journal_fige();
drop trigger if exists stock_operations_fige on public.stock_operations;
create trigger stock_operations_fige before update or delete on public.stock_operations
  for each row execute function interne.l040_journal_fige();

-- réglage : mode strict (faux = transitoire, compatible avec les téléphones en ancienne version) ; schéma interne, aucun
-- accès pour les sessions de l'application ; une 2e application de la 040 ne change pas un réglage déjà posé
create table if not exists interne.l040_reglages (cle text primary key, actif boolean not null default false);
insert into interne.l040_reglages (cle, actif) values ('strict_toutes_versions', false) on conflict (cle) do nothing;
revoke all on table interne.l040_reglages from public, anon, authenticated;

create or replace function interne.l040_strict() returns boolean
language sql stable security definer set search_path = interne, pg_catalog as $$
  select coalesce((select actif from interne.l040_reglages where cle = 'strict_toutes_versions'), false)
$$;
-- vrai seulement pendant une écriture faite PAR une fonction de cette migration (réglage local à la transaction, posé
-- juste avant et effacé juste après ; une requête de l'application ne peut pas le poser)
create or replace function interne.l040_par_fonction() returns boolean
language sql stable set search_path = pg_catalog as $$ select coalesce(current_setting('l040.fonction', true), '') = '1' $$;
revoke all on function interne.l040_strict(), interne.l040_par_fonction() from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 2. Fonctions PURES et utilitaires (reproduction des règles de l'application ; auto-contrôle de la section 8)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- quantité = Math.max(1, parseInt(qte) || 1) : partie entière en tête du texte, 1 si absente, nulle ou négative (bornée)
create or replace function interne.l040_qte(p jsonb) returns integer
language plpgsql immutable set search_path = pg_catalog as $$
declare t text; m text;
begin
  if p is null or jsonb_typeof(p) = 'null' then return 1; end if;
  t := btrim(case when jsonb_typeof(p) = 'string' then p #>> '{}' else p::text end);
  m := substring(t from '^[+-]?[0-9]+');
  if m is null then return 1; end if;
  return greatest(1, least(m::numeric, 1000000))::integer;
end $$;
-- v7.5.206 : borne d'une quantité demandée (ligne simple, ou ligne × composant d'un ensemble)
create or replace function interne.l040_qte_max() returns integer language sql immutable as $$ select 1000000 $$;

-- dimension normalisée comme l'appli : minuscules, sans espaces
create or replace function interne.l040_dim(p text) returns text
language sql immutable set search_path = pg_catalog as $$ select regexp_replace(lower(coalesce(p, '')), '\s+', '', 'g') $$;

-- même dimension (règle de l'appli) : dimension du substitut qui CONTIENT « largeur×longueur » de la référence, sinon égalité
create or replace function interne.l040_dim_compatible(p_ref text, p_x text) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select case
    when p_ref <> '' and p_x <> '' and position('×' in p_ref) > 0
         and position((split_part(p_ref, '×', 1) || '×' || split_part(p_ref, '×', 2)) in p_x) > 0 then true
    else p_x = p_ref end
$$;

-- produit d'une ligne (stkTrouverProduit) : identifiant, sinon nom ; à égalité le plus petit identifiant
create or replace function interne.l040_trouver_produit(p_id text, p_nom text) returns text
language plpgsql stable security definer set search_path = public, pg_catalog as $$
declare r text; deux text;
begin
  if coalesce(p_id, '') <> '' then
    select id into r from public.produits where id = p_id;
    if found then return r; end if;
  end if;
  if coalesce(p_nom, '') = '' then return null; end if;
  select id into r from public.produits where coalesce(actif, true) and nom = p_nom order by id limit 1;
  if found then return r; end if;
  deux := array_to_string((string_to_array(p_nom, ' '))[1:2], ' ');
  select id into r from public.produits
   where coalesce(actif, true) and coalesce(nom, '') <> ''
     and (position(nom in p_nom) > 0 or (deux <> '' and position(deux in nom) > 0))
   order by id limit 1;
  return r;
end $$;

-- produits à verrouiller pour livrer les produits p_lignes, lus dans leur état COURANT (appelée sous verrou) : les
-- produits des lignes, les composants des ensembles, et les substituts possibles (produits des mêmes catégories)
create or replace function interne.l040_verrous_requis(p_lignes text[]) returns text[]
language sql stable security definer set search_path = public, pg_catalog as $$
  with comp as (
    select distinct e ->> 'id' as id
      from public.produits p, jsonb_array_elements(case when jsonb_typeof(p.composants) = 'array' then p.composants else '[]'::jsonb end) e
     where p.id = any (p_lignes) and coalesce(e ->> 'id', '') <> ''
  ), cats as (
    select distinct coalesce(x.cat, '') as cat from public.produits x where x.id in (select id from comp)
  )
  select coalesce(array_agg(distinct u order by u), '{}') from (
    select unnest(p_lignes) as u
    union select id from comp
    union select x.id from public.produits x where coalesce(x.cat, '') in (select cat from cats)
  ) t where u is not null
$$;

-- stock courant des produits (réponse : stocks_actuels)
create or replace function interne.l040_stocks(p_ids text[]) returns jsonb
language sql stable security definer set search_path = public, pg_catalog as $$
  select coalesce(jsonb_object_agg(id, stock), '{}'::jsonb) from public.produits where id = any (coalesce(p_ids, '{}'))
$$;

-- rejeu : résultat COMPLET de la dernière opération de la commande, si elle est de la nature demandée
create or replace function interne.l040_rejeu(p_cmd text, p_nature text) returns json
language plpgsql stable security definer set search_path = public, interne, pg_catalog as $$
declare o record; v_ids text[];
begin
  select id, nature, resultat into o from public.stock_operations
   where cmd_id = p_cmd and nature in ('deduction', 'recredit') order by id desc limit 1;
  if found and o.nature = p_nature then
    select array_agg(x ->> 'produit_id') into v_ids
      from jsonb_array_elements(coalesce(o.resultat -> 'retraits', o.resultat -> 'retours', '[]'::jsonb)) x;
    return (o.resultat || jsonb_build_object('ok', true, 'deja', true, 'stock_deduit', p_nature = 'deduction',
      'operation_id', o.id, 'stocks_actuels', interne.l040_stocks(v_ids)))::json;
  end if;
  -- rien de connu (ancienne version de l'appli, ou rien à faire) : déjà dans l'état demandé, rien n'est touché
  return json_build_object('ok', true, 'deja', true, 'stock_deduit', p_nature = 'deduction', 'resultat_inconnu', true,
    'retraits', '[]'::json, 'manques', '[]'::json, 'retours', '[]'::json, 'stocks_actuels', '{}'::json);
end $$;
revoke all on function interne.l040_trouver_produit(text, text), interne.l040_verrous_requis(text[]),
  interne.l040_stocks(text[]), interne.l040_rejeu(text, text) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 3. Déduction du stock d'une livraison (une seule fois par commande, tout ou rien)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.deduire_stock_livraison(p_cmd_id text) returns json
language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
declare
  v_role text := public.session_role();
  v_liv text := public.session_livreur();
  v_acteur text;
  c record; p record; cp record; s record;
  v_lignes jsonb := '[]'::jsonb;   -- [{id (résolu ou null), produitId, nom, qte}]
  l jsonb; e jsonb;
  v_ids_lignes text[] := '{}';
  v_ids text[] := '{}';
  v_requis text[];
  v_stable boolean := false;
  v_pid text; v_q integer; v_req integer; v_av integer; v_ap integer; v_ret integer; v_hb jsonb;
  v_cible text; v_sub text;
  v_retraits jsonb := '[]'::jsonb;
  v_manques jsonb := '[]'::jsonb;
  v_res jsonb; v_op bigint; v_touches text[];
begin
  if v_role is null or v_role not in ('admin', 'collab', 'livreur') then
    return json_build_object('ok', false, 'erreur', 'session_requise');
  end if;
  if coalesce(btrim(p_cmd_id), '') = '' then return json_build_object('ok', false, 'erreur', 'commande_requise'); end if;
  v_acteur := v_role || coalesce(':' || v_liv, '');

  -- (b) verrou de la commande (même verrou que le recrédit, même ordre : consultatif puis ligne)
  perform pg_advisory_xact_lock(hashtext('l040|' || p_cmd_id));
  -- (a) commande visible par la session (même règle que les politiques sess_*), VERROUILLÉE
  select id, statut, stock_deduit, lignes, produit, qte into c from public.commandes
   where id = p_cmd_id
     and (v_role <> 'livreur'
          or (v_liv is not null and upper(coalesce(livreur, '')) = v_liv
              and coalesce(date_livraison, '') >= to_char(current_date - 2, 'YYYY-MM-DD')
              and coalesce(date_livraison, '') <= to_char(current_date + 2, 'YYYY-MM-DD')))
   for update;
  if not found then return json_build_object('ok', false, 'erreur', 'commande_introuvable'); end if;

  -- (c) déjà déduite : rien n'est touché ; résultat complet de la première déduction restitué (idempotent)
  if coalesce(c.stock_deduit, false) then return interne.l040_rejeu(c.id, 'deduction'); end if;
  -- (d) seulement une commande livrée
  if coalesce(c.statut, '') not in ('livré', 'livre') then
    return json_build_object('ok', false, 'erreur', 'commande_non_livree', 'statut', c.statut);
  end if;

  -- lignes de la commande et produits concernés (identité seulement, aucun stock lu ici)
  if jsonb_typeof(c.lignes) = 'array' and jsonb_array_length(c.lignes) > 0 then
    for l in select x.value from jsonb_array_elements(c.lignes) with ordinality as x(value, n) order by x.n loop
      if jsonb_typeof(l) <> 'object' then continue; end if;
      v_lignes := v_lignes || jsonb_build_array(jsonb_build_object(
        'id', interne.l040_trouver_produit(l ->> 'produitId', coalesce(nullif(l ->> 'nom', ''), l ->> 'produit')),
        'produitId', l ->> 'produitId', 'nom', coalesce(nullif(l ->> 'nom', ''), l ->> 'produit'), 'qte', l -> 'qte'));
    end loop;
  else
    v_lignes := jsonb_build_array(jsonb_build_object(
      'id', interne.l040_trouver_produit(null, c.produit), 'produitId', null, 'nom', c.produit, 'qte', to_jsonb(c.qte)));
  end if;
  select coalesce(array_agg(distinct x ->> 'id' order by x ->> 'id'), '{}') into v_ids_lignes
    from jsonb_array_elements(v_lignes) x where x ->> 'id' is not null;

  -- (e) VERROUS STABLES : verrouiller (ordre des identifiants), relire la composition SOUS VERROU ; s'il manque des
  -- produits, annuler la sous-transaction (verrous de la passe relâchés) et recommencer avec l'ensemble agrandi
  v_ids := v_ids_lignes;
  for k in 1..6 loop
    begin
      perform 1 from public.produits where id = any (v_ids) order by id for update;
      v_requis := interne.l040_verrous_requis(v_ids_lignes);
      if v_requis <@ v_ids then v_stable := true; exit; end if;
      v_ids := array(select distinct u from unnest(v_ids || v_requis) u order by u);
      raise exception using errcode = 'L4001', message = 'l040_recommencer';
    exception when sqlstate 'L4001' then null;
    end;
  end loop;
  if not v_stable then return json_build_object('ok', false, 'erreur', 'composition_instable'); end if;

  -- v7.5.206 (avis chatgpt-review sur c22dacd, point 1) : BORNE du produit « quantité de la ligne × quantité du composant »
  -- d'un ensemble (chacune bornée à 1 000 000 par l040_qte) : calculé en bigint AVANT toute écriture et refusé au-delà de
  -- 1 000 000 (même borne qu'une ligne simple) — avant, au-delà de 2 147 483 647 la multiplication en integer échouait.
  select jsonb_agg(jsonb_build_object('produit_id', zl ->> 'id', 'composant', zc ->> 'id',
           'demande', interne.l040_qte(zc -> 'qte')::bigint * interne.l040_qte(zl -> 'qte')::bigint)) into v_hb
    from jsonb_array_elements(v_lignes) zl
    join public.produits pe on pe.id = zl ->> 'id' and jsonb_typeof(pe.composants) = 'array'
    cross join lateral jsonb_array_elements(pe.composants) zc
   where coalesce(zc ->> 'id', '') <> ''
     and interne.l040_qte(zc -> 'qte')::bigint * interne.l040_qte(zl -> 'qte')::bigint > interne.l040_qte_max();
  if v_hb is not null then
    return json_build_object('ok', false, 'erreur', 'quantite_hors_borne', 'detail', v_hb, 'max', interne.l040_qte_max());
  end if;

  -- (f)(g) retraits, ligne par ligne, dans l'ordre de la commande (toutes les lectures APRÈS les verrous)
  perform set_config('l040.fonction', '1', true);
  for l in select x.value from jsonb_array_elements(v_lignes) with ordinality as x(value, n) order by x.n loop
    v_q := interne.l040_qte(l -> 'qte');
    v_pid := l ->> 'id';
    if v_pid is null then
      v_manques := v_manques || jsonb_build_array(jsonb_build_object('produit_id', l ->> 'produitId', 'nom', l ->> 'nom',
        'raison', 'produit_introuvable', 'demande', v_q, 'retire', 0, 'manque', v_q));
      continue;
    end if;
    select id, nom, composants into p from public.produits where id = v_pid;
    if jsonb_typeof(p.composants) = 'array' and jsonb_array_length(p.composants) > 0 then
      -- ENSEMBLE : ses composants sont retirés, jamais l'ensemble lui-même
      for e in select x.value from jsonb_array_elements(p.composants) with ordinality as x(value, n) order by x.n loop
        if coalesce(e ->> 'id', '') = '' then continue; end if;
        select id, nom, cat, dim, stock into cp from public.produits where id = (e ->> 'id');
        if not found then
          v_manques := v_manques || jsonb_build_array(jsonb_build_object('produit_id', e ->> 'id', 'nom', null,
            'raison', 'composant_introuvable', 'composant_de', p.id, 'demande', interne.l040_qte(e -> 'qte') * v_q, 'retire', 0,
            'manque', interne.l040_qte(e -> 'qte') * v_q));
          continue;
        end if;
        v_req := interne.l040_qte(e -> 'qte') * v_q;
        v_cible := cp.id; v_sub := null;
        if coalesce(cp.stock, 0) < v_req then
          -- SUBSTITUTION AUTOMATIQUE (règle de l'appli) parmi les produits VERROUILLÉS : même catégorie, même dimension,
          -- actif, vendable, stock suffisant
          select x.id into s from public.produits x
           where x.id = any (v_ids) and x.id <> cp.id and coalesce(x.actif, true) and x.cat is not distinct from cp.cat
             and coalesce((to_jsonb(x) ->> 'vendable')::boolean, true)
             and interne.l040_dim_compatible(interne.l040_dim(cp.dim), interne.l040_dim(x.dim))
             and coalesce(x.stock, 0) >= v_req
           order by x.id limit 1;
          if found then v_cible := s.id; v_sub := cp.id; end if;
        end if;
        select stock, nom into s from public.produits where id = v_cible;
        v_av := s.stock;
        v_ap := greatest(0, coalesce(v_av, 0) - v_req);
        v_ret := greatest(0, coalesce(v_av, 0) - v_ap);
        update public.produits set stock = v_ap, updated_at = now() where id = v_cible;
        insert into public.stock_sorties_livraison (cmd_id, produit_id, produit_nom, qte_demandee, qte_retiree, stock_avant,
          stock_apres, composant_de, substitue_de, acteur)
        values (c.id, v_cible, s.nom, v_req, v_ret, v_av, v_ap, p.id, v_sub, v_acteur);
        v_retraits := v_retraits || jsonb_build_array(jsonb_build_object('produit_id', v_cible, 'nom', s.nom, 'qte', v_ret,
          'demande', v_req, 'stock_avant', v_av, 'stock_apres', v_ap, 'composant_de', p.id, 'substitue_de', v_sub));
        if v_ret < v_req then
          v_manques := v_manques || jsonb_build_array(jsonb_build_object('produit_id', v_cible, 'nom', s.nom,
            'raison', 'stock_insuffisant', 'composant_de', p.id, 'demande', v_req, 'retire', v_ret, 'manque', v_req - v_ret));
        end if;
      end loop;
    else
      select stock, nom into s from public.produits where id = v_pid;
      v_av := s.stock;
      v_ap := greatest(0, coalesce(v_av, 0) - v_q);
      v_ret := greatest(0, coalesce(v_av, 0) - v_ap);
      update public.produits set stock = v_ap, updated_at = now() where id = v_pid;
      insert into public.stock_sorties_livraison (cmd_id, produit_id, produit_nom, qte_demandee, qte_retiree, stock_avant,
        stock_apres, composant_de, substitue_de, acteur)
      values (c.id, v_pid, s.nom, v_q, v_ret, v_av, v_ap, null, null, v_acteur);
      v_retraits := v_retraits || jsonb_build_array(jsonb_build_object('produit_id', v_pid, 'nom', s.nom, 'qte', v_ret,
        'demande', v_q, 'stock_avant', v_av, 'stock_apres', v_ap, 'composant_de', null, 'substitue_de', null));
      if v_ret < v_q then
        v_manques := v_manques || jsonb_build_array(jsonb_build_object('produit_id', v_pid, 'nom', s.nom,
          'raison', 'stock_insuffisant', 'demande', v_q, 'retire', v_ret, 'manque', v_q - v_ret));
      end if;
    end if;
  end loop;
  -- une seule fois : marquée déduite dans la MÊME transaction
  update public.commandes set stock_deduit = true, updated_at = now() where id = c.id;
  perform set_config('l040.fonction', '', true);

  v_res := jsonb_build_object('retraits', v_retraits, 'manques', v_manques);
  insert into public.stock_operations (nature, cmd_id, sortie_max, resultat, acteur)
  values ('deduction', c.id, (select max(id) from public.stock_sorties_livraison where cmd_id = c.id), v_res, v_acteur)
  returning id into v_op;
  select array_agg(x ->> 'produit_id') into v_touches from jsonb_array_elements(v_retraits) x;
  return (v_res || jsonb_build_object('ok', true, 'deja', false, 'stock_deduit', true, 'operation_id', v_op,
    'stocks_actuels', interne.l040_stocks(v_touches)))::json;
end $$;
revoke all on function public.deduire_stock_livraison(text) from public, anon, authenticated;
grant execute on function public.deduire_stock_livraison(text) to anon;   -- session vérifiée DANS la fonction

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 4. Recrédit d'une livraison annulée (depuis les sorties journalisées, une seule fois par déduction)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.recrediter_stock_livraison(p_cmd_id text, p_suppression boolean default false) returns json
language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
declare
  v_role text := public.session_role();
  c record; o record; r record; s record;
  v_trouvee boolean;
  v_depuis bigint; v_max bigint;
  v_ids text[];
  v_retours jsonb := '[]'::jsonb;
  v_res jsonb; v_op bigint;
  v_supprimee_ici boolean := false;   -- v7.5.209 : commande supprimée PAR CET APPEL (p_suppression)
  v_produits jsonb;
begin
  if v_role is null then return json_build_object('ok', false, 'erreur', 'session_requise'); end if;
  if v_role not in ('admin', 'collab') then return json_build_object('ok', false, 'erreur', 'droits_insuffisants'); end if;
  if coalesce(btrim(p_cmd_id), '') = '' then return json_build_object('ok', false, 'erreur', 'commande_requise'); end if;

  perform pg_advisory_xact_lock(hashtext('l040|' || p_cmd_id));
  select id, statut, stock_deduit, lignes, produit, qte into c from public.commandes where id = p_cmd_id for update;
  v_trouvee := found;
  -- v7.5.208 (avis chatgpt-review sur 8905a30) : p_suppression n'est plus une simple DÉCLARATION de l'appelant. Commande
  -- encore présente : elle est RÉELLEMENT SUPPRIMÉE ICI, dans la même transaction et sous le même verrou, AVANT tout recrédit
  -- (mêmes droits que la suppression par l'appli : administrateur ou collaboratrice). Si la base refuse la suppression,
  -- rien n'est recrédité (« suppression_refusee ») : jamais de stock rendu pour une commande qui reste livrée. Le recrédit
  -- se fait ensuite comme pour une commande déjà supprimée (depuis le journal des sorties).
  if v_trouvee and coalesce(p_suppression, false) then
    begin
      delete from public.commandes where id = c.id;
    exception when others then
      return json_build_object('ok', false, 'erreur', 'suppression_refusee', 'detail', left(sqlerrm, 300));
    end;
    if exists (select 1 from public.commandes where id = p_cmd_id) then
      return json_build_object('ok', false, 'erreur', 'suppression_refusee');
    end if;
    v_trouvee := false;
    v_supprimee_ici := true;
  end if;
  if not v_trouvee and not coalesce(p_suppression, false) then
    return json_build_object('ok', false, 'erreur', 'commande_introuvable');
  end if;
  -- déjà recréditée (ou jamais déduite) : rien n'est touché ; résultat du recrédit restitué (idempotent)
  if v_trouvee and not coalesce(c.stock_deduit, false) then return interne.l040_rejeu(p_cmd_id, 'recredit'); end if;
  if v_trouvee and coalesce(c.statut, '') in ('livré', 'livre') and not coalesce(p_suppression, false) then
    return json_build_object('ok', false, 'erreur', 'commande_encore_livree', 'statut', c.statut);
  end if;
  select id, nature, sortie_max into o from public.stock_operations
   where cmd_id = p_cmd_id and nature in ('deduction', 'recredit') order by id desc limit 1;
  if not found or o.nature <> 'deduction' then
    -- v7.5.209 (avis chatgpt-review sur 3fefbc9) : commande SUPPRIMÉE PAR CET APPEL alors qu'elle était déduite (stock_deduit)
    -- ou livrée, SANS déduction journalisée (déduite par une ANCIENNE version de l'appli, qui retirait le stock elle-même) :
    -- quantités sorties inconnues, rien n'est recrédité. La suppression demandée par le bureau est MAINTENUE (la refuser ne
    -- rendrait pas les quantités connues et bloquerait le bureau), mais ce n'est plus un succès muet : les produits de la
    -- commande (copiés AVANT sa disparition) sont écrits au journal stock_operations (nature « recredit », aucun stock
    -- touché, réponse rejouée à l'identique) et la réponse dit explicitement « recredit_manuel_requis » avec leur détail.
    if v_supprimee_ici and (coalesce(c.stock_deduit, false) or coalesce(c.statut, '') in ('livré', 'livre')) then
      select coalesce(jsonb_agg(jsonb_build_object('produit_id', interne.l040_trouver_produit(x.l ->> 'produitId',
               coalesce(nullif(x.l ->> 'nom', ''), x.l ->> 'produit')), 'nom', coalesce(nullif(x.l ->> 'nom', ''), x.l ->> 'produit'),
               'qte', interne.l040_qte(x.l -> 'qte')) order by x.n), '[]'::jsonb) into v_produits
        from (select e.value as l, e.n from jsonb_array_elements(case when jsonb_typeof(c.lignes) = 'array' then c.lignes else '[]'::jsonb end)
                with ordinality as e(value, n) where jsonb_typeof(e.value) = 'object') x;
      if jsonb_array_length(v_produits) = 0 and coalesce(c.produit, '') <> '' then
        v_produits := jsonb_build_array(jsonb_build_object('produit_id', interne.l040_trouver_produit(null, c.produit),
          'nom', c.produit, 'qte', interne.l040_qte(to_jsonb(c.qte))));
      end if;
      v_res := jsonb_build_object('retours', '[]'::jsonb, 'recredit_manuel_requis', true,
        'deduction_certaine', coalesce(c.stock_deduit, false), 'statut', c.statut, 'produits', v_produits);
      insert into public.stock_operations (nature, cmd_id, sortie_max, resultat, acteur)
      values ('recredit', p_cmd_id, null, v_res, v_role) returning id into v_op;
      return (v_res || jsonb_build_object('ok', true, 'deja', false, 'stock_deduit', false, 'operation_id', v_op,
        'stocks_actuels', '{}'::jsonb))::json;
    end if;
    if not v_trouvee then return interne.l040_rejeu(p_cmd_id, 'recredit'); end if; -- commande supprimée : déjà fait / rien à faire
    -- déduite par une ANCIENNE version de l'appli (aucune sortie journalisée) : quantités inconnues, rien n'est touché
    return json_build_object('ok', false, 'erreur', 'sans_journal');
  end if;
  select coalesce(max(sortie_max), 0) into v_depuis from public.stock_operations where cmd_id = p_cmd_id and nature = 'recredit';
  v_max := coalesce(o.sortie_max, v_depuis);

  -- produits à recréditer verrouillés dans l'ordre des identifiants, puis lus sous verrou
  select coalesce(array_agg(distinct produit_id order by produit_id), '{}') into v_ids from public.stock_sorties_livraison
   where cmd_id = p_cmd_id and id > v_depuis and id <= v_max and qte_retiree > 0;
  perform 1 from public.produits where id = any (v_ids) order by id for update;
  perform set_config('l040.fonction', '1', true);
  for r in select produit_id, sum(qte_retiree)::integer as q, max(produit_nom) as nom from public.stock_sorties_livraison
            where cmd_id = p_cmd_id and id > v_depuis and id <= v_max and qte_retiree > 0
            group by produit_id order by produit_id loop
    select stock, nom into s from public.produits where id = r.produit_id;
    if not found then
      v_retours := v_retours || jsonb_build_array(jsonb_build_object('produit_id', r.produit_id, 'nom', r.nom, 'qte', 0,
        'demande', r.q, 'raison', 'produit_introuvable'));
      continue;
    end if;
    update public.produits set stock = coalesce(s.stock, 0) + r.q, updated_at = now() where id = r.produit_id;
    v_retours := v_retours || jsonb_build_array(jsonb_build_object('produit_id', r.produit_id, 'nom', coalesce(s.nom, r.nom),
      'qte', r.q, 'demande', r.q, 'stock_avant', coalesce(s.stock, 0), 'stock_apres', coalesce(s.stock, 0) + r.q));
  end loop;
  if v_trouvee then update public.commandes set stock_deduit = false, updated_at = now() where id = c.id; end if;
  perform set_config('l040.fonction', '', true);

  v_res := jsonb_build_object('retours', v_retours);
  insert into public.stock_operations (nature, cmd_id, sortie_max, resultat, acteur)
  values ('recredit', p_cmd_id, v_max, v_res, v_role) returning id into v_op;
  return (v_res || jsonb_build_object('ok', true, 'deja', false, 'stock_deduit', false, 'operation_id', v_op,
    'stocks_actuels', interne.l040_stocks(v_ids)))::json;
end $$;
revoke all on function public.recrediter_stock_livraison(text, boolean) from public, anon, authenticated;
grant execute on function public.recrediter_stock_livraison(text, boolean) to anon;   -- session vérifiée DANS la fonction

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 5. Mouvement manuel du bureau (entrée, retour, sortie, correction), calculé par la base, idempotent par clé
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.mouvement_stock_produit(p_produit_id text, p_type text, p_qte integer,
  p_motif text default null, p_cle text default null) returns json
language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
declare
  v_role text := public.session_role();
  o record; p record;
  v_av integer; v_ap integer;
  v_res jsonb; v_op bigint;
begin
  if v_role is null then return json_build_object('ok', false, 'erreur', 'session_requise'); end if;
  if v_role not in ('admin', 'collab') then return json_build_object('ok', false, 'erreur', 'droits_insuffisants'); end if;
  if coalesce(length(p_cle), 0) not between 8 and 120 then return json_build_object('ok', false, 'erreur', 'cle_requise'); end if;
  if coalesce(p_type, '') not in ('entree', 'retour', 'sortie', 'correction') then
    return json_build_object('ok', false, 'erreur', 'type_invalide');
  end if;
  if p_qte is null or p_qte < 0 or p_qte > 1000000 or (p_type <> 'correction' and p_qte < 1) then
    return json_build_object('ok', false, 'erreur', 'quantite_invalide');
  end if;

  perform pg_advisory_xact_lock(hashtext('l040m|' || p_cle));
  select id, produit_id, resultat into o from public.stock_operations where cle = p_cle;
  if found then
    -- v7.5.207 (avis chatgpt-review sur 6775bbc, point 2) : une clé déjà utilisée n'est rejouée (« deja ») que pour le MÊME
    -- mouvement (produit, type ET quantité). Avant : une entrée de 5 puis une sortie de 5 avec la même clé répondait « deja »
    -- sans effectuer la sortie. Toute réutilisation avec d'autres paramètres est refusée explicitement, rien n'est écrit.
    if o.produit_id is distinct from p_produit_id or (o.resultat ->> 'type') is distinct from p_type
       or (o.resultat ->> 'qte') is distinct from p_qte::text then
      return json_build_object('ok', false, 'erreur', 'cle_deja_utilisee', 'detail',
        jsonb_build_object('produit_id', o.produit_id, 'type', o.resultat ->> 'type', 'qte', (o.resultat ->> 'qte')::integer));
    end if;
    return (o.resultat || jsonb_build_object('ok', true, 'deja', true, 'operation_id', o.id,
      'stocks_actuels', interne.l040_stocks(array[p_produit_id])))::json;
  end if;
  select id, nom, stock into p from public.produits where id = p_produit_id for update;
  if not found then return json_build_object('ok', false, 'erreur', 'produit_introuvable'); end if;
  v_av := coalesce(p.stock, 0);
  v_ap := case p_type when 'sortie' then greatest(0, v_av - p_qte) when 'correction' then p_qte else v_av + p_qte end;
  perform set_config('l040.fonction', '1', true);
  update public.produits set stock = v_ap, updated_at = now() where id = p.id;
  perform set_config('l040.fonction', '', true);
  v_res := jsonb_build_object('produit_id', p.id, 'nom', p.nom, 'type', p_type, 'qte', p_qte, 'delta', v_ap - v_av,
    'stock_avant', v_av, 'stock_apres', v_ap, 'motif', left(coalesce(p_motif, ''), 500));
  insert into public.stock_operations (nature, produit_id, cle, resultat, acteur)
  values ('mouvement', p.id, p_cle, v_res, v_role) returning id into v_op;
  return (v_res || jsonb_build_object('ok', true, 'deja', false, 'operation_id', v_op,
    'stocks_actuels', interne.l040_stocks(array[p.id])))::json;
end $$;
revoke all on function public.mouvement_stock_produit(text, text, integer, text, text) from public, anon, authenticated;
grant execute on function public.mouvement_stock_produit(text, text, integer, text, text) to anon;   -- session vérifiée DANS la fonction

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 6. Gardes : stock_deduit et stock ne changent que par les fonctions (jamais d'erreur ; voir « COMPATIBILITÉ »)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function interne.l040_stock_deduit_garde() returns trigger
language plpgsql security definer set search_path = public, interne, pg_catalog as $$
begin
  if new.stock_deduit is distinct from old.stock_deduit and not interne.l040_par_fonction()
     and public.session_role() is not null then
    if coalesce(old.stock_deduit, false) and not coalesce(new.stock_deduit, false) then
      new.stock_deduit := old.stock_deduit;   -- vrai → faux : seulement par la fonction de recrédit
    elsif interne.l040_strict() then
      new.stock_deduit := old.stock_deduit;   -- mode strict : faux → vrai seulement par la fonction de déduction
    end if;
  end if;
  return new;
end $$;
revoke all on function interne.l040_stock_deduit_garde() from public, anon, authenticated;
drop trigger if exists commandes_stock_deduit_garde on public.commandes;
create trigger commandes_stock_deduit_garde before update on public.commandes
  for each row execute function interne.l040_stock_deduit_garde();

create or replace function interne.l040_stock_garde() returns trigger
language plpgsql security definer set search_path = public, interne, pg_catalog as $$
begin
  if new.stock is distinct from old.stock and not interne.l040_par_fonction()
     and public.session_role() is not null and interne.l040_strict() then
    new.stock := old.stock;   -- mode strict : stock d'une fiche existante changé seulement par les fonctions
  end if;
  return new;
end $$;
revoke all on function interne.l040_stock_garde() from public, anon, authenticated;
drop trigger if exists produits_stock_garde on public.produits;
create trigger produits_stock_garde before update on public.produits
  for each row execute function interne.l040_stock_garde();

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 7. Contrôle à l'application : colonnes attendues présentes, journaux acceptés (essai annulé, rien n'est écrit)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
do $$
declare manque text;
begin
  select string_agg(t || '.' || col, ', ') into manque
    from (values ('commandes', 'id'), ('commandes', 'statut'), ('commandes', 'stock_deduit'), ('commandes', 'lignes'),
                 ('commandes', 'produit'), ('commandes', 'qte'), ('commandes', 'livreur'), ('commandes', 'date_livraison'),
                 ('commandes', 'updated_at'), ('produits', 'id'), ('produits', 'nom'), ('produits', 'stock'),
                 ('produits', 'composants'), ('produits', 'cat'), ('produits', 'dim'), ('produits', 'actif'),
                 ('produits', 'updated_at')) as v(t, col)
   where not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = v.t and column_name = v.col);
  if manque is not null then
    raise exception 'Contrôle 040 : colonnes absentes (%). Migration annulée.', manque;
  end if;
  begin
    insert into public.stock_sorties_livraison (cmd_id, produit_id, produit_nom, qte_demandee, qte_retiree, stock_avant, stock_apres, acteur)
      values ('#TEST-040', '#TEST', 'Essai', 1, 1, 1, 0, 'controle');
    insert into public.stock_operations (nature, cmd_id, resultat, acteur) values ('deduction', '#TEST-040', '{}'::jsonb, 'controle');
    raise exception 'essai_annule';
  exception when others then
    if sqlerrm <> 'essai_annule' then
      raise exception 'Contrôle 040 : un journal refuse une écriture (%). Migration annulée.', sqlerrm;
    end if;
  end;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 8. Auto-contrôle à l'application : règles de l'appli reproduites (fonctions PURES, valeurs fictives, rien n'est écrit)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
do $$
declare f text := null;
begin
  if interne.l040_qte(null) <> 1 then f := 'qte absente'; end if;
  if f is null and interne.l040_qte('0'::jsonb) <> 1 then f := 'qte 0'; end if;
  if f is null and interne.l040_qte('-3'::jsonb) <> 1 then f := 'qte négative'; end if;
  if f is null and interne.l040_qte('2'::jsonb) <> 2 then f := 'qte 2'; end if;
  if f is null and interne.l040_qte('2.7'::jsonb) <> 2 then f := 'qte 2.7'; end if;
  if f is null and interne.l040_qte('"3 pièces"'::jsonb) <> 3 then f := 'qte texte'; end if;
  if f is null and interne.l040_qte('"abc"'::jsonb) <> 1 then f := 'qte illisible'; end if;
  if f is null and interne.l040_dim(' 140 X 190 ') <> '140x190' then f := 'dim normalisée'; end if;
  if f is null and not interne.l040_dim_compatible('140×190', '140×190×25') then f := 'dim contenue'; end if;
  if f is null and interne.l040_dim_compatible('140×190', '160×200') then f := 'dim différente'; end if;
  if f is null and not interne.l040_dim_compatible('', '') then f := 'dim vides'; end if;
  if f is null and interne.l040_dim_compatible('90x190', '140x190') then f := 'dim sans ×'; end if;
  if f is not null then
    raise exception 'Auto-contrôle 040 en échec : cas « % ». Migration annulée.', f;
  end if;
end $$;
