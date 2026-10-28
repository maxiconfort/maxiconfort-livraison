-- ════════════════════════════════════════════════════════════════════
-- 036 — Porte JARVIS « lbc-action » : aperçu enregistré, confirmation ATOMIQUE, journal (28/10/2026, lot LBC 2)
-- ════════════════════════════════════════════════════════════════════
-- Réserves Codex sur la PR Livraison #6 :
--  1. une confirmation n'est acceptée que contre un APERÇU enregistré par le serveur (jeton à usage unique, 10 min), pour
--     EXACTEMENT les mêmes paramètres ; la validation humaine a lieu dans JARVIS (bouton « Confirmer » de Borhen, page locale
--     à origine contrôlée) — ce jeton prouve que la confirmation porte sur l'aperçu montré, rien d'autre ;
--  2. l'aperçu fige une EMPREINTE de chaque ligne visée (annonce ou produit) ; à la confirmation, la moindre différence
--     (heure, ville, statut, lien, validation, boost…) → rien n'est écrit ;
--  3. contrôles + écriture dans UNE transaction, lignes verrouillées (FOR UPDATE) : tout le lot ou rien ;
--  4. journal en ajout seul : jeton, action, cibles, avant / après, résultat (jamais de secret) ;
--  5. (2e passage) l'aperçu renvoie les LIGNES qu'il a empreintées, lues dans la MÊME instruction (même instantané) : ce que
--     Borhen voit est exactement ce qui est figé ; la confirmation reçoit les cibles demandées (p_ids) et les refuse si elles
--     diffèrent de celles du jeton ; elle renvoie les cibles réellement traitées (relecture par l'Edge Function).
-- Exécutable seulement par la clé serveur (service_role) : ni le navigateur, ni l'outil LBC, ni une session de l'appli.
-- Les types des colonnes de lbc_annonces / lbc_produits ne sont pas supposés (texte ou date) : comparaisons en ::text,
-- écritures par conversions qui valent pour les deux.
-- ════════════════════════════════════════════════════════════════════

create table if not exists public.lbc_action_apercus (
  jeton uuid primary key default gen_random_uuid(),
  cree_le timestamptz not null default now(),
  utilise_le timestamptz,
  action text not null,
  demande jsonb not null,            -- paramètres exacts (sans les cibles)
  cibles jsonb not null              -- [{ id, empreinte }]
);
create table if not exists public.lbc_actions_journal (
  id bigint generated always as identity primary key,
  le timestamptz not null default now(),
  jeton uuid,
  action text not null,
  resultat text not null,            -- OK | REFUS
  motif text,
  cibles jsonb,
  avant jsonb,
  apres jsonb
);
alter table public.lbc_action_apercus enable row level security;   -- aucune politique : serveur seulement
alter table public.lbc_actions_journal enable row level security;
revoke all on public.lbc_action_apercus, public.lbc_actions_journal from anon, authenticated;

create schema if not exists interne;

-- Journal en ajout seul
create or replace function interne.lbc_journal_ajout_seul() returns trigger language plpgsql as $$
begin raise exception 'journal en ajout seul'; end $$;
drop trigger if exists lbc_actions_journal_ajout_seul on public.lbc_actions_journal;
create trigger lbc_actions_journal_ajout_seul before update or delete on public.lbc_actions_journal
  for each row execute function interne.lbc_journal_ajout_seul();

-- Empreintes : TOUTES les colonnes qui comptent pour la décision de Borhen
create or replace function interne.lbc_empreinte_annonce(a public.lbc_annonces) returns text language sql stable as $$
  select md5(concat_ws('|', a.id::text, a.date_pub::text, a.heure::text, a.ville::text, a.dept::text, a.collab_id::text,
    a.produit::text, a.dim::text, a.validation::text, a.statut::text, coalesce(a.lien::text, '')))
$$;
create or replace function interne.lbc_empreinte_produit(p public.lbc_produits) returns text language sql stable as $$
  select md5(concat_ws('|', p.id::text, p.nom::text, p.dim::text, p.actif::text, p.boost_pct::text, p.boost_until::text,
    p.poids_idf::text, p.poids_prov::text))
$$;
create or replace function interne.lbc_jour_paris() returns text language sql stable as $$
  select to_char((now() at time zone 'Europe/Paris')::date, 'YYYY-MM-DD')
$$;

-- ── APERÇU : enregistre les cibles et leurs empreintes, renvoie le jeton (aucune écriture métier) ──
create or replace function public.lbc_action_enregistrer_apercu(p_action text, p_demande jsonb, p_ids text[]) returns jsonb
language plpgsql security definer set search_path = public, interne as $$
declare v_cibles jsonb; v_lignes jsonb; v_jeton uuid;
begin
  if p_action not in ('boost', 'fin_boost', 'poids_zone', 'bloquer', 'debloquer', 'decaler') then raise exception 'action non autorisée'; end if;
  if coalesce(array_length(p_ids, 1), 0) = 0 or array_length(p_ids, 1) > 100 then raise exception '1 à 100 cibles'; end if;
  if p_action in ('boost', 'fin_boost', 'poids_zone') then
    select jsonb_agg(jsonb_build_object('id', p.id::text, 'empreinte', interne.lbc_empreinte_produit(p)) order by p.id::text),
           jsonb_agg(jsonb_build_object('id', p.id::text, 'nom', p.nom, 'dim', p.dim, 'actif', p.actif, 'boost_pct', p.boost_pct, 'boost_until', p.boost_until,
             'poids_idf', p.poids_idf, 'poids_prov', p.poids_prov) order by p.id::text)
      into v_cibles, v_lignes from public.lbc_produits p where p.id::text = any(p_ids);
  else
    select jsonb_agg(jsonb_build_object('id', a.id::text, 'empreinte', interne.lbc_empreinte_annonce(a)) order by a.id::text),
           jsonb_agg(jsonb_build_object('id', a.id::text, 'date_pub', a.date_pub, 'heure', a.heure, 'ville', a.ville, 'dept', a.dept, 'collab_id', a.collab_id,
             'produit', a.produit, 'dim', a.dim, 'validation', a.validation, 'statut', a.statut, 'lien', a.lien) order by a.id::text)
      into v_cibles, v_lignes from public.lbc_annonces a where a.id::text = any(p_ids);
  end if;
  if coalesce(jsonb_array_length(v_cibles), 0) <> array_length(p_ids, 1) then raise exception 'cible introuvable'; end if;
  delete from public.lbc_action_apercus where cree_le < now() - interval '1 day';
  insert into public.lbc_action_apercus (action, demande, cibles) values (p_action, p_demande, v_cibles) returning jeton into v_jeton;
  return jsonb_build_object('jeton', v_jeton, 'lignes', v_lignes);   -- lignes = celles empreintes (même instantané)
end $$;

-- ── CONFIRMATION : tout ou rien ──
-- Renvoie { ok, code?, motif?, problemes?, modifiees } ; ne lève pas d'exception pour un refus métier (rien n'est écrit,
-- le refus est journalisé). Toute erreur inattendue annule la transaction entière.
drop function if exists public.lbc_action_appliquer(uuid, text, jsonb);
create or replace function public.lbc_action_appliquer(p_jeton uuid, p_action text, p_demande jsonb, p_ids text[]) returns jsonb
language plpgsql security definer set search_path = public, interne as $$
declare
  v_ap public.lbc_action_apercus; v_ids text[]; v_avant jsonb; v_apres jsonb; v_n int; v_problemes jsonb := '[]'::jsonb;
  v_auj text := interne.lbc_jour_paris(); r record; v_attendu text;
  v_statut text; v_validation text; v_date text; v_patch jsonb;
