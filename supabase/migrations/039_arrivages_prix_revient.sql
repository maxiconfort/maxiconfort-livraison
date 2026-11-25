-- 039_arrivages_prix_revient.sql — 25/11/2026 — RÉCEPTION D'ARRIVAGE, PRIX DE REVIENT, PRODUITS NON VENDABLES (application v7.5.136).
--
-- ⚠️ DÉPÔT PUBLIC : ce fichier ne contient AUCUN prix d'achat, montant, numéro de facture ou nom de fournisseur. Les données d'un
--    arrivage sont chargées à part, depuis un fichier privé, par un administrateur (jamais par l'application).
--
-- But (demande de Borhen du 25/11/2026 : intégrer un conteneur de matelas) :
--   1. arrivages / arrivage_lignes : un conteneur attendu, ses références et quantités, puis la RÉCEPTION (reçu / endommagé /
--      manquant par ligne) validée UNE seule fois par l'administrateur (fonction valider_reception_arrivage, atomique).
--   2. Prix de revient HT par produit, valorisé au COÛT MOYEN PONDÉRÉ (CUMP) à chaque réception — CHOIX À VALIDER PAR BORHEN :
--      la méthode est une constante (interne.arrivage_methode_valorisation) ; 'DERNIER_PRIX' est l'autre méthode possible.
--      Historique par lot dans prix_revient_historique (ajout seul : jamais modifié rétroactivement).
--   3. Produits NON VENDABLES : une nouvelle référence arrive sans prix de vente (prix NULL, prix_vente_defini = false,
--      vendable = false). Elle peut être reçue et stockée mais ne peut être ni vendue (commande), ni reliée à une variante
--      Shopify, ni comptée dans un ensemble vendable, tant que l'administrateur n'a pas fixé son prix.
--
-- Pourquoi le prix de revient n'est PAS une colonne de « produits » (écart volontaire avec la demande initiale) :
--   la table produits est LISIBLE en entier par les sessions collaboratrice et livreur (politiques sess_collab et
--   sess_livreur_lecture de la migration 019) et par le cerveau (brain_read). Une colonne prix_revient_ht y serait donc visible
--   par tout le monde. Le revient vit dans produits_revient, lisible par l'administrateur seulement (même règle que
--   journal_financier). Les marges des commandes passées ne sont JAMAIS recalculées (aucune colonne de coût ajoutée aux
--   commandes dans ce lot : le coût figé à la vente viendra avec le lot « Marges »).
--
-- Rien n'est écrit dans produits.stock par cette migration : le stock n'augmente qu'à la validation d'une réception.
-- Le stock ENTRANT (arrivages en attente) est lu par la fonction stock_entrant() (administrateur et collaboratrice), sans prix.
--
-- ORDRE DE MISE EN SERVICE : 1) cette migration ; 2) l'application v7.5.136 ; 3) (facultatif) jarvis-action et
-- whatsapp-receive redéployées (elles filtrent les produits non vendables) ; 4) le fichier privé de chargement d'un arrivage.
--
-- RETOUR ARRIÈRE (sans perte de données, à faire AVANT toute réception validée) :
--   drop trigger if exists commandes_produit_vendable_garde on public.commandes;
--   drop trigger if exists stock_correspondance_vendable_garde on public.stock_correspondance;
--   drop trigger if exists produits_vente_garde on public.produits;
--   (les tables et colonnes ajoutées peuvent rester : elles sont inoffensives) ; revenir à l'application v7.5.135.
--   Après une réception validée : le stock ajouté est tracé dans mouvements_stock (type 'entree', source 'arrivage:<réf>') et dans
--   stock_entrees (motif 'arrivage:<réf>', lu par stock-sync-shopify et JARVIS). La contrainte élargie de stock_entrees.motif peut rester.

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 1. Produits : prix de vente « à définir », vendable, référence interne, caractéristiques
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Une nouvelle référence n'a pas encore de prix de vente : prix NULL (et non 0, qui serait un vrai prix). Sans effet si la
-- colonne accepte déjà NULL. L'application lit un prix NULL comme 0 et affiche « Prix à définir ».
alter table public.produits alter column prix drop not null;

alter table public.produits
  add column if not exists prix_vente_defini boolean not null default true,
  add column if not exists vendable boolean not null default true,
  add column if not exists reference_interne text,
  add column if not exists caracteristiques jsonb;
