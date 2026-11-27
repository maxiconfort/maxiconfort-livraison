// Banc de test RÉEL de la migration 040 (déduction du stock d'une livraison PAR LA BASE, une seule fois par commande) sur une
// base PostgreSQL JETABLE, EN MÉMOIRE (@electric-sql/pglite = PostgreSQL 16 compilé en WebAssembly : rien n'est écrit sur le
// disque, aucune connexion à la vraie base).
// Usage : node outils/test-040-pglite.js
// Prérequis : @electric-sql/pglite, version EXACTE 0.2.17 (même dépendance de développement que les bancs 038b et 039 de la
//   PR 24 / PR 26, package.json) : npm install. Sans ce paquet, ou avec une autre version, le banc ÉCHOUE (code 2). Pour le
//   sauter VOLONTAIREMENT : SAUTER_PGLITE=1 node outils/test-040-pglite.js (« SAUTÉ », code 0 ; ne vaut jamais preuve).
// VALEURS FICTIVES uniquement (dépôt PUBLIC) : aucun client, aucun livreur réel, aucun produit réel.
//
// Ce que fait le banc :
//   1. recrée le STRICT NÉCESSAIRE du schéma réel (rôles Supabase anon / authenticated / service_role, rôle propriétaire non
//      superutilisateur avec BYPASSRLS comme « postgres » chez Supabase, privilèges par défaut de Supabase, tables produits /
//      commandes avec les politiques de session de la migration 019, déclencheur garde_livreur_commandes de la 019 recopié
//      TEL QUEL depuis le fichier) ; applique TELLES QUELLES les migrations 004 et 031 puis la 040 (contrôles des sections 7
//      et 8 compris), puis la 040 une 2e fois (rejouable) ;
//   2. exécute pour de vrai : droits, idempotence, rejeu après réponse perdue, appels « simultanés », livreur d'une autre
//      commande, commande non livrée, ensemble à composants, substitution automatique, stock insuffisant, journal, garde de
//      stock_deduit (dont COMPATIBILITÉ : sauvegarde complète ancienne façon v7.5.196 et nouvelle v7.5.197), tout ou rien.
// LIMITES : une seule connexion (pglite exécute les requêtes l'une après l'autre : deux appels lancés « en même temps » sont
// sérialisés ; l'attente réelle entre deux transactions est garantie par le verrou FOR UPDATE de la commande, vérifié dans le
// texte de la fonction et par deux appels dans une même transaction) ; pas de PostgREST (l'appel rpc est reproduit en SQL :
// select public.deduire_stock_livraison(…)) ; session par paramètre de configuration au lieu des en-têtes x-app-secret /
// x-session-token ; types des colonnes historiques supposés d'après les envois de l'application.
const fs = require('fs'), path = require('path');
const racine = path.join(__dirname, '..');
const VERSION_ATTENDUE = '0.2.17';

const SAUTER = process.env.SAUTER_PGLITE === '1';
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (e) {
  if (SAUTER) { console.log('BANC 040 PGLITE SAUTÉ VOLONTAIREMENT (SAUTER_PGLITE=1) : la migration 040 n\'a PAS été testée.'); process.exit(0); }
  console.error('ÉCHEC DU BANC 040 PGLITE : dépendance @electric-sql/pglite absente — la migration 040 n\'a PAS été testée.');
  console.error('Installer les dépendances de développement (@electric-sql/pglite ' + VERSION_ATTENDUE + ') : npm install');
  console.error('Pour sauter ce banc volontairement : SAUTER_PGLITE=1 node outils/test-040-pglite.js');
  process.exit(2);
}

