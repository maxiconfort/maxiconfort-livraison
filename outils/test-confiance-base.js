// Test RÉEL de l'« appareil de confiance » côté base (migration 036, 05/11/2026).
// Usage (PC de Borhen, après installation de la migration 036) : node outils/test-confiance-base.js
// Il lit le fichier .env local (jeton d'administration, jamais affiché). TOUT se passe dans UNE seule opération de la base
// qui est ANNULÉE à la fin (rollback) : aucune session, aucun essai, aucune ligne ne reste dans la base.
const fs = require('fs'), path = require('path');
const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8'); const val = k => (env.match(new RegExp(k + '\\s*=\\s*"?([^\\s"]+)')) || [])[1];
const PAT = val('SUPABASE_ACCESS_TOKEN');
const sql = async q => { const r = await fetch('https://api.supabase.com/v1/projects/jmvfjtnmebstkzcfnlgp/database/query', { method: 'POST', headers: { Authorization: 'Bearer ' + PAT, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) }); return { ok: r.ok, texte: await r.text() }; };

const BLOC = `do $$
declare
  secret text := (select valeur from public.secrets_serveur where cle = 'app_secret_courant');
  ta text := encode(extensions.gen_random_bytes(32), 'hex');
  tc text := encode(extensions.gen_random_bytes(32), 'hex');
  r json; r1 json; s record; res text := ''; n int;
begin
  insert into public.sessions_app (jeton_hash, role, livreur, expire_at, appareil) values
    (encode(extensions.digest(ta, 'sha256'), 'hex'), 'admin', null, now() + interval '5 minutes', 'test-automatique'),
    (encode(extensions.digest(tc, 'sha256'), 'hex'), 'collab', null, now() + interval '5 minutes', 'test-automatique');

  -- 1. sans APP_SECRET
  perform set_config('request.headers', '{}', true);
  r := public.activer_appareil_confiance();
  res := res || case when r ->> 'erreur' = 'non_autorise' then 'OK' else 'KO' end || '|sans APP_SECRET : refusé|' || r::text || E'\\n';
  -- 2. APP_SECRET sans session
  perform set_config('request.headers', json_build_object('x-app-secret', secret)::text, true);
  r := public.activer_appareil_confiance();
  res := res || case when r ->> 'erreur' = 'session_admin_requise' then 'OK' else 'KO' end || '|sans session : refusé|' || r::text || E'\\n';
  -- 3. session COLLAB (connaître le code collab ne suffit pas)
  perform set_config('request.headers', json_build_object('x-app-secret', secret, 'x-session-token', tc)::text, true);
  r := public.activer_appareil_confiance();
  res := res || case when r ->> 'erreur' = 'session_admin_requise' then 'OK' else 'KO' end || '|session collab : refusé|' || r::text || E'\\n';
  -- 4. session ADMIN : accepté
  perform set_config('request.headers', json_build_object('x-app-secret', secret, 'x-session-token', ta)::text, true);
  r1 := public.activer_appareil_confiance();
  select role, confiance, expire_at, revoquee_at into s from public.sessions_app where jeton_hash = encode(extensions.digest(r1 ->> 'jeton', 'sha256'), 'hex');
  res := res || case when (r1 ->> 'ok')::boolean and s.role = 'collab' and s.confiance and s.revoquee_at is null then 'OK' else 'KO' end || '|admin : session collab de confiance créée|' || coalesce(s.role, '?') || E'\\n';
  res := res || case when s.expire_at between now() + interval '39 days 23 hours' and now() + interval '40 days 1 minute' then 'OK' else 'KO' end || '|expire dans 40 jours|' || s.expire_at::text || E'\\n';
  select revoquee_at into s from public.sessions_app where jeton_hash = encode(extensions.digest(ta, 'sha256'), 'hex');
  res := res || case when s.revoquee_at is not null then 'OK' else 'KO' end || '|la session admin de l''appareil est fermée par le serveur|' || E'\\n';
  -- reprise des essais suivants avec une nouvelle session admin
  ta := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.sessions_app (jeton_hash, role, livreur, expire_at, appareil) values (encode(extensions.digest(ta, 'sha256'), 'hex'), 'admin', null, now() + interval '5 minutes', 'test-automatique');
  -- 5. le nouveau jeton est reconnu comme Collaboratrice (jamais admin)
  perform set_config('request.headers', json_build_object('x-app-secret', secret, 'x-session-token', r1 ->> 'jeton')::text, true);
  res := res || case when public.session_role() = 'collab' then 'OK' else 'KO' end || '|le jeton ouvre le rôle collab|' || coalesce(public.session_role(), 'null') || E'\\n';
  r := public.activer_appareil_confiance();
  res := res || case when r ->> 'erreur' = 'session_admin_requise' then 'OK' else 'KO' end || '|un appareil de confiance ne peut pas en créer un autre|' || r::text || E'\\n';
  r := public.verifier_session(r1 ->> 'jeton');
  res := res || case when (r ->> 'ok')::boolean and r ->> 'role' = 'collab' and (r ->> 'confiance')::boolean then 'OK' else 'KO' end || '|verifier_session répond collab + confiance (reprise à l''ouverture)|' || r::text || E'\\n';
  r := public.verifier_session(tc);
  res := res || case when (r ->> 'ok')::boolean and (r ->> 'confiance')::boolean = false then 'OK' else 'KO' end || '|session collab ordinaire : confiance = faux|' || r::text || E'\\n';
  -- 6. au plus 3 appareils : 3 activations de plus, la 1re est révoquée
  for i in 1..3 loop -- chaque activation ferme la session admin appelante : une nouvelle session admin à chaque fois
    ta := encode(extensions.gen_random_bytes(32), 'hex');
    insert into public.sessions_app (jeton_hash, role, livreur, expire_at, appareil) values (encode(extensions.digest(ta, 'sha256'), 'hex'), 'admin', null, now() + interval '5 minutes', 'test-automatique');
    perform set_config('request.headers', json_build_object('x-app-secret', secret, 'x-session-token', ta)::text, true);
    perform public.activer_appareil_confiance();
  end loop;
  select count(*) into n from public.sessions_app where confiance and revoquee_at is null and expire_at > now();
  res := res || case when n = 3 then 'OK' else 'KO' end || '|3 appareils de confiance actifs au plus|' || n || E'\\n';
  select revoquee_at into s from public.sessions_app where jeton_hash = encode(extensions.digest(r1 ->> 'jeton', 'sha256'), 'hex');
  res := res || case when s.revoquee_at is not null then 'OK' else 'KO' end || '|le plus ancien est révoqué|' || E'\\n';
  -- 7. changer le PIN collab coupe les appareils de confiance (on simule l'effet : révocation du rôle collab)
  update public.sessions_app set revoquee_at = now() where role = 'collab' and revoquee_at is null;
  select count(*) into n from public.sessions_app where confiance and revoquee_at is null;
  res := res || case when n = 0 then 'OK' else 'KO' end || '|révocation du rôle collab = plus aucun appareil de confiance|' || n || E'\\n';
  -- 8. les connexions par code ne sont jamais « confiance »
  select count(*) into n from public.sessions_app where confiance and role <> 'collab';
  res := res || case when n = 0 then 'OK' else 'KO' end || '|aucune session de confiance hors collab|' || n || E'\\n';

  raise exception 'RESULTATS_CONFIANCE%', E'\\n' || res; -- annule TOUT
end $$`;

(async () => {
  const r = await sql(BLOC);
  const m = r.texte.replace(/\\n/g, '\n').match(/RESULTATS_CONFIANCE([\s\S]*?)(?:"|$)/);
  if (!m) { console.log('Réponse inattendue de la base (migration 036 installée ?) :\n' + r.texte.slice(0, 600)); process.exit(1); }
  let ok = 0, ko = 0;
  for (const ligne of m[1].split('\n').filter(l => /^(OK|KO)\|/.test(l))) {
    const [etat, nom, det] = ligne.split('|');
    if (etat === 'OK') { ok++; console.log('  OK    ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + ' — ' + (det || '').slice(0, 200)); }
  }
  console.log('\n' + ok + ' OK, ' + ko + ' échec(s) — tout a été annulé dans la base (rien n\'est resté).');
  process.exit(ko || ok < 14 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
