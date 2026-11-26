// Banc de test RÉEL de la migration 038b (verrou du point de caisse validé sur les dépenses) sur une base PostgreSQL JETABLE,
// EN MÉMOIRE (@electric-sql/pglite = PostgreSQL 16 compilé en WebAssembly, rien n'est écrit sur le disque, aucune connexion).
// Usage : node outils/test-038b-pglite.js
// Prérequis : @electric-sql/pglite, version EXACTE 0.2.17, installée à part dans cette branche (aucun téléchargement fait par le banc) :
//   npm install --no-save @electric-sql/pglite@0.2.17   (ou NODE_PATH vers un dossier qui l'a déjà ; la PR 26 la déclare dans package.json)
//   Sans ce paquet, ou avec une autre version, le banc ÉCHOUE (code 2). Pour le sauter VOLONTAIREMENT (machine sans dépendances) :
//   SAUTER_PGLITE=1 node outils/test-038b-pglite.js   (message « SAUTÉ », code 0 ; ne vaut jamais preuve que la 038b est testée).
// VALEURS FICTIVES uniquement (dépôt PUBLIC) : aucun livreur réel, aucun montant réel.
//
// Ce que fait le banc :
//   1. recrée le STRICT NÉCESSAIRE du schéma réel : rôles Supabase anon / authenticated / service_role, rôle propriétaire non
//      superutilisateur avec BYPASSRLS (comme « postgres » chez Supabase), schéma privé « interne », tables depenses, tournees et
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
  console.error('Installer à part : npm install --no-save @electric-sql/pglite@' + VERSION_ATTENDUE + ' (ou NODE_PATH vers un dossier qui l\'a déjà)');
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
create table public.tournees (id text primary key, livreur text, date_tournee text, statut text, stops jsonb, updated_at timestamptz);
do $$
declare t text;
begin
  foreach t in array array['depenses', 'caisse_remises', 'tournees'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy sess_admin on public.%I for all to anon using ((select public.session_role()) = ''admin'') with check ((select public.session_role()) = ''admin'')', t);
  end loop;
end $$;
-- migration 019 : politique livreur sur tournees (dates J-2 / J+2 omises : sans effet sur le verrou)
create policy sess_livreur on public.tournees for all to anon
  using ((select public.session_role()) = 'livreur' and upper(coalesce(livreur,'')) = (select public.session_livreur()))
  with check ((select public.session_role()) = 'livreur' and upper(coalesce(livreur,'')) = (select public.session_livreur()));
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
    for (const [table, trig] of [['tournees', 'tournees_verrou_caisse'], ['caisse_remises', 'caisse_remises_verrou_caisse']]) {
      await db.exec('set role l24_postgres; begin;');
      await db.exec('alter table public.' + table + ' disable trigger ' + trig);
      let ec = null; try { await db.exec(bloc); } catch (e) { ec = e.message; }
      await db.exec('rollback; reset role;');
      test('auto-contrôle : déclencheur ' + trig + ' désactivé -> la migration ÉCHOUE', !!ec && new RegExp('déclencheur ' + trig).test(ec), ec);
    }
    await db.exec('set role l24_postgres; begin;');
    await db.exec('grant execute on function interne.l038b_premiere(text, text, text, text) to anon');
    let ed = null; try { await db.exec(bloc); } catch (e) { ed = e.message; }
    await db.exec('rollback; reset role;');
    test('auto-contrôle : une fonction interne du verrou ouverte à anon -> la migration ÉCHOUE', !!ed && /exécutable par anon/.test(ed), ed);
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
  test('livreur : dépense sans tournée, aucune tournée du livreur ce jour-là -> acceptée (rien à verrouiller)', m === null, m);
  await q('admin', "insert into public.caisse_remises (key_remise, livreur, periode, validee, par) values ('t_T-L', 'LIVREUR-TEST', $1, false, 'admin')", [AUJ]);
  m = await echec('livreur', "update public.depenses set montant = 6.5 where id = 'd2'");
  test('remise enregistrée mais NON validée (validee = false) -> modification acceptée', m === null, m);
  await q('admin', "delete from public.caisse_remises where key_remise = 't_T-L'");

  // ===================================================================================================================
  console.log('\n3 bis. DÉPENSE SANS tournee_id : rattachée comme dans l\'appli (première tournée du livreur ce jour-là) — revue Codex sur 26dcf5b');
  // dates à venir : la politique 020 ne laisse au livreur que ses dépenses de la veille et après
  const { j1: J1, j2: J2 } = (await db.query("select to_char(current_date + 1, 'YYYY-MM-DD') as j1, to_char(current_date + 2, 'YYYY-MM-DD') as j2")).rows[0];
  // deux tournées le même jour : la PREMIÈRE (ordre des identifiants : T-A < T-B) reçoit la dépense sans tournée
  await q('maintenance', "insert into public.tournees (id, livreur, date_tournee, statut) values ('T-B', 'LIVREUR-TEST', $1, 'terminée'), ('T-A', 'livreur-test', $1, 'terminée'), ('T-Z', 'LIVREUR-TEST', $2, 'terminée'), ('T-O', 'AUTRE-TEST', $2, 'terminée')", [J1, J2]);
  // ANCIENNES dépenses sans tournee_id (écrites avant la 038b) : déclencheur suspendu le temps de les créer
  await q('maintenance', 'alter table public.depenses disable trigger depenses_verrou_caisse');
  await q('maintenance', "insert into public.depenses (id, date_depense, cat, montant, livreur, comment, mode_paie, tournee_id) values ('s1', $1, 'Péage', 5, 'LIVREUR-TEST', '', 'Espèces', null), ('s2', $2, 'Péage', 4, 'LIVREUR-TEST', '', 'Espèces', null)", [J1, J2]);
  await q('maintenance', 'alter table public.depenses enable trigger depenses_verrou_caisse');
  { let er = null; try { await db.exec('set role l24_postgres'); await db.exec(sql038b); } catch (e) { er = e.message; } finally { await db.exec('reset role'); }
    test('ancienne dépense sans tournee_id : la migration rejouée ne réécrit RIEN (tournee_id reste vide)', er === null && (await dep('s1')).tournee_id === null && (await dep('s2')).tournee_id === null, er); }
  await valider('T-A');
  m = await echec('livreur', "update public.depenses set mode_paie = 'CB' where id = 's1'");
  test('sans tournee_id, date de T-A (validée, 1re du jour, livreur écrit en minuscules) : changement de mode refusé', VERROU.test(m || '') && (await dep('s1')).mode_paie === 'Espèces', m);
  m = await echec('admin', "delete from public.depenses where id = 's1'");
  test('sans tournee_id : suppression par l\'admin refusée tant que T-A est validée', VERROU.test(m || '') && (await dep('s1')) !== null, m);
  m = await echec('livreur', "insert into public.depenses (id, date_depense, cat, montant, livreur, comment, mode_paie, tournee_id) values ('s3', $1, 'Parking', 2, 'LIVREUR-TEST', '', 'Espèces', null)", [J1]);
  test('sans tournee_id : AJOUT d\'une nouvelle dépense à la date de T-A validée -> refusé', VERROU.test(m || '') && (await dep('s3')) === null, m);
  m = await echec('livreur', "update public.depenses set date_depense = $1 where id = 's2'", [J1]);
  test('sans tournee_id : changer la DATE pour entrer dans la tournée validée -> refusé', VERROU.test(m || '') && (await dep('s2')) !== null, m);
  m = await echec('livreur', "update public.depenses set date_depense = $1 where id = 's1'", [J2]);
  test('sans tournee_id : changer la DATE pour sortir de la tournée validée -> refusé', VERROU.test(m || ''), m);
  await annuler('T-A'); await valider('T-B');
  m = await echec('livreur', "update public.depenses set montant = 6 where id = 's1'");
  test('seule T-B (2e du jour) validée : la dépense sans tournée appartient à T-A -> modifiable (même règle que l\'appli)', m === null && (await dep('s1')).montant === 6, m);
  await annuler('T-B');
  await q('admin', "insert into public.caisse_remises (key_remise, livreur, periode, validee, par) values ('t_T-O', 'AUTRE-TEST', $1, true, 'admin')", [J2]);
  m = await echec('livreur', "update public.depenses set montant = 5 where id = 's2'");
  test('tournée validée d\'un AUTRE livreur le même jour -> sans effet sur la dépense', m === null, m);
  await valider('T-Z');
  m = await echec('livreur', "update public.depenses set montant = 9, tournee_id = 'T-NV' where id = 's2'");
  test('sans tournee_id -> tournée renseignée NON validée : l\'état d\'avant (T-Z validée) bloque quand même', VERROU.test(m || ''), m);
  await annuler('T-Z');
  test('ancienne dépense : FIGÉE à sa première écriture acceptée (s1 -> T-A, s2 -> T-Z : la tournée que l\'appli lui attribuait)', (await dep('s1')).tournee_id === 'T-A' && (await dep('s2')).tournee_id === 'T-Z', [await dep('s1'), await dep('s2')]);

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

  // ===================================================================================================================
  console.log('\n6. CONTRÔLE DOUX DE L\'APPLI : public.verrou_caisse_actif()');
  test('appli (anon) : verrou_caisse_actif() = vrai une fois la 038b appliquée', (await q('livreur', 'select public.verrou_caisse_actif() as v'))[0].v === true);
  await db.exec('set role l24_postgres; begin;');
  await db.exec('alter table public.depenses disable trigger depenses_verrou_caisse');
  test('déclencheur désactivé -> verrou_caisse_actif() = faux (l\'appli le signale à l\'admin)', (await db.query('select public.verrou_caisse_actif() as v')).rows[0].v === false);
  await db.exec('rollback; reset role;');
  test('anon ne peut pas appeler interne.l038b_tournee_attribuee', !!(await echec('anon', "select interne.l038b_tournee_attribuee(null, 'x', 'y')")));
  for (const [table, trig] of [['tournees', 'tournees_verrou_caisse'], ['caisse_remises', 'caisse_remises_verrou_caisse']]) {
    await db.exec('set role l24_postgres; begin;');
    await db.exec('alter table public.' + table + ' disable trigger ' + trig);
    test('déclencheur ' + trig + ' désactivé -> verrou_caisse_actif() = faux', (await db.query('select public.verrou_caisse_actif() as v')).rows[0].v === false);
    await db.exec('rollback; reset role;');
  }
  for (const f of ["interne.l038b_cle('x')", "interne.l038b_verrouiller(array['x'])", "interne.l038b_validee('x')", "interne.l038b_premiere('x', 'y', null, null)", "interne.l038b_sans_tournee('x', 'y')"]) {
    test('anon ne peut pas appeler ' + f.split('(')[0], !!(await echec('anon', 'select ' + f)));
  }

  // ===================================================================================================================
  console.log('\n7. RATTACHEMENT FIGÉ À L\'ÉCRITURE (revue Codex PR 24 sur 639f2f5, point 1)');
  const JX = (await db.query("select to_char(current_date + 3, 'YYYY-MM-DD') as j3, to_char(current_date + 4, 'YYYY-MM-DD') as j4, to_char(current_date + 5, 'YYYY-MM-DD') as j5, to_char(current_date + 6, 'YYYY-MM-DD') as j6, to_char(current_date + 7, 'YYYY-MM-DD') as j7, to_char(current_date + 8, 'YYYY-MM-DD') as j8")).rows[0];
  const [J3, J4, J5, J6, J7, J8] = [JX.j3, JX.j4, JX.j5, JX.j6, JX.j7, JX.j8];
  await q('maintenance', "insert into public.tournees (id, livreur, date_tournee, statut) values ('T-C', 'LIVREUR-TEST', $1, 'en cours'), ('T-D', 'LIVREUR-TEST', $2, 'en cours')", [J3, J4]);
  m = await echec('livreur', POST, ['f1', J3, 5, null]);
  test('ajout SANS tournee_id : la base renseigne tournee_id = T-C (première tournée du livreur ce jour-là)', m === null && (await dep('f1')).tournee_id === 'T-C', [m, await dep('f1')]);
  m = await echec('livreur', POST, ['f2', J8, 5, null]);
  test('ajout sans tournee_id un jour SANS tournée : tournee_id reste vide (rien à figer)', m === null && (await dep('f2')).tournee_id === null, m);
  await q('maintenance', "insert into public.tournees (id, livreur, date_tournee, statut) values ('T-0C', 'LIVREUR-TEST', $1, 'en cours')", [J3]);
  test('nouvelle tournée T-0C (triée AVANT T-C) le même jour : la dépense reste sur T-C (plus de rattachement implicite)', (await dep('f1')).tournee_id === 'T-C');
  await valider('T-0C');
  m = await echec('livreur', "update public.depenses set mode_paie = 'CB' where id = 'f1'");
  test('… T-0C validée : la dépense figée sur T-C (non validée) reste modifiable, sans être « volée » par T-0C', m === null && (await dep('f1')).tournee_id === 'T-C', m);
  await annuler('T-0C');
  m = await echec('livreur', UPSERT, ['f1', J3, 6, null]);
  test('copie ancienne d\'un téléphone (upsert, tournee_id vide, même date et livreur) : rattachement figé GARDÉ (T-C)', m === null && (await dep('f1')).tournee_id === 'T-C' && (await dep('f1')).montant === 6, [m, await dep('f1')]);
  m = await echec('livreur', "update public.depenses set tournee_id = null, montant = 7 where id = 'f1'");
  test('PATCH avec tournee_id vide, même date et livreur : rattachement figé GARDÉ', m === null && (await dep('f1')).tournee_id === 'T-C', m);
  m = await echec('admin', "update public.depenses set tournee_id = null, date_depense = $1 where id = 'f1'", [J4]);
  test('changement de DATE envoyé avec tournee_id vide (ce que fait l\'appli) : rattachement recalculé -> T-D', m === null && (await dep('f1')).tournee_id === 'T-D', [m, await dep('f1')]);
  await valider('T-D');
  m = await echec('admin', "update public.depenses set tournee_id = null, date_depense = $1 where id = 'f1'", [J3]);
  test('… T-D validée : en SORTIR par un changement de date -> refusé, dépense toujours sur T-D', VERROU.test(m || '') && (await dep('f1')).tournee_id === 'T-D', m);
  m = await echec('livreur', POST, ['f3', J4, 2, null]);
  test('ajout sans tournee_id à la date de T-D validée -> refusé (rattachement calculé PUIS contrôlé)', VERROU.test(m || '') && (await dep('f3')) === null, m);
  await annuler('T-D');

  // ===================================================================================================================
  console.log('\n8. TOURNÉES : une tournée validée et les anciennes dépenses sans tournée restent en place (point 1)');
  await q('maintenance', "insert into public.tournees (id, livreur, date_tournee, statut, stops) values ('T-P', 'LIVREUR-TEST', $1, 'terminée', '[]')", [J5]);
  await valider('T-P');
  const tour = async (id) => (await q('maintenance', 'select id, livreur, date_tournee, statut from public.tournees where id = $1', [id]))[0] || null;
  m = await echec('admin', "delete from public.tournees where id = 'T-P'");
  test('admin : SUPPRIMER une tournée dont le point de caisse est validé -> refusé, tournée présente', VERROU.test(m || '') && (await tour('T-P')) !== null, m);
  m = await echec('admin', "update public.tournees set livreur = 'AUTRE-TEST' where id = 'T-P'");
  test('admin : changer le LIVREUR d\'une tournée validée -> refusé', VERROU.test(m || '') && (await tour('T-P')).livreur === 'LIVREUR-TEST', m);
  m = await echec('admin', "update public.tournees set date_tournee = $1 where id = 'T-P'", [J7]);
  test('admin : changer la DATE d\'une tournée validée -> refusé', VERROU.test(m || '') && (await tour('T-P')).date_tournee === J5, m);
  m = await echec('admin', "update public.tournees set id = 'T-P2' where id = 'T-P'");
  test('admin : changer l\'IDENTIFIANT d\'une tournée validée -> refusé', VERROU.test(m || '') && (await tour('T-P')) !== null, m);
  m = await echec('livreur', "insert into public.tournees (id, livreur, date_tournee, statut, stops, updated_at) values ('T-P', 'LIVREUR-TEST', $1, 'terminée', '[{\"etape\":1}]', now()) on conflict (id) do update set livreur = excluded.livreur, date_tournee = excluded.date_tournee, statut = excluded.statut, stops = excluded.stops, updated_at = excluded.updated_at", [J5]);
  test('livreur : sauvegarde ordinaire (upsert sbSaveTournee : statut, arrêts) d\'une tournée validée -> acceptée', m === null, m);
  m = await echec('livreur', "insert into public.tournees (id, livreur, date_tournee, statut) values ('T-P', 'LIVREUR-TEST', $1, 'terminée') on conflict (id) do update set date_tournee = excluded.date_tournee", [J7]);
  test('livreur : upsert qui change la DATE d\'une tournée validée -> refusé', VERROU.test(m || '') && (await tour('T-P')).date_tournee === J5, m);
  m = await echec('service_role', "update public.tournees set date_tournee = $1 where id = 'T-P'", [J7]);
  test('service_role (serveur) : non bloqué', m === null && (await tour('T-P')).date_tournee === J7, m);
  await q('service_role', "update public.tournees set date_tournee = $1 where id = 'T-P'", [J5]);
  await annuler('T-P');
  m = await echec('admin', "update public.tournees set date_tournee = $1 where id = 'T-P'", [J7]);
  test('validation ANNULÉE : le changement de date passe', m === null && (await tour('T-P')).date_tournee === J7, m);
  m = await echec('admin', "delete from public.tournees where id = 'T-P'");
  test('validation annulée : la suppression passe', m === null && (await tour('T-P')) === null, m);
  // ancienne dépense sans tournée (avant la 038b), rattachée par la date
  await q('maintenance', "insert into public.tournees (id, livreur, date_tournee, statut) values ('T-M', 'LIVREUR-TEST', $1, 'terminée')", [J6]);
  await q('maintenance', 'alter table public.depenses disable trigger depenses_verrou_caisse');
  await q('maintenance', "insert into public.depenses (id, date_depense, cat, montant, livreur, comment, mode_paie, tournee_id) values ('a1', $1, 'Péage', 8, 'livreur-test', '', 'Espèces', null)", [J6]);
  await q('maintenance', 'alter table public.depenses enable trigger depenses_verrou_caisse');
  await valider('T-M');
  m = await echec('admin', "insert into public.tournees (id, livreur, date_tournee, statut) values ('T-0M', 'LIVREUR-TEST', $1, 'en cours')", [J6]);
  test('ancienne dépense rattachée à T-M VALIDÉE : AJOUTER une tournée T-0M (triée avant) ce jour-là -> refusé (elle « volerait » la dépense)', VERROU.test(m || '') && (await tour('T-0M')) === null, m);
  m = await echec('admin', "insert into public.tournees (id, livreur, date_tournee, statut) values ('T-Y', 'LIVREUR-TEST', $1, 'en cours')", [J6]);
  test('… ajouter une tournée T-Y (triée APRÈS T-M) -> acceptée (rattachement inchangé)', m === null, m);
  m = await echec('admin', "update public.tournees set date_tournee = $1 where id = 'T-Y'", [J7]);
  test('… déplacer T-Y (non validée, pas la première) -> accepté', m === null, m);
  await annuler('T-M');
  m = await echec('admin', "insert into public.tournees (id, livreur, date_tournee, statut) values ('T-H', 'LIVREUR-TEST', $1, 'en cours')", [J6]);
  test('aucune validation : ajouter T-H (triée avant T-M) -> accepté (l\'ancienne dépense passe à T-H, rien de validé)', m === null, m);
  await valider('T-M');
  m = await echec('admin', "delete from public.tournees where id = 'T-H'");
  test('T-M validée : SUPPRIMER T-H (non validée) ferait passer l\'ancienne dépense dans T-M -> refusé', VERROU.test(m || '') && (await tour('T-H')) !== null, m);
  m = await echec('admin', "update public.tournees set date_tournee = $1 where id = 'T-H'", [J7]);
  test('… changer la DATE de T-H -> refusé', VERROU.test(m || ''), m);
  m = await echec('admin', "update public.tournees set livreur = 'AUTRE-TEST' where id = 'T-H'");
  test('… changer le LIVREUR de T-H -> refusé', VERROU.test(m || ''), m);
  m = await echec('livreur', "update public.tournees set statut = 'terminée' where id = 'T-H'");
  test('… mise à jour ordinaire de T-H (statut) -> acceptée', m === null, m);
  m = await echec('service_role', "delete from public.tournees where id = 'T-H'");
  test('service_role (serveur) : non bloqué (T-H supprimée)', m === null && (await tour('T-H')) === null, m);
  test('l\'écriture des tournées ne réécrit pas l\'ancienne dépense (tournee_id toujours vide)', (await dep('a1')).tournee_id === null);
  await annuler('T-M');

  // ===================================================================================================================
  console.log('\n9. SÉRIALISATION (revue Codex PR 24 sur 639f2f5, point 2) : MÊME verrou consultatif pour les trois chemins');
  console.log('   LIMITE : pglite = UNE seule connexion. Deux transactions réellement simultanées ne sont pas reproductibles ici ;');
  console.log('   le banc vérifie que chaque chemin prend, dans sa transaction, la MÊME clé de verrou pour la même tournée.');
  const cle = async (tid) => (await q('maintenance', 'select interne.l038b_cle($1)::text as k', [tid]))[0].k;
  async function verrousPris(qui, sql, params) {
    await contexte(qui); await db.exec('begin');
    let err = null; try { await db.query(sql, params || []); } catch (e) { err = e.message; }
    let cles = [];
    if (!err) cles = (await db.query("select ((classid::bigint << 32) | objid::bigint)::text as k from pg_locks where locktype = 'advisory' and objsubid = 1 and granted")).rows.map((r) => r.k);
    await db.exec('rollback'); await db.exec('reset role');
    return { err, cles };
  }
  const kTL = await cle('T-L'), kTV = await cle('T-V'), kTA = await cle('T-A');
  test('clés distinctes pour deux tournées (T-L ≠ T-V), stables d\'un appel à l\'autre', kTL !== kTV && kTL === (await cle('T-L')));
  let v = await verrousPris('livreur', POST, ['k1', AUJ, 1, 'T-L']);
  test('dépense (ajout, livreur) : verrou de T-L pris', !v.err && v.cles.includes(kTL), v);
  v = await verrousPris('admin', "insert into public.caisse_remises (key_remise, livreur, periode, validee, par) values ('t_T-L', 'LIVREUR-TEST', 'x', true, 'admin') on conflict (key_remise) do update set validee = excluded.validee");
  test('VALIDATION de la remise t_T-L (upsert, admin) : MÊME verrou (T-L)', !v.err && v.cles.includes(kTL), v);
  v = await verrousPris('admin', "delete from public.caisse_remises where key_remise = 't_T-V'");
  test('ANNULATION de la remise t_T-V (admin) : verrou de T-V pris', !v.err && v.cles.includes(kTV), v);
  v = await verrousPris('service_role', "update public.depenses set comment = 'k' where id = 'd1'");
  test('dépense de T-V (modification, même par le serveur) : MÊME verrou (T-V)', !v.err && v.cles.includes(kTV), v);
  v = await verrousPris('admin', "update public.tournees set statut = 'terminée' where id = 'T-A'");
  test('tournée T-A (modification) : MÊME verrou (T-A)', !v.err && v.cles.includes(kTA), v);
  v = await verrousPris('maintenance', "update public.caisse_remises set commentaire = 'k' where key_remise = 't_T-V'");
  test('verrou rendu à la fin de la transaction (plus aucun verrou consultatif ensuite)', (await db.query("select count(*)::int as n from pg_locks where locktype = 'advisory'")).rows[0].n === 0);
  test('séquentiel : la remise validée puis la dépense écrite dans la MÊME transaction -> la dépense voit la validation (refusée)', await (async () => {
    await contexte('admin'); await db.exec('begin');
    let e = null; try { await db.query("insert into public.caisse_remises (key_remise, livreur, periode, validee, par) values ('t_T-L', 'LIVREUR-TEST', 'x', true, 'admin')"); await db.query(POST, ['k2', AUJ, 1, 'T-L']); } catch (x) { e = x.message; }
    await db.exec('rollback'); await db.exec('reset role'); return VERROU.test(e || '');
  })());

  console.log('\n' + ok + ' OK, ' + ko + ' échec(s)');
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