create unique index if not exists produits_reference_interne_unique on public.produits (reference_interne) where reference_interne is not null;
comment on column public.produits.prix_vente_defini is 'false = prix de vente pas encore fixé par la direction (prix NULL) : produit non vendable. Seul un administrateur le passe à true (avec un prix > 0).';
comment on column public.produits.vendable is 'false = jamais proposé à la vente (commande, ensemble, correspondance Shopify). Modifiable par un administrateur seulement.';
comment on column public.produits.reference_interne is 'Référence interne (ex. MC-…), unique si renseignée.';
comment on column public.produits.caracteristiques is 'Caractéristiques techniques (jsonb), affichage seulement.';

-- Un produit est NON VENDABLE s'il est marqué non vendable, sans prix de vente défini, ou si c'est un ensemble dont un
-- composant est non vendable (un niveau, comme getStockDispo dans l'application).
create or replace function interne.produit_non_vendable(p_id text) returns boolean
language sql stable security definer set search_path = public, pg_catalog as $$
  select exists (
    select 1 from public.produits p
     where p.id = p_id
       and (not p.vendable or not p.prix_vente_defini
            or (jsonb_typeof(p.composants) = 'array' and exists (
                  select 1 from jsonb_array_elements(p.composants) c
                    join public.produits q on q.id = c ->> 'id'
                   where not q.vendable or not q.prix_vente_defini))));
$$;
revoke all on function interne.produit_non_vendable(text) from public, anon, authenticated;

-- Garde sur produits :
--  * une session collaboratrice ou livreur ne change jamais vendable, prix_vente_defini, reference_interne, caracteristiques ;
--  * tant que le prix n'est pas défini, une écriture ordinaire ne lui donne pas de prix (l'application envoie 0 par défaut) ;
--  * passer à « prix défini » exige un prix > 0 ; un produit sans prix défini ne peut pas être vendable.
create or replace function interne.produits_vente_garde() returns trigger
language plpgsql security definer set search_path = public, interne, pg_catalog as $$
declare r text := (select public.session_role());
begin
  if tg_op = 'UPDATE' and r is not null and r <> 'admin' then
    new.vendable := old.vendable;
    new.prix_vente_defini := old.prix_vente_defini;
    new.reference_interne := old.reference_interne;
    new.caracteristiques := old.caracteristiques;
  end if;
  if tg_op = 'INSERT' and r is not null and r <> 'admin' then
    new.reference_interne := null; new.caracteristiques := null;
    -- création ordinaire depuis l'application : produit vendable avec son prix, comme avant
    new.vendable := true; new.prix_vente_defini := true;
  end if;
  if not new.prix_vente_defini then
    if tg_op = 'UPDATE' and old.prix_vente_defini = false then new.prix := old.prix;  -- reste « à définir »
    elsif tg_op = 'INSERT' then new.prix := null;
    end if;
  end if;
  -- passage de « à définir » à « défini » : prix > 0 obligatoire (une création ordinaire, elle, garde son fonctionnement)
  if tg_op = 'UPDATE' and old.prix_vente_defini = false and new.prix_vente_defini and coalesce(new.prix, 0) <= 0 then
    raise exception 'PRIX DE VENTE : un prix supérieur à 0 est obligatoire pour définir le prix de « % »', new.nom using errcode = 'P0001';
  end if;
  if new.vendable and not new.prix_vente_defini then
    raise exception 'PRODUIT NON VENDABLE : « % » n''a pas de prix de vente défini', new.nom using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists produits_vente_garde on public.produits;
