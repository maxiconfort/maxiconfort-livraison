// Banc de test RÉEL de la migration 041 (dropshipping encadré et provenance de chaque pièce, 3 pare-feu) sur une base
// PostgreSQL JETABLE, EN MÉMOIRE (@electric-sql/pglite 0.2.17 = PostgreSQL 16 en WebAssembly : rien n'est écrit sur le disque,
// aucune connexion à la vraie base).
// Usage : node outils/test-041-pglite.js   (SAUTER_PGLITE=1 pour le sauter volontairement : « SAUTÉ », ne vaut jamais preuve)
// VALEURS FICTIVES uniquement (dépôt PUBLIC) : aucun client, aucun fournisseur, aucun prix réel.
//
// Ce que fait le banc :
//   1. recrée le strict nécessaire du schéma (rôles Supabase, propriétaire BYPASSRLS non superutilisateur, privilèges par défaut,
//      tables produits / commandes / tournees / depenses / caisse_remises / parametres / stock_camion avec les politiques de
//      session de la 019, schéma storage minimal) ; applique TELLES QUELLES 004, 020, 038b, 040, puis la 041 (deux fois) ;
//      la 039 est représentée par sa seule table produits_revient (DDL recopiée ; la 039 a son propre banc) ;
//   2. exécute pour de vrai les trois pare-feu, le stock du camion, la déduction limitée aux pièces « Dépôt », la marge, le
//      bilan du jour, les alertes, le journal, les droits par rôle et les politiques du stockage des tickets.
// LIMITES : une seule connexion (la concurrence est garantie par les verrous FOR UPDATE, vérifiés dans le texte) ; pas de
// PostgREST ni d'API Storage (appels reproduits en SQL) ; session par paramètre au lieu des en-têtes ; types des colonnes
// historiques : stock_camion relevé dans la vraie base (v7.5.205) ; les autres supposés d'après l'appli — le banc d'intégration
// outils/test-041-integration-pglite.js reproduit TOUS les types relevés et applique les vraies 038b → 039 → 040 → 041.
const fs = require('fs'), path = require('path');
const racine = path.join(__dirname, '..');
const VERSION_ATTENDUE = '0.2.17';
const SAUTER = process.env.SAUTER_PGLITE === '1';
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (e) {
  if (SAUTER) { console.log('BANC 041 PGLITE SAUTÉ VOLONTAIREMENT (SAUTER_PGLITE=1) : la migration 041 n\'a PAS été testée.'); process.exit(0); }
  console.error('ÉCHEC DU BANC 041 PGLITE : dépendance @electric-sql/pglite absente — la migration 041 n\'a PAS été testée.');
  console.error('Installer @electric-sql/pglite ' + VERSION_ATTENDUE + ' (npm install), ou SAUTER_PGLITE=1 pour le sauter volontairement.');
  process.exit(2);
}
const lireMigration = (n) => fs.readFileSync(path.join(racine, 'supabase', 'migrations', n), 'utf8');
let ok = 0, ko = 0;
const test = (nom, cond, det) => { if (cond) { ok++; console.log('  OK   ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (det !== undefined ? ' — ' + JSON.stringify(det) : '')); } };

const SQL_ROLES = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role l41_postgres nologin bypassrls;
grant usage, create on schema public to l41_postgres;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role l41_postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role l41_postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role l41_postgres in schema public grant all on functions to anon, authenticated, service_role;
create schema interne authorization l41_postgres;
create schema storage authorization l41_postgres;
grant usage on schema storage to anon, authenticated, service_role;
`;
// BOUCHONS documentés : session_role() / session_livreur() lisent l41.session_role / l41.session_livreur (en production :
// en-têtes x-app-secret + x-session-token, table sessions_app, migration 019). Schéma storage : tables buckets / objects
// minimales (en production : Supabase Storage, RLS activée sur storage.objects, rôle anon pour la clé publishable).
const SQL_BASE = `
create or replace function public.session_role() returns text
language sql stable security definer set search_path = public, pg_catalog as $$ select nullif(current_setting('l41.session_role', true), '') $$;
create or replace function public.session_livreur() returns text
language sql stable security definer set search_path = public, pg_catalog as $$
  select case when nullif(current_setting('l41.session_role', true), '') = 'livreur' then upper(nullif(current_setting('l41.session_livreur', true), '')) end $$;
revoke all on function public.session_role(), public.session_livreur() from public, anon, authenticated;
grant execute on function public.session_role(), public.session_livreur() to anon;

create table public.produits (
  id text primary key, nom text not null, cat text, dim text, prix numeric, poids numeric, stock integer default 0,
  seuil integer, empl text, remarque text, actif boolean default true, updated_at timestamptz default now(), created_at timestamptz default now());
create table public.commandes (
  id text primary key, client text, produit text, lignes jsonb, qte integer default 1, prix numeric default 0, livreur text,
  transporteur text default 'RANOU', statut text default 'en-attente', date_livraison text, stock_deduit boolean default false,
  updated_at timestamptz default now(), created_at timestamptz default now());
create table public.tournees (id text primary key, livreur text, date_tournee text, statut text, stops jsonb, updated_at timestamptz);
create table public.depenses (
  id text primary key, date_depense text, cat text, montant numeric, livreur text, comment text, mode_paie text, tournee_id text,
  created_at timestamptz default now());
create table public.caisse_remises (
  id bigint generated always as identity primary key, key_remise text unique, livreur text, periode text, validee boolean,
  date_remise timestamptz, par text, especes_attendues numeric, especes_remises numeric, ecart numeric, cb_encaisse numeric, commentaire text);
create table public.parametres (cle text primary key, valeur text);
-- v7.5.205 : types RELEVÉS dans la vraie base (information_schema, 27/11/2026) — id uuid (gen_random_uuid()), livreur et
-- produit_libelle NOT NULL, quantite NOT NULL défaut 1
create table public.stock_camion (
  id uuid primary key default gen_random_uuid(), livreur text not null, produit_libelle text not null, quantite integer not null default 1,
  source_cmd_id text, source_tournee_id text, charge_at timestamptz default now(), charge_par text, status text default 'en_camion',
  retour_at timestamptz, retour_par text, notes text, created_at timestamptz default now(), updated_at timestamptz default now());
-- 039 : seule la table produits_revient est nécessaire ici (DDL recopiée de la 039)
create table public.produits_revient (
  produit_id text primary key references public.produits(id) on update cascade on delete cascade,
  prix_revient_ht numeric(12,4) not null check (prix_revient_ht >= 0), methode text not null default 'cump',
  provisoire boolean not null default false, maj_at timestamptz default now(), maj_par text);

do $$
declare t text;
begin
  foreach t in array array['produits', 'commandes', 'tournees', 'depenses', 'caisse_remises', 'parametres', 'stock_camion', 'produits_revient'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy sess_admin on public.%I for all to anon using ((select public.session_role()) = ''admin'') with check ((select public.session_role()) = ''admin'')', t);
  end loop;
  foreach t in array array['produits', 'commandes', 'tournees', 'stock_camion'] loop
    execute format('create policy sess_collab on public.%I for all to anon using ((select public.session_role()) = ''collab'') with check ((select public.session_role()) = ''collab'')', t);
  end loop;
end $$;
create policy sess_livreur on public.commandes for all to anon
  using ((select public.session_role()) = 'livreur' and upper(coalesce(livreur,'')) = (select public.session_livreur())
         and coalesce(date_livraison,'') >= to_char(current_date - 2, 'YYYY-MM-DD') and coalesce(date_livraison,'') <= to_char(current_date + 2, 'YYYY-MM-DD'))
  with check ((select public.session_role()) = 'livreur' and upper(coalesce(livreur,'')) = (select public.session_livreur()));
create policy sess_livreur on public.tournees for all to anon
  using ((select public.session_role()) = 'livreur' and upper(coalesce(livreur,'')) = (select public.session_livreur()))
  with check ((select public.session_role()) = 'livreur' and upper(coalesce(livreur,'')) = (select public.session_livreur()));
create policy sess_livreur on public.depenses for all to anon
  using ((select public.session_role()) = 'livreur' and upper(coalesce(livreur,'')) = (select public.session_livreur()))
  with check ((select public.session_role()) = 'livreur' and upper(coalesce(livreur,'')) = (select public.session_livreur()));
create policy sess_livreur on public.stock_camion for all to anon
  using ((select public.session_role()) = 'livreur' and upper(coalesce(livreur,'')) = (select public.session_livreur()))
  with check ((select public.session_role()) = 'livreur' and upper(coalesce(livreur,'')) = (select public.session_livreur()));
create policy sess_livreur_lecture on public.produits for select to anon using ((select public.session_role()) = 'livreur');
create policy sess_livreur_stock on public.produits for update to anon using ((select public.session_role()) = 'livreur') with check ((select public.session_role()) = 'livreur');

create table storage.buckets (id text primary key, name text, public boolean default false);
create table storage.objects (id bigint generated always as identity primary key, bucket_id text references storage.buckets(id), name text, owner text, created_at timestamptz default now());
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to anon;
`;

(async () => {
  let pkg = { version: '?' };
  try { let d = path.dirname(require.resolve('@electric-sql/pglite'));
        while (!fs.existsSync(path.join(d, 'package.json')) && path.dirname(d) !== d) d = path.dirname(d);
        pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')); } catch (e) { /* version inconnue */ }
  if (pkg.version !== VERSION_ATTENDUE) {
    console.error('ÉCHEC DU BANC 041 PGLITE : @electric-sql/pglite ' + pkg.version + ' installé, version exigée ' + VERSION_ATTENDUE + ' — migration 041 NON testée.');
    process.exit(2);
  }
  const db = new PGlite();
  console.log('Base jetable en mémoire : ' + (await db.query('select version() as v')).rows[0].v.split(' on ')[0] + ' (@electric-sql/pglite ' + pkg.version + ')');

  const SESS = { admin: ['admin', ''], collab: ['collab', ''], livreur: ['livreur', 'livreur-a'], livreurB: ['livreur', 'livreur-b'] };
  async function contexte(qui) {
    await db.exec('reset role');
    const s = SESS[qui] || ['', ''];
    await db.query("select set_config('l41.session_role', $1, false), set_config('l41.session_livreur', $2, false)", s);
    if (qui === 'proprio') await db.exec('set role l41_postgres');
    else if (qui !== 'maintenance') await db.exec('set role anon');
  }
  async function q(qui, sql, params) { await contexte(qui); try { return (await db.query(sql, params || [])).rows; } finally { await db.exec('reset role'); } }
  async function echec(qui, sql, params) { await contexte(qui); try { await db.query(sql, params || []); return null; } catch (e) { return String(e && e.message || e); } finally { await db.exec('reset role'); } }
  const un = async (qui, sql, params) => (await q(qui, sql, params))[0];
  const rpc = async (qui, appel, params) => (await un(qui, 'select ' + appel + ' as r', params)).r;
  const P = 'proprio';
  const AUJ = (await db.query("select to_char(current_date, 'YYYY-MM-DD') as d")).rows[0].d;
  const stock = async (id) => (await un(P, 'select stock from public.produits where id = $1', [id])).stock;
  const nb = async (sql, params) => Number((await un(P, 'select count(*)::int as n from ' + sql, params)).n);

  // =========================================================================================================================
  console.log('\n1. SCHÉMA ET MIGRATIONS (004, 020, 038b, 040 telles quelles, puis 041 TELLE QUELLE deux fois)');
  await db.exec(SQL_ROLES);
  await db.exec('set role l41_postgres');
  await db.exec(SQL_BASE);
  for (const m of ['004_add_composants_to_produits.sql', '020_depenses_livreur_restreint.sql', '038b_depenses_verrou_caisse_validee.sql', '040_deduction_stock_serveur.sql']) {
    let err = null; try { await db.exec(lireMigration(m)); } catch (e) { err = e.message; }
    test('migration ' + m + ' appliquée telle quelle', err === null, err);
  }
  const sql041 = lireMigration('041_dropshipping_provenance.sql');
  let e41 = null; try { await db.exec(sql041); } catch (e) { e41 = e.message; }
  test('migration 041 appliquée TELLE QUELLE (contrôles des sections 9 et 10 passés)', e41 === null, e41);
  if (e41) { console.log('\nRÉSULTAT : arrêt, la migration 041 ne s\'applique pas.'); process.exit(1); }
  let e41b = null; try { await db.exec(sql041); } catch (e) { e41b = e.message; }
  test('migration 041 rejouable une 2e fois sans erreur', e41b === null, e41b);
  await db.exec('reset role');
  {
    const bloc10 = sql041.slice(sql041.indexOf('-- 10. Auto-contrôle')); const corps10 = bloc10.slice(bloc10.indexOf('do $$'));
    await db.exec('set role l41_postgres; begin;');
    await db.exec("create or replace function interne.l041_ht(p_ttc numeric, p_tva numeric) returns numeric language sql immutable as $$ select p_ttc $$");
    let e10 = null; try { await db.exec(corps10); } catch (e) { e10 = e.message; }
    await db.exec('rollback; reset role;');
    test('auto-contrôle section 10 : une règle HT faussée fait ÉCHOUER la migration', !!e10 && /Auto-contrôle 041/.test(e10), e10);
    const bloc9 = sql041.slice(sql041.indexOf('-- 9. Contrôle')); const corps9 = bloc9.slice(bloc9.indexOf('do $$'), bloc9.indexOf('-- ───', bloc9.indexOf('do $$')));
    await db.exec('set role l41_postgres; begin;');
    await db.exec('drop table public.produits_revient cascade');
    let e9 = null; try { await db.exec(corps9); } catch (e) { e9 = e.message; }
    await db.exec('rollback; reset role;');
    test('contrôle section 9 : sans la 039 (produits_revient) → migration ANNULÉE', !!e9 && /produits_revient\.prix_revient_ht/.test(e9), e9);
  }
  test('réglages créés : alerte camion 3 jours, charges fixes VIDES, GLS vide, lot tampon 30 jours, TVA 20',
    JSON.stringify((await q(P, "select cle, valeur from public.parametres where cle like 'drop_%' and cle <> 'drop_actif_depuis' order by cle")).map(r => r.cle + '=' + r.valeur))
      === JSON.stringify(['drop_camion_alerte_jours=3', 'drop_charges_fixes_jour_ht=', 'drop_gls_cout_commande_ht=', 'drop_tampon_alerte_jours=30', 'drop_tva_pct=20']));
  const ACTIF = (await un(P, "select valeur from public.parametres where cle = 'drop_actif_depuis'")).valeur;
  test('v7.5.205 : date d\'activation du module notée à la 1re application (drop_actif_depuis, gardée au rejeu)', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(ACTIF)
    && (await un(P, 'select interne.l041_actif_depuis() = $1::timestamptz as v', [ACTIF])).v === true, ACTIF);
  test('bucket drop-tickets créé PRIVÉ', (await un(P, "select public from storage.buckets where id = 'drop-tickets'")).public === false);
  const src = (await un(P, "select prosrc from pg_proc where proname = 'drop_enlever_payer'")).prosrc;
  test('texte : enlèvement — commande puis pièce verrouillées (FOR UPDATE) avant toute lecture de l\'achat',
    /from public\.commandes where id = p\.cmd_id for update;[\s\S]*from public\.commande_pieces where id = p_piece_id for update;[\s\S]*from public\.achats_fournisseur where id = p\.achat_id for update/.test(src));

  // ---------------------------------------------------------------------------------------------------------------------
  // Données fictives : matelas M140 (stock 5, revient 100), matelas M180 (stock 0 = rupture, revient 150), sommier S90
  // (stock 4, revient 40), ensemble E180 = M180 + 2 × S90 ; fournisseurs F1 / F2 (fictifs) ; livreur LIVREUR-A.
  await q(P, `insert into public.produits (id, nom, cat, dim, prix, stock, composants) values
    ('pm140', 'Matelas fictif 140', 'Matelas', '140×190', 300, 5, null),
    ('pm180', 'Matelas fictif 180', 'Matelas', '180×190', 400, 0, null),
    ('ps90', 'Sommier fictif 90', 'Sommier', '90×190', 120, 4, null),
    ('pe180', 'Ensemble fictif 180', 'Ensemble', '180×190', 600, 0, '[{"id":"pm180","qte":1},{"id":"ps90","qte":2}]')`);
  await q(P, "insert into public.produits_revient (produit_id, prix_revient_ht) values ('pm140', 100), ('pm180', 150), ('ps90', 40)");
  const cmd = (id, champs) => q(P, 'insert into public.commandes (id, client, produit, lignes, qte, prix, livreur, transporteur, statut, date_livraison) values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)',
    [id, 'Client fictif', champs.produit || null, champs.lignes ? JSON.stringify(champs.lignes) : null, champs.qte || 1, champs.prix || 0,
     champs.livreur === undefined ? 'Livreur-A' : champs.livreur, champs.transporteur || 'RANOU', champs.statut || 'en-route', champs.date || AUJ])
    // v7.5.205 : commande créée AVANT l'activation du module (champs.avant = nombre de jours)
    .then((x) => champs.avant ? q(P, "update public.commandes set created_at = now() - make_interval(days => $2) where id = $1", [id, champs.avant]) : x)
    // v7.5.206 : commande DÉJÀ LIVRÉE à l'activation (relevé de la 1re application, reproduit ici : drop_livrees_avant_activation)
    .then((x) => champs.livreeActivation ? q(P, "insert into public.drop_livrees_avant_activation (cmd_id, statut) values ($1, 'livré')", [id]) : x);
  await cmd('#C1', { lignes: [{ produitId: 'pe180', nom: 'Ensemble fictif 180', qte: 1 }], prix: 720 });
  await cmd('#C2', { lignes: [{ produitId: 'pm140', nom: 'Matelas fictif 140', qte: 2 }], prix: 600 });
  await cmd('#CB', { lignes: [{ produitId: 'pm140', qte: 1 }], prix: 360, livreur: 'Livreur-B' });
  await q(P, "insert into public.tournees (id, livreur, date_tournee, statut, stops) values ('T-1', 'Livreur-A', $1, 'en cours', $2::jsonb)",
    [AUJ, JSON.stringify([{ cmdId: '#C1', client: 'Client fictif' }, { cmdId: '#C2', client: 'Client fictif' }])]);

  // =========================================================================================================================
  console.log('\n2. DROITS PAR RÔLE');
  test('sans session : drop_version() ne répond rien', (await rpc('anon', 'public.drop_version()')) === null);
  test('livreur : drop_version() = 041', (await rpc('livreur', 'public.drop_version()')) === '041');
  test('admin : crée un fournisseur (écriture directe, politique sess_admin_ecriture)',
    (await echec('admin', "insert into public.fournisseurs (nom, adresse, telephone) values ('Fournisseur fictif 1', '1 rue Fictive 75000 Paris', '0100000000'), ('Fournisseur fictif 2', '2 rue Fictive 75000 Paris', null)")) === null);
  const F1 = (await un(P, "select id from public.fournisseurs where nom = 'Fournisseur fictif 1'")).id;
  const F2 = (await un(P, "select id from public.fournisseurs where nom = 'Fournisseur fictif 2'")).id;
  test('collaboratrice : ne crée pas de fournisseur', !!(await echec('collab', "insert into public.fournisseurs (nom, adresse) values ('X', 'Y')")));
  test('livreur : ne crée pas de fournisseur', !!(await echec('livreur', "insert into public.fournisseurs (nom, adresse) values ('X', 'Y')")));
  test('livreur et collaboratrice : lisent les fournisseurs (adresse de l\'enlèvement)', (await q('livreur', 'select id from public.fournisseurs')).length === 2 && (await q('collab', 'select id from public.fournisseurs')).length === 2);
  await q('admin', 'insert into public.fournisseur_prix (produit_id, fournisseur_id, prix_achat_ht) values ($1, $2, 160), ($1, $3, 170), ($4, $2, 45)', ['pm180', F1, F2, 'ps90']);
  test('collaboratrice : AUCUN prix d\'achat visible', (await q('collab', 'select * from public.fournisseur_prix')).length === 0);
  test('livreur : aucun prix tant que la référence n\'est pas activée', (await q('livreur', 'select * from public.fournisseur_prix')).length === 0);
  test('livreur : n\'active pas le dropshipping', !!(await echec('livreur', "insert into public.drop_produits (produit_id, actif) values ('pm180', true)")));
  test('collaboratrice : n\'active pas le dropshipping', !!(await echec('collab', "insert into public.drop_produits (produit_id, actif) values ('pm180', true)")));
  test('admin : active pm180 (référence en rupture) en dropshipping', (await echec('admin', "insert into public.drop_produits (produit_id, actif, motif) values ('pm180', true, 'rupture')")) === null);
  test('livreur : voit les 2 prix de la référence activée, pas ceux d\'une référence non activée',
    JSON.stringify((await q('livreur', 'select produit_id, prix_achat_ht::float8 as p from public.fournisseur_prix order by p')).map(r => r.produit_id + ':' + r.p)) === JSON.stringify(['pm180:160', 'pm180:170']));
  test('personne n\'écrit directement une pièce, un achat, un coût, une alerte (admin compris)',
    !!(await echec('admin', "insert into public.commande_pieces (cmd_id, ligne_idx, piece_idx, libelle, empreinte) values ('#C1', 0, 9, 'x', 'x')"))
    && !!(await echec('livreur', "insert into public.achats_fournisseur (piece_id, cmd_id, fournisseur_id, prix_prevu_ht) values (1, '#C1', 1, 1)"))
    && !!(await echec('admin', "insert into public.drop_alertes (type, cle, message) values ('ecart_prix', 'x', 'x')")));
  test('journal : activation et prix journalisés (qui, quoi, combien)',
    (await nb("public.drop_journal where action = 'drop_produits_insert' and acteur = 'admin'")) === 1
    && (await nb("public.drop_journal where action = 'fournisseur_prix_insert' and montant = 160")) === 1);

  // =========================================================================================================================
  console.log('\n3. DÉCOUPAGE EN PIÈCES');
  let r = await rpc('livreur', 'public.drop_pieces($1)', ['#C1']);
  test('ensemble 180 = matelas + 2 sommiers 90 → 3 pièces (composants)', r.ok && r.pieces.length === 3
    && JSON.stringify(r.pieces.map(p => p.produit_id)) === JSON.stringify(['pm180', 'ps90', 'ps90']) && r.pieces.every(p => p.composant_de === 'pe180' && p.ligne_idx === 0), r);
  const [pM, pS1, pS2] = r.pieces;
  test('livreur : la pièce activée propose les 2 fournisseurs (prix prévus HT), la moins chère d\'abord',
    JSON.stringify(pM.fournisseurs.map(f => f.prix_prevu_ht)) === JSON.stringify([160, 170]) && pM.drop_actif === true && pS1.drop_actif === false);
  r = await rpc('livreur', 'public.drop_pieces($1)', ['#C1']);
  test('rejouable : pas de nouveau découpage', r.pieces.length === 3 && (await nb("public.commande_pieces where cmd_id = '#C1'")) === 3);
  r = await rpc('collab', 'public.drop_pieces($1)', ['#C1']);
  test('collaboratrice : voit les pièces SANS aucun prix', r.ok && r.pieces.length === 3 && r.pieces.every(p => p.fournisseurs === undefined && p.achat === undefined));
  r = await rpc('livreurB', 'public.drop_pieces($1)', ['#C1']);
  test('autre livreur : commande introuvable', r.ok === false && r.erreur === 'commande_introuvable');
  r = await rpc('livreur', 'public.drop_pieces($1)', ['#C2']);
  test('matelas × 2 → 2 pièces', r.pieces.length === 2);
  await q(P, "update public.commandes set lignes = $1::jsonb where id = '#C2'", [JSON.stringify([{ produitId: 'pm140', qte: 1 }])]);
  r = await rpc('livreur', 'public.drop_pieces($1)', ['#C2']);
  test('lignes changées et rien de déclaré → redécoupage (1 pièce)', r.pieces.length === 1 && r.perime === false);
  const pC2 = r.pieces[0];

  // =========================================================================================================================
  console.log('\n4. 1er PARE-FEU : CHARGEMENT (provenance)');
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [pS1.id, 'depot']);
  test('sommier 1 : Dépôt', r.ok && r.piece.provenance === 'depot' && r.piece.origine === 'depot');
  r = await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [pS2.id, 'fournisseur', F1]);
  test('sommier 2 : chez un fournisseur REFUSÉ (référence non activée)', r.ok === false && r.erreur === 'dropshipping_inactif');
  r = await rpc('collab', 'public.drop_declarer($1, $2, null, null)', [pS2.id, 'depot']);
  test('collaboratrice : ne déclare pas', r.ok === false && r.erreur === 'session_requise');
  r = await rpc('livreurB', 'public.drop_declarer($1, $2, null, null)', [pS2.id, 'depot']);
  test('autre livreur : pièce introuvable', r.ok === false && r.erreur === 'piece_introuvable');
  await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [pS2.id, 'depot']);
  r = await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [pM.id, 'fournisseur', F2]);
  test('matelas 180 (rupture) : chez le fournisseur 2 → achat PRÉVU au prix HT du fournisseur 2', r.ok && r.piece.provenance === 'fournisseur' && r.piece.achat.statut === 'prevu' && r.piece.achat.prix_prevu_ht === 170, r);
  r = await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [pM.id, 'fournisseur', F1]);
  test('changement de fournisseur avant paiement : ancien achat annulé, nouveau prévu à 160', r.ok && r.piece.achat.prix_prevu_ht === 160
    && (await nb("public.achats_fournisseur where piece_id = $1 and statut = 'annule'", [pM.id])) === 1
    && (await un(P, "select tournee_id from public.achats_fournisseur where piece_id = $1 and statut = 'prevu'", [pM.id])).tournee_id === 'T-1');
  r = await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [pM.id, 'fournisseur', F1]);
  test('même déclaration rejouée : « deja », rien de plus', r.ok && r.deja === true && (await nb('public.achats_fournisseur where piece_id = $1', [pM.id])) === 2);
  test('stock théorique 0 : pas d\'alerte « manque au dépôt »', (await nb("public.drop_alertes where type = 'manque_depot'")) === 0);
  // pM180 en rupture mais pm140 en stock : activer pm140 et le prendre chez le fournisseur → alerte manque au dépôt
  await q('admin', "insert into public.drop_produits (produit_id, actif) values ('pm140', true)");
  await q('admin', 'insert into public.fournisseur_prix (produit_id, fournisseur_id, prix_achat_ht) values ($1, $2, 90)', ['pm140', F1]);
  r = await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [pC2.id, 'fournisseur', F1]);
  test('pièce prise chez un fournisseur alors que le stock théorique en indiquait 5 → alerte « manque au dépôt »', r.ok
    && (await nb("public.drop_alertes where type = 'manque_depot' and piece_id = $1", [pC2.id])) === 1);
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [pC2.id, 'depot']);
  test('revenu à Dépôt : achat prévu annulé', r.ok && r.piece.provenance === 'depot' && (await nb("public.achats_fournisseur where piece_id = $1 and statut = 'prevu'", [pC2.id])) === 0);

  // =========================================================================================================================
  console.log('\n5. 2e PARE-FEU : ENLÈVEMENT CHEZ LE FOURNISSEUR (« Enlevé et payé »)');
  r = await rpc('livreur', 'public.drop_enlever_payer($1, $2, $3, $4)', [pS1.id, 10, 'especes', null]);
  test('pièce « Dépôt » : pas un enlèvement', r.ok === false && r.erreur === 'pas_un_enlevement');
  r = await rpc('livreur', 'public.drop_enlever_payer($1, $2, $3, $4)', [pM.id, 198, 'especes', 'autre/C1/t.jpg']);
  test('chemin de ticket d\'un autre dossier : refusé, rien enregistré', r.ok === false && r.erreur === 'chemin_ticket_invalide' && (await nb("public.depenses where id like 'drop-%'")) === 0);
  r = await rpc('livreur', 'public.drop_enlever_payer($1, $2, $3, $4)', [pM.id, 198, 'chèque', null]);
  test('mode inconnu : refusé', r.ok === false && r.erreur === 'mode_invalide');
  // point de caisse validé (038b) : refus de la base, RIEN n'est enregistré
  // v7.5.201 (fusion pile 24-28, 038b v7.5.195) : la validation porte ce sur quoi le montant attendu a été calculé
  const ctrlT1 = await un(P, "select interne.l038b_depenses_especes('T-1') as d, interne.l038b_arrets_caisse((select t.stops::jsonb from public.tournees t where t.id = 'T-1')) as a");
  await q('admin', "insert into public.caisse_remises (key_remise, livreur, periode, validee, par, controle_depenses, controle_arrets) values ('t_T-1', 'Livreur-A', $1, true, 'admin', $2, $3)",
    [AUJ, ctrlT1.d, JSON.stringify(ctrlT1.a)]);
  r = await rpc('livreur', 'public.drop_enlever_payer($1, $2, $3, $4)', [pM.id, 198, 'especes', 'livreur-a/C1/ticket-1.jpg']);
  test('point de caisse de la tournée déjà validé (038b) : refusé, ni achat payé ni dépense', r.ok === false && r.erreur === 'point_caisse_valide'
    && (await un(P, "select statut from public.achats_fournisseur where piece_id = $1 and statut <> 'annule'", [pM.id])).statut === 'prevu' && (await nb("public.depenses where id like 'drop-%'")) === 0, r);
  await q('admin', "delete from public.caisse_remises where key_remise = 't_T-1'");
  r = await rpc('livreur', 'public.drop_enlever_payer($1, $2, $3, $4)', [pM.id, 198, 'especes', 'livreur-a/C1/ticket-1.jpg']);
  const ach = await un(P, "select * from public.achats_fournisseur where piece_id = $1 and statut = 'paye'", [pM.id]);
  const dep = await un(P, 'select * from public.depenses where id = $1', ['drop-' + (ach && ach.id)]);
  test('CAISSE TTC, MARGE HT : payé 198 € TTC en espèces (prévu 160 HT = 192 TTC attendus) → coût HT 165 (198 ÷ 1,2), TTC 198 gardé à part, écart TTC +6', r.ok && r.ecart === 6 && r.ttc_attendu === 192
    && ach && Number(ach.montant_paye_ht) === 165 && Number(ach.montant_paye_ttc) === 198 && Number(ach.tva_pct) === 20 && ach.mode === 'especes', r);
  test('dépense « Espèces » de la tournée = TTC PAYÉ 198 (déduit de ce que le livreur remet, PR 24)', dep && dep.mode_paie === 'Espèces' && Number(dep.montant) === 198 && dep.tournee_id === 'T-1' && dep.livreur === 'Livreur-A' && dep.date_depense === AUJ && dep.cat === 'Achat fournisseur', dep);
  test('écart TTC payé / TTC attendu → alerte administrateur (+6, message en TTC)', (await nb("public.drop_alertes where type = 'ecart_prix' and montant = 6 and message like '%198.00 € TTC au lieu de 192.00 € TTC%'")) === 1);
  test('ticket fourni : pas d\'alerte « ticket manquant »', (await nb("public.drop_alertes where type = 'ticket_manquant'")) === 0);
  r = await rpc('livreur', 'public.drop_enlever_payer($1, $2, $3, $4)', [pM.id, 198, 'especes', 'livreur-a/C1/ticket-1.jpg']);
  test('rejeu (réponse perdue) : « deja », aucune 2e dépense', r.ok && r.deja === true && (await nb("public.depenses where id like 'drop-%'")) === 1);
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [pM.id, 'depot']);
  test('achat payé : la provenance ne peut plus changer', r.ok === false && r.erreur === 'achat_deja_paye');
  test('livreur : voit son achat payé ; collaboratrice : aucun achat', (await q('livreur', 'select id from public.achats_fournisseur where statut = $1', ['paye'])).length === 1 && (await q('collab', 'select id from public.achats_fournisseur')).length === 0);

  // =========================================================================================================================
  console.log('\n6. 3e PARE-FEU : LIVRAISON PIÈCE PAR PIÈCE');
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#C1', JSON.stringify([{ id: pM.id, livree: true }, { id: pS1.id, livree: true }])]);
  test('pièces incomplètes : refusé', r.ok === false && r.erreur === 'pieces_incompletes');
  // une pièce fournisseur non payée ne peut pas être livrée : #C3 avec un matelas 180 déclaré fournisseur, non payé
  await cmd('#C3', { lignes: [{ produitId: 'pm180', qte: 1 }], prix: 480 });
  const p3 = (await rpc('livreur', 'public.drop_pieces($1)', ['#C3'])).pieces[0];
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#C3', JSON.stringify([{ id: p3.id, livree: true }])]);
  test('pièce SANS provenance : « livrée » refusé', r.ok === false && r.erreur === 'provenance_manquante');
  await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [p3.id, 'fournisseur', F1]);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#C3', JSON.stringify([{ id: p3.id, livree: true }])]);
  test('pièce fournisseur NON payée : « livrée » refusé', r.ok === false && r.erreur === 'enlevement_non_paye');
  // #C1 : matelas livré, sommier 1 livré, sommier 2 NON livré (refusé par le client)
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#C1', JSON.stringify([{ id: pM.id, livree: true }, { id: pS1.id, livree: true }, { id: pS2.id, livree: false }])]);
  test('confirmation complète : acceptée', r.ok && r.deja === false, r);
  const couts = await q(P, "select piece_id, cout_ht::float8 as c, source from public.pieces_couts where cmd_id = '#C1' order by piece_id");
  test('coûts FIGÉS : matelas = prix payé 165 (achat), sommier dépôt = revient 40 ; pièce non livrée : aucun coût',
    JSON.stringify(couts.map(x => x.c + ':' + x.source)) === JSON.stringify(['165:achat', '40:revient']), couts);
  test('coût figé : ni modification ni suppression', /ajout seul/.test(await echec(P, "update public.pieces_couts set cout_ht = 1 where cmd_id = '#C1'") || ''));
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#C1', JSON.stringify([{ id: pM.id, livree: true }, { id: pS1.id, livree: true }, { id: pS2.id, livree: false }])]);
  test('rejeu : « deja »', r.ok && r.deja === true);
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [pS1.id, 'depot']);
  test('après confirmation : la provenance est figée', r.ok === false && r.erreur === 'piece_deja_confirmee');

  // =========================================================================================================================
  console.log('\n7. STOCK : SEULES LES PIÈCES « DÉPÔT » SONT RETIRÉES (deduire_stock_livraison)');
  await q(P, "update public.commandes set statut = 'livré' where id = '#C1'");
  const avant = { m: await stock('pm180'), s: await stock('ps90') };
  r = await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#C1']);
  test('déduction par pièces : 1 sommier retiré (dépôt, livré) ; matelas fournisseur et sommier non livré : rien', r.ok && r.mode === 'pieces'
    && (await stock('ps90')) === avant.s - 1 && (await stock('pm180')) === avant.m, r);
  r = await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#C1']);
  test('idempotente : 2e appel « deja », aucun retrait de plus', r.ok && r.deja === true && (await stock('ps90')) === avant.s - 1);
  test('journal des sorties : composant de l\'ensemble noté', (await nb("public.stock_sorties_livraison where cmd_id = '#C1' and produit_id = 'ps90' and composant_de = 'pe180' and qte_retiree = 1")) === 1);
  await cmd('#C4', { lignes: [{ produitId: 'pm140', qte: 2 }], prix: 600, statut: 'livré', avant: 30, livreeActivation: true });   // livrée avant l'activation
  const s140 = await stock('pm140');
  r = await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#C4']);
  test('commande SANS pièces (bureau, GLS, avant ce module) : retrait par la fonction de la 040 conservée (2 matelas, opération journalisée)', r.ok && r.mode === undefined && r.operation_id > 0 && (await stock('pm140')) === s140 - 2, r);
  // livré sans confirmation des pièces (ancienne version de l'appli) : pièces non fournisseur retirées + alerte
  await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [pC2.id, 'depot']);
  await q(P, "update public.commandes set statut = 'livré' where id = '#C2'");
  const s140b = await stock('pm140');
  r = await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#C2']);
  test('v7.5.201 : « livré » posé hors appli SANS confirmation des pièces : la déduction ATTEND (pieces_non_confirmees), rien retiré, alerte', r.ok === false && r.erreur === 'pieces_non_confirmees'
    && (await stock('pm140')) === s140b && (await nb("public.drop_alertes where type = 'livre_sans_confirmation' and cmd_id = '#C2'")) === 1
    && !(await un(P, "select stock_deduit from public.commandes where id = '#C2'")).stock_deduit, r);
  r = await rpc('livreur', 'public.drop_livre_sans_confirmation($1, $2)', ['#C2', 'client a tout pris']);
  test('dérogation : refusée au livreur', r.ok === false && r.erreur === 'admin_requis');
  r = await rpc('admin', 'public.drop_livre_sans_confirmation($1, $2)', ['#C2', 'ok']);
  test('dérogation : motif de moins de 5 caractères refusé', r.ok === false && r.erreur === 'motif_requis');
  r = await rpc('admin', 'public.drop_livre_sans_confirmation($1, $2)', ['#C2', 'Pièces vues livrées au téléphone']);
  test('dérogation de l\'administrateur (motif) : journalisée', r.ok && r.cycle === 1 && (await nb("public.drop_journal where action = 'derogation_livre' and cmd_id = '#C2' and acteur = 'admin'")) === 1);
  r = await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#C2']);
  test('après dérogation : pièce Dépôt retirée (comportement d\'avant) + alerte', r.ok && (await stock('pm140')) === s140b - 1
    && (await nb("public.drop_alertes where type = 'livre_sans_confirmation' and cmd_id = '#C2'")) >= 1, r);

  // =========================================================================================================================
  console.log('\n8. PIÈCE ACHETÉE NON LIVRÉE → STOCK DU CAMION, REPRISE LE LENDEMAIN SANS NOUVEL ACHAT');
  // sommier 2 de #C1 : non livré mais venu du DÉPÔT → pas de stock camion créé ; on fabrique le cas « acheté non livré » avec #C3
  await rpc('livreur', 'public.drop_enlever_payer($1, $2, $3, $4)', [p3.id, 192, 'cb', null]);
  test('payé 192 TTC en CB sans photo : dépense « CB » à part de 192 (non déduite des espèces) + alerte « ticket manquant »',
    (await un(P, "select mode_paie from public.depenses where comment like 'Dropshipping #C3%'")).mode_paie === 'CB' && Number((await un(P, "select montant from public.depenses where comment like 'Dropshipping #C3%'")).montant) === 192 && (await nb("public.drop_alertes where type = 'ticket_manquant'")) === 1);
  r = await rpc('livreur', 'public.drop_ticket_ajouter($1, $2)', [p3.id, 'livreur-a/C3/ticket-2.jpg']);
  test('photo envoyée après coup : rattachée, alerte « ticket manquant » marquée vue', r.ok && (await nb("public.drop_alertes where type = 'ticket_manquant' and vue_at is null")) === 0);
  r = await rpc('livreur', 'public.drop_commande_non_livree($1)', ['#C3']);
  const sc3 = await un(P, "select * from public.stock_camion where source_cmd_id = '#C3'");
  test('client absent : la pièce achetée part dans le STOCK DU CAMION, rattachée à son achat ; déclaration remise à zéro', r.ok && r.pieces === 1
    && sc3 && sc3.status === 'en_camion' && sc3.achat_id !== null && sc3.produit_id === 'pm180'
    && (await un(P, 'select provenance from public.commande_pieces where id = $1', [p3.id])).provenance === null, sc3);
  r = await rpc('livreur', 'public.drop_commande_non_livree($1)', ['#C3']);
  test('rejouable : aucun 2e article dans le camion', r.ok && r.pieces === 0 && (await nb("public.stock_camion where source_cmd_id = '#C3'")) === 1);
  // le lendemain : nouvelle commande #C5 du même matelas → « Déjà dans le camion »
  await cmd('#C5', { lignes: [{ produitId: 'pm180', qte: 1 }], prix: 480 });
  const p5 = (await rpc('livreur', 'public.drop_pieces($1)', ['#C5'])).pieces[0];
  test('la pièce achetée est proposée « Déjà dans le camion » (marquée achetée)', p5.camion.length === 1 && p5.camion[0].id === sc3.id && p5.camion[0].achete === true, p5.camion);
  r = await rpc('livreurB', 'public.drop_declarer($1, $2, null, $3)', [p5.id, 'camion', sc3.id]);
  test('un autre livreur ne prend pas la pièce de ce camion', r.ok === false);
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [p5.id, 'camion', sc3.id]);
  test('« Déjà dans le camion » : origine = fournisseur (son achat), AUCUN nouvel achat', r.ok && r.piece.origine === 'fournisseur'
    && (await nb("public.achats_fournisseur where cmd_id = '#C5'")) === 0);
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [p3.id, 'camion', sc3.id]);
  test('la même pièce du camion ne sert pas deux fois', r.ok === false && r.erreur === 'piece_camion_indisponible');
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#C5', JSON.stringify([{ id: p5.id, livree: true }])]);
  test('livrée : coût repris de l\'ACHAT D\'ORIGINE (160, achat_camion) ; article du camion sorti (livré)', r.ok
    && Number((await un(P, 'select cout_ht from public.pieces_couts where piece_id = $1', [p5.id])).cout_ht) === 160
    && (await un(P, 'select source from public.pieces_couts where piece_id = $1', [p5.id])).source === 'achat_camion'
    && (await un(P, 'select status from public.stock_camion where id = $1', [sc3.id])).status === 'livre');
  await q(P, "update public.commandes set statut = 'livré' where id = '#C5'");
  const s180 = await stock('pm180');
  r = await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#C5']);
  test('pièce du camion achetée : AUCUN retrait du stock du dépôt', r.ok && (await stock('pm180')) === s180);

  // =========================================================================================================================
  console.log('\n9. ALERTES (camion > N jours), MARGE, BILAN DU JOUR (administrateur seul)');
  // v7.5.205 : une ligne par achat (index unique) — la ligne « ancienne » (fabriquée) est rattachée à l'achat payé du matelas de #C1 (livré : aucune autre ligne pour cet achat)
  await q(P, "insert into public.stock_camion (livreur, produit_libelle, quantite, source_cmd_id, charge_at, status, produit_id, achat_id) values ('Livreur-A', 'Matelas fictif 180', 1, '#C1', now() - interval '4 days', 'en_camion', 'pm180', $1)", [ach.id]);
  r = await rpc('admin', 'public.drop_controler()', []);
  test('pièce achetée dans le camion depuis 4 jours (> 3) → alerte', r.ok && r.alertes.some(a => a.type === 'camion_ancien'), r);
  await q('admin', "update public.parametres set valeur = '5' where cle = 'drop_camion_alerte_jours'");
  await q(P, "delete from public.drop_alertes where type = 'camion_ancien'");
  r = await rpc('admin', 'public.drop_controler()', []);
  test('réglage passé à 5 jours : plus d\'alerte pour 4 jours', r.ok && r.jours === 5 && !r.alertes.some(a => a.type === 'camion_ancien'));
  test('drop_controler : refusé au livreur et à la collaboratrice', (await rpc('livreur', 'public.drop_controler()', [])).ok === false && (await rpc('collab', 'public.drop_controler()', [])).ok === false);
  const al = r.alertes[0];
  r = await rpc('admin', 'public.drop_alerte_vue($1)', [al.id]);
  test('alerte marquée vue : ne revient plus dans la liste', r.ok && !(await rpc('admin', 'public.drop_controler()', [])).alertes.some(a => a.id === al.id));
  r = await rpc('admin', 'public.drop_marge_commande($1)', ['#C1']);
  // v7.5.203 (avis chatgpt-review n° 3 sur 77441b6) : LIVRAISON PARTIELLE — #C1 = matelas 180 (prix catalogue 400) livré, sommier 90
  // (120) livré, sommier 90 (120) PAS livré : vente reconnue = 600 HT × (400 + 120) / 640 = 487,50 ; le sommier non livré n'est compté
  // ni en vente ni en coût
  test('marge #C1 (livraison PARTIELLE) : vente de la commande 600 HT, RECONNUE 487,50 (pièces livrées seulement), 112,50 non reconnus ; coût 165 + 40 = 205 ; marge 282,50 ; pièces avec fournisseur, prix payé, mode, ticket',
    r.ok && r.vente_ht_commande === 600 && r.vente_ht === 487.5 && r.vente_non_reconnue_ht === 112.5 && r.livraison_partielle === true && r.pieces_livrees === 2 && r.pieces_total === 3
    && r.cout_ht === 205 && r.marge_ht === 282.5 && r.cout_estime === false
    && r.pieces.some(p => p.fournisseur === 'Fournisseur fictif 1' && p.montant_paye_ht === 165 && p.mode === 'especes' && p.ticket_path === 'livreur-a/C1/ticket-1.jpg'), r);
  test('marge : refusée au livreur', (await rpc('livreur', 'public.drop_marge_commande($1)', ['#C1'])).ok === false);
  await cmd('#G1', { lignes: [{ produitId: 'pm140', qte: 1 }], prix: 360, transporteur: 'GLS', statut: 'livré', livreur: '' });
  r = await rpc('admin', 'public.drop_bilan_jour($1)', [AUJ]);
  // livrées du jour : #C1 (487,50 HT reconnus sur 600 : livraison partielle, 205), #C2 (500 HT, 1 pièce dépôt NON confirmée → coût estimé 100), #C4 (500 HT, 2 × 100
  // estimé), #C5 (400 HT, 160), #G1 (300 HT, 100 estimé, GLS non renseigné)
  test('bilan : ventes RECONNUES HT = 2 187,50 (112,50 non reconnus, 1 livraison partielle), coût des produits = 765, GLS non renseigné (1 commande), résultat = 1 422,50, charges fixes vides',
    r.ok && r.commandes === 5 && r.ventes_ht === 2187.5 && r.ventes_non_reconnues_ht === 112.5 && r.livraisons_partielles === 1 && r.cout_produits_ht === 765 && r.gls_ht === 0 && r.commandes_gls_non_renseigne === 1
    && r.resultat_ht === 1422.5 && r.charges_fixes_ht === null && r.resultat_net_ht === null, r);
  await q('admin', "update public.parametres set valeur = '12,5' where cle = 'drop_gls_cout_commande_ht'");
  await q('admin', "update public.parametres set valeur = '200' where cle = 'drop_charges_fixes_jour_ht'");
  r = await rpc('admin', 'public.drop_bilan_jour($1)', [AUJ]);
  test('réglages GLS 12,5 € HT / commande et charges fixes 200 : résultat 1 410, net 1 210', r.gls_ht === 12.5 && r.resultat_ht === 1410 && r.resultat_net_ht === 1210, r);
  test('bilan : refusé au livreur et à la collaboratrice', (await rpc('livreur', 'public.drop_bilan_jour($1)', [AUJ])).ok === false && (await rpc('collab', 'public.drop_bilan_jour($1)', [AUJ])).ok === false);
  test('collaboratrice : aucun coût lisible (pieces_couts)', (await q('collab', 'select * from public.pieces_couts')).length === 0);

  // =========================================================================================================================
  console.log('\n10. JOURNAL ET STOCKAGE DES TICKETS');
  test('journal : provenance, enlèvement (montant), livraison, camion, ticket — avec l\'acteur',
    (await nb("public.drop_journal where action = 'provenance'")) > 0
    && (await nb("public.drop_journal where action = 'enlevement_paye' and montant = 165 and acteur = 'livreur:LIVREUR-A'")) === 1
    && (await nb("public.drop_journal where action = 'livraison_confirmee'")) === 2 && (await nb("public.drop_journal where action = 'vers_camion'")) === 1);
  test('journal : ajout seul', /ajout seul/.test(await echec(P, 'delete from public.drop_journal') || ''));
  test('journal : lu par l\'administrateur seulement', (await q('admin', 'select id from public.drop_journal')).length > 0 && (await q('livreur', 'select id from public.drop_journal')).length === 0 && (await q('collab', 'select id from public.drop_journal')).length === 0);
  test('stockage : le livreur dépose dans SON dossier pour SA commande', (await echec('livreur', "insert into storage.objects (bucket_id, name) values ('drop-tickets', 'livreur-a/C1/ticket-9.jpg')")) === null);
  test('stockage : pas dans le dossier d\'un autre livreur', !!(await echec('livreur', "insert into storage.objects (bucket_id, name) values ('drop-tickets', 'livreur-b/C1/x.jpg')")));
  test('stockage : pas pour une commande qu\'il ne voit pas', !!(await echec('livreur', "insert into storage.objects (bucket_id, name) values ('drop-tickets', 'livreur-a/CB/x.jpg')")));
  test('stockage : le livreur ne relit pas les tickets ; l\'administrateur les lit ; la collaboratrice rien',
    (await q('livreur', "select id from storage.objects where bucket_id = 'drop-tickets'")).length === 0
    && (await q('admin', "select id from storage.objects where bucket_id = 'drop-tickets'")).length === 1
    && (await q('collab', "select id from storage.objects where bucket_id = 'drop-tickets'")).length === 0);

  // =========================================================================================================================
  console.log('\n11. ADMINISTRATEUR : DÉCOUPAGE PÉRIMÉ, RÉINITIALISATION');
  await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [p3.id, 'fournisseur', F1]);
  await q(P, "update public.commandes set lignes = $1::jsonb where id = '#C3'", [JSON.stringify([{ produitId: 'pm140', qte: 1 }])]);
  r = await rpc('livreur', 'public.drop_pieces($1)', ['#C3']);
  test('lignes changées APRÈS une déclaration : découpage gardé, signalé « périmé »', r.ok && r.perime === true && r.pieces[0].produit_id === 'pm180');
  test('réinitialisation : refusée au livreur', (await rpc('livreur', 'public.drop_reinitialiser_pieces($1)', ['#C3'])).ok === false);
  r = await rpc('admin', 'public.drop_reinitialiser_pieces($1)', ['#C3']);
  const r2 = await rpc('livreur', 'public.drop_pieces($1)', ['#C3']);
  test('réinitialisation admin : achat prévu annulé, nouveau découpage d\'après les lignes actuelles', r.ok && r2.pieces.length === 1 && r2.pieces[0].produit_id === 'pm140'
    && (await nb("public.achats_fournisseur where cmd_id = '#C3' and statut = 'prevu'")) === 0);

  // =========================================================================================================================
  console.log('\n12. STOCK TAMPON DROPSHIPPING (achat d\'avance, lots au prix réel, premier entré premier sorti)');
  const sTamp = await stock('ps90');
  const nMvt = await nb("public.stock_operations where nature = 'mouvement'");
  const ENTREE = 'select public.drop_tampon_entree($1, $2, $3::date, $4, $5, $6::jsonb) as r';
  r = (await un('livreur', ENTREE, ['cle-entree-1', F2, AUJ, 'especes', null, JSON.stringify([{ produit_id: 'ps90', qte: 2, prix_ttc: 36 }])])).r;
  test('livreur : pas d\'entrée de stock tampon', r.ok === false && r.erreur === 'admin_requis');
  r = (await un('collab', ENTREE, ['cle-entree-1', F2, AUJ, 'especes', null, JSON.stringify([{ produit_id: 'ps90', qte: 2, prix_ttc: 36 }])])).r;
  test('collaboratrice : pas d\'entrée de stock tampon', r.ok === false);
  r = (await un('admin', ENTREE, ['cle-entree-x', F2, AUJ, 'especes', null, JSON.stringify([{ produit_id: 'ps90', qte: 2, prix_ttc: 36 }, { produit_id: 'ps90', qte: 1, prix_ttc: 'abc' }])])).r;
  test('prix invalide sur une ligne : refusé, RIEN d\'écrit (ni lot ni stock)', r.ok === false && r.erreur === 'prix_invalide' && (await stock('ps90')) === sTamp && (await nb('public.stock_tampon_lots')) === 0);
  const ilYa40 = (await un(P, "select to_char(current_date - 40, 'YYYY-MM-DD') as d")).d;
  r = (await un('admin', ENTREE, ['cle-entree-1', F2, ilYa40, 'especes', 'tampon/cle-entree-1/facture.jpg', JSON.stringify([{ produit_id: 'ps90', qte: 2, prix_ttc: 36 }])])).r;
  test('entrée 1 (il y a 40 jours) : facture 2 × 36 € TTC = 72 TTC payés, lot au coût HT 30 (36 ÷ 1,2), stock du dépôt +2 PAR mouvement_stock_produit (040)', r.ok && r.total_ht === 60 && r.total_ttc === 72 && r.lots[0].prix_ht === 30
    && (await stock('ps90')) === sTamp + 2 && (await nb("public.stock_operations where nature = 'mouvement'")) === nMvt + 1, r);
  r = (await un('admin', ENTREE, ['cle-entree-1', F2, ilYa40, 'especes', 'tampon/cle-entree-1/facture.jpg', JSON.stringify([{ produit_id: 'ps90', qte: 2, prix_ttc: 36 }])])).r;
  test('rejeu de la même entrée : « deja », aucun lot ni stock de plus', r.ok && r.deja === true && (await stock('ps90')) === sTamp + 2 && (await nb('public.stock_tampon_lots')) === 1);
  r = (await un('admin', ENTREE, ['cle-entree-2', F2, AUJ, 'cb', null, JSON.stringify([{ produit_id: 'ps90', qte: 3, prix_ttc: 42 }])])).r;
  test('entrée 2 (aujourd\'hui) : 3 sommiers à 35 € HT', r.ok && (await stock('ps90')) === sTamp + 5);
  test('lots et entrées : invisibles au livreur et à la collaboratrice', (await q('livreur', 'select id from public.stock_tampon_lots')).length === 0 && (await q('collab', 'select id from public.stock_tampon_entrees')).length === 0);
  r = await rpc('admin', 'public.drop_tampon_etat()', []);
  test('stock tampon restant par fournisseur : 5 pièces, valeur 2 × 30 + 3 × 35 = 165 € HT', r.ok && r.fournisseurs.length === 1 && r.fournisseurs[0].restant === 5 && Number(r.fournisseurs[0].valeur_ht) === 165 && Number(r.valeur_totale_ht) === 165, r);
  test('état du stock tampon : refusé au livreur', (await rpc('livreur', 'public.drop_tampon_etat()', [])).ok === false);
  await cmd('#T1', { lignes: [{ produitId: 'ps90', qte: 3 }], prix: 360 });
  let pt = (await rpc('livreur', 'public.drop_pieces($1)', ['#T1'])).pieces;
  test('chargement : choix « Dépôt — stock tampon » du fournisseur (5 restants, SANS prix) et stock BMS séparé', pt.length === 3 && pt[0].tampon.length === 1 && pt[0].tampon[0].restant === 5
    && pt[0].tampon[0].prix_ht === undefined && pt[0].stock_bms === (await stock('ps90')) - 5, pt[0]);
  r = await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [pt[0].id, 'tampon', F1]);
  test('stock tampon d\'un fournisseur qui n\'en a pas : refusé', r.ok === false && r.erreur === 'stock_tampon_vide');
  for (const x of pt) await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [x.id, 'tampon', F2]);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#T1', JSON.stringify(pt.map(x => ({ id: x.id, livree: true })))]);
  test('livraison confirmée : coût d\'une pièce tampon PAS encore figé (il le sera à la sortie de son lot)', r.ok && (await nb("public.pieces_couts where cmd_id = '#T1'")) === 0);
  await q(P, "update public.commandes set statut = 'livré' where id = '#T1'");
  const sAv = await stock('ps90');
  r = await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#T1']);
  const cT = await q(P, "select cout_ht::float8 as c, source, lot_id from public.pieces_couts where cmd_id = '#T1' order by piece_id");
  test('déduction PAR LA BASE : 3 retirés du dépôt, sortis des lots premier entré premier sorti (2 à 30, puis 1 à 35)', r.ok && r.mode === 'pieces' && r.lots_tampon.length === 3
    && (await stock('ps90')) === sAv - 3 && JSON.stringify(cT.map(x => x.c + ':' + x.source)) === JSON.stringify(['30:tampon', '30:tampon', '35:tampon']), { r, cT });
  test('lots : le plus ancien écoulé (0), le récent à 2 ; sorties tracées (pièce → lot)', JSON.stringify((await q(P, 'select quantite_restante as n from public.stock_tampon_lots order by id')).map(x => x.n)) === JSON.stringify([0, 2])
    && (await nb("public.tampon_sorties where cmd_id = '#T1'")) === 3);
  r = await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#T1']);
  test('rejeu de la déduction : « deja » (résultat restitué par la 040), aucun lot retouché', r.ok && r.deja === true && (await nb('public.tampon_sorties')) === 3);
  r = await rpc('admin', 'public.drop_marge_commande($1)', ['#T1']);
  test('marge : vente 360 TTC = 300 HT − coût réel des lots 95 = 205', r.ok && r.cout_ht === 95 && r.marge_ht === 205 && r.cout_estime === false, r);
  test('sortie de lot : ni modification ni suppression', /ajout seul/.test(await echec(P, 'delete from public.tampon_sorties') || ''));
  r = (await un('admin', ENTREE, ['cle-entree-3', F2, ilYa40, 'virement', null, JSON.stringify([{ produit_id: 'pm140', qte: 1, prix_ttc: 96 }])])).r;
  r = await rpc('admin', 'public.drop_controler()', []);
  test('lot qui dort depuis plus de 30 jours (réglage) → alerte avec sa valeur', r.ok && r.jours_tampon === 30 && r.alertes.some(a => a.type === 'tampon_ancien' && Number(a.montant) === 80), r.alertes);
  test('journal : entrée de stock tampon (montant, lots)', (await nb("public.drop_journal where action = 'tampon_entree' and montant = 105")) === 1);


  // =========================================================================================================================
  // v7.5.201 — réserves de la revue Codex sur 53c7b59 et décision de Borhen corrigée (caisse TTC, marge HT)
  console.log('\n13. v7.5.201 : LA BASE REFUSE « LIVRÉ » TANT QU\'UNE PIÈCE N\'EST PAS CONFIRMÉE (sauf dérogation de l\'administrateur)');
  await cmd('#L1', { lignes: [{ produitId: 'pm140', qte: 1 }], prix: 360 });
  const pL1 = (await rpc('livreur', 'public.drop_pieces($1)', ['#L1'])).pieces[0];
  await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [pL1.id, 'depot']);
  let m = await echec('livreur', "update public.commandes set statut = 'livré' where id = '#L1'");
  test('livreur : « livré » refusé tant que la pièce n\'est pas confirmée (PIECES_NON_CONFIRMEES)', !!m && /PIECES_NON_CONFIRMEES/.test(m), m);
  m = await echec('livreur', "insert into public.commandes (id, client, livreur, statut, date_livraison) values ('#L1', 'Client fictif', 'Livreur-A', 'livré', $1) on conflict (id) do update set statut = excluded.statut", [AUJ]);
  test('même refus par un upsert (POST merge-duplicates de l\'appli)', !!m && /PIECES_NON_CONFIRMEES/.test(m), m);
  m = await echec('admin', "update public.commandes set statut = 'livré' where id = '#L1'");
  test('administrateur : refusé lui aussi sans dérogation', !!m && /PIECES_NON_CONFIRMEES/.test(m), m);
  test('statut inchangé en base', (await un(P, "select statut from public.commandes where id = '#L1'")).statut === 'en-route');
  await cmd('#L2', { lignes: [{ produitId: 'pm140', qte: 1 }], prix: 360, avant: 3 });
  test('v7.5.206 (avis chatgpt-review sur efe0409, pt 1) : commande CRÉÉE AVANT l\'activation mais PAS ENCORE LIVRÉE, confiée à un livreur, jamais découpée → « livré » REFUSÉ (DECOUPAGE_REQUIS)',
    /DECOUPAGE_REQUIS/.test(await echec('livreur', "update public.commandes set statut = 'livré' where id = '#L2'") || ''));
  r = await rpc('admin', 'public.drop_livre_sans_confirmation($1, $2)', ['#L2', 'Ancienne commande livrée par le bureau']);
  test('… même dérogation de l\'administrateur (cycle 1, journalisée), puis « livré » accepté', r.ok && r.cycle === 1
    && (await nb("public.drop_journal where action = 'derogation_livre' and cmd_id = '#L2'")) === 1
    && (await echec('livreur', "update public.commandes set statut = 'livré' where id = '#L2'")) === null, r);
  await cmd('#L2b', { lignes: [{ produitId: 'pm140', qte: 1 }], prix: 360, avant: 3, statut: 'annulé', livreeActivation: true });
  test('commande DÉJÀ LIVRÉE à l\'activation (relevé), annulée puis relivrée : jamais bloquée', (await echec('livreur', "update public.commandes set statut = 'livré' where id = '#L2b'")) === null);
  test('compatibilité : création directe « livré » (bureau) sans pièces → acceptée', (await echec('admin', "insert into public.commandes (id, client, statut, date_livraison) values ('#L3', 'Client fictif', 'livré', $1)", [AUJ])) === null);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#L1', JSON.stringify([{ id: pL1.id, livree: true }])]);
  test('après la confirmation des pièces : « livré » accepté', r.ok && (await echec('livreur', "update public.commandes set statut = 'livré' where id = '#L1'")) === null, r);
  r = await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#L1']);
  test('déduction après confirmation : acceptée', r.ok && r.mode === 'pieces', r);
  await cmd('#L4', { lignes: [{ produitId: 'pm140', qte: 1 }], prix: 360 });
  const pL4 = (await rpc('livreur', 'public.drop_pieces($1)', ['#L4'])).pieces[0];
  r = await rpc('admin', 'public.drop_livre_sans_confirmation($1, $2)', ['#L4', 'Livré par le bureau, pièces contrôlées']);
  test('dérogation motivée de l\'administrateur → « livré » accepté (pièce jamais déclarée)', r.ok && (await echec('admin', "update public.commandes set statut = 'livré' where id = '#L4'")) === null, r);
  r = await rpc('admin', 'public.drop_livre_sans_confirmation($1, $2)', ['#L4', 'Livré par le bureau, pièces contrôlées']);
  test('dérogation rejouée : « deja »', r.ok && r.deja === true);
  test('dérogation : ajout seul', /ajout seul/.test(await echec(P, 'delete from public.drop_derogations') || ''));
  test('dérogations : invisibles au livreur et à la collaboratrice', (await q('livreur', 'select id from public.drop_derogations')).length === 0 && (await q('collab', 'select id from public.drop_derogations')).length === 0);
  void pL4;

  console.log('\n14. v7.5.201 : DÉCOUPAGE PÉRIMÉ → CONFIRMATION REFUSÉE PAR LA BASE');
  await cmd('#P1', { lignes: [{ produitId: 'pm140', qte: 1 }], prix: 360 });
  const pP1 = (await rpc('livreur', 'public.drop_pieces($1)', ['#P1'])).pieces[0];
  await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [pP1.id, 'depot']);
  await q(P, "update public.commandes set lignes = $1::jsonb where id = '#P1'", [JSON.stringify([{ produitId: 'pm140', qte: 2 }])]);
  test('lignes changées après déclaration : « périmé »', (await rpc('livreur', 'public.drop_pieces($1)', ['#P1'])).perime === true);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#P1', JSON.stringify([{ id: pP1.id, livree: true }])]);
  test('confirmation d\'un découpage périmé : REFUSÉE (decoupage_perime), rien de confirmé (appareil au cache ancien compris)', r.ok === false && r.erreur === 'decoupage_perime'
    && (await un(P, 'select livraison from public.commande_pieces where id = $1', [pP1.id])).livraison === null, r);
  test('et « livré » reste refusé', /PIECES_NON_CONFIRMEES/.test(await echec('livreur', "update public.commandes set statut = 'livré' where id = '#P1'") || ''));
  await rpc('admin', 'public.drop_reinitialiser_pieces($1)', ['#P1']);
  r = await rpc('livreur', 'public.drop_pieces($1)', ['#P1']);
  test('après réinitialisation par l\'administrateur : 2 pièces neuves, non périmées', r.ok && r.perime === false && r.pieces.length === 2);

  console.log('\n15. v7.5.201 : CAISSE TTC, MARGE HT (enlèvement)');
  await cmd('#V1', { lignes: [{ produitId: 'pm180', qte: 1 }], prix: 480 });
  const pV1 = (await rpc('livreur', 'public.drop_pieces($1)', ['#V1'])).pieces[0];
  r = await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [pV1.id, 'fournisseur', F1]);
  test('le livreur voit le TTC attendu (160 HT → 192 TTC) et le taux de TVA', r.ok && r.piece.achat.prix_prevu_ttc === 192 && r.piece.tva_pct === 20 && r.piece.fournisseurs[0].prix_prevu_ttc === 192, r.piece && r.piece.achat);
  r = await rpc('livreur', 'public.drop_enlever_payer($1, $2, $3, $4, $5)', [pV1.id, 192, 'especes', null, 193]);
  test('HT de la facture supérieur au TTC : refusé, rien enregistré', r.ok === false && r.erreur === 'montant_ht_invalide' && (await nb("public.depenses where comment like 'Dropshipping #V1%'")) === 0);
  r = await rpc('livreur', 'public.drop_enlever_payer($1, $2, $3, $4, $5)', [pV1.id, 192, 'especes', null, 159.5]);
  const aV1 = await un(P, "select * from public.achats_fournisseur where cmd_id = '#V1' and statut = 'paye'");
  test('HT de la facture SAISI (159,50) : coût HT = 159,50 (pas 160), TTC payé 192, écart TTC 0 (pas d\'alerte)', r.ok && r.ecart === 0 && Number(aV1.montant_paye_ht) === 159.5 && Number(aV1.montant_paye_ttc) === 192
    && (await nb("public.drop_alertes where type = 'ecart_prix' and cmd_id = '#V1'")) === 0, r);
  test('caisse : dépense espèces = 192 TTC (ce qui sort réellement de la poche du livreur)', Number((await un(P, "select montant from public.depenses where comment like 'Dropshipping #V1%'")).montant) === 192);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#V1', JSON.stringify([{ id: pV1.id, livree: true }])]);
  await q('livreur', "update public.commandes set statut = 'livré' where id = '#V1'");
  r = await rpc('admin', 'public.drop_marge_commande($1)', ['#V1']);
  test('marge en HT : vente 480 TTC = 400 HT − coût HT 159,50 = 240,50', r.ok && r.cout_ht === 159.5 && r.marge_ht === 240.5 && r.pieces[0].montant_paye_ttc === 192, r);
  await q('admin', "update public.parametres set valeur = '10' where cle = 'drop_tva_pct'");
  await cmd('#V2', { lignes: [{ produitId: 'pm180', qte: 1 }], prix: 440 });
  const pV2 = (await rpc('livreur', 'public.drop_pieces($1)', ['#V2'])).pieces[0];
  r = await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [pV2.id, 'fournisseur', F1]);
  test('TVA du réglage (10 %) : TTC attendu 176', r.ok && r.piece.achat.prix_prevu_ttc === 176);
  r = await rpc('livreur', 'public.drop_enlever_payer($1, $2, $3, $4)', [pV2.id, 187, 'cb', null]);
  test('TVA 10 % : 187 TTC payés → coût HT 170 (187 ÷ 1,1), écart TTC +11 signalé', r.ok && r.montant_paye_ht === 170 && r.ecart === 11
    && (await nb("public.drop_alertes where type = 'ecart_prix' and cmd_id = '#V2' and montant = 11")) === 1, r);
  await q('admin', "update public.parametres set valeur = '20' where cle = 'drop_tva_pct'");

  console.log('\n16. v7.5.201 : IDEMPOTENCE DE LA DÉCLARATION « STOCK TAMPON » (le fournisseur compte)');
  r = (await un('admin', ENTREE, ['cle-entree-f1', F1, AUJ, 'especes', null, JSON.stringify([{ produit_id: 'ps90', qte: 1, prix_ttc: 30, prix_ht: 25 }])])).r;
  test('entrée tampon chez F1 avec HT de facture saisi : lot au coût HT 25 (pas 30 ÷ 1,2), facture 30 TTC', r.ok && r.lots[0].prix_ht === 25 && r.total_ttc === 30, r);
  await cmd('#D1', { lignes: [{ produitId: 'ps90', qte: 1 }], prix: 144 });
  const pD1 = (await rpc('livreur', 'public.drop_pieces($1)', ['#D1'])).pieces[0];
  r = await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [pD1.id, 'tampon', F2]);
  test('stock tampon F2 déclaré', r.ok && r.piece.fournisseur_id === F2);
  r = await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [pD1.id, 'tampon', F1]);
  test('puis stock tampon F1 : PAS « deja » — fournisseur changé (revue Codex P2)', r.ok && r.deja === false && r.piece.fournisseur_id === F1, r);
  r = await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [pD1.id, 'tampon', F1]);
  test('la même (tampon F1) rejouée : « deja »', r.ok && r.deja === true);
  r = (await un('admin', ENTREE, ['cle-entree-f1', F2, AUJ, 'especes', null, JSON.stringify([{ produit_id: 'ps90', qte: 1, prix_ttc: 30 }])])).r;
  test('même clé d\'entrée avec un autre fournisseur : refusée (cle_deja_utilisee), rien écrit', r.ok === false && r.erreur === 'cle_deja_utilisee');
  r = (await un('admin', ENTREE, ['cle-entree-q', F1, AUJ, 'especes', null, JSON.stringify([{ produit_id: 'ps90', qte: 10001, prix_ttc: 30 }])])).r;
  test('quantité au-delà de 10 000 : refus explicite (quantite_invalide)', r.ok === false && r.erreur === 'quantite_invalide');

  console.log('\n17. v7.5.201 : ANNULATION (recrédit → lot tampon d\'origine) PUIS RELIVRAISON (nouveau cycle)');
  const lotsAv = (await q(P, "select id, quantite_restante as n from public.stock_tampon_lots where produit_id = 'ps90' and fournisseur_id = $1 order by id", [F2])).map(x => x.n);
  const sT1 = await stock('ps90');
  m = await echec('admin', "update public.commandes set statut = 'annulé' where id = '#T1'");
  test('#T1 (3 pièces tampon livrées) annulée par l\'administrateur', m === null, m);
  r = await rpc('admin', 'public.recrediter_stock_livraison($1, false)', ['#T1']);
  const lotsAp = (await q(P, "select quantite_restante as n from public.stock_tampon_lots where produit_id = 'ps90' and fournisseur_id = $1 order by id", [F2])).map(x => x.n);
  test('recrédit : stock du dépôt +3 (040) ET chaque pièce rendue à SON lot (2 au lot à 30, 1 au lot à 35)', r.ok && (await stock('ps90')) === sT1 + 3
    && lotsAp[0] === lotsAv[0] + 2 && lotsAp[1] === lotsAv[1] + 1 && r.lots_tampon_restaures.length === 3, { r, lotsAv, lotsAp });
  test('retours tracés (ajout seul), pièces passées au cycle 2, confirmation à refaire',
    (await nb("public.tampon_retours where cmd_id = '#T1'")) === 3 && /ajout seul/.test(await echec(P, 'delete from public.tampon_retours') || '')
    && (await nb("public.commande_pieces where cmd_id = '#T1' and cycle = 2 and livraison is null")) === 3);
  r = await rpc('admin', 'public.recrediter_stock_livraison($1, false)', ['#T1']);
  test('recrédit rejoué : « deja », aucun lot rendu deux fois', r.ok && r.deja === true && (await nb("public.tampon_retours where cmd_id = '#T1'")) === 3
    && JSON.stringify((await q(P, "select quantite_restante as n from public.stock_tampon_lots where produit_id = 'ps90' and fournisseur_id = $1 order by id", [F2])).map(x => x.n)) === JSON.stringify(lotsAp));
  test('relivraison : « livré » refusé tant que les pièces du nouveau cycle ne sont pas confirmées', /PIECES_NON_CONFIRMEES/.test(await echec('livreur', "update public.commandes set statut = 'livré' where id = '#T1'") || ''));
  const ptT1 = (await rpc('livreur', 'public.drop_pieces($1)', ['#T1'])).pieces;
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#T1', JSON.stringify(ptT1.map(x => ({ id: x.id, livree: true })))]);
  test('relivraison : confirmation du cycle 2 acceptée', r.ok && r.deja === false, r);
  await q('livreur', "update public.commandes set statut = 'livré' where id = '#T1'");
  const sT2 = await stock('ps90');
  r = await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#T1']);
  const cT2 = await q(P, "select cycle, cout_ht::float8 as c from public.pieces_couts where cmd_id = '#T1' order by cycle, piece_id");
  test('relivraison : nouvelles sorties des lots (cycle 2), stock −3, coûts du cycle 2 refigés', r.ok && r.deja === false && r.lots_tampon.length === 3 && (await stock('ps90')) === sT2 - 3
    && (await nb("public.tampon_sorties where cmd_id = '#T1' and cycle = 2")) === 3 && cT2.filter(x => x.cycle === 2).length === 3, { r, cT2 });
  r = await rpc('admin', 'public.drop_marge_commande($1)', ['#T1']);
  test('marge de la relivraison : coût du SEUL cycle en cours (95), pas le cumul des deux cycles (190)', r.ok && r.cout_ht === 95 && r.cout_estime === false, r);
  test('lots de nouveau écoulés comme après la 1re livraison', JSON.stringify((await q(P, "select quantite_restante as n from public.stock_tampon_lots where produit_id = 'ps90' and fournisseur_id = $1 order by id", [F2])).map(x => x.n)) === JSON.stringify(lotsAv));

  console.log('\n18. v7.5.201 : BORNES EXPLICITES (plus de limite silencieuse)');
  await cmd('#B1', { lignes: [{ produitId: 'pm140', qte: 51 }], prix: 0 });
  r = await rpc('livreur', 'public.drop_pieces($1)', ['#B1']);
  test('51 unités sur une ligne : refus explicite (quantite_hors_borne, max 50), aucune pièce créée', r.ok === false && r.erreur === 'quantite_hors_borne' && r.detail.raison === 'qte_ligne' && r.detail.max === 50
    && (await nb("public.commande_pieces where cmd_id = '#B1'")) === 0, r);
  await cmd('#B2', { lignes: [{ produitId: 'pm140', qte: 50 }], prix: 0 });
  r = await rpc('livreur', 'public.drop_pieces($1)', ['#B2']);
  test('50 unités : traitées INTÉGRALEMENT (50 pièces)', r.ok && r.pieces.length === 50, r.erreur);
  await q(P, "insert into public.produits (id, nom, cat, prix, stock, composants) values ('pe-lot', 'Lot fictif', 'Ensemble', 10, 0, '[{\"id\":\"ps90\",\"qte\":21}]')");
  await cmd('#B3', { lignes: [{ produitId: 'pe-lot', qte: 1 }], prix: 0 });
  r = await rpc('livreur', 'public.drop_pieces($1)', ['#B3']);
  test('composant × 21 dans un ensemble : refus explicite (max 20)', r.ok === false && r.erreur === 'quantite_hors_borne' && r.detail.raison === 'qte_composant' && r.detail.max === 20, r);
  await cmd('#B4', { lignes: [{ produitId: 'pm140', qte: 50 }, { produitId: 'pm140', qte: 50 }, { produitId: 'pm140', qte: 50 }, { produitId: 'pm140', qte: 50 }, { produitId: 'pm140', qte: 1 }], prix: 0 });
  r = await rpc('livreur', 'public.drop_pieces($1)', ['#B4']);
  test('201 pièces au total : refus explicite (max 200)', r.ok === false && r.erreur === 'quantite_hors_borne' && r.detail.raison === 'pieces', r);
  test('le découpage interne échoue au lieu de tronquer s\'il est appelé hors bornes', /quantite_hors_borne/.test(await echec(P, "select count(*) from interne.l041_decomposer('[{\"produitId\":\"pm140\",\"qte\":60}]'::jsonb, null, null)") || ''));
  await q(P, "update public.commandes set statut = 'livré' where id = '#B1'");
  r = await rpc('admin', 'public.drop_marge_commande($1)', ['#B1']);
  test('marge d\'une commande hors bornes (sans pièces) : coût signalé inconnu, jamais estimé sur une quantité tronquée', r.ok && r.cout_inconnu === 1 && r.cout_ht === 0, r);

  console.log('\n19. v7.5.205 (A) : TYPES DE LA VRAIE BASE — stock_camion.id est un uuid');
  const typ = async (t, c) => (await un(P, 'select udt_name from information_schema.columns where table_schema = $1 and table_name = $2 and column_name = $3', ['public', t, c]) || {}).udt_name;
  test('types alignés : stock_camion.id, commande_pieces.stock_camion_id et stock_camion_demande = uuid ; stock_camion.utilise_par_piece / achat_id = bigint',
    (await typ('stock_camion', 'id')) === 'uuid' && (await typ('commande_pieces', 'stock_camion_id')) === 'uuid' && (await typ('commande_pieces', 'stock_camion_demande')) === 'uuid'
    && (await typ('stock_camion', 'utilise_par_piece')) === 'int8' && (await typ('stock_camion', 'achat_id')) === 'int8');
  test('ligne du camion créée par la base : un VRAI uuid (défaut de la table), jamais un texte « sc_drop_… »', /^[0-9a-f-]{36}$/.test(String(sc3.id)) && (await nb("public.stock_camion where id::text like 'sc_drop_%'")) === 0);
  test('index unique partiel : une seule ligne du camion par achat', !!(await un(P, "select 1 as x from pg_indexes where indexname = 'stock_camion_achat_unique' and indexdef ilike '%(achat_id)%where%achat_id is not null%'")));
  await cmd('#U1', { lignes: [{ produitId: 'pm180', qte: 1 }], prix: 480 });
  const pU1 = (await rpc('livreur', 'public.drop_pieces($1)', ['#U1'])).pieces[0];
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [pU1.id, 'camion', 'sc_1700000000_abcdef']);
  test('identifiant de ligne du camion qui n\'est pas un uuid (ancienne appli) : refus propre « piece_camion_indisponible », jamais une erreur de type', r.ok === false && r.erreur === 'piece_camion_indisponible', r);
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [pU1.id, 'camion', '00000000-0000-0000-0000-000000000000']);
  test('uuid inconnu : « piece_camion_indisponible »', r.ok === false && r.erreur === 'piece_camion_indisponible', r);
  test('texte : plus aucun identifiant « sc_drop_ » ni comparaison au paramètre texte dans la 041', !/'sc_drop_'/.test(sql041) && !/where id = p_stock_camion_id/.test(sql041));

  console.log('\n20. v7.5.205 (C, revue native P1) : LIVRAISON PARTIELLE PUIS ANNULATION — la pièce achetée non livrée n\'est jamais livrée deux fois');
  await cmd('#R1', { lignes: [{ produitId: 'pm180', qte: 2 }], prix: 960 });
  const [pR1, pR2] = (await rpc('livreur', 'public.drop_pieces($1)', ['#R1'])).pieces;
  for (const x of [pR1, pR2]) {
    await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [x.id, 'fournisseur', F1]);
    await rpc('livreur', 'public.drop_enlever_payer($1, $2, $3, $4)', [x.id, 192, 'cb', null]);
  }
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#R1', JSON.stringify([{ id: pR1.id, livree: true }, { id: pR2.id, livree: false }])]);
  const achR2 = (await un(P, 'select achat_id from public.commande_pieces where id = $1', [pR2.id])).achat_id;
  const scR2 = await un(P, 'select * from public.stock_camion where achat_id = $1', [achR2]);
  test('livraison partielle : la 2e pièce achetée non livrée part dans le stock du camion (uuid, rattachée à son achat)', r.ok && scR2 && scR2.status === 'en_camion' && /^[0-9a-f-]{36}$/.test(scR2.id), { r, scR2 });
  await q('livreur', "update public.commandes set statut = 'livré' where id = '#R1'");
  r = await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#R1']);
  test('déduction de #R1 : rien retiré du dépôt (pièces fournisseur)', r.ok && r.retraits.length === 0, r);
  await q('admin', "update public.commandes set statut = 'annulé' where id = '#R1'");
  r = await rpc('admin', 'public.recrediter_stock_livraison($1, false)', ['#R1']);
  const pR2b = await un(P, 'select * from public.commande_pieces where id = $1', [pR2.id]);
  const pR1b = await un(P, 'select * from public.commande_pieces where id = $1', [pR1.id]);
  const achR1 = (await un(P, "select id from public.achats_fournisseur where piece_id = $1 and statut = 'paye'", [pR1.id])).id;
  const scR1 = await un(P, 'select * from public.stock_camion where achat_id = $1', [achR1]);
  // v7.5.208 (règle des 10 retours) : commande ANNULÉE après livraison → aucun achat payé ne reste attaché à la commande annulée
  test('annulation : la pièce NON livrée est remise à zéro ; v7.5.208 : la pièce LIVRÉE puis reprise aussi — son article acheté passe dans le STOCK DU CAMION (rattaché à son achat) ; cycle 2',
    r.ok && pR2b.provenance === null && pR2b.achat_id === null && pR2b.cycle === 2 && pR1b.provenance === null && pR1b.achat_id === null && pR1b.cycle === 2
    && r.pieces_a_redeclarer.length === 1 && r.pieces_a_redeclarer[0].stock_camion_id === scR2.id && r.pieces_liberees === 1
    && scR1 && scR1.status === 'en_camion' && scR1.utilise_par_piece === null
    && (await nb("public.drop_journal where action = 'commande_annulee_apres_livraison' and cmd_id = '#R1'")) === 1, { r, pR2b, pR1b, scR1 });
  test('l\'article acheté reste UNE seule ligne du camion, disponible (aucune ligne en double)', (await nb('public.stock_camion where achat_id = $1', [achR2])) === 1
    && (await un(P, 'select status, utilise_par_piece from public.stock_camion where id = $1', [scR2.id])).status === 'en_camion'
    && (await un(P, 'select utilise_par_piece from public.stock_camion where id = $1', [scR2.id])).utilise_par_piece === null);
  await q('admin', "update public.commandes set statut = 'en-route' where id = '#R1'");
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#R1', JSON.stringify([{ id: pR1.id, livree: true }, { id: pR2.id, livree: true }])]);
  test('relivraison : une pièce remise à zéro ne se confirme pas « livrée » sous son ancien achat (provenance manquante)', r.ok === false && r.erreur === 'provenance_manquante' && [pR1.id, pR2.id].includes(r.piece), r);
  const rR1 = await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [pR1.id, 'camion', scR1.id]);
  test('v7.5.208 : relivraison — l\'article livré puis repris se redéclare « Déjà dans le camion » sur SON achat, sans nouvel achat', rR1.ok && rR1.piece.origine === 'fournisseur' && rR1.piece.stock_camion_id === scR1.id, rR1);
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [pR2.id, 'camion', scR2.id]);
  test('relivraison : « Déjà dans le camion » sur l\'article acheté, sans nouvel achat', r.ok && r.piece.origine === 'fournisseur' && r.piece.stock_camion_id === scR2.id
    && (await nb("public.achats_fournisseur where cmd_id = '#R1' and statut <> 'annule'")) === 2, r);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#R1', JSON.stringify([{ id: pR1.id, livree: true }, { id: pR2.id, livree: true }])]);
  test('relivraison confirmée : l\'article sort du camion (livré) ; coût du cycle 2 = achat d\'origine (achat_camion)', r.ok
    && (await un(P, 'select status from public.stock_camion where id = $1', [scR2.id])).status === 'livre'
    && (await un(P, 'select source from public.pieces_couts where piece_id = $1 and cycle = 2', [pR2.id])).source === 'achat_camion', r);
  await cmd('#R3', { lignes: [{ produitId: 'pm180', qte: 1 }], prix: 480 });
  const pR3 = (await rpc('livreur', 'public.drop_pieces($1)', ['#R3'])).pieces[0];
  test('l\'article livré n\'est plus proposé à une autre commande', !pR3.camion.some(x => x.id === scR2.id), pR3.camion);
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [pR3.id, 'camion', scR2.id]);
  test('… ni déclarable « Déjà dans le camion »', r.ok === false && r.erreur === 'piece_camion_indisponible', r);
  // garde de la confirmation : un état ancien (pièce restée « fournisseur » alors que son achat est au camion) est refusé
  await cmd('#R4', { lignes: [{ produitId: 'pm180', qte: 1 }], prix: 480 });
  const pR4 = (await rpc('livreur', 'public.drop_pieces($1)', ['#R4'])).pieces[0];
  await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [pR4.id, 'fournisseur', F1]);
  await rpc('livreur', 'public.drop_enlever_payer($1, $2, $3, $4)', [pR4.id, 192, 'cb', null]);
  const achR4 = (await un(P, 'select achat_id from public.commande_pieces where id = $1', [pR4.id])).achat_id;
  await rpc('livreur', 'public.drop_commande_non_livree($1)', ['#R4']);
  await q(P, "update public.commande_pieces set provenance = 'fournisseur', origine = 'fournisseur', fournisseur_id = $2, achat_id = $3 where id = $1", [pR4.id, F1, achR4]);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#R4', JSON.stringify([{ id: pR4.id, livree: true }])]);
  test('garde : pièce « fournisseur » dont l\'achat est au camion → « livrée » REFUSÉ (achat_au_camion), rien de confirmé', r.ok === false && r.erreur === 'achat_au_camion'
    && (await un(P, 'select livraison from public.commande_pieces where id = $1', [pR4.id])).livraison === null, r);

  console.log('\n21. v7.5.205 (D, revue native P2) : RÉSERVATION ET CONSOMMATION PAR UNITÉ (ligne du camion de plusieurs unités)');
  // ligne chargée la veille par l'appli : 2 unités, sans produit_id (libellé), sans achat
  const scW = (await un(P, "insert into public.stock_camion (livreur, produit_libelle, quantite, source_cmd_id, charge_at, status) values ('Livreur-A', 'Matelas fictif 140', 2, '#AVANT', now() - interval '1 day', 'en_camion') returning id")).id;
  await cmd('#W1', { lignes: [{ produitId: 'pm140', qte: 1 }], prix: 360 });
  await cmd('#W2', { lignes: [{ produitId: 'pm140', qte: 1 }], prix: 360 });
  await cmd('#W3', { lignes: [{ produitId: 'pm140', qte: 1 }], prix: 360 });
  const pW1 = (await rpc('livreur', 'public.drop_pieces($1)', ['#W1'])).pieces[0];
  test('la ligne de 2 unités est proposée avec sa quantité', pW1.camion.some(x => x.id === scW && x.quantite === 2), pW1.camion);
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [pW1.id, 'camion', scW]);
  const uW1 = r.piece && r.piece.stock_camion_id;
  test('1re unité déclarée : la ligne est DÉCOUPÉE (une unité réservée à la pièce, la ligne d\'origine garde 1 unité libre)', r.ok && uW1 && uW1 !== scW
    && (await un(P, 'select quantite, utilise_par_piece from public.stock_camion where id = $1', [scW])).quantite === 1
    && (await un(P, 'select utilise_par_piece from public.stock_camion where id = $1', [scW])).utilise_par_piece === null
    && (await un(P, 'select quantite, utilise_par_piece, scinde_de from public.stock_camion where id = $1', [uW1])).scinde_de === scW, r);
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [pW1.id, 'camion', scW]);
  test('même déclaration rejouée (ligne d\'origine) : « deja », aucune 2e unité prise', r.ok && r.deja === true && (await un(P, 'select quantite from public.stock_camion where id = $1', [scW])).quantite === 1, r);
  const pW2 = (await rpc('livreur', 'public.drop_pieces($1)', ['#W2'])).pieces[0];
  test('la 2e unité RESTE disponible pour une autre commande (avant : toute la ligne était réservée)', pW2.camion.some(x => x.id === scW && x.quantite === 1) && !pW2.camion.some(x => x.id === uW1), pW2.camion);
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [pW2.id, 'camion', scW]);
  test('2e unité déclarée par une autre commande : acceptée', r.ok && r.piece.stock_camion_id === scW, r);
  const pW3 = (await rpc('livreur', 'public.drop_pieces($1)', ['#W3'])).pieces[0];
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [pW3.id, 'camion', scW]);
  test('plus d\'unité libre : 3e commande refusée', r.ok === false && r.erreur === 'piece_camion_indisponible', r);
  for (const [c, p] of [['#W1', pW1], ['#W2', pW2]]) await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', [c, JSON.stringify([{ id: p.id, livree: true }])]);
  test('livraisons confirmées : CHAQUE unité sort du camion (2 lignes d\'une unité « livre »), rien ne reste en camion',
    (await nb("public.stock_camion where (id = $1 or scinde_de = $1) and status = 'livre' and quantite = 1", [scW])) === 2
    && (await nb("public.stock_camion where (id = $1 or scinde_de = $1) and status = 'en_camion'", [scW])) === 0);
  // une unité réservée puis libérée (redéclarée Dépôt) redevient disponible
  const scV = (await un(P, "insert into public.stock_camion (livreur, produit_libelle, quantite, source_cmd_id, charge_at, status) values ('Livreur-A', 'Matelas fictif 140', 3, '#AVANT', now() - interval '1 day', 'en_camion') returning id")).id;
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [pW3.id, 'camion', scV]);
  const uW3 = r.piece && r.piece.stock_camion_id;
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [pW3.id, 'depot']);
  test('unité libérée (redéclarée Dépôt) : de nouveau disponible, le total des unités est conservé (2 + 1)', r.ok
    && (await un(P, 'select utilise_par_piece from public.stock_camion where id = $1', [uW3])).utilise_par_piece === null
    && Number((await un(P, "select sum(quantite)::int as n from public.stock_camion where (id = $1 or scinde_de = $1) and status = 'en_camion'", [scV])).n) === 3, r);

  console.log('\n22. v7.5.205 (E, avis chatgpt-review n° 1) : COMMANDE CONCERNÉE JAMAIS DÉCOUPÉE — découpage et confirmation imposés, dérogation explicite');
  const DECOUP = /DECOUPAGE_REQUIS/;
  await cmd('#E1', { lignes: [{ produitId: 'pm140', qte: 1 }], prix: 360 });
  test('commande concernée (nos livreurs, livreur attribué, créée après l\'activation) jamais découpée : « livré » REFUSÉ au livreur (DECOUPAGE_REQUIS)',
    DECOUP.test(await echec('livreur', "update public.commandes set statut = 'livré' where id = '#E1'") || ''));
  test('… à l\'administrateur aussi, et par un upsert', DECOUP.test(await echec('admin', "update public.commandes set statut = 'livré' where id = '#E1'") || '')
    && DECOUP.test(await echec('livreur', "insert into public.commandes (id, client, livreur, statut, date_livraison) values ('#E1', 'Client fictif', 'Livreur-A', 'livré', $1) on conflict (id) do update set statut = excluded.statut", [AUJ]) || ''));
  test('contournement impossible : le livreur qui vide le livreur ou passe en GLS dans la même écriture reste refusé',
    DECOUP.test(await echec('livreur', "update public.commandes set statut = 'livré', livreur = '' where id = '#E1'") || '')
    && DECOUP.test(await echec('livreur', "update public.commandes set statut = 'livré', transporteur = 'GLS' where id = '#E1'") || ''));
  test('statut inchangé en base', (await un(P, "select statut from public.commandes where id = '#E1'")).statut === 'en-route');
  await q(P, "update public.commandes set statut = 'livré' where id = '#E1'");   // hors session (serveur, maintenance) : non bloqué
  const s140e = await stock('pm140');
  r = await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#E1']);
  test('« livré » posé hors session : la déduction REFUSE (decoupage_requis), rien retiré, alerte, stock_deduit reste faux', r.ok === false && r.erreur === 'decoupage_requis'
    && (await stock('pm140')) === s140e && (await nb("public.drop_alertes where type = 'livre_sans_confirmation' and cmd_id = '#E1'")) === 1
    && !(await un(P, "select stock_deduit from public.commandes where id = '#E1'")).stock_deduit, r);
  r = await rpc('livreurB', 'public.deduire_stock_livraison($1)', ['#E1']);
  test('autre livreur : rien n\'est révélé (réponse de la 040)', r.ok === false && r.erreur !== 'decoupage_requis', r);
  r = await rpc('admin', 'public.drop_livre_sans_confirmation($1, $2)', ['#E1', 'Livrée par le bureau, vérifiée']);
  test('dérogation explicite de l\'administrateur sur une commande jamais découpée : cycle 1, journalisée', r.ok && r.cycle === 1
    && (await nb("public.drop_journal where action = 'derogation_livre' and cmd_id = '#E1'")) === 1, r);
  r = await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#E1']);
  test('après dérogation : déduction par la 040 (1 matelas)', r.ok && r.mode === undefined && (await stock('pm140')) === s140e - 1, r);
  await cmd('#E2', { lignes: [{ produitId: 'pm140', qte: 1 }], prix: 360 });
  r = await rpc('admin', 'public.drop_livre_sans_confirmation($1, $2)', ['#E2', 'Livrée par le bureau, vérifiée']);
  test('dérogation de l\'administrateur AVANT le « livré » : « livré » accepté ensuite', r.ok && (await echec('livreur', "update public.commandes set statut = 'livré' where id = '#E2'")) === null, r);
  await cmd('#E3', { lignes: [{ produitId: 'pm140', qte: 1 }], prix: 360, transporteur: 'GLS' });
  test('compatibilité : commande GLS jamais découpée (même avec un livreur) → « livré » accepté, déduction 040', (await echec('livreur', "update public.commandes set statut = 'livré' where id = '#E3'")) === null
    && (await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#E3'])).ok === true);
  await cmd('#E4', { lignes: [{ produitId: 'pm140', qte: 1 }], prix: 360, livreur: '' });
  test('compatibilité : commande sans livreur (bureau, retrait) → « livré » accepté ; dérogation inutile (rien_a_deroger)', (await echec('admin', "update public.commandes set statut = 'livré' where id = '#E4'")) === null
    && (await rpc('admin', 'public.drop_livre_sans_confirmation($1, $2)', ['#E4', 'Livrée par le bureau, vérifiée'])).erreur === 'rien_a_deroger');
  await cmd('#E5', { lignes: [{ produitId: 'pm140', qte: 1 }], prix: 360, statut: 'livré', avant: 60, livreeActivation: true });
  test('compatibilité : ancienne commande déjà livrée : remise « livré » ou modifiée sans blocage', (await echec('admin', "update public.commandes set statut = 'livré', prix = 361 where id = '#E5'")) === null);
  test('création directe « livré » d\'une commande concernée (bureau, avec livreur) : refusée — créer, déroger, puis livrer', DECOUP.test(await echec('admin', "insert into public.commandes (id, client, livreur, statut, date_livraison) values ('#E6', 'Client fictif', 'Livreur-A', 'livré', $1)", [AUJ]) || ''));
  await cmd('#E7', { lignes: [{ produitId: 'pm140', qte: 1 }], prix: 360 });
  const pE7 = (await rpc('livreur', 'public.drop_pieces($1)', ['#E7'])).pieces[0];
  test('une fois découpée : le contrôle pièce par pièce reprend (PIECES_NON_CONFIRMEES)', /PIECES_NON_CONFIRMEES/.test(await echec('livreur', "update public.commandes set statut = 'livré' where id = '#E7'") || ''));
  await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [pE7.id, 'depot']);
  await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#E7', JSON.stringify([{ id: pE7.id, livree: true }])]);
  test('… puis « livré » accepté après la confirmation', (await echec('livreur', "update public.commandes set statut = 'livré' where id = '#E7'")) === null);
  await q('admin', "update public.parametres set valeur = 'n importe quoi' where cle = 'drop_actif_depuis'");
  await cmd('#E8', { lignes: [{ produitId: 'pm140', qte: 1 }], prix: 360, avant: 400 });
  test('commande créée 400 jours avant, pas livrée : concernée (v7.5.206 : la date d\'activation, même illisible, ne compte plus)', DECOUP.test(await echec('livreur', "update public.commandes set statut = 'livré' where id = '#E8'") || ''));
  await q('admin', "update public.parametres set valeur = $1 where cle = 'drop_actif_depuis'", [ACTIF]);

  console.log('\n23. v7.5.205 (avis chatgpt-review sur 3728fb8, point 3) : STOCK TAMPON ÉPUISÉ ENTRE LA DÉCLARATION ET LA LIVRAISON');
  await q(P, "insert into public.produits (id, nom, cat, prix, stock) values ('pt-or', 'Oreiller fictif', 'Oreiller', 30, 2)");
  await q(P, "insert into public.produits_revient (produit_id, prix_revient_ht) values ('pt-or', 8)");
  r = (await un('admin', ENTREE, ['cle-entree-or', F1, AUJ, 'especes', null, JSON.stringify([{ produit_id: 'pt-or', qte: 1, prix_ttc: 12 }])])).r;
  test('lot tampon d\'UNE unité chez F1 (oreiller fictif, coût HT 10)', r.ok && r.lots[0].prix_ht === 10, r);
  await cmd('#K1', { lignes: [{ produitId: 'pt-or', qte: 1 }], prix: 36 });
  await cmd('#K2', { lignes: [{ produitId: 'pt-or', qte: 1 }], prix: 36 });
  const pK1 = (await rpc('livreur', 'public.drop_pieces($1)', ['#K1'])).pieces[0];
  const pK2 = (await rpc('livreur', 'public.drop_pieces($1)', ['#K2'])).pieces[0];
  for (const x of [pK1, pK2]) await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [x.id, 'tampon', F1]);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#K1', JSON.stringify([{ id: pK1.id, livree: true }])]);
  test('1re commande confirmée : la dernière unité du lot lui est promise', r.ok, r);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#K2', JSON.stringify([{ id: pK2.id, livree: true }])]);
  test('2e commande déclarée sur le même lot (épuisé entre-temps) : « livrée » REFUSÉ (stock_tampon_epuise), rien de confirmé', r.ok === false && r.erreur === 'stock_tampon_epuise'
    && (await un(P, 'select livraison from public.commande_pieces where id = $1', [pK2.id])).livraison === null, r);
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [pK2.id, 'depot']);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#K2', JSON.stringify([{ id: pK2.id, livree: true }])]);
  test('… redéclarée « Dépôt — stock BMS » : confirmée, coût au revient BMS assumé', r.ok && (await un(P, 'select source from public.pieces_couts where piece_id = $1', [pK2.id])).source === 'revient', r);
  // lot vidé entre la confirmation et la déduction (correction de lot, autre écriture) : la déduction refuse au lieu de retirer en silence
  await q(P, "update public.stock_tampon_lots set quantite_restante = 0 where produit_id = 'pt-or'");
  await q('livreur', "update public.commandes set statut = 'livré' where id = '#K1'");
  const sOr = await stock('pt-or');
  r = await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#K1']);
  test('lot épuisé à la déduction : REFUS (stock_tampon_epuise) AVANT toute écriture — stock du dépôt intact, aucun coût au revient, alerte', r.ok === false && r.erreur === 'stock_tampon_epuise'
    && (await stock('pt-or')) === sOr && (await nb('public.pieces_couts where piece_id = $1', [pK1.id])) === 0
    && (await nb("public.drop_alertes where type = 'tampon_epuise' and cle = 'cmd:#K1' and vue_at is null")) === 1
    && !(await un(P, "select stock_deduit from public.commandes where id = '#K1'")).stock_deduit, r);
  test('correction : refusée au livreur, motif obligatoire', (await rpc('livreur', 'public.drop_tampon_corriger($1, $2)', [pK1.id, 'lot vide'])).erreur === 'admin_requis'
    && (await rpc('admin', 'public.drop_tampon_corriger($1, $2)', [pK1.id, 'x'])).erreur === 'motif_requis');
  r = await rpc('admin', 'public.drop_tampon_corriger($1, $2)', [pK1.id, 'Lot vidé à l\'inventaire, pièce prise au stock BMS']);
  test('correction EXPLICITE de l\'administrateur : pièce notée « Dépôt — stock BMS », coût figé au revient 8, journalisée (motif), alerte vue', r.ok && r.cout_ht === 8
    && (await un(P, 'select provenance from public.commande_pieces where id = $1', [pK1.id])).provenance === 'depot'
    && (await nb("public.drop_journal where action = 'correction_tampon_vers_depot' and piece_id = $1 and details ->> 'motif' like 'Lot vidé%'", [pK1.id])) === 1
    && (await nb("public.drop_alertes where type = 'tampon_epuise' and cle = 'cmd:#K1' and vue_at is null")) === 0, r);
  r = await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#K1']);
  test('après correction : la déduction retire la pièce du dépôt (1), coût = revient corrigé', r.ok && (await stock('pt-or')) === sOr - 1
    && Number((await un(P, 'select cout_ht from public.pieces_couts where piece_id = $1', [pK1.id])).cout_ht) === 8, r);
  test('correction : impossible une 2e fois (commande déduite)', (await rpc('admin', 'public.drop_tampon_corriger($1, $2)', [pK1.id, 'Encore une correction'])).ok === false);

  console.log('\n24. v7.5.206 (revue native P2 sur cfbf0fa) : LIVRAISON CONFIRMÉE MAIS JAMAIS DÉDUITE, PUIS ANNULATION → pièces rouvertes');
  const scR = (await un(P, "insert into public.stock_camion (livreur, produit_libelle, quantite, source_cmd_id, charge_at, status) values ('Livreur-A', 'Sommier fictif 90', 1, '#AVANT', now() - interval '1 day', 'en_camion') returning id")).id;
  await cmd('#Q1', { lignes: [{ produitId: 'ps90', qte: 1 }, { produitId: 'pm140', qte: 1 }], prix: 480 });
  const [pQ1, pQ2] = (await rpc('livreur', 'public.drop_pieces($1)', ['#Q1'])).pieces;
  await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [pQ1.id, 'camion', scR]);
  await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [pQ2.id, 'depot']);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#Q1', JSON.stringify([{ id: pQ1.id, livree: true }, { id: pQ2.id, livree: true }])]);
  const uR = (await un(P, 'select stock_camion_id as u from public.commande_pieces where id = $1', [pQ1.id])).u;
  test('pièces confirmées (unité du camion « livre »), « livré » posé, déduction PAS faite (en attente)', r.ok
    && (await echec('livreur', "update public.commandes set statut = 'livré' where id = '#Q1'")) === null
    && (await un(P, 'select status from public.stock_camion where id = $1', [uR])).status === 'livre'
    && !(await un(P, "select stock_deduit from public.commandes where id = '#Q1'")).stock_deduit, r);
  r = await rpc('admin', 'public.recrediter_stock_livraison($1, false)', ['#Q1']);
  test('recrédit alors que la commande est ENCORE livrée : rien n\'est rouvert (cycle 1, pièces confirmées)', r.ok && !r.pieces_rouvertes_sans_deduction
    && (await nb("public.commande_pieces where cmd_id = '#Q1' and cycle = 1 and livraison = 'livree'")) === 2, r);
  const sR = { s: await stock('ps90'), m: await stock('pm140') };
  await q('admin', "update public.commandes set statut = 'annulé' where id = '#Q1'");
  r = await rpc('admin', 'public.recrediter_stock_livraison($1, false)', ['#Q1']);
  test('annulation : la 040 répond « deja » (rien à rendre, stock intact) MAIS les pièces sont ROUVERTES (nouveau cycle, issue effacée)', r.ok && r.deja === true
    && r.pieces_rouvertes_sans_deduction === true && r.pieces_nouveau_cycle === 2 && (await stock('ps90')) === sR.s && (await stock('pm140')) === sR.m
    && (await nb("public.commande_pieces where cmd_id = '#Q1' and cycle = 2 and livraison is null")) === 2, r);
  test('… l\'unité du camion confirmée livrée revient « en_camion » (plus jamais « livre » pour une commande annulée)',
    (await un(P, 'select status from public.stock_camion where id = $1', [uR])).status === 'en_camion');
  test('… journal du recrédit des pièces marqué « sans déduction »',
    (await nb("public.drop_journal where action = 'recredit_pieces' and cmd_id = '#Q1' and details ->> 'sans_deduction' = 'true'")) === 1);
  r = await rpc('admin', 'public.recrediter_stock_livraison($1, false)', ['#Q1']);
  test('rejeu : déjà réconcilié → rien de plus (cycle 2 conservé, pas de 2e journal)', r.ok && r.deja === true && !r.pieces_rouvertes_sans_deduction
    && (await nb("public.commande_pieces where cmd_id = '#Q1' and cycle = 2")) === 2
    && (await nb("public.drop_journal where action = 'recredit_pieces' and cmd_id = '#Q1'")) === 1, r);
  test('v7.5.208 : commande annulée — l\'unité du camion est LIBÉRÉE (disponible pour une autre commande), la pièce « Déjà dans le camion » est remise à zéro ; la pièce Dépôt garde sa déclaration',
    (await un(P, 'select utilise_par_piece from public.stock_camion where id = $1', [uR])).utilise_par_piece === null
    && (await un(P, 'select provenance from public.commande_pieces where id = $1', [pQ1.id])).provenance === null
    && (await un(P, 'select provenance from public.commande_pieces where id = $1', [pQ2.id])).provenance === 'depot');
  await q('admin', "update public.commandes set statut = 'en-route' where id = '#Q1'");
  await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [pQ1.id, 'camion', uR]);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#Q1', JSON.stringify([{ id: pQ1.id, livree: true }, { id: pQ2.id, livree: true }])]);
  await q('livreur', "update public.commandes set statut = 'livré' where id = '#Q1'");
  const rR = await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#Q1']);
  test('relivraison : confirmée au cycle 2, unité du camion de nouveau sortie, UNE seule déduction (une demande par pièce, rien de rendu deux fois)', r.ok && rR.ok && rR.mode === 'pieces'
    && (await un(P, 'select status from public.stock_camion where id = $1', [uR])).status === 'livre'
    && rR.retraits.reduce((t, x) => t + x.demande, 0) === 2 && (await un(P, "select stock_deduit from public.commandes where id = '#Q1'")).stock_deduit === true, { r, rR });

  console.log('\n25. v7.5.206 (revue native P2 sur cfbf0fa) : COMMANDE ANNULÉE AVANT SA LIVRAISON → achat payé dans le stock du camion');
  await cmd('#N1', { lignes: [{ produitId: 'pm180', qte: 1 }], prix: 480 });
  const pN1 = (await rpc('livreur', 'public.drop_pieces($1)', ['#N1'])).pieces[0];
  await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [pN1.id, 'fournisseur', F1]);
  r = await rpc('livreur', 'public.drop_enlever_payer($1, $2, $3, $4)', [pN1.id, 192, 'cb', null]);
  const aN1 = (await un(P, 'select achat_id from public.commande_pieces where id = $1', [pN1.id])).achat_id;
  test('« Enlevé et payé » avant la livraison', r.ok && aN1 > 0, r);
  await q('livreur', "update public.commandes set statut = 'annulé' where id = '#N1'");
  test('arrêt ANNULÉ par le livreur : l\'achat payé n\'est plus attaché à la commande, il est dans le STOCK DU CAMION (en_camion, rattaché à l\'achat)',
    (await un(P, 'select provenance, achat_id from public.commande_pieces where id = $1', [pN1.id])).achat_id === null
    && (await nb("public.stock_camion where achat_id = $1 and status = 'en_camion' and source_cmd_id = '#N1'", [aN1])) === 1
    && (await un(P, 'select statut from public.achats_fournisseur where id = $1', [aN1])).statut === 'paye'
    && (await nb("public.drop_journal where action = 'commande_annulee_non_livree' and cmd_id = '#N1'")) === 1);
  r = await rpc('livreur', 'public.drop_commande_non_livree($1)', ['#N1']);
  test('rejouable : l\'appel de l\'appli après l\'annulation ne fait rien de plus (0 pièce, 1 seule ligne du camion)', r.ok && r.pieces === 0
    && (await nb('public.stock_camion where achat_id = $1', [aN1])) === 1, r);
  await cmd('#N2', { lignes: [{ produitId: 'pm180', qte: 1 }], prix: 480 });
  const pN2 = (await rpc('livreur', 'public.drop_pieces($1)', ['#N2'])).pieces[0];
  await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [pN2.id, 'fournisseur', F1]);
  const aN2 = (await un(P, 'select achat_id from public.commande_pieces where id = $1', [pN2.id])).achat_id;
  await q('collab', "update public.commandes set statut = 'annulé' where id = '#N2'");
  test('annulée par la COLLABORATRICE (fiche commande) avant l\'enlèvement : achat prévu annulé, déclaration remise à zéro',
    (await un(P, 'select statut from public.achats_fournisseur where id = $1', [aN2])).statut === 'annule'
    && (await un(P, 'select provenance from public.commande_pieces where id = $1', [pN2.id])).provenance === null);
  await cmd('#N3', { lignes: [{ produitId: 'pm140', qte: 1 }], prix: 360 });
  const pN3 = (await rpc('livreur', 'public.drop_pieces($1)', ['#N3'])).pieces[0];
  await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [pN3.id, 'depot']);
  await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#N3', JSON.stringify([{ id: pN3.id, livree: true }])]);
  await q('livreur', "update public.commandes set statut = 'livré' where id = '#N3'");
  await q('admin', "update public.commandes set statut = 'annulé' where id = '#N3'");
  test('annulation APRÈS livraison : le déclencheur ne touche rien (le recrédit s\'en charge) — pièce toujours confirmée',
    (await un(P, 'select livraison, provenance from public.commande_pieces where id = $1', [pN3.id])).provenance === 'depot'
    && (await nb("public.drop_journal where action = 'commande_annulee_non_livree' and cmd_id = '#N3'")) === 0);

  // =========================================================================================================================
  console.log('\n26. v7.5.207 (revue native P2 sur c22dacd) : LIGNES DU CHARGEMENT RÉCONCILIÉES À LA LIVRAISON — un article livré n\'est jamais reproposé');
  await q(P, `insert into public.produits (id, nom, cat, prix, stock) values ('pz140', 'Matelas fictif Z', 'Matelas', 300, 5), ('pz90', 'Sommier fictif Z', 'Sommier', 120, 5)`);
  await q(P, "insert into public.produits_revient (produit_id, prix_revient_ht) values ('pz140', 90), ('pz90', 35)");
  await cmd('#Z1', { lignes: [{ produitId: 'pz140', nom: 'Matelas fictif Z', qte: 1 }, { produitId: 'pz90', nom: 'Sommier fictif Z', qte: 2 }], prix: 540 });
  const pZ1 = (await rpc('livreur', 'public.drop_pieces($1)', ['#Z1'])).pieces;
  // lignes cochées à l'écran de chargement : l'appli crée ses lignes du camion (uuid, source_cmd_id, sans achat ni pièce)
  await q('livreur', "insert into public.stock_camion (livreur, produit_libelle, quantite, source_cmd_id, source_tournee_id, charge_par, status) values ('Livreur-A', 'Matelas fictif Z', 1, '#Z1', 'T-1', 'Livreur-A', 'en_camion'), ('Livreur-A', 'Sommier fictif Z', 2, '#Z1', 'T-1', 'Livreur-A', 'en_camion')");
  for (const p of pZ1) await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [p.id, 'depot']);
  const sZ = pZ1.filter((p) => p.produit_id === 'pz90');
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#Z1', JSON.stringify(pZ1.map((p) => ({ id: p.id, livree: p.id !== sZ[1].id })))]);
  test('confirmation : les 2 lignes du chargement (matelas, 2 sommiers) sont fermées « livre », quelle que soit la provenance déclarée (Dépôt)',
    r.ok && r.chargement && r.chargement.fermees.length === 2
    && (await nb("public.stock_camion where source_cmd_id = '#Z1' and piece_id is null and status = 'livre'")) === 2
    && (await nb("public.stock_camion where source_cmd_id = '#Z1' and piece_id is null and status = 'en_camion'")) === 0, r);
  const gZ = await q(P, "select * from public.stock_camion where source_cmd_id = '#Z1' and status = 'en_camion'");
  test('seule l\'unité NON livrée reste dans le camion : 1 ligne d\'une unité, rattachée à la pièce « pas livrée » (produit renseigné, livreur, tournée)',
    gZ.length === 1 && String(gZ[0].piece_id) === String(sZ[1].id) && gZ[0].produit_id === 'pz90' && gZ[0].quantite === 1 && gZ[0].livreur === 'Livreur-A'
    && gZ[0].source_tournee_id === 'T-1' && gZ[0].achat_id === null && r.chargement.gardees.length === 1, { gZ, r });
  test('journal : réconciliation du chargement tracée (fermées, gardées)', (await nb("public.drop_journal where action = 'chargement_reconcilie' and cmd_id = '#Z1'")) === 1);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#Z1', JSON.stringify(pZ1.map((p) => ({ id: p.id, livree: true })))]);
  test('rejeu de la confirmation : « deja », aucune ligne fermée ni créée en plus', r.ok && r.deja === true
    && (await nb("public.stock_camion where source_cmd_id = '#Z1'")) === 3, r);
  await q('livreur', "update public.commandes set statut = 'livré' where id = '#Z1'");
  const avZ = { m: await stock('pz140'), s: await stock('pz90') };
  r = await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#Z1']);
  test('déduction inchangée : matelas et sommier LIVRÉS retirés du dépôt (5 → 4, 5 → 4), le sommier non livré n\'est pas retiré',
    r.ok && (await stock('pz140')) === avZ.m - 1 && (await stock('pz90')) === avZ.s - 1, { r, avZ });
  // LE LENDEMAIN : les lignes du chargement d'hier ne sont proposées à AUCUNE commande ; seule l'unité non livrée l'est
  await q(P, "update public.stock_camion set charge_at = now() - interval '1 day' where source_cmd_id = '#Z1'");
  await cmd('#Z2', { lignes: [{ produitId: 'pz140', nom: 'Matelas fictif Z', qte: 1 }, { produitId: 'pz90', nom: 'Sommier fictif Z', qte: 1 }], prix: 420 });
  const pZ2 = (await rpc('livreur', 'public.drop_pieces($1)', ['#Z2'])).pieces;
  const mZ2 = pZ2.find((p) => p.produit_id === 'pz140'), sZ2 = pZ2.find((p) => p.produit_id === 'pz90');
  test('lendemain : le matelas LIVRÉ hier n\'est plus proposé « Déjà dans le camion » (aucune ligne du camion pour lui)', (mZ2.camion || []).length === 0, mZ2.camion);
  test('lendemain : le sommier livré hier non plus — seule l\'unité NON livrée est proposée (1 choix, 1 unité)',
    (sZ2.camion || []).length === 1 && sZ2.camion[0].id === gZ[0].id && sZ2.camion[0].quantite === 1, sZ2.camion);
  const mZL = await un(P, "select id from public.stock_camion where source_cmd_id = '#Z1' and produit_libelle = 'Matelas fictif Z'");
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [mZ2.id, 'camion', mZL.id]);
  test('une ligne du chargement déjà livrée ne peut pas être déclarée « Déjà dans le camion » (2e consommation refusée)', !r.ok && r.erreur === 'piece_camion_indisponible', r);
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [sZ2.id, 'camion', gZ[0].id]);
  const rZ2 = await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [mZ2.id, 'depot']);
  test('l\'unité non livrée se déclare « Déjà dans le camion » (venue du dépôt)', r.ok && rZ2.ok && r.piece.stock_camion_id === gZ[0].id && r.piece.origine === 'depot', r);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#Z2', JSON.stringify(pZ2.map((p) => ({ id: p.id, livree: true })))]);
  test('livrée à #Z2 : l\'unité sort du camion (« livre ») ; plus rien de #Z1 dans le camion', r.ok
    && (await un(P, 'select status from public.stock_camion where id = $1', [gZ[0].id])).status === 'livre'
    && (await nb("public.stock_camion where source_cmd_id in ('#Z1', '#Z2') and status = 'en_camion'")) === 0, r);
  // aucune ligne de chargement (ligne jamais cochée, déblocage du bureau) : rien n'est inventé dans le camion
  await cmd('#Z3', { lignes: [{ produitId: 'pz90', nom: 'Sommier fictif Z', qte: 1 }], prix: 140 });
  const pZ3 = (await rpc('livreur', 'public.drop_pieces($1)', ['#Z3'])).pieces[0];
  await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [pZ3.id, 'depot']);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#Z3', JSON.stringify([{ id: pZ3.id, livree: false }])]);
  test('sans ligne de chargement : pièce « pas livrée » d\'origine dépôt, aucune ligne du camion créée (rien ne prouve qu\'elle y est)',
    r.ok && r.chargement.fermees.length === 0 && (await nb("public.stock_camion where source_cmd_id = '#Z3'")) === 0, r);
  test('texte : la confirmation appelle la réconciliation du chargement dans la même fonction',
    /create or replace function public\.drop_confirmer_livraison[\s\S]*?interne\.l041_reconcilier_chargement\(c\.id, c\.livreur\)[\s\S]*?end \$\$;/.test(sql041));

  // =========================================================================================================================
  console.log('\n27. v7.5.208 (RÈGLE DES 10 RETOURS ; revue native P2 sur bac211e) : UNITÉ GARDÉE RATTACHÉE À SA LIGNE DE CHARGEMENT, garde du camion, rejeux');
  await q(P, "insert into public.produits (id, nom, cat, prix, stock) values ('py140', 'Matelas fictif Y', 'Matelas', 300, 5), ('py90', 'Sommier fictif Y', 'Sommier', 120, 5), ('py80', 'Oreiller fictif Y', 'Linge', 30, 9)");
  await q(P, "insert into public.produits_revient (produit_id, prix_revient_ht) values ('py140', 90), ('py90', 35), ('py80', 6)");
  const ins = (cmdId, lib, qte, idx, quand) => un('livreur', "insert into public.stock_camion (livreur, produit_libelle, quantite, source_cmd_id, source_tournee_id, charge_par, status, ligne_idx, charge_at) values ('Livreur-A', $1, $2, $3, 'T-1', 'Livreur-A', 'en_camion', $4, coalesce($5::timestamptz, now())) returning id", [lib, qte, cmdId, idx, quand || null]);
  // A) la réserve native : 2 lignes, UNE seule cochée au chargement, départ par le déblocage du bureau
  await cmd('#Y1', { lignes: [{ produitId: 'py140', nom: 'Matelas fictif Y', qte: 1 }, { produitId: 'py90', nom: 'Sommier fictif Y', qte: 1 }], prix: 500 });
  const pY1 = (await rpc('livreur', 'public.drop_pieces($1)', ['#Y1'])).pieces;
  await ins('#Y1', 'Matelas fictif Y', 1, 0);                 // seule la ligne 0 (matelas) est cochée
  for (const p of pY1) await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [p.id, 'depot']);
  const mY1 = pY1.find((p) => p.produit_id === 'py140'), sY1 = pY1.find((p) => p.produit_id === 'py90');
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#Y1', JSON.stringify([{ id: mY1.id, livree: true }, { id: sY1.id, livree: false }])]);
  test('réserve native : matelas (ligne cochée) livré, sommier (ligne JAMAIS cochée) « pas livré » → AUCUNE unité fictive dans le camion',
    r.ok && r.chargement.fermees.length === 1 && r.chargement.fermees[0].ligne_idx === 0 && r.chargement.gardees.length === 0
    && (await nb("public.stock_camion where source_cmd_id = '#Y1' and status = 'en_camion'")) === 0, r);
  await q(P, "update public.stock_camion set charge_at = now() - interval '1 day' where source_cmd_id = '#Y1'");
  await cmd('#Y2', { lignes: [{ produitId: 'py90', nom: 'Sommier fictif Y', qte: 1 }], prix: 140 });
  const pY2 = (await rpc('livreur', 'public.drop_pieces($1)', ['#Y2'])).pieces[0];
  test('… le lendemain, l\'article resté au DÉPÔT n\'est PAS proposé « Déjà dans le camion »', (pY2.camion || []).length === 0, pY2.camion);
  // B) la ligne cochée garde SON unité non livrée
  await cmd('#Y3', { lignes: [{ produitId: 'py140', nom: 'Matelas fictif Y', qte: 1 }, { produitId: 'py90', nom: 'Sommier fictif Y', qte: 1 }], prix: 500 });
  const pY3 = (await rpc('livreur', 'public.drop_pieces($1)', ['#Y3'])).pieces;
  await ins('#Y3', 'Sommier fictif Y', 1, 1);                 // seule la ligne 1 (sommier) est cochée
  for (const p of pY3) await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [p.id, 'depot']);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#Y3', JSON.stringify(pY3.map((p) => ({ id: p.id, livree: false })))]);
  const gY3 = await q(P, "select * from public.stock_camion where source_cmd_id = '#Y3' and status = 'en_camion'");
  test('ligne cochée, pièce « pas livrée » : SON unité est gardée (ligne 1, sommier) ; la ligne jamais cochée (matelas) ne garde rien',
    r.ok && gY3.length === 1 && gY3[0].produit_id === 'py90' && gY3[0].ligne_idx === 1 && String(gY3[0].piece_id) === String(pY3.find((p) => p.produit_id === 'py90').id), { r, gY3 });
  // C) plafond : ligne de 2 unités, une seule chargée (ligne du camion de 1) → une seule unité gardée
  await cmd('#Y4', { lignes: [{ produitId: 'py90', nom: 'Sommier fictif Y', qte: 2 }], prix: 280 });
  const pY4 = (await rpc('livreur', 'public.drop_pieces($1)', ['#Y4'])).pieces;
  await ins('#Y4', 'Sommier fictif Y', 1, 0);
  for (const p of pY4) await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [p.id, 'depot']);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#Y4', JSON.stringify(pY4.map((p) => ({ id: p.id, livree: false })))]);
  test('plafond : 1 unité chargée sur 2 commandées, 2 pièces « pas livrées » → UNE seule unité gardée (jamais plus que ce qui a été chargé)',
    r.ok && r.chargement.gardees.length === 1 && (await nb("public.stock_camion where source_cmd_id = '#Y4' and status = 'en_camion'")) === 1, r);
  // D) ligne du camion sans indice (ancienne) : rattachée par son libellé ; libellé inconnu : fermée, non rattachée, rien gardé
  await cmd('#Y5', { lignes: [{ produitId: 'py140', nom: 'Matelas fictif Y', qte: 1 }, { produitId: 'py90', nom: 'Sommier fictif Y', qte: 1 }], prix: 500 });
  const pY5 = (await rpc('livreur', 'public.drop_pieces($1)', ['#Y5'])).pieces;
  await ins('#Y5', 'Sommier fictif Y', 1, null);
  await ins('#Y5', 'Article inconnu', 1, null);
  for (const p of pY5) await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [p.id, 'depot']);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#Y5', JSON.stringify(pY5.map((p) => ({ id: p.id, livree: false })))]);
  test('ligne du camion SANS indice : rattachée par son libellé (sommier → ligne 1, unité gardée) ; libellé inconnu → fermée « non rattachée », rien gardé ; tout tracé',
    r.ok && r.chargement.fermees.length === 1 && r.chargement.fermees[0].ligne_idx === 1 && r.chargement.non_rattachees.length === 1
    && r.chargement.gardees.length === 1 && r.chargement.gardees[0].ligne_idx === 1
    && (await nb("public.stock_camion where source_cmd_id = '#Y5' and status = 'en_camion'")) === 1
    && (await nb("public.drop_journal where action = 'chargement_reconcilie' and cmd_id = '#Y5' and jsonb_array_length(details -> 'non_rattachees') = 1")) === 1, r);
  // E) unité réservée UNE fois puis libérée : plus une ligne du chargement de sa commande d'origine (jamais fermée par elle)
  await cmd('#Y6', { lignes: [{ produitId: 'py140', nom: 'Matelas fictif Y', qte: 1 }], prix: 360 });
  const pY6 = (await rpc('livreur', 'public.drop_pieces($1)', ['#Y6'])).pieces[0];
  const uY6 = (await ins('#Y6', 'Matelas fictif Y', 1, 0, new Date(Date.now() - 86400000).toISOString())).id;   // chargée la veille (report)
  await cmd('#Y7', { lignes: [{ produitId: 'py140', nom: 'Matelas fictif Y', qte: 1 }], prix: 360 });
  const pY7 = (await rpc('livreur', 'public.drop_pieces($1)', ['#Y7'])).pieces[0];
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [pY7.id, 'camion', uY6]);
  test('« Déjà dans le camion » sur la ligne d\'une unité d\'une autre commande : réservée, marquée « réservée une fois »',
    r.ok && r.piece.stock_camion_id === uY6 && (await un(P, 'select reservee_une_fois from public.stock_camion where id = $1', [uY6])).reservee_une_fois === true, r);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#Y7', JSON.stringify([{ id: pY7.id, livree: false }])]);
  await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [pY6.id, 'depot']);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#Y6', JSON.stringify([{ id: pY6.id, livree: true }])]);
  test('… libérée (pièce de #Y7 pas livrée), elle RESTE dans le camion quand #Y6 est confirmée (unité libre, jamais fermée par sa commande d\'origine)',
    r.ok && r.chargement.fermees.length === 0 && (await un(P, 'select status, utilise_par_piece from public.stock_camion where id = $1', [uY6])).status === 'en_camion', r);
  // F) unité gardée venue du STOCK TAMPON : elle sortira de SON lot (coût réel, lot décompté), jamais au revient BMS
  r = (await un('admin', ENTREE, ['cle-entree-y80', F1, AUJ, 'cb', null, JSON.stringify([{ produit_id: 'py80', qte: 3, prix_ht: 4 }])])).r;
  await cmd('#Y8', { lignes: [{ produitId: 'py80', nom: 'Oreiller fictif Y', qte: 1 }], prix: 40 });
  const pY8 = (await rpc('livreur', 'public.drop_pieces($1)', ['#Y8'])).pieces[0];
  await ins('#Y8', 'Oreiller fictif Y', 1, 0);
  await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [pY8.id, 'tampon', F1]);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#Y8', JSON.stringify([{ id: pY8.id, livree: false }])]);
  const gY8 = await un(P, "select * from public.stock_camion where source_cmd_id = '#Y8' and status = 'en_camion'");
  test('pièce « stock tampon » pas livrée : unité gardée avec le FOURNISSEUR DE SON LOT', r.ok && gY8 && String(gY8.tampon_fournisseur_id) === String(F1), { r, gY8 });
  await q(P, "update public.stock_camion set charge_at = now() - interval '1 day' where id = $1", [gY8.id]);
  await cmd('#Y9', { lignes: [{ produitId: 'py80', nom: 'Oreiller fictif Y', qte: 1 }], prix: 40 });
  const pY9 = (await rpc('livreur', 'public.drop_pieces($1)', ['#Y9'])).pieces[0];
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [pY9.id, 'camion', gY8.id]);
  test('le lendemain « Déjà dans le camion » : la pièce reprend le fournisseur du lot (origine dépôt)', r.ok && r.piece.origine === 'depot' && String(r.piece.fournisseur_id) === String(F1), r);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#Y9', JSON.stringify([{ id: pY9.id, livree: true }])]);
  test('… confirmée : coût PAS encore figé (il le sera à la sortie de son lot)', r.ok && (await nb('public.pieces_couts where piece_id = $1', [pY9.id])) === 0, r);
  const lotY = await un(P, "select id, quantite_restante from public.stock_tampon_lots where produit_id = 'py80'");
  const s80 = await stock('py80');
  await q('livreur', "update public.commandes set statut = 'livré' where id = '#Y9'");
  r = await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#Y9']);
  test('déduction : la pièce sort de SON lot (lot −1, sortie tracée), stock du dépôt −1, coût = prix réel du lot (4), pas le revient BMS (6)',
    r.ok && r.lots_tampon.length === 1 && (await un(P, 'select quantite_restante from public.stock_tampon_lots where id = $1', [lotY.id])).quantite_restante === lotY.quantite_restante - 1
    && (await stock('py80')) === s80 - 1 && Number((await un(P, 'select cout_ht from public.pieces_couts where piece_id = $1', [pY9.id])).cout_ht) === 4
    && (await un(P, 'select source from public.pieces_couts where piece_id = $1', [pY9.id])).source === 'tampon', r);
  // G) garde du camion : une session de l'appli ne fabrique ni ne ranime une unité
  const GARDE = /STOCK_CAMION_RESERVE/;
  const achAny = (await un(P, "select id from public.achats_fournisseur where statut = 'paye' limit 1")).id;
  test('garde : le livreur ne crée pas une unité rattachée à un achat (ni pièce, ni réservation, ni lot tampon)',
    GARDE.test(await echec('livreur', "insert into public.stock_camion (livreur, produit_libelle, quantite, status, achat_id) values ('Livreur-A', 'X', 1, 'en_camion', $1)", [achAny]) || '')
    && GARDE.test(await echec('livreur', "insert into public.stock_camion (livreur, produit_libelle, quantite, status, tampon_fournisseur_id) values ('Livreur-A', 'X', 1, 'en_camion', $1)", [F1]) || ''));
  test('garde : le livreur ne libère ni ne réserve une unité directement, ne change pas sa quantité',
    GARDE.test(await echec('livreur', 'update public.stock_camion set utilise_par_piece = null where id = $1', [gY8.id]) || '')
    && GARDE.test(await echec('livreur', 'update public.stock_camion set quantite = 5 where id = $1', [uY6]) || ''));
  const livreY = (await un(P, "select id from public.stock_camion where source_cmd_id = '#Y1' and status = 'livre' limit 1")).id;
  test('garde : une ligne sortie (livrée) n\'est JAMAIS ranimée « en_camion » par l\'appli', GARDE.test(await echec('livreur', "update public.stock_camion set status = 'en_camion' where id = $1", [livreY]) || ''));
  test('garde : le retour au dépôt d\'une ligne (statut de sortie) reste permis à l\'appli', (await echec('livreur', "update public.stock_camion set status = 'retourne_depot', retour_at = now(), retour_par = 'Livreur-A' where id = $1", [uY6])) === null);
  // H) ligne du chargement reçue APRÈS la confirmation de toutes les pièces (téléphone resté hors ligne) : fermée par la base
  const tard = await ins('#Y1', 'Sommier fictif Y', 1, 1);
  test('ligne du chargement reçue après la confirmation : enregistrée FERMÉE « livre », tracée — jamais proposée « Déjà dans le camion »',
    (await un(P, 'select status from public.stock_camion where id = $1', [tard.id])).status === 'livre'
    && (await nb("public.drop_journal where action = 'chargement_tardif_ferme' and cmd_id = '#Y1'")) === 1);
  // I) rejeu d'une confirmation avec une pièce répétée (issues contradictoires) : refusée, rien de confirmé
  await cmd('#Y10', { lignes: [{ produitId: 'py90', nom: 'Sommier fictif Y', qte: 1 }], prix: 140 });
  const pY10 = (await rpc('livreur', 'public.drop_pieces($1)', ['#Y10'])).pieces[0];
  await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [pY10.id, 'depot']);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#Y10', JSON.stringify([{ id: pY10.id, livree: true }, { id: pY10.id, livree: false }])]);
  test('confirmation où la même pièce figure deux fois (livrée ET pas livrée) : REFUSÉE (pieces_incompletes), rien de confirmé',
    r.ok === false && r.erreur === 'pieces_incompletes' && (await un(P, 'select livraison from public.commande_pieces where id = $1', [pY10.id])).livraison === null, r);
  test('texte : la réconciliation lit l\'indice de la ligne (ligne_idx), plafonne par la quantité chargée et exclut les unités réservées une fois / découpées',
    /create or replace function interne\.l041_reconcilier_chargement[\s\S]*?r\.ligne_idx[\s\S]*?v_cap := least[\s\S]*?end \$\$;/.test(sql041)
    && /sc\.scinde_de is null and not coalesce\(sc\.reservee_une_fois, false\)/.test(sql041));

  // =========================================================================================================================
  console.log('\n28. v7.5.208 (revue native P2 sur 8905a30) : UNITÉ DU DÉPÔT GARDÉE AU CYCLE PRÉCÉDENT, PUIS ANNULATION ET RELIVRAISON « Dépôt »');
  await cmd('#UG1', { lignes: [{ produitId: 'py140', nom: 'Matelas fictif Y', qte: 1 }, { produitId: 'py90', nom: 'Sommier fictif Y', qte: 1 }], prix: 500 });
  const pG1 = (await rpc('livreur', 'public.drop_pieces($1)', ['#UG1'])).pieces;
  await ins('#UG1', 'Matelas fictif Y', 1, 0); await ins('#UG1', 'Sommier fictif Y', 1, 1);
  for (const p of pG1) await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [p.id, 'depot']);
  const mG1 = pG1.find((p) => p.produit_id === 'py140'), sG1 = pG1.find((p) => p.produit_id === 'py90');
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#UG1', JSON.stringify([{ id: mG1.id, livree: true }, { id: sG1.id, livree: false }])]);
  const uG1 = await un(P, "select * from public.stock_camion where piece_id = $1 and status = 'en_camion'", [sG1.id]);
  test('cycle 1 : livraison partielle, le sommier « pas livré » garde SON unité dans le camion', r.ok && !!uG1, r);
  await q('livreur', "update public.commandes set statut = 'livré' where id = '#UG1'");
  await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#UG1']);
  await q('admin', "update public.commandes set statut = 'en-attente' where id = '#UG1'");   // le bureau annule la livraison
  r = await rpc('admin', 'public.recrediter_stock_livraison($1, false)', ['#UG1']);
  test('annulation de la livraison : recrédit ok, nouveau cycle, l\'unité gardée est encore dans le camion', r.ok
    && (await un(P, 'select status from public.stock_camion where id = $1', [uG1.id])).status === 'en_camion', r);
  for (const p of pG1) await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [p.id, 'depot']);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#UG1', JSON.stringify(pG1.map((p) => ({ id: p.id, livree: true })))]);
  test('relivraison déclarée « Dépôt » : l\'unité gardée pour CETTE pièce est FERMÉE « livre » dans la même transaction (tracée dans la réponse)',
    r.ok && (await un(P, 'select status from public.stock_camion where id = $1', [uG1.id])).status === 'livre'
    && r.pieces.some((x) => String(x.id) === String(sG1.id) && (x.unite_gardee_fermee || []).map(String).includes(String(uG1.id))), r);
  await q(P, "update public.stock_camion set charge_at = now() - interval '1 day' where source_cmd_id = '#UG1'");
  await cmd('#UG2', { lignes: [{ produitId: 'py90', nom: 'Sommier fictif Y', qte: 1 }], prix: 140 });
  const pG2 = (await rpc('livreur', 'public.drop_pieces($1)', ['#UG2'])).pieces[0];
  test('… le lendemain, l\'article livré n\'est PAS proposé « Déjà dans le camion » à une autre commande',
    !(pG2.camion || []).some((x) => String(x.id) === String(uG1.id)), pG2.camion);
  // unité gardée déjà RÉSERVÉE par une autre pièce : elle reste à cette autre commande
  await cmd('#UG3', { lignes: [{ produitId: 'py90', nom: 'Sommier fictif Y', qte: 1 }], prix: 140 });
  const pG3 = (await rpc('livreur', 'public.drop_pieces($1)', ['#UG3'])).pieces[0];
  await ins('#UG3', 'Sommier fictif Y', 1, 0);
  await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [pG3.id, 'depot']);
  await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#UG3', JSON.stringify([{ id: pG3.id, livree: false }])]);
  const uG3 = await un(P, "select * from public.stock_camion where piece_id = $1 and status = 'en_camion'", [pG3.id]);
  await q(P, "update public.stock_camion set charge_at = now() - interval '1 day' where id = $1", [uG3.id]);
  await cmd('#UG4', { lignes: [{ produitId: 'py90', nom: 'Sommier fictif Y', qte: 1 }], prix: 140 });
  const pG4 = (await rpc('livreur', 'public.drop_pieces($1)', ['#UG4'])).pieces[0];
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [pG4.id, 'camion', uG3.id]);
  const uG4 = r.piece && r.piece.stock_camion_id;
  await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [pG3.id, 'depot']);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#UG3', JSON.stringify([{ id: pG3.id, livree: true }])]);
  test('unité gardée déjà réservée par une autre commande : non touchée par la relivraison « Dépôt » (elle reste à l\'autre commande)',
    r.ok && !!uG4 && (await un(P, 'select status, utilise_par_piece from public.stock_camion where id = $1', [uG4])).status === 'en_camion', { r, uG4 });

  // =========================================================================================================================
  {   // sections 29 et 30 : variables locales au bloc
  console.log('\n29. v7.5.208 (revue native P2 sur 8905a30) : COMMANDE SUPPRIMÉE AVANT SA LIVRAISON → achats et réservations libérés');
  await q('admin', "insert into public.fournisseur_prix (produit_id, fournisseur_id, prix_achat_ht) values ('py140', $1, 100), ('py90', $1, 40)", [F1]);
  await q('admin', "insert into public.drop_produits (produit_id, actif) values ('py140', true), ('py90', true) on conflict (produit_id) do update set actif = true");
  await cmd('#US1', { lignes: [{ produitId: 'py140', nom: 'Matelas fictif Y', qte: 1 }], prix: 360 });
  const pS1 = (await rpc('livreur', 'public.drop_pieces($1)', ['#US1'])).pieces[0];
  await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [pS1.id, 'fournisseur', F1]);
  r = await rpc('livreur', 'public.drop_enlever_payer($1, $2, $3, $4)', [pS1.id, 120, 'cb', null]);
  const aS1 = (await un(P, 'select achat_id from public.commande_pieces where id = $1', [pS1.id])).achat_id;
  test('« Enlevé et payé » avant la livraison', r.ok && aS1 > 0, r);
  e = await echec('admin', "delete from public.commandes where id = '#US1'");
  test('le bureau SUPPRIME la commande (simple DELETE) : l\'achat payé n\'est plus attaché à la pièce, il est dans le STOCK DU CAMION (rattaché à l\'achat), tracé',
    e === null && (await nb("public.commandes where id = '#US1'")) === 0
    && (await un(P, 'select achat_id, provenance from public.commande_pieces where id = $1', [pS1.id])).achat_id === null
    && (await nb("public.stock_camion where achat_id = $1 and status = 'en_camion'", [aS1])) === 1
    && (await un(P, 'select statut from public.achats_fournisseur where id = $1', [aS1])).statut === 'paye'
    && (await nb("public.drop_journal where action = 'commande_supprimee_non_livree' and cmd_id = '#US1'")) === 1, e);
  // réservation « Déjà dans le camion » et achat prévu : libérés par la suppression
  const uS2 = (await un(P, "select id from public.stock_camion where achat_id = $1", [aS1])).id;
  await q(P, "update public.stock_camion set charge_at = now() - interval '1 day' where id = $1", [uS2]);
  await cmd('#US2', { lignes: [{ produitId: 'py140', nom: 'Matelas fictif Y', qte: 1 }, { produitId: 'py90', nom: 'Sommier fictif Y', qte: 1 }], prix: 500 });
  const pS2 = (await rpc('livreur', 'public.drop_pieces($1)', ['#US2'])).pieces;
  const mS2 = pS2.find((p) => p.produit_id === 'py140'), sS2 = pS2.find((p) => p.produit_id === 'py90');
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [mS2.id, 'camion', uS2]);
  test('« Déjà dans le camion » : l\'article acheté est réservé à la pièce de #US2', r.ok && (await un(P, 'select utilise_par_piece from public.stock_camion where id = $1', [uS2])).utilise_par_piece !== null, r);
  await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [sS2.id, 'fournisseur', F1]);
  const aS2 = (await un(P, 'select achat_id from public.commande_pieces where id = $1', [sS2.id])).achat_id;
  e = await echec('collab', "delete from public.commandes where id = '#US2'");
  test('suppression par la collaboratrice : réservation LIBÉRÉE (article disponible), achat prévu ANNULÉ, déclarations remises à zéro',
    e === null && (await un(P, 'select utilise_par_piece, status from public.stock_camion where id = $1', [uS2])).utilise_par_piece === null
    && (await un(P, 'select statut from public.achats_fournisseur where id = $1', [aS2])).statut === 'annule'
    && (await nb('public.commande_pieces where cmd_id = $1 and provenance is not null', ['#US2'])) === 0, e);
  // commande LIVRÉE supprimée par le recrédit (p_suppression) : supprimée par la fonction, stock rendu, pièces rouvertes
  await cmd('#US3', { lignes: [{ produitId: 'py90', nom: 'Sommier fictif Y', qte: 1 }], prix: 140 });
  const pS3 = (await rpc('livreur', 'public.drop_pieces($1)', ['#US3'])).pieces[0];
  await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [pS3.id, 'depot']);
  await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#US3', JSON.stringify([{ id: pS3.id, livree: true }])]);
  await q('livreur', "update public.commandes set statut = 'livré' where id = '#US3'");
  const s90 = await stock('py90');
  await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#US3']);
  r = await rpc('admin', 'public.recrediter_stock_livraison($1, true)', ['#US3']);
  test('commande LIVRÉE, recrédit p_suppression : commande supprimée par la fonction, stock rendu (py90 revenu à ' + s90 + '), pièces rouvertes',
    r.ok && (await nb("public.commandes where id = '#US3'")) === 0 && (await stock('py90')) === s90
    && (await un(P, 'select livraison from public.commande_pieces where id = $1', [pS3.id])).livraison === null, r);

  // =========================================================================================================================
  console.log('\n30. v7.5.208 (revue native P2 sur 8905a30) : RETOUR AU DÉPÔT D\'UNE UNITÉ ACHETÉE → stock du dépôt + lot au coût payé');
  const s140R = await stock('py140');
  const nLots = await nb("public.stock_tampon_lots where produit_id = 'py140'");
  e = await echec('livreur', "update public.stock_camion set status = 'retourne_depot', retour_at = now(), retour_par = 'Livreur-A' where id = $1", [uS2]);
  const lotR = await un(P, "select l.*, e.cle from public.stock_tampon_lots l join public.stock_tampon_entrees e on e.id = l.entree_id where e.cle = $1", ['retour_achat:' + aS1]);
  const achR = await un(P, 'select montant_paye_ht, fournisseur_id from public.achats_fournisseur where id = $1', [aS1]);
  test('« Retour dépôt » (PATCH de l\'appli) d\'un article acheté : stock du dépôt +1, lot d\'UNE unité au coût PAYÉ HT, fournisseur de l\'achat, opération et journal',
    e === null && (await stock('py140')) === s140R + 1 && !!lotR && lotR.quantite_restante === 1
    && Number(lotR.prix_achat_ht) === Number(achR.montant_paye_ht) && String(lotR.fournisseur_id) === String(achR.fournisseur_id)
    && (await nb('public.stock_operations where cle = $1', ['tampon:retour_achat:' + aS1 + ':' + lotR.id])) === 1
    && (await nb("public.drop_journal where action = 'retour_depot_achat' and achat_id = $1", [aS1])) === 1, { e, lotR, achR });
  e = await echec('livreur', "update public.stock_camion set status = 'retourne_depot', retour_par = 'Livreur-A' where id = $1", [uS2]);
  test('rejoué (2e envoi du même retour) : rien de plus (stock, lots inchangés)', e === null && (await stock('py140')) === s140R + 1
    && (await nb("public.stock_tampon_lots where produit_id = 'py140'")) === nLots + 1, e);
  // la prochaine livraison « stock tampon » sort de CE lot, au coût payé
  await cmd('#US4', { lignes: [{ produitId: 'py140', nom: 'Matelas fictif Y', qte: 1 }], prix: 360 });
  const pS4 = (await rpc('livreur', 'public.drop_pieces($1)', ['#US4'])).pieces[0];
  await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [pS4.id, 'tampon', achR.fournisseur_id]);
  await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#US4', JSON.stringify([{ id: pS4.id, livree: true }])]);
  await q('livreur', "update public.commandes set statut = 'livré' where id = '#US4'");
  r = await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#US4']);
  test('livraison suivante « stock tampon » : sortie de CE lot, coût = prix payé (pas le revient BMS)', r.ok
    && Number((await un(P, 'select cout_ht from public.pieces_couts where piece_id = $1', [pS4.id])).cout_ht) === Number(achR.montant_paye_ht)
    && (await un(P, 'select quantite_restante from public.stock_tampon_lots where id = $1', [lotR.id])).quantite_restante === 0, r);
  // une ligne du chargement (sans achat) retournée au dépôt : rien n'entre au stock (elle n'en est jamais sortie)
  await cmd('#US5', { lignes: [{ produitId: 'py140', nom: 'Matelas fictif Y', qte: 1 }], prix: 360 });
  const uOrd = (await ins('#US5', 'Matelas fictif Y', 1, 0)).id;
  const s140O = await stock('py140');
  e = await echec('livreur', "update public.stock_camion set status = 'retourne_depot' where id = $1", [uOrd]);
  test('ligne ordinaire du chargement retournée au dépôt : stock du dépôt inchangé', e === null && (await stock('py140')) === s140O, e);

  }

  console.log('\nRÉSULTAT : ' + ok + ' tests réussis, ' + ko + ' échec(s)');
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERREUR DU BANC :', e); process.exit(1); });
