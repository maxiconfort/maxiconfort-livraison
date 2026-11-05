-- 036 — Session « appareil de confiance » pour le rôle Collaboratrice (GO Borhen 05/11/2026 16:02 : « 40 jours collab,
-- garde les mêmes 4 chiffres »). Aucune valeur secrète ici. Le PIN Collaboratrice ne change pas.
--
-- Problème : la session ouverte par le PIN dure 12 h ; au-delà, l'ordinateur de Borhen repasse à l'écran du code et
-- Claude ne peut plus enregistrer les commandes Leboncoin sans lui.
-- Réponse : une case « Rester connecté sur cet ordinateur (40 jours) », réservée au rôle collab (pas admin, pas livreur).
-- Toutes les protections existantes sont réutilisées telles quelles, parce qu'on APPELLE connexion_pin (même vérification
-- du PIN, mêmes limites d'essais, même jeton) puis on allonge seulement l'expiration de CETTE session.
-- Révocable comme les autres : bouton Déconnexion, changement du PIN collab, revoquer_sessions('collab').

create or replace function public.connexion_pin_confiance(p_pin text)
returns json language plpgsql volatile security definer set search_path = public, extensions, pg_catalog as $$
declare r json; v_exp timestamptz; v_hash text;
begin
  r := public.connexion_pin('collab', p_pin, null);
  if coalesce((r ->> 'ok')::boolean, false) is not true then return r; end if;
  v_hash := encode(extensions.digest(r ->> 'jeton', 'sha256'), 'hex');
  v_exp := now() + interval '40 days';
  update public.sessions_app
     set expire_at = v_exp, appareil = left('confiance-40j | ' || coalesce(appareil, ''), 220)
   where jeton_hash = v_hash and role = 'collab' and revoquee_at is null;
  if not found then return json_build_object('ok', false, 'erreur', 'session_introuvable'); end if;
  -- au plus 3 appareils de confiance actifs : les plus anciens sont révoqués
  update public.sessions_app set revoquee_at = now()
   where role = 'collab' and revoquee_at is null and appareil like 'confiance-40j |%' and jeton_hash <> v_hash
     and jeton_hash not in (select jeton_hash from public.sessions_app
                             where role = 'collab' and revoquee_at is null and appareil like 'confiance-40j |%'
                               and jeton_hash <> v_hash
                             order by expire_at desc limit 2);
  return json_build_object('ok', true, 'role', 'collab', 'jeton', r ->> 'jeton', 'expire_at', v_exp, 'confiance', true);
end $$;
revoke all on function public.connexion_pin_confiance(text) from public, anon, authenticated;
grant execute on function public.connexion_pin_confiance(text) to anon;
