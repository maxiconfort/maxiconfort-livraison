-- ════════════════════════════════════════════════════════════════════
-- 019 - Incident cles Supabase (27/09/2026) - applique via l'API Management
-- AUCUNE valeur secrete ici. Les valeurs (secret interne des crons, APP_SECRET courant,
-- empreintes des PIN) ont ete posees a part (Vault / secrets_serveur).
-- Ordre applique : tables serveur -> crons -> PIN serveur -> sessions -> RLS par role -> droits.
-- ════════════════════════════════════════════════════════════════════

create table if not exists public.secrets_serveur (cle text primary key, valeur text not null, updated_at timestamptz not null default now());
alter table public.secrets_serveur enable row level security; alter table public.secrets_serveur force row level security;
revoke all on table public.secrets_serveur from anon, authenticated, public;
create table if not exists public.oauth_etats (etat text primary key, fournisseur text not null, cree_at timestamptz not null default now(), expire_at timestamptz not null, utilise_at timestamptz);
alter table public.oauth_etats enable row level security; alter table public.oauth_etats force row level security;
revoke all on table public.oauth_etats from anon, authenticated, public;

-- Crons -> Edge Functions : en-tete x-cron-secret lu dans Vault (secret INTERNAL_CRON_SECRET)
create schema if not exists interne;
revoke all on schema interne from public, anon, authenticated;
create or replace function interne.appel_fonction(p_nom text, p_corps jsonb default '{}'::jsonb, p_timeout_ms int default 5000)
returns bigint language sql security definer set search_path = pg_catalog, public as $$
  select net.http_post(url := 'https://jmvfjtnmebstkzcfnlgp.supabase.co/functions/v1/' || p_nom,
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name = 'INTERNAL_CRON_SECRET' limit 1)),
    body := p_corps, timeout_milliseconds := p_timeout_ms);
$$;
revoke all on function interne.appel_fonction(text, jsonb, int) from public, anon, authenticated;
-- (les 18 crons appellent : select interne.appel_fonction('<fonction>', '<corps>'::jsonb, <timeout>);)
-- PIN verifies cote serveur (incident cles 27/09/2026). Aucune valeur de PIN dans ce fichier.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.pin_tentatives (
  id bigserial primary key,
  role text not null,
  ip text,
  ok boolean not null,
  cree_at timestamptz not null default now()
);
create index if not exists pin_tentatives_idx on public.pin_tentatives (role, cree_at);
alter table public.pin_tentatives enable row level security;
alter table public.pin_tentatives force row level security;
revoke all on table public.pin_tentatives from anon, authenticated, public;
revoke all on sequence public.pin_tentatives_id_seq from anon, authenticated, public;

create table if not exists public.sessions_app (
  jeton_hash text primary key,
  role text not null,
  livreur text,
  cree_at timestamptz not null default now(),
  expire_at timestamptz not null
);
alter table public.sessions_app enable row level security;
alter table public.sessions_app force row level security;
revoke all on table public.sessions_app from anon, authenticated, public;

-- en-tete x-app-secret present et egal au secret des politiques RLS (lu dans secrets_serveur)
create or replace function public._app_secret_ok() returns boolean
language plpgsql stable security definer set search_path = public, pg_catalog as $$
declare h json; s text; attendu text;
begin
  begin h := current_setting('request.headers', true)::json; exception when others then return false; end;
  if h is null then return false; end if;
  s := h ->> 'x-app-secret';
  select valeur into attendu from public.secrets_serveur where cle = 'app_secret_courant';
  return s is not null and attendu is not null and s = attendu;
end $$;
revoke all on function public._app_secret_ok() from public, anon, authenticated;

create or replace function public._ip_appelant() returns text
language plpgsql stable security definer set search_path = public, pg_catalog as $$
declare h json;
begin
  begin h := current_setting('request.headers', true)::json; exception when others then return null; end;
  return coalesce(h ->> 'cf-connecting-ip', split_part(coalesce(h ->> 'x-forwarded-for', ''), ',', 1), null);
end $$;
revoke all on function public._ip_appelant() from public, anon, authenticated;

