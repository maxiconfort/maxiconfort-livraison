-- 030_motif_annulation.sql — 07/10/2026 — MOTIF D'ANNULATION (décision de Borhen : comprendre et réduire les annulations).
--
-- * commandes : 4 colonnes posées au moment où une commande passe « annulé » (motif, commentaire, personne, date et heure).
-- * journal_annulations : une ligne par annulation (numéro, date et heure, canal d'origine, produit, montant,
--   Île-de-France / province, motif, commentaire, personne). Ajout seul : ni modification ni suppression.
-- * L'application (v7.5.117) rend le motif obligatoire. La base, elle, ne REFUSE jamais une annulation : une écriture sans
--   motif (ancienne version de l'application encore en cache, programme serveur) est enregistrée « Non renseigné ».
-- * Les annulations antérieures ne sont PAS modifiées (colonnes vides = annulation d'avant le 07/10/2026).
-- * Aucun champ de paiement n'est touché : les déclencheurs paiement_verrou / paiement_journal restent inchangés.
--
-- RETOUR ARRIÈRE (sans perte de données ; les colonnes et le journal peuvent rester en place, ils sont inoffensifs) :
--   drop trigger if exists annulation_trace on public.commandes;
--   drop trigger if exists annulation_journal on public.commandes;
--   puis revenir à l'application v7.5.116 (étiquette git « v7.5.116-avant-motif-annulation »).

alter table public.commandes
  add column if not exists annulation_motif text,
  add column if not exists annulation_commentaire text,
  add column if not exists annulation_par text,          -- admin | collab | livreur:NOM | serveur
  add column if not exists annulation_at timestamptz;

create table if not exists public.journal_annulations (
  id bigserial primary key,
  cree_at timestamptz not null default now(),
  cmd_id text not null,
  origine text,                  -- canal : LeBonCoin, Site Maxiconfort, TikTok Shop…
  produit text,
  montant numeric,
  zone text,                     -- Île-de-France | province | inconnue (d'après le code postal de l'adresse)
  date_commande date,
  statut_avant text,
  motif text not null,
  commentaire text,
  enregistre_par text,           -- admin | collab | livreur:NOM | serveur
  origine_action text            -- application | serveur
);
create index if not exists journal_annulations_cmd_idx on public.journal_annulations (cmd_id, cree_at);
alter table public.journal_annulations enable row level security;
alter table public.journal_annulations force row level security;
revoke all on table public.journal_annulations from anon, authenticated, public;
revoke all on sequence public.journal_annulations_id_seq from anon, authenticated, public;
grant select on table public.journal_annulations to anon;
drop policy if exists sess_admin_lecture on public.journal_annulations;
create policy sess_admin_lecture on public.journal_annulations for select to anon
  using ((select public.session_role()) = 'admin');

create or replace function interne._journal_annulations_fige() returns trigger
language plpgsql as $$
begin
  raise exception 'journal_annulations : ajout seul (ni modification ni suppression)';
end $$;
drop trigger if exists journal_annulations_fige on public.journal_annulations;
create trigger journal_annulations_fige before update or delete on public.journal_annulations
  for each row execute function interne._journal_annulations_fige();

-- Avant écriture : pose motif / commentaire / personne / date au passage à « annulé » ; hors de ce passage, ces 4 colonnes
-- ne se modifient pas (une annulation déjà enregistrée garde son motif ; une commande non annulée n'en a pas).
create or replace function public._annulation_trace() returns trigger
language plpgsql security definer set search_path = public, interne, pg_catalog as $$
begin
  if tg_op = 'INSERT' then
    -- écriture « créer ou mettre à jour » sur une ligne existante : c'est la mise à jour qui décide
    if exists (select 1 from public.commandes where id = new.id) then return new; end if;
    if new.statut = 'annulé' then
      new.annulation_motif := coalesce(nullif(btrim(new.annulation_motif), ''), 'Non renseigné');
      new.annulation_commentaire := nullif(btrim(new.annulation_commentaire), '');
      new.annulation_par := interne._acteur_paiement();
      new.annulation_at := now();
    else
      new.annulation_motif := null; new.annulation_commentaire := null; new.annulation_par := null; new.annulation_at := null;
    end if;
    return new;
  end if;
  if new.statut = 'annulé' and old.statut is distinct from 'annulé' then
    new.annulation_motif := coalesce(nullif(btrim(new.annulation_motif), ''), 'Non renseigné');
    new.annulation_commentaire := nullif(btrim(new.annulation_commentaire), '');
    new.annulation_par := interne._acteur_paiement();
    new.annulation_at := now();
  elsif old.statut = 'annulé' and new.statut is distinct from 'annulé' then
    -- commande remise en cours : la fiche repart sans motif, le journal garde la trace de l'annulation passée
    new.annulation_motif := null; new.annulation_commentaire := null; new.annulation_par := null; new.annulation_at := null;
  else
    new.annulation_motif := old.annulation_motif; new.annulation_commentaire := old.annulation_commentaire;
    new.annulation_par := old.annulation_par; new.annulation_at := old.annulation_at;
  end if;
  return new;
end $$;
drop trigger if exists annulation_trace on public.commandes;
create trigger annulation_trace before insert or update on public.commandes
  for each row execute function public._annulation_trace();

-- Après écriture : une ligne de journal par passage à « annulé ».
create or replace function public._annulation_journal() returns trigger
language plpgsql security definer set search_path = public, interne, pg_catalog as $$
declare cp text;
begin
  if new.statut = 'annulé' and (tg_op = 'INSERT' or old.statut is distinct from 'annulé') then
    cp := substring(coalesce(new.adresse, '') from '(\d{5})');
    insert into public.journal_annulations (cmd_id, origine, produit, montant, zone, date_commande, statut_avant, motif, commentaire, enregistre_par, origine_action)
    values (new.id, new.origine, new.produit, new.prix,
      case when cp is null then 'inconnue' when cp ~ '^(75|77|78|91|92|93|94|95)' then 'Île-de-France' else 'province' end,
      new.date_commande, case when tg_op = 'INSERT' then null else old.statut end,
      coalesce(new.annulation_motif, 'Non renseigné'), new.annulation_commentaire, new.annulation_par,
      case when public.session_role() is null then 'serveur' else 'application' end);
  end if;
  return new;
end $$;
drop trigger if exists annulation_journal on public.commandes;
create trigger annulation_journal after insert or update on public.commandes
  for each row execute function public._annulation_journal();

notify pgrst, 'reload schema';
