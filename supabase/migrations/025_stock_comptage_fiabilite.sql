-- 025 (30/09/2026) : stock par ÉVÉNEMENTS à partir d'un comptage horodaté.
-- Le disponible n'est plus calculé depuis produits.stock (modifié par le navigateur à la
-- livraison, alors que gls-sync passe des commandes « livré » côté serveur sans déduction).
--   disponible(simple) = compté − Σ qte des commandes non annulées qui consomment le stock
--                        compté (toutes sauf 'sortie_avant') + entrées après la fin du comptage
-- Recalculé entièrement à chaque passage (idempotent). Voir docs/stock-synchronisation.md.
-- Toutes les tables : accès serveur uniquement (RLS sans politique). Aucune donnée client.

-- 1. Fiabilité des correspondances variante Shopify -> produit app
alter table public.stock_correspondance
  add column if not exists fiabilite text not null default 'absente'
    check (fiabilite in ('certaine', 'incertaine', 'absente')),
  add column if not exists motif text;
comment on column public.stock_correspondance.app_produit_id is
  'Produit app. Utilisé (import des commandes, écriture Shopify) SEULEMENT si fiabilite = certaine ; sinon simple candidat.';

-- 2. Comptages
create table if not exists public.stock_comptage (
  id bigint generated always as identity primary key,
  debut timestamptz not null,
  fin timestamptz not null,
  statut text not null default 'brouillon' check (statut in ('brouillon', 'valide')),
  saisi_par text,
  remarque text,
  valide_at timestamptz,
  cree_at timestamptz not null default now(),
  check (fin > debut)
);

create table if not exists public.stock_comptage_lignes (
  comptage_id bigint not null references public.stock_comptage(id) on delete cascade,
  app_produit_id text not null references public.produits(id) on update cascade,
  quantite integer not null check (quantite >= 0),
  remarque text,
  primary key (comptage_id, app_produit_id)
);

-- Instantané pris à la validation : où était chaque commande (non annulée) pendant le comptage
create table if not exists public.stock_comptage_commandes (
  comptage_id bigint not null references public.stock_comptage(id) on delete cascade,
  cmd_id text not null,
  situation text not null check (situation in ('sortie_avant', 'dans_stock', 'a_verifier')),
  motif text,
  decision_par text,          -- rempli quand une situation 'a_verifier' est tranchée à la main
  decision_at timestamptz,
  primary key (comptage_id, cmd_id)
);

-- Un comptage validé est figé (lignes et instantané non modifiables, sauf décision sur 'a_verifier')
create or replace function public._stock_comptage_fige()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
declare st text;
begin
  select statut into st from public.stock_comptage where id = coalesce(new.comptage_id, old.comptage_id);
  if st = 'valide' then
    if tg_table_name = 'stock_comptage_commandes' and tg_op = 'UPDATE'
       and old.situation = 'a_verifier' and new.cmd_id = old.cmd_id then
      return new;             -- décision sur une commande à vérifier : autorisée
    end if;
    raise exception 'comptage % validé : modification interdite', coalesce(new.comptage_id, old.comptage_id);
  end if;
  return coalesce(new, old);
end $$;

create or replace function public._stock_comptage_entete_fige()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op = 'DELETE' then
    if old.statut = 'valide' then raise exception 'comptage % validé : suppression interdite', old.id; end if;
    return old;
  end if;
  if old.statut = 'valide' and (new.debut is distinct from old.debut or new.fin is distinct from old.fin
     or new.statut is distinct from old.statut) then
    raise exception 'comptage % validé : debut/fin/statut non modifiables', old.id;
  end if;
  return new;
end $$;
drop trigger if exists stock_comptage_entete_fige on public.stock_comptage;
create trigger stock_comptage_entete_fige before update or delete on public.stock_comptage
  for each row execute function public._stock_comptage_entete_fige();

drop trigger if exists stock_comptage_lignes_fige on public.stock_comptage_lignes;
create trigger stock_comptage_lignes_fige before insert or update or delete on public.stock_comptage_lignes
  for each row execute function public._stock_comptage_fige();
drop trigger if exists stock_comptage_commandes_fige on public.stock_comptage_commandes;
create trigger stock_comptage_commandes_fige before insert or update or delete on public.stock_comptage_commandes
  for each row execute function public._stock_comptage_fige();

-- 3. Entrées de stock après comptage (réassorts, retours CONSTATÉS au dépôt).
-- mouvements_stock ne contient que des mouvements camion (chargement / retour_depot, par
-- libellé) : aucune entrée fournisseur n'y est enregistrée -> source dédiée, par produit.
create table if not exists public.stock_entrees (
  id bigint generated always as identity primary key,
  date_entree timestamptz not null default now(),
  app_produit_id text not null references public.produits(id) on update cascade,
  quantite integer not null check (quantite > 0),
  motif text not null check (motif in ('reassort', 'retour_gls', 'reprise_sav', 'correction')),
  cmd_id text,
  saisi_par text,
  remarque text,
  cree_at timestamptz not null default now()
);

-- 4. Sauvegarde des valeurs Shopify avant toute écriture
create table if not exists public.stock_sauvegarde_shopify (
  id bigint generated always as identity primary key,
  lot text not null,
  comptage_id bigint references public.stock_comptage(id),
  shopify_variant_id bigint not null,
  inventory_item_id text not null,
  location_id text not null,
  available integer,
  committed integer,
  on_hand integer,
  cible integer,
  cree_at timestamptz not null default now()
);
create index if not exists stock_sauvegarde_shopify_lot_idx on public.stock_sauvegarde_shopify (lot);

do $$
declare t text;
begin
  foreach t in array array['stock_comptage', 'stock_comptage_lignes', 'stock_comptage_commandes',
                           'stock_entrees', 'stock_sauvegarde_shopify'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated, public', t);
  end loop;
end $$;
