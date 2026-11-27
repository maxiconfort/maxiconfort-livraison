-- 038b (26/11/2026) : DÉPENSES — verrou du point de caisse validé appliqué PAR LA BASE (revue Codex PR 24 sur 437ec1e, P2).
--
-- RETOUR ARRIÈRE (à exécuter tel quel dans l'éditeur SQL si besoin ; ne supprime ni ne modifie aucune donnée) :
--   drop trigger if exists depenses_verrou_caisse on public.depenses;
--   drop trigger if exists tournees_verrou_caisse on public.tournees;
--   drop trigger if exists caisse_remises_verrou_caisse on public.caisse_remises;
--   drop function if exists interne._depense_verrou_caisse();
--   drop function if exists interne._tournee_verrou_caisse();
--   drop function if exists interne._caisse_remise_verrou();
--   drop function if exists interne.l038b_verrouiller(text[]);
--   drop function if exists interne.l038b_cle(text);
--   drop function if exists interne.l038b_validee(text);
--   drop function if exists interne.l038b_premiere(text, text, text, text);
--   drop function if exists interne.l038b_sans_tournee(text, text);
--   drop function if exists interne.l038b_tournee_attribuee(text, text, text);
--   drop function if exists interne.l038b_refus(text, text, boolean);
--   drop function if exists interne.l038b_arrets_caisse(jsonb);
--   drop function if exists interne.l038b_depenses_especes(text);
--   (Les colonnes caisse_remises.controle_depenses / controle_arrets peuvent rester : l'ancienne appli ne les envoie pas et
--    plus rien ne les lit une fois le déclencheur retiré. Les retirer n'efface que ces traces de contrôle, aucun montant :
--    alter table public.caisse_remises drop column if exists controle_depenses, drop column if exists controle_arrets;)
--   drop function if exists public.verrou_caisse_actif();
--   (Les tournee_id renseignés par le figement de la section 2 restent : ce sont exactement les tournées que
--    l'appli attribuait à ces dépenses au moment de leur écriture ; les garder ne change aucun calcul de l'appli.)
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
--   * Aucune nouvelle lecture n'est ouverte au livreur : caisse_remises reste réservée à l'administrateur ; seules les
--     fonctions des déclencheurs (SECURITY DEFINER, schéma privé « interne », non appelables par anon) la consultent.
--
-- Règle : une dépense dont la tournée (tournee_id, AVANT ou APRÈS l'écriture) a un point de caisse validé
-- (caisse_remises.key_remise = 't_' || tournee_id, validee = true) ne peut être ni ajoutée, ni modifiée, ni supprimée
-- par l'application, QUEL QUE SOIT le rôle de la session (livreur, collaboratrice, administrateur). L'administrateur
-- doit d'abord ANNULER la validation (bouton existant « annuler », qui supprime la ligne caisse_remises), corriger,
-- puis valider de nouveau : le montant remis et l'écart sont alors recalculés et ré-enregistrés.
-- Exception : les écritures du serveur (rôle service_role : fonctions et scripts avec la clé secrète) et la maintenance
-- directe dans l'éditeur SQL (aucun « set role » : rôle « none », connexion autre que celle de PostgREST).
-- Refus = erreur « POINT_CAISSE_VALIDE … » (code P0001, réponse 400 de PostgREST) : l'application la reconnaît et
-- affiche un message clair (v7.5.175, rtRefusCaisseValidee).
--
-- Dépense SANS tournee_id (revue Codex PR 24 sur 26dcf5b) : elle appartient à la tournée que l'APPLICATION lui
-- attribue (même règle que rtDepenseDeTournee) : la PREMIÈRE tournée (identifiants triés, ordre binaire) du MÊME livreur
-- (sans tenir compte des majuscules) à la MÊME date (date_depense = date_tournee).
--
-- RATTACHEMENT FIGÉ (revue Codex PR 24 sur 639f2f5, point 1) : ce rattachement par la date dépendait des tournées
-- existantes, alors que seul « depenses » était surveillé : ajouter, supprimer ou modifier une TOURNÉE pouvait déplacer
-- une dépense vers ou depuis une tournée validée sans aucun refus. Désormais :
--   * à l'ÉCRITURE d'une dépense sans tournee_id (ajout ou modification), la base renseigne tournee_id avec la tournée
--     calculée (si elle existe) : plus aucun rattachement implicite ensuite. Une copie ancienne d'un téléphone qui
--     renvoie tournee_id vide SANS changer ni la date ni le livreur garde le rattachement déjà figé ; un changement de
--     date ou de livreur envoyé avec tournee_id vide recalcule le rattachement (l'appli vide tournee_id dans ce cas) ;
--   * les ANCIENNES dépenses sans tournee_id ne sont pas réécrites par cette migration (elles le sont à leur prochaine
--     écriture) ; elles sont protégées par un déclencheur sur public.tournees (section 3 quater) : une session de l'appli
--     ne peut ni SUPPRIMER une tournée dont le point de caisse est validé, ni en changer l'identifiant, le livreur ou la
--     date ; et aucun ajout, suppression ou changement de tournée ne peut déplacer une ancienne dépense sans tournée
--     vers ou depuis une tournée validée.
--
-- SÉRIALISATION (revue Codex PR 24 sur 639f2f5, point 2) : la vérification « remise validée ? » et l'écriture de la
-- dépense n'étaient pas synchronisées avec la validation : deux transactions simultanées pouvaient chacune voir l'ancien
-- état. Désormais un VERROU CONSULTATIF de transaction (pg_advisory_xact_lock) sur une clé dérivée de l'identifiant de la
-- tournée (interne.l038b_cle) est pris par les TROIS chemins : déclencheur des dépenses, déclencheur des tournées et
-- déclencheur de caisse_remises (validation et annulation de la remise, quel que soit le rôle). Le second arrivé attend
-- la fin du premier, puis relit l'état validé (nouvelle image à chaque requête, isolement « read committed » de PostgREST).
--
-- VALIDATION CONTRÔLÉE PAR LA BASE (revue Codex PR 24 sur 59f3a26, points 1 et 2) :
--   1. la relecture des dépenses par l'appli précède la validation et ne partage pas sa transaction : une dépense pouvait
--      être enregistrée entre les deux, puis la remise être validée avec l'ancien montant. Désormais l'appli envoie, avec la
--      remise, ce sur quoi elle a calculé le montant attendu : le total des dépenses en espèces déduites
--      (caisse_remises.controle_depenses) et le relevé des arrêts qui comptent pour la caisse (controle_arrets). Le
--      déclencheur de caisse_remises, APRÈS avoir pris le verrou de la tournée et DANS la transaction de la validation,
--      recalcule les deux depuis la base et REFUSE la validation s'ils diffèrent (« CAISSE_CHANGEE ») : l'appli relit et
--      fait recalculer. Une dépense enregistrée avant la prise du verrou est donc vue ; une dépense écrite pendant la
--      validation attend sa fin, puis est refusée (POINT_CAISSE_VALIDE).
--   2. une tournée validée acceptait encore la modification de ses arrêts. Le déclencheur des tournées refuse désormais
--      à une session de l'appli tout changement des données d'arrêt qui comptent pour la caisse (interne.l038b_arrets_caisse :
--      commande, client si l'arrêt n'a pas de commande, statut, paiement, statut du paiement, acompte avant, encaissé sur
--      la tournée, parts espèces / CB, trace d'encaissement ; ajout ou retrait d'arrêt) ; les autres champs (heure, GPS,
--      photo, signature…) restent modifiables.
--   Mêmes exceptions qu'ailleurs : service_role et maintenance directe ne sont ni contrôlés ni bloqués.
--
-- Aucune donnée n'est modifiée par cette migration (deux colonnes vides ajoutées à caisse_remises). Rejouable.

-- ── 0. Colonnes de contrôle de la validation (vides pour les remises existantes) ──────────────────────────────────
alter table public.caisse_remises add column if not exists controle_depenses numeric;
alter table public.caisse_remises add column if not exists controle_arrets jsonb;

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
-- contournée) : la fonction n'est appelée que par les déclencheurs, jamais par anon.
create or replace function interne.l038b_tournee_attribuee(p_tournee_id text, p_livreur text, p_date text)
returns text language sql stable security definer set search_path = public, pg_catalog as $$
  select case when coalesce(p_tournee_id, '') <> '' then p_tournee_id
    else (select t.id::text from public.tournees t
           where lower(coalesce(t.livreur::text, '')) = lower(coalesce(p_livreur, ''))
             and coalesce(t.date_tournee::text, '') = coalesce(p_date, '')
           order by t.id::text collate "C" limit 1) end;
$$;
revoke all on function interne.l038b_tournee_attribuee(text, text, text) from public, anon, authenticated;

-- ── 1 ter. Outils du verrou (revue Codex PR 24 sur 639f2f5) ───────────────────────────────────────────────────────
-- Clé du verrou consultatif d'une tournée : 38002 dans les 32 bits hauts (propre à ce verrou), empreinte de l'identifiant
-- dans les 32 bits bas. La MÊME fonction sert aux trois déclencheurs : ils prennent donc la même clé pour la même tournée.
create or replace function interne.l038b_cle(p_tournee text) returns bigint language sql immutable as $$
  select (38002::bigint << 32) | (hashtext(coalesce(p_tournee, ''))::bigint & 4294967295::bigint);
$$;
revoke all on function interne.l038b_cle(text) from public, anon, authenticated;

-- Prend le verrou de chaque tournée de la liste (vides ignorées, doublons retirés, ordre binaire fixe pour limiter les
-- interblocages) ; il est rendu automatiquement à la fin de la transaction.
create or replace function interne.l038b_verrouiller(p_tids text[]) returns void
language plpgsql security definer set search_path = public, pg_catalog as $$
declare v text;
begin
  for v in select distinct x collate "C" from unnest(coalesce(p_tids, array[]::text[])) as u(x)
            where coalesce(x, '') <> '' order by 1 loop
    perform pg_advisory_xact_lock(interne.l038b_cle(v));
  end loop;
end $$;
revoke all on function interne.l038b_verrouiller(text[]) from public, anon, authenticated;

-- Point de caisse de la tournée validé ? (VOLATILE : relu avec une image neuve après la prise du verrou)
create or replace function interne.l038b_validee(p_tournee text) returns boolean
language sql volatile security definer set search_path = public, pg_catalog as $$
  select coalesce(p_tournee, '') <> '' and exists (select 1 from public.caisse_remises cr
    where cr.key_remise = 't_' || p_tournee and coalesce(cr.validee::text, '') in ('true', 't'));
$$;
revoke all on function interne.l038b_validee(text) from public, anon, authenticated;

-- Première tournée (ordre binaire) d'un livreur à une date, en retirant p_sans et en ajoutant p_avec : sert à comparer le
-- rattachement des anciennes dépenses sans tournée AVANT et APRÈS l'écriture d'une tournée.
create or replace function interne.l038b_premiere(p_livreur text, p_date text, p_sans text, p_avec text) returns text
language sql volatile security definer set search_path = public, pg_catalog as $$
  select min(s.x collate "C") from (
    select t.id::text as x from public.tournees t
     where lower(coalesce(t.livreur::text, '')) = lower(coalesce(p_livreur, ''))
       and coalesce(t.date_tournee::text, '') = coalesce(p_date, '')
       and (p_sans is null or t.id::text <> p_sans)
    union all select p_avec where p_avec is not null) s;
$$;
revoke all on function interne.l038b_premiere(text, text, text, text) from public, anon, authenticated;

-- Relevé des données d'arrêt qui comptent pour la caisse (même liste que rtArretsCaisse dans l'appli) : un objet par arrêt,
-- dans l'ordre, toujours avec les mêmes clés (absente = null). Tout autre champ de l'arrêt est ignoré.
create or replace function interne.l038b_arrets_caisse(p_stops jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'cmdId', x.e -> 'cmdId',
           'client', case when coalesce(x.e ->> 'cmdId', '') = '' then x.e -> 'client' end,
           'statut', x.e -> 'statut', 'paie', x.e -> 'paie', 'stpaie', x.e -> 'stpaie',
           'encAvant', x.e -> 'encAvant', 'encTournee', x.e -> 'encTournee',
           'paie_especes', x.e -> 'paie_especes', 'paie_cb', x.e -> 'paie_cb', 'enc', x.e -> 'enc') order by x.o), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p_stops) = 'array' then p_stops else '[]'::jsonb end) with ordinality as x(e, o);