-- verifier_pin : renvoie un jeton de session (12 h) si le PIN est bon.
-- Limites : 5 echecs / 15 min par IP et par role ; 40 echecs / heure par role (tous appareils) -> blocage temporaire.
create or replace function public.verifier_pin(p_role text, p_pin text, p_livreur text default null)
returns json language plpgsql volatile security definer set search_path = public, extensions, pg_catalog as $$
declare v_hash text; v_ip text; v_ech_ip int; v_ech_role int; v_jeton text; v_exp timestamptz;
begin
  if not public._app_secret_ok() then return json_build_object('ok', false, 'erreur', 'non_autorise'); end if;
  if p_role not in ('admin', 'collab', 'livreur') then return json_build_object('ok', false, 'erreur', 'role_invalide'); end if;
  v_ip := public._ip_appelant();
  select count(*) into v_ech_ip from public.pin_tentatives
    where role = p_role and not ok and ip is not distinct from v_ip and cree_at > now() - interval '15 minutes';
  select count(*) into v_ech_role from public.pin_tentatives
    where role = p_role and not ok and cree_at > now() - interval '1 hour';
  if v_ech_ip >= 5 or v_ech_role >= 40 then
    return json_build_object('ok', false, 'erreur', 'trop_d_essais');
  end if;
  select valeur into v_hash from public.secrets_serveur where cle = 'pin_hash_' || p_role;
  if v_hash is null or p_pin is null or p_pin !~ '^[0-9]{4}$' or extensions.crypt(p_pin, v_hash) <> v_hash then
    insert into public.pin_tentatives(role, ip, ok) values (p_role, v_ip, false);
    return json_build_object('ok', false, 'erreur', 'pin_incorrect');
  end if;
  insert into public.pin_tentatives(role, ip, ok) values (p_role, v_ip, true);
  delete from public.pin_tentatives where cree_at < now() - interval '30 days';
  delete from public.sessions_app where expire_at < now();
  v_jeton := encode(extensions.gen_random_bytes(32), 'hex');
  v_exp := now() + interval '12 hours';
  insert into public.sessions_app(jeton_hash, role, livreur, expire_at)
    values (encode(extensions.digest(v_jeton, 'sha256'), 'hex'), p_role, nullif(upper(trim(coalesce(p_livreur, ''))), ''), v_exp);
  return json_build_object('ok', true, 'role', p_role, 'jeton', v_jeton, 'expire_at', v_exp);
end $$;
revoke all on function public.verifier_pin(text, text, text) from public, anon, authenticated;
grant execute on function public.verifier_pin(text, text, text) to anon;

-- changer_pin : reserve a une session ADMIN valide ; invalide les sessions du role modifie.
create or replace function public.changer_pin(p_jeton text, p_role text, p_nouveau text)
returns json language plpgsql volatile security definer set search_path = public, extensions, pg_catalog as $$
declare v_role text;
begin
  if not public._app_secret_ok() then return json_build_object('ok', false, 'erreur', 'non_autorise'); end if;
  select role into v_role from public.sessions_app
    where jeton_hash = encode(extensions.digest(coalesce(p_jeton, ''), 'sha256'), 'hex') and expire_at > now();
  if v_role is distinct from 'admin' then return json_build_object('ok', false, 'erreur', 'session_admin_requise'); end if;
  if p_role not in ('admin', 'collab', 'livreur') then return json_build_object('ok', false, 'erreur', 'role_invalide'); end if;
  if p_nouveau is null or p_nouveau !~ '^[0-9]{4}$' then return json_build_object('ok', false, 'erreur', 'format_4_chiffres'); end if;
  insert into public.secrets_serveur(cle, valeur, updated_at)
    values ('pin_hash_' || p_role, extensions.crypt(p_nouveau, extensions.gen_salt('bf', 8)), now())
    on conflict (cle) do update set valeur = excluded.valeur, updated_at = now();
  delete from public.sessions_app where role = p_role
    and jeton_hash <> encode(extensions.digest(p_jeton, 'sha256'), 'hex');
  return json_build_object('ok', true);
