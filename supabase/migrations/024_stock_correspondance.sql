-- 024 (29/09/2026) : correspondance variantes Shopify <-> produits de l'app.
-- Sert à :
--   * shopify-sync v7 : renseigner lignes[].produitId des commandes du site
--     (sinon leurs ventes ne déduisent jamais le stock de l'app) ;
--   * stock-sync-shopify : calculer la quantité « available » à publier sur Shopify
--     pour chaque variante reliée.
-- Une variante sans app_produit_id (NULL) est simplement ignorée (comportement d'avant).
-- actif = false : variante d'un produit Shopify brouillon / archivé (jamais synchronisée).
-- Le pré-remplissage (identifiants et titres Shopify) est fait par script via l'API
-- (service_role), pas dans ce fichier : dépôt public.

create table if not exists public.stock_correspondance (
  shopify_variant_id bigint primary key,
  shopify_sku text,
  libelle text,                                    -- « titre produit — titre variante »
  app_produit_id text references public.produits(id) on update cascade on delete set null,
  actif boolean not null default true,
  note text,                                       -- ex. « approx. : sommier non différencié par couleur »
  maj timestamptz not null default now()
);

create index if not exists stock_correspondance_app_produit_idx
  on public.stock_correspondance (app_produit_id);

create or replace function public._stock_correspondance_maj()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  new.maj := now();
  return new;
end $$;

drop trigger if exists stock_correspondance_maj on public.stock_correspondance;
create trigger stock_correspondance_maj before update on public.stock_correspondance
  for each row execute function public._stock_correspondance_maj();

-- Accès service_role uniquement (Edge Functions / scripts serveur) : RLS sans politique.
alter table public.stock_correspondance enable row level security;
alter table public.stock_correspondance force row level security;
revoke all on table public.stock_correspondance from anon, authenticated, public;