create trigger produits_vente_garde before insert or update on public.produits
  for each row execute function interne.produits_vente_garde();

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 2. Commandes et correspondance Shopify : un produit non vendable est REFUSÉ
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Seules les lignes NOUVELLES sont contrôlées (une commande déjà prise qui contient un produit retiré de la vente reste
-- modifiable). Aucune commande existante n'est touchée par cette migration. Les déclencheurs de paiement et d'annulation
-- ne changent pas.
create or replace function interne.commandes_produit_vendable_garde() returns trigger
language plpgsql security definer set search_path = public, interne, pg_catalog as $$
declare v_ids text[]; v_refus text; v_new jsonb := to_jsonb(new.lignes); v_old jsonb;
begin
  if jsonb_typeof(v_new) is distinct from 'array' then return new; end if;
  if tg_op = 'UPDATE' then v_old := to_jsonb(old.lignes);
  else
    -- enregistrement « upsert » de l'application (INSERT … ON CONFLICT) : le déclencheur INSERT voit la ligne proposée AVANT
    -- la détection du conflit ; si la commande existe déjà, ses lignes actuelles servent de référence (comme pour un UPDATE)
    select to_jsonb(c.lignes) into v_old from public.commandes c where c.id = new.id;
  end if;
  select array_agg(distinct e ->> 'produitId') into v_ids
    from jsonb_array_elements(v_new) e
   where coalesce(e ->> 'produitId', '') <> ''
     and (jsonb_typeof(v_old) is distinct from 'array'
          or not exists (select 1 from jsonb_array_elements(v_old) o where o ->> 'produitId' = e ->> 'produitId'));
  if v_ids is null then return new; end if;
  select string_agg(p.nom, ', ' order by p.nom) into v_refus
    from public.produits p where p.id = any(v_ids) and interne.produit_non_vendable(p.id);
  if v_refus is not null then
    raise exception 'PRODUIT NON VENDABLE (prix de vente à définir) : %', v_refus using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists commandes_produit_vendable_garde on public.commandes;
create trigger commandes_produit_vendable_garde before insert or update of lignes on public.commandes
  for each row execute function interne.commandes_produit_vendable_garde();

-- Une variante Shopify « certaine » (utilisée pour importer les commandes et publier le stock) ne peut pas pointer vers un
-- produit non vendable. Les fonctions Shopify ne sont pas modifiées.
create or replace function interne.stock_correspondance_vendable_garde() returns trigger
language plpgsql security definer set search_path = public, interne, pg_catalog as $$
begin
  if new.app_produit_id is not null and new.fiabilite = 'certaine' and interne.produit_non_vendable(new.app_produit_id) then
    raise exception 'PRODUIT NON VENDABLE : la variante Shopify % ne peut pas être reliée à % tant que son prix de vente n''est pas défini',
      new.shopify_variant_id, new.app_produit_id using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists stock_correspondance_vendable_garde on public.stock_correspondance;
create trigger stock_correspondance_vendable_garde before insert or update of app_produit_id, fiabilite on public.stock_correspondance
  for each row execute function interne.stock_correspondance_vendable_garde();

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 3. Arrivages, lignes, prix de revient, historique
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.arrivages (
  id bigint generated always as identity primary key,
  reference_interne text not null unique,           -- ex. ARR-2026-11-01 (jamais le numéro de facture dans le dépôt public)
  fournisseur text,
  facture text,
  date_facture date,
  transitaire_facture text,
  navire text,
  bl text,
  devise text not null default 'USD',
  taux_change numeric(12,6) check (taux_change > 0),  -- 1 unité de devise = taux_change €
  taux_provisoire boolean not null default true,
  frais_import_ht numeric(12,2) not null default 0 check (frais_import_ht >= 0), -- transport, transit, douane (€ HT)
  statut text not null default 'en_attente' check (statut in ('en_attente', 'recu', 'annule')),
  recu_le timestamptz,
  recu_par text,
  remarque text,
  cree_at timestamptz not null default now(),
  maj_at timestamptz not null default now()
);

create table if not exists public.arrivage_lignes (
  id bigint generated always as identity primary key,
  arrivage_id bigint not null references public.arrivages(id) on delete restrict,
  produit_id text not null references public.produits(id) on update cascade on delete restrict,
  quantite_attendue integer not null check (quantite_attendue > 0),
  quantite_recue integer check (quantite_recue >= 0),           -- reçues en BON état (ajoutées au stock)
  quantite_endommagee integer check (quantite_endommagee >= 0), -- reçues abîmées (NON ajoutées au stock)
  quantite_manquante integer check (quantite_manquante >= 0),   -- jamais arrivées
  fob_unitaire numeric(12,4) check (fob_unitaire >= 0),         -- prix d'achat unitaire dans la devise de l'arrivage
  revient_unitaire_ht numeric(12,4) check (revient_unitaire_ht >= 0), -- € HT : FOB × taux + part des frais d'import
  remarque text,
  unique (arrivage_id, produit_id),
  check (quantite_recue is null
         or quantite_recue + coalesce(quantite_endommagee, 0) + coalesce(quantite_manquante, 0) = quantite_attendue)
);
create index if not exists arrivage_lignes_produit_idx on public.arrivage_lignes (produit_id);