end $$;
revoke all on function public.changer_pin(text, text, text) from public, anon, authenticated;
grant execute on function public.changer_pin(text, text, text) to anon;

-- verifier_session : l'app peut verifier qu'un jeton est encore valide (role, expiration)
create or replace function public.verifier_session(p_jeton text)
returns json language plpgsql stable security definer set search_path = public, extensions, pg_catalog as $$
declare r record;
begin
  if not public._app_secret_ok() then return json_build_object('ok', false, 'erreur', 'non_autorise'); end if;
  select role, livreur, expire_at into r from public.sessions_app
    where jeton_hash = encode(extensions.digest(coalesce(p_jeton, ''), 'sha256'), 'hex') and expire_at > now();
  if not found then return json_build_object('ok', false); end if;
  return json_build_object('ok', true, 'role', r.role, 'livreur', r.livreur, 'expire_at', r.expire_at);
end $$;
revoke all on function public.verifier_session(text) from public, anon, authenticated;
grant execute on function public.verifier_session(text) to anon;

-- Sessions serveur pour proteger les DONNEES (27/09/2026). Aucune valeur secrete ici.
alter table public.sessions_app add column if not exists appareil text;

-- session_valide() : en-tete x-session-token -> session existante et non expiree
create or replace function public.session_valide() returns boolean
language plpgsql stable security definer set search_path = public, extensions, pg_catalog as $$
declare h json; t text;
begin
  begin h := current_setting('request.headers', true)::json; exception when others then return false; end;
  if h is null then return false; end if;
  t := h ->> 'x-session-token';
  if t is null or length(t) < 32 then return false; end if;
  return exists (select 1 from public.sessions_app
                 where jeton_hash = encode(extensions.digest(t, 'sha256'), 'hex') and expire_at > now());
end $$;
revoke all on function public.session_valide() from public;
grant execute on function public.session_valide() to anon, authenticated;

-- connexion_pin : verifie le PIN (bcrypt), limite les essais, temporise les echecs, renvoie un jeton 12 h
create or replace function public.connexion_pin(p_role text, p_pin text, p_livreur text default null)
returns json language plpgsql volatile security definer set search_path = public, extensions, pg_catalog as $$
declare v_hash text; v_ip text; v_ech_ip int; v_ech_role int; v_jeton text; v_exp timestamptz; v_ua text; h json;
begin
  if not public._app_secret_ok() then return json_build_object('ok', false, 'erreur', 'non_autorise'); end if;
  if p_role not in ('admin', 'collab', 'livreur') then return json_build_object('ok', false, 'erreur', 'role_invalide'); end if;
  v_ip := public._ip_appelant();
  begin h := current_setting('request.headers', true)::json; v_ua := left(h ->> 'user-agent', 200); exception when others then v_ua := null; end;
  select count(*) into v_ech_ip from public.pin_tentatives
    where role = p_role and not ok and ip is not distinct from v_ip and cree_at > now() - interval '15 minutes';
  select count(*) into v_ech_role from public.pin_tentatives
    where role = p_role and not ok and cree_at > now() - interval '15 minutes';
  if v_ech_ip >= 5 or v_ech_role >= 20 then
    perform pg_sleep(1);
    return json_build_object('ok', false, 'erreur', 'trop_d_essais');
  end if;
  select valeur into v_hash from public.secrets_serveur where cle = 'pin_hash_' || p_role;
  if v_hash is null or p_pin is null or p_pin !~ '^[0-9]{4}$' or extensions.crypt(p_pin, v_hash) <> v_hash then
    insert into public.pin_tentatives(role, ip, ok) values (p_role, v_ip, false);
    perform pg_sleep(1);
    return json_build_object('ok', false, 'erreur', 'pin_incorrect');
  end if;
  insert into public.pin_tentatives(role, ip, ok) values (p_role, v_ip, true);
  delete from public.pin_tentatives where cree_at < now() - interval '30 days';
  delete from public.sessions_app where expire_at < now();
  v_jeton := encode(extensions.gen_random_bytes(32), 'hex');
  v_exp := now() + interval '12 hours';
  insert into public.sessions_app(jeton_hash, role, livreur, expire_at, appareil)
    values (encode(extensions.digest(v_jeton, 'sha256'), 'hex'), p_role,
            nullif(upper(trim(coalesce(p_livreur, ''))), ''), v_exp, v_ua);
  return json_build_object('ok', true, 'role', p_role, 'jeton', v_jeton, 'expire_at', v_exp);
