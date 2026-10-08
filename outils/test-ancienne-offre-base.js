// Test RÉEL de « ANCIENNE OFFRE — NE PLUS UTILISER » côté base (migration 031, 09/10/2026).
// Usage : node outils/test-ancienne-offre-base.js
// Il lit le fichier .env local (jeton d'administration, jamais affiché). Il ne LIT que les vraies fiches produit et les vraies
// commandes ; il n'ÉCRIT que dans une fiche produit fictive « prTEST-ANCIENNE-OFFRE », créée puis supprimée pendant le test.
// Aucune commande n'est créée ni modifiée.
const fs = require('fs'), path = require('path');
const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8'); const val = k => (env.match(new RegExp(k + '\\s*=\\s*"?([^\\s"]+)')) || [])[1];
const PAT = val('SUPABASE_ACCESS_TOKEN');
const sql = async q => { const r = await fetch('https://api.supabase.com/v1/projects/jmvfjtnmebstkzcfnlgp/database/query', { method: 'POST', headers: { Authorization: 'Bearer ' + PAT, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {} return { ok: r.ok, lignes: Array.isArray(j) ? j : [], texte: t }; };
let ok = 0, ko = 0; const test = (nom, cond, det) => { if (cond) { ok++; console.log('  OK    ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (det ? ' — ' + (typeof det === 'string' ? det : JSON.stringify(det)).slice(0, 300) : '')); } };
// Écriture faite avec une SESSION simulée de l'application (créée, utilisée et supprimée dans la même opération ; le jeton n'en sort jamais).
const session = (ecriture, roleS) => sql(`do $$ declare tk text := encode(extensions.gen_random_bytes(32), 'hex'); begin
    insert into public.sessions_app (jeton_hash, role, livreur, expire_at, appareil) values (encode(extensions.digest(tk, 'sha256'), 'hex'), '${roleS}', null, now() + interval '2 minutes', 'test-automatique');
    perform set_config('request.headers', json_build_object('x-app-secret', (select valeur from public.secrets_serveur where cle = 'app_secret_courant'), 'x-session-token', tk)::text, true);
    if (select public.session_role()) is distinct from '${roleS}' then raise exception 'session de test non reconnue'; end if;
    ${ecriture};
    perform set_config('request.headers', '', true);
    delete from public.sessions_app where appareil = 'test-automatique';
  end $$`);
const T = 'prTEST-ANCIENNE-OFFRE', ANCIENS = ['pr1779111250992', 'pr1779111182143'], PACK15 = ['pr1789810598512', 'pr1789810425754'], liste = l => l.map(x => "'" + x + "'").join(', ');
const fiche = async () => (await sql(`select id, nom, prix, actif, ancienne_offre from public.produits where id = '${T}'`)).lignes[0];
// ce qu'envoie un appareil quand il enregistre une fiche produit : toute la fiche SAUF le marqueur, avec « actif » à vrai
const ENVOI_APPAREIL = `insert into public.produits (id, nom, cat, dim, prix, poids, stock, seuil, empl, remarque, composants, actif, updated_at) values ('${T}', 'TEST ANCIENNE OFFRE (ne pas vendre)', 'Service', '', 1, 0, 0, 2, '', '', null, true, now())
      on conflict (id) do update set nom = excluded.nom, cat = excluded.cat, dim = excluded.dim, prix = excluded.prix, poids = excluded.poids, stock = excluded.stock, seuil = excluded.seuil, empl = excluded.empl, remarque = excluded.remarque, composants = excluded.composants, actif = excluded.actif, updated_at = excluded.updated_at`;

(async () => {
  let r;
  console.log('\n1. LA BASE CONNAÎT LE MARQUEUR');
  r = await sql("select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'produits' and column_name = 'ancienne_offre'");
  test('colonne produits.ancienne_offre présente (vrai / faux, faux par défaut)', r.lignes.length === 1 && r.lignes[0].data_type === 'boolean' && r.lignes[0].is_nullable === 'NO' && /false/.test(r.lignes[0].column_default || ''), r.lignes);
  r = await sql("select tgname from pg_trigger where not tgisinternal and tgrelid = 'public.produits'::regclass");
  test('déclencheur de garde présent sur les produits', r.lignes.some(x => x.tgname === 'produits_ancienne_offre_garde'), r.lignes);
  r = await sql("select string_agg(tgname, ', ' order by tgname) t from pg_trigger where not tgisinternal and tgrelid = 'public.commandes'::regclass");
  test('aucun déclencheur ajouté ni retiré sur les commandes (paiement et annulation intacts)', (r.lignes[0] || {}).t === 'annulation_journal, annulation_trace, garde_livreur_commandes, klaviyo_exclusion, litige_clos_at, paiement_journal, paiement_verrou', r.lignes);

  console.log('\n2. ANCIEN PACK 20 CM : MARQUÉ, TOUJOURS AU CATALOGUE');
  r = await sql(`select id, nom, prix, actif, ancienne_offre, jsonb_array_length(coalesce(composants, '[]'::jsonb)) nc from public.produits where id in (${liste(ANCIENS)}) order by nom`);
  test('les deux fiches (blanc et noir) existent toujours', r.lignes.length === 2, r.lignes);
  test('elles sont marquées « ancienne offre »', r.lignes.every(x => x.ancienne_offre === true), r.lignes);
  test('elles restent actives (historique lisible, stock déduit)', r.lignes.every(x => x.actif === true), r.lignes);
  test('leur prix catalogue (379 €) et leurs composants (lit + matelas) n\'ont pas bougé', r.lignes.every(x => Number(x.prix) === 379 && x.nc === 2), r.lignes);
  r = await sql(`select count(*)::int n from public.produits where ancienne_offre and id not in (${liste(ANCIENS)}) and id <> '${T}'`);
  test('aucun autre produit n\'est marqué', (r.lignes[0] || {}).n === 0, r.lignes);

  console.log('\n3. PACK ACTUEL 15 CM : 349 € POUR LES NOUVELLES COMMANDES');
  r = await sql(`select id, nom, prix, actif, ancienne_offre from public.produits where id in (${liste(PACK15)}) order by nom`);
  test('pack blanc et pack noir à 349 €', r.lignes.length === 2 && r.lignes.every(x => Number(x.prix) === 349), r.lignes);
  test('ils restent actifs et sélectionnables (non marqués)', r.lignes.every(x => x.actif === true && x.ancienne_offre === false), r.lignes);

  console.log('\n4. COMMANDES DÉJÀ PRISES : RIEN N\'A BOUGÉ');
  r = await sql(`select c.id, c.statut, c.prix, (l->>'prixUnit')::numeric pu, l->>'produitId' pid, l->>'produit' nom from public.commandes c, jsonb_array_elements(coalesce(c.lignes, '[]'::jsonb)) l where l->>'produitId' in (${liste(ANCIENS)})`);
  test('les lignes de commande de l\'ancien pack sont toujours là (34 au 09/10/2026, jamais moins)', r.lignes.length >= 34, r.lignes.length);
  test('chaque ligne garde le nom d\'origine du produit', r.lignes.every(x => /^Lit Coffre (Blanc|Noir) 140×190 \+ Matelas/.test(x.nom)), r.lignes.find(x => !/^Lit Coffre/.test(x.nom)));
  const attente = r.lignes.filter(x => x.statut === 'en-attente');
  test('les commandes en attente gardent leur prix d\'origine (299 € la ligne, 299 € la commande)', attente.every(x => Number(x.pu) === 299 && Number(x.prix) === 299), attente.map(x => [x.statut, x.pu, x.prix]));
  r = await sql(`select count(*)::int n from public.commandes c, jsonb_array_elements(coalesce(c.lignes, '[]'::jsonb)) l where l->>'produitId' in (${liste(PACK15)}) and (l->>'prixUnit')::numeric = 299`);
  test('la commande déjà prise du pack 15 cm à 299 € garde son prix (le nouveau prix ne vaut que pour les nouvelles)', (r.lignes[0] || {}).n >= 1, r.lignes);

  console.log('\n5. UN APPAREIL NE PEUT NI LEVER LE MARQUEUR NI SUPPRIMER LA FICHE (fiche fictive)');
  await sql(`delete from public.produits where id = '${T}' and not ancienne_offre`); await sql(`update public.produits set ancienne_offre = false where id = '${T}'`); await sql(`delete from public.produits where id = '${T}'`);
  r = await sql(`insert into public.produits (id, nom, cat, prix, stock, actif, ancienne_offre) values ('${T}', 'TEST ANCIENNE OFFRE (ne pas vendre)', 'Service', 1, 0, true, true)`); let f = await fiche();
  test('fiche fictive créée et marquée côté serveur', r.ok && !!f && f.ancienne_offre === true, r.texte);
  for (const roleS of ['collab', 'admin']) {
    r = await session(ENVOI_APPAREIL, roleS); f = await fiche();
    test(`session « ${roleS} », enregistrement d'une fiche comme le fait un appareil (sans le marqueur, actif = vrai) : accepté, marqueur conservé`, r.ok && f.ancienne_offre === true && f.actif === true, r.texte);
    r = await session(`update public.produits set ancienne_offre = false where id = '${T}'`, roleS); f = await fiche();
    test(`session « ${roleS} », tentative directe de lever le marqueur : sans effet`, f.ancienne_offre === true, r.texte);
    r = await session(`delete from public.produits where id = '${T}'`, roleS); f = await fiche();
    test(`session « ${roleS} », suppression de la fiche : refusée, la fiche est toujours là`, !!f && /ANCIENNE OFFRE/.test(r.texte), r.texte);
  }
  r = await session(`update public.produits set stock = 3, prix = 2 where id = '${T}'`, 'collab'); f = await fiche();
  test('les autres modifications d\'une fiche marquée restent possibles (stock, prix)', r.ok && Number(f.prix) === 2 && f.ancienne_offre === true, r.texte);
  r = await sql(`delete from public.produits where id = '${T}'`); f = await fiche();
  test('même côté serveur, une fiche marquée ne se supprime pas tant que le marqueur est posé', !!f, r.texte);

  console.log('\n6. RETOUR ARRIÈRE (côté serveur, par un administrateur)');
  r = await sql(`update public.produits set ancienne_offre = false where id = '${T}'`); f = await fiche();
  test('côté serveur, le marqueur se lève : l\'offre redeviendrait sélectionnable', r.ok && f.ancienne_offre === false, r.texte);
  r = await sql(`delete from public.produits where id = '${T}'`); f = await fiche();
  test('la fiche fictive est supprimée : il ne reste rien du test', r.ok && !f, r.texte);
  r = await sql("select count(*)::int n from public.sessions_app where appareil = 'test-automatique'");
  test('aucune session de test ne reste dans la base', (r.lignes[0] || {}).n === 0, r.lignes);

  console.log(`\nRÉSULTAT : ${ok} tests réussis, ${ko} échec(s)`); process.exitCode = ko ? 1 : 0;
})().catch(e => { console.error('ERREUR :', e.stack || e.message); process.exit(1); });
