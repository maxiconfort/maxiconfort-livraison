-- 027 (03/10/2026) : PAIEMENT — origine structurée, verrou côté base, journal financier, caisse comptée.
-- Contexte : audit du 03/10/2026 (commandes du site payées en ligne devenues « Espèces » à
-- l'enregistrement de leur fiche). La v7.5.113 de l'application corrige l'écran ; cette
-- migration place la protection DANS LA BASE, pour qu'elle ne dépende plus de l'interface.
-- Aucune valeur secrète. Aucune donnée financière existante n'est modifiée : les colonnes
-- paie / stpaie / montant_enc ne sont pas touchées ; seule la NOUVELLE colonne payment_source
-- est renseignée pour les commandes existantes.

-- ── 1. Colonnes ─────────────────────────────────────────────────────────────────────
alter table public.commandes
  add column if not exists payment_source text,          -- SHOPIFY_ONLINE | DELIVERY | LEBONCOIN | TIKTOK | MANUAL
  add column if not exists payment_transactions text,    -- identifiants des transactions Shopify (séparés par des virgules)
  add column if not exists ticket_cb text,               -- référence du ticket du terminal de carte (encaissement livreur)
  add column if not exists encaisse_par text,            -- livreur qui a déclaré l'encaissement
  add column if not exists encaisse_at timestamptz;      -- date et heure de la déclaration
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'commandes_payment_source_chk') then
    alter table public.commandes add constraint commandes_payment_source_chk
      check (payment_source is null or payment_source in ('SHOPIFY_ONLINE','DELIVERY','LEBONCOIN','TIKTOK','MANUAL'));
  end if;
end $$;

alter table public.caisse_remises
  add column if not exists especes_attendues numeric,
  add column if not exists especes_remises numeric,
  add column if not exists ecart numeric,
  add column if not exists cb_encaisse numeric,
  add column if not exists commentaire text;

-- ── 2. Journal financier (ajout seul : ni modification ni suppression) ──────────────
create table if not exists public.journal_financier (
  id bigserial primary key,
  cree_at timestamptz not null default now(),
  cmd_id text not null,
  action text not null,          -- creation | modification | modification_admin | tentative_bloquee
  ancien jsonb,                  -- valeurs avant
  nouveau jsonb,                 -- valeurs après (ou valeurs REFUSÉES pour une tentative bloquée)
  montant numeric,               -- montant payé après l'action
  reste_du numeric,              -- reste dû après l'action
  utilisateur text,              -- admin | collab | livreur:NOM | serveur
  origine_action text,           -- application | serveur | action_admin
  motif text                     -- obligatoire pour une modification administrateur
);
create index if not exists journal_financier_cmd_idx on public.journal_financier (cmd_id, cree_at);
alter table public.journal_financier enable row level security;
alter table public.journal_financier force row level security;
revoke all on table public.journal_financier from anon, authenticated, public;
revoke all on sequence public.journal_financier_id_seq from anon, authenticated, public;
grant select on table public.journal_financier to anon;
drop policy if exists sess_admin_lecture on public.journal_financier;
create policy sess_admin_lecture on public.journal_financier for select to anon
  using ((select public.session_role()) = 'admin');

create or replace function interne._journal_financier_fige() returns trigger
language plpgsql as $$
begin
  raise exception 'journal_financier : ajout seul (ni modification ni suppression)';
end $$;
drop trigger if exists journal_financier_fige on public.journal_financier;
create trigger journal_financier_fige before update or delete on public.journal_financier
  for each row execute function interne._journal_financier_fige();

-- ── 3. Origine du paiement : règle de classement ────────────────────────────────────
-- Commande du site = origine « Site Maxiconfort » + identifiant Shopify numérique. À
-- l'import (shopify-sync) elle est soit payée en ligne, soit en « paiement à la livraison »
-- (statut Non payé + consigne dans les instructions). Les autres origines ne sont pas
-- verrouillées : leur fonctionnement ne change pas.
create or replace function interne._payment_source_derive(p_origine text, p_ref text, p_stpaie text, p_instr text)
returns text language sql immutable as $$
  select case
    when coalesce(p_origine, '') = 'Site Maxiconfort' and coalesce(p_ref, '') ~ '^[0-9]{6,}$' then
      case when coalesce(p_instr, '') ~* 'PAIEMENT\s+[ÀA]\s+LA\s+LIVRAISON\s*:' then 'DELIVERY'
           when coalesce(p_stpaie, '') = 'Payé' then 'SHOPIFY_ONLINE'
           else 'DELIVERY' end
    when coalesce(p_origine, '') ilike 'leboncoin%' then 'LEBONCOIN'
    when coalesce(p_origine, '') ilike 'tiktok%' then 'TIKTOK'
    else 'MANUAL'
  end;
$$;