end $$;
revoke all on function public.connexion_pin(text, text, text) from public, anon, authenticated;
grant execute on function public.connexion_pin(text, text, text) to anon;

-- verifier_pin (utilise par la v7.5.110) = meme logique
create or replace function public.verifier_pin(p_role text, p_pin text, p_livreur text default null)
returns json language sql volatile security definer set search_path = public, pg_catalog as $$
  select public.connexion_pin(p_role, p_pin, p_livreur);
$$;
revoke all on function public.verifier_pin(text, text, text) from public, anon, authenticated;
grant execute on function public.verifier_pin(text, text, text) to anon;

-- deconnexion : supprime la session de l'en-tete x-session-token
create or replace function public.deconnexion() returns json
language plpgsql volatile security definer set search_path = public, extensions, pg_catalog as $$
declare h json; t text;
begin
  begin h := current_setting('request.headers', true)::json; exception when others then return json_build_object('ok', false); end;
  t := h ->> 'x-session-token';
  if t is not null then delete from public.sessions_app where jeton_hash = encode(extensions.digest(t, 'sha256'), 'hex'); end if;
  return json_build_object('ok', true);
end $$;
revoke all on function public.deconnexion() from public, anon, authenticated;
grant execute on function public.deconnexion() to anon;

-- RLS par SESSION et par ROLE (incident cles 27/09/2026). Aucune valeur secrete.
-- Role de la session courante (en-tetes x-app-secret + x-session-token), NULL sinon.
create or replace function public.session_role() returns text
language plpgsql stable security definer set search_path = public, extensions, pg_catalog as $$
declare h json; t text; r text;
begin
  if not public._app_secret_ok() then return null; end if;
  begin h := current_setting('request.headers', true)::json; exception when others then return null; end;
  t := h ->> 'x-session-token';
  if t is null or t !~ '^[0-9a-f]{64}$' then return null; end if;
  select role into r from public.sessions_app
   where jeton_hash = encode(extensions.digest(t, 'sha256'), 'hex') and expire_at > now() and revoquee_at is null;
  return r;
end $$;

create or replace function public.session_livreur() returns text
language plpgsql stable security definer set search_path = public, extensions, pg_catalog as $$
declare h json; t text; r text;
begin
  if not public._app_secret_ok() then return null; end if;
  begin h := current_setting('request.headers', true)::json; exception when others then return null; end;
  t := h ->> 'x-session-token';
  if t is null or t !~ '^[0-9a-f]{64}$' then return null; end if;
  select livreur into r from public.sessions_app
   where jeton_hash = encode(extensions.digest(t, 'sha256'), 'hex') and expire_at > now() and revoquee_at is null and role = 'livreur';
  return r;
end $$;

create or replace function public.session_valide() returns boolean
language sql stable security definer set search_path = public, pg_catalog as $$
  select public.session_role() is not null;
$$;

-- revocation : sessions revocables (deconnexion, changement de PIN, revocation admin)
create or replace function public.deconnexion() returns json
language plpgsql volatile security definer set search_path = public, extensions, pg_catalog as $$
declare h json; t text;
begin
  begin h := current_setting('request.headers', true)::json; exception when others then return json_build_object('ok', false); end;
  t := h ->> 'x-session-token';
  if t is not null then
    update public.sessions_app set revoquee_at = now() where jeton_hash = encode(extensions.digest(t, 'sha256'), 'hex') and revoquee_at is null;
  end if;
  return json_build_object('ok', true);
end $$;

