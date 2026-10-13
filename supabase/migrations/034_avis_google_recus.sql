-- Migration 034 (13/10/2026) : arret des relances d'avis quand le client a deja laisse son avis Google
-- Decision Borhen : des qu'un avis Google est rapproche avec certitude d'un client, plus aucune
-- demande ni relance ne part, QUELLE QUE SOIT LA NOTE (1 a 5 etoiles : meme traitement).
--
-- avis_google_recus     : un avis rapproche d'une fiche. Seuls deux types existent :
--                         'certain' (nom complet concordant, un seul client possible) et
--                         'valide'  (rapprochement valide par le dirigeant : pseudo, conjoint...).
--                         La colonne note sert a l'audit ; aucune fonction ne la lit pour decider.
-- avis_relances_bloquees: journal des SMS d'avis non envoyes pour cette raison (audit).
-- Tables internes : RLS active sans politique (seules les fonctions serveur y accedent).

create table if not exists public.avis_google_recus (
  id          bigint generated always as identity primary key,
  cmd_id      text        not null,
  tel_cle     text,
  nom_google  text        not null,
  note        smallint    check (note between 1 and 5),
  date_avis   date,
  type_match  text        not null check (type_match in ('certain', 'valide')),
  raison      text,
  source      text        not null default 'GOOGLE',
  created_at  timestamptz not null default now(),
  unique (cmd_id, nom_google)
);
create index if not exists avis_google_recus_tel_cle on public.avis_google_recus (tel_cle);

create table if not exists public.avis_relances_bloquees (
  id            bigint generated always as identity primary key,
  cmd_id        text        not null,
  type_sms      text        not null,
  client        text,
  commande_site text,
  nom_google    text,
  note          smallint,
  date_avis     date,
  type_match    text,
  raison        text        not null default 'RELANCE ANNULEE - AVIS GOOGLE DEJA RECU',
  created_at    timestamptz not null default now(),
  unique (cmd_id, type_sms)
);

alter table public.avis_google_recus      enable row level security;
alter table public.avis_relances_bloquees enable row level security;
revoke all on public.avis_google_recus, public.avis_relances_bloquees from anon, authenticated;
