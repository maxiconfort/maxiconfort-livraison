// Banc de test RÉEL de la migration 039 (arrivages, prix de revient, produits non vendables) sur une base PostgreSQL JETABLE,
// EN MÉMOIRE (@electric-sql/pglite = PostgreSQL 16 compilé en WebAssembly, rien n'est écrit sur le disque, aucune connexion).
// Usage : node outils/test-039-pglite.js
// Prérequis : la dépendance de développement déclarée dans package.json (@electric-sql/pglite, version EXACTE 0.2.17) : npm install
//   (revue Codex PR 26 sur 636f873) Sans ce paquet, ou avec une autre version, le banc ÉCHOUE (code 2) : un contrôle automatique ne
//   peut plus paraître réussi sans avoir testé la migration. Pour le sauter VOLONTAIREMENT (machine sans dépendances) :
//   SAUTER_PGLITE=1 node outils/test-039-pglite.js   (message « SAUTÉ », code 0 ; ne vaut jamais preuve que la 039 est testée).
// VALEURS FICTIVES uniquement (dépôt PUBLIC) : aucun prix réel, aucun client, aucun fournisseur.
//
// Ce que fait le banc :
//   1. recrée le STRICT NÉCESSAIRE du schéma réel (rôles Supabase anon / authenticated / service_role, rôle propriétaire non
//      superutilisateur avec BYPASSRLS comme « postgres » chez Supabase, privilèges par défaut de Supabase sur le schéma public,
//      tables produits / commandes / mouvements_stock avec les politiques de session de la migration 019) — BOUCHONS documentés
//      plus bas (session_role, session_livreur, auth.uid, auth.jwt) ;
//   2. applique TELLES QUELLES les migrations 004 (composants), 024 (stock_correspondance), 025 (stock_entrees…) puis la 039
//      (ses auto-contrôles des sections 8, 9 et 10 s'exécutent : une erreur annulerait la migration) ; puis la 039 une 2e fois
//      (rejouable sans erreur) ;
//   3. exécute pour de vrai les droits par rôle, les déclencheurs, la réception atomique, la correction de taux et la double
//      validation d'un même arrivage.
// LIMITES (voir aussi le compte rendu de PR) : une seule connexion (pas de vraie concurrence : la double validation est simulée
// par deux appels successifs) ; pas de PostgREST (les requêtes de l'application sont reproduites en SQL : POST = insert,
// merge-duplicates = insert … on conflict do update, PATCH = update) ; session par paramètre de configuration au lieu des
// en-têtes x-app-secret / x-session-token ; types des colonnes historiques (créées avant les migrations du dépôt) supposés
// d'après les envois de l'application.
const fs = require('fs'), path = require('path');
const racine = path.join(__dirname, '..');
const VERSION_ATTENDUE = '0.2.17';

const SAUTER = process.env.SAUTER_PGLITE === '1';
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (e) {
  if (SAUTER) {
    console.log('BANC 039 PGLITE SAUTÉ VOLONTAIREMENT (SAUTER_PGLITE=1) : la migration 039 n\'a PAS été testée.');
    process.exit(0);
  }
  console.error('ÉCHEC DU BANC 039 PGLITE : dépendance @electric-sql/pglite absente — la migration 039 n\'a PAS été testée.');
  console.error('Installer les dépendances déclarées (package.json, devDependencies : @electric-sql/pglite ' + VERSION_ATTENDUE + ') : npm install');
  console.error('Pour sauter ce banc volontairement : SAUTER_PGLITE=1 node outils/test-039-pglite.js');
  process.exit(2);
}