create or replace function public.revoquer_sessions(p_role text) returns json
language plpgsql volatile security definer set search_path = public, extensions, pg_catalog as $$
declare n int; h json; t text;
begin
  if public.session_role() is distinct from 'admin' then return json_build_object('ok', false, 'erreur', 'session_admin_requise'); end if;
  if p_role not in ('admin', 'collab', 'livreur', 'tous') then return json_build_object('ok', false, 'erreur', 'role_invalide'); end if;
  h := current_setting('request.headers', true)::json; t := h ->> 'x-session-token';
  update public.sessions_app set revoquee_at = now()
   where revoquee_at is null and (p_role = 'tous' or role = p_role)
     and jeton_hash <> encode(extensions.digest(t, 'sha256'), 'hex');
  get diagnostics n = row_count;
  return json_build_object('ok', true, 'sessions_revoquees', n);
end $$;

-- changer_pin : session admin via en-tete (ou jeton passe en parametre), revoque les sessions du role
create or replace function public.changer_pin(p_jeton text, p_role text, p_nouveau text)
returns json language plpgsql volatile security definer set search_path = public, extensions, pg_catalog as $$
declare v_role text;
begin
  if not public._app_secret_ok() then return json_build_object('ok', false, 'erreur', 'non_autorise'); end if;
  select role into v_role from public.sessions_app
   where jeton_hash = encode(extensions.digest(coalesce(p_jeton, ''), 'sha256'), 'hex') and expire_at > now() and revoquee_at is null;
  if v_role is distinct from 'admin' then return json_build_object('ok', false, 'erreur', 'session_admin_requise'); end if;
  if p_role not in ('admin', 'collab', 'livreur') then return json_build_object('ok', false, 'erreur', 'role_invalide'); end if;
  if p_nouveau is null or p_nouveau !~ '^[0-9]{4}$' then return json_build_object('ok', false, 'erreur', 'format_4_chiffres'); end if;
  insert into public.secrets_serveur(cle, valeur, updated_at)
    values ('pin_hash_' || p_role, extensions.crypt(p_nouveau, extensions.gen_salt('bf', 8)), now())
    on conflict (cle) do update set valeur = excluded.valeur, updated_at = now();
  update public.sessions_app set revoquee_at = now() where role = p_role and revoquee_at is null
    and jeton_hash <> encode(extensions.digest(p_jeton, 'sha256'), 'hex');
  return json_build_object('ok', true);
end $$;

create or replace function public.verifier_session(p_jeton text)
returns json language plpgsql stable security definer set search_path = public, extensions, pg_catalog as $$
declare r record;
begin
  if not public._app_secret_ok() then return json_build_object('ok', false, 'erreur', 'non_autorise'); end if;
  select role, livreur, expire_at into r from public.sessions_app
    where jeton_hash = encode(extensions.digest(coalesce(p_jeton, ''), 'sha256'), 'hex') and expire_at > now() and revoquee_at is null;
  if not found then return json_build_object('ok', false); end if;
  return json_build_object('ok', true, 'role', r.role, 'livreur', r.livreur, 'expire_at', r.expire_at);
end $$;

-- Livreur : ne peut ni creer une commande, ni modifier les champs clients / montants (valeurs restaurees)
create or replace function public._garde_livreur_commandes() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if public.session_role() is distinct from 'livreur' then return new; end if;
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.commandes where id = new.id) then
      raise exception 'livreur : creation de commande interdite';
    end if;
    return new;
  end if;
  new.client := old.client; new.tel := old.tel; new.email := old.email; new.adresse := old.adresse;
  new.produit := old.produit; new.lignes := old.lignes; new.qte := old.qte;
  new.prix := old.prix; new.prix_brut := old.prix_brut; new.frais_port := old.frais_port;
  new.remise_globale := old.remise_globale; new.remise_globale_val := old.remise_globale_val;
  new.remise_globale_type := old.remise_globale_type; new.remise_motif := old.remise_motif;
  new.livreur := old.livreur; new.origine := old.origine; new.ref_marketplace := old.ref_marketplace;
  new.date_commande := old.date_commande; new.tracking_token := old.tracking_token; new.transporteur := old.transporteur;
  new.tracking_transporteur := old.tracking_transporteur; new.created_at := old.created_at;
  return new;
