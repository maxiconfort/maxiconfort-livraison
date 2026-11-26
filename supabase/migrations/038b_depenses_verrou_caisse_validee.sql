-- 038b (26/11/2026) : DÉPENSES — verrou du point de caisse validé appliqué PAR LA BASE (revue Codex PR 24 sur 437ec1e, P2).
--
-- RETOUR ARRIÈRE (à exécuter tel quel dans l'éditeur SQL si besoin ; ne touche à aucune donnée) :
--   drop trigger if exists depenses_verrou_caisse on public.depenses;
--   drop function if exists interne._depense_verrou_caisse();
--   drop function if exists interne.l038b_tournee_attribuee(text, text, text);
--   drop function if exists interne.l038b_refus(text, text, boolean);
--   drop function if exists public.verrou_caisse_actif();
--
-- ORDRE DE MISE EN SERVICE (obligatoire) : cette migration 038b est appliquée AVANT la mise en ligne du code de la
-- PR 24 (v7.5.175 et suivantes) ; la migration 039 (PR 26) l'est ensuite, AVANT la mise en ligne du code de la PR 26.
-- Si le code est en ligne sans la 038b, l'appli le signale à l'administrateur (fonction public.verrou_caisse_actif
-- absente -> bandeau « verrou de la base absent » dans Encaissements) au lieu de prétendre protéger les dépenses.
--
-- Problème : l'application refuse déjà d'ajouter, corriger ou supprimer une dépense d'une tournée dont le point de caisse
-- est validé (v7.5.171, rtDepenseVerrou). Mais sur le téléphone du livreur ce contrôle ne voit rien : la table
-- caisse_remises n'est lisible qu'avec une session administrateur (politique sess_admin de la migration 019). La carte
-- locale « caissesRemises » reste donc vide chez le livreur, qui pouvait encore changer le mode de paiement d'une dépense
-- (ou en ajouter une) après la validation : le reste affiché changeait alors que la remise enregistrée restait figée.
--
-- Choix (le plus sûr et le plus simple) : un DÉCLENCHEUR sur public.depenses, plutôt qu'un marqueur lisible par le livreur.
--   * Un marqueur lisible ne ferait qu'informer l'application : un ancien téléphone resté en cache, une file hors ligne
--     rejouée ou une requête faite à la main passeraient quand même. Le déclencheur, lui, s'applique à TOUTE écriture.
--   * Aucune nouvelle lecture n'est ouverte au livreur : caisse_remises reste réservée à l'administrateur ; seule la
--     fonction du déclencheur (SECURITY DEFINER, schéma privé « interne », non appelable par anon) la consulte.
--
-- Règle : une dépense dont la tournée (tournee_id, AVANT ou APRÈS l'écriture) a un point de caisse validé
-- (caisse_remises.key_remise = 't_' || tournee_id, validee = true) ne peut être ni ajoutée, ni modifiée, ni supprimée
-- par l'application, QUEL QUE SOIT le rôle de la session (livreur, collaboratrice, administrateur). L'administrateur
-- doit d'abord ANNULER la validation (bouton existant « annuler », qui supprime la ligne caisse_remises), corriger,
-- puis valider de nouveau : le montant remis et l'écart sont alors recalculés et ré-enregistrés.
-- Exception : les écritures du serveur (rôle service_role : fonctions et scripts avec la clé secrète) et la maintenance
-- directe dans l'éditeur SQL (aucun « set role » : rôle « none », connexion autre que celle de PostgREST).
-- Refus = erreur « POINT_CAISSE_VALIDE … » (code P0001, réponse 400 de PostgREST) : l'application la reconnaît et
-- affiche un message clair au livreur (v7.5.175, rtRefusCaisseValidee).
--
-- Dépense SANS tournee_id (revue Codex PR 24 sur 26dcf5b) : la base la rattache à la tournée que l'APPLICATION lui
-- attribue (même règle que rtDepenseDeTournee) : la PREMIÈRE tournée (identifiants triés, ordre binaire) du MÊME livreur
-- (sans tenir compte des majuscules) à la MÊME date (date_depense = date_tournee). Le verrou s'applique alors comme si
-- tournee_id était renseigné (avant ET après l'écriture : changer la date ou le livreur pour entrer dans une tournée
-- validée, ou en sortir, est refusé). Aucune donnée n'est réécrite (tournee_id reste vide). Les remises d'anciennes clés
-- (livreur_période, sans « t_ ») ne sont pas concernées.
-- Aucune donnée n'est modifiée par cette migration. Rejouable.

-- ── 1. Décision (fonction pure, vérifiée par l'auto-contrôle de la section 4) ─────────────────────────────────────
-- p_role = valeur de current_setting('role') au moment de l'écriture (« anon », « authenticated », « service_role »
-- avec PostgREST ; « none » sans set role) — une fonction SECURITY DEFINER change current_user mais PAS ce réglage ;
-- p_session_user = session_user (« authenticator » pour PostgREST) ; p_validee = point de caisse de la tournée validé.
create or replace function interne.l038b_refus(p_role text, p_session_user text, p_validee boolean)
returns boolean language sql immutable as $$
  select coalesce(p_validee, false)
     and not ( coalesce(p_role, '') = 'service_role'
               or ( coalesce(p_role, 'none') in ('none', '')
                    and coalesce(p_session_user, '') not in ('', 'authenticator', 'anon', 'authenticated') ) );
$$;
revoke all on function interne.l038b_refus(text, text, boolean) from public;

-- ── 1 bis. Tournée de rattachement d'une dépense (règle de l'application, rtDepenseDeTournee) ─────────────────────
-- tournee_id renseigné : c'est elle. Sinon : première tournée (id trié en ordre binaire, comme le tri JavaScript) du même
-- livreur (lower) à la même date. Aucune tournée : null (rien à verrouiller). Lit public.tournees en propriétaire (RLS
-- contournée) : la fonction n'est appelée que par le déclencheur, jamais par anon.
create or replace function interne.l038b_tournee_attribuee(p_tournee_id text, p_livreur text, p_date text)
returns text language sql stable security definer set search_path = public, pg_catalog as $$
  select case when coalesce(p_tournee_id, '') <> '' then p_tournee_id
    else (select t.id::text from public.tournees t
           where lower(coalesce(t.livreur::text, '')) = lower(coalesce(p_livreur, ''))
             and coalesce(t.date_tournee::text, '') = coalesce(p_date, '')
           order by t.id::text collate "C" limit 1) end;
$$;
revoke all on function interne.l038b_tournee_attribuee(text, text, text) from public, anon, authenticated;

-- ── 2. Fonction du déclencheur ────────────────────────────────────────────────────────────────────────────────────
create or replace function interne._depense_verrou_caisse() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_role text := current_setting('role', true);
  v_tids text[] := array[]::text[];
  v_tid text;
  v_validee boolean;
begin
  -- tournée de chaque état (avant / après) : tournee_id, sinon celle que l'application attribue (date + livreur)
  if tg_op in ('UPDATE', 'DELETE') then
    v_tid := interne.l038b_tournee_attribuee(old.tournee_id::text, old.livreur::text, old.date_depense::text);
    if v_tid is not null then v_tids := v_tids || v_tid; end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_tid := interne.l038b_tournee_attribuee(new.tournee_id::text, new.livreur::text, new.date_depense::text);
    if v_tid is not null and not (v_tid = any(v_tids)) then v_tids := v_tids || v_tid; end if;
  end if;
  foreach v_tid in array v_tids loop
    select exists (select 1 from public.caisse_remises cr
                    where cr.key_remise = 't_' || v_tid and coalesce(cr.validee::text, '') in ('true', 't'))
      into v_validee;
    if interne.l038b_refus(v_role, session_user::text, v_validee) then
      raise exception using
        errcode = 'P0001',
        message = 'POINT_CAISSE_VALIDE : le point de caisse de la tournée ' || v_tid || ' est déjà validé, dépense non modifiable',
        hint = 'Le bureau doit d''abord annuler la validation du point de caisse, puis corriger et valider de nouveau.';
    end if;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke all on function interne._depense_verrou_caisse() from public, anon, authenticated;

-- ── 3. Déclencheur (avant ajout, modification, suppression ; l'upsert « merge-duplicates » passe par les deux) ──────
drop trigger if exists depenses_verrou_caisse on public.depenses;
create trigger depenses_verrou_caisse before insert or update or delete on public.depenses
  for each row execute function interne._depense_verrou_caisse();

-- ── 3 bis. Contrôle doux de l'application : le verrou est-il en place dans la base ? ──────────────────────────────
-- Renvoie seulement vrai / faux (aucune donnée). Fonction absente (migration non appliquée) -> l'appli reçoit une
-- erreur 404 et affiche à l'administrateur « verrou de la base absent » au lieu de prétendre protéger les dépenses.
create or replace function public.verrou_caisse_actif() returns boolean
language sql stable security definer set search_path = public, pg_catalog as $$
  select exists (select 1 from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'depenses' and tg.tgname = 'depenses_verrou_caisse'
                    and tg.tgenabled <> 'D' and (tg.tgtype & 28) = 28)
     and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'interne' and p.proname = '_depense_verrou_caisse');
$$;
revoke all on function public.verrou_caisse_actif() from public, anon, authenticated;
grant execute on function public.verrou_caisse_actif() to anon;

-- ── 4. Auto-contrôle (une erreur annule la migration) ─────────────────────────────────────────────────────────────
do $$
declare v_def boolean; v_cfg text[];
begin
  -- colonnes sur lesquelles repose le verrou
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'depenses' and column_name = 'tournee_id') then
    raise exception 'Auto-contrôle 038b : colonne public.depenses.tournee_id absente';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'caisse_remises'
       and column_name in ('key_remise', 'validee')) <> 2 then
    raise exception 'Auto-contrôle 038b : colonnes caisse_remises.key_remise / validee absentes';
  end if;
  -- rattachement d'une dépense sans tournee_id (date + livreur, comme l'application)
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'depenses'
       and column_name in ('livreur', 'date_depense')) <> 2
     or (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'tournees'
       and column_name in ('id', 'livreur', 'date_tournee')) <> 3 then
    raise exception 'Auto-contrôle 038b : colonnes depenses.livreur / date_depense ou tournees.id / livreur / date_tournee absentes';
  end if;
  if interne.l038b_tournee_attribuee('T-X', 'L', '2000-01-01') is distinct from 'T-X' then
    raise exception 'Auto-contrôle 038b : tournee_id renseigné non retenu tel quel';
  end if;
  if has_function_privilege('anon', 'interne.l038b_tournee_attribuee(text, text, text)', 'execute') then
    raise exception 'Auto-contrôle 038b : interne.l038b_tournee_attribuee ne doit pas être exécutable par anon';
  end if;
  -- déclencheur présent et actif sur les trois opérations
  if not exists (select 1 from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'depenses' and tg.tgname = 'depenses_verrou_caisse'
                    and tg.tgenabled <> 'D' and (tg.tgtype & 28) = 28) then   -- 4 = INSERT, 8 = DELETE, 16 = UPDATE
    raise exception 'Auto-contrôle 038b : déclencheur depenses_verrou_caisse absent, désactivé ou incomplet';
  end if;
  -- fonction du déclencheur : SECURITY DEFINER avec search_path figé, non exécutable par anon / authenticated
  select p.prosecdef, p.proconfig into v_def, v_cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'interne' and p.proname = '_depense_verrou_caisse';
  if not coalesce(v_def, false) or v_cfg is null or not exists (select 1 from unnest(v_cfg) x where x like 'search_path=%') then
    raise exception 'Auto-contrôle 038b : interne._depense_verrou_caisse doit être SECURITY DEFINER avec search_path figé';
  end if;
  if has_function_privilege('anon', 'interne._depense_verrou_caisse()', 'execute')
     or has_function_privilege('authenticated', 'interne._depense_verrou_caisse()', 'execute') then
    raise exception 'Auto-contrôle 038b : interne._depense_verrou_caisse ne doit pas être exécutable par anon / authenticated';
  end if;
  -- table de décision
  if not interne.l038b_refus('anon', 'authenticator', true) then raise exception 'Auto-contrôle 038b : session de l''application (anon) non bloquée'; end if;
  if not interne.l038b_refus('authenticated', 'authenticator', true) then raise exception 'Auto-contrôle 038b : authenticated non bloqué'; end if;
  if not interne.l038b_refus('none', 'authenticator', true) then raise exception 'Auto-contrôle 038b : connexion PostgREST sans rôle non bloquée'; end if;
  if not interne.l038b_refus(null, null, true) then raise exception 'Auto-contrôle 038b : rôle inconnu non bloqué'; end if;
  if interne.l038b_refus('service_role', 'authenticator', true) then raise exception 'Auto-contrôle 038b : service_role bloqué à tort'; end if;
  if interne.l038b_refus('none', 'postgres', true) then raise exception 'Auto-contrôle 038b : maintenance directe bloquée à tort'; end if;
  if interne.l038b_refus('anon', 'authenticator', false) or interne.l038b_refus('anon', 'authenticator', null) then
    raise exception 'Auto-contrôle 038b : tournée non validée bloquée à tort';
  end if;
  -- contrôle doux de l'application
  if not coalesce(public.verrou_caisse_actif(), false) then
    raise exception 'Auto-contrôle 038b : public.verrou_caisse_actif() ne voit pas le verrou';
  end if;
  if not has_function_privilege('anon', 'public.verrou_caisse_actif()', 'execute') then
    raise exception 'Auto-contrôle 038b : public.verrou_caisse_actif() doit être exécutable par anon (contrôle de l''appli)';
  end if;
end $$;