$$;
revoke all on function interne.l038b_arrets_caisse(jsonb) from public, anon, authenticated;

-- Total des dépenses payées en ESPÈCES déduites du point de caisse d'une tournée (même règle que l'appli : même livreur,
-- hors « CAISSE », mode autre que « CB » — vide = Espèces —, rattachement de rtDepenseDeTournee), arrondi au centime.
-- Tournée absente : null. VOLATILE : relu avec une image neuve après la prise du verrou.
create or replace function interne.l038b_depenses_especes(p_tournee text) returns numeric
language sql volatile security definer set search_path = public, pg_catalog as $$
  select case when t.id is null then null else round(coalesce((
    select sum(case when trim(d.montant::text) ~ '^-?[0-9]+([.][0-9]+)?$' then trim(d.montant::text)::numeric else 0 end)
      from public.depenses d
     where lower(coalesce(d.livreur::text, '')) = lower(coalesce(t.livreur::text, ''))
       and upper(coalesce(d.livreur::text, '')) <> 'CAISSE'
       and coalesce(nullif(d.mode_paie::text, ''), 'Espèces') <> 'CB'
       and ( coalesce(d.tournee_id::text, '') = t.id::text
             or ( coalesce(d.tournee_id::text, '') = ''
                  and coalesce(d.date_depense::text, '') = coalesce(t.date_tournee::text, '')
                  and interne.l038b_premiere(t.livreur::text, t.date_tournee::text, null, null) = t.id::text ) )), 0), 2) end
    from (select 1) u left join public.tournees t on t.id::text = p_tournee;
