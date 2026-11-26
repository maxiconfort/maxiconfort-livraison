// Banc de test RÉEL de la migration 038b (verrou du point de caisse validé sur les dépenses) sur une base PostgreSQL JETABLE,
// EN MÉMOIRE (@electric-sql/pglite = PostgreSQL 16 compilé en WebAssembly, rien n'est écrit sur le disque, aucune connexion).
// Usage : node outils/test-038b-pglite.js
// Prérequis : la dépendance de développement déclarée dans package.json (@electric-sql/pglite, version EXACTE 0.2.17) : npm install
//   (déclarée à partir de la PR 26 ; sur la branche de la PR 24 seule : npm install --no-save @electric-sql/pglite@0.2.17)
//   Sans ce paquet, ou avec une autre version, le banc ÉCHOUE (code 2). Pour le sauter VOLONTAIREMENT (machine sans dépendances) :
//   SAUTER_PGLITE=1 node outils/test-038b-pglite.js   (message « SAUTÉ », code 0 ; ne vaut jamais preuve que la 038b est testée).
// VALEURS FICTIVES uniquement (dépôt PUBLIC) : aucun livreur réel, aucun montant réel.
//
// Ce que fait le banc :
//   1. recrée le STRICT NÉCESSAIRE du schéma réel : rôles Supabase anon / authenticated / service_role, rôle propriétaire non
//      superutilisateur avec BYPASSRLS (comme « postgres » chez Supabase), schéma privé « interne », tables depenses et
//      caisse_remises avec la politique sess_admin de la migration 019, puis la migration 020 TELLE QUELLE (politiques du livreur) ;
//   2. applique TELLE QUELLE la migration 038b (son auto-contrôle s'exécute : une erreur annulerait la migration), puis une 2e fois ;
//   3. exécute pour de vrai, rôle par rôle, les écritures que fait l'application (POST = insert, merge-duplicates =
//      insert … on conflict do update, PATCH = update, DELETE = delete).
// LIMITES : pas de PostgREST (requêtes reproduites en SQL ; le rôle « anon » est posé par set role comme le fait PostgREST) ;
// session par paramètre de configuration au lieu des en-têtes x-app-secret / x-session-token ; types des colonnes historiques
// (créées avant les migrations du dépôt) supposés d'après les envois de l'application (sbSaveDepense, validerRemiseCaisse).
const fs = require('fs'), path = require('path');
const racine = path.join(__dirname, '..');
const VERSION_ATTENDUE = '0.2.17';

