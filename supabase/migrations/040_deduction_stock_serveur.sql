-- 040 (26/11/2026) : STOCK — le retrait de stock d'une livraison est fait PAR LA BASE, en une seule opération et UNE SEULE
-- FOIS par commande (décision de Borhen du 26/11/2026, « GO » à la solution A, confirmé à 22 h 15 ; PR 29).
--
-- RETOUR ARRIÈRE (à exécuter tel quel dans l'éditeur SQL si besoin ; ne supprime ni ne modifie aucune donnée de stock ni
-- aucune commande) :
--   drop trigger if exists commandes_stock_deduit_garde on public.commandes;
--   drop function if exists interne.l040_stock_deduit_garde();
--   drop function if exists public.deduire_stock_livraison(text);
--   drop function if exists interne.l040_trouver_produit(text, text);
--   drop function if exists interne.l040_dim_compatible(text, text);
--   drop function if exists interne.l040_dim(text);
--   drop function if exists interne.l040_qte(jsonb);
--   (La table public.stock_sorties_livraison peut rester : c'est le journal des sorties déjà faites ; la supprimer n'efface
--    que ce journal, aucun stock : drop table if exists public.stock_sorties_livraison;)
--   Puis revenir à l'application v7.5.196 (elle calcule de nouveau le retrait sur le téléphone).
--
-- ORDRE DE MISE EN SERVICE (obligatoire) : 038b (PR 24) → 039 (PR 26) → CETTE 040 → PUIS l'application v7.5.197 (PR 29).
-- Si l'application v7.5.197 est en ligne sans la 040, rien n'est perdu : l'appel est gardé en file sur le téléphone
-- (« mise à jour de la base en attente », affiché une fois) et rejoué dès que la fonction existe.
--
-- Problème (6 retours de Codex sur la PR 29) : le téléphone calculait le nouveau stock (stock lu − quantité) puis l'envoyait
-- produit par produit, puis posait stock_deduit = vrai. Un envoi au résultat incertain (réponse perdue, application fermée
-- pendant l'envoi, deux appareils) ne peut pas être rejoué sans risquer une double déduction, ni abandonné sans risquer une
-- déduction perdue : un téléphone ne peut pas garantir SEUL une déduction unique.
--
-- Solution : public.deduire_stock_livraison(p_cmd_id) fait TOUT dans une seule transaction de la base :
--   1. session vérifiée (admin, collaboratrice, ou livreur PROPRIÉTAIRE de la commande, même règle que la politique
--      sess_livreur de la migration 019 : livreur de la commande = livreur de la session, date de livraison à ±2 jours) ;
--      une commande d'un autre livreur répond « commande_introuvable » (comme la politique : elle lui est invisible) ;
--   2. commande VERROUILLÉE (FOR UPDATE) : deux appels simultanés s'attendent ; le second voit stock_deduit = vrai ;
--   3. stock_deduit déjà vrai → { ok: true, deja: true } SANS RIEN TOUCHER (IDEMPOTENT : un téléphone peut renvoyer la
--      demande autant de fois qu'il veut, après une réponse perdue ou une fermeture) ;
--   4. commande pas « livré » → refus clair { ok: false, erreur: 'commande_non_livree' } (rien n'est touché) ;
--   5. quantités calculées comme stkDeduireStock de l'application v7.5.196 (voir « FIDÉLITÉ » ci-dessous) ;
--   6. produits touchés VERROUILLÉS dans un ordre stable (par identifiant) avant toute lecture du stock ;
--   7. stock jamais négatif : nouveau stock = max(0, stock − quantité) ; ce qui manque est renvoyé (manques) ;
--   8. chaque sortie est écrite dans le journal public.stock_sorties_livraison (ajout seul) ;
--   9. stock_deduit = vrai ;
--   tout ou rien : la moindre erreur annule l'opération entière (aucun stock retiré, stock_deduit reste faux).
--   Réponse : { ok, deja, stock_deduit, retraits: [{produit_id, nom, qte, demande, stock_avant, stock_apres, composant_de,
--   substitue_de}], manques: [{produit_id, nom, raison, demande, retire, manque}] }.
--
-- FIDÉLITÉ à stkDeduireStock (application v7.5.196) :
--   * lignes de la commande (commandes.lignes : produitId, nom ou produit, qte) ; sans lignes : commandes.produit + qte ;
--   * quantité = max(1, partie entière de qte) (Math.max(1, parseInt(qte) || 1)) ;
--   * produit retrouvé par son identifiant, sinon par son nom (repli de stkTrouverProduit : nom identique, ou nom de la ligne
--     qui contient le nom du produit, ou nom du produit qui contient les deux premiers mots de la ligne ; produits actifs) ;
--   * ENSEMBLE (produits.composants non vide) : ce sont ses COMPOSANTS qui sont retirés (qte du composant × quantité),
--     jamais l'ensemble lui-même ; pas de descente dans un composant qui serait lui-même un ensemble (comme l'appli) ;
--   * SUBSTITUTION AUTOMATIQUE (l'appli la fait, elle est reproduite) : composant en stock insuffisant → produit de même
--     catégorie, même dimension (même règle de comparaison que l'appli), actif, dont le stock suffit ;
--   * produit ou composant introuvable : ignoré (comme l'appli), mais SIGNALÉ dans « manques » (raison).
--   DIFFÉRENCES VOULUES (plus sûres), documentées :
--   * l'appli prenait le premier produit de sa liste en mémoire ; la base prend, à égalité, le plus petit identifiant
--     (ordre stable, le même sur tous les appareils) ; un nom identique passe avant un nom seulement « contenu » ;
--   * un produit au nom vide ne « correspond » plus à n'importe quelle ligne (en JavaScript, ''.includes('') est vrai) ;
--   * l'identifiant d'un produit désactivé est reconnu (l'appli ne chargeait que les produits actifs et retombait sur le nom) ;
--   * substitution : un produit marqué « non vendable » (colonne vendable de la migration 039, si elle existe) n'est jamais
--     pris comme substitut ;
--   * le journal est écrit EN BASE (l'appli ne gardait ses « sorties livraison » qu'en mémoire, perdues au rechargement).
--
-- JOURNAL : public.stock_sorties_livraison, table DÉDIÉE. mouvements_stock n'est PAS utilisé : elle ne contient que des
-- mouvements camion (chargement / retour_depot / livraison depuis le camion, cf. migration 025) lus par stock-sync-shopify
-- et JARVIS ; y écrire les sorties du dépôt fausserait leurs calculs (double compte possible). Lecture : administrateur et
-- collaboratrice ; écriture : uniquement par la fonction ; ni modification ni suppression.
--
-- GARDE stock_deduit (déclencheur commandes_stock_deduit_garde) : une sauvegarde ordinaire de l'application (POST
-- merge-duplicates d'une commande, file rejouée, ancien téléphone) ne peut plus REMETTRE stock_deduit à faux après la
-- déduction faite par la base (sinon une demande renvoyée déduirait une deuxième fois). Seule exception : le recrédit de
-- l'administrateur (stkReCrediterStock), qui remet stock_deduit à faux quand une commande livrée est annulée, reportée ou
-- remise en attente (statut qui n'est plus « livré »). Les programmes serveur (sans session de l'application) ne sont pas
-- concernés. Passer stock_deduit à vrai reste permis (anciennes versions de l'application, qui l'envoient après leur
-- propre déduction ; ce passage ne peut qu'empêcher une déduction, jamais en provoquer une).
--
-- LIMITES : la règle des ±2 jours du livreur s'applique aussi ici : un téléphone resté hors ligne plus de 2 jours après la
-- date de livraison verra sa demande refusée (l'application le signale ; à faire par le bureau). Le recrédit à
-- l'annulation reste calculé par l'application de l'administrateur (inchangé, hors de cette migration).
-- Aucune donnée existante n'est modifiée par cette migration.

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 1. Journal des sorties de stock des livraisons (ajout seul)
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
create index if not exists stock_sorties_livraison_cmd_idx on public.stock_sorties_livraison (cmd_id);
comment on table public.stock_sorties_livraison is 'Sorties de stock des livraisons, écrites UNIQUEMENT par public.deduire_stock_livraison (migration 040). Ajout seul.';
alter table public.stock_sorties_livraison enable row level security;
revoke all on table public.stock_sorties_livraison from public, anon, authenticated;
revoke all on sequence public.stock_sorties_livraison_id_seq from public, anon, authenticated;
grant select on table public.stock_sorties_livraison to anon;
drop policy if exists sess_lecture on public.stock_sorties_livraison;
create policy sess_lecture on public.stock_sorties_livraison for select to anon
  using ((select public.session_role()) in ('admin', 'collab'));

create or replace function interne.l040_journal_fige() returns trigger
language plpgsql as $$
begin
  raise exception 'stock_sorties_livraison : ajout seul (ni modification ni suppression)';
end $$;
drop trigger if exists stock_sorties_livraison_fige on public.stock_sorties_livraison;
create trigger stock_sorties_livraison_fige before update or delete on public.stock_sorties_livraison
  for each row execute function interne.l040_journal_fige();

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 2. Fonctions PURES (reproduction des règles de l'application ; testées par l'auto-contrôle de la section 6)
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
revoke all on function interne.l040_trouver_produit(text, text) from public, anon, authenticated;

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
  v_ids text[] := '{}';
  v_cats text[] := '{}';
  v_pid text; v_q integer; v_req integer; v_av integer; v_ap integer; v_ret integer;
  v_cible text; v_sub text;
  v_retraits jsonb := '[]'::jsonb;
  v_manques jsonb := '[]'::jsonb;
begin
  if v_role is null or v_role not in ('admin', 'collab', 'livreur') then
    return json_build_object('ok', false, 'erreur', 'session_requise');
  end if;
  if coalesce(btrim(p_cmd_id), '') = '' then return json_build_object('ok', false, 'erreur', 'commande_requise'); end if;
  v_acteur := v_role || coalesce(':' || v_liv, '');

  -- (1)(2) commande visible par la session (même règle que les politiques sess_*), VERROUILLÉE
  select id, statut, stock_deduit, lignes, produit, qte into c from public.commandes
   where id = p_cmd_id
     and (v_role <> 'livreur'
          or (v_liv is not null and upper(coalesce(livreur, '')) = v_liv
              and coalesce(date_livraison, '') >= to_char(current_date - 2, 'YYYY-MM-DD')
              and coalesce(date_livraison, '') <= to_char(current_date + 2, 'YYYY-MM-DD')))
   for update;
  if not found then return json_build_object('ok', false, 'erreur', 'commande_introuvable'); end if;

  -- (3) déjà déduite : rien n'est touché (idempotent)
  if coalesce(c.stock_deduit, false) then
    return json_build_object('ok', true, 'deja', true, 'stock_deduit', true, 'retraits', '[]'::json, 'manques', '[]'::json);
  end if;
  -- (4) seulement une commande livrée
  if coalesce(c.statut, '') not in ('livré', 'livre') then
    return json_build_object('ok', false, 'erreur', 'commande_non_livree', 'statut', c.statut);
  end if;

  -- (5) lignes de la commande et produits concernés (sans verrou : seulement l'identité des produits)
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
  -- ensemble de verrous : produits des lignes, leurs composants, et les substituts possibles (même catégorie)
  for l in select x.value from jsonb_array_elements(v_lignes) as x(value) loop
    v_pid := l ->> 'id';
    if v_pid is null then continue; end if;
    v_ids := v_ids || v_pid;
    select id, composants into p from public.produits where id = v_pid;
    if jsonb_typeof(p.composants) = 'array' and jsonb_array_length(p.composants) > 0 then
      for e in select x.value from jsonb_array_elements(p.composants) as x(value) loop
        if coalesce(e ->> 'id', '') = '' then continue; end if;
        v_ids := v_ids || (e ->> 'id');
        select cat into cp from public.produits where id = e ->> 'id';
        if found then v_cats := v_cats || coalesce(cp.cat, ''); end if;
      end loop;
    end if;
  end loop;
  if cardinality(v_cats) > 0 then
    v_ids := v_ids || array(select id from public.produits where coalesce(cat, '') = any (v_cats));
  end if;
  -- (6) verrous dans un ordre STABLE (identifiant) : deux déductions simultanées ne peuvent pas s'interbloquer
  perform 1 from public.produits where id = any (v_ids) order by id for update;

  -- (5)(7)(8) retraits, ligne par ligne, dans l'ordre de la commande (lectures APRÈS les verrous)
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
        select id, nom, cat, dim, stock into cp from public.produits where id = (e ->> 'id');
        if not found then
          v_manques := v_manques || jsonb_build_array(jsonb_build_object('produit_id', e ->> 'id', 'nom', null,
            'raison', 'composant_introuvable', 'composant_de', p.id, 'demande', interne.l040_qte(e -> 'qte') * v_q, 'retire', 0,
            'manque', interne.l040_qte(e -> 'qte') * v_q));
          continue;
        end if;
        perform 1 from public.produits where id = cp.id for update;  -- composition changée entre-temps : verrou ajouté
        v_req := interne.l040_qte(e -> 'qte') * v_q;
        v_cible := cp.id; v_sub := null;
        if coalesce(cp.stock, 0) < v_req then
          -- SUBSTITUTION AUTOMATIQUE (règle de l'appli) : même catégorie, même dimension, actif, stock suffisant
          select x.id into s from public.produits x
           where x.id <> cp.id and coalesce(x.actif, true) and x.cat is not distinct from cp.cat
             and coalesce((to_jsonb(x) ->> 'vendable')::boolean, true)
             and interne.l040_dim_compatible(interne.l040_dim(cp.dim), interne.l040_dim(x.dim))
             and coalesce(x.stock, 0) >= v_req
           order by x.id limit 1
           for update;
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

  -- (9) une seule fois : marquée déduite dans la MÊME transaction
  update public.commandes set stock_deduit = true, updated_at = now() where id = c.id;
  return json_build_object('ok', true, 'deja', false, 'stock_deduit', true, 'retraits', v_retraits::json, 'manques', v_manques::json);
end $$;
revoke all on function public.deduire_stock_livraison(text) from public, anon, authenticated;
grant execute on function public.deduire_stock_livraison(text) to anon;   -- session vérifiée DANS la fonction

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 4. Garde : une sauvegarde ordinaire ne remet pas stock_deduit à faux (sauf recrédit de l'administrateur)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function interne.l040_stock_deduit_garde() returns trigger
language plpgsql security definer set search_path = public, interne, pg_catalog as $$
declare r text;
begin
  if coalesce(old.stock_deduit, false) and not coalesce(new.stock_deduit, false) then
    r := public.session_role();
    if r is not null and not (r = 'admin' and coalesce(new.statut, '') not in ('livré', 'livre')) then
      new.stock_deduit := true;   -- valeur périmée d'un téléphone : ignorée (le reste de l'écriture est conservé)
    end if;
  end if;
  return new;
end $$;
revoke all on function interne.l040_stock_deduit_garde() from public, anon, authenticated;
drop trigger if exists commandes_stock_deduit_garde on public.commandes;
create trigger commandes_stock_deduit_garde before update on public.commandes
  for each row execute function interne.l040_stock_deduit_garde();

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 5. Contrôle à l'application : colonnes attendues présentes, journal accepté (essai annulé, rien n'est écrit)
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
    raise exception 'essai_annule';
  exception when others then
    if sqlerrm <> 'essai_annule' then
      raise exception 'Contrôle 040 : le journal refuse une sortie (%). Migration annulée.', sqlerrm;
    end if;
  end;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 6. Auto-contrôle à l'application : règles de l'appli reproduites (fonctions PURES, valeurs fictives, rien n'est écrit)
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
