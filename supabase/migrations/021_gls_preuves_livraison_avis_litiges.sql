-- ════════════════════════════════════════════════════════════════════
-- 021 (28/09/2026) - Preuves de livraison GLS, alerte « sans premier scan »,
--                    suspension des demandes d'avis pendant un litige/SAV.
-- Appliquée via l'API Management. AUCUNE valeur secrète ici : les crons
-- passent par interne.appel_fonction (secret interne lu dans Vault, cf. 019).
-- ════════════════════════════════════════════════════════════════════

-- 1. Etat de livraison calculé par gls-sync v15 (affichable, lu par sms-avis)
alter table public.commandes add column if not exists gls_livraison_etat text;     -- livre | partiel | retour | transit | non_pris_en_charge | erreur
alter table public.commandes add column if not exists gls_livraison_detail text;   -- ex. « livraison partielle 2/3 »
alter table public.commandes add column if not exists gls_livraison_verif_at timestamptz;

-- 2. Date de clôture d'un litige (pour la reprise de la demande d'avis à J+2)
alter table public.commandes add column if not exists litige_clos_at timestamptz;

create or replace function public._litige_clos_at() returns trigger
language plpgsql set search_path = public, pg_catalog as $$
declare fermes text[] := array['indemnise','refuse','clos','close','cloture','resolu','termine','ferme'];
begin
  if coalesce(new.litige_statut,'') is distinct from coalesce(old.litige_statut,'') then
    if coalesce(new.litige_statut,'') = '' or lower(new.litige_statut) = any(fermes) then
      -- passage d'un litige OUVERT à clos (ou effacé) : on date la clôture
      if coalesce(old.litige_statut,'') <> '' and not (lower(old.litige_statut) = any(fermes)) then
        new.litige_clos_at := now();
      end if;
    else
      new.litige_clos_at := null;  -- (ré)ouverture
    end if;
  end if;
  return new;
end $$;
drop trigger if exists litige_clos_at on public.commandes;
create trigger litige_clos_at before update on public.commandes
  for each row execute function public._litige_clos_at();

-- 3. Cache des colis GLS déjà pris en charge (plus jamais interrogés par l'alerte)
create table if not exists public.gls_colis (
  track_id text primary key,
  cmd_id text,
  prise_en_charge_at timestamptz,
  etat text,
  verifie_at timestamptz not null default now()
);
alter table public.gls_colis enable row level security;
alter table public.gls_colis force row level security;
revoke all on table public.gls_colis from anon, authenticated, public;

-- 4. Anti-doublon des alertes GLS (1 ligne par type, colis/commande et jour)
create table if not exists public.gls_alertes (
  type text not null,          -- 'sans-scan' | 'livraison-partiel' | 'livraison-retour'
  cle text not null,           -- n° de colis ou id de commande
  jour date not null,
  cmd_id text,
  message text,
  envoye boolean,
  cree_at timestamptz not null default now(),
  primary key (type, cle, jour)
);
alter table public.gls_alertes enable row level security;
alter table public.gls_alertes force row level security;
revoke all on table public.gls_alertes from anon, authenticated, public;

-- 5. Crons alerte-gls-sans-scan : 18h Paris lun-ven, 10h Paris samedi.
--    pg_cron est en UTC : 2 heures UTC par créneau (été/hiver), la fonction
--    ne travaille que dans le bon créneau (body creneau:true).
select cron.schedule('alerte-gls-sans-scan-semaine', '0 16,17 * * 1-5',
  $$select interne.appel_fonction('alerte-gls-sans-scan', '{"creneau":true}'::jsonb, 150000);$$);
select cron.schedule('alerte-gls-sans-scan-samedi', '0 8,9 * * 6',
  $$select interne.appel_fonction('alerte-gls-sans-scan', '{"creneau":true}'::jsonb, 150000);$$);