let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (e) {
  if (process.env.SAUTER_PGLITE === '1') { console.log('BANC 038b PGLITE SAUTÉ VOLONTAIREMENT (SAUTER_PGLITE=1) : la migration 038b n\'a PAS été testée.'); process.exit(0); }
  console.error('ÉCHEC DU BANC 038b PGLITE : dépendance @electric-sql/pglite absente — la migration 038b n\'a PAS été testée.');
  console.error('Installer les dépendances déclarées (package.json, devDependencies : @electric-sql/pglite ' + VERSION_ATTENDUE + ') : npm install');
  process.exit(2);
}
const lireMigration = (n) => fs.readFileSync(path.join(racine, 'supabase', 'migrations', n), 'utf8');
let ok = 0, ko = 0;
const test = (nom, cond, det) => { if (cond) { ok++; console.log('  OK   ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (det !== undefined ? ' — ' + JSON.stringify(det) : '')); } };

const SQL_ROLES = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role l24_postgres nologin bypassrls;
grant usage, create on schema public to l24_postgres;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role l24_postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role l24_postgres in schema public grant all on functions to anon, authenticated, service_role;
create schema interne authorization l24_postgres;   -- migration 019 : schéma privé, aucun droit d'usage pour anon
`;
// Exécuté par l24_postgres. BOUCHONS : session_role() / session_livreur() lisent un paramètre posé par le banc (en production :
// en-têtes + table sessions_app, migration 019) ; même signature, SECURITY DEFINER, exécution anon seulement.
const SQL_BASE = `
create or replace function public.session_role() returns text
language sql stable security definer set search_path = public, pg_catalog as $$ select nullif(current_setting('l24.session_role', true), '') $$;
create or replace function public.session_livreur() returns text
language sql stable security definer set search_path = public, pg_catalog as $$
  select case when nullif(current_setting('l24.session_role', true), '') = 'livreur' then upper(nullif(current_setting('l24.session_livreur', true), '')) end $$;
revoke all on function public.session_role(), public.session_livreur() from public, anon, authenticated;
grant execute on function public.session_role(), public.session_livreur() to anon;

create table public.depenses (
  id text primary key, date_depense text, cat text, montant numeric, livreur text, comment text, mode_paie text, tournee_id text,
  created_at timestamptz default now());
create table public.caisse_remises (
  id bigint generated always as identity primary key, key_remise text unique, livreur text, periode text, validee boolean,
  date_remise timestamptz, par text, especes_attendues numeric, especes_remises numeric, ecart numeric, cb_encaisse numeric, commentaire text);
do $$
declare t text;
begin
  foreach t in array array['depenses', 'caisse_remises'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy sess_admin on public.%I for all to anon using ((select public.session_role()) = ''admin'') with check ((select public.session_role()) = ''admin'')', t);
  end loop;
end $$;
-- migration 019 : politique livreur d'origine sur depenses (remplacée par la 020 appliquée telle quelle)
create policy sess_livreur on public.depenses for all to anon
  using ((select public.session_role()) = 'livreur' and upper(coalesce(livreur,'')) = (select public.session_livreur()))
  with check ((select public.session_role()) = 'livreur' and upper(coalesce(livreur,'')) = (select public.session_livreur()));
`;

(async () => {
  let pkg = { version: '?' };
  try { let d = path.dirname(require.resolve('@electric-sql/pglite'));
        while (!fs.existsSync(path.join(d, 'package.json')) && path.dirname(d) !== d) d = path.dirname(d);
        pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')); } catch (e) { /* version inconnue */ }
  if (pkg.version !== VERSION_ATTENDUE) {
    console.error('ÉCHEC DU BANC 038b PGLITE : @electric-sql/pglite ' + pkg.version + ' installé, version exigée ' + VERSION_ATTENDUE + ' — migration 038b NON testée.');
    process.exit(2);
  }
  const db = new PGlite();
  console.log('Base jetable en mémoire : ' + (await db.query('select version() as v')).rows[0].v.split(' on ')[0] + ' (@electric-sql/pglite ' + pkg.version + ')');

  // admin / livreur = navigateur (rôle anon) avec une session de ce rôle ; service_role = serveur (clé secrète) ;
  // proprio = l24_postgres par set role ; maintenance = connexion directe sans set role (éditeur SQL : rôle « none »).
  const ROLES_PG = { admin: 'anon', livreur: 'anon', autre: 'anon', anon: 'anon', authenticated: 'authenticated', service_role: 'service_role', proprio: 'l24_postgres', maintenance: null };
  async function contexte(qui) {
    await db.exec('reset role');
    const sess = ['admin', 'livreur', 'autre'].includes(qui) ? (qui === 'autre' ? 'livreur' : qui) : '';
    await db.query("select set_config('l24.session_role', $1, false), set_config('l24.session_livreur', $2, false)", [sess, qui === 'autre' ? 'AUTRE-TEST' : (sess === 'livreur' ? 'LIVREUR-TEST' : '')]);
    if (ROLES_PG[qui]) await db.exec('set role ' + ROLES_PG[qui]);
  }
  async function q(qui, sql, params) { await contexte(qui); try { return (await db.query(sql, params || [])).rows; } finally { await db.exec('reset role'); } }
  async function echec(qui, sql, params) { await contexte(qui); try { await db.query(sql, params || []); return null; } catch (e) { return String(e && e.message || e); } finally { await db.exec('reset role'); } }
  const dep = async (id) => (await q('maintenance', 'select id, mode_paie, montant::float8 as montant, tournee_id from public.depenses where id = $1', [id]))[0] || null;
  const AUJ = (await db.query("select to_char(current_date, 'YYYY-MM-DD') as d")).rows[0].d;
  const VERROU = /POINT_CAISSE_VALIDE/;
  const POST = "insert into public.depenses (id, date_depense, cat, montant, livreur, comment, mode_paie, tournee_id) values ($1, $2, 'Péage', $3, 'LIVREUR-TEST', '', 'Espèces', $4)";
  const UPSERT = POST + ' on conflict (id) do update set montant = excluded.montant, mode_paie = excluded.mode_paie, tournee_id = excluded.tournee_id';
  const valider = (tid) => q('admin', "insert into public.caisse_remises (key_remise, livreur, periode, validee, par) values ($1, 'LIVREUR-TEST', $2, true, 'admin')", ['t_' + tid, AUJ]);
  const annuler = (tid) => q('admin', 'delete from public.caisse_remises where key_remise = $1', ['t_' + tid]);

  // ===================================================================================================================
  console.log('\n1. SCHÉMA ET MIGRATIONS (020 telle quelle, puis 038b TELLE QUELLE, auto-contrôle compris)');
  await db.exec(SQL_ROLES);
  await db.exec('set role l24_postgres');
  await db.exec(SQL_BASE);
  let e020 = null; try { await db.exec(lireMigration('020_depenses_livreur_restreint.sql')); } catch (e) { e020 = e.message; }
  test('migration 020 appliquée telle quelle', e020 === null, e020);
  const sql038b = lireMigration('038b_depenses_verrou_caisse_validee.sql');
  let e1 = null; try { await db.exec(sql038b); } catch (e) { e1 = e.message; }
  test('migration 038b appliquée TELLE QUELLE (auto-contrôle de la section 4 passé)', e1 === null, e1);
  if (e1) { console.log('\nRÉSULTAT : arrêt, la migration 038b ne s\'applique pas.'); process.exit(1); }
  let e2 = null; try { await db.exec(sql038b); } catch (e) { e2 = e.message; }
  test('migration 038b rejouable une 2e fois sans erreur', e2 === null, e2);
  await db.exec('reset role');
  { // l'auto-contrôle s'exécute vraiment : une décision faussée le fait échouer
    const bloc = sql038b.slice(sql038b.indexOf('-- ── 4. Auto-contrôle'));
    await db.exec('set role l24_postgres; begin;');
    await db.exec("create or replace function interne.l038b_refus(p_role text, p_session_user text, p_validee boolean) returns boolean language sql immutable as $$ select false $$");
    let ea = null; try { await db.exec(bloc); } catch (e) { ea = e.message; }
    await db.exec('rollback; reset role;');
    test('auto-contrôle : une décision faussée (plus aucun refus) fait ÉCHOUER la migration', !!ea && /Auto-contrôle 038b/.test(ea), ea);
    await db.exec('set role l24_postgres; begin;');
    await db.exec('alter table public.depenses disable trigger depenses_verrou_caisse');
    let eb = null; try { await db.exec(bloc); } catch (e) { eb = e.message; }
    await db.exec('rollback; reset role;');
    test('auto-contrôle : déclencheur désactivé -> la migration ÉCHOUE', !!eb && /déclencheur depenses_verrou_caisse/.test(eb), eb);
  }
  test('anon ne peut pas appeler la fonction du déclencheur (schéma privé)', !!(await echec('anon', 'select interne.l038b_refus(\'anon\', \'x\', true)')));

  // ===================================================================================================================
  console.log('\n2. LE PROBLÈME : le livreur ne lit pas caisse_remises (politique sess_admin seulement)');
  await q('livreur', POST, ['d1', AUJ, 5, 'T-V']);
  await q('livreur', POST, ['d2', AUJ, 6, 'T-L']);
  await valider('T-V');
  test('admin : la remise de T-V est enregistrée et lisible', (await q('admin', 'select count(*)::int as n from public.caisse_remises')).at(0).n === 1);
  test('livreur : caisse_remises est VIDE pour lui (le contrôle de l\'appli ne peut rien voir)', (await q('livreur', 'select count(*)::int as n from public.caisse_remises')).at(0).n === 0);

  // ===================================================================================================================
  console.log('\n3. VERROU TENU PAR LA BASE (livreur)');
  let m = await echec('livreur', "update public.depenses set mode_paie = 'CB' where id = 'd1'");
  test('livreur : changement de mode (PATCH) d\'une dépense de la tournée VALIDÉE -> refusé (POINT_CAISSE_VALIDE)', VERROU.test(m || ''), m);
  test('… la dépense est intacte (Espèces)', (await dep('d1')).mode_paie === 'Espèces');
  m = await echec('livreur', POST, ['d3', AUJ, 7, 'T-V']);
  test('livreur : AJOUT d\'une dépense à la tournée validée (POST) -> refusé', VERROU.test(m || ''), m);
  test('… rien n\'est ajouté', (await dep('d3')) === null);
  m = await echec('livreur', UPSERT, ['d1', AUJ, 50, 'T-V']);
  test('livreur : upsert « merge-duplicates » sur la dépense validée -> refusé, montant inchangé', VERROU.test(m || '') && (await dep('d1')).montant === 5, m);
  m = await echec('livreur', "update public.depenses set tournee_id = 'T-V' where id = 'd2'");
  test('livreur : faire ENTRER une dépense dans la tournée validée -> refusé', VERROU.test(m || ''), m);
  m = await echec('livreur', "update public.depenses set tournee_id = 'T-L' where id = 'd1'");
  test('livreur : faire SORTIR une dépense de la tournée validée -> refusé', VERROU.test(m || '') && (await dep('d1')).tournee_id === 'T-V', m);
  m = await echec('livreur', "update public.depenses set mode_paie = 'CB' where id = 'd2'");
  test('livreur : dépense d\'une tournée NON validée -> modification acceptée', m === null && (await dep('d2')).mode_paie === 'CB', m);
  m = await echec('livreur', POST, ['d4', AUJ, 3, null]);
  test('livreur : dépense ancienne sans tournée (limite documentée) -> non concernée', m === null, m);
  await q('admin', "insert into public.caisse_remises (key_remise, livreur, periode, validee, par) values ('t_T-L', 'LIVREUR-TEST', $1, false, 'admin')", [AUJ]);
  m = await echec('livreur', "update public.depenses set montant = 6.5 where id = 'd2'");
  test('remise enregistrée mais NON validée (validee = false) -> modification acceptée', m === null, m);
  await q('admin', "delete from public.caisse_remises where key_remise = 't_T-L'");

  // ===================================================================================================================
  console.log('\n4. ADMINISTRATEUR : annuler la validation d\'abord');
  m = await echec('admin', "update public.depenses set montant = 9 where id = 'd1'");
  test('admin : correction pendant que le point de caisse est validé -> refusée', VERROU.test(m || ''), m);
  m = await echec('admin', "delete from public.depenses where id = 'd1'");
  test('admin : suppression pendant que le point de caisse est validé -> refusée, dépense présente', VERROU.test(m || '') && (await dep('d1')) !== null, m);
  test('le message dit quoi faire (annuler la validation)', /annuler la validation/.test((await (async () => { await contexte('admin'); try { await db.query("update public.depenses set montant = 9 where id = 'd1'"); return ''; } catch (e) { return String(e.hint || ''); } finally { await db.exec('reset role'); } })())));
  await annuler('T-V');
  m = await echec('admin', "update public.depenses set montant = 9 where id = 'd1'");
  test('admin : après ANNULATION de la validation, la correction passe', m === null && (await dep('d1')).montant === 9, m);
  m = await echec('livreur', "update public.depenses set mode_paie = 'CB' where id = 'd1'");
  test('livreur : après annulation, son changement de mode passe aussi', m === null, m);
  await valider('T-V');
  m = await echec('admin', "delete from public.depenses where id = 'd1'");
  test('nouvelle validation : de nouveau figée', VERROU.test(m || ''), m);

  // ===================================================================================================================
  console.log('\n5. EXCEPTIONS : serveur et maintenance');
  m = await echec('service_role', "update public.depenses set comment = 'correction serveur' where id = 'd1'");
  test('service_role (scripts serveur, clé secrète) : non bloqué', m === null, m);
  m = await echec('maintenance', "update public.depenses set comment = 'maintenance' where id = 'd1'");
  test('maintenance directe (éditeur SQL, sans set role) : non bloquée', m === null, m);
  m = await echec('authenticated', "update public.depenses set comment = 'x' where id = 'd1'");
  test('authenticated (outil LBC) : aucune ligne visible (RLS sans politique) -> aucune écriture', (await q('maintenance', "select comment from public.depenses where id = 'd1'"))[0].comment === 'maintenance');

  console.log('\n' + ok + ' OK, ' + ko + ' échec(s)');
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