$$;
revoke all on function interne.l038b_depenses_especes(text) from public, anon, authenticated;

-- Reste-t-il d'anciennes dépenses SANS tournee_id pour ce livreur à cette date ?
create or replace function interne.l038b_sans_tournee(p_livreur text, p_date text) returns boolean
language sql volatile security definer set search_path = public, pg_catalog as $$
  select exists (select 1 from public.depenses d
                  where coalesce(d.tournee_id::text, '') = ''
                    and lower(coalesce(d.livreur::text, '')) = lower(coalesce(p_livreur, ''))
                    and coalesce(d.date_depense::text, '') = coalesce(p_date, ''));
$$;
revoke all on function interne.l038b_sans_tournee(text, text) from public, anon, authenticated;

-- ── 2. Fonction du déclencheur des dépenses (figement, verrou, contrôle) ──────────────────────────────────────────
create or replace function interne._depense_verrou_caisse() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_role text := current_setting('role', true);
  v_prec record;              -- état précédent : OLD, ou la ligne déjà en base de même id (phase INSERT d'un upsert)
  v_a_prec boolean := false;
  v_calc boolean := false;    -- tournee_id calculé par la base (figement) et non donné par l'écriture
  v_tids text[] := array[]::text[];
  v_tid text;
  v_validee boolean;
begin
  if tg_op = 'UPDATE' then
    v_prec := old; v_a_prec := true;
  elsif tg_op = 'INSERT' then
    select * into v_prec from public.depenses d where d.id = new.id;
    v_a_prec := found;
  end if;
  -- 1. FIGEMENT : dépense écrite sans tournee_id -> la base renseigne la tournée que l'application lui attribue
  if tg_op in ('INSERT', 'UPDATE') and coalesce(new.tournee_id::text, '') = '' then
    if v_a_prec and coalesce(v_prec.tournee_id::text, '') <> ''
       and lower(coalesce(v_prec.livreur::text, '')) = lower(coalesce(new.livreur::text, ''))
       and coalesce(v_prec.date_depense::text, '') = coalesce(new.date_depense::text, '') then
      new.tournee_id := v_prec.tournee_id;   -- copie ancienne d'un téléphone : le rattachement déjà figé est gardé
    else
      v_calc := true;
      new.tournee_id := interne.l038b_tournee_attribuee(null, new.livreur::text, new.date_depense::text);
    end if;
  end if;
  -- 2. tournée de chaque état (avant / après) : tournee_id, sinon celle que l'application attribue (date + livreur)
  if tg_op in ('UPDATE', 'DELETE') then
    v_tid := interne.l038b_tournee_attribuee(old.tournee_id::text, old.livreur::text, old.date_depense::text);
    if v_tid is not null then v_tids := v_tids || v_tid; end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_tid := interne.l038b_tournee_attribuee(new.tournee_id::text, new.livreur::text, new.date_depense::text);
    if v_tid is not null and not (v_tid = any(v_tids)) then v_tids := v_tids || v_tid; end if;
  end if;
  -- 3. SÉRIALISATION avec la validation de la remise et l'écriture des tournées (même clé, interne.l038b_cle)
  perform interne.l038b_verrouiller(v_tids);
  if v_calc then   -- rattachement recalculé APRÈS le verrou : une tournée a pu changer pendant l'attente
    v_tid := interne.l038b_tournee_attribuee(null, new.livreur::text, new.date_depense::text);
    if v_tid is distinct from nullif(new.tournee_id::text, '') then
      new.tournee_id := v_tid;
      if v_tid is not null and not (v_tid = any(v_tids)) then
        perform interne.l038b_verrouiller(array[v_tid]);
        v_tids := v_tids || v_tid;
      end if;
    end if;
  end if;
  -- 4. contrôle (relu après le verrou)
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

-- ── 3. Déclencheur des dépenses (avant ajout, modification, suppression ; l'upsert « merge-duplicates » passe par les deux)
drop trigger if exists depenses_verrou_caisse on public.depenses;
create trigger depenses_verrou_caisse before insert or update or delete on public.depenses
  for each row execute function interne._depense_verrou_caisse();

-- ── 3 ter. Déclencheur de caisse_remises : la validation (et son annulation) prend le verrou de la tournée ─────────
-- La validation reste réservée à l'administrateur (politique sess_admin). Revue Codex PR 24 sur 59f3a26 (point 1) : une
-- VALIDATION (validee = vrai) écrite par une session de l'appli est CONTRÔLÉE après la prise du verrou, dans sa propre
-- transaction : total des dépenses en espèces et relevé des arrêts recalculés depuis la base, comparés à ceux sur lesquels
-- l'appli a calculé le montant attendu. Différence, contrôle absent (ancienne appli en cache) ou tournée introuvable ->
-- refus « CAISSE_CHANGEE » (rien n'est validé). L'annulation (suppression) n'est jamais contrôlée.
create or replace function interne._caisse_remise_verrou() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_tids text[] := array[]::text[];
  v_role text := current_setting('role', true);
  v_tid text; v_dep numeric; v_arr jsonb;
begin
  if tg_op in ('UPDATE', 'DELETE') and coalesce(old.key_remise::text, '') like 't\_%' then v_tids := v_tids || substr(old.key_remise::text, 3); end if;
  if tg_op in ('INSERT', 'UPDATE') and coalesce(new.key_remise::text, '') like 't\_%' then v_tids := v_tids || substr(new.key_remise::text, 3); end if;
  perform interne.l038b_verrouiller(v_tids);
  if tg_op in ('INSERT', 'UPDATE') and coalesce(new.validee::text, '') in ('true', 't')
     and coalesce(new.key_remise::text, '') like 't\_%'
     and interne.l038b_refus(v_role, session_user::text, true) then   -- session de l'application (pas serveur, pas maintenance)
    v_tid := substr(new.key_remise::text, 3);
    v_dep := interne.l038b_depenses_especes(v_tid);                  -- relus APRÈS le verrou (image neuve)
    select interne.l038b_arrets_caisse(t.stops::jsonb) into v_arr from public.tournees t where t.id::text = v_tid;
    if v_dep is null or new.controle_depenses is null or new.controle_arrets is null
       or round(new.controle_depenses, 2) <> v_dep
       or interne.l038b_arrets_caisse(new.controle_arrets) is distinct from coalesce(v_arr, '[]'::jsonb) then
      raise exception using
        errcode = 'P0001',
        message = 'CAISSE_CHANGEE : les dépenses ou les arrêts de la tournée ' || v_tid || ' ont changé depuis le calcul du montant attendu'
                  || case when v_dep is null then ' (tournée introuvable)'
                          when new.controle_depenses is null or new.controle_arrets is null then ' (contrôle absent : application à recharger)'
                          else ' (dépenses en espèces : ' || round(new.controle_depenses, 2)::text || ' € envoyé, ' || v_dep::text || ' € en base)' end,
        hint = 'Relire la page, vérifier le nouveau montant attendu, puis valider de nouveau.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke all on function interne._caisse_remise_verrou() from public, anon, authenticated;
drop trigger if exists caisse_remises_verrou_caisse on public.caisse_remises;
create trigger caisse_remises_verrou_caisse before insert or update or delete on public.caisse_remises
  for each row execute function interne._caisse_remise_verrou();

-- ── 3 quater. Déclencheur des tournées : une tournée validée et les anciennes dépenses sans tournée restent en place ─
-- Refusé à une session de l'appli (mêmes exceptions que les dépenses : service_role, maintenance directe) :
--   A. supprimer une tournée dont le point de caisse est validé, ou en changer l'identifiant, le livreur ou la date ;
--   B. tout ajout, suppression ou changement de tournée qui changerait la tournée de rattachement d'anciennes dépenses
--      sans tournee_id (même livreur, même date) quand l'ancienne OU la nouvelle tournée de rattachement est validée ;
--   C. (revue Codex PR 24 sur 59f3a26, point 2) changer, sur une tournée au point de caisse validé, les données d'arrêt qui
--      comptent pour la caisse (interne.l038b_arrets_caisse : résultat, paiement, encaissements, ajout ou retrait d'arrêt).
-- Une mise à jour ordinaire (statut de la tournée, champs d'arrêt sans effet sur la caisse : heure, GPS, photo…) ne change
-- ni l'identifiant, ni le livreur, ni la date, ni le relevé de caisse des arrêts : toujours acceptée.
create or replace function interne._tournee_verrou_caisse() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_role text := current_setting('role', true);
  v_nid text; v_nl text; v_nd text;            -- nouvel état (ajout, modification)
  v_oid text; v_ol text; v_od text;            -- ancien état (modification, suppression)
  v_l text[] := array[]::text[]; v_d text[] := array[]::text[];
  v_verrous text[] := array[]::text[];
  v_avec text; v_avant text; v_apres text;
  i int;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_oid := old.id::text; v_ol := coalesce(old.livreur::text, ''); v_od := coalesce(old.date_tournee::text, '');
    v_l := v_l || v_ol; v_d := v_d || v_od; v_verrous := v_verrous || v_oid;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_nid := new.id::text; v_nl := coalesce(new.livreur::text, ''); v_nd := coalesce(new.date_tournee::text, '');
    v_l := v_l || v_nl; v_d := v_d || v_nd; v_verrous := v_verrous || v_nid;
  end if;
  -- verrou : la tournée elle-même et la première tournée de chaque (livreur, date) touché, avant et après
  for i in 1 .. coalesce(array_length(v_l, 1), 0) loop
    v_avec := case when v_nid is not null and lower(v_nl) = lower(v_l[i]) and v_nd = v_d[i] then v_nid end;
    v_verrous := v_verrous || interne.l038b_premiere(v_l[i], v_d[i], null, null) || interne.l038b_premiere(v_l[i], v_d[i], v_oid, v_avec);
  end loop;
  perform interne.l038b_verrouiller(v_verrous);
  if interne.l038b_refus(v_role, session_user::text, true) then   -- session de l'application (pas serveur, pas maintenance)
    -- A. tournée au point de caisse validé
    if v_oid is not null and interne.l038b_validee(v_oid) then
      if tg_op = 'DELETE' or v_nid is distinct from v_oid or lower(v_nl) <> lower(v_ol) or v_nd <> v_od then
        raise exception using
          errcode = 'P0001',
          message = 'POINT_CAISSE_VALIDE : le point de caisse de la tournée ' || v_oid || ' est déjà validé : ni suppression, ni changement d''identifiant, de livreur ou de date',
          hint = 'Le bureau doit d''abord annuler la validation du point de caisse de cette tournée.';
      end if;
      -- C. résultats et encaissements des arrêts figés tant que la validation n'est pas annulée
      if tg_op = 'UPDATE' and interne.l038b_arrets_caisse(old.stops::jsonb) is distinct from interne.l038b_arrets_caisse(new.stops::jsonb) then
        raise exception using
          errcode = 'P0001',
          message = 'POINT_CAISSE_VALIDE : le point de caisse de la tournée ' || v_oid || ' est déjà validé : résultats et encaissements de ses arrêts non modifiables',
          hint = 'Le bureau doit d''abord annuler la validation du point de caisse de cette tournée.';
      end if;
    end if;
    -- B. anciennes dépenses sans tournee_id : leur tournée de rattachement ne change pas vers / depuis une tournée validée
    for i in 1 .. coalesce(array_length(v_l, 1), 0) loop
      if interne.l038b_sans_tournee(v_l[i], v_d[i]) then
        v_avec := case when v_nid is not null and lower(v_nl) = lower(v_l[i]) and v_nd = v_d[i] then v_nid end;
        v_avant := interne.l038b_premiere(v_l[i], v_d[i], null, null);
        v_apres := interne.l038b_premiere(v_l[i], v_d[i], v_oid, v_avec);
        if v_avant is distinct from v_apres and (interne.l038b_validee(v_avant) or interne.l038b_validee(v_apres)) then
          raise exception using
            errcode = 'P0001',
            message = 'POINT_CAISSE_VALIDE : ce changement de tournée déplacerait des dépenses sans tournée de ' || coalesce(v_avant, 'aucune tournée')
                      || ' vers ' || coalesce(v_apres, 'aucune tournée') || ' alors qu''un point de caisse est validé',
            hint = 'Le bureau doit d''abord annuler la validation du point de caisse concerné.';
        end if;
      end if;
    end loop;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke all on function interne._tournee_verrou_caisse() from public, anon, authenticated;
drop trigger if exists tournees_verrou_caisse on public.tournees;
create trigger tournees_verrou_caisse before insert or update or delete on public.tournees
  for each row execute function interne._tournee_verrou_caisse();

-- ── 3 bis. Contrôle doux de l'application : le verrou est-il en place dans la base ? ──────────────────────────────
-- Renvoie seulement vrai / faux (aucune donnée). Fonction absente (migration non appliquée) -> l'appli reçoit une
-- erreur 404 et affiche à l'administrateur « verrou de la base absent » au lieu de prétendre protéger les dépenses.
-- Vrai seulement si les TROIS déclencheurs (dépenses, tournées, caisse_remises) sont présents et actifs.
create or replace function public.verrou_caisse_actif() returns boolean
language sql stable security definer set search_path = public, pg_catalog as $$
  select (select count(*) from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and tg.tgenabled <> 'D' and (tg.tgtype & 28) = 28
             and ((c.relname = 'depenses' and tg.tgname = 'depenses_verrou_caisse')
               or (c.relname = 'tournees' and tg.tgname = 'tournees_verrou_caisse')
               or (c.relname = 'caisse_remises' and tg.tgname = 'caisse_remises_verrou_caisse'))) = 3
     and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'interne' and p.proname in ('_depense_verrou_caisse', '_tournee_verrou_caisse', '_caisse_remise_verrou')) = 3;
$$;
revoke all on function public.verrou_caisse_actif() from public, anon, authenticated;
grant execute on function public.verrou_caisse_actif() to anon;

-- ── 4. Auto-contrôle (une erreur annule la migration) ─────────────────────────────────────────────────────────────
do $$
declare v_def boolean; v_cfg text[]; f text; t text[];
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
       and column_name in ('id', 'livreur', 'date_depense')) <> 3
     or (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'tournees'
       and column_name in ('id', 'livreur', 'date_tournee')) <> 3 then
    raise exception 'Auto-contrôle 038b : colonnes depenses.id / livreur / date_depense ou tournees.id / livreur / date_tournee absentes';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'caisse_remises'
       and column_name in ('controle_depenses', 'controle_arrets')) <> 2 then
    raise exception 'Auto-contrôle 038b : colonnes caisse_remises.controle_depenses / controle_arrets absentes';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tournees' and column_name = 'stops') then
    raise exception 'Auto-contrôle 038b : colonne public.tournees.stops absente';
  end if;
  -- relevé de caisse des arrêts : champs sans effet ignorés, client gardé seulement sans commande, clés toujours présentes
  if interne.l038b_arrets_caisse('[{"cmdId":"#1","client":"X","statut":"livré","gps":[1,2],"heure":"10:00"},{"client":"Y","statut":"absent"}]'::jsonb)
     is distinct from '[{"cmdId":"#1","client":null,"statut":"livré","paie":null,"stpaie":null,"encAvant":null,"encTournee":null,"paie_especes":null,"paie_cb":null,"enc":null},{"cmdId":null,"client":"Y","statut":"absent","paie":null,"stpaie":null,"encAvant":null,"encTournee":null,"paie_especes":null,"paie_cb":null,"enc":null}]'::jsonb
     or interne.l038b_arrets_caisse(null) <> '[]'::jsonb or interne.l038b_arrets_caisse('{}'::jsonb) <> '[]'::jsonb
     or interne.l038b_arrets_caisse('[{"statut":"livré","encTournee":{"esp":10}}]'::jsonb) = interne.l038b_arrets_caisse('[{"statut":"livré","encTournee":{"esp":12}}]'::jsonb) then
    raise exception 'Auto-contrôle 038b : interne.l038b_arrets_caisse incorrecte';
  end if;
  if interne.l038b_depenses_especes('T-AUTOCONTROLE-038B-ABSENTE') is not null then
    raise exception 'Auto-contrôle 038b : interne.l038b_depenses_especes doit renvoyer null pour une tournée absente';
  end if;
  if interne.l038b_tournee_attribuee('T-X', 'L', '2000-01-01') is distinct from 'T-X' then
    raise exception 'Auto-contrôle 038b : tournee_id renseigné non retenu tel quel';
  end if;
  if interne.l038b_premiere('L-AUTOCONTROLE-038B', '1900-01-01', null, 'T-X') is distinct from 'T-X'
     or interne.l038b_premiere('L-AUTOCONTROLE-038B', '1900-01-01', null, null) is not null then
    raise exception 'Auto-contrôle 038b : interne.l038b_premiere incorrecte';
  end if;
  -- clé du verrou : stable, propre à chaque tournée, dans l'espace 38002
  if interne.l038b_cle('T-1') is distinct from interne.l038b_cle('T-1') or interne.l038b_cle('T-1') = interne.l038b_cle('T-2')
     or (interne.l038b_cle('T-1') >> 32) <> 38002 then
    raise exception 'Auto-contrôle 038b : clé de verrou interne.l038b_cle incorrecte';
  end if;
  -- déclencheurs présents et actifs sur les trois opérations (4 = INSERT, 8 = DELETE, 16 = UPDATE)
  foreach t slice 1 in array array[['depenses', 'depenses_verrou_caisse'], ['tournees', 'tournees_verrou_caisse'],
                                    ['caisse_remises', 'caisse_remises_verrou_caisse']] loop
    if not exists (select 1 from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = t[1] and tg.tgname = t[2]
                      and tg.tgenabled <> 'D' and (tg.tgtype & 28) = 28) then
      raise exception 'Auto-contrôle 038b : déclencheur % absent, désactivé ou incomplet', t[2];
    end if;
  end loop;
  -- fonctions privées : SECURITY DEFINER avec search_path figé (sauf fonctions pures), non exécutables par anon / authenticated
  foreach f in array array['_depense_verrou_caisse', '_tournee_verrou_caisse', '_caisse_remise_verrou', 'l038b_verrouiller',
                           'l038b_validee', 'l038b_premiere', 'l038b_sans_tournee', 'l038b_tournee_attribuee', 'l038b_depenses_especes'] loop
    select p.prosecdef, p.proconfig into v_def, v_cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'interne' and p.proname = f;
    if not coalesce(v_def, false) or v_cfg is null or not exists (select 1 from unnest(v_cfg) x where x like 'search_path=%') then
      raise exception 'Auto-contrôle 038b : interne.% doit être SECURITY DEFINER avec search_path figé', f;
    end if;
  end loop;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'interne' and (p.proname like 'l038b\_%' or p.proname in ('_depense_verrou_caisse', '_tournee_verrou_caisse', '_caisse_remise_verrou'))
                and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))) then
    raise exception 'Auto-contrôle 038b : une fonction interne du verrou est exécutable par anon / authenticated';
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