begin
  select * into v_ap from public.lbc_action_apercus where jeton = p_jeton for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'APERCU', 'motif', 'aperçu inconnu : refais l’aperçu'); end if;
  if v_ap.utilise_le is not null then return jsonb_build_object('ok', false, 'code', 'APERCU', 'motif', 'aperçu déjà utilisé'); end if;
  if v_ap.cree_le < now() - interval '10 minutes' then return jsonb_build_object('ok', false, 'code', 'APERCU', 'motif', 'aperçu expiré (10 min) : refais l’aperçu'); end if;
  if v_ap.action <> p_action or v_ap.demande <> p_demande then
    insert into public.lbc_actions_journal (jeton, action, resultat, motif) values (p_jeton, p_action, 'REFUS', 'paramètres différents de l’aperçu');
    return jsonb_build_object('ok', false, 'code', 'APERCU', 'motif', 'les paramètres ne sont pas ceux de l’aperçu : rien n’a été modifié');
  end if;
  select array_agg(c->>'id' order by c->>'id') into v_ids from jsonb_array_elements(v_ap.cibles) c;
  -- Les cibles demandées doivent être EXACTEMENT celles du jeton (ni substitution, ni ajout, ni retrait).
  if p_ids is null or (select array_agg(x order by x) from unnest(p_ids) x) is distinct from v_ids then
    update public.lbc_action_apercus set utilise_le = now() where jeton = p_jeton;   -- jeton brûlé : une tentative de substitution ne se rejoue pas
    insert into public.lbc_actions_journal (jeton, action, resultat, motif) values (p_jeton, p_action, 'REFUS', 'cibles différentes de l’aperçu');
    return jsonb_build_object('ok', false, 'code', 'APERCU', 'motif', 'les cibles ne sont pas celles de l’aperçu : rien n’a été modifié');
  end if;
  update public.lbc_action_apercus set utilise_le = now() where jeton = p_jeton;   -- usage unique (annulé avec le reste si erreur)

  if p_action in ('boost', 'fin_boost', 'poids_zone') then
    -- Produit : verrou, empreinte identique, actif
    for r in select p.*, interne.lbc_empreinte_produit(p) as emp from public.lbc_produits p where p.id::text = any(v_ids) for update loop
      v_attendu := (select c->>'empreinte' from jsonb_array_elements(v_ap.cibles) c where c->>'id' = r.id::text);
      if r.emp is distinct from v_attendu then v_problemes := v_problemes || jsonb_build_object('id', r.id::text, 'motif', 'a changé depuis l’aperçu'); end if;
      if r.actif is not null and r.actif::text in ('false', 'f') then v_problemes := v_problemes || jsonb_build_object('id', r.id::text, 'motif', 'inactif'); end if;
    end loop;
    select count(*) into v_n from public.lbc_produits p where p.id::text = any(v_ids);
    if v_n <> array_length(v_ids, 1) then v_problemes := v_problemes || jsonb_build_object('motif', 'produit introuvable'); end if;
    if jsonb_array_length(v_problemes) > 0 then
      insert into public.lbc_actions_journal (jeton, action, resultat, motif, cibles) values (p_jeton, p_action, 'REFUS', 'changé depuis l’aperçu', to_jsonb(v_ids));
      return jsonb_build_object('ok', false, 'code', 'CHANGE', 'motif', 'le produit a changé depuis l’aperçu : rien n’a été modifié', 'problemes', v_problemes);
    end if;
    select jsonb_agg(to_jsonb(p)) into v_avant from public.lbc_produits p where p.id::text = any(v_ids);
    if p_action = 'boost' then
      update public.lbc_produits set boost_pct = (p_demande->>'pct')::int,
        boost_until = ((v_auj::date) + (p_demande->>'jours')::int), updated_at = now() where id::text = any(v_ids);
    elsif p_action = 'fin_boost' then
      update public.lbc_produits set boost_pct = null, boost_until = null, updated_at = now() where id::text = any(v_ids);
    elsif p_demande->>'zone' = 'idf' then
      update public.lbc_produits set poids_idf = (p_demande->>'poids')::int, updated_at = now() where id::text = any(v_ids);
    else
      update public.lbc_produits set poids_prov = (p_demande->>'poids')::int, updated_at = now() where id::text = any(v_ids);
    end if;
    get diagnostics v_n = row_count;
    if v_n <> array_length(v_ids, 1) then raise exception 'nombre de lignes modifiées inattendu'; end if;
    select jsonb_agg(to_jsonb(p)) into v_apres from public.lbc_produits p where p.id::text = any(v_ids);
  else
    -- Annonces : verrou de TOUT le lot, empreinte identique, toujours à venir, non publiée, statut attendu
    for r in select a.*, interne.lbc_empreinte_annonce(a) as emp from public.lbc_annonces a where a.id::text = any(v_ids) for update loop
      v_attendu := (select c->>'empreinte' from jsonb_array_elements(v_ap.cibles) c where c->>'id' = r.id::text);
      if r.emp is distinct from v_attendu then v_problemes := v_problemes || jsonb_build_object('id', r.id::text, 'motif', 'a changé depuis l’aperçu');
      elsif left(r.date_pub::text, 10) < v_auj then v_problemes := v_problemes || jsonb_build_object('id', r.id::text, 'motif', 'jour passé');
      elsif r.validation::text = 'ON' or coalesce(btrim(r.lien::text), '') <> '' then v_problemes := v_problemes || jsonb_build_object('id', r.id::text, 'motif', 'déjà publiée');
      elsif p_action = 'debloquer' and r.statut::text is distinct from 'Bloqué' then v_problemes := v_problemes || jsonb_build_object('id', r.id::text, 'motif', 'pas bloquée');
      elsif p_action <> 'debloquer' and r.statut::text = 'Bloqué' then v_problemes := v_problemes || jsonb_build_object('id', r.id::text, 'motif', 'déjà bloquée');
      end if;
    end loop;
    select count(*) into v_n from public.lbc_annonces a where a.id::text = any(v_ids);
    if v_n <> array_length(v_ids, 1) then v_problemes := v_problemes || jsonb_build_object('motif', 'annonce introuvable'); end if;
    if jsonb_array_length(v_problemes) > 0 then
      insert into public.lbc_actions_journal (jeton, action, resultat, motif, cibles) values (p_jeton, p_action, 'REFUS', 'planning changé depuis l’aperçu', to_jsonb(v_ids));
      return jsonb_build_object('ok', false, 'code', 'CHANGE', 'motif', 'le planning a changé depuis l’aperçu : rien n’a été modifié, refais l’aperçu', 'problemes', v_problemes);
    end if;
    select jsonb_agg(jsonb_build_object('id', a.id::text, 'date_pub', a.date_pub::text, 'statut', a.statut::text, 'validation', a.validation::text)) into v_avant from public.lbc_annonces a where a.id::text = any(v_ids);
    if p_action = 'bloquer' then
      update public.lbc_annonces set statut = 'Bloqué', validation = 'OFF', updated_at = now() where id::text = any(v_ids);
    elsif p_action = 'debloquer' then
      update public.lbc_annonces set statut = 'À publier', updated_at = now() where id::text = any(v_ids);
    else
      if (p_demande->>'nouvelleDate') < v_auj or (p_demande->>'nouvelleDate')::date > (v_auj::date + 30) then raise exception 'nouvelle date hors bornes'; end if;
      update public.lbc_annonces set date_pub = (p_demande->>'nouvelleDate')::date, updated_at = now() where id::text = any(v_ids);
    end if;
    get diagnostics v_n = row_count;
    if v_n <> array_length(v_ids, 1) then raise exception 'nombre de lignes modifiées inattendu'; end if;
    select jsonb_agg(jsonb_build_object('id', a.id::text, 'date_pub', a.date_pub::text, 'statut', a.statut::text, 'validation', a.validation::text)) into v_apres from public.lbc_annonces a where a.id::text = any(v_ids);
  end if;
  insert into public.lbc_actions_journal (jeton, action, resultat, cibles, avant, apres) values (p_jeton, p_action, 'OK', to_jsonb(v_ids), v_avant, v_apres);
  return jsonb_build_object('ok', true, 'modifiees', v_n, 'cibles', to_jsonb(v_ids), 'apres', v_apres);
end $$;

revoke all on function public.lbc_action_enregistrer_apercu(text, jsonb, text[]) from public, anon, authenticated;
revoke all on function public.lbc_action_appliquer(uuid, text, jsonb, text[]) from public, anon, authenticated;
grant execute on function public.lbc_action_enregistrer_apercu(text, jsonb, text[]) to service_role;
grant execute on function public.lbc_action_appliquer(uuid, text, jsonb, text[]) to service_role;