end $$;
drop trigger if exists garde_livreur_commandes on public.commandes;
create trigger garde_livreur_commandes before insert or update on public.commandes
  for each row execute function public._garde_livreur_commandes();

-- ── Politiques : remplacement de require_app_secret (x-app-secret seul, public) ──
do $$
declare t text;
begin
  foreach t in array array['caisse_remises','chargements','commandes','depenses','entretiens','geofence_logs','gls_sync_logs',
    'gps_positions','lbc_annonces','lbc_config','lbc_produits','lbc_releves','lbc_villes','livreurs','mouvements_stock',
    'parametres','produits','sms_historique','stock_camion','stock_mouvements','tournees','vehicules','zones'] loop
    execute format('drop policy if exists require_app_secret on public.%I', t);
    execute format('drop policy if exists sess_admin on public.%I', t);
    execute format('create policy sess_admin on public.%I for all to anon using ((select public.session_role()) = ''admin'') with check ((select public.session_role()) = ''admin'')', t);
  end loop;
end $$;

-- COLLABORATRICE : gestion commandes / tournees / stock / produits ; lecture referentiels ; PAS caisse, depenses, lbc, parametres sensibles
do $$
declare t text;
begin
  foreach t in array array['commandes','tournees','chargements','stock_camion','mouvements_stock','stock_mouvements','produits'] loop
    execute format('drop policy if exists sess_collab on public.%I', t);
    execute format('create policy sess_collab on public.%I for all to anon using ((select public.session_role()) = ''collab'') with check ((select public.session_role()) = ''collab'')', t);
  end loop;
  foreach t in array array['livreurs','zones','vehicules','entretiens','gps_positions','geofence_logs','gls_sync_logs','sms_historique'] loop
    execute format('drop policy if exists sess_collab_lecture on public.%I', t);
    execute format('create policy sess_collab_lecture on public.%I for select to anon using ((select public.session_role()) = ''collab'')', t);
  end loop;
end $$;
drop policy if exists sess_collab_ecriture on public.sms_historique;
create policy sess_collab_ecriture on public.sms_historique for insert to anon with check ((select public.session_role()) = 'collab');

-- parametres non sensibles (societe, mentions, domicile livreur, dates verrouillees) : lecture collab + livreur
drop policy if exists sess_parametres_lecture on public.parametres;
create policy sess_parametres_lecture on public.parametres for select to anon
  using ((select public.session_role()) in ('collab', 'livreur')
         and (cle in ('soc_nom','soc_tel','soc_adresse','soc_email','legal_text','gardefou_skip_dates') or cle like 'livreur\_%\_domicile'));

-- LIVREUR : uniquement SES livraisons recentes/du jour et ses donnees de tournee
drop policy if exists sess_livreur on public.commandes;
create policy sess_livreur on public.commandes for all to anon
  using ((select public.session_role()) = 'livreur' and upper(coalesce(livreur,'')) = (select public.session_livreur())
         and coalesce(date_livraison,'') >= to_char(current_date - 2, 'YYYY-MM-DD') and coalesce(date_livraison,'') <= to_char(current_date + 2, 'YYYY-MM-DD'))
  with check ((select public.session_role()) = 'livreur' and upper(coalesce(livreur,'')) = (select public.session_livreur()));
drop policy if exists sess_livreur on public.tournees;
create policy sess_livreur on public.tournees for all to anon
  using ((select public.session_role()) = 'livreur' and upper(coalesce(livreur,'')) = (select public.session_livreur())
         and coalesce(date_tournee,'') >= to_char(current_date - 2, 'YYYY-MM-DD') and coalesce(date_tournee,'') <= to_char(current_date + 2, 'YYYY-MM-DD'))
  with check ((select public.session_role()) = 'livreur' and upper(coalesce(livreur,'')) = (select public.session_livreur()));