-- Prix de revient HT ACTUEL de chaque produit (valeur de la méthode de valorisation). Administrateur seulement.
create table if not exists public.produits_revient (
  produit_id text primary key references public.produits(id) on update cascade on delete cascade,
  prix_revient_ht numeric(12,4) not null check (prix_revient_ht >= 0),
  methode text not null,
  provisoire boolean not null default false,  -- calculé avec un taux de change provisoire
  maj_at timestamptz not null default now(),
  maj_par text
);

-- Historique par lot (ajout seul). Une correction de taux ajoute une ligne et RELIE l'ancienne (remplace_par) sans la modifier.
create table if not exists public.prix_revient_historique (
  id bigint generated always as identity primary key,
  produit_id text not null references public.produits(id) on update cascade on delete restrict,
  revient_ht numeric(12,4) not null check (revient_ht >= 0),   -- revient unitaire du LOT
  quantite integer not null check (quantite >= 0),             -- quantité entrée en stock pour ce lot
  stock_avant integer,                                         -- produits.stock juste avant la réception
  revient_moyen_avant numeric(12,4),                           -- revient du produit avant (NULL = inconnu)
  revient_moyen_apres numeric(12,4) not null,                  -- revient du produit après (méthode appliquée)
  methode text not null,
  source text not null default 'arrivage' check (source in ('arrivage', 'recalcul_taux')),
  arrivage_id bigint references public.arrivages(id) on delete restrict,
  date timestamptz not null default now(),
  provisoire boolean not null default false,                   -- revient du LOT calculé avec un taux provisoire
  moyen_avant_provisoire boolean,                              -- le revient du produit AVANT était provisoire
  moyen_apres_provisoire boolean not null default false,       -- revient du produit APRÈS provisoire (CUMP qui en intègre un)
  corrige_id bigint references public.prix_revient_historique(id),   -- ligne corrigée (recalcul de taux)
  remplace_par bigint references public.prix_revient_historique(id), -- ligne de correction qui la remplace
  cree_par text
);
create index if not exists prix_revient_historique_produit_idx on public.prix_revient_historique (produit_id, date);

create or replace function interne.prix_revient_historique_fige() returns trigger
language plpgsql set search_path = public, pg_catalog as $$
begin
  if tg_op = 'DELETE' then raise exception 'HISTORIQUE DES PRIX DE REVIENT : suppression interdite' using errcode = 'P0001'; end if;
  -- seule modification permise : relier une ligne PROVISOIRE à sa correction (une seule fois), sans toucher aux valeurs
  if old.provisoire and old.remplace_par is null and new.remplace_par is not null
     and (to_jsonb(new) - 'remplace_par') = (to_jsonb(old) - 'remplace_par') then
    return new;
  end if;
  raise exception 'HISTORIQUE DES PRIX DE REVIENT : modification interdite (ajout seul)' using errcode = 'P0001';
end $$;
drop trigger if exists prix_revient_historique_fige on public.prix_revient_historique;
create trigger prix_revient_historique_fige before update or delete on public.prix_revient_historique
  for each row execute function interne.prix_revient_historique_fige();

