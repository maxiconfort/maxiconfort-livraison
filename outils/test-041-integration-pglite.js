// Banc d'INTÉGRATION de la migration 041 (v7.5.205, avis chatgpt-review sur b8b7fe0, point 2) sur une base PostgreSQL JETABLE,
// EN MÉMOIRE (@electric-sql/pglite 0.2.17 = PostgreSQL 16 en WebAssembly : rien n'est écrit sur le disque, aucune connexion à
// la vraie base).
// Usage : node outils/test-041-integration-pglite.js   (SAUTER_PGLITE=1 pour le sauter volontairement : « SAUTÉ », ne vaut jamais preuve)
// VALEURS FICTIVES uniquement (dépôt PUBLIC) : aucun client, aucun fournisseur, aucun prix réel.
//
// Différence avec outils/test-041-pglite.js (banc détaillé de la 041) : ICI, AUCUNE table d'une migration n'est recopiée.
//   1. Les tables HISTORIQUES (créées hors migrations) sont recréées avec les types, défauts, NOT NULL, clés et politiques de
//      session RELEVÉS dans la vraie base le 27/11/2026 (SELECT de lecture sur information_schema, pg_constraint, pg_policies,
//      pg_trigger — aucune écriture) : produits, commandes, tournees, depenses, caisse_remises, parametres, stock_camion
//      (id UUID), mouvements_stock (id UUID). Le relevé est embarqué plus bas (RELEVE) et COMPARÉ colonne par colonne à la
//      base du banc après les migrations.
//   2. Les migrations déjà en service dans la vraie base sont appliquées telles quelles : garde du livreur de la 019 (extrait
//      tel quel), 004, 020, 024, 025, 031.
//   3. Puis les VRAIES migrations de la mise en ligne, dans l'ordre obligatoire et telles quelles : 038b → 039 → 040 → 041.
//   4. Parcours principaux rejoués : livré avec pièces (Dépôt, fournisseur payé en espèces dans la caisse de la tournée,
//      stock tampon), livraison partielle → stock du camion (uuid), annulation / recrédit (dépôt, lot tampon, pièce remise à
//      zéro), relivraison « Déjà dans le camion », ligne du camion de plusieurs unités, point de caisse validé (038b), commande
//      concernée jamais découpée.
// LIMITES (documentées) : une seule connexion (pas de concurrence réelle) ; pas de PostgREST ni de Storage (appels reproduits
// en SQL) ; session par paramètre (en production : en-têtes x-app-secret / x-session-token, table sessions_app, digest) ;
// politiques « brain_read » (lecture du cerveau MAXI BRAIN) et déclencheurs de paiement / annulation / Klaviyo / litige de
// commandes NON reproduits (ils ne touchent ni le statut « livré » ni le stock) ; schéma storage minimal.
const fs = require('fs'), path = require('path');
const racine = path.join(__dirname, '..');
const VERSION_ATTENDUE = '0.2.17';
const SAUTER = process.env.SAUTER_PGLITE === '1';
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (e) {
  if (SAUTER) { console.log('BANC 041 INTÉGRATION SAUTÉ VOLONTAIREMENT (SAUTER_PGLITE=1) : la mise en ligne 038b → 041 n\'a PAS été testée.'); process.exit(0); }
  console.error('ÉCHEC DU BANC 041 INTÉGRATION : dépendance @electric-sql/pglite absente — rien n\'a été testé.');
  console.error('Installer @electric-sql/pglite ' + VERSION_ATTENDUE + ' (npm install), ou SAUTER_PGLITE=1 pour le sauter volontairement.');
  process.exit(2);
}
const lireMigration = (n) => fs.readFileSync(path.join(racine, 'supabase', 'migrations', n), 'utf8');
let ok = 0, ko = 0;
const test = (nom, cond, det) => { if (cond) { ok++; console.log('  OK   ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (det !== undefined ? ' — ' + JSON.stringify(det) : '')); } };

// RELEVÉ de la vraie base (27/11/2026, information_schema.columns) : [colonne, type (udt_name), nullable, défaut résumé]
const RELEVE = {
  stock_camion: [['id', 'uuid', 'NO', 'gen_random_uuid()'], ['livreur', 'text', 'NO'], ['produit_libelle', 'text', 'NO'], ['quantite', 'int4', 'NO', '1'],
    ['source_cmd_id', 'text', 'YES'], ['source_tournee_id', 'text', 'YES'], ['charge_at', 'timestamptz', 'YES', 'now()'], ['charge_par', 'text', 'YES'],
    ['status', 'text', 'YES', "'en_camion'::text"], ['retour_at', 'timestamptz', 'YES'], ['retour_par', 'text', 'YES'], ['notes', 'text', 'YES'],
    ['created_at', 'timestamptz', 'YES', 'now()'], ['updated_at', 'timestamptz', 'YES', 'now()']],
  commandes: [['id', 'text', 'NO'], ['client', 'text', 'NO'], ['tel', 'text', 'YES'], ['email', 'text', 'YES'], ['adresse', 'text', 'YES'], ['etage', 'text', 'YES'],
    ['ascenseur', 'text', 'YES'], ['code', 'text', 'YES'], ['produit', 'text', 'YES'], ['lignes', 'jsonb', 'YES'], ['qte', 'int4', 'YES', '1'], ['prix', 'numeric', 'YES', '0'],
    ['prix_brut', 'numeric', 'YES', '0'], ['remise_globale', 'numeric', 'YES', '0'], ['remise_globale_val', 'numeric', 'YES', '0'], ['remise_globale_type', 'text', 'YES', "'pct'::text"],
    ['remise_motif', 'text', 'YES'], ['paie', 'text', 'YES', "'Espèces'::text"], ['stpaie', 'text', 'YES', "'Non payé'::text"], ['montant_enc', 'numeric', 'YES'],
    ['livreur', 'text', 'YES'], ['statut', 'text', 'YES', "'en-attente'::text"], ['date_livraison', 'text', 'YES'], ['instr', 'text', 'YES'], ['origine', 'text', 'YES'],
    ['ref_marketplace', 'text', 'YES'], ['created_at', 'timestamptz', 'YES', 'now()'], ['updated_at', 'timestamptz', 'YES', 'now()'], ['mode_paie', 'text', 'YES', "'Espèces'::text"],
    ['date_commande', 'date', 'YES', 'CURRENT_DATE'], ['tracking_token', 'uuid', 'YES', 'gen_random_uuid()'], ['transporteur', 'text', 'YES', "'RANOU'::text"],
    ['tracking_transporteur', 'text', 'YES'], ['sms_envoyes', 'jsonb', 'YES', "'[]'::jsonb"], ['frais_port', 'numeric', 'YES', '0'], ['stock_deduit', 'bool', 'YES', 'false'],
    ['payment_source', 'text', 'YES'], ['ticket_cb', 'text', 'YES'], ['encaisse_par', 'text', 'YES'], ['encaisse_at', 'timestamptz', 'YES'], ['encaisse_tournee', 'text', 'YES'],
    ['annulation_motif', 'text', 'YES'], ['annulation_commentaire', 'text', 'YES'], ['annulation_par', 'text', 'YES'], ['annulation_at', 'timestamptz', 'YES']],
  produits: [['id', 'text', 'NO'], ['nom', 'text', 'NO'], ['cat', 'text', 'YES'], ['dim', 'text', 'YES'], ['prix', 'numeric', 'YES', '0'], ['poids', 'numeric', 'YES', '0'],
    ['stock', 'int4', 'YES', '0'], ['seuil', 'int4', 'YES', '2'], ['empl', 'text', 'YES'], ['remarque', 'text', 'YES'], ['actif', 'bool', 'YES', 'true'],
    ['created_at', 'timestamptz', 'YES', 'now()'], ['updated_at', 'timestamptz', 'YES', 'now()'], ['composants', 'jsonb', 'YES'], ['ancienne_offre', 'bool', 'NO', 'false']],
  tournees: [['id', 'text', 'NO'], ['livreur', 'text', 'YES'], ['date_tournee', 'text', 'YES'], ['statut', 'text', 'YES', "'préparée'::text"], ['stops', 'jsonb', 'YES', "'[]'::jsonb"],
    ['created_at', 'timestamptz', 'YES', 'now()'], ['updated_at', 'timestamptz', 'YES', 'now()']],
  depenses: [['id', 'text', 'NO'], ['date_depense', 'text', 'YES'], ['cat', 'text', 'YES'], ['montant', 'numeric', 'YES'], ['livreur', 'text', 'YES'], ['comment', 'text', 'YES'],
    ['created_at', 'timestamptz', 'YES', 'now()'], ['mode_paie', 'text', 'YES', "'Espèces'::text"], ['tournee_id', 'text', 'YES']],
  caisse_remises: [['key_remise', 'text', 'NO'], ['livreur', 'text', 'NO'], ['periode', 'text', 'YES'], ['validee', 'bool', 'YES', 'true'], ['date_remise', 'timestamptz', 'YES', 'now()'],
    ['par', 'text', 'YES'], ['especes_attendues', 'numeric', 'YES'], ['especes_remises', 'numeric', 'YES'], ['ecart', 'numeric', 'YES'], ['cb_encaisse', 'numeric', 'YES'], ['commentaire', 'text', 'YES']],
  parametres: [['cle', 'text', 'NO'], ['valeur', 'text', 'YES'], ['updated_at', 'timestamptz', 'YES', 'now()']],
  mouvements_stock: [['id', 'uuid', 'NO', 'gen_random_uuid()'], ['date_mouvement', 'timestamptz', 'YES', 'now()'], ['type', 'text', 'NO'], ['produit_libelle', 'text', 'NO'],
    ['quantite', 'int4', 'NO', '1'], ['source', 'text', 'YES'], ['destination', 'text', 'YES'], ['commande_id', 'text', 'YES'], ['tournee_id', 'text', 'YES'],
    ['livreur', 'text', 'YES'], ['par_user', 'text', 'YES'], ['notes', 'text', 'YES'], ['created_at', 'timestamptz', 'YES', 'now()']],
};
const SQLTYPE = { text: 'text', int4: 'integer', numeric: 'numeric', jsonb: 'jsonb', bool: 'boolean', timestamptz: 'timestamptz', date: 'date', uuid: 'uuid' };
// clés primaires relevées (pg_constraint) : caisse_remises = key_remise (PAS de colonne id), parametres = cle, les autres = id
const CLE = { caisse_remises: 'key_remise', parametres: 'cle' };
function ddl(t) {
  return 'create table public.' + t + ' (\n  ' + RELEVE[t].map(([c, u, n, d]) => c + ' ' + SQLTYPE[u] + (c === (CLE[t] || 'id') ? ' primary key' : '')
    + (n === 'NO' && c !== (CLE[t] || 'id') ? ' not null' : '') + (d ? ' default ' + d : '')).join(',\n  ') + ');';
}

const SQL_ROLES = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role l41i_postgres nologin bypassrls;
grant usage, create on schema public to l41i_postgres;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role l41i_postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role l41i_postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role l41i_postgres in schema public grant all on functions to anon, authenticated, service_role;
create schema interne authorization l41i_postgres;
create schema auth authorization l41i_postgres;
grant usage on schema auth to anon, authenticated, service_role;
create schema storage authorization l41i_postgres;
grant usage on schema storage to anon, authenticated, service_role;
`;
// politiques de session RELEVÉES (pg_policies, 27/11/2026) ; BOUCHONS : session_role() / session_livreur() lisent un paramètre
const POL_LIV = "(select public.session_role()) = 'livreur' and upper(coalesce(livreur, '')) = (select public.session_livreur())";
const DATES = (col) => ` and coalesce(${col}, '') >= to_char(current_date - 2, 'YYYY-MM-DD') and coalesce(${col}, '') <= to_char(current_date + 2, 'YYYY-MM-DD')`;
const SQL_BASE = `
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create or replace function public.session_role() returns text
language sql stable security definer set search_path = public, pg_catalog as $$ select nullif(current_setting('l41i.session_role', true), '') $$;
create or replace function public.session_livreur() returns text
language sql stable security definer set search_path = public, pg_catalog as $$
  select case when nullif(current_setting('l41i.session_role', true), '') = 'livreur' then upper(nullif(current_setting('l41i.session_livreur', true), '')) end $$;
revoke all on function public.session_role(), public.session_livreur() from public, anon, authenticated;
grant execute on function public.session_role(), public.session_livreur() to anon;
${Object.keys(RELEVE).map(ddl).join('\n')}
do $$
declare t text;
begin
  foreach t in array array['produits', 'commandes', 'tournees', 'depenses', 'caisse_remises', 'parametres', 'stock_camion', 'mouvements_stock'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy sess_admin on public.%I for all to anon using ((select public.session_role()) = ''admin'') with check ((select public.session_role()) = ''admin'')', t);
  end loop;
  foreach t in array array['produits', 'commandes', 'tournees', 'stock_camion', 'mouvements_stock'] loop
    execute format('create policy sess_collab on public.%I for all to anon using ((select public.session_role()) = ''collab'') with check ((select public.session_role()) = ''collab'')', t);
  end loop;
end $$;
create policy sess_livreur on public.commandes for all to anon using (${POL_LIV}${DATES('date_livraison')}) with check (${POL_LIV});
create policy sess_livreur on public.tournees for all to anon using (${POL_LIV}${DATES('date_tournee')}) with check (${POL_LIV});
create policy sess_livreur on public.stock_camion for all to anon using (${POL_LIV}) with check (${POL_LIV});
create policy sess_livreur on public.mouvements_stock for all to anon using (${POL_LIV}) with check (${POL_LIV});
create policy sess_livreur on public.depenses for all to anon using (${POL_LIV}) with check (${POL_LIV});   -- remplacée par la 020 (telle quelle)
create policy sess_livreur_lecture on public.produits for select to anon using ((select public.session_role()) = 'livreur');
create policy sess_livreur_stock on public.produits for update to anon using ((select public.session_role()) = 'livreur') with check ((select public.session_role()) = 'livreur');
create policy sess_parametres_lecture on public.parametres for select to anon using ((select public.session_role()) in ('collab', 'livreur')
  and (cle in ('soc_nom', 'soc_tel', 'soc_adresse', 'soc_email', 'legal_text', 'gardefou_skip_dates') or cle like 'livreur\\_%\\_domicile'));
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
    console.error('ÉCHEC DU BANC 041 INTÉGRATION : @electric-sql/pglite ' + pkg.version + ' installé, version exigée ' + VERSION_ATTENDUE + ' — rien n\'a été testé.');
    process.exit(2);
  }
  const db = new PGlite();
  console.log('Base jetable en mémoire : ' + (await db.query('select version() as v')).rows[0].v.split(' on ')[0] + ' (@electric-sql/pglite ' + pkg.version + ')');
  const SESS = { admin: ['admin', ''], collab: ['collab', ''], livreur: ['livreur', 'livreur-a'], livreurB: ['livreur', 'livreur-b'] };
  async function contexte(qui) {
    await db.exec('reset role');
    const s = SESS[qui] || ['', ''];
    await db.query("select set_config('l41i.session_role', $1, false), set_config('l41i.session_livreur', $2, false)", s);
    if (qui === 'proprio') await db.exec('set role l41i_postgres'); else await db.exec('set role anon');
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
  console.log('\n1. SCHÉMA RELEVÉ DANS LA VRAIE BASE, MIGRATIONS EN SERVICE, PUIS 038b → 039 → 040 → 041 TELLES QUELLES');
  await db.exec(SQL_ROLES);
  await db.exec('set role l41i_postgres');
  let e0 = null; try { await db.exec(SQL_BASE); } catch (e) { e0 = e.message; }
  test('tables historiques recréées aux types RELEVÉS (stock_camion.id et mouvements_stock.id en uuid, caisse_remises sans colonne id)', e0 === null, e0);
  const m019 = lireMigration('019_incident_cles_2026-09-27.sql');
  const iG = m019.indexOf('create or replace function public._garde_livreur_commandes()');
  const fG = m019.indexOf('for each row execute function public._garde_livreur_commandes();', iG);
  let eG = null; try { await db.exec(m019.slice(iG, fG) + 'for each row execute function public._garde_livreur_commandes();'); } catch (e) { eG = e.message; }
  test('garde du livreur de la 019 (en service dans la vraie base) extraite TELLE QUELLE', iG > 0 && fG > iG && eG === null, eG);
  for (const m of ['004_add_composants_to_produits.sql', '020_depenses_livreur_restreint.sql', '024_stock_correspondance.sql', '025_stock_comptage_fiabilite.sql', '031_ancienne_offre.sql']) {
    let err = null; try { await db.exec(lireMigration(m)); } catch (e) { err = e.message; }
    test('migration en service ' + m + ' appliquée telle quelle', err === null, err);
  }
  let arret = false;
  for (const m of ['038b_depenses_verrou_caisse_validee.sql', '039_arrivages_prix_revient.sql', '040_deduction_stock_serveur.sql', '041_dropshipping_provenance.sql']) {
    let err = null; try { await db.exec(lireMigration(m)); } catch (e) { err = e.message; }
    test('mise en ligne : ' + m + ' appliquée TELLE QUELLE (ses contrôles et auto-contrôles passés)', err === null, err);
    if (err) { arret = true; break; }
  }
  if (arret) { await db.exec('reset role'); console.log('\nRÉSULTAT : arrêt, la chaîne 038b → 041 ne s\'applique pas. ' + ok + ' réussis, ' + (ko) + ' échec(s)'); process.exit(1); }
  let e41b = null; try { await db.exec(lireMigration('041_dropshipping_provenance.sql')); } catch (e) { e41b = e.message; }
  test('041 rejouable une 2e fois sur cette base', e41b === null, e41b);
  await db.exec('reset role');
  // fidélité : chaque colonne relevée existe dans la base du banc, même type, même NOT NULL
  const ecarts = [];
  for (const t of Object.keys(RELEVE)) {
    const cols = await q(P, 'select column_name as c, udt_name as u, is_nullable as n from information_schema.columns where table_schema = $1 and table_name = $2', ['public', t]);
    for (const [c, u, n] of RELEVE[t]) { const x = cols.find((k) => k.c === c); if (!x || x.u !== u || x.n !== n) ecarts.push(t + '.' + c + ' ' + (x ? x.u + '/' + x.n : 'absente') + ' ≠ ' + u + '/' + n); }
  }
  test('FIDÉLITÉ : après les migrations, toutes les colonnes relevées dans la vraie base ont le même type et le même NOT NULL (' + Object.values(RELEVE).reduce((s, v) => s + v.length, 0) + ' colonnes)', ecarts.length === 0, ecarts);
  test('types ajoutés par la 041 cohérents avec la vraie base : commande_pieces.stock_camion_id = uuid comme stock_camion.id',
    (await un(P, "select udt_name from information_schema.columns where table_name = 'commande_pieces' and column_name = 'stock_camion_id'")).udt_name === 'uuid');

  // Données fictives
  await q(P, `insert into public.produits (id, nom, cat, dim, prix, stock, composants) values
    ('pm180', 'Matelas fictif 180', 'Matelas', '180×190', 400, 0, null),
    ('ps90', 'Sommier fictif 90', 'Sommier', '90×190', 120, 4, null),
    ('pe180', 'Ensemble fictif 180', 'Ensemble', '180×190', 600, 0, '[{"id":"pm180","qte":1},{"id":"ps90","qte":2}]')`);
  await q(P, "insert into public.produits_revient (produit_id, prix_revient_ht, methode) values ('pm180', 150, 'CUMP'), ('ps90', 40, 'CUMP')")   // methode NOT NULL sans défaut dans la VRAIE 039 (le banc détaillé recopiait un défaut);
  const cmd = (id, lignes, prix, champs) => q(P, 'insert into public.commandes (id, client, lignes, prix, livreur, transporteur, statut, date_livraison) values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)',
    [id, 'Client fictif', JSON.stringify(lignes), prix, (champs && champs.livreur !== undefined) ? champs.livreur : 'Livreur-A', (champs && champs.transporteur) || 'RANOU', 'en-route', AUJ]);
  await q(P, "insert into public.tournees (id, livreur, date_tournee, statut, stops) values ('T-I1', 'Livreur-A', $1, 'en cours', $2::jsonb)",
    [AUJ, JSON.stringify([{ cmdId: '#I1', client: 'Client fictif' }, { cmdId: '#I2', client: 'Client fictif' }])]);
  await q('admin', "insert into public.fournisseurs (nom, adresse) values ('Fournisseur fictif 1', '1 rue Fictive 75000 Paris')");
  const F1 = (await un(P, 'select id from public.fournisseurs')).id;
  await q('admin', 'insert into public.fournisseur_prix (produit_id, fournisseur_id, prix_achat_ht) values ($1, $2, 160)', ['pm180', F1]);
  await q('admin', "insert into public.drop_produits (produit_id, actif, motif) values ('pm180', true, 'rupture')");

  // =========================================================================================================================
  console.log('\n2. STOCK TAMPON (entrée par la base : mouvement_stock_produit de la 040)');
  let r = await rpc('admin', 'public.drop_tampon_entree($1, $2, $3::date, $4, $5, $6::jsonb)', ['cle-integ-1', F1, AUJ, 'especes', null, JSON.stringify([{ produit_id: 'ps90', qte: 2, prix_ttc: 36 }])]);
  test('entrée de 2 sommiers en stock tampon (coût HT 30) : stock du dépôt 4 → 6 par la 040', r.ok && (await stock('ps90')) === 6 && (await nb("public.stock_operations where nature = 'mouvement'")) === 1, r);

  // =========================================================================================================================
  console.log('\n3. LIVRÉ AVEC PIÈCES (Dépôt + fournisseur payé en espèces + stock tampon), garde du livreur ACTIVE');
  await cmd('#I1', [{ produitId: 'pe180', nom: 'Ensemble fictif 180', qte: 1 }], 720);
  const [pM, pS1, pS2] = (await rpc('livreur', 'public.drop_pieces($1)', ['#I1'])).pieces;
  test('ensemble découpé en 3 pièces', pM && pS2 && pM.produit_id === 'pm180' && pS1.produit_id === 'ps90');
  await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [pM.id, 'fournisseur', F1]);
  await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [pS1.id, 'depot']);
  r = await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [pS2.id, 'tampon', F1]);
  test('3 provenances déclarées (fournisseur, Dépôt — stock BMS, Dépôt — stock tampon)', r.ok, r);
  r = await rpc('livreur', 'public.drop_enlever_payer($1, $2, $3, $4)', [pM.id, 192, 'especes', 'livreur-a/I1/ticket-1.jpg']);
  test('« Enlevé et payé » 192 € TTC en espèces : dépense de la tournée (table depenses aux types réels, 038b en place)', r.ok
    && (await nb("public.depenses where id like 'drop-%' and tournee_id = 'T-I1' and mode_paie = 'Espèces' and montant = 192")) === 1, r);
  test('caisse (038b) : ces espèces comptent dans les dépenses de la tournée', Number((await un(P, "select interne.l038b_depenses_especes('T-I1') as d")).d) >= 192);
  test('« livré » refusé tant que les pièces ne sont pas confirmées', /PIECES_NON_CONFIRMEES/.test(await echec('livreur', "update public.commandes set statut = 'livré' where id = '#I1'") || ''));
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#I1', JSON.stringify([pM, pS1, pS2].map((p) => ({ id: p.id, livree: true })))]);
  test('confirmation des 3 pièces', r.ok, r);
  test('« livré » accepté (garde du livreur de la 019 active)', (await echec('livreur', "update public.commandes set statut = 'livré' where id = '#I1'")) === null);
  r = await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#I1']);
  test('déduction PAR LA BASE : 2 sommiers retirés (1 Dépôt + 1 tampon), matelas fournisseur non retiré, lot 2 → 1', r.ok && r.mode === 'pieces' && (await stock('ps90')) === 4
    && (await un(P, 'select quantite_restante from public.stock_tampon_lots')).quantite_restante === 1, r);
  r = await rpc('admin', 'public.drop_marge_commande($1)', ['#I1']);
  test('marge : vente 600 HT − (160 + 40 + 30) = 370', r.ok && r.cout_ht === 230 && r.marge_ht === 370 && r.cout_estime === false, r);

  // =========================================================================================================================
  console.log('\n4. LIVRAISON PARTIELLE → STOCK DU CAMION (uuid), ANNULATION / RECRÉDIT, RELIVRAISON « DÉJÀ DANS LE CAMION »');
  await cmd('#I2', [{ produitId: 'pm180', qte: 1 }, { produitId: 'ps90', qte: 1 }], 624);
  const [pA, pB] = (await rpc('livreur', 'public.drop_pieces($1)', ['#I2'])).pieces;
  await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [pA.id, 'fournisseur', F1]);
  await rpc('livreur', 'public.drop_enlever_payer($1, $2, $3, $4)', [pA.id, 192, 'cb', null]);
  await rpc('livreur', 'public.drop_declarer($1, $2, null, null)', [pB.id, 'depot']);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#I2', JSON.stringify([{ id: pA.id, livree: false }, { id: pB.id, livree: true }])]);
  const scA = await un(P, "select * from public.stock_camion where source_cmd_id = '#I2'");
  test('matelas acheté non livré → stock du camion : ligne avec un VRAI uuid (table aux types réels), livreur renseigné (NOT NULL)', r.ok && scA && /^[0-9a-f-]{36}$/.test(scA.id) && scA.livreur === 'Livreur-A' && scA.status === 'en_camion', { r, scA });
  await q('livreur', "update public.commandes set statut = 'livré' where id = '#I2'");
  r = await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#I2']);
  test('déduction : 1 sommier (Dépôt) retiré', r.ok && (await stock('ps90')) === 3, r);
  await q('admin', "update public.commandes set statut = 'annulé' where id = '#I2'");
  r = await rpc('admin', 'public.recrediter_stock_livraison($1, false)', ['#I2']);
  test('annulation : recrédit de la 040 (sommier rendu : 3 → 4) ; la jointure stock_camion (uuid) ↔ pièces (uuid) passe ; pièce non livrée remise à zéro',
    r.ok && (await stock('ps90')) === 4 && (await un(P, 'select provenance from public.commande_pieces where id = $1', [pA.id])).provenance === null, r);
  await q('admin', "update public.commandes set statut = 'en-route' where id = '#I2'");
  r = await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [pA.id, 'camion', scA.id]);
  test('relivraison : « Déjà dans le camion » avec l\'uuid de la ligne', r.ok && r.piece.stock_camion_id === scA.id, r);
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#I2', JSON.stringify([{ id: pA.id, livree: true }, { id: pB.id, livree: true }])]);
  await q('livreur', "update public.commandes set statut = 'livré' where id = '#I2'");
  const r2 = await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#I2']);
  test('relivraison : article du camion sorti (livre), coût = achat d\'origine, sommier retiré de nouveau (4 → 3)', r.ok && r2.ok
    && (await un(P, 'select status from public.stock_camion where id = $1', [scA.id])).status === 'livre'
    && (await un(P, 'select source from public.pieces_couts where piece_id = $1 and cycle = 2', [pA.id])).source === 'achat_camion' && (await stock('ps90')) === 3, { r, r2 });

  console.log('\n5. ANNULATION D\'UNE COMMANDE AVEC STOCK TAMPON : la pièce revient dans SON lot');
  await q('admin', "update public.commandes set statut = 'annulé' where id = '#I1'");
  r = await rpc('admin', 'public.recrediter_stock_livraison($1, false)', ['#I1']);
  test('recrédit : 2 sommiers rendus au dépôt (3 → 5), lot tampon 1 → 2', r.ok && (await stock('ps90')) === 5 && (await un(P, 'select quantite_restante from public.stock_tampon_lots')).quantite_restante === 2
    && r.lots_tampon_restaures.length === 1, r);

  console.log('\n6. STOCK DU CAMION : ligne de l\'appli de plusieurs unités, identifiant uuid');
  const mTexte = await echec(P, "insert into public.stock_camion (id, livreur, produit_libelle, quantite, status) values ('sc_1700000000_abcdef', 'Livreur-A', 'Sommier fictif 90', 1, 'en_camion')");
  test('CONSTAT : un identifiant texte « sc_… » (comme l\'envoie ajouterStockCamion de l\'appli) est REFUSÉ par la table réelle (uuid)', !!mTexte && /uuid/i.test(mTexte), mTexte);
  const scW = (await un(P, "insert into public.stock_camion (livreur, produit_libelle, quantite, source_cmd_id, charge_at, status) values ('Livreur-A', 'Sommier fictif 90', 2, '#AVANT', now() - interval '1 day', 'en_camion') returning id")).id;
  await cmd('#I3', [{ produitId: 'ps90', qte: 2 }], 288);
  const [pW1, pW2] = (await rpc('livreur', 'public.drop_pieces($1)', ['#I3'])).pieces;
  const rW1 = await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [pW1.id, 'camion', scW]);
  const rW2 = await rpc('livreur', 'public.drop_declarer($1, $2, null, $3)', [pW2.id, 'camion', scW]);
  test('ligne de 2 unités : une unité par pièce (découpage), les deux pièces servies', rW1.ok && rW2.ok && rW1.piece.stock_camion_id !== rW2.piece.stock_camion_id, { rW1, rW2 });
  r = await rpc('livreur', 'public.drop_confirmer_livraison($1, $2::jsonb)', ['#I3', JSON.stringify([{ id: pW1.id, livree: true }, { id: pW2.id, livree: true }])]);
  test('confirmation : les 2 unités sortent du camion', r.ok && (await nb("public.stock_camion where (id = $1 or scinde_de = $1) and status = 'livre'", [scW])) === 2, r);

  console.log('\n7. CAISSE (038b) : point de caisse validé → enlèvement refusé, rien enregistré');
  await cmd('#I4', [{ produitId: 'pm180', qte: 1 }], 480);
  await q(P, "update public.tournees set stops = stops || $1::jsonb where id = 'T-I1'", [JSON.stringify([{ cmdId: '#I4', client: 'Client fictif' }])]);
  const pI4 = (await rpc('livreur', 'public.drop_pieces($1)', ['#I4'])).pieces[0];
  await rpc('livreur', 'public.drop_declarer($1, $2, $3, null)', [pI4.id, 'fournisseur', F1]);
  const c38 = await un(P, "select interne.l038b_depenses_especes('T-I1') as d, interne.l038b_arrets_caisse((select t.stops::jsonb from public.tournees t where t.id = 'T-I1')) as a");
  test('validation du point de caisse dans caisse_remises (clé key_remise, aux colonnes réelles + contrôles de la 038b)', (await echec('admin',
    "insert into public.caisse_remises (key_remise, livreur, periode, validee, par, controle_depenses, controle_arrets) values ('t_T-I1', 'Livreur-A', $1, true, 'admin', $2, $3)", [AUJ, c38.d, JSON.stringify(c38.a)])) === null);
  r = await rpc('livreur', 'public.drop_enlever_payer($1, $2, $3, $4)', [pI4.id, 192, 'especes', null]);
  test('enlèvement refusé (point_caisse_valide) : ni achat payé ni dépense', r.ok === false && r.erreur === 'point_caisse_valide'
    && (await nb("public.depenses where comment like 'Dropshipping #I4%'")) === 0, r);

  console.log('\n8. COMMANDE CONCERNÉE JAMAIS DÉCOUPÉE (avis n° 1) avec la garde du livreur de la 019');
  await cmd('#I5', [{ produitId: 'ps90', qte: 1 }], 144);
  test('« livré » refusé (DECOUPAGE_REQUIS), y compris en vidant le livreur dans la même écriture', /DECOUPAGE_REQUIS/.test(await echec('livreur', "update public.commandes set statut = 'livré' where id = '#I5'") || '')
    && /DECOUPAGE_REQUIS/.test(await echec('livreur', "update public.commandes set statut = 'livré', livreur = '' where id = '#I5'") || ''));
  await cmd('#I6', [{ produitId: 'ps90', qte: 1 }], 144, { transporteur: 'GLS' });
  test('commande GLS jamais découpée : « livré » accepté, déduction de la 040', (await echec('livreur', "update public.commandes set statut = 'livré' where id = '#I6'")) === null
    && (await rpc('livreur', 'public.deduire_stock_livraison($1)', ['#I6'])).ok === true);

  console.log('\nRÉSULTAT : ' + ok + ' tests réussis, ' + ko + ' échec(s)');
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERREUR DU BANC :', e); process.exit(1); });