-- Commandes existantes : renseigner la nouvelle colonne (avant la pose des déclencheurs,
-- pour ne pas créer une ligne de journal par commande). Aucune autre colonne modifiée.
update public.commandes
   set payment_source = interne._payment_source_derive(origine, ref_marketplace, stpaie, instr)
 where payment_source is null;

-- Acteur de l'action en cours (session de l'application, sinon serveur)
create or replace function interne._acteur_paiement() returns text
language plpgsql stable security definer set search_path = public, pg_catalog as $$
declare r text; l text; f text;
begin
  f := nullif(current_setting('app.fin_acteur', true), '');
  if f is not null then return f; end if;
  r := public.session_role();
  if r is null then return 'serveur'; end if;
  if r = 'livreur' then l := public.session_livreur(); return 'livreur:' || coalesce(l, '?'); end if;
  return r;
end $$;

-- ── 4. Verrou (avant écriture) ──────────────────────────────────────────────────────
-- * payment_source et payment_transactions : posés une fois, jamais changés par une
--   sauvegarde ordinaire (ni par l'application, ni par un script).
-- * commande SHOPIFY_ONLINE : paie / stpaie / montant_enc restaurés à leur valeur en base,
--   la tentative est notée dans le journal. Seule l'action administrateur dédiée
--   (public.modifier_paiement, avec motif) lève le verrou pour la durée de sa transaction.
create or replace function public._paiement_verrou() returns trigger
language plpgsql security definer set search_path = public, interne, pg_catalog as $$
declare fin_ok boolean := coalesce(current_setting('app.fin_ok', true), '') = '1';
begin
  if tg_op = 'INSERT' then
    -- la base classe TOUJOURS elle-même la commande : une valeur fournie par l'appelant
    -- (application ou programme serveur) est ignorée. Défaut trouvé au test du 03/10 : une
    -- commande « paiement à la livraison » créée avec la valeur SHOPIFY_ONLINE était acceptée.
    new.payment_source := interne._payment_source_derive(new.origine, new.ref_marketplace, new.stpaie, new.instr);
    if public.session_role() is not null then new.payment_transactions := null; end if;
    return new;
  end if;
  if fin_ok then return new; end if;
  if old.payment_source is not null then
    new.payment_source := old.payment_source;
  else
    new.payment_source := interne._payment_source_derive(new.origine, new.ref_marketplace, new.stpaie, new.instr);
  end if;
  if old.payment_transactions is not null or public.session_role() is not null then
    new.payment_transactions := old.payment_transactions;
  end if;
  if old.payment_source = 'SHOPIFY_ONLINE'
     and (new.paie is distinct from old.paie or new.stpaie is distinct from old.stpaie
          or coalesce(new.montant_enc, 0) is distinct from coalesce(old.montant_enc, 0)) then
    insert into public.journal_financier (cmd_id, action, ancien, nouveau, montant, reste_du, utilisateur, origine_action, motif)
    values (old.id, 'tentative_bloquee',
      jsonb_build_object('paie', old.paie, 'stpaie', old.stpaie, 'montant_enc', old.montant_enc),
      jsonb_build_object('paie', new.paie, 'stpaie', new.stpaie, 'montant_enc', new.montant_enc),
      old.montant_enc, 0, interne._acteur_paiement(),
      case when public.session_role() is null then 'serveur' else 'application' end,
      'Commande payée en ligne : paiement non modifiable par une sauvegarde ordinaire');
    new.paie := old.paie; new.stpaie := old.stpaie; new.montant_enc := old.montant_enc;
  end if;
  -- une commande payée en ligne ne reçoit ni ticket ni encaissement livreur
  if old.payment_source = 'SHOPIFY_ONLINE' then
    new.ticket_cb := old.ticket_cb; new.encaisse_par := old.encaisse_par; new.encaisse_at := old.encaisse_at;
  end if;
  return new;
end $$;
drop trigger if exists paiement_verrou on public.commandes;
create trigger paiement_verrou before insert or update on public.commandes
  for each row execute function public._paiement_verrou();

-- ── 5. Journal (après écriture) + alerte « livré non encaissé » ─────────────────────
create or replace function public._paiement_journal() returns trigger
language plpgsql security definer set search_path = public, interne, pg_catalog as $$
declare fin_ok boolean := coalesce(current_setting('app.fin_ok', true), '') = '1';
        du numeric;
begin
  du := case when new.stpaie = 'Payé' then 0 else greatest(0, coalesce(new.prix, 0) - coalesce(new.montant_enc, 0)) end;
  if tg_op = 'INSERT' then
    insert into public.journal_financier (cmd_id, action, ancien, nouveau, montant, reste_du, utilisateur, origine_action)
    values (new.id, 'creation', null,
      jsonb_build_object('paie', new.paie, 'stpaie', new.stpaie, 'montant_enc', new.montant_enc, 'prix', new.prix, 'payment_source', new.payment_source),
      new.montant_enc, du, interne._acteur_paiement(),
      case when public.session_role() is null then 'serveur' else 'application' end);
    return null;
  end if;
  if new.paie is distinct from old.paie or new.stpaie is distinct from old.stpaie
     or coalesce(new.montant_enc, 0) is distinct from coalesce(old.montant_enc, 0)
     or coalesce(new.prix, 0) is distinct from coalesce(old.prix, 0)
     or new.payment_source is distinct from old.payment_source
     or new.ticket_cb is distinct from old.ticket_cb then
    insert into public.journal_financier (cmd_id, action, ancien, nouveau, montant, reste_du, utilisateur, origine_action, motif)
    values (new.id, case when fin_ok then 'modification_admin' else 'modification' end,
      jsonb_build_object('paie', old.paie, 'stpaie', old.stpaie, 'montant_enc', old.montant_enc, 'prix', old.prix, 'payment_source', old.payment_source, 'ticket_cb', old.ticket_cb),
      jsonb_build_object('paie', new.paie, 'stpaie', new.stpaie, 'montant_enc', new.montant_enc, 'prix', new.prix, 'payment_source', new.payment_source, 'ticket_cb', new.ticket_cb, 'encaisse_par', new.encaisse_par),
      new.montant_enc, du, interne._acteur_paiement(),
      case when fin_ok then 'action_admin' when public.session_role() is null then 'serveur' else 'application' end,
      nullif(current_setting('app.fin_motif', true), ''));
  end if;
  -- paiement à la livraison LIVRÉ sans encaissement : alerte (Telegram) en arrière-plan
  if new.payment_source = 'DELIVERY' and new.statut = 'livré' and coalesce(new.stpaie, '') <> 'Payé'
     and (old.statut is distinct from 'livré' or old.stpaie is distinct from new.stpaie) then
    perform interne.appel_fonction('paiement-suivi', jsonb_build_object('action', 'alerte_non_encaisse', 'cmdId', new.id), 8000);
  end if;
  return null;
end $$;
drop trigger if exists paiement_journal on public.commandes;
create trigger paiement_journal after insert or update on public.commandes
  for each row execute function public._paiement_journal();

-- ── 6. Action administrateur : modification financière volontaire, avec motif ───────
create or replace function interne.modifier_paiement(p_cmd text, p_mode text, p_statut text, p_montant numeric, p_motif text, p_acteur text)
returns json language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
declare v record;
begin
  if coalesce(length(btrim(p_motif)), 0) < 5 then return json_build_object('ok', false, 'erreur', 'motif_obligatoire'); end if;
  if p_statut not in ('Payé', 'Non payé', 'Partiel') then return json_build_object('ok', false, 'erreur', 'statut_invalide'); end if;
  if coalesce(btrim(p_mode), '') = '' then return json_build_object('ok', false, 'erreur', 'mode_obligatoire'); end if;
  if p_montant is null or p_montant < 0 then return json_build_object('ok', false, 'erreur', 'montant_invalide'); end if;
  select id, paie, stpaie, montant_enc into v from public.commandes where id = p_cmd;
  if not found then return json_build_object('ok', false, 'erreur', 'commande_introuvable'); end if;
  perform set_config('app.fin_ok', '1', true);
  perform set_config('app.fin_motif', btrim(p_motif), true);
  perform set_config('app.fin_acteur', coalesce(p_acteur, 'admin'), true);
  update public.commandes set paie = p_mode, stpaie = p_statut, montant_enc = p_montant, updated_at = now() where id = p_cmd;
  perform set_config('app.fin_ok', '', true);
  perform set_config('app.fin_motif', '', true);
  perform set_config('app.fin_acteur', '', true);
  return json_build_object('ok', true, 'avant', json_build_object('paie', v.paie, 'stpaie', v.stpaie, 'montant_enc', v.montant_enc));
end $$;
revoke all on function interne.modifier_paiement(text, text, text, numeric, text, text) from public, anon, authenticated;

create or replace function public.modifier_paiement(p_cmd text, p_mode text, p_statut text, p_montant numeric, p_motif text)
returns json language plpgsql volatile security definer set search_path = public, interne, pg_catalog as $$
begin
  if public.session_role() is distinct from 'admin' then return json_build_object('ok', false, 'erreur', 'session_admin_requise'); end if;
  return interne.modifier_paiement(p_cmd, p_mode, p_statut, p_montant, p_motif, 'admin');
end $$;
revoke all on function public.modifier_paiement(text, text, text, numeric, text) from public, anon, authenticated;
grant execute on function public.modifier_paiement(text, text, text, numeric, text) to anon;

-- ── 7. Identifiants de transaction Shopify : relevé périodique (fonction paiement-suivi) ──
select cron.unschedule('paiement-suivi-transactions') where exists (select 1 from cron.job where jobname = 'paiement-suivi-transactions');
select cron.schedule('paiement-suivi-transactions', '7,37 * * * *',
  $$select interne.appel_fonction('paiement-suivi', '{"action":"transactions"}'::jsonb, 60000);$$);