const lireMigration = (n) => fs.readFileSync(path.join(racine, 'supabase', 'migrations', n), 'utf8');
let ok = 0, ko = 0;
const test = (nom, cond, det) => { if (cond) { ok++; console.log('  OK   ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (det !== undefined ? ' — ' + JSON.stringify(det) : '')); } };

const SQL_ROLES = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role l26_postgres nologin bypassrls;
grant usage, create on schema public to l26_postgres;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role l26_postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role l26_postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role l26_postgres in schema public grant all on functions to anon, authenticated, service_role;
create schema interne authorization l26_postgres;
`;
// BOUCHONS (documentés) : session_role() / session_livreur() lisent les paramètres l26.session_role / l26.session_livreur
// (en production : en-têtes x-app-secret + x-session-token et table sessions_app, migration 019). Même signature, SECURITY
// DEFINER. Tables : colonnes utiles seulement (types supposés d'après sbSaveCommande / sbSaveProduit).
const SQL_BASE = `
create or replace function public.session_role() returns text
language sql stable security definer set search_path = public, pg_catalog as $$ select nullif(current_setting('l26.session_role', true), '') $$;
create or replace function public.session_livreur() returns text
language sql stable security definer set search_path = public, pg_catalog as $$
  select case when nullif(current_setting('l26.session_role', true), '') = 'livreur' then upper(nullif(current_setting('l26.session_livreur', true), '')) end $$;
revoke all on function public.session_role(), public.session_livreur() from public, anon, authenticated;
grant execute on function public.session_role(), public.session_livreur() to anon;

create table public.produits (
  id text primary key, nom text not null, cat text, dim text, prix numeric, poids numeric, stock integer default 0,
  seuil integer, empl text, remarque text, actif boolean default true, updated_at timestamptz default now(), created_at timestamptz default now());
create table public.commandes (
  id text primary key, client text, tel text, email text, adresse text, produit text, lignes jsonb, qte integer default 1,
  prix numeric default 0, prix_brut numeric, frais_port numeric default 0, remise_globale numeric default 0, remise_globale_val numeric default 0,
  remise_globale_type text default 'pct', remise_motif text, livreur text, origine text, ref_marketplace text, date_commande text,
  tracking_token text, transporteur text, tracking_transporteur text, statut text default 'en-attente', date_livraison text,
  stock_deduit boolean default false, updated_at timestamptz default now(), created_at timestamptz default now());

do $$
declare t text;
begin
  foreach t in array array['produits', 'commandes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy sess_admin on public.%I for all to anon using ((select public.session_role()) = ''admin'') with check ((select public.session_role()) = ''admin'')', t);
    execute format('create policy sess_collab on public.%I for all to anon using ((select public.session_role()) = ''collab'') with check ((select public.session_role()) = ''collab'')', t);
  end loop;
end $$;
create policy sess_livreur on public.commandes for all to anon
  using ((select public.session_role()) = 'livreur' and upper(coalesce(livreur,'')) = (select public.session_livreur())
         and coalesce(date_livraison,'') >= to_char(current_date - 2, 'YYYY-MM-DD') and coalesce(date_livraison,'') <= to_char(current_date + 2, 'YYYY-MM-DD'))
  with check ((select public.session_role()) = 'livreur' and upper(coalesce(livreur,'')) = (select public.session_livreur()));
create policy sess_livreur_lecture on public.produits for select to anon using ((select public.session_role()) = 'livreur');
create policy sess_livreur_stock on public.produits for update to anon using ((select public.session_role()) = 'livreur') with check ((select public.session_role()) = 'livreur');
`;

(async () => {
  let pkg = { version: '?' };
  try { let d = path.dirname(require.resolve('@electric-sql/pglite'));
        while (!fs.existsSync(path.join(d, 'package.json')) && path.dirname(d) !== d) d = path.dirname(d);
        pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')); } catch (e) { /* version inconnue */ }
  if (pkg.version !== VERSION_ATTENDUE) {
    console.error('ÉCHEC DU BANC 040 PGLITE : @electric-sql/pglite ' + pkg.version + ' installé, version exigée ' + VERSION_ATTENDUE + ' — migration 040 NON testée.');
    process.exit(2);
  }
  const db = new PGlite();
  const ver = (await db.query('select version() as v')).rows[0].v;
  console.log('Base jetable en mémoire : ' + ver.split(' on ')[0] + ' (@electric-sql/pglite ' + pkg.version + ')');

  // admin / collab / livreur (LIVREUR-A) / livreurB (LIVREUR-B) = navigateur (rôle anon) avec une session de ce rôle
  const ROLES_PG = { admin: 'anon', collab: 'anon', livreur: 'anon', livreurB: 'anon', anon: 'anon', authenticated: 'authenticated', service_role: 'service_role', proprio: 'l26_postgres' };
  // en-têtes HTTP de la requête (PostgREST les expose dans request.headers) : ENTETES = '' par défaut
  let ENTETES = '';
  async function contexte(qui) {
    await db.exec('reset role');
    await db.query("select set_config('request.headers', $1, false)", [ENTETES]);
    const sess = { admin: 'admin', collab: 'collab', livreur: 'livreur', livreurB: 'livreur' }[qui] || '';
    const nom = qui === 'livreur' ? 'livreur-a' : (qui === 'livreurB' ? 'livreur-b' : '');
    await db.query("select set_config('l26.session_role', $1, false), set_config('l26.session_livreur', $2, false)", [sess, nom]);
    await db.exec('set role ' + ROLES_PG[qui]);
  }
  async function q(qui, sql, params) { await contexte(qui); try { return (await db.query(sql, params || [])).rows; } finally { await db.exec('reset role'); } }
  async function echec(qui, sql, params) {
    await contexte(qui);
    try { await db.query(sql, params || []); return null; } catch (e) { return String(e && e.message || e); } finally { await db.exec('reset role'); }
  }
  const un = async (qui, sql, params) => (await q(qui, sql, params))[0];
  const deduire = async (qui, id) => (await un(qui, 'select public.deduire_stock_livraison($1) as r', [id])).r;
  const stock = async (id) => (await un('proprio', 'select stock from public.produits where id = $1', [id])).stock;
  const deduit = async (id) => (await un('proprio', 'select stock_deduit from public.commandes where id = $1', [id])).stock_deduit;
  const journal = async (cmd) => Number((await un('proprio', 'select count(*)::int as n from public.stock_sorties_livraison' + (cmd ? ' where cmd_id = $1' : ''), cmd ? [cmd] : [])).n);
  const AUJ = "to_char(current_date, 'YYYY-MM-DD')";
  async function commande(id, champs) {
    const c = Object.assign({ livreur: 'Livreur-A', statut: 'livré', lignes: null, produit: null, qte: 1, date: AUJ }, champs || {});
    await q('proprio', `insert into public.commandes (id, client, livreur, statut, lignes, produit, qte, date_livraison) values ($1, 'Client fictif', $2, $3, $4::jsonb, $5, $6, ${c.date})`,
      [id, c.livreur, c.statut, c.lignes === null ? null : JSON.stringify(c.lignes), c.produit, c.qte]);
  }

  // =========================================================================================================================
  console.log('\n1. SCHÉMA ET MIGRATIONS (004, 031, garde livreur de la 019 TELLE QUELLE, puis 040 TELLE QUELLE)');
  await db.exec(SQL_ROLES);
  await db.exec('set role l26_postgres');
  await db.exec(SQL_BASE);
  const m019 = lireMigration('019_incident_cles_2026-09-27.sql');
  const iG = m019.indexOf('create or replace function public._garde_livreur_commandes()');
  const fG = m019.indexOf('for each row execute function public._garde_livreur_commandes();', iG);
  let errG = null; try { await db.exec(m019.slice(iG, fG) + 'for each row execute function public._garde_livreur_commandes();'); } catch (e) { errG = e.message; }
  test('déclencheur garde_livreur_commandes de la 019 recopié tel quel', iG > 0 && fG > iG && errG === null, errG);
  for (const m of ['004_add_composants_to_produits.sql', '031_ancienne_offre.sql']) {
    let err = null; try { await db.exec(lireMigration(m)); } catch (e) { err = e.message; }
    test('migration ' + m + ' appliquée telle quelle', err === null, err);
  }
  const sql040 = lireMigration('040_deduction_stock_serveur.sql');
  let err040 = null; try { await db.exec(sql040); } catch (e) { err040 = e.message; }
  test('migration 040 appliquée TELLE QUELLE (contrôles des sections 7 et 8 passés)', err040 === null, err040);
  if (err040) { console.log('\nRÉSULTAT : arrêt, la migration 040 ne s\'applique pas.'); process.exit(1); }
  let err040b = null; try { await db.exec(sql040); } catch (e) { err040b = e.message; }
  test('migration 040 rejouable une 2e fois sans erreur', err040b === null, err040b);
  await db.exec('reset role');
  {
    // l'auto-contrôle s'exécute vraiment : une règle faussée fait échouer la section 6
    const bloc = sql040.slice(sql040.indexOf('-- 8. Auto-contrôle')); const corps = bloc.slice(bloc.indexOf('do $$'));
    await db.exec('set role l26_postgres; begin;');
    await db.exec("create or replace function interne.l040_dim_compatible(p_ref text, p_x text) returns boolean language sql immutable as $$ select true $$");
    let e6 = null; try { await db.exec(corps); } catch (e) { e6 = e.message; }
    await db.exec('rollback; reset role;');
    test('auto-contrôle section 8 : une règle de dimension faussée fait ÉCHOUER la migration', !!e6 && /Auto-contrôle 040/.test(e6), e6);
    // le contrôle de la section 5 refuse une base sans la colonne stock_deduit
    const bloc5 = sql040.slice(sql040.indexOf('-- 7. Contrôle')); const corps5 = bloc5.slice(bloc5.indexOf('do $$'), bloc5.indexOf('-- ───', bloc5.indexOf('do $$')));
    await db.exec('set role l26_postgres; begin;');
    await db.exec('drop trigger commandes_stock_deduit_garde on public.commandes; alter table public.commandes drop column stock_deduit');
    let e5 = null; try { await db.exec(corps5); } catch (e) { e5 = e.message; }
    await db.exec('rollback; reset role;');
    test('contrôle section 7 : colonne stock_deduit absente → migration ANNULÉE', !!e5 && /commandes\.stock_deduit/.test(e5), e5);
  }
  const src = (await un('proprio', "select prosrc from pg_proc where proname = 'deduire_stock_livraison'")).prosrc;
  const iFU = src.search(/from public\.commandes[\s\S]*?for update;/), iDeja = src.indexOf('if coalesce(c.stock_deduit, false) then');
  test('texte de la fonction : commande verrouillée (FOR UPDATE) AVANT la lecture de stock_deduit', iFU > 0 && iDeja > iFU, [iFU, iDeja]);
  test('texte de la fonction : produits verrouillés dans un ordre stable (order by id for update)', /perform 1 from public\.produits where id = any \(v_ids\) order by id for update;/.test(src));
  const def = await un('proprio', "select prosecdef, proconfig from pg_proc where proname = 'deduire_stock_livraison'");
  test('SECURITY DEFINER et search_path fixé', def.prosecdef === true && (def.proconfig || []).some(x => /^search_path=/.test(x)), def);

  // catalogue FICTIF (serveur)
  await q('service_role', `insert into public.produits (id, nom, cat, dim, prix, stock) values
    ('pa', 'Matelas Fictif A', 'Matelas', '140x190', 199, 5),
    ('pb', 'Sommier Fictif B', 'Sommier', '140x190', 99, 10),
    ('pm', 'Matelas Composant M', 'Matelas', '140×190', 150, 6),
    ('ps', 'Sommier Composant S', 'Sommier', '140×190', 90, 8),
    ('pz-sub', 'Matelas Substitut Z', 'Matelas', '140 × 190 × 20', 150, 4),
    ('pc', 'Oreiller Fictif C', 'Accessoire', '', 29, 1)`);
  await q('service_role', `insert into public.produits (id, nom, cat, prix, stock, composants) values
    ('pens', 'Ensemble Fictif M + S', 'Ensemble', 279, 3, '[{"id":"pm","qte":1},{"id":"ps","qte":2}]')`);

  // =========================================================================================================================
  console.log('\n2. DROITS');
  test('anon sans session : refus « session_requise »', (await deduire('anon', '#X')).erreur === 'session_requise');
  let e = await echec('authenticated', "select public.deduire_stock_livraison('#X')");
  test('authenticated (outil LBC) : exécution refusée', !!e && /permission denied/.test(e), e);
  const priv = await un('proprio', "select has_function_privilege('anon', 'public.deduire_stock_livraison(text)', 'execute') as a, has_function_privilege('public', 'public.deduire_stock_livraison(text)', 'execute') as p");
  test('exécution : anon oui (session vérifiée dans la fonction), PUBLIC non', priv.a === true && priv.p === false, priv);
  e = await echec('admin', "insert into public.stock_sorties_livraison (cmd_id, produit_id, qte_demandee, qte_retiree, stock_apres) values ('#F', 'pa', 1, 1, 0)");
  test('journal : aucune écriture directe, même par l\'administrateur', !!e && /permission denied/.test(e), e);
  test('fonctions internes de la 040 (schéma interne) : aucun accès pour anon', (await un('proprio', "select has_schema_privilege('anon', 'interne', 'usage') as u")).u === false);

  // =========================================================================================================================
  console.log('\n3. LIVRAISON SIMPLE ET IDEMPOTENCE (deux appels → une seule déduction ; rejeu après réponse perdue)');
  await commande('#C1', { lignes: [{ produitId: 'pa', nom: 'Matelas Fictif A', qte: 2 }, { produitId: 'pb', nom: 'Sommier Fictif B', qte: '1' }] });
  let r = await deduire('livreur', '#C1');
  test('livreur propriétaire : ok, deja = faux', r.ok === true && r.deja === false, r);
  test('retraits : pa −2 (stock 3), pb −1 (stock 9)', r.retraits.length === 2 && r.retraits[0].produit_id === 'pa' && r.retraits[0].qte === 2 && r.retraits[0].stock_apres === 3 && r.retraits[1].produit_id === 'pb' && r.retraits[1].qte === 1 && r.retraits[1].stock_apres === 9, r.retraits);
  test('stocks en base : pa 3, pb 9 ; stock_deduit = vrai ; aucun manque', (await stock('pa')) === 3 && (await stock('pb')) === 9 && (await deduit('#C1')) === true && r.manques.length === 0);
  test('journal écrit : 2 lignes pour #C1, acteur « livreur:LIVREUR-A »', (await journal('#C1')) === 2 && (await un('proprio', "select acteur from public.stock_sorties_livraison where cmd_id = '#C1' limit 1")).acteur === 'livreur:LIVREUR-A');
  const r1er = r; // réponse du 1er appel (supposée perdue par le téléphone)
  r = await deduire('livreur', '#C1');
  test('2e appel (réponse du 1er perdue, téléphone qui renvoie) : ok, deja = vrai, rien retiré en base', r.ok === true && r.deja === true && (await stock('pa')) === 3 && (await stock('pb')) === 9, r);
  test('… réserve Codex n° 1 : résultat COMPLET de la 1re déduction restitué tel quel (retraits, manques, opération) + stock courant', JSON.stringify(r.retraits) === JSON.stringify(r1er.retraits) && JSON.stringify(r.manques) === JSON.stringify(r1er.manques) && r.operation_id === r1er.operation_id && r.stocks_actuels.pa === 3 && r.stocks_actuels.pb === 9, [r, r1er]);
  for (let i = 0; i < 3; i++) await deduire(i % 2 ? 'admin' : 'livreur', '#C1');
  test('3 rejeux de plus (livreur et admin) : stocks inchangés (pa 3, pb 9), journal toujours 2 lignes', (await stock('pa')) === 3 && (await stock('pb')) === 9 && (await journal('#C1')) === 2);

  // =========================================================================================================================
  console.log('\n4. APPELS SIMULTANÉS');
  await commande('#C2', { lignes: [{ produitId: 'pa', qte: 1 }] });
  await contexte('livreur');
  const rs = await Promise.all([db.query("select public.deduire_stock_livraison('#C2') as r"), db.query("select public.deduire_stock_livraison('#C2') as r")]);
  await db.exec('reset role');
  const deja = rs.map(x => x.rows[0].r.deja).sort();
  test('deux appels lancés en même temps : un seul déduit (deja = faux puis vrai)', JSON.stringify(deja) === '[false,true]', deja);
  test('… pa retiré UNE fois (3 → 2), journal 1 ligne', (await stock('pa')) === 2 && (await journal('#C2')) === 1);
  await commande('#C3', { lignes: [{ produitId: 'pa', qte: 1 }] });
  await contexte('livreur');
  await db.exec('begin');
  const r1 = (await db.query("select public.deduire_stock_livraison('#C3') as r")).rows[0].r;
  const r2 = (await db.query("select public.deduire_stock_livraison('#C3') as r")).rows[0].r;
  await db.exec('commit'); await db.exec('reset role');
  test('deux appels dans la même transaction : le second voit stock_deduit = vrai (deja)', r1.deja === false && r2.deja === true, [r1, r2]);
  test('… pa 2 → 1 seulement', (await stock('pa')) === 1);

  // =========================================================================================================================
  console.log('\n5. SESSIONS : AUTRE LIVREUR, HORS DATE, COLLABORATRICE, ADMINISTRATEUR');
  await commande('#C4', { lignes: [{ produitId: 'pb', qte: 1 }] });
  r = await deduire('livreurB', '#C4');
  test('livreur d\'une AUTRE commande : refus « commande_introuvable », rien touché', r.ok === false && r.erreur === 'commande_introuvable' && (await stock('pb')) === 9 && (await deduit('#C4')) === false, r);
  await commande('#C5', { lignes: [{ produitId: 'pb', qte: 1 }], date: "to_char(current_date - 5, 'YYYY-MM-DD')" });
  r = await deduire('livreur', '#C5');
  test('livreur, livraison à plus de 2 jours (même règle que sess_livreur) : refus', r.ok === false && r.erreur === 'commande_introuvable', r);
  r = await deduire('collab', '#C5');
  test('collaboratrice : déduction faite (pb 9 → 8)', r.ok === true && r.deja === false && (await stock('pb')) === 8, r);
  r = await deduire('admin', '#C4');
  test('administrateur : déduction faite (pb 8 → 7)', r.ok === true && r.deja === false && (await stock('pb')) === 7, r);
  test('commande inexistante : « commande_introuvable »', (await deduire('admin', '#INCONNUE')).erreur === 'commande_introuvable');

  // =========================================================================================================================
  console.log('\n6. COMMANDE NON LIVRÉE : REFUS CLAIR');
  for (const st of ['en-route', 'en-attente', 'annulé']) {
    await commande('#N-' + st, { statut: st, lignes: [{ produitId: 'pb', qte: 1 }] });
    r = await deduire('livreur', '#N-' + st);
    test('statut « ' + st + ' » : refus « commande_non_livree », stock et stock_deduit inchangés', r.ok === false && r.erreur === 'commande_non_livree' && r.statut === st && (await stock('pb')) === 7 && (await deduit('#N-' + st)) === false, r);
  }
  await commande('#C-livre', { statut: 'livre', lignes: [{ produitId: 'pb', qte: 1 }] });
  test('statut « livre » (sans accent, ancien) accepté', (await deduire('livreur', '#C-livre')).deja === false && (await stock('pb')) === 6);

  // =========================================================================================================================
  console.log('\n7. ENSEMBLE À COMPOSANTS ET SUBSTITUTION AUTOMATIQUE');
  await commande('#E1', { lignes: [{ produitId: 'pens', nom: 'Ensemble Fictif M + S', qte: 2 }] });
  r = await deduire('livreur', '#E1');
  test('ensemble ×2 : composants retirés (pm −2 → 4, ps −4 → 4), l\'ensemble lui-même non retiré (3)', r.ok && (await stock('pm')) === 4 && (await stock('ps')) === 4 && (await stock('pens')) === 3, r.retraits);
  test('retraits marqués « composant_de » = l\'ensemble', r.retraits.length === 2 && r.retraits.every(x => x.composant_de === 'pens' && x.substitue_de === null), r.retraits);
  await q('service_role', "update public.produits set stock = 1 where id = 'pm'");
  await commande('#E2', { lignes: [{ produitId: 'pens', qte: 2 }] });
  r = await deduire('livreur', '#E2');
  const rz = r.retraits.find(x => x.produit_id === 'pz-sub');
  test('composant pm en rupture (1 < 2) : substitut même catégorie et dimension (pz-sub, 4 → 2), pm intact', rz && rz.qte === 2 && rz.substitue_de === 'pm' && (await stock('pz-sub')) === 2 && (await stock('pm')) === 1, r.retraits);
  test('journal : substitue_de = pm', (await un('proprio', "select substitue_de from public.stock_sorties_livraison where cmd_id = '#E2' and produit_id = 'pz-sub'")).substitue_de === 'pm');
  // substitut « non vendable » (colonne de la 039) jamais choisi ; à défaut, retrait partiel + manque
  await q('proprio', 'alter table public.produits add column vendable boolean not null default true');
  await q('service_role', "insert into public.produits (id, nom, cat, dim, prix, stock, vendable) values ('pa-nv', 'Matelas Non Vendable', 'Matelas', '140×190', 150, 50, false)");
  await q('service_role', "update public.produits set stock = 0 where id in ('pm', 'pz-sub')");
  await commande('#E3', { lignes: [{ produitId: 'pens', qte: 1 }] });
  r = await deduire('livreur', '#E3');
  test('substitut non vendable (039) jamais pris : pa-nv intact (50)', (await stock('pa-nv')) === 50, r.retraits);
  const mq = r.manques.find(x => x.produit_id === 'pm');
  test('composant sans substitut : stock 0 gardé, manque renvoyé (1)', mq && mq.manque === 1 && mq.raison === 'stock_insuffisant' && (await stock('pm')) === 0, r.manques);
  test('stock_deduit = vrai malgré le manque (rien à redéduire)', (await deduit('#E3')) === true);

  // =========================================================================================================================
  console.log('\n8. STOCK INSUFFISANT, PRODUIT INTROUVABLE, REPLI PAR NOM');
  await commande('#S1', { lignes: [{ produitId: 'pc', qte: 3 }] });
  r = await deduire('livreur', '#S1');
  test('stock 1, quantité 3 : stock 0 (jamais négatif), retiré 1, manque 2', (await stock('pc')) === 0 && r.retraits[0].qte === 1 && r.manques[0].manque === 2 && r.manques[0].demande === 3, r);
  await commande('#S2', { lignes: [{ produitId: 'pc', qte: 1 }] });
  r = await deduire('livreur', '#S2');
  test('stock déjà 0 : reste 0, manque 1', (await stock('pc')) === 0 && r.manques[0].manque === 1, r);
  await commande('#S3', { lignes: [{ produitId: 'p-disparu', nom: 'Produit Inexistant Zzz', qte: 1 }] });
  r = await deduire('livreur', '#S3');
  test('produit introuvable : signalé (« produit_introuvable »), stock_deduit = vrai', r.ok && r.manques[0].raison === 'produit_introuvable' && (await deduit('#S3')) === true, r);
  await commande('#S4', { lignes: [{ nom: 'Sommier Fictif B', qte: 1 }] });
  r = await deduire('livreur', '#S4');
  test('ligne sans produitId : retrouvée par son nom (pb 6 → 5)', r.retraits[0] && r.retraits[0].produit_id === 'pb' && (await stock('pb')) === 5, r);
  await commande('#S5', { produit: 'Sommier Fictif B 140', qte: 2 });
  r = await deduire('livreur', '#S5');
  test('commande sans lignes (produit + qte), nom qui contient celui du produit : pb 5 → 3', r.retraits[0] && r.retraits[0].produit_id === 'pb' && r.retraits[0].qte === 2 && (await stock('pb')) === 3, r);

  // =========================================================================================================================
  console.log('\n9. GARDE : UNE SAUVEGARDE ORDINAIRE NE REMET PAS stock_deduit À FAUX');
  const upsertCmd = `insert into public.commandes (id, client, livreur, statut, stock_deduit, date_livraison) values ($1, 'Client fictif', 'Livreur-A', $2, false, ${AUJ})
    on conflict (id) do update set statut = excluded.statut, stock_deduit = excluded.stock_deduit, updated_at = now()`;
  e = await echec('livreur', upsertCmd, ['#C1', 'livré']);
  test('livreur : upsert (sbSaveCommande, file rejouée) avec stock_deduit = faux → reste VRAI', e === null && (await deduit('#C1')) === true, e);
  r = await deduire('livreur', '#C1');
  test('… et le rejeu de la demande ne déduit pas une 2e fois (deja)', r.deja === true && (await stock('pa')) === 1, r);
  e = await echec('collab', "update public.commandes set stock_deduit = false where id = '#C1'");
  test('collaboratrice : remise à faux ignorée', e === null && (await deduit('#C1')) === true, e);
  e = await echec('admin', "update public.commandes set stock_deduit = false where id = '#C1'");
  test('administrateur, commande encore « livré » : remise à faux ignorée', e === null && (await deduit('#C1')) === true, e);
  // réserve Codex n° 5 sur 9473d23 : sauvegarde PÉRIMÉE de l'administrateur (copie d'avant le « livré » : statut
  // en-route, stock_deduit faux) → stock_deduit reste vrai ; seule la fonction de recrédit le remet à faux
  e = await echec('admin', "update public.commandes set statut = 'en-route', stock_deduit = false where id = '#C1'");
  test('administrateur, sauvegarde PÉRIMÉE (en-route, stock_deduit faux) : stock_deduit reste VRAI', e === null && (await deduit('#C1')) === true, e);
  await q('proprio', "update public.commandes set statut = 'livré' where id = '#C1'");
  r = await deduire('livreur', '#C1');
  test('… la commande relivrée ensuite ne déduit pas une 2e fois (deja)', r.deja === true && (await stock('pa')) === 1, r);
  ENTETES = JSON.stringify({ 'x-stock-recredit': '1' });
  e = await echec('admin', "update public.commandes set statut = 'annulé', stock_deduit = false where id = '#C1'");
  ENTETES = '';
  test('ancien en-tête x-stock-recredit (version précédente de la PR) : sans effet, stock_deduit reste VRAI', e === null && (await deduit('#C1')) === true, e);
  ENTETES = 'pas du json';
  e = await echec('admin', "update public.commandes set prix = 5 where id = '#C1'");
  ENTETES = '';
  test('en-têtes illisibles : aucune erreur', e === null, e);
  await q('proprio', "update public.commandes set statut = 'livré' where id = '#C1'");
  await q('service_role', "update public.produits set stock = 10 where id in ('pa', 'pb')");
  r = await deduire('livreur', '#C1');
  test('(remise en état du banc) #C1 toujours déduite : deja', r.deja === true);
  await q('service_role', "update public.commandes set stock_deduit = false where id = '#C1'");
  r = await deduire('livreur', '#C1');
  test('commande dont stock_deduit a été remis à faux par un programme serveur : nouvelle déduction (pa 10 → 8, pb 10 → 9)', r.deja === false && (await stock('pa')) === 8 && (await stock('pb')) === 9, r);
  e = await echec('service_role', "update public.commandes set stock_deduit = false where id = '#C4'");
  test('programme serveur (sans session) : non concerné', e === null && (await deduit('#C4')) === false, e);
  e = await echec('livreur', "update public.commandes set stock_deduit = true where id = '#N-en-route'");
  test('passer stock_deduit à vrai reste permis (anciennes versions de l\'appli)', e === null && (await deduit('#N-en-route')) === true, e);

  // COMPATIBILITÉ des sauvegardes (réserve Codex sur 96590c2) : corps COMPLET envoyé par sbSaveCommande (POST
  // merge-duplicates = insert … on conflict do update de toutes les colonnes envoyées), ancienne façon (v7.5.196 et
  // avant, téléphones déjà installés) et nouvelle (v7.5.197). Le déclencheur ne refuse JAMAIS une sauvegarde : il ne
  // corrige que stock_deduit vrai → faux ; tout le reste de l'écriture est enregistré.
  const upsertComplet = `insert into public.commandes (id, client, tel, produit, lignes, qte, prix, livreur, statut, stock_deduit, date_livraison, updated_at)
    values ($1, 'Client fictif', '0600000000', 'Matelas Fictif A', $2::jsonb, 1, $3, 'Livreur-A', $4, $5, ${AUJ}, now())
    on conflict (id) do update set client = excluded.client, tel = excluded.tel, produit = excluded.produit, lignes = excluded.lignes,
      qte = excluded.qte, prix = excluded.prix, livreur = excluded.livreur, statut = excluded.statut, stock_deduit = excluded.stock_deduit,
      date_livraison = excluded.date_livraison, updated_at = excluded.updated_at`;
  const lignesA = JSON.stringify([{ produitId: 'pa', nom: 'Matelas Fictif A', qte: 1 }]);
  const prix = async (id) => Number((await un('proprio', 'select prix from public.commandes where id = $1', [id])).prix);
  // (a) ancienne appli, copie PÉRIMÉE (stock_deduit faux) d'une commande déjà déduite par la base : sauvegarde acceptée
  await commande('#K1', { lignes: [{ produitId: 'pa', qte: 1 }] });
  r = await deduire('livreur', '#K1');
  const paK1 = await stock('pa');
  for (const qui of ['livreur', 'admin', 'collab']) {
    e = await echec(qui, upsertComplet, ['#K1', lignesA, qui === 'admin' ? 321 : 0, 'livré', false]);
    test('ancienne façon (' + qui + ') : sauvegarde complète périmée ACCEPTÉE, stock_deduit gardé VRAI', e === null && (await deduit('#K1')) === true, e);
    if (qui === 'admin') test('… le reste de l\'écriture de l\'administrateur est enregistré (prix 321)', (await prix('#K1')) === 321);
  }
  r = await deduire('livreur', '#K1');
  test('… et la demande renvoyée ne déduit pas une 2e fois (deja, stock pa inchangé)', r.deja === true && (await stock('pa')) === paK1, r);
  // (b) ancienne appli qui a déduit ELLE-MÊME puis posé stock_deduit = vrai : la base ne redéduit jamais
  await commande('#K2', { statut: 'en-route', lignes: [{ produitId: 'pa', qte: 1 }] });
  const paK2 = await stock('pa');
  e = await echec('livreur', upsertComplet, ['#K2', lignesA, 0, 'livré', true]);
  test('ancienne façon : « livré » + stock_deduit = vrai (déduction faite par le téléphone) accepté', e === null && (await deduit('#K2')) === true, e);
  r = await deduire('livreur', '#K2');
  test('… un appel de la fonction ensuite ne déduit rien (deja) : pas de double déduction', r.deja === true && (await stock('pa')) === paK2, r);
  // (c) première sauvegarde « livré » (stock_deduit faux) d'une commande jamais déduite : déclencheur sans effet
  await commande('#K3', { statut: 'en-route', lignes: [{ produitId: 'pa', qte: 1 }] });
  e = await echec('livreur', upsertComplet, ['#K3', lignesA, 0, 'livré', false]);
  test('« livré » enregistré, stock_deduit faux reste faux (le déclencheur ne déduit rien)', e === null && (await deduit('#K3')) === false && (await stock('pa')) === paK2, e);
  // (d) nouvelle appli : « livré », fonction, puis REJEU de la file (copie d'avant la déduction, stock_deduit faux)
  r = await deduire('livreur', '#K3');
  test('nouvelle façon : la fonction déduit après le « livré » (pa −1)', r.deja === false && (await stock('pa')) === paK2 - 1, r);
  e = await echec('livreur', upsertComplet, ['#K3', lignesA, 0, 'livré', false]);
  test('nouvelle façon : « livré » rejoué depuis la file après la déduction → accepté, stock_deduit reste VRAI', e === null && (await deduit('#K3')) === true, e);
  r = await deduire('livreur', '#K3');
  test('… demande rejouée : deja, stock inchangé', r.deja === true && (await stock('pa')) === paK2 - 1, r);
  // (e) écriture qui ne touche pas stock_deduit, et création de commande : aucun effet
  e = await echec('admin', "update public.commandes set prix = 99 where id = '#K3'");
  test('modification sans stock_deduit : acceptée, rien d\'autre changé', e === null && (await prix('#K3')) === 99 && (await deduit('#K3')) === true, e);
  e = await echec('admin', upsertComplet, ['#K4', lignesA, 10, 'en-attente', false]);
  test('création d\'une commande (insert) : non concernée (stock_deduit faux)', e === null && (await deduit('#K4')) === false, e);
  await q('service_role', "update public.produits set stock = 8 where id = 'pa'"); // remis comme avant ce bloc (suite du banc)
  const cl = await un('proprio', "select client from public.commandes where id = '#C1'");
  test('déclencheur garde_livreur_commandes toujours actif (client non modifié par l\'appel du livreur)', cl.client === 'Client fictif');

  // =========================================================================================================================
  console.log('\n10. TOUT OU RIEN, JOURNAL FIGÉ');
  await q('proprio', `create or replace function public.t_panne() returns trigger language plpgsql as $f$ begin if new.id = 'pb' then raise exception 'panne simulée'; end if; return new; end $f$`);
  await q('proprio', 'create trigger t_panne before update on public.produits for each row execute function public.t_panne()');
  await commande('#P1', { lignes: [{ produitId: 'pa', qte: 1 }, { produitId: 'pb', qte: 1 }] });
  const jAvant = await journal();
  e = await echec('livreur', "select public.deduire_stock_livraison('#P1')");
  test('erreur sur le 2e produit : l\'appel échoue', !!e && /panne simulée/.test(e), e);
  test('… rien n\'est retiré (pa 8), stock_deduit faux, journal inchangé', (await stock('pa')) === 8 && (await deduit('#P1')) === false && (await journal()) === jAvant);
  await q('proprio', 'drop trigger t_panne on public.produits');
  r = await deduire('livreur', '#P1');
  test('rejeu après la panne : déduction faite une fois (pa 7, pb 8)', r.deja === false && (await stock('pa')) === 7 && (await stock('pb')) === 8, r);
  e = await echec('proprio', "update public.stock_sorties_livraison set qte_retiree = 0 where cmd_id = '#P1'");
  test('journal : modification refusée (ajout seul)', !!e && /ajout seul/.test(e), e);
  e = await echec('proprio', "delete from public.stock_sorties_livraison where cmd_id = '#P1'");
  test('journal : suppression refusée', !!e && /ajout seul/.test(e), e);
  test('journal lisible par l\'administrateur et la collaboratrice, pas par le livreur', Number((await un('admin', 'select count(*)::int as n from public.stock_sorties_livraison')).n) > 0
    && Number((await un('collab', 'select count(*)::int as n from public.stock_sorties_livraison')).n) > 0
    && Number((await un('livreur', 'select count(*)::int as n from public.stock_sorties_livraison')).n) === 0);

  // =========================================================================================================================
  const fixer = async (stocks) => { for (const [id, v] of Object.entries(stocks)) await q('service_role', 'update public.produits set stock = $2 where id = $1', [id, v]); };
  const recrediter = async (qui, id, sup) => (await un(qui, 'select public.recrediter_stock_livraison($1, $2) as r', [id, !!sup])).r;
  const mouvement = async (qui, pid, type, qte, cle) => (await un(qui, 'select public.mouvement_stock_produit($1, $2, $3, $4, $5) as r', [pid, type, qte, 'motif fictif', cle])).r;
  const nbOps = async (cmd) => Number((await un('proprio', 'select count(*)::int as n from public.stock_operations where cmd_id = $1', [cmd])).n);

  console.log('\n11. RÉSERVE CODEX N° 1 : REJEU APRÈS RÉPONSE PERDUE — RÉSULTAT COMPLET CONSERVÉ (MANQUES, INTROUVABLES)');
  await fixer({ pc: 1 });
  await commande('#R1', { lignes: [{ produitId: 'pc', nom: 'Oreiller Fictif C', qte: 3 }, { produitId: 'p-absent', nom: 'Produit Absent Qqq', qte: 1 }] });
  const rR1 = await deduire('livreur', '#R1');
  test('1re déduction : retrait partiel (pc 1 sur 3) + manque « stock_insuffisant » + « produit_introuvable »', rR1.retraits.length === 1 && rR1.manques.length === 2 && rR1.manques.some(m => m.raison === 'stock_insuffisant' && m.manque === 2) && rR1.manques.some(m => m.raison === 'produit_introuvable'), rR1);
  const opR1 = await un('proprio', "select resultat from public.stock_operations where cmd_id = '#R1' and nature = 'deduction'");
  test('journal des opérations : résultat complet conservé EN BASE, produit introuvable compris', opR1 && opR1.resultat.manques.some(m => m.raison === 'produit_introuvable' && m.nom === 'Produit Absent Qqq'), opR1);
  for (const qui of ['livreur', 'admin', 'collab']) {
    const rj = await deduire(qui, '#R1');
    test('rejeu (' + qui + ') : deja, retraits ET manques identiques à la 1re réponse, rien retiré', rj.deja === true && JSON.stringify(rj.retraits) === JSON.stringify(rR1.retraits) && JSON.stringify(rj.manques) === JSON.stringify(rR1.manques) && (await stock('pc')) === 0, rj);
  }
  test('… une seule opération de déduction en base pour #R1', (await nbOps('#R1')) === 1);
  // commande déduite par une ANCIENNE version (stock_deduit posé par le téléphone) : rien de connu, rien touché
  await commande('#R2', { lignes: [{ produitId: 'pa', qte: 1 }] });
  await q('livreur', "update public.commandes set stock_deduit = true where id = '#R2'");
  const rR2 = await deduire('livreur', '#R2');
  test('commande déduite par une ancienne version : deja + « resultat_inconnu », aucun retrait', rR2.deja === true && rR2.resultat_inconnu === true && rR2.retraits.length === 0, rR2);

  console.log('\n12. RÉSERVE CODEX N° 2 : RECRÉDIT PAR LA BASE DEPUIS LES SORTIES JOURNALISÉES');
  await fixer({ pm: 0, 'pz-sub': 5, ps: 8, pc: 1, 'pa-nv': 50 });
  await commande('#RC1', { lignes: [{ produitId: 'pens', qte: 2 }, { produitId: 'pc', qte: 3 }] });
  let rc = await deduire('livreur', '#RC1');
  test('déduction : substitut pz-sub (5 → 3) pour pm en rupture, ps 8 → 4, pc retiré 1 sur 3 (partiel)', (await stock('pz-sub')) === 3 && (await stock('ps')) === 4 && (await stock('pc')) === 0 && (await stock('pm')) === 0, rc);
  rc = await recrediter('admin', '#RC1');
  test('recrédit demandé alors que la commande est encore « livré » en base : refus « commande_encore_livree », rien touché', rc.ok === false && rc.erreur === 'commande_encore_livree' && (await stock('ps')) === 4 && (await deduit('#RC1')) === true, rc);
  test('recrédit par un livreur : « droits_insuffisants » ; sans session : « session_requise »', (await recrediter('livreur', '#RC1')).erreur === 'droits_insuffisants' && (await recrediter('anon', '#RC1')).erreur === 'session_requise');
  await q('admin', "update public.commandes set statut = 'annulé' where id = '#RC1'");
  rc = await recrediter('collab', '#RC1');
  test('commande annulée, collaboratrice : recrédit ok, stock_deduit = faux', rc.ok === true && rc.deja === false && (await deduit('#RC1')) === false, rc);
  test('… produits et quantités RÉELLEMENT sortis : pz-sub +2 (3 → 5, le substitut), ps +4 (4 → 8), pc +1 seulement (retrait partiel), pm (composant d\'origine) inchangé 0', (await stock('pz-sub')) === 5 && (await stock('ps')) === 8 && (await stock('pc')) === 1 && (await stock('pm')) === 0, rc.retours);
  const rcRej = await recrediter('admin', '#RC1');
  test('recrédit rejoué (réponse perdue) : deja, même résultat, stocks inchangés', rcRej.deja === true && JSON.stringify(rcRej.retours) === JSON.stringify(rc.retours) && (await stock('ps')) === 8 && (await stock('pz-sub')) === 5, rcRej);
  e = await echec('admin', "update public.commandes set stock_deduit = true where id = '#RC1'");
  r = await deduire('livreur', '#RC1');
  test('après recrédit, une sauvegarde qui remet stock_deduit = vrai (mode transitoire) puis un rejeu de déduction : deja (pas de 2e retrait)', e === null && r.deja === true && (await stock('ps')) === 8, r);
  await q('service_role', "update public.commandes set stock_deduit = false where id = '#RC1'");
  await q('admin', "update public.commandes set statut = 'livré' where id = '#RC1'");
  await fixer({ pm: 6 });
  r = await deduire('livreur', '#RC1');
  test('relivrée : nouvelle déduction (pm 6 → 4, ps 8 → 4, pc 1 → 0)', r.deja === false && (await stock('pm')) === 4 && (await stock('ps')) === 4 && (await stock('pc')) === 0, r);
  await q('admin', "update public.commandes set statut = 'annulé' where id = '#RC1'");
  rc = await recrediter('admin', '#RC1');
  test('2e annulation : seulement les sorties de la 2e livraison (pm +2 → 6, ps +4 → 8, pc +1 → 1 ; pz-sub inchangé 5)', rc.ok && (await stock('pm')) === 6 && (await stock('ps')) === 8 && (await stock('pc')) === 1 && (await stock('pz-sub')) === 5, rc.retours);
  // commande déduite par une ANCIENNE version : quantités inconnues → rien touché
  await commande('#RC2', { statut: 'annulé', lignes: [{ produitId: 'pa', qte: 1 }] });
  await q('livreur', "update public.commandes set stock_deduit = true where id = '#RC2'");
  const paRC2 = await stock('pa');
  rc = await recrediter('admin', '#RC2');
  test('déduite par une ancienne version (aucune sortie journalisée) : « sans_journal », rien touché, stock_deduit reste vrai', rc.ok === false && rc.erreur === 'sans_journal' && (await stock('pa')) === paRC2 && (await deduit('#RC2')) === true, rc);
  // suppression d'une commande livrée
  await commande('#RC3', { lignes: [{ produitId: 'pb', qte: 2 }] });
  await deduire('livreur', '#RC3');
  const pbRC3 = await stock('pb');
  rc = await recrediter('admin', '#RC3', true);
  test('suppression d\'une commande encore « livré » (p_suppression) : recrédit fait (pb +2)', rc.ok === true && (await stock('pb')) === pbRC3 + 2, rc);
  await commande('#RC4', { lignes: [{ produitId: 'pb', qte: 1 }] });
  await deduire('livreur', '#RC4');
  await q('proprio', "delete from public.commandes where id = '#RC4'");
  const pbRC4 = await stock('pb');
  test('commande déjà supprimée, sans p_suppression : « commande_introuvable »', (await recrediter('admin', '#RC4')).erreur === 'commande_introuvable');
  rc = await recrediter('admin', '#RC4', true);
  test('commande déjà supprimée, p_suppression : recrédit depuis le journal (pb +1)', rc.ok === true && rc.deja === false && (await stock('pb')) === pbRC4 + 1, rc);
  rc = await recrediter('admin', '#RC4', true);
  test('… rejoué : deja, pb inchangé', rc.deja === true && (await stock('pb')) === pbRC4 + 1, rc);
  const srcR = (await un('proprio', "select prosrc from pg_proc where proname = 'recrediter_stock_livraison'")).prosrc;
  test('texte du recrédit : verrou de la commande puis produits verrouillés dans l\'ordre des identifiants', /pg_advisory_xact_lock\(hashtext\('l040\|'/.test(srcR) && /perform 1 from public\.produits where id = any \(v_ids\) order by id for update;/.test(srcR));

  console.log('\n13. RÉSERVE CODEX N° 3 : MOUVEMENTS MANUELS PAR LA BASE ; FICHES SANS STOCK ; MODE STRICT');
  await fixer({ pa: 10 });
  let mv = await mouvement('collab', 'pa', 'entree', 5, 'mv-essai-0001');
  test('entrée +5 (collaboratrice) : calculée par la base (10 → 15)', mv.ok === true && mv.deja === false && mv.stock_apres === 15 && (await stock('pa')) === 15, mv);
  mv = await mouvement('collab', 'pa', 'entree', 5, 'mv-essai-0001');
  test('même clé rejouée (réponse perdue) : deja, stock inchangé (15)', mv.deja === true && mv.stock_apres === 15 && (await stock('pa')) === 15, mv);
  test('même clé pour un autre produit : « cle_deja_utilisee »', (await mouvement('admin', 'pb', 'entree', 1, 'mv-essai-0001')).erreur === 'cle_deja_utilisee');
  mv = await mouvement('admin', 'pa', 'sortie', 40, 'mv-essai-0002');
  test('sortie plus grande que le stock : 0, jamais négatif', mv.stock_apres === 0 && (await stock('pa')) === 0, mv);
  mv = await mouvement('admin', 'pa', 'correction', 12, 'mv-essai-0003');
  test('correction explicite du bureau : stock = 12', mv.stock_apres === 12 && (await stock('pa')) === 12, mv);
  test('refus : livreur, type inconnu, quantité 0 en entrée, clé trop courte, produit absent', (await mouvement('livreur', 'pa', 'entree', 1, 'mv-essai-0004')).erreur === 'droits_insuffisants'
    && (await mouvement('admin', 'pa', 'vol', 1, 'mv-essai-0005')).erreur === 'type_invalide'
    && (await mouvement('admin', 'pa', 'entree', 0, 'mv-essai-0006')).erreur === 'quantite_invalide'
    && (await mouvement('admin', 'pa', 'entree', 1, 'court')).erreur === 'cle_requise'
    && (await mouvement('admin', 'p-absent', 'entree', 1, 'mv-essai-0007')).erreur === 'produit_introuvable' && (await stock('pa')) === 12);
  // déduction concurrente : l'administrateur a ouvert la fiche (stock lu 12), une livraison retire 2, puis il enregistre
  const upsertFiche = (avecStock) => `insert into public.produits (id, nom, cat, dim, prix${avecStock ? ', stock' : ''}, updated_at) values ('pa', $1, 'Matelas', '140x190', 199${avecStock ? ', 12' : ''}, now())
    on conflict (id) do update set nom = excluded.nom, prix = excluded.prix${avecStock ? ', stock = excluded.stock' : ''}, updated_at = excluded.updated_at`;
  await commande('#M1', { lignes: [{ produitId: 'pa', qte: 2 }] });
  await deduire('livreur', '#M1');
  e = await echec('admin', upsertFiche(false), ['Matelas Fictif A (renommé)']);
  test('fiche v7.5.198 (sans le champ stock) enregistrée APRÈS une déduction : nom changé, stock de la base gardé (10)', e === null && (await stock('pa')) === 10 && (await un('proprio', "select nom from public.produits where id = 'pa'")).nom === 'Matelas Fictif A (renommé)', e);
  e = await echec('admin', upsertFiche(true), ['Matelas Fictif A']);
  test('mode TRANSITOIRE : fiche d\'une ANCIENNE version avec un stock périmé (12) : acceptée telle quelle (compatibilité, limite documentée)', e === null && (await stock('pa')) === 12, e);
  await q('proprio', "update interne.l040_reglages set actif = true where cle = 'strict_toutes_versions'");
  await commande('#M2', { lignes: [{ produitId: 'pa', qte: 2 }] });
  await deduire('livreur', '#M2');
  e = await echec('admin', upsertFiche(true), ['Matelas Fictif A (strict)']);
  test('mode STRICT : fiche périmée (stock 12) après une déduction : AUCUNE erreur, nom enregistré, stock de la base gardé (10)', e === null && (await stock('pa')) === 10 && (await un('proprio', "select nom from public.produits where id = 'pa'")).nom === 'Matelas Fictif A (strict)', e);
  e = await echec('livreur', "update public.produits set stock = 99 where id = 'pa'");
  test('mode STRICT : PATCH du stock par un livreur (ancienne version) : aucune erreur, ignoré (10)', e === null && (await stock('pa')) === 10, e);
  e = await echec('collab', "update public.produits set stock = 99 where id = 'pa'");
  test('mode STRICT : collaboratrice, écriture directe du stock : ignorée (10)', e === null && (await stock('pa')) === 10, e);
  mv = await mouvement('admin', 'pa', 'entree', 3, 'mv-essai-0008');
  test('mode STRICT : les fonctions écrivent toujours (entrée +3 → 13)', mv.ok && (await stock('pa')) === 13, mv);
  e = await echec('admin', "insert into public.produits (id, nom, cat, stock) values ('p-neuf', 'Produit Neuf Fictif', 'Matelas', 7)");
  test('mode STRICT : création d\'une fiche avec son stock initial : acceptée (7)', e === null && (await stock('p-neuf')) === 7, e);
  await q('service_role', "update public.produits set stock = 20 where id = 'pa'");
  test('mode STRICT : programme serveur (sans session) : non concerné (20)', (await stock('pa')) === 20);
  await commande('#M3', { lignes: [{ produitId: 'pa', qte: 1 }] });
  e = await echec('livreur', "update public.commandes set stock_deduit = true where id = '#M3'");
  test('mode STRICT : stock_deduit posé par une ancienne version : ignoré (faux)', e === null && (await deduit('#M3')) === false, e);
  r = await deduire('livreur', '#M3');
  test('… la fonction déduit normalement (pa 20 → 19)', r.deja === false && (await stock('pa')) === 19, r);
  await q('admin', "update public.commandes set statut = 'annulé' where id = '#M3'");
  rc = await recrediter('admin', '#M3');
  test('mode STRICT : recrédit par la fonction (19 → 20, stock_deduit faux)', rc.ok && (await stock('pa')) === 20 && (await deduit('#M3')) === false, rc);
  await q('proprio', "update interne.l040_reglages set actif = false where cle = 'strict_toutes_versions'");
  let e040c = null; try { await db.exec('set role l26_postgres'); await db.exec("update interne.l040_reglages set actif = true where cle = 'strict_toutes_versions'"); await db.exec(sql040); } catch (x) { e040c = x.message; } finally { await db.exec('reset role'); }
  test('migration 040 rejouée en mode strict : sans erreur, réglage strict CONSERVÉ', e040c === null && (await un('proprio', "select actif from interne.l040_reglages where cle = 'strict_toutes_versions'")).actif === true, e040c);
  await q('proprio', "update interne.l040_reglages set actif = false where cle = 'strict_toutes_versions'");
  test('réglage : aucun accès pour les sessions de l\'application', !!(await echec('admin', 'select * from interne.l040_reglages')));
  test('journal des opérations : écriture directe refusée, même à l\'administrateur', /permission denied/.test(await echec('admin', "insert into public.stock_operations (nature, resultat) values ('mouvement', '{}')") || ''));

  console.log('\n14. RÉSERVE CODEX N° 4 : VERROUS STABLES, COMPOSITION LUE SOUS VERROU');
  const srcD = (await un('proprio', "select prosrc from pg_proc where proname = 'deduire_stock_livraison'")).prosrc;
  test('texte : seulement DEUX prises de verrou de ligne (la commande, puis les produits dans l\'ordre des identifiants)', (srcD.match(/for update/g) || []).length === 2, srcD.match(/for update/g));
  test('texte : composition relue SOUS verrou (interne.l040_verrous_requis APRÈS le verrou), sous-transaction recommencée sinon', /order by id for update;\s*v_requis := interne\.l040_verrous_requis\(v_ids_lignes\);[\s\S]{0,200}raise exception using errcode = 'L4001'/.test(srcD) && /exception when sqlstate 'L4001'/.test(srcD));
  test('texte : substitut choisi seulement parmi les produits verrouillés', /x\.id = any \(v_ids\)/.test(srcD));
  // composition modifiée entre l'ouverture de la commande et la livraison (même transaction : modification, puis appel)
  await fixer({ pm: 5, ps: 5, pb: 5, pc: 5 });
  await commande('#V1', { lignes: [{ produitId: 'pens', qte: 1 }] });
  await contexte('admin'); await db.exec('begin');
  await db.query(`update public.produits set composants = '[{"id":"pb","qte":1},{"id":"pc","qte":2}]' where id = 'pens'`);
  const rV1 = (await db.query("select public.deduire_stock_livraison('#V1') as r")).rows[0].r;
  await db.exec('commit'); await db.exec('reset role');
  test('composition modifiée juste avant (pm+ps → pb+pc×2) : la NOUVELLE composition est retirée (pb 5 → 4, pc 5 → 3), l\'ancienne non (pm, ps 5)', rV1.ok && (await stock('pb')) === 4 && (await stock('pc')) === 3 && (await stock('pm')) === 5 && (await stock('ps')) === 5, rV1);
  // nouvelle catégorie de composant : ses substituts sont verrouillés à la passe suivante et peuvent être choisis
  await q('service_role', "insert into public.produits (id, nom, cat, dim, prix, stock) values ('pt1', 'Tête Fictive 1', 'Tete', '140x190', 50, 0), ('pt2', 'Tête Fictive 2', 'Tete', '140x190', 50, 4)");
  await q('admin', `update public.produits set composants = '[{"id":"pt1","qte":1}]' where id = 'pens'`);
  await commande('#V2', { lignes: [{ produitId: 'pens', qte: 2 }] });
  const rV2 = await deduire('livreur', '#V2');
  test('composant d\'une nouvelle catégorie en rupture : substitut de cette catégorie verrouillé et pris (pt2 4 → 2)', rV2.ok && (await stock('pt2')) === 2 && rV2.retraits[0].substitue_de === 'pt1', rV2);
  await q('admin', `update public.produits set composants = '[{"id":"pm","qte":1},{"id":"ps","qte":2}]' where id = 'pens'`);

  console.log('\n13. v7.5.206 (avis chatgpt-review sur c22dacd, point 1) : DÉPASSEMENT « QUANTITÉ DE LIGNE × QUANTITÉ DU COMPOSANT »');
  await fixer({ pm: 5, ps: 5 });
  await q('admin', `update public.produits set composants = '[{"id":"pm","qte":1},{"id":"ps","qte":1000000}]' where id = 'pens'`);
  await commande('#X1', { lignes: [{ produitId: 'pens', qte: 1000000 }] });
  r = await deduire('livreur', '#X1');
  test('1 000 000 × 1 000 000 (> 2 147 483 647) : refus propre « quantite_hors_borne » (plus d\'erreur de débordement), RIEN retiré ni journalisé, pas marquée déduite',
    r && r.ok === false && r.erreur === 'quantite_hors_borne' && r.detail[0].composant === 'ps' && Number(r.detail[0].demande) === 1e12
    && (await stock('pm')) === 5 && (await stock('ps')) === 5 && (await journal('#X1')) === 0 && (await deduit('#X1')) === false, r);
  await commande('#X2', { lignes: [{ produitId: 'pens', qte: 2 }] });
  await q('admin', `update public.produits set composants = '[{"id":"pm","qte":1},{"id":"ps","qte":500001}]' where id = 'pens'`);
  r = await deduire('livreur', '#X2');
  test('produit juste au-dessus de la borne (2 × 500 001 = 1 000 002) : refusé aussi, sans écriture', r && r.ok === false && r.erreur === 'quantite_hors_borne' && (await stock('pm')) === 5, r);
  await q('admin', `update public.produits set composants = '[{"id":"pm","qte":1},{"id":"ps","qte":2}]' where id = 'pens'`);
  r = await deduire('livreur', '#X2');
  test('composition revenue à la normale : la même commande se déduit ensuite (pm −2, ps −4)', r && r.ok && (await stock('pm')) === 3 && (await stock('ps')) === 1, r);

  console.log('\nRÉSULTAT : ' + ok + ' tests réussis, ' + ko + ' échec(s)');
  process.exit(ko ? 1 : 0);
})().catch(e => { console.error('ERREUR DU BANC :', e); process.exit(2); });
