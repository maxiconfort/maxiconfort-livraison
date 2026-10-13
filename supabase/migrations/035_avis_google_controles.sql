-- Migration 035 (13/10/2026) : controle Google Avis du matin AVANT les relances
-- Decision Borhen : chaque matin a 7 h 30, les avis Google recents sont releves et les
-- rapprochements certains ecrits dans avis_google_recus, avant le passage des relances.
-- Si ce controle n'a pas pu etre fait, les relances ne doivent pas partir en silence :
-- sms-avis-relance v2.5 lit cette table et envoie une alerte (Telegram) quand aucune ligne
-- « ok » n'existe pour le jour.
create table if not exists public.avis_google_controles (
  jour        date        primary key,
  statut      text        not null check (statut in ('ok', 'echec', 'non_fait')),
  fait_at     timestamptz,
  nb_avis     integer,
  nb_marques  integer,
  detail      text,
  alerte_at   timestamptz
);
alter table public.avis_google_controles enable row level security;
revoke all on public.avis_google_controles from anon, authenticated;