-- Droits : lecture ADMINISTRATEUR seulement (comme journal_financier) ; aucune écriture directe depuis l'application :
-- tout passe par les fonctions ci-dessous (ou par un administrateur côté serveur pour le chargement d'un arrivage).
do $$
declare t text;
begin
  foreach t in array array['arrivages', 'arrivage_lignes', 'produits_revient', 'prix_revient_historique'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated, public', t);
    execute format('grant select on table public.%I to anon', t);
    execute format('drop policy if exists sess_admin_lecture on public.%I', t);
    execute format('create policy sess_admin_lecture on public.%I for select to anon using ((select public.session_role()) = ''admin'')', t);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 4. Méthode de valorisation (CONSTANTE — CHOIX À VALIDER PAR BORHEN) et calcul du revient
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 'CUMP'         : nouveau = (stock_avant × revient_avant + qté_reçue × revient_lot) / (stock_avant + qté_reçue) ;
--                  revient_avant inconnu ou stock_avant ≤ 0 → revient du lot.
-- 'DERNIER_PRIX' : nouveau = revient du dernier lot reçu.
-- Même constante dans l'application : ARR_METHODE_VALORISATION (bloc ARR-DEBUT … ARR-FIN de maxiconfort-v7.html).
create or replace function interne.arrivage_methode_valorisation() returns text
language sql immutable as $$ select 'CUMP'::text $$;

create or replace function interne.revient_apres(p_methode text, p_stock_avant integer, p_revient_avant numeric, p_qte integer, p_revient_lot numeric)
returns numeric language sql immutable as $$
  select case
    when coalesce(p_qte, 0) <= 0 then p_revient_avant
    when p_methode = 'DERNIER_PRIX' or p_revient_avant is null or coalesce(p_stock_avant, 0) <= 0 then round(p_revient_lot, 4)
    else round((p_stock_avant * p_revient_avant + p_qte * p_revient_lot) / (p_stock_avant + p_qte), 4)
  end
$$;

-- Le revient du produit après réception est-il provisoire ? Revient du lot seul (dernier prix, pas de stock, revient inconnu)
-- → selon le lot ; moyenne pondérée → provisoire si le lot OU l'ancien revient l'est.
create or replace function interne.revient_provisoire_apres(p_methode text, p_stock_avant integer, p_revient_avant numeric, p_qte integer,
    p_prov_avant boolean, p_prov_lot boolean)
returns boolean language sql immutable as $$
  select case
    when coalesce(p_qte, 0) <= 0 then coalesce(p_prov_avant, false)
    when p_methode = 'DERNIER_PRIX' or p_revient_avant is null or coalesce(p_stock_avant, 0) <= 0 then coalesce(p_prov_lot, false)
    else coalesce(p_prov_lot, false) or coalesce(p_prov_avant, false)
  end
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 5. Validation de la réception (ADMINISTRATEUR, une seule fois, atomique)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- stock_entrees (migration 025) reçoit aussi chaque entrée d'arrivage (motif « arrivage:<réf> ») : stock-sync-shopify et
-- l'estimation de JARVIS comptent le stock à partir du dernier comptage validé + stock_entrees, jamais depuis produits.stock ;
-- l'application, elle, lit produits.stock et jamais stock_entrees : chaque source compte donc la réception UNE seule fois.
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.stock_entrees'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%motif%' loop
    execute format('alter table public.stock_entrees drop constraint %I', c.conname);
  end loop;
  alter table public.stock_entrees add constraint stock_entrees_motif_check
    check (motif in ('reassort', 'retour_gls', 'reprise_sav', 'correction') or motif like 'arrivage:%');
end $$;

-- p_lignes = [{"ligne_id": 12, "recue": 38, "endommagee": 1, "manquante": 1}, …] : UNE entrée par ligne de l'arrivage,
-- avec recue + endommagee + manquante = quantité attendue. Tout ou rien : la moindre erreur annule toute l'opération.
-- Verrous, toujours dans le même ordre (comme recalculer_revient_arrivage) : arrivage → produits (par id) → produits_revient
-- (par produit_id), AVANT toute lecture de l'ancienne valorisation.
create or replace function public.valider_reception_arrivage(p_arrivage_id bigint, p_lignes jsonb) returns json
language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
declare
  a public.arrivages%rowtype;
  l record; s jsonb; p record;
  v_methode text := interne.arrivage_methode_valorisation();
  v_rec integer; v_end integer; v_man integer;
  v_rev_avant numeric; v_prov_avant boolean; v_rev_apres numeric; v_prov_apres boolean; v_stock_avant integer;
  v_nb integer; v_resultat jsonb := '[]'::jsonb; v_total_recu integer := 0;
begin
  if (select public.session_role()) is distinct from 'admin' then
    return json_build_object('ok', false, 'erreur', 'session_admin_requise');
  end if;
  -- verrou : deux validations simultanées attendent l'une l'autre ; la seconde voit le statut « recu » et est refusée
  select * into a from public.arrivages where id = p_arrivage_id for update;
  if not found then return json_build_object('ok', false, 'erreur', 'arrivage_introuvable'); end if;
  if a.statut <> 'en_attente' then
    return json_build_object('ok', false, 'erreur', 'arrivage_deja_traite', 'statut', a.statut);
  end if;
  if jsonb_typeof(p_lignes) is distinct from 'array' then return json_build_object('ok', false, 'erreur', 'lignes_invalides'); end if;
  select count(*) into v_nb from public.arrivage_lignes where arrivage_id = a.id;
  if v_nb = 0 then return json_build_object('ok', false, 'erreur', 'arrivage_sans_ligne'); end if;
  if jsonb_array_length(p_lignes) <> v_nb
     or (select count(distinct (e ->> 'ligne_id')) from jsonb_array_elements(p_lignes) e) <> v_nb then
    return json_build_object('ok', false, 'erreur', 'une_saisie_par_ligne_requise');
  end if;

  -- verrous dans un ordre fixe (pas d'interblocage avec une autre réception ni un recalcul) : produits, PUIS produits_revient
  perform 1 from public.produits where id in (select produit_id from public.arrivage_lignes where arrivage_id = a.id) order by id for update;
  perform 1 from public.produits_revient where produit_id in (select produit_id from public.arrivage_lignes where arrivage_id = a.id) order by produit_id for update;

  for l in select * from public.arrivage_lignes where arrivage_id = a.id order by produit_id loop
    select e into s from jsonb_array_elements(p_lignes) e where e ->> 'ligne_id' = l.id::text;
    if s is null then raise exception 'SAISIE MANQUANTE pour la ligne %', l.id using errcode = 'P0001'; end if;
    begin
      v_rec := (s ->> 'recue')::integer; v_end := coalesce((s ->> 'endommagee')::integer, 0); v_man := coalesce((s ->> 'manquante')::integer, 0);
    exception when others then raise exception 'SAISIE INVALIDE pour la ligne % (nombres entiers attendus)', l.id using errcode = 'P0001';
    end;
    if v_rec is null or v_rec < 0 or v_end < 0 or v_man < 0 then
      raise exception 'SAISIE INVALIDE pour la ligne % (quantités positives ou nulles)', l.id using errcode = 'P0001';
    end if;
    if v_rec + v_end + v_man <> l.quantite_attendue then
      raise exception 'CONTRÔLE : ligne % — reçu % + endommagé % + manquant % ≠ attendu %', l.id, v_rec, v_end, v_man, l.quantite_attendue using errcode = 'P0001';
    end if;
    if v_rec > 0 and l.revient_unitaire_ht is null then
      raise exception 'REVIENT INCONNU pour la ligne % : impossible de valoriser le stock reçu', l.id using errcode = 'P0001';
    end if;

    update public.arrivage_lignes set quantite_recue = v_rec, quantite_endommagee = v_end, quantite_manquante = v_man where id = l.id;

    select id, nom, stock into p from public.produits where id = l.produit_id;
    v_stock_avant := coalesce(p.stock, 0);
    v_rev_avant := null; v_prov_avant := false;
    select prix_revient_ht, provisoire into v_rev_avant, v_prov_avant from public.produits_revient where produit_id = l.produit_id;
    v_prov_avant := coalesce(v_prov_avant, false);
    v_rev_apres := v_rev_avant; v_prov_apres := v_prov_avant;
    if v_rec > 0 then
      -- seules les quantités reçues en BON état entrent dans le stock disponible
      update public.produits set stock = coalesce(stock, 0) + v_rec, updated_at = now() where id = l.produit_id;
      insert into public.mouvements_stock (type, produit_libelle, quantite, source, destination, commande_id, tournee_id, livreur, par_user)
        values ('entree', p.nom, v_rec, 'arrivage:' || a.reference_interne, 'depot', null, null, null, 'admin');
      insert into public.stock_entrees (date_entree, app_produit_id, quantite, motif, cmd_id, saisi_par, remarque)
        values (now(), l.produit_id, v_rec, 'arrivage:' || a.reference_interne, null, 'admin', 'Réception d''arrivage validée dans l''application');
      v_rev_apres := interne.revient_apres(v_methode, v_stock_avant, v_rev_avant, v_rec, l.revient_unitaire_ht);
      -- un CUMP qui intègre un revient encore PROVISOIRE reste provisoire
      v_prov_apres := interne.revient_provisoire_apres(v_methode, v_stock_avant, v_rev_avant, v_rec, v_prov_avant, a.taux_provisoire);
      insert into public.produits_revient (produit_id, prix_revient_ht, methode, provisoire, maj_at, maj_par)
        values (l.produit_id, v_rev_apres, v_methode, v_prov_apres, now(), 'admin')
        on conflict (produit_id) do update set prix_revient_ht = excluded.prix_revient_ht, methode = excluded.methode,
          provisoire = excluded.provisoire, maj_at = excluded.maj_at, maj_par = excluded.maj_par;
      insert into public.prix_revient_historique (produit_id, revient_ht, quantite, stock_avant, revient_moyen_avant, revient_moyen_apres,
          methode, source, arrivage_id, provisoire, moyen_avant_provisoire, moyen_apres_provisoire, cree_par)
        values (l.produit_id, l.revient_unitaire_ht, v_rec, v_stock_avant, v_rev_avant, v_rev_apres, v_methode, 'arrivage', a.id, a.taux_provisoire,
          v_prov_avant, v_prov_apres, 'admin');
      v_total_recu := v_total_recu + v_rec;
    end if;
    v_resultat := v_resultat || jsonb_build_object('produit_id', l.produit_id, 'recue', v_rec, 'endommagee', v_end, 'manquante', v_man,
      'stock_avant', v_stock_avant, 'stock_apres', v_stock_avant + v_rec, 'revient_avant', v_rev_avant, 'revient_apres', v_rev_apres,
      'revient_provisoire', v_prov_apres);
  end loop;

  update public.arrivages set statut = 'recu', recu_le = now(), recu_par = 'admin', maj_at = now() where id = a.id;
  return json_build_object('ok', true, 'arrivage', a.reference_interne, 'methode', v_methode, 'total_recu', v_total_recu, 'lignes', v_resultat);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 6. Taux de change définitif (ADMINISTRATEUR, une seule fois par arrivage)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- revient d'une ligne = FOB × taux + frais d'import répartis uniformément sur les quantités attendues.
-- Arrivage en attente : seules les lignes changent. Arrivage reçu : lignes + revient des produits + historique (une ligne de
-- correction par produit, la ligne provisoire est reliée, jamais modifiée). Les commandes ne sont jamais touchées.
-- Produit qui a reçu un AUTRE lot depuis cet arrivage : RECALCUL EN CHAÎNE. Le revient du produit est recalculé lot après lot,
-- à partir du lot corrigé, avec les lignes d'historique EFFECTIVES des lots suivants (non remplacées : leur revient de lot,
-- leur quantité et leur stock d'avant), dans l'ordre de réception. Les lignes d'historique de ces lots suivants gardent leurs
-- valeurs d'époque (ajout seul) ; la réponse indique, par produit, le nombre de lots suivants recalculés. Le revient reste
-- provisoire tant qu'un lot de la chaîne l'est encore.
-- Verrous dans le même ordre que valider_reception_arrivage : arrivage → produits → produits_revient, avant toute lecture.
create or replace function public.recalculer_revient_arrivage(p_arrivage_id bigint, p_nouveau_taux numeric) returns json
language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
declare
  a public.arrivages%rowtype; l record; h record; x record;
  v_total integer; v_frais_u numeric; v_rev numeric; v_corrige numeric; v_prov boolean; v_cur numeric; v_chaine integer;
  v_id bigint; v_res jsonb := '[]'::jsonb;
begin
  if (select public.session_role()) is distinct from 'admin' then
    return json_build_object('ok', false, 'erreur', 'session_admin_requise');
  end if;
  if p_nouveau_taux is null or p_nouveau_taux <= 0 or p_nouveau_taux > 100 then
    return json_build_object('ok', false, 'erreur', 'taux_invalide');
  end if;
  select * into a from public.arrivages where id = p_arrivage_id for update;
  if not found then return json_build_object('ok', false, 'erreur', 'arrivage_introuvable'); end if;
  if a.statut = 'annule' then return json_build_object('ok', false, 'erreur', 'arrivage_annule'); end if;
  if not a.taux_provisoire then return json_build_object('ok', false, 'erreur', 'taux_deja_definitif'); end if;
  select sum(quantite_attendue), count(*) filter (where fob_unitaire is null) into v_total, v_id from public.arrivage_lignes where arrivage_id = a.id;
  if coalesce(v_total, 0) = 0 then return json_build_object('ok', false, 'erreur', 'arrivage_sans_ligne'); end if;
  if v_id > 0 then return json_build_object('ok', false, 'erreur', 'fob_manquant'); end if;
  v_frais_u := a.frais_import_ht / v_total;

  if a.statut = 'recu' then
    perform 1 from public.produits where id in (select produit_id from public.arrivage_lignes where arrivage_id = a.id) order by id for update;
    perform 1 from public.produits_revient where produit_id in (select produit_id from public.arrivage_lignes where arrivage_id = a.id) order by produit_id for update;
  end if;
  for l in select * from public.arrivage_lignes where arrivage_id = a.id order by produit_id loop
    v_rev := round(l.fob_unitaire * p_nouveau_taux + v_frais_u, 4);
    update public.arrivage_lignes set revient_unitaire_ht = v_rev where id = l.id;
    if a.statut = 'recu' then
      select * into h from public.prix_revient_historique
       where arrivage_id = a.id and produit_id = l.produit_id and source = 'arrivage' and remplace_par is null;
      if found then
        v_corrige := interne.revient_apres(h.methode, h.stock_avant, h.revient_moyen_avant, h.quantite, v_rev);
        v_prov := interne.revient_provisoire_apres(h.methode, h.stock_avant, h.revient_moyen_avant, h.quantite, coalesce(h.moyen_avant_provisoire, false), false);
        insert into public.prix_revient_historique (produit_id, revient_ht, quantite, stock_avant, revient_moyen_avant, revient_moyen_apres,
            methode, source, arrivage_id, provisoire, moyen_avant_provisoire, moyen_apres_provisoire, corrige_id, cree_par)
          values (l.produit_id, v_rev, h.quantite, h.stock_avant, h.revient_moyen_avant, v_corrige, h.methode, 'recalcul_taux', a.id, false,
            h.moyen_avant_provisoire, v_prov, h.id, 'admin')
          returning id into v_id;
        update public.prix_revient_historique set remplace_par = v_id where id = h.id;
        -- chaîne : lots reçus APRÈS celui-ci, lignes effectives seulement, dans l'ordre
        v_cur := v_corrige; v_chaine := 0;
        for x in select * from public.prix_revient_historique
                  where produit_id = l.produit_id and id > h.id and remplace_par is null and arrivage_id is distinct from a.id
                  order by id loop
          v_prov := interne.revient_provisoire_apres(x.methode, x.stock_avant, v_cur, x.quantite, v_prov, x.provisoire);
          v_cur := interne.revient_apres(x.methode, x.stock_avant, v_cur, x.quantite, x.revient_ht);
          v_chaine := v_chaine + 1;
        end loop;
        update public.produits_revient set prix_revient_ht = v_cur, provisoire = v_prov, maj_at = now(), maj_par = 'admin'
         where produit_id = l.produit_id;
        v_res := v_res || jsonb_build_object('produit_id', l.produit_id, 'revient_lot', v_rev, 'revient_apres_lot', v_corrige,
          'lots_suivants_recalcules', v_chaine, 'revient_produit', v_cur, 'revient_provisoire', v_prov);
      end if;
    else
      v_res := v_res || jsonb_build_object('produit_id', l.produit_id, 'revient_lot', v_rev);
    end if;
  end loop;
  update public.arrivages set taux_change = p_nouveau_taux, taux_provisoire = false, maj_at = now() where id = a.id;
  return json_build_object('ok', true, 'arrivage', a.reference_interne, 'lignes', v_res);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 7. Stock ENTRANT (arrivages en attente) — administrateur et collaboratrice, SANS aucun prix
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.stock_entrant() returns table (produit_id text, quantite bigint, arrivages bigint)
language plpgsql stable security definer set search_path = public, pg_catalog as $$
begin
  if coalesce((select public.session_role()), '') not in ('admin', 'collab') then return; end if;
  return query
    select l.produit_id, sum(l.quantite_attendue)::bigint, count(distinct l.arrivage_id)::bigint
      from public.arrivage_lignes l join public.arrivages a on a.id = l.arrivage_id
     where a.statut = 'en_attente'
     group by l.produit_id;
end $$;

revoke all on function public.valider_reception_arrivage(bigint, jsonb) from public, anon, authenticated;
revoke all on function public.recalculer_revient_arrivage(bigint, numeric) from public, anon, authenticated;
revoke all on function public.stock_entrant() from public, anon, authenticated;
grant execute on function public.valider_reception_arrivage(bigint, jsonb) to anon;
grant execute on function public.recalculer_revient_arrivage(bigint, numeric) to anon;
grant execute on function public.stock_entrant() to anon;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 8. Contrôle à l'application de la migration : mouvements_stock accepte une entrée « entree » (essai annulé, rien n'est écrit)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
do $$
begin
  begin
    insert into public.mouvements_stock (type, produit_libelle, quantite, source, destination, commande_id, tournee_id, livreur, par_user)
      values ('entree', '#TEST-ARRIVAGE', 1, 'arrivage:#TEST', 'depot', null, null, null, 'admin');
    raise exception 'essai_annule';
  exception when others then
    if sqlerrm <> 'essai_annule' then
      raise exception 'mouvements_stock refuse une entrée d''arrivage (%). Migration annulée : adapter l''insertion de valider_reception_arrivage.', sqlerrm;
    end if;
  end;
end $$;