do $$
declare t text;
begin
  foreach t in array array['chargements','stock_camion','mouvements_stock','gps_positions','geofence_logs','depenses'] loop
    execute format('drop policy if exists sess_livreur on public.%I', t);
    execute format('create policy sess_livreur on public.%I for all to anon using ((select public.session_role()) = ''livreur'' and upper(coalesce(livreur,'''')) = (select public.session_livreur())) with check ((select public.session_role()) = ''livreur'' and upper(coalesce(livreur,'''')) = (select public.session_livreur()))', t);
  end loop;
  foreach t in array array['produits','livreurs','zones','vehicules','entretiens'] loop
    execute format('drop policy if exists sess_livreur_lecture on public.%I', t);
    execute format('create policy sess_livreur_lecture on public.%I for select to anon using ((select public.session_role()) = ''livreur'')', t);
  end loop;
end $$;
-- livreur : decompte de stock a la livraison (produits.stock) + historique de mouvement
drop policy if exists sess_livreur_stock on public.produits;
create policy sess_livreur_stock on public.produits for update to anon using ((select public.session_role()) = 'livreur') with check ((select public.session_role()) = 'livreur');
drop policy if exists sess_livreur_ajout on public.stock_mouvements;
create policy sess_livreur_ajout on public.stock_mouvements for insert to anon with check ((select public.session_role()) = 'livreur');
drop policy if exists sess_livreur_ajout on public.sms_historique;
create policy sess_livreur_ajout on public.sms_historique for insert to anon with check ((select public.session_role()) = 'livreur');

-- Reouverture : droits UNIQUEMENT sur ce que les politiques par session protegent
grant usage on schema public to anon, authenticated;
-- tables app (politiques sess_* : admin / collab / livreur)
grant select, insert, update, delete on table
  public.caisse_remises, public.chargements, public.commandes, public.depenses, public.entretiens, public.geofence_logs,
  public.gls_sync_logs, public.gps_positions, public.livreurs, public.mouvements_stock, public.parametres, public.produits,
  public.sms_historique, public.stock_camion, public.stock_mouvements, public.tournees, public.vehicules, public.zones,
  public.lbc_annonces, public.lbc_config, public.lbc_produits, public.lbc_releves, public.lbc_villes
  to anon;
-- MAXI BRAIN (politiques brain_* : en-tete x-brain-secret par role)
grant select, insert, update on table
  public.brain_agents, public.brain_alerts, public.brain_approvals, public.brain_audit_events, public.brain_conflicts,
  public.brain_control, public.brain_executions, public.brain_integrations, public.brain_kpis_daily, public.brain_messages,
  public.brain_missions, public.brain_proposals, public.brain_snapshots
  to anon;
-- Outil LBC (Supabase Auth, compte unique, inscription fermee ; politiques auth_all_*)
grant select, insert, update, delete on table
  public.lbc_annonces, public.lbc_catalogue_site, public.lbc_params, public.lbc_produits, public.lbc_releves, public.lbc_villes
  to authenticated;
alter view public.lbc_perf_agg set (security_invoker = true);
alter view public.lbc_perf_dept set (security_invoker = true);
alter view public.lbc_perf_ville set (security_invoker = true);
alter view public.lbc_perf_ville_organique set (security_invoker = true);
alter view public.lbc_suivi_boost set (security_invoker = true);
grant select on public.lbc_perf_agg, public.lbc_perf_dept, public.lbc_perf_ville, public.lbc_perf_ville_organique, public.lbc_suivi_boost to authenticated;
alter view public.geofence_stats_quotidien set (security_invoker = true);
grant select on public.geofence_stats_quotidien to anon;
-- sequences des tables ci-dessus
grant usage, select on all sequences in schema public to anon, authenticated;
revoke all on sequence public.pin_tentatives_id_seq from anon, authenticated;
-- fonctions : connexion / session / politiques
grant execute on function public.connexion_pin(text, text, text), public.verifier_pin(text, text, text), public.deconnexion(),
  public.verifier_session(text), public.changer_pin(text, text, text), public.revoquer_sessions(text),
  public.session_role(), public.session_livreur(), public.session_valide(), public._app_secret_ok(),
  public.brain_has(text), public.brain_any()
  to anon;
grant execute on function public.brain_has(text), public.brain_any() to authenticated;
