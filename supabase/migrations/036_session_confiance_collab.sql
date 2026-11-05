-- 036 — « Appareil de confiance » : un ordinateur connecté en Collaboratrice pendant 40 jours
-- (GO Borhen 05/11/2026 16:02 : « 40 jours collab, garde les mêmes 4 chiffres »). Aucune valeur secrète ici. Aucun PIN modifié.
--
-- Problème : la session ouverte par le PIN dure 12 h ; au-delà, l'ordinateur de Borhen repasse à l'écran du code et
-- Claude ne peut plus enregistrer les commandes Leboncoin sans lui.
-- Réponse : seul l'ADMINISTRATEUR, déjà connecté avec son code, peut déclarer l'appareil sur lequel il se trouve
-- « appareil de confiance » (Paramètres → Codes PIN). Cet appareil reçoit alors une session Collaboratrice de 40 jours.
-- Connaître le code Collaboratrice ne suffit donc PAS pour obtenir 40 jours (relecture du 05/11, point majeur).
-- Révocable comme les autres sessions : Déconnexion, changement du PIN collab, revoquer_sessions('collab').

alter table public.sessions_app add column if not exists confiance boolean not null default false;

create or replace function public.activer_appareil_confiance()
returns json language plpgsql volatile security definer set search_path = public, extensions, pg_catalog as $$
declare v_jeton text; v_hash text; v_exp timestamptz; v_ua text; h json; n int;
begin
  if not public._app_secret_ok() then return json_build_object('ok', false, 'erreur', 'non_autorise'); end if;
  if public.session_role() is distinct from 'admin' then return json_build_object('ok', false, 'erreur', 'session_admin_requise'); end if;
  perform pg_advisory_xact_lock(hashtext('maxiconfort-appareil-confiance'));
  begin h := current_setting('request.headers', true)::json; v_ua := left(h ->> 'user-agent', 180); exception when others then v_ua := null; end;
  v_jeton := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash := encode(extensions.digest(v_jeton, 'sha256'), 'hex');
  v_exp := clock_timestamp() + interval '40 days'; -- horloge réelle : départage les activations d'une même opération
  insert into public.sessions_app(jeton_hash, role, livreur, expire_at, appareil, confiance)
    values (v_hash, 'collab', null, v_exp, left('confiance-40j | ' || coalesce(v_ua, ''), 220), true);
  -- au plus 3 appareils de confiance actifs : les plus anciens sont révoqués
  update public.sessions_app set revoquee_at = now()
   where confiance and revoquee_at is null and expire_at > now() and jeton_hash <> v_hash
     and jeton_hash not in (select s.jeton_hash from public.sessions_app s
                             where s.confiance and s.revoquee_at is null and s.expire_at > now() and s.jeton_hash <> v_hash
                             order by s.expire_at desc limit 2);
  get diagnostics n = row_count;
  return json_build_object('ok', true, 'role', 'collab', 'jeton', v_jeton, 'expire_at', v_exp, 'confiance', true,
                           'anciens_revoques', n);
end $$;
revoke all on function public.activer_appareil_confiance() from public, anon, authenticated;
grant execute on function public.activer_appareil_confiance() to anon;