const lireMigration = (n) => fs.readFileSync(path.join(racine, 'supabase', 'migrations', n), 'utf8');
let ok = 0, ko = 0;
const test = (nom, cond, det) => { if (cond) { ok++; console.log('  OK   ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (det !== undefined ? ' — ' + JSON.stringify(det) : '')); } };
const r4 = (x) => Math.round(x * 10000) / 10000;  // arrondi à 4 décimales (round(numeric, 4) ; valeurs positives ici)

// ---------------------------------------------------------------------------------------------------------------------------
// Schéma de base : le strict nécessaire, exécuté par le superutilisateur de pglite puis par le rôle propriétaire.
// ---------------------------------------------------------------------------------------------------------------------------
// Rôles : anon (navigateur, clé publishable), authenticated (outil LBC, Supabase Auth), service_role (clé secrète, BYPASSRLS),
// l26_postgres = propriétaire des objets (comme « postgres » chez Supabase : PAS superutilisateur, mais BYPASSRLS ; les
// fonctions SECURITY DEFINER de la 039 s'exécutent donc avec ses droits, comme en production).
const SQL_ROLES = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role l26_postgres nologin bypassrls;
grant usage, create on schema public to l26_postgres;
grant usage on schema public to anon, authenticated, service_role;
-- privilèges par défaut de Supabase : tout objet créé dans public par le propriétaire est ouvert aux trois rôles (les
-- migrations retirent ensuite ce qu'il faut : c'est ce que le banc vérifie)
alter default privileges for role l26_postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role l26_postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role l26_postgres in schema public grant all on functions to anon, authenticated, service_role;
create schema interne authorization l26_postgres;   -- migration 019 (schéma privé : aucun droit d'usage pour anon)
create schema auth authorization l26_postgres;
grant usage on schema auth to anon, authenticated, service_role;
`;
// Exécuté par l26_postgres. BOUCHONS (documentés) :
//  * public.session_role() / session_livreur() : en production (migration 019) le rôle vient des en-têtes x-app-secret +
//    x-session-token et de la table sessions_app ; ici il est lu dans le paramètre l26.session_role (l26.session_livreur) posé
//    par le banc avant chaque requête. Même signature, SECURITY DEFINER, mêmes droits (exécution anon seulement).
//  * auth.uid() / auth.jwt() : bouchons minimaux (la 039 ne les utilise pas ; présents pour la fidélité du schéma).
//  * produits / commandes / mouvements_stock : tables créées avant les migrations du dépôt ; colonnes utiles seulement, types
//    supposés d'après les envois de l'application (sbSaveProduit, sbSaveCommande, logMouvementStock) ; politiques de session
//    recopiées de la migration 019 (sess_admin, sess_collab, sess_livreur, sess_livreur_lecture, sess_livreur_stock).
const SQL_BASE = `
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;

create or replace function public.session_role() returns text
language sql stable security definer set search_path = public, pg_catalog as $$ select nullif(current_setting('l26.session_role', true), '') $$;
create or replace function public.session_livreur() returns text
language sql stable security definer set search_path = public, pg_catalog as $$
  select case when nullif(current_setting('l26.session_role', true), '') = 'livreur' then upper(nullif(current_setting('l26.session_livreur', true), '')) end $$;
revoke all on function public.session_role(), public.session_livreur() from public, anon, authenticated;
grant execute on function public.session_role(), public.session_livreur() to anon;

create table public.produits (
  id text primary key, nom text not null, cat text, dim text, prix numeric not null, poids numeric, stock integer default 0,
  seuil integer, empl text, remarque text, actif boolean default true, updated_at timestamptz default now(), created_at timestamptz default now());
create table public.commandes (
  id text primary key, client text, produit text, lignes jsonb, qte integer default 1, prix numeric default 0, prix_brut numeric,
  remise_globale numeric default 0, remise_globale_val numeric default 0, remise_globale_type text default 'pct', remise_motif text,
  livreur text, statut text default 'en-attente', date_livraison text, created_at timestamptz default now());
create table public.mouvements_stock (
  id bigint generated always as identity primary key, type text not null, produit_libelle text, quantite integer, source text,
  destination text, commande_id text, tournee_id text, livreur text, par_user text, date_mouvement timestamptz default now());

do $$
declare t text;
begin
  foreach t in array array['produits', 'commandes', 'mouvements_stock'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy sess_admin on public.%I for all to anon using ((select public.session_role()) = ''admin'') with check ((select public.session_role()) = ''admin'')', t);
    execute format('create policy sess_collab on public.%I for all to anon using ((select public.session_role()) = ''collab'') with check ((select public.session_role()) = ''collab'')', t);
  end loop;
end $$;
create policy sess_livreur on public.commandes for all to anon
  using ((select public.session_role()) = 'livreur' and upper(coalesce(livreur,'')) = (select public.session_livreur()))
  with check ((select public.session_role()) = 'livreur' and upper(coalesce(livreur,'')) = (select public.session_livreur()));
create policy sess_livreur on public.mouvements_stock for all to anon
  using ((select public.session_role()) = 'livreur' and upper(coalesce(livreur,'')) = (select public.session_livreur()))
  with check ((select public.session_role()) = 'livreur' and upper(coalesce(livreur,'')) = (select public.session_livreur()));
create policy sess_livreur_lecture on public.produits for select to anon using ((select public.session_role()) = 'livreur');
create policy sess_livreur_stock on public.produits for update to anon using ((select public.session_role()) = 'livreur') with check ((select public.session_role()) = 'livreur');
`;

(async () => {
  let pkg = { version: '?' };
  try { let d = path.dirname(require.resolve('@electric-sql/pglite'));
        while (!fs.existsSync(path.join(d, 'package.json')) && path.dirname(d) !== d) d = path.dirname(d);
        pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')); } catch (e) { /* version inconnue : sans effet */ }
  // revue Codex PR 26 sur 636f873 : version EXACTE exigée (celle de package.json) ; une autre version = échec explicite
  if (pkg.version !== VERSION_ATTENDUE) {
    console.error('ÉCHEC DU BANC 039 PGLITE : @electric-sql/pglite ' + pkg.version + ' installé, version exigée ' + VERSION_ATTENDUE + ' (package.json) — migration 039 NON testée.');
    process.exit(2);
  }
  let db = new PGlite();  // let : la section 10 rebranche les mêmes aides sur des connexions NEUVES (copies de la base)
  const ver = (await db.query('select version() as v')).rows[0].v;
  console.log('Base jetable en mémoire : ' + ver.split(' on ')[0] + ' (@electric-sql/pglite ' + pkg.version + ')');

  // Contexte d'exécution. admin / collab / livreur = navigateur (rôle anon) avec une session de ce rôle ; anon = navigateur
  // sans session ; authenticated ; service_role (scripts serveur, clé secrète, session NULL) ; proprio = l26_postgres.
  const ROLES_PG = { admin: 'anon', collab: 'anon', livreur: 'anon', anon: 'anon', authenticated: 'authenticated', service_role: 'service_role', proprio: 'l26_postgres' };
  async function contexte(qui) {
    await db.exec('reset role');
    const sess = ['admin', 'collab', 'livreur'].includes(qui) ? qui : '';
    await db.query("select set_config('l26.session_role', $1, false), set_config('l26.session_livreur', $2, false)", [sess, sess === 'livreur' ? 'LIVREUR-TEST' : '']);
    await db.exec('set role ' + ROLES_PG[qui]);
  }
  async function q(qui, sql, params) { await contexte(qui); try { return (await db.query(sql, params || [])).rows; } finally { await db.exec('reset role'); } }
  async function echec(qui, sql, params) {  // message d'erreur, ou null si la requête passe
    await contexte(qui);
    try { await db.query(sql, params || []); return null; } catch (e) { return String(e && e.message || e); } finally { await db.exec('reset role'); }
  }
  const un = async (qui, sql, params) => (await q(qui, sql, params))[0];
  const rpc = async (qui, sql, params) => { const r = await un(qui, sql, params); return r && r.r; };
  const produit = (id) => un('proprio', 'select id, nom, prix::float8 as prix, prix_vente_defini, vendable, stock, reference_interne, caracteristiques, composants from public.produits where id = $1', [id]);
  const compte = async (table, where, params) => Number((await un('proprio', 'select count(*)::int as n from ' + table + (where ? ' where ' + where : ''), params)).n);
  const empreinte = async (id) => (await un('proprio', 'select interne.l039_empreinte_valorisation($1, interne.arrivage_methode_valorisation()) as e', [id])).e;
  // photo de tout ce qu'une réception ou une correction peut écrire (pour prouver « aucune écriture »)
  async function photo() {
    return JSON.stringify(await un('proprio', `select
      (select jsonb_agg(to_jsonb(p) - 'updated_at' order by id) from public.produits p) as produits,
      (select jsonb_agg(to_jsonb(l) order by id) from public.arrivage_lignes l) as lignes,
      (select jsonb_agg(to_jsonb(a) - 'maj_at' order by id) from public.arrivages a) as arrivages,
      (select jsonb_agg(to_jsonb(r) - 'maj_at' order by produit_id) from public.produits_revient r) as revient,
      (select count(*) from public.prix_revient_historique) as hist, (select count(*) from public.mouvements_stock) as mvts,
      (select count(*) from public.stock_entrees) as entrees`));
  }

  // =========================================================================================================================
  console.log('\n1. SCHÉMA ET MIGRATIONS (004, 024, 025, puis 039 TELLE QUELLE, auto-contrôles 8 à 10 compris)');
  await db.exec(SQL_ROLES);
  await db.exec('set role l26_postgres');
  await db.exec(SQL_BASE);
  for (const m of ['004_add_composants_to_produits.sql', '024_stock_correspondance.sql', '025_stock_comptage_fiabilite.sql']) {
    let err = null; try { await db.exec(lireMigration(m)); } catch (e) { err = e.message; }
    test('migration ' + m + ' appliquée telle quelle', err === null, err);
  }
  const sql039 = lireMigration('039_arrivages_prix_revient.sql');
  let err039 = null; try { await db.exec(sql039); } catch (e) { err039 = e.message; }
  test('migration 039 appliquée TELLE QUELLE (auto-contrôles des sections 8, 9 et 10 passés)', err039 === null, err039);
  if (err039) { console.log('\nRÉSULTAT : arrêt, la migration 039 ne s\'applique pas.'); process.exit(1); }
  let err039b = null; try { await db.exec(sql039); } catch (e) { err039b = e.message; }
  test('migration 039 rejouable une 2e fois sans erreur (idempotente)', err039b === null, err039b);
  await db.exec('reset role');
  // auto-contrôle rendu VISIBLE : une fonction pure faussée fait bien échouer la section 10 (preuve que la section s'exécute)
  {
    const sec10 = sql039.slice(sql039.indexOf('-- 10. Auto-contrôle'));
    const bloc = sec10.slice(sec10.indexOf('do $$'));
    await db.exec('set role l26_postgres; begin;');
    await db.exec("create or replace function interne.l039_creation_etat(p_admin boolean, p_prix numeric) returns text language sql immutable as $$ select null::text $$");
    let e10 = null; try { await db.exec(bloc); } catch (e) { e10 = e.message; }
    await db.exec('rollback; reset role;');
    test('auto-contrôle section 10 : une décision faussée (création collaboratrice vendable) fait ÉCHOUER la migration', !!e10 && /Auto-contrôle 039/.test(e10), e10);
    test('… et la vraie décision est revenue après annulation', (await un('proprio', 'select interne.l039_creation_etat(false, 199) as e')).e === 'a_definir');
    // relecture SANS le verrou de la réception (simples SELECT) : la section 10 fait échouer la migration
    await db.exec('set role l26_postgres; begin;');
    await db.exec("create or replace function public.statut_reception_arrivage(p_arrivage_id bigint) returns json language plpgsql volatile security definer set search_path = public, pg_catalog as $f$ begin if (select public.session_role()) is distinct from 'admin' then return null; end if; return (select json_build_object('ok', true, 'statut', statut) from public.arrivages where id = p_arrivage_id); end $f$");
    let e10b = null; try { await db.exec(bloc); } catch (e) { e10b = e.message; }
    await db.exec('rollback; reset role;');
    test('auto-contrôle section 10 : une relecture SANS le verrou de l\'arrivage (for update) fait ÉCHOUER la migration', !!e10b && /statut_reception_arrivage/.test(e10b), e10b);
  }

  // ---------- catalogue FICTIF chargé côté serveur (service_role, session NULL = flux serveur / administrateur) ----------
  await q('service_role', `insert into public.produits (id, nom, cat, prix, stock) values
    ('pr-a', 'Matelas Fictif A 140x190', 'Matelas', 199, 10), ('pr-b', 'Sommier Fictif B 140x190', 'Sommier', 99, 0),
    ('pr-c', 'Oreiller Fictif C', 'Accessoire', 29, 12)`);
  await q('service_role', `insert into public.produits (id, nom, cat, prix, stock, composants) values
    ('pr-ens', 'Ensemble Fictif A + B', 'Ensemble', 279, 0, '[{"id":"pr-a","qte":1},{"id":"pr-b","qte":1}]')`);
  await q('service_role', "insert into public.produits_revient (produit_id, prix_revient_ht, methode, provisoire, maj_par) values ('pr-a', 12, 'CUMP', false, 'chargement')");

  // =========================================================================================================================
  console.log('\n2. PRODUITS : création, modification, upsert (déclencheur produits_vente_garde, contraintes)');
  let e = await echec('collab', "insert into public.produits (id, nom, cat, prix, stock, prix_vente_defini, vendable) values ('pr-n', 'Matelas Nouveau N (fictif)', 'Matelas', 150, 0, true, true)");
  let p = await produit('pr-n');
  test('collaboratrice crée un produit AVEC prix 150 : créé « à définir » (prix NULL, non vendable) — décision A', e === null && p && p.prix === null && p.prix_vente_defini === false && p.vendable === false, { e, p });
  e = await echec('collab', "insert into public.produits (id, nom, prix, prix_vente_defini, vendable) values ('pr-n0', 'Produit Fictif N0', 0, true, true)");
  p = await produit('pr-n0');
  test('collaboratrice crée un produit à prix 0 marqué vendable : « à définir »', e === null && p.prix === null && !p.prix_vente_defini && !p.vendable, { e, p });
  e = await echec('collab', "insert into public.produits (id, nom, prix, reference_interne, caracteristiques) values ('pr-n1', 'Produit Fictif N1', 50, 'MC-FORCE', '{\"x\":1}')");
  p = await produit('pr-n1');
  test('collaboratrice : référence interne et caractéristiques ignorées à la création', e === null && p.reference_interne === null && p.caracteristiques === null, { e, p });
  e = await echec('livreur', "insert into public.produits (id, nom, prix) values ('pr-liv', 'Produit Fictif Livreur', 80)");
  test('livreur : création de produit REFUSÉE (aucune politique d\'insertion, migration 019)', !!e && /row-level security/.test(e), e);
  e = await echec('admin', "insert into public.produits (id, nom, prix) values ('pr-ad', 'Produit Fictif Admin', 120)");
  p = await produit('pr-ad');
  test('administrateur crée un produit avec prix 120 : vendable, prix défini', e === null && p.prix === 120 && p.prix_vente_defini && p.vendable, { e, p });
  e = await echec('admin', "insert into public.produits (id, nom, prix) values ('pr-ad0', 'Produit Fictif Admin 0', 0)");
  p = await produit('pr-ad0');
  test('administrateur crée un produit à prix 0 : « à définir »', e === null && p.prix === null && !p.vendable, { e, p });
  e = await echec('admin', "insert into public.produits (id, nom, prix, prix_vente_defini, vendable) values ('pr-ad1', 'Produit Fictif Admin 1', 120, false, true)");
  test('administrateur : vendable sans prix défini REFUSÉ (« PRODUIT NON VENDABLE »)', !!e && /PRODUIT NON VENDABLE/.test(e), e);

  e = await echec('collab', "update public.produits set prix = 150, prix_vente_defini = true, vendable = true where id = 'pr-n'");
  p = await produit('pr-n');
  test('collaboratrice tente de fixer le prix et de rendre vendable : marqueurs et prix gardés (« à définir »)', e === null && p.prix === null && !p.prix_vente_defini && !p.vendable, { e, p });
  e = await echec('admin', "update public.produits set prix_vente_defini = true where id = 'pr-n'");
  test('administrateur : « prix défini » sans prix > 0 REFUSÉ (prix_obligatoire)', !!e && /un prix supérieur à 0 est obligatoire/.test(e), e);
  e = await echec('admin', "update public.produits set prix = 0, prix_vente_defini = true where id = 'pr-n'");
  test('administrateur : « prix défini » à 0 REFUSÉ', !!e && /obligatoire/.test(e), e);
  e = await echec('admin', "update public.produits set reference_interne = 'MC-TEST-N' where id = 'pr-n'");
  test('administrateur pose la référence interne MC-TEST-N', e === null && (await produit('pr-n')).reference_interne === 'MC-TEST-N', e);
  e = await echec('collab', "update public.produits set reference_interne = 'MC-AUTRE' where id = 'pr-n'");
  test('collaboratrice : référence interne inchangeable (gardée)', e === null && (await produit('pr-n')).reference_interne === 'MC-TEST-N', e);
  // upsert de l'application (sbSaveProduit, Prefer: resolution=merge-duplicates) d'un produit « à définir » existant
  const upsertProduit = `insert into public.produits (id, nom, cat, dim, prix, poids, stock, seuil, empl, remarque, composants, actif, updated_at)
    values ($1, $2, '', '', $3, 0, $4, 2, '', '', null, true, now())
    on conflict (id) do update set nom = excluded.nom, cat = excluded.cat, dim = excluded.dim, prix = excluded.prix, poids = excluded.poids,
      stock = excluded.stock, seuil = excluded.seuil, empl = excluded.empl, remarque = excluded.remarque, composants = excluded.composants,
      actif = excluded.actif, updated_at = excluded.updated_at`;
  e = await echec('collab', upsertProduit, ['pr-n', 'Matelas Nouveau N (fictif)', null, 3]);
  p = await produit('pr-n');
  test('upsert collaboratrice (sbSaveProduit, prix NULL) d\'un produit « à définir » : stock enregistré, reste « à définir »', e === null && p.stock === 3 && p.prix === null && !p.vendable, { e, p });
  e = await echec('collab', upsertProduit, ['pr-n', 'Matelas Nouveau N (fictif)', 0, 3]);
  p = await produit('pr-n');
  test('upsert collaboratrice avec prix 0 (ancienne appli) : reste « à définir », prix NULL', e === null && p.prix === null && !p.prix_vente_defini, { e, p });
  e = await echec('admin', upsertProduit, ['pr-n', 'Matelas Nouveau N (fictif)', 300, 3]);
  p = await produit('pr-n');
  test('upsert administrateur avec prix 300 d\'un produit « à définir » : ne fixe PAS le prix (seul le flux « définir le prix » le fait)', e === null && p.prix === null && !p.vendable, { e, p });
  e = await echec('livreur', "update public.produits set stock = 2, prix = 500, vendable = true where id = 'pr-n'");
  p = await produit('pr-n');
  test('livreur (décompte de stock) : stock modifié, prix et marqueurs gardés', e === null && p.stock === 2 && p.prix === null && !p.vendable, { e, p });
  e = await echec('service_role', "update public.produits set prix = null where id = 'pr-a'");
  test('serveur : « prix défini » sans prix (NULL) REFUSÉ (prix_null)', !!e && /sans prix \(NULL\)/.test(e), e);
  await q('proprio', 'alter table public.produits disable trigger produits_vente_garde');
  e = await echec('proprio', "update public.produits set prix = null where id = 'pr-a'");
  await q('proprio', 'alter table public.produits enable trigger produits_vente_garde');
  test('contrainte produits_prix_defini_non_null : refuse même sans le déclencheur', !!e && /produits_prix_defini_non_null/.test(e), e);
  e = await echec('collab', "update public.produits set stock = 5 where id = 'pr-a'");
  test('collaboratrice : modification ordinaire d\'un produit vendable acceptée', e === null && (await produit('pr-a')).stock === 5, e);
  await q('service_role', "update public.produits set stock = 10 where id = 'pr-a'");

  // =========================================================================================================================
  console.log('\n3. CORRESPONDANCE SHOPIFY (stock_correspondance_vendable_garde, produits_correspondance_garde)');
  e = await echec('service_role', "insert into public.stock_correspondance (shopify_variant_id, app_produit_id, fiabilite) values (1001, 'pr-a', 'certaine')");
  test('variante « certaine » vers un produit vendable : acceptée', e === null, e);
  e = await echec('service_role', "insert into public.stock_correspondance (shopify_variant_id, app_produit_id, fiabilite) values (1002, 'pr-n', 'certaine')");
  test('variante « certaine » vers un produit non vendable : REFUSÉE', !!e && /PRODUIT NON VENDABLE/.test(e), e);
  e = await echec('service_role', "insert into public.stock_correspondance (shopify_variant_id, app_produit_id, fiabilite) values (1002, 'pr-n', 'incertaine')");
  test('variante « incertaine » vers un produit non vendable : acceptée', e === null, e);
  e = await echec('service_role', "update public.stock_correspondance set fiabilite = 'certaine' where shopify_variant_id = 1002");
  test('passage en « certaine » d\'une variante d\'un produit non vendable : REFUSÉ', !!e && /PRODUIT NON VENDABLE/.test(e), e);
  e = await echec('service_role', "insert into public.stock_correspondance (shopify_variant_id, app_produit_id, fiabilite) values (1003, 'pr-ens', 'certaine')");
  test('variante « certaine » vers un ensemble vendable : acceptée', e === null, e);
  e = await echec('admin', "update public.produits set vendable = false where id = 'pr-a'");
  test('produit relié à une variante « certaine » rendu non vendable : REFUSÉ', !!e && /variantes Shopify « certaines »/.test(e) && (await produit('pr-a')).vendable, e);
  e = await echec('admin', "update public.produits set vendable = false where id = 'pr-b'");
  test('composant d\'un ensemble relié (certaine) rendu non vendable : REFUSÉ (l\'ensemble le deviendrait)', !!e && /1003/.test(e) && (await produit('pr-b')).vendable, e);
  e = await echec('admin', "update public.produits set composants = '[{\"id\":\"pr-a\",\"qte\":1},{\"id\":\"pr-n\",\"qte\":1}]' where id = 'pr-ens'");
  test('ensemble relié (certaine) recomposé avec un produit non vendable : REFUSÉ', !!e && /retirer d'abord ces correspondances/.test(e), e);
  e = await echec('admin', "update public.produits set composants = '[{\"id\":\"pr-a\",\"qte\":1},{\"id\":\"pr-inconnu\",\"qte\":1}]' where id = 'pr-ens'");
  test('ensemble relié (certaine) avec un composant INTROUVABLE : REFUSÉ (introuvable = non vendable)', !!e && /retirer d'abord/.test(e), e);
  e = await echec('anon', "select * from public.stock_correspondance");
  test('stock_correspondance : aucun droit pour le navigateur (anon)', !!e && /permission denied/.test(e), e);
  await q('service_role', 'delete from public.stock_correspondance where shopify_variant_id = 1003');
  e = await echec('admin', "update public.produits set vendable = false where id = 'pr-b'");
  test('correspondance retirée : l\'administrateur retire le sommier de la vente', e === null && !(await produit('pr-b')).vendable, e);
  test('l\'ensemble qui le contient est désormais NON vendable (interne.produit_non_vendable)', (await un('proprio', "select interne.produit_non_vendable('pr-ens') as nv")).nv === true);
  e = await echec('collab', "update public.produits set composants = '[{\"id\":\"pr-a\",\"qte\":1}]' where id = 'pr-ens'");
  test('collaboratrice retire le composant non vendable d\'un ensemble (le rendrait vendable) : REFUSÉ', !!e && /seul l'administrateur le rend vendable/.test(e), e);
  e = await echec('collab', "update public.produits set stock = 1 where id = 'pr-ens'");
  test('collaboratrice : autre modification de cet ensemble acceptée', e === null, e);
  const upsertEns = upsertProduit.replace("null, true, now())", "$5::jsonb, true, now())");
  e = await echec('collab', upsertEns, ['pr-ens', 'Ensemble Fictif A + B', 279, 1, '[{"id":"pr-a","qte":1}]']);
  test('… même tentative par l\'upsert de l\'application (sbSaveProduit) : REFUSÉE', !!e && /seul l'administrateur le rend vendable/.test(e), e);
  e = await echec('livreur', "update public.produits set composants = '[{\"id\":\"pr-a\",\"qte\":1}]' where id = 'pr-ens'");
  test('livreur (droit de modifier produits pour le stock) : même tentative REFUSÉE', !!e && /seul l'administrateur/.test(e), e);
  e = await echec('admin', "update public.produits set composants = '[{\"id\":\"pr-a\",\"qte\":1}]' where id = 'pr-ens'");
  test('administrateur : recomposer l\'ensemble (le rend vendable) accepté', e === null && (await un('proprio', "select interne.produit_non_vendable('pr-ens') as nv")).nv === false, e);
  await q('admin', "update public.produits set composants = '[{\"id\":\"pr-a\",\"qte\":1},{\"id\":\"pr-b\",\"qte\":1}]' where id = 'pr-ens'");
  test('catalogue chargé côté serveur (session NULL) avec prix : vendable', (await produit('pr-c')).vendable === true);

  // =========================================================================================================================
  console.log('\n4. COMMANDES (commandes_produit_vendable_garde : lignes figées, remise globale figée, upsert)');
  const L = (pid, nom, qte, pu, extra) => Object.assign({ produitId: pid, produit: nom, qte, prixUnit: pu, prixBrut: qte * pu, remiseLigne: 0, sousTotal: qte * pu }, extra || {});
  const insCmd = 'insert into public.commandes (id, client, produit, lignes, qte, prix) values ($1, \'Client Fictif\', $2, $3::jsonb, 1, $4)';
  e = await echec('collab', insCmd, ['#TEST-C2', 'Matelas Nouveau N (fictif)', JSON.stringify([L('pr-n', 'Matelas Nouveau N (fictif)', 1, 150)]), 150]);
  test('nouvelle commande avec une ligne d\'un produit non vendable (produitId) : REFUSÉE', !!e && /PRODUIT NON VENDABLE/.test(e), e);
  e = await echec('collab', insCmd, ['#TEST-C3', 'x', JSON.stringify([{ produit: 'matelas nouveau N (FICTIF)', qte: 1, prixUnit: 150 }]), 150]);
  test('nouvelle commande : ligne SANS produitId au nom (normalisé) d\'un produit non vendable : REFUSÉE', !!e && /PRODUIT NON VENDABLE/.test(e), e);
  e = await echec('collab', insCmd, ['#TEST-C4', 'Matelas Nouveau N (fictif)', null, 150]);
  test('nouvelle commande SANS lignes, produit principal non vendable : REFUSÉE', !!e && /PRODUIT NON VENDABLE/.test(e), e);
  e = await echec('collab', insCmd, ['#TEST-C5', 'x', JSON.stringify([L('pr-a', 'Matelas Fictif A 140x190', 1, 199, { sku: 'mc-test-n' })]), 199]);
  test('identifiant et nom vendables + sku d\'un produit non vendable : REFUSÉE (ligne contradictoire)', !!e && /PRODUIT NON VENDABLE/.test(e), e);
  e = await echec('collab', insCmd, ['#TEST-C6', 'x', JSON.stringify([{ produit: 'Article TikTok', _ugs: 'MC-TEST-N', qte: 1, prixUnit: 150 }]), 150]);
  test('ligne TikTok dont l\'UGS est la référence interne d\'un produit non vendable : REFUSÉE', !!e && /PRODUIT NON VENDABLE/.test(e), e);
  e = await echec('collab', insCmd, ['#TEST-C7', 'x', JSON.stringify([L('pr-a', 'Matelas Fictif A 140x190', 1, 199)]), 199]);
  test('nouvelle commande d\'un produit vendable : acceptée', e === null, e);
  e = await echec('collab', insCmd, ['#TEST-C8', 'Ensemble Fictif A + B', null, 279]);
  test('nouvelle commande sans lignes d\'un ENSEMBLE devenu non vendable (composant retiré) : REFUSÉE', !!e && /PRODUIT NON VENDABLE/.test(e), e);
  e = await echec('collab', insCmd, ['#TEST-C9', 'Reprise — matelas usagé', null, 0]);
  test('commande sans lignes au libellé libre : acceptée', e === null, e);

  // commande DÉJÀ PRISE (créée quand le sommier était vendable, chargée côté serveur) qui contient maintenant un produit non vendable
  const lignesC1 = [L('pr-b', 'Sommier Fictif B 140x190', 1, 99), L('pr-a', 'Matelas Fictif A 140x190', 1, 199)];
  await q('proprio', 'alter table public.commandes disable trigger commandes_produit_vendable_garde');
  await q('proprio', "insert into public.commandes (id, client, produit, lignes, qte, prix, remise_globale, remise_globale_val, remise_globale_type) values ('#TEST-C1', 'Client Fictif', 'Sommier Fictif B 140x190', $1::jsonb, 1, 298, 0, 0, 'pct')", [JSON.stringify(lignesC1)]);
  await q('proprio', 'alter table public.commandes enable trigger commandes_produit_vendable_garde');
  const majLignes = (lg) => echec('collab', "update public.commandes set lignes = $1::jsonb where id = '#TEST-C1'", [JSON.stringify(lg)]);
  e = await echec('collab', "update public.commandes set statut = 'livré' where id = '#TEST-C1'");
  test('commande existante avec produit non vendable : changement de statut accepté', e === null, e);
  e = await majLignes([L('pr-a', 'Matelas Fictif A 140x190', 2, 199), L('pr-b', 'Sommier Fictif B 140x190', 1, 99)]);
  test('lignes réordonnées, ligne vendable modifiée, ligne figée identique : acceptée', e === null, e);
  e = await majLignes([L('pr-a', 'Matelas Fictif A 140x190', 2, 199), L('pr-b', 'Sommier Fictif B 140x190', 1, 99, { prixBrut: 98.999999999, sousTotal: 99.0000001 })]);
  test('ligne figée recalculée avec un écart d\'arrondi (< demi-centime) : acceptée', e === null, e);
  e = await majLignes([L('pr-a', 'Matelas Fictif A 140x190', 2, 199), L('pr-b', 'Sommier Fictif B 140x190', 2, 99)]);
  test('quantité de la ligne figée modifiée : REFUSÉE', !!e && /ligne ajoutée, quantité ou prix modifié/.test(e), e);
  e = await majLignes([L('pr-a', 'Matelas Fictif A 140x190', 2, 199), L('pr-b', 'Sommier Fictif B 140x190', 1, 89)]);
  test('prix de la ligne figée modifié : REFUSÉ', !!e && /PRODUIT NON VENDABLE/.test(e), e);
  e = await majLignes([L('pr-a', 'Matelas Fictif A 140x190', 2, 199), L('pr-b', 'Sommier Fictif B 140x190', 1, 99), L('pr-b', 'Sommier Fictif B 140x190', 1, 99)]);
  test('ligne du produit non vendable ajoutée en double : REFUSÉE', !!e && /PRODUIT NON VENDABLE/.test(e), e);
  e = await majLignes([L('pr-a', 'Matelas Fictif A 140x190', 2, 199), L('pr-b', 'Sommier Fictif B 140x190', 1, 99), L('pr-n', 'Matelas Nouveau N (fictif)', 1, 150)]);
  test('ligne d\'un AUTRE produit non vendable ajoutée : REFUSÉE', !!e && /Matelas Nouveau N/.test(e), e);
  e = await echec('collab', "update public.commandes set remise_globale = 10, remise_globale_val = 10, remise_globale_type = 'eur' where id = '#TEST-C1'");
  test('remise globale modifiée tant que la ligne figée est là : REFUSÉE', !!e && /remise globale/.test(e), e);
  e = await echec('collab', "update public.commandes set remise_globale_type = 'eur' where id = '#TEST-C1'");
  test('type de remise globale seul modifié : REFUSÉ', !!e && /remise globale/.test(e), e);
  e = await echec('collab', "update public.commandes set remise_motif = 'geste commercial' where id = '#TEST-C1'");
  test('motif de remise (texte) modifié : accepté', e === null, e);
  const upsertCmd = `insert into public.commandes (id, client, produit, lignes, qte, prix, remise_globale, remise_globale_val, remise_globale_type)
    values ('#TEST-C1', 'Client Fictif', 'Sommier Fictif B 140x190', $1::jsonb, 1, 298, $2, $2, 'pct')
    on conflict (id) do update set client = excluded.client, produit = excluded.produit, lignes = excluded.lignes, qte = excluded.qte,
      prix = excluded.prix, remise_globale = excluded.remise_globale, remise_globale_val = excluded.remise_globale_val, remise_globale_type = excluded.remise_globale_type`;
  e = await echec('collab', upsertCmd, [JSON.stringify([L('pr-a', 'Matelas Fictif A 140x190', 2, 199), L('pr-b', 'Sommier Fictif B 140x190', 1, 99)]), 0]);
  test('upsert (sbSaveCommande) de la commande existante, ligne figée identique : accepté', e === null, e);
  e = await echec('collab', upsertCmd, [JSON.stringify([L('pr-a', 'Matelas Fictif A 140x190', 2, 199), L('pr-b', 'Sommier Fictif B 140x190', 3, 99)]), 0]);
  test('upsert avec la ligne figée modifiée : REFUSÉ', !!e && /PRODUIT NON VENDABLE/.test(e), e);
  e = await echec('collab', upsertCmd, [JSON.stringify([L('pr-a', 'Matelas Fictif A 140x190', 2, 199), L('pr-b', 'Sommier Fictif B 140x190', 1, 99)]), 5]);
  test('upsert avec la remise globale modifiée : REFUSÉ', !!e && /remise globale/.test(e), e);
  e = await majLignes([L('pr-a', 'Matelas Fictif A 140x190', 2, 199)]);
  test('TOUTES les lignes du produit non vendable retirées : accepté', e === null, e);
  e = await echec('collab', "update public.commandes set remise_globale = 10, remise_globale_val = 10, remise_globale_type = 'eur' where id = '#TEST-C1'");
  test('… la remise globale est alors libre', e === null, e);
  e = await majLignes([L('pr-a', 'Matelas Fictif A 140x190', 2, 199), L('pr-b', 'Sommier Fictif B 140x190', 1, 99)]);
  test('ligne du produit non vendable remise après retrait : REFUSÉE', !!e && /PRODUIT NON VENDABLE/.test(e), e);
  const c1 = await un('proprio', "select lignes, remise_globale::float8 as rg from public.commandes where id = '#TEST-C1'");
  test('état final de la commande = dernières écritures acceptées seulement', c1.lignes.length === 1 && c1.rg === 10, c1);

  // =========================================================================================================================
  console.log('\n5. DROITS PAR RÔLE (nouvelles tables, fonctions, séquence)');
  // arrivage FICTIF chargé côté serveur (comme le fichier privé de chargement : service_role)
  // ARR-TEST-1 : taux 1,1 provisoire, frais 90 € HT pour 90 unités attendues (1 €/unité)
  const arr1 = (await un('service_role', "insert into public.arrivages (reference_interne, devise, taux_change, taux_provisoire, frais_import_ht) values ('ARR-TEST-1', 'USD', 1.1, true, 90) returning id")).id;
  await q('service_role', `insert into public.arrivage_lignes (arrivage_id, produit_id, quantite_attendue, fob_unitaire, revient_unitaire_ht) values
    ($1, 'pr-a', 30, 10.5, 12.554), ($1, 'pr-c', 20, 5, null), ($1, 'pr-n', 40, 20, null)`, [arr1]);
  const lignes1 = await q('proprio', 'select id, produit_id from public.arrivage_lignes where arrivage_id = $1 order by produit_id', [arr1]);
  const idL = Object.fromEntries(lignes1.map(l => [l.produit_id, Number(l.id)]));
  for (const t of ['arrivages', 'arrivage_lignes', 'produits_revient', 'prix_revient_historique']) {
    const nAdmin = (await q('admin', 'select * from public.' + t)).length;
    const nCollab = (await q('collab', 'select * from public.' + t)).length;
    const nLiv = (await q('livreur', 'select * from public.' + t)).length;
    const nAnon = (await q('anon', 'select * from public.' + t)).length;
    const eAuth = await echec('authenticated', 'select * from public.' + t);
    const nTotal = await compte('public.' + t);
    test(t + ' : lecture admin seulement (admin ' + nAdmin + '/' + nTotal + ', collab ' + nCollab + ', livreur ' + nLiv + ', anon ' + nAnon + ', authenticated refusé)',
      (nTotal === 0 || nAdmin === nTotal) && nCollab === 0 && nLiv === 0 && nAnon === 0 && !!eAuth && /permission denied/.test(eAuth), { nAdmin, nTotal, eAuth });
    const eIns = await echec('admin', 'delete from public.' + t);
    test(t + ' : aucune écriture directe, même administrateur (suppression refusée)', !!eIns && /permission denied/.test(eIns), eIns);
  }
  e = await echec('admin', 'update public.arrivage_lignes set fob_unitaire = 0');
  test('administrateur : modification directe d\'une ligne d\'arrivage refusée', !!e && /permission denied/.test(e), e);
  e = await echec('admin', "insert into public.produits_revient (produit_id, prix_revient_ht, methode) values ('pr-b', 1, 'CUMP')");
  test('administrateur : écriture directe du revient refusée (tout passe par les fonctions)', !!e && /permission denied/.test(e), e);
  const se = await q('collab', 'select * from public.stock_entrant() order by produit_id');
  test('stock_entrant() collaboratrice : quantités attendues, SANS aucun prix (3 colonnes)', se.length === 3 && Object.keys(se[0]).join(',') === 'produit_id,quantite,arrivages'
    && se.map(r => r.produit_id + ':' + r.quantite).join(' ') === 'pr-a:30 pr-c:20 pr-n:40', se);
  test('stock_entrant() administrateur : mêmes lignes', (await q('admin', 'select * from public.stock_entrant()')).length === 3);
  test('stock_entrant() livreur et anon sans session : rien', (await q('livreur', 'select * from public.stock_entrant()')).length === 0 && (await q('anon', 'select * from public.stock_entrant()')).length === 0);
  e = await echec('authenticated', 'select * from public.stock_entrant()');
  test('stock_entrant() authenticated : exécution refusée', !!e && /permission denied/.test(e), e);
  for (const qui of ['collab', 'livreur', 'anon', 'service_role']) {
    const r1 = await rpc(qui, 'select public.valider_reception_arrivage($1, $2::jsonb, $3) as r', [arr1, '[]', 'x']);
    const r2 = await rpc(qui, 'select public.recalculer_revient_arrivage($1, 1.2) as r', [arr1]);
    test(qui + ' : valider_reception_arrivage et recalculer_revient_arrivage refusés (session_admin_requise)', r1.erreur === 'session_admin_requise' && r2.erreur === 'session_admin_requise', { r1, r2 });
  }
  e = await echec('authenticated', 'select public.valider_reception_arrivage($1, $2::jsonb, $3)', [arr1, '[]', 'x']);
  const e2 = await echec('authenticated', 'select public.recalculer_revient_arrivage($1, 1.2)', [arr1]);
  test('authenticated : les deux fonctions refusées à l\'exécution', /permission denied/.test(e || '') && /permission denied/.test(e2 || ''), { e, e2 });
  e = await echec('anon', "select interne.produit_non_vendable('pr-n')");
  test('fonctions internes (schéma interne) : inaccessibles au navigateur', !!e && /permission denied/.test(e), e);
  e = await echec('admin', "select nextval('public.arrivages_ordre_reception_seq')");
  test('séquence de l\'ordre de réception : inaccessible au navigateur (même admin)', !!e && /permission denied/.test(e), e);
  const ae = await q('admin', 'select prix_revient_ht from public.produits_revient');
  test('administrateur : lit le revient', ae.length === 1);
  test('collaboratrice : revient invisible (produits_revient vide pour elle)', (await q('collab', 'select * from public.produits_revient')).length === 0);
  test('aucune colonne de revient dans produits (lisible par collab et livreur)', !(await q('proprio', "select column_name from information_schema.columns where table_name = 'produits'")).some(c => /revient/.test(c.column_name)));

  // =========================================================================================================================
  console.log('\n6. RÉCEPTION valider_reception_arrivage (atomique, empreinte, revient calculé par la base)');
  const saisie = (o) => JSON.stringify(Object.entries(o).map(([pid, [r, d, m]]) => ({ ligne_id: idL[pid], recue: r, endommagee: d, manquante: m })));
  const bonne = { 'pr-a': [28, 1, 1], 'pr-c': [20, 0, 0], 'pr-n': [38, 2, 0] };
  const valider = (qui, s, emp) => rpc(qui || 'admin', 'select public.valider_reception_arrivage($1, $2::jsonb, $3) as r', [arr1, s, emp]);
  let emp = await empreinte(arr1);
  test('empreinte v2 de l\'arrivage (aperçu) : stock actuel compris', /^v2\|CUMP\|1\.100000\|90\.00\|t\|/.test(emp) && emp.includes(':pr-a:30:10.5000:12.5540:12.0000:f:10'), emp);
  let avant = await photo();
  let r = await valider('admin', saisie(bonne), 'v2|faux');
  test('empreinte différente de l\'aperçu : REFUS « valorisation_modifiee », AUCUNE écriture', r.erreur === 'valorisation_modifiee' && (await photo()) === avant, r);
  r = await valider('admin', saisie(bonne), '');
  test('empreinte absente : REFUS « empreinte_requise »', r.erreur === 'empreinte_requise', r);
  // vente entre l'aperçu et la validation : le stock change, donc le CUMP aussi
  await q('admin', "update public.produits set stock = 9 where id = 'pr-a'");
  avant = await photo();
  r = await valider('admin', saisie(bonne), emp);
  test('stock modifié entre l\'aperçu et la validation : REFUS, AUCUNE écriture', r.erreur === 'valorisation_modifiee' && (await photo()) === avant, r);
  await q('admin', "update public.produits set stock = 10 where id = 'pr-a'");
  test('stock rétabli : l\'empreinte de l\'aperçu redevient valable', (await empreinte(arr1)) === emp);
  // ERREUR SUR LA DERNIÈRE LIGNE (ordre de traitement : produit_id ; pr-n est la dernière) : rien ne doit rester des deux premières
  avant = await photo();
  e = await echec('admin', 'select public.valider_reception_arrivage($1, $2::jsonb, $3)', [arr1, saisie({ 'pr-a': [28, 1, 1], 'pr-c': [20, 0, 0], 'pr-n': [38, 1, 0] }), emp]);
  test('total faux sur la DERNIÈRE ligne : exception (CONTRÔLE … ≠ attendu)', !!e && /CONTRÔLE : ligne/.test(e), e);
  test('… ATOMIQUE : aucun stock, mouvement, entrée, revient, historique ni statut écrit pour les lignes précédentes', (await photo()) === avant);
  e = await echec('admin', 'select public.valider_reception_arrivage($1, $2::jsonb, $3)', [arr1, JSON.stringify([{ ligne_id: idL['pr-a'], recue: 28, endommagee: 1, manquante: 1 }, { ligne_id: idL['pr-c'], recue: 20, endommagee: 0, manquante: 0 }, { ligne_id: idL['pr-n'], recue: 38, endommagee: 2 }]), emp]);
  test('quantité « manquante » absente sur la dernière ligne : exception, aucune écriture', !!e && /trois quantités/.test(e) && (await photo()) === avant, e);
  e = await echec('admin', 'select public.valider_reception_arrivage($1, $2::jsonb, $3)', [arr1, JSON.stringify([{ ligne_id: idL['pr-a'], recue: 28, endommagee: 1, manquante: 1 }, { ligne_id: idL['pr-c'], recue: 20, endommagee: 0, manquante: 0 }, { ligne_id: 999999, recue: 38, endommagee: 2, manquante: 0 }]), emp]);
  test('saisie de la dernière ligne sous un identifiant inconnu : exception, aucune écriture', !!e && /SAISIE MANQUANTE/.test(e) && (await photo()) === avant, e);
  e = await echec('admin', 'select public.valider_reception_arrivage($1, $2::jsonb, $3)', [arr1, JSON.stringify([{ ligne_id: idL['pr-a'], recue: 28, endommagee: 1, manquante: 1 }, { ligne_id: idL['pr-c'], recue: 20, endommagee: 0, manquante: 0 }, { ligne_id: idL['pr-n'], recue: 'beaucoup', endommagee: 2, manquante: 0 }]), emp]);
  test('quantité non numérique sur la dernière ligne : exception, aucune écriture', !!e && /SAISIE INVALIDE/.test(e) && (await photo()) === avant, e);
  r = await valider('admin', saisie({ 'pr-a': [28, 1, 1], 'pr-c': [20, 0, 0] }), emp);
  test('une saisie manquante (2 lignes sur 3) : REFUS « une_saisie_par_ligne_requise »', r.erreur === 'une_saisie_par_ligne_requise' && (await photo()) === avant, r);
  // revient chargé qui contredit FOB × taux + frais (sur la DERNIÈRE ligne)
  await q('service_role', 'update public.arrivage_lignes set revient_unitaire_ht = 15 where id = $1', [idL['pr-n']]);
  const empInc = await empreinte(arr1); avant = await photo();
  e = await echec('admin', 'select public.valider_reception_arrivage($1, $2::jsonb, $3)', [arr1, saisie(bonne), empInc]);
  test('revient chargé incohérent sur la dernière ligne (15 ≠ 20 × 1,1 + 1) : exception, aucune écriture', !!e && /REVIENT INCOHÉRENT/.test(e) && (await photo()) === avant, e);
  await q('service_role', 'update public.arrivage_lignes set revient_unitaire_ht = null where id = $1', [idL['pr-n']]);
  test('revient de la ligne remis à vide : empreinte de l\'aperçu d\'origine valable', (await empreinte(arr1)) === emp);
  await q('service_role', 'update public.arrivages set taux_change = null where id = $1', [arr1]);
  r = await valider('admin', saisie(bonne), await empreinte(arr1));
  test('taux de change absent : REFUS « taux_manquant »', r.erreur === 'taux_manquant', r);
  await q('service_role', 'update public.arrivages set taux_change = 1.1 where id = $1', [arr1]);
  // VALIDATION RÉUSSIE
  const mvtsAvant = await compte('public.mouvements_stock');
  r = await valider('admin', saisie(bonne), emp);
  test('validation réussie (ok, méthode CUMP, total reçu 86)', r.ok === true && r.methode === 'CUMP' && r.total_recu === 86, r);
  const pa = await produit('pr-a'), pc = await produit('pr-c'), pn = await produit('pr-n');
  test('stock : seuls les reçus en BON état sont ajoutés (pr-a 10+28, pr-c 12+20, pr-n 2+38)', pa.stock === 38 && pc.stock === 32 && pn.stock === 40, [pa.stock, pc.stock, pn.stock]);
  test('produit non vendable reçu et stocké, toujours non vendable', !pn.vendable && pn.prix === null);
  const lg = await q('proprio', 'select produit_id, quantite_recue, quantite_endommagee, quantite_manquante, revient_unitaire_ht::float8 as rv from public.arrivage_lignes where arrivage_id = $1 order by produit_id', [arr1]);
  test('revient de chaque lot CALCULÉ par la base (12,554 chargé → 12,55 ; vides → 6,5 et 23)', lg.map(l => l.rv).join(' ') === '12.55 6.5 23', lg);
  test('quantités reçues / endommagées / manquantes enregistrées', lg[0].quantite_recue === 28 && lg[0].quantite_endommagee === 1 && lg[0].quantite_manquante === 1 && lg[2].quantite_endommagee === 2);
  const rev = Object.fromEntries((await q('proprio', 'select produit_id, prix_revient_ht::float8 as v, provisoire from public.produits_revient')).map(x => [x.produit_id, x]));
  const cumpA = r4((10 * 12 + 28 * 12.55) / 38);
  test('CUMP pr-a = (10 × 12 + 28 × 12,55) / 38 = ' + cumpA + ' (provisoire : taux provisoire)', rev['pr-a'].v === cumpA && rev['pr-a'].provisoire === true, rev['pr-a']);
  test('pr-c (12 en stock SANS revient) : coût du lot appliqué à tout le stock = 6,5 (décision B)', rev['pr-c'].v === 6.5, rev['pr-c']);
  test('pr-n (2 unités déjà en stock, sans revient) : coût du lot = 23', rev['pr-n'].v === 23, rev['pr-n']);
  const hist = Object.fromEntries((await q('proprio', 'select produit_id, revient_ht::float8 as lot, quantite, stock_avant, revient_moyen_avant::float8 as av, revient_moyen_apres::float8 as ap, revient_initial_approxime as approx, provisoire from public.prix_revient_historique where arrivage_id = $1', [arr1])).map(x => [x.produit_id, x]));
  test('historique : une ligne par lot reçu (3), stock avant et revient avant/après enregistrés', Object.keys(hist).length === 3 && hist['pr-a'].stock_avant === 10 && hist['pr-a'].av === 12 && hist['pr-a'].ap === cumpA && hist['pr-a'].quantite === 28, hist);
  test('revient_initial_approxime : VRAI pour pr-c et pr-n (stock existant sans revient), FAUX pour pr-a (revient connu)', hist['pr-c'].approx === true && hist['pr-n'].approx === true && hist['pr-a'].approx === false, hist);
  const rl = Object.fromEntries(r.lignes.map(x => [x.produit_id, x]));
  test('réponse de la fonction : revient_initial_approxime renvoyé pour l\'aperçu', rl['pr-c'].revient_initial_approxime === true && rl['pr-a'].revient_initial_approxime === false, r.lignes);
  const mv = await q('proprio', "select type, produit_libelle, quantite, source, destination from public.mouvements_stock where source = 'arrivage:ARR-TEST-1' order by produit_libelle");
  test('mouvements_stock : 3 entrées « entree », source arrivage:ARR-TEST-1, vers le dépôt', (await compte('public.mouvements_stock')) === mvtsAvant + 3 && mv.length === 3 && mv.every(m => m.type === 'entree' && m.destination === 'depot'), mv);
  const ent = await q('proprio', "select app_produit_id, quantite, motif from public.stock_entrees order by app_produit_id");
  test('stock_entrees : 3 entrées motif arrivage:ARR-TEST-1 (lues par stock-sync-shopify)', ent.length === 3 && ent.every(x => x.motif === 'arrivage:ARR-TEST-1') && ent.map(x => x.quantite).join(',') === '28,20,38', ent);
  const a1 = await un('proprio', 'select statut, ordre_reception, recu_le, recu_par from public.arrivages where id = $1', [arr1]);
  test('arrivage passé « recu », ordre de réception tiré, date et auteur', a1.statut === 'recu' && a1.ordre_reception !== null && a1.recu_le !== null && a1.recu_par === 'admin', a1);
  e = await echec('service_role', "insert into public.stock_entrees (app_produit_id, quantite, motif) values ('pr-a', 1, 'autre_motif')");
  test('contrainte élargie de stock_entrees.motif : motif inconnu toujours refusé', !!e && /stock_entrees_motif_check/.test(e), e);
  // RELECTURE SOUS VERROU statut_reception_arrivage (revue Codex PR 26 sur ce01159) : appel, résultat, droits. La CONCURRENCE réelle
  // (une réception encore en cours dans une autre connexion, que la relecture doit attendre) est HORS DE PORTÉE de pglite (une seule
  // connexion) : elle est garantie par le même premier verrou (select … for update sur l'arrivage), vérifié par l'auto-contrôle 039.
  {
    const st = await rpc('admin', 'select public.statut_reception_arrivage($1) as r', [arr1]);
    const nbH = await compte('public.prix_revient_historique', "arrivage_id = $1 and source = 'arrivage'", [arr1]);
    const nbM = await compte('public.mouvements_stock', "source = 'arrivage:ARR-TEST-1'");
    test('statut_reception_arrivage (admin) après réception : « recu », date, historique, mouvements et quantité de CET arrivage',
      st && st.ok === true && st.statut === 'recu' && !!st.recu_le && st.historique === nbH && nbH > 0 && st.mouvements === nbM && nbM > 0 && st.quantite === 86, st);
    avant = await photo();
    await rpc('admin', 'select public.statut_reception_arrivage($1) as r', [arr1]);
    test('… lecture seule : aucune écriture (le verrou sert seulement à attendre)', (await photo()) === avant);
    for (const qui of ['collab', 'livreur', 'anon']) {
      const x = await rpc(qui, 'select public.statut_reception_arrivage($1) as r', [arr1]);
      test('statut_reception_arrivage refusé hors administrateur (' + qui + ') : « session_admin_requise », aucun statut', x && x.ok === false && x.erreur === 'session_admin_requise' && x.statut === undefined, x);
    }
    e = await echec('authenticated', 'select public.statut_reception_arrivage($1)', [arr1]);
    test('statut_reception_arrivage : authenticated n\'a pas le droit d\'exécution', !!e && /permission denied/i.test(e), e);
    const intro = await rpc('admin', 'select public.statut_reception_arrivage($1) as r', [999999]);
    test('statut_reception_arrivage : arrivage inconnu -> « arrivage_introuvable »', intro && intro.ok === false && intro.erreur === 'arrivage_introuvable', intro);
    const def = await un('proprio', "select p.prosecdef as d, p.provolatile as v, p.prosrc as s from pg_proc p where p.proname = 'statut_reception_arrivage'");
    test('statut_reception_arrivage : SECURITY DEFINER, VOLATILE, même premier verrou que la réception (for update sur l\'arrivage), attente bornée',
      def.d === true && def.v === 'v' && /from public\.arrivages where id = p_arrivage_id for update/.test(def.s) && /lock_timeout', '2s'/.test(def.s) && /lock_not_available/.test(def.s));
  }
  // DOUBLE VALIDATION (concurrence simulée : pglite n'a qu'une connexion, les deux appels sont successifs)
  avant = await photo();
  r = await valider('admin', saisie(bonne), emp);
  test('2e validation du même arrivage (même aperçu) : REFUS « arrivage_deja_traite », AUCUNE écriture', r.erreur === 'arrivage_deja_traite' && r.statut === 'recu' && (await photo()) === avant, r);

  // =========================================================================================================================
  console.log('\n7. CORRECTION DE TAUX recalculer_revient_arrivage (rejeu, historique, rupture de continuité)');
  // 2e lot de pr-a (ARR-TEST-2, taux provisoire 1,1, sans frais) reçu APRÈS ARR-TEST-1
  const arr2 = (await un('service_role', "insert into public.arrivages (reference_interne, taux_change, taux_provisoire, frais_import_ht) values ('ARR-TEST-2', 1.1, true, 0) returning id")).id;
  await q('service_role', "insert into public.arrivage_lignes (arrivage_id, produit_id, quantite_attendue, fob_unitaire) values ($1, 'pr-a', 5, 20)", [arr2]);
  const l2 = (await un('proprio', 'select id from public.arrivage_lignes where arrivage_id = $1', [arr2])).id;
  { const st = await rpc('admin', 'select public.statut_reception_arrivage($1) as r', [arr2]);
    test('statut_reception_arrivage (admin) avant réception : « en_attente », aucun historique ni mouvement', st && st.ok === true && st.statut === 'en_attente' && st.historique === 0 && st.mouvements === 0 && st.quantite === 0 && st.recu_le === null, st); }
  r = await rpc('admin', 'select public.valider_reception_arrivage($1, $2::jsonb, $3) as r', [arr2, JSON.stringify([{ ligne_id: Number(l2), recue: 5, endommagee: 0, manquante: 0 }]), await empreinte(arr2)]);
  const cumpA2 = r4((38 * cumpA + 5 * 22) / 43);
  test('2e lot pr-a : CUMP = (38 × ' + cumpA + ' + 5 × 22) / 43 = ' + cumpA2, r.ok && (await un('proprio', "select prix_revient_ht::float8 as v from public.produits_revient where produit_id = 'pr-a'")).v === cumpA2, r);
  r = await rpc('admin', 'select public.recalculer_revient_arrivage($1, 0) as r', [arr1]);
  test('taux nul : REFUS « taux_invalide »', r.erreur === 'taux_invalide', r);
  r = await rpc('admin', 'select public.recalculer_revient_arrivage($1, 101) as r', [arr1]);
  test('taux > 100 : REFUS « taux_invalide »', r.erreur === 'taux_invalide', r);
  // correction du taux du 1er arrivage (1,2) alors qu'un lot plus récent existe : rejeu complet
  const nHist = await compte('public.prix_revient_historique');
  r = await rpc('admin', 'select public.recalculer_revient_arrivage($1, 1.2) as r', [arr1]);
  const lotA = r4(10.5 * 1.2 + 1), rejA1 = r4((10 * 12 + 28 * lotA) / 38), rejA2 = r4((38 * rejA1 + 5 * 22) / 43);
  const ra = (r && r.lignes || []).find(x => x.produit_id === 'pr-a');
  test('correction ARR-TEST-1 à 1,2 : lot pr-a = 10,5 × 1,2 + 1 = ' + lotA + ', 2 lots rejoués, revient = ' + rejA2, r.ok && ra && ra.revient_lot === lotA && ra.lots_rejoues === 2 && ra.revient_produit === rejA2, r);
  test('… revient du produit encore provisoire (le 2e lot l\'est toujours)', ra && ra.revient_provisoire === true, ra);
  const revC = (await un('proprio', "select prix_revient_ht::float8 as v, provisoire from public.produits_revient where produit_id = 'pr-c'"));
  test('pr-c : nouveau revient 5 × 1,2 + 1 = 7, définitif', revC.v === 7 && revC.provisoire === false, revC);
  test('historique : 3 lignes de correction ajoutées, rien de réécrit', (await compte('public.prix_revient_historique')) === nHist + 3);
  const corr = await q('proprio', "select o.id, o.remplace_par, o.revient_ht::float8 as ancien, c.revient_ht::float8 as nouveau, c.corrige_id, c.revient_initial_approxime as approx from public.prix_revient_historique o join public.prix_revient_historique c on c.id = o.remplace_par where o.arrivage_id = $1 and o.produit_id = 'pr-c'", [arr1]);
  test('ligne d\'origine reliée à sa correction (remplace_par / corrige_id), valeurs d\'origine intactes, approximation tracée', corr.length === 1 && corr[0].ancien === 6.5 && corr[0].nouveau === 7 && Number(corr[0].corrige_id) === Number(corr[0].id) && corr[0].approx === true, corr);
  test('arrivage : taux définitif enregistré', (await un('proprio', 'select taux_change::float8 as t, taux_provisoire from public.arrivages where id = $1', [arr1])).taux_provisoire === false);
  test('lignes d\'arrivage : revient recalculé', (await un('proprio', 'select revient_unitaire_ht::float8 as v from public.arrivage_lignes where id = $1', [idL['pr-a']])).v === lotA);
  r = await rpc('admin', 'select public.recalculer_revient_arrivage($1, 1.3) as r', [arr1]);
  test('2e correction du même arrivage : REFUS « taux_deja_definitif »', r.erreur === 'taux_deja_definitif', r);
  // correction du 2e arrivage APRÈS celle du 1er : la continuité doit être reconnue (le rejeu tient compte de la 1re correction)
  r = await rpc('admin', 'select public.recalculer_revient_arrivage($1, 1.0) as r', [arr2]);
  const rejB = r4((38 * rejA1 + 5 * 20) / 43);
  test('correction ARR-TEST-2 après celle d\'ARR-TEST-1 : continuité reconnue, revient = ' + rejB + ', définitif', r.ok && r.lignes[0].revient_produit === rejB && r.lignes[0].revient_provisoire === false, r);
  // RUPTURE DE CONTINUITÉ : le revient courant est modifié HORS historique (écriture directe côté serveur)
  const arr3 = (await un('service_role', "insert into public.arrivages (reference_interne, taux_change, taux_provisoire, frais_import_ht) values ('ARR-TEST-3', 1.1, true, 0) returning id")).id;
  await q('service_role', "insert into public.arrivage_lignes (arrivage_id, produit_id, quantite_attendue, fob_unitaire) values ($1, 'pr-c', 10, 4), ($1, 'pr-b', 4, 30)", [arr3]);
  const l3 = await q('proprio', 'select id from public.arrivage_lignes where arrivage_id = $1 order by produit_id', [arr3]);
  r = await rpc('admin', 'select public.valider_reception_arrivage($1, $2::jsonb, $3) as r', [arr3, JSON.stringify(l3.map((x, i) => ({ ligne_id: Number(x.id), recue: i ? 10 : 4, endommagee: 0, manquante: 0 }))), await empreinte(arr3)]);
  test('ARR-TEST-3 reçu (pr-b, pr-c)', r.ok === true, r);
  test('pr-b (stock VIDE, sans revient) : revient_initial_approxime FAUX', r.lignes.find(x => x.produit_id === 'pr-b').revient_initial_approxime === false, r.lignes);
  await q('service_role', "update public.produits_revient set prix_revient_ht = 99 where produit_id = 'pr-c'");
  avant = await photo();
  r = await rpc('admin', 'select public.recalculer_revient_arrivage($1, 1.2) as r', [arr3]);
  test('revient de pr-c modifié hors historique : REFUS « rupture_continuite », produit listé', r.erreur === 'rupture_continuite' && r.produits.length === 1 && r.produits[0].produit_id === 'pr-c' && Number(r.produits[0].revient_courant) === 99, r);
  test('… AUCUNE écriture (lignes, revients, historique, taux de l\'arrivage)', (await photo()) === avant);
  await q('service_role', "delete from public.produits_revient where produit_id = 'pr-b'");
  await q('service_role', "update public.produits_revient set prix_revient_ht = $1 where produit_id = 'pr-c'", [r4((32 * 7 + 10 * 4.4) / 42)]);
  avant = await photo();
  r = await rpc('admin', 'select public.recalculer_revient_arrivage($1, 1.2) as r', [arr3]);
  test('ligne de revient d\'un produit SUPPRIMÉE hors historique : REFUS « rupture_continuite » (pr-b), aucune écriture', r.erreur === 'rupture_continuite' && r.produits.length === 1 && r.produits[0].produit_id === 'pr-b' && (await photo()) === avant, r);
  await q('service_role', "insert into public.produits_revient (produit_id, prix_revient_ht, methode, provisoire) values ('pr-b', 33, 'CUMP', true)");
  r = await rpc('admin', 'select public.recalculer_revient_arrivage($1, 1.2) as r', [arr3]);
  test('continuité rétablie : correction acceptée (pr-c = (32 × 7 + 10 × 4,8) / 42)', r.ok === true && r.lignes.find(x => x.produit_id === 'pr-c').revient_produit === r4((32 * 7 + 10 * 4.8) / 42), r);
  // arrivage EN ATTENTE : seules les lignes changent
  const arr4 = (await un('service_role', "insert into public.arrivages (reference_interne, taux_change, taux_provisoire, frais_import_ht) values ('ARR-TEST-4', 1.1, true, 8) returning id")).id;
  await q('service_role', "insert into public.arrivage_lignes (arrivage_id, produit_id, quantite_attendue, fob_unitaire) values ($1, 'pr-a', 4, 10)", [arr4]);
  avant = await compte('public.prix_revient_historique');
  r = await rpc('admin', 'select public.recalculer_revient_arrivage($1, 1.25) as r', [arr4]);
  test('arrivage en attente : seule la ligne change (10 × 1,25 + 2 = 14,5), aucun historique', r.ok && r.lignes[0].revient_lot === 14.5 && (await compte('public.prix_revient_historique')) === avant, r);
  // historique en AJOUT SEUL
  e = await echec('service_role', 'update public.prix_revient_historique set revient_ht = 0');
  test('historique : modification refusée (même serveur)', !!e && /modification interdite/.test(e), e);
  e = await echec('service_role', 'delete from public.prix_revient_historique');
  test('historique : suppression refusée (même serveur)', !!e && /suppression interdite/.test(e), e);
  e = await echec('service_role', "update public.prix_revient_historique set remplace_par = id where source = 'recalcul_taux' and remplace_par is null");
  test('historique : relier une ligne déjà définitive refusé', !!e && /modification interdite/.test(e), e);

  // =========================================================================================================================
  console.log('\n8. ADMINISTRATEUR : fixer le prix d\'un nouveau produit (flux « définir le prix »)');
  e = await echec('admin', "update public.produits set prix = 349, prix_vente_defini = true, vendable = true where id = 'pr-n'");
  p = await produit('pr-n');
  test('administrateur fixe le prix (349) : produit vendable', e === null && p.prix === 349 && p.prix_vente_defini && p.vendable, { e, p });
  e = await echec('collab', insCmd, ['#TEST-C10', 'x', JSON.stringify([L('pr-n', 'Matelas Nouveau N (fictif)', 1, 349)]), 349]);
  test('… il peut alors être commandé', e === null, e);
  e = await echec('service_role', "insert into public.stock_correspondance (shopify_variant_id, app_produit_id, fiabilite) values (1004, 'pr-n', 'certaine')");
  test('… et relié à une variante Shopify « certaine »', e === null, e);

  // =========================================================================================================================
  console.log('\n9. ENSEMBLES IMBRIQUÉS ET CYCLES : composition contrôlée EN ENTIER (revue Codex PR 26 sur ce01159, point 2)');
  const nv = async (id) => (await un('proprio', 'select interne.produit_non_vendable($1) as nv', [id])).nv;
  const J = (ids) => JSON.stringify(ids.map((id) => ({ id, qte: 1 })));
  await q('service_role', "insert into public.produits (id, nom, cat, prix, stock, prix_vente_defini, vendable) values ('pr-zx', 'Matelas Fictif ZX à définir', 'Matelas', null, 0, false, false)");
  await q('service_role', "insert into public.produits (id, nom, cat, prix, stock, composants) values ('pr-zb', 'Ensemble Fictif ZB', 'Ensemble', 300, 0, $1::jsonb)", [J(['pr-zx', 'pr-b'])]);
  await q('service_role', "insert into public.produits (id, nom, cat, prix, stock, composants) values ('pr-za', 'Ensemble Fictif ZA', 'Ensemble', 500, 0, $1::jsonb)", [J(['pr-a', 'pr-zb'])]);
  await q('service_role', "insert into public.produits (id, nom, cat, prix, stock, composants) values ('pr-zb2', 'Ensemble Fictif ZB2', 'Ensemble', 300, 0, $1::jsonb)", [J(['pr-a', 'pr-c'])]);
  await q('service_role', "insert into public.produits (id, nom, cat, prix, stock, composants) values ('pr-zok', 'Ensemble Fictif ZOK', 'Ensemble', 520, 0, $1::jsonb)", [J(['pr-c', 'pr-zb2'])]);
  test('A contient B qui contient un produit NON vendable : B non vendable ET A non vendable (avant : A vendable)', (await nv('pr-zb')) === true && (await nv('pr-za')) === true);
  test('A contient B dont toute la composition est vendable : A vendable', (await nv('pr-zb2')) === false && (await nv('pr-zok')) === false);
  e = await echec('collab', insCmd, ['#TEST-Z1', 'Ensemble Fictif ZA', JSON.stringify([L('pr-za', 'Ensemble Fictif ZA', 1, 500)]), 500]);
  test('nouvelle commande de A (non vendable au 2e niveau) : REFUSÉE par la base', !!e && /PRODUIT NON VENDABLE/.test(e), e);
  e = await echec('collab', insCmd, ['#TEST-Z2', 'Ensemble Fictif ZOK', JSON.stringify([L('pr-zok', 'Ensemble Fictif ZOK', 1, 520)]), 520]);
  test('nouvelle commande d\'un ensemble imbriqué entièrement vendable : acceptée', e === null, e);
  await q('service_role', "insert into public.produits (id, nom, cat, prix, stock, composants) values ('pr-zi', 'Ensemble Fictif ZI', 'Ensemble', 400, 0, $1::jsonb)", [J(['pr-a', 'pr-zinconnu-interne'])]);
  await q('service_role', "insert into public.produits (id, nom, cat, prix, stock, composants) values ('pr-zj', 'Ensemble Fictif ZJ', 'Ensemble', 450, 0, $1::jsonb)", [J(['pr-zi'])]);
  test('composant INTROUVABLE au 2e niveau : l\'ensemble du dessus est non vendable', (await nv('pr-zj')) === true);
  // cycles
  await q('service_role', "insert into public.produits (id, nom, cat, prix, stock, composants) values ('pr-zc1', 'Ensemble Fictif ZC1', 'Ensemble', 100, 0, $1::jsonb)", [J(['pr-a', 'pr-zc2'])]);
  await q('service_role', "insert into public.produits (id, nom, cat, prix, stock, composants) values ('pr-zc2', 'Ensemble Fictif ZC2', 'Ensemble', 100, 0, $1::jsonb)", [J(['pr-b', 'pr-zc1'])]);
  await q('service_role', "insert into public.produits (id, nom, cat, prix, stock, composants) values ('pr-zs', 'Ensemble Fictif ZS', 'Ensemble', 100, 0, $1::jsonb)", [J(['pr-a', 'pr-zs'])]);
  await q('service_role', "insert into public.produits (id, nom, cat, prix, stock, composants) values ('pr-zcy', 'Ensemble Fictif ZCY', 'Ensemble', 100, 0, $1::jsonb)", [J(['pr-zc1'])]);
  const t0 = Date.now(); const cyc = [await nv('pr-zc1'), await nv('pr-zc2'), await nv('pr-zs'), await nv('pr-zcy')];
  test('CYCLE A ↔ B, ensemble qui se contient lui-même, ensemble au-dessus d\'un cycle : tous NON vendables, réponse immédiate', cyc.every((v) => v === true) && Date.now() - t0 < 5000, cyc);
  e = await echec('collab', insCmd, ['#TEST-Z3', 'Ensemble Fictif ZC1', JSON.stringify([L('pr-zc1', 'Ensemble Fictif ZC1', 1, 100)]), 100]);
  test('nouvelle commande d\'un ensemble en cycle : REFUSÉE (pas de boucle infinie)', !!e && /PRODUIT NON VENDABLE/.test(e), e);
  test('composition à tous les niveaux (interne.l039_composition_ids) : cycle arrêté, chaque produit une fois',
    JSON.stringify((await un('proprio', "select interne.l039_composition_ids('pr-zc1') as ids")).ids.sort()) === JSON.stringify(['pr-a', 'pr-b', 'pr-zc1', 'pr-zc2']));
  // profondeur plafonnée (8 niveaux)
  for (let n = 9; n >= 0; n--) {
    await q('service_role', "insert into public.produits (id, nom, cat, prix, stock, composants) values ($1, $2, 'Ensemble', 100, 0, $3::jsonb)",
      ['pr-zd' + n, 'Ensemble Fictif ZD' + n, J([n === 9 ? 'pr-a' : 'pr-zd' + (n + 1)])]);
  }
  test('chaîne de 7 niveaux (ZD3 → … → ZD9 → A) : vendable', (await nv('pr-zd3')) === false);
  test('chaîne de 10 niveaux (ZD0 → … → A) : au-delà du plafond de 8 niveaux → NON vendable (jamais vendable par défaut)', (await nv('pr-zd0')) === true && (await un('proprio', 'select interne.l039_profondeur_max() as m')).m === 8);
  // garde collaboratrice : ne rend pas vendable un ensemble non vendable à cause d'un niveau profond
  e = await echec('collab', "update public.produits set composants = $1::jsonb where id = 'pr-za'", [J(['pr-a'])]);
  test('collaboratrice : recomposer A (non vendable au 2e niveau) pour le rendre vendable → refusé', !!e && /seul l'administrateur le rend vendable/.test(e), e);
  e = await echec('collab', "update public.produits set composants = $1::jsonb where id = 'pr-zok'", [J(['pr-c', 'pr-za'])]);
  test('collaboratrice : ajouter à un ensemble vendable un sous-ensemble non vendable (le rend non vendable) → accepté', e === null && (await nv('pr-zok')) === true, e);
  await q('admin', "update public.produits set composants = $1::jsonb where id = 'pr-zok'", [J(['pr-c', 'pr-zb2'])]);
  // correspondance Shopify « certaine » sur un ensemble qui contient le produit au 2e niveau
  await q('service_role', "insert into public.produits (id, nom, cat, prix, stock) values ('pr-zy', 'Oreiller Fictif ZY', 'Accessoire', 19, 5)");
  await q('service_role', "insert into public.produits (id, nom, cat, prix, stock, composants) values ('pr-zw', 'Ensemble Fictif ZW', 'Ensemble', 60, 0, $1::jsonb)", [J(['pr-zy', 'pr-c'])]);
  await q('service_role', "insert into public.produits (id, nom, cat, prix, stock, composants) values ('pr-zv', 'Ensemble Fictif ZV', 'Ensemble', 260, 0, $1::jsonb)", [J(['pr-a', 'pr-zw'])]);
  e = await echec('service_role', "insert into public.stock_correspondance (shopify_variant_id, app_produit_id, fiabilite) values (1099, 'pr-zv', 'certaine')");
  test('ensemble imbriqué vendable relié à une variante Shopify « certaine »', e === null, e);
  e = await echec('admin', "update public.produits set vendable = false where id = 'pr-zy'");
  test('produit retiré de la vente alors qu\'un ensemble le contient au 2e NIVEAU avec une variante « certaine » → refusé', !!e && /variantes Shopify/.test(e) && /pr-zv/.test(e), e);
  e = await echec('service_role', "insert into public.stock_correspondance (shopify_variant_id, app_produit_id, fiabilite) values (1098, 'pr-za', 'certaine')");
  test('variante « certaine » vers un ensemble non vendable au 2e niveau → refusée', !!e && /NON VENDABLE/i.test(e), e);
  e = await echec('anon', "select interne.l039_composants_non_vendables('[]'::jsonb, null)");
  test('anon ne peut pas appeler interne.l039_composants_non_vendables', !!e, e);

  // =========================================================================================================================
  console.log('\n10. CONNEXION NEUVE : modification de produit SANS insertion préalable (défaut « record v_ex is not assigned yet »)');
  // Défaut trouvé par un essai pglite local le 26/11 : dans produits_vente_garde, v_ex n'était rempli que pour un INSERT, mais la
  // condition « tg_op = 'INSERT' and v_existe and v_ex.prix_vente_defini = false » était aussi évaluée pour un UPDATE (PL/pgSQL ne
  // garantit pas l'arrêt au premier « false » d'un AND) : erreur sur TOUTE modification de produit dans une connexion neuve, ou
  // après la création d'une table (même temporaire), tant qu'aucune insertion de produit n'avait eu lieu dans la connexion. Les
  // sections 2 à 9 ne le voyaient pas : elles insèrent des produits avant de les modifier. Ici, la base est COPIÉE (dumpDataDir)
  // dans une nouvelle instance = une connexion neuve où AUCUNE insertion de produit n'a encore eu lieu.
  const arrCx = (await un('service_role', "insert into public.arrivages (reference_interne, taux_change, taux_provisoire, frais_import_ht) values ('ARR-TEST-NEUVE', 1.1, false, 0) returning id")).id;
  await q('service_role', "insert into public.arrivage_lignes (arrivage_id, produit_id, quantite_attendue, fob_unitaire) values ($1, 'pr-c', 3, 5)", [arrCx]);
  const lCx = (await un('proprio', 'select id from public.arrivage_lignes where arrivage_id = $1', [arrCx])).id;
  // table temporaire créée par le superutilisateur de pglite (anon n'a pas le droit TEMPORARY) : seule compte l'invalidation des plans
  const tempo = async (nom) => { await db.exec('reset role'); try { await db.exec('create temp table ' + nom + ' (x int)'); return null; } catch (x) { return String(x && x.message || x); } };
  const copie = await db.dumpDataDir();
  const dbPrincipale = db;
  const neuve = async () => { const d = new PGlite({ loadDataDir: copie }); await d.waitReady; return d; };
  try {
    db = await neuve();
    const st0 = Number((await produit('pr-c')).stock);
    e = await echec('admin', "update public.produits set stock = stock + 1 where id = 'pr-c'");
    test('connexion neuve : l\'administrateur MODIFIE le stock d\'un produit (aucune insertion avant) → accepté', e === null && Number((await produit('pr-c')).stock) === st0 + 1, e);
    await db.close();
    db = await neuve();
    e = await echec('collab', "update public.produits set stock = stock + 1 where id = 'pr-c'");
    test('connexion neuve : la collaboratrice MODIFIE le stock d\'un produit → accepté', e === null, e);
    await db.close();
    db = await neuve();
    e = await echec('admin', "update public.produits set prix = 31 where id = 'pr-c'");
    test('connexion neuve : l\'administrateur MODIFIE le prix d\'un produit → accepté', e === null && (await produit('pr-c')).prix === 31, e);
    await db.close();
    db = await neuve();
    try { r = await rpc('admin', 'select public.valider_reception_arrivage($1, $2::jsonb, $3) as r', [arrCx, JSON.stringify([{ ligne_id: Number(lCx), recue: 3, endommagee: 0, manquante: 0 }]), await empreinte(arrCx)]); } catch (x) { r = { erreur: String(x && x.message || x) }; }
    test('connexion neuve : valider_reception_arrivage (réception du conteneur) → réussie, stock + 3', r && r.ok === true && Number((await produit('pr-c')).stock) === st0 + 3, r);
    await db.close();
    db = await neuve();
    e = await tempo('l26_tmp');
    test('connexion neuve : création d\'une table temporaire', e === null, e);
    e = await echec('admin', "update public.produits set stock = stock + 1 where id = 'pr-c'");
    test('… puis modification d\'un produit → acceptée', e === null, e);
    await db.close();
  } finally { db = dbPrincipale; }
  // connexion principale (insertions déjà faites) : création d'une table temporaire, puis modification et enregistrement « upsert »
  e = await tempo('l26_tmp2');
  test('connexion principale : création d\'une table temporaire', e === null, e);
  e = await echec('admin', "update public.produits set stock = stock + 1 where id = 'pr-c'");
  test('… puis modification d\'un produit → acceptée', e === null, e);
  e = await echec('collab', "insert into public.produits (id, nom, prix, stock) values ('pr-c', 'Oreiller Fictif C', 29, 4) on conflict (id) do update set stock = excluded.stock");
  test('… et l\'enregistrement « upsert » d\'un produit existant fonctionne toujours (stock 4)', e === null && Number((await produit('pr-c')).stock) === 4, e);

  console.log('\nRÉSULTAT : ' + ok + ' tests réussis, ' + ko + ' échec(s)');
  await db.close();
  process.exit(ko ? 1 : 0);
})().catch(e => { console.log('ERREUR : ' + (e && e.stack || e)); process.exit(1); });
