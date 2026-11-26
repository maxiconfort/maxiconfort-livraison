// Banc de test « ARRIVAGES, PRIX DE REVIENT, PRODUITS NON VENDABLES » (v7.5.136 + migration 039, 25/11/2026).
// Usage : node outils/test-arrivage.js
// Il EXTRAIT le vrai code de maxiconfort-v7.html (bloc ARR-DEBUT … ARR-FIN, bloc AO, buildProduitOptions, sbLoadProduits) et
// l'exécute dans un bac à sable : aucune connexion à la base, VALEURS FICTIVES uniquement (aucun prix réel dans ce dépôt public).
// La migration SQL n'est pas exécutée ici (pas de base de test locale) : ses règles sont vérifiées sur le texte du fichier, et
// le calcul du revient est le même des deux côtés (constante et formule comparées).
const fs = require('fs'), path = require('path'), vm = require('vm');
const racine = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(racine, 'maxiconfort-v7.html'), 'utf8');
const sql = fs.readFileSync(path.join(racine, 'supabase', 'migrations', '039_arrivages_prix_revient.sql'), 'utf8').replace(/\r\n/g, '\n'); // fins de ligne CRLF (copie Windows) ramenées à LF
const sw = fs.readFileSync(path.join(racine, 'service-worker.js'), 'utf8');
function extraireBloc(debut, fin) { const i = html.indexOf(debut), j = html.indexOf(fin, i); if (i < 0 || j < 0) throw new Error('bloc introuvable : ' + debut); return html.slice(i, j); }
function extraireFonction(signature) { const i = html.indexOf(signature); if (i < 0) throw new Error('fonction introuvable : ' + signature);
  let k = html.indexOf('{', i), n = 0, dansChaine = null, ech = false;
  for (let p = k; p < html.length; p++) { const ch = html[p];
    if (dansChaine) { if (ech) ech = false; else if (ch === '\\') ech = true; else if (ch === dansChaine) dansChaine = null; continue; }
    if (ch === '/' && html[p + 1] === '/') { p = html.indexOf('\n', p); continue; }
    if (ch === "'" || ch === '"' || ch === '`') { dansChaine = ch; continue; }
    if (ch === '{') n++; else if (ch === '}') { n--; if (n === 0) return html.slice(i, p + 1); } }
  throw new Error('accolade non refermée : ' + signature); }
let ok = 0, ko = 0; const test = (nom, cond, det) => { if (cond) { ok++; console.log('  OK   ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (det !== undefined ? ' — ' + JSON.stringify(det) : '')); } };

// ---------- catalogue FICTIF ----------
const catalogue = () => [
  { id: 'pr-a', nom: 'Matelas Fictif A 140×190', cat: 'Matelas', prix: 100, stock: 10, seuil: 2 },
  { id: 'pr-b', nom: 'Matelas Fictif B 160×200', cat: 'Matelas', prix: 120, stock: 0, seuil: 2 },
  { id: 'pr-n', nom: 'Matelas Nouveau N (fictif)', cat: 'Matelas', prix: 0, prixDefini: false, vendable: false, stock: 0, seuil: 2, refInterne: 'MC-TEST-1' },
  { id: 'pr-s', nom: 'Sommier Fictif 140×190', cat: 'Sommier', prix: 80, stock: 5, seuil: 2 },
  { id: 'pr-e1', nom: 'Ensemble Fictif A + Sommier', cat: 'Ensemble', prix: 200, stock: 0, seuil: 2, composants: [{ id: 'pr-a', qte: 1 }, { id: 'pr-s', qte: 1 }] },
  { id: 'pr-e2', nom: 'Ensemble Nouveau N + Sommier', cat: 'Ensemble', prix: 260, stock: 0, seuil: 2, composants: [{ id: 'pr-n', qte: 1 }, { id: 'pr-s', qte: 1 }] },
  { id: 'pr-retire', nom: 'Matelas Retiré R', cat: 'Matelas', prix: 90, vendable: false, stock: 3, seuil: 2 },
];
const arrivage = (st) => ({ id: 7, reference_interne: 'ARR-TEST-1', navire: 'Navire fictif', statut: st || 'en_attente', taux_provisoire: true });
const lignesArr = () => [
  { id: 71, arrivage_id: 7, produit_id: 'pr-a', quantite_attendue: 30, revient_unitaire_ht: 50 },
  { id: 72, arrivage_id: 7, produit_id: 'pr-n', quantite_attendue: 40, revient_unitaire_ht: 70 },
];
// Réponse paginée comme la base (PostgREST) : filtre arrivage_id=eq.N, puis offset / limit, plafond par réponse (1 000 par défaut).
function paginer(url, rows, plafond) {
  const u = new URL(url); let r = rows.slice();
  const fa = u.searchParams.get('arrivage_id'); if (fa) r = r.filter(x => 'eq.' + x.arrivage_id === fa);
  const off = Number(u.searchParams.get('offset') || 0), lim = Math.min(Number(u.searchParams.get('limit') || 1e9), plafond || 1000);
  return r.slice(off, off + lim);
}
// v7.5.150 : stock des produits lus par identifiants (produits?select=id,stock&id=in.(…)) — réponse de la base FICTIVE = stock des
// produits du bac (produits inactifs ou modifiés : option stocksBase), par pages. Revients et stock entrant des réponses de test
// tiennent sur une page : la page suivante (offset > 0) est vide, comme la base.
function idsDuFiltre(url, champ) {
  const v = new URL(url).searchParams.get(champ); if (!v) return null;
  return v.slice(v.indexOf('(') + 1, v.lastIndexOf(')')).split(',').map(x => JSON.parse(x));
}
function stocksParDefaut(url, bac, o) {
  if (!url.includes('/rest/v1/produits?select=id,stock')) return null;
  if (o.lectureStocks) return o.lectureStocks(url);
  const ids = idsDuFiltre(url, 'id') || [];
  const base = o.stocksBase ? o.stocksBase() : bac.produits.map(p => ({ id: p.id, stock: p.stock }));
  return { ok: true, status: 200, corps: paginer(url, base.filter(p => ids.includes(p.id)).sort((x, y) => (x.id < y.id ? -1 : 1))) };
}
function pagesSuivantes(url) {
  const u = new URL(url);
  if ((url.includes('/produits_revient?') || url.includes('/rpc/stock_entrant?')) && Number(u.searchParams.get('offset') || 0) > 0) return { ok: true, status: 200, corps: [] };
  return null;
}
function nouveauBac(opts) {
  const o = opts || {}, appels = [], toasts = [], elts = {};
  const el = (id) => elts[id] || (elts[id] = { id, innerHTML: '', textContent: '', disabled: false, style: {}, value: '' });
  const bac = { console: { log() {}, warn() {} }, Math, Date, JSON, parseFloat, parseInt, String, Array, Object, Number, isNaN, encodeURIComponent, Promise, Set,
    SUPABASE_URL: 'https://exemple.invalid', SUPABASE_KEY: 'cle-de-test', role: o.role || 'admin', produits: catalogue(), window: {},
    document: { getElementById: el, querySelectorAll: () => [], querySelector: () => null },
    localStorage: { setItem() {}, getItem() { return null; } },
    confirm: () => o.confirmer !== false, toast: (m, t) => toasts.push({ m, t }), paiEur: (n) => (Math.round(n * 100) / 100) + ' €',
    stkRender() {}, stkApplyRoleVisibility() {}, sbLoadProduits: async () => {}, sbSaveEchec() {},
    fetch: async (url, init) => { appels.push({ url, methode: (init && init.method) || 'GET', body: init && init.body ? JSON.parse(init.body) : null });
      const rep = stocksParDefaut(url, bac, o) || (o.pagination ? null : pagesSuivantes(url)) || (o.repondre ? o.repondre(url, init) : { ok: true, status: 200, corps: [] });
      return { ok: rep.ok, status: rep.status, json: async () => rep.corps, text: async () => JSON.stringify(rep.corps) }; } };
  vm.createContext(bac);
  vm.runInContext(extraireBloc('// AO-DEBUT', '// AO-FIN'), bac);
  vm.runInContext(extraireBloc('// ARR-DEBUT', '// ARR-FIN'), bac);
  for (const f of ['function buildProduitOptions()', 'async function sbLoadProduits()']) vm.runInContext(extraireFonction(f), bac);
  return { bac, appels, toasts, elts };
}

(async () => {
  console.log('\n1. VALORISATION : COÛT MOYEN PONDÉRÉ (CUMP) — CHOIX À VALIDER PAR BORHEN');
  let { bac } = nouveauBac();
  test('méthode retenue dans l\'appli = CUMP', bac.ARR_METHODE_VALORISATION === 'CUMP');
  test('même méthode dans la base (interne.arrivage_methode_valorisation)', /arrivage_methode_valorisation\(\) returns text\s+language sql immutable as \$\$ select 'CUMP'::text \$\$/.test(sql));
  test('revient inconnu avant → revient du lot', bac.arrNouveauRevient('CUMP', 10, null, 30, 50) === 50);
  test('stock nul avant → revient du lot', bac.arrNouveauRevient('CUMP', 0, 40, 30, 50) === 50);
  test('stock négatif avant (écart d\'inventaire) → revient du lot', bac.arrNouveauRevient('CUMP', -3, 40, 30, 50) === 50);
  test('10 en stock à 40 + 30 reçus à 50 → (10×40 + 30×50) / 40 = 47,5', bac.arrNouveauRevient('CUMP', 10, 40, 30, 50) === 47.5, bac.arrNouveauRevient('CUMP', 10, 40, 30, 50));
  test('arrondi à 4 décimales (1 à 10 + 2 à 11 → 10,6667)', bac.arrNouveauRevient('CUMP', 1, 10, 2, 11) === 10.6667, bac.arrNouveauRevient('CUMP', 1, 10, 2, 11));
  test('rien reçu → revient inchangé', bac.arrNouveauRevient('CUMP', 10, 40, 0, 50) === 40);
  test('méthode « dernier prix » (paramétrable) → revient du lot', bac.arrNouveauRevient('DERNIER_PRIX', 10, 40, 30, 50) === 50);
  test('même formule dans la base (interne.revient_apres)', sql.includes('round((p_stock_avant * p_revient_avant + p_qte * p_revient_lot) / (p_stock_avant + p_qte), 4)')
    && sql.includes("when p_methode = 'DERNIER_PRIX' or p_revient_avant is null or coalesce(p_stock_avant, 0) <= 0 then round(p_revient_lot, 4)"));

  console.log('\n2. SAISIE DE LA RÉCEPTION : CONTRÔLE DU TOTAL, QUANTITÉS PARTIELLES');
  const L = lignesArr();
  let c = bac.arrControleSaisies(L, bac.arrSaisiesInitiales(L));
  test('saisie de départ = tout reçu en bon état, contrôle OK', c.ok && c.total.recue === 70 && c.total.attendu === 70, c);
  c = bac.arrControleSaisies(L, { 71: { recue: 27, endommagee: 2, manquante: 1 }, 72: { recue: 40, endommagee: 0, manquante: 0 } });
  test('reçu partiel 27 + 2 endommagés + 1 manquant = 30 : accepté', c.ok && c.total.recue === 67 && c.total.endommagee === 2 && c.total.manquante === 1, c);
  c = bac.arrControleSaisies(L, { 71: { recue: 28, endommagee: 0, manquante: 0 }, 72: { recue: 40, endommagee: 0, manquante: 0 } });
  test('total faux (28 au lieu de 30) : refusé, ligne désignée', !c.ok && c.erreurs.length === 1 && c.erreurs[0].ligne === 71, c.erreurs);
  for (const v of ['', 'abc', '-1', '2.5']) {
    c = bac.arrControleSaisies(L, { 71: { recue: v, endommagee: 0, manquante: 0 }, 72: { recue: 40, endommagee: 0, manquante: 0 } });
    test('quantité « ' + v + ' » refusée', !c.ok && c.erreurs[0].ligne === 71);
  }
  test('arrivage sans ligne : refusé', !bac.arrControleSaisies([], {}).ok);
  const corps = bac.arrCorpsValidation(7, L, { 71: { recue: '27', endommagee: '2', manquante: '1' }, 72: { recue: 40, endommagee: 0, manquante: 0 } });
  test('envoi à la base : une saisie par ligne, en nombres entiers', corps.p_arrivage_id === 7 && corps.p_lignes.length === 2 && corps.p_lignes[0].ligne_id === 71 && corps.p_lignes[0].recue === 27 && corps.p_lignes[0].endommagee === 2, corps);
  test('base : une saisie exigée par ligne et total reçu + endommagé + manquant = attendu', sql.includes("'une_saisie_par_ligne_requise'") && sql.includes('if v_rec + v_end + v_man <> l.quantite_attendue then'));
  test('base : contrainte de table sur le même total', sql.includes('quantite_recue + coalesce(quantite_endommagee, 0) + coalesce(quantite_manquante, 0) = quantite_attendue'));

  console.log('\n3. STOCK : SEULS LES REÇUS EN BON ÉTAT ENTRENT, LES ENDOMMAGÉS NON');
  let ap = bac.arrApercu(L, { 71: { recue: 27, endommagee: 2, manquante: 1 }, 72: { recue: 38, endommagee: 2, manquante: 0 } }, bac.produits, { 'pr-a': { prix_revient_ht: 40 } }, 'CUMP');
  test('produit A : 10 en stock + 27 reçus bons = 37 (2 endommagés et 1 manquant non ajoutés)', ap[0].stockAvant === 10 && ap[0].stockApres === 37, ap[0]);
  test('produit A : revient 40 → CUMP (10×40 + 27×50) / 37', ap[0].revientAvant === 40 && ap[0].revientApres === Math.round((400 + 1350) / 37 * 10000) / 10000, ap[0]);
  test('nouveau produit N : 0 + 38 = 38, revient = celui du lot', ap[1].stockApres === 38 && ap[1].revientAvant === null && ap[1].revientApres === 70, ap[1]);
  test('l\'aperçu ne modifie pas le stock en mémoire', bac.produits.find(p => p.id === 'pr-a').stock === 10);
  // DÉCISION DE BORHEN du 26/11 (« B ») : stock existant SANS revient — coût du lot appliqué, EXPLICITE et TRACÉ
  test('aperçu : produit A (revient connu) ⇒ pas d\'avertissement ; nouveau produit N (stock vide) ⇒ pas d\'avertissement', ap[0].approxime === false && ap[1].approxime === false, ap);
  const apX = bac.arrApercu(L, { 71: { recue: 27, endommagee: 2, manquante: 1 }, 72: { recue: 38, endommagee: 2, manquante: 0 } }, bac.produits, {}, 'CUMP');
  test('aperçu : 10 unités en stock SANS revient + 27 reçues ⇒ coût du lot appliqué à tout le stock (50) et approximation signalée',
    apX[0].revientAvant === null && apX[0].revientApres === 50 && apX[0].approxime === true && apX[1].approxime === false, apX);
  test('aperçu : avertissement clair « X unités déjà en stock sans prix de revient… (décision du 26/11) »',
    bac.arrAvertissementApproxime(apX[0]).includes('10 unités déjà en stock sans prix de revient : le coût de ce lot leur est appliqué (décision du 26/11)') && bac.arrAvertissementApproxime(apX[1]) === '');
  test('appli : arrRevientInitialApproxime = même règle que la base (CUMP, reçu > 0, stock > 0, revient inconnu)',
    bac.arrRevientInitialApproxime('CUMP', 12, null, 30) === true && bac.arrRevientInitialApproxime('CUMP', 12, 40, 30) === false && bac.arrRevientInitialApproxime('CUMP', 0, null, 30) === false
    && bac.arrRevientInitialApproxime('CUMP', -2, null, 30) === false && bac.arrRevientInitialApproxime('CUMP', 12, null, 0) === false && bac.arrRevientInitialApproxime('DERNIER_PRIX', 12, null, 30) === false);
  const apxF = sql.slice(sql.indexOf('create or replace function interne.l039_revient_initial_approxime'), sql.indexOf('revoke all on function interne.l039_revient_initial_approxime'));
  test('base : marque revient_initial_approxime (colonne, décision PURE, écrite à la réception ET à la correction de taux, renvoyée)',
    sql.includes('revient_initial_approxime boolean not null default false,') && sql.includes('alter table public.prix_revient_historique add column if not exists revient_initial_approxime boolean not null default false;')
    && apxF.includes("select p_methode = 'CUMP' and coalesce(p_qte, 0) > 0 and coalesce(p_stock_avant, 0) > 0 and p_revient_avant is null")
    && sql.includes("v_prov_avant, v_prov_apres, interne.l039_revient_initial_approxime(v_methode, v_stock_avant, v_rev_avant, v_rec), 'admin');")
    && sql.includes("v_h_prov_avant, v_h_prov_apres, interne.l039_revient_initial_approxime(h.methode, h.stock_avant, v_h_avant, h.quantite), h.id, 'admin')")
    && sql.includes("'revient_initial_approxime', interne.l039_revient_initial_approxime(v_methode, v_stock_avant, v_rev_avant, v_rec));"));
  const auto10B = sql.slice(sql.indexOf("-- 10. Auto-contrôle à l'application : revient d'un lot"));
  test('base : auto-contrôle EXÉCUTÉ « stock existant sans revient » (approximation tracée, coût du lot appliqué, cas sans approximation)',
    ['stock existant sans revient : approximation tracée', 'stock existant sans revient : coût du lot appliqué à tout le stock', "stock existant avec revient : pas d''approximation",
     "stock vide : pas d''approximation", "stock négatif : pas d''approximation", "rien reçu : pas d''approximation", "dernier prix : pas d''approximation"].every(c => auto10B.includes("f := '" + c + "'")));
  test('base : le stock n\'augmente que des reçus bons (v_rec), jamais des endommagés', sql.includes('update public.produits set stock = coalesce(stock, 0) + v_rec') && !/stock = coalesce\(stock, 0\) \+ v_(end|man)/.test(sql));
  test('base : une ligne mouvements_stock « entree » par produit, source = référence de l\'arrivage', /insert into public\.mouvements_stock[\s\S]{0,200}values \('entree', p\.nom, v_rec, 'arrivage:' \|\| a\.reference_interne/.test(sql));
  test('base : historique du revient par lot écrit à la réception', /insert into public\.prix_revient_historique[\s\S]{0,500}'arrivage', a\.id, a\.taux_provisoire/.test(sql));

  console.log('\n4. DOUBLE VALIDATION REFUSÉE');
  test('arrivage en attente : validable', bac.arrPeutValider(arrivage('en_attente')) === true);
  test('arrivage reçu : non validable', bac.arrPeutValider(arrivage('recu')) === false);
  test('arrivage annulé : non validable', bac.arrPeutValider(arrivage('annule')) === false);
  const fonc = sql.slice(sql.indexOf('create or replace function public.valider_reception_arrivage'), sql.indexOf('create or replace function public.recalculer_revient_arrivage'));
  const iVerrou = fonc.indexOf('from public.arrivages where id = p_arrivage_id for update'), iStatut = fonc.indexOf("if a.statut <> 'en_attente' then"), iPremiereEcriture = fonc.indexOf('update public.');
  test('base : verrou sur l\'arrivage, puis refus si statut ≠ en_attente, AVANT toute écriture', iVerrou > 0 && iStatut > iVerrou && iPremiereEcriture > iStatut, { iVerrou, iStatut, iPremiereEcriture });
  test('base : l\'arrivage passe « recu » dans la même opération', fonc.includes("update public.arrivages set statut = 'recu'"));
  test('base : réservé à une session administrateur', fonc.includes("if (select public.session_role()) is distinct from 'admin' then"));
  // écran : deux clics (même très rapprochés) n'envoient qu'UNE validation ; après succès, le bouton disparaît
  let B = nouveauBac({ repondre: (url) => url.includes('/rpc/valider_reception_arrivage') ? { ok: true, status: 200, corps: { ok: true, total_recu: 70 } }
    : url.includes('/arrivages?') ? { ok: true, status: 200, corps: paginer(url, [arrivage('recu')]) } : url.includes('/arrivage_lignes?') ? { ok: true, status: 200, corps: paginer(url, lignesArr()) } : { ok: true, status: 200, corps: [] } });
  B.bac.ARR_ETAT.arrivages = [arrivage('en_attente')]; B.bac.ARR_ETAT.lignes = lignesArr();
  B.bac.arrOuvrir(7);
  const p1 = B.bac.arrValider(), p2 = B.bac.arrValider(); await Promise.all([p1, p2]);
  const nbRpc = () => B.appels.filter(a => a.url.includes('/rpc/valider_reception_arrivage')).length;
  test('double clic : une seule validation envoyée', nbRpc() === 1, nbRpc());
  test('après succès : arrivage relu « recu », plus de bouton Valider', B.bac.ARR_ETAT.arrivages[0].statut === 'recu' && !B.elts['arr-contenu'].innerHTML.includes('arr-btn-valider'), B.elts['arr-contenu'].innerHTML.slice(0, 200));
  B.bac.ARR_ETAT.arrivages = [arrivage('recu')]; await B.bac.arrValider();
  test('nouvelle tentative sur un arrivage reçu : refusée sans appel à la base', nbRpc() === 1 && B.toasts.some(t => t.t === 'err' && /déjà été traité/.test(t.m)), B.toasts);
  B = nouveauBac({ repondre: (url) => url.includes('/rpc/') ? { ok: true, status: 200, corps: { ok: false, erreur: 'arrivage_deja_traite', statut: 'recu' } }
    : url.includes('/arrivage_lignes?') ? { ok: true, status: 200, corps: paginer(url, lignesArr()) } : { ok: true, status: 200, corps: [] } });
  B.bac.ARR_ETAT.arrivages = [arrivage('en_attente')]; B.bac.ARR_ETAT.lignes = lignesArr(); B.bac.arrOuvrir(7); await B.bac.arrValider();
  test('la base refuse (validé ailleurs entre-temps) : message clair, rien n\'est compté comme reçu', B.toasts.some(t => t.t === 'err' && /NON validée : arrivage_deja_traite/.test(t.m)), B.toasts);
  B = nouveauBac({ confirmer: false }); B.bac.ARR_ETAT.arrivages = [arrivage('en_attente')]; B.bac.ARR_ETAT.lignes = lignesArr(); B.bac.arrOuvrir(7); await B.bac.arrValider();
  test('sans confirmation : rien n\'est envoyé', !B.appels.some(a => a.url.includes('/rpc/')));
  B = nouveauBac(); B.bac.ARR_ETAT.arrivages = [arrivage('en_attente')]; B.bac.ARR_ETAT.lignes = lignesArr(); B.bac.arrOuvrir(7); B.bac.arrSaisie(71, 'recue', '29'); await B.bac.arrValider();
  test('total faux : rien n\'est envoyé', !B.appels.some(a => a.url.includes('/rpc/')) && B.toasts.some(t => /Contrôle à corriger/.test(t.m)));
  B = nouveauBac({ role: 'collab' }); B.bac.ARR_ETAT.arrivages = [arrivage('en_attente')]; B.bac.ARR_ETAT.lignes = lignesArr(); B.bac.ARR_ETAT.ouvert = 7; await B.bac.arrValider();
  test('collaboratrice : validation refusée par l\'appli (et par la base)', !B.appels.some(a => a.url.includes('/rpc/')));
  // revue Codex PR 26 sur 636f873 : NAVIGATION PENDANT L'ENVOI — le verrou reste posé pendant toute l'opération (avant : arrOuvrir le
  // remettait à false pendant les relectures, et une seconde validation pouvait partir en parallèle)
  {
    let pendantNav = null, p2 = null;
    const autre = Object.assign(arrivage('en_attente'), { id: 8, reference_interne: 'ARR-TEST-2' });
    B = nouveauBac({ repondre: (url) => {
      if (url.includes('/rpc/valider_reception_arrivage')) return { ok: true, status: 200, corps: { ok: true, total_recu: 70 } };
      if (url.includes('/arrivage_lignes?') && url.includes('arrivage_id=eq.7') && !pendantNav) {
        // l'utilisateur navigue PENDANT la relecture : réouvre le même arrivage, en ouvre un autre, revient à la liste, actualise,
        // puis clique de nouveau sur « Valider »
        B.bac.arrOuvrir(7); B.bac.arrOuvrir(8); B.bac.arrFermer(); B.bac.arrInit(); p2 = B.bac.arrValider();
        pendantNav = { envoi: B.bac.ARR_ETAT.envoi, ouvert: B.bac.ARR_ETAT.ouvert, refus: B.toasts.filter(t => /Validation de la réception en cours/.test(t.m)).length };
      }
      if (url.includes('/arrivages?')) return { ok: true, status: 200, corps: paginer(url, [Object.assign(arrivage('recu')), autre]) };
      if (url.includes('/arrivage_lignes?')) return { ok: true, status: 200, corps: paginer(url, lignesArr()) };
      return { ok: true, status: 200, corps: [] };
    } });
    B.bac.ARR_ETAT.arrivages = [arrivage('en_attente'), autre]; B.bac.ARR_ETAT.lignes = lignesArr(); B.bac.arrOuvrir(7);
    await B.bac.arrValider(); await p2;
    const nbV = B.appels.filter(a => a.url.includes('/rpc/valider_reception_arrivage')).length;
    test('navigation pendant l\'envoi : verrou GARDÉ (même arrivage, autre arrivage, retour à la liste, actualiser)', !!pendantNav && pendantNav.envoi === true && pendantNav.ouvert === 7 && pendantNav.refus === 4, pendantNav);
    test('navigation pendant l\'envoi : second clic sur « Valider » sans effet, UNE seule validation envoyée', nbV === 1, nbV);
    test('après la validation : verrou levé, navigation de nouveau possible', B.bac.ARR_ETAT.envoi === false && (B.bac.arrOuvrir(8), B.bac.ARR_ETAT.ouvert === 8));
    // erreur inattendue pendant l'envoi : le verrou est levé quand même (finally), rien n'est envoyé, message clair
    B = nouveauBac({ repondre: (url) => url.includes('/arrivage_lignes?') ? { ok: true, status: 200, corps: paginer(url, lignesArr()) } : { ok: true, status: 200, corps: [] } });
    B.bac.ARR_ETAT.arrivages = [arrivage('en_attente')]; B.bac.ARR_ETAT.lignes = lignesArr(); B.bac.arrOuvrir(7);
    B.bac.arrAppliquerValorisation = () => { throw new Error('panne simulée'); };
    let leve = null; try { await B.bac.arrValider(); } catch (e) { leve = e; }
    test('erreur inattendue pendant l\'envoi : verrou levé, rien envoyé, message « erreur inattendue »', !leve && B.bac.ARR_ETAT.envoi === false && !B.appels.some(a => a.url.includes('/rpc/')) && B.toasts.some(t => /erreur inattendue \(panne simulée\)/.test(t.m)), B.toasts);
    const code = extraireFonction('function arrOuvrir(id)');
    test('code : arrOuvrir ne remet plus le verrou à false', !/envoi\s*=\s*false/.test(code));
  }

  console.log('\n5. PRODUIT NON VENDABLE : REFUSÉ PARTOUT');
  ({ bac } = nouveauBac());
  test('base → appli : prix NULL = prix à définir', bac.venDepuisBase({ prix: null }).prixDefini === false);
  test('base → appli : vendable=false lu', bac.venDepuisBase({ prix: 10, vendable: false }).vendable === false);
  test('base → appli : colonnes absentes (avant migration) = vendable, prix défini', (() => { const v = bac.venDepuisBase({ prix: 99 }); return v.vendable && v.prixDefini; })());
  const opts = bac.buildProduitOptions();
  test('nouvelle commande / SAV : le produit sans prix n\'est pas proposé', !opts.includes('value="pr-n"'), opts);
  test('nouvelle commande : un produit retiré de la vente n\'est pas proposé', !opts.includes('value="pr-retire"'));
  test('ensemble dont un composant est non vendable : pas proposé', !opts.includes('value="pr-e2"'));
  test('les produits vendables restent proposés (A, B, sommier, ensemble A)', ['pr-a', 'pr-b', 'pr-s', 'pr-e1'].every(id => opts.includes('value="' + id + '"')));
  test('venEst : ensemble avec composant non vendable = non vendable', bac.venEst(bac.produits.find(p => p.id === 'pr-e2'), bac.produits) === false && bac.venEst(bac.produits.find(p => p.id === 'pr-e1'), bac.produits) === true);
  // v7.5.152 (revue Codex PR 26 sur 2ce2dad) : composant identifié mais introuvable (ou inactif) = ensemble non vendable, comme la base
  {
    const ens = (composants) => ({ id: 'pr-ex', nom: 'Ensemble Fictif X', cat: 'Ensemble', prix: 210, stock: 0, seuil: 2, composants });
    const cat = bac.produits.concat([{ id: 'pr-inactif', nom: 'Sommier Inactif (fictif)', cat: 'Sommier', prix: 70, stock: 0, seuil: 2, actif: false }]);
    test('venEst : composant identifié mais INTROUVABLE dans le catalogue → ensemble non vendable', bac.venEst(ens([{ id: 'pr-a', qte: 1 }, { id: 'pr-disparu', qte: 1 }]), cat) === false);
    test('venEst : composant INACTIF (absent du catalogue chargé, ou actif = false) → ensemble non vendable', bac.venEst(ens([{ id: 'pr-a', qte: 1 }, { id: 'pr-inactif', qte: 1 }]), cat) === false);
    test('venEst : composant sans identifiant ignoré (comme la base) ; composants tous présents et vendables → vendable', bac.venEst(ens([{ id: 'pr-a', qte: 1 }, { qte: 1 }, { id: '', qte: 1 }]), cat) === true && bac.venEst(ens([{ id: 'pr-a' }, { id: 'pr-s' }]), cat) === true);
    test('venEst : catalogue vide (pas encore chargé) → un ensemble n\'est pas proposé', bac.venEst(ens([{ id: 'pr-a', qte: 1 }]), []) === false);
    const avant = bac.produits; bac.produits = cat.concat([ens([{ id: 'pr-a', qte: 1 }, { id: 'pr-disparu', qte: 1 }])]);
    test('nouvelle commande : l\'ensemble au composant introuvable n\'est plus proposé', !bac.buildProduitOptions().includes('value="pr-ex"'));
    bac.produits = avant;
    test('base : composant introuvable = non vendable (q.id is null), composant sans identifiant ignoré',
      /interne\.produit_non_vendable[\s\S]{0,900}left join public\.produits q on q\.id = c ->> 'id'[\s\S]{0,200}coalesce\(c ->> 'id', ''\) <> ''[\s\S]{0,120}q\.id is null/.test(sql));
  }
  test('enregistrement d\'une commande : ligne nouvelle avec produit non vendable refusée', JSON.stringify(bac.venLignesRefusees([{ produitId: 'pr-a' }, { produitId: 'pr-n' }], bac.produits, null)) === JSON.stringify(['Matelas Nouveau N (fictif)']));
  test('commande déjà prise qui le contenait : reste modifiable (ligne figée)', bac.venLignesRefusees([{ produitId: 'pr-retire' }], bac.produits, { lignes: [{ produitId: 'pr-retire' }] }).length === 0);
  test('produit hors catalogue (commande du site) : comportement inchangé', bac.venLignesRefusees([{ produitId: '_custom_X' }], bac.produits, null).length === 0);
  const saveCmd = extraireFonction('function saveCmd()');
  test('saveCmd applique le refus avant tout enregistrement', saveCmd.includes('venLignesRefusees(lignes, produits, existingCmd)') && saveCmd.indexOf('venLignesRefusees') < saveCmd.indexOf('paiAvancePreparer'));
  {
    // revue Codex PR 26 sur cf58971 : commande SANS LIGNES = produit principal contrôlé (même règle que interne.l039_lignes_effectives)
    const NV = 'Matelas Nouveau N (fictif)';
    test('sans lignes : lignes absentes, vides ou d\'un autre format → produit principal comme ligne', JSON.stringify(bac.venLignesEffectives(null, NV, 1, 0)) === JSON.stringify([{ produit: NV, qte: 1, prixUnit: 0, principal: true }])
      && bac.venLignesEffectives([], NV, 1, 0).length === 1 && bac.venLignesEffectives({ x: 1 }, NV, 1, 0).length === 1 && bac.venLignesEffectives(null, '  ', 1, 0).length === 0
      && JSON.stringify(bac.venLignesEffectives([{ produitId: 'pr-a' }], NV, 1, 0)) === '[{"produitId":"pr-a"}]');
    test('sans lignes : commande NOUVELLE au nom d\'un produit non vendable refusée (nom ou référence)', JSON.stringify(bac.venLignesRefusees(null, bac.produits, null, { produit: NV, qte: 1, prix: 0 })) === JSON.stringify([NV])
      && bac.venLignesRefusees([], bac.produits, null, { produit: 'mc-test-1', qte: 1, prix: 0 }).length === 1);
    test('sans lignes : libellé libre (« Reprise — … ») accepté', bac.venLignesRefusees([], bac.produits, null, { produit: 'Reprise — ' + NV, qte: 1, prix: 0 }).length === 0);
    const anc = { produit: NV, lignes: null, qte: 1, prix: 0 };
    test('sans lignes : commande EXISTANTE au produit principal inchangé reste modifiable', bac.venLignesRefusees(null, bac.produits, anc, { produit: NV, qte: 1, prix: 0 }).length === 0);
    test('sans lignes : quantité ou prix du produit principal modifiés refusés', bac.venLignesRefusees(null, bac.produits, anc, { produit: NV, qte: 2, prix: 0 }).length === 1
      && bac.venLignesRefusees(null, bac.produits, anc, { produit: NV, qte: 1, prix: 50 }).length === 1);
    test('sans lignes : ancienne commande sans lignes, lignes vendables saisies → acceptée', bac.venLignesRefusees([{ produitId: 'pr-a', produit: 'Matelas Fictif A 140×190', qte: 1 }], bac.produits, anc).length === 0);
    const sav = extraireFonction('async function savCreer()');
    test('SAV (appli) : produit à livrer ou produit principal contrôlé AVANT l\'enregistrement', sav.includes('venLignesRefusees(lignes, produits, null, { produit: produitFinalLabel, qte: 1, prix: prixCmd })')
      && sav.indexOf('venLignesRefusees') < sav.indexOf('sbSaveCommande(newCmd)'));
    const eff = sql.slice(sql.indexOf('create or replace function interne.l039_lignes_effectives'), sql.indexOf('revoke all on function interne.l039_lignes_effectives'));
    const trigE = sql.slice(sql.indexOf('create or replace function interne.commandes_produit_vendable_garde()'), sql.indexOf('create trigger commandes_produit_vendable_garde'));
    test('base : commande sans lignes — produit principal (produit, qte, prix) comme ligne, fonction PURE, accès retiré',
      eff.includes('language sql immutable') && eff.includes("when jsonb_typeof(p_lignes) = 'array' and p_lignes <> '[]'::jsonb then p_lignes")
      && eff.includes("jsonb_build_object('produit', p_produit, 'qte', coalesce(p_qte, 'null'::jsonb)") && !trigE.includes("if jsonb_typeof(v_new) is distinct from 'array' then return new;")
      && trigE.includes('interne.l039_lignes_effectives(to_jsonb(new.lignes), new.produit::text, to_jsonb(new.qte), to_jsonb(new.prix))')
      && trigE.includes('interne.l039_lignes_effectives(to_jsonb(old.lignes), old.produit::text, to_jsonb(old.qte), to_jsonb(old.prix))')
      && sql.includes('revoke all on function interne.l039_lignes_effectives(jsonb, text, jsonb, jsonb) from public, anon, authenticated;'));
    const auto10e = sql.slice(sql.indexOf("-- 10. Auto-contrôle à l'application : revient d'un lot"));
    test('base : auto-contrôle EXÉCUTÉ (commande sans lignes : nouvelle refusée, existante inchangée acceptée, quantité modifiée refusée)',
      ['lignes absentes : produit principal', 'lignes vides : produit principal', "lignes d''un autre format : produit principal", 'sans lignes ni produit : rien à comparer',
       'lignes présentes prises telles quelles', "commande nouvelle sans lignes au nom d''un produit non vendable", 'commande existante sans lignes inchangée', 'quantité du produit principal modifiée'].every(c => auto10e.includes("f := '" + c + "'")));
  }
  const compo = extraireFonction('function composRenderList()');
  test('composition d\'un ensemble : composant non vendable signalé', compo.includes('NON VENDABLE'));
  test('stock : badge « Prix à définir — non vendable » et prix « à définir »', bac.VEN_LIBELLE === 'Prix à définir — non vendable' && extraireFonction('function stkRender()').includes('venBadge()') && extraireFonction('function stkRender()').includes("p.prixDefini===false?"));
  const save = extraireFonction('async function sbSaveProduit(p)');
  test('fiche produit : un produit sans prix n\'est jamais renvoyé avec un prix 0', save.includes('prix: (p.prixDefini === false) ? null : (p.prix||0)'));
  test('fiche produit : seul l\'administrateur fixe le prix (puis vendable)', extraireFonction('async function venDefinirPrix(p, prix)').includes("role !== 'admin'") && extraireFonction('function sauvegarderProduit()').includes("role === 'admin' && data.prix > 0"));
  // chargement depuis la base : les marqueurs arrivent dans le catalogue en mémoire
  B = nouveauBac({ repondre: () => ({ ok: true, status: 200, corps: [{ id: 'pr-z', nom: 'Nouveau Z', cat: 'Matelas', prix: null, stock: 0, actif: true, vendable: false, prix_vente_defini: false, reference_interne: 'MC-TEST-Z' }] }) });
  await B.bac.sbLoadProduits(); const z = B.bac.produits.find(p => p.id === 'pr-z');
  test('chargement : prix NULL → prix 0 affiché « à définir », non vendable, réf. interne', z && z.prix === 0 && z.prixDefini === false && z.vendable === false && z.refInterne === 'MC-TEST-Z', z);
  test('base : déclencheur sur commandes (lignes nouvelles seulement, upsert compris)', sql.includes('create trigger commandes_produit_vendable_garde before insert or update of lignes, produit, qte, prix, remise_globale, remise_globale_val, remise_globale_type on public.commandes') && sql.includes('select interne.l039_lignes_effectives(to_jsonb(c.lignes), c.produit::text, to_jsonb(c.qte), to_jsonb(c.prix)),\n           interne.l039_remise_signature(to_jsonb(c.remise_globale_val), c.remise_globale_type::text, to_jsonb(c.remise_globale))\n      into v_old, v_old_remise\n      from public.commandes c where c.id = new.id'));
  {
    // revue Codex sur 82a9b09 (point 1) : lignes FIGÉES ligne à ligne
    const trig = sql.slice(sql.indexOf('create or replace function interne.commandes_produit_vendable_garde()'), sql.indexOf('create trigger commandes_produit_vendable_garde'));
    test('base : lignes figées — TOUTES les lignes des produits non vendables comparées (plus d\'exemption « produit déjà présent »)',
      trig.includes('v_modif := interne.lignes_non_vendables_modifiees(v_new, v_old, v_nv);') && !trig.includes("not exists (select 1 from jsonb_array_elements(v_old) o where o ->> 'produitId' = e ->> 'produitId')"));
    test('base : lignes figées — comparaison en multiensemble trié de signatures (occurrences, quantité, prix, remises)',
      /jsonb_agg\(interne\.l039_signature_ligne\(e\) order by interne\.l039_signature_ligne\(e\)\)[\s\S]{0,200}is distinct from[\s\S]{0,200}jsonb_agg\(interne\.l039_signature_ligne\(o\) order by interne\.l039_signature_ligne\(o\)\)/.test(sql)
      && ['qte', 'prixUnit', 'prixBrut', 'remiseLigne', 'remiseVal', 'remiseType', 'sousTotal'].every(k => sql.includes("'" + k + "', ")));
    test('base : lignes figées — upsert : lignes actuelles de la commande comme référence, commande nouvelle = refus', trig.includes('select interne.l039_lignes_effectives(to_jsonb(c.lignes), c.produit::text, to_jsonb(c.qte), to_jsonb(c.prix)),\n           interne.l039_remise_signature(to_jsonb(c.remise_globale_val), c.remise_globale_type::text, to_jsonb(c.remise_globale))\n      into v_old, v_old_remise\n      from public.commandes c where c.id = new.id;') && trig.includes('Commande nouvelle : v_old reste NULL'));
    const auto = sql.slice(sql.indexOf('9. Auto-contrôle à l\'application : lignes figées'));
    test('base : auto-contrôle EXÉCUTÉ à l\'application de la migration (quantité, prix, doublon, occurrence retirée, commande nouvelle, ordre libre)',
      ['identique', 'ordre / produit vendable modifié', 'retrait total', 'quantité', 'prix', 'ligne en double ajoutée', 'une occurrence retirée', 'commande nouvelle'].every(c => auto.includes("f := '" + c + "'")) && auto.includes('Migration annulée'));
    // point 2 : correspondance certaine d'un produit qui DEVIENT non vendable
    test('base : produit (ou composant d\'ensemble) qui devient non vendable avec une variante Shopify « certaine » → refusé',
      sql.includes('create trigger produits_correspondance_garde after update of vendable, prix_vente_defini, composants on public.produits')
      && /produits_correspondance_garde\(\)[\s\S]{0,900}sc\.fiabilite = 'certaine'[\s\S]{0,500}c ->> 'id' = new\.id[\s\S]{0,200}interne\.produit_non_vendable\(sc\.app_produit_id\)/.test(sql)
      && sql.includes('drop trigger if exists produits_correspondance_garde on public.produits;'));
  }
  test('base : déclencheur sur la correspondance Shopify (variante « certaine »)', sql.includes('create trigger stock_correspondance_vendable_garde') && sql.includes("new.fiabilite = 'certaine' and interne.produit_non_vendable(new.app_produit_id)"));
  test('base : un ensemble dont un composant est non vendable est non vendable', /produit_non_vendable[\s\S]{0,700}jsonb_array_elements\(p\.composants\)/.test(sql));
  test('base : collaboratrice / livreur ne peuvent pas rendre un produit vendable', sql.includes('new.vendable := old.vendable;') && sql.includes('new.prix_vente_defini := old.prix_vente_defini;'));
  test('base : un produit vendable sans prix défini est impossible', sql.includes("PRODUIT NON VENDABLE : « % » n''a pas de prix de vente défini"));
  const wa = fs.readFileSync(path.join(racine, 'supabase', 'functions', 'whatsapp-receive', 'index.ts'), 'utf8');
  const pv = await import('file:///' + path.join(racine, 'supabase', 'functions', '_shared', 'produits-vendables.ts').replace(/\\/g, '/'));
  const rowsW = [
    { id: 'a', nom: 'Matelas Fictif A', actif: true }, { id: 's', nom: 'Sommier Fictif', actif: true },
    { id: 'n', nom: 'Matelas Nouveau N', actif: true, vendable: false, prix_vente_defini: false },
    { id: 'e-ok', nom: 'Ensemble A + Sommier', actif: true, composants: [{ id: 'a', qte: 1 }, { id: 's', qte: 1 }] },
    { id: 'e-nv', nom: 'Ensemble N + Sommier', actif: true, composants: [{ id: 'n', qte: 1 }, { id: 's', qte: 1 }] },
    { id: 'e-inactif', nom: 'Ensemble composant inactif non vendable', actif: true, composants: [{ id: 'x', qte: 1 }] },
    { id: 'x', nom: 'Matelas X inactif non vendable', actif: false, vendable: false },
  ];
  const vend = pv.produitsVendables(rowsW).map(r => r.id);
  test('règle commune : produit non vendable écarté', !vend.includes('n'));
  test('règle commune : ENSEMBLE dont un composant est non vendable écarté (revue Codex P2)', !vend.includes('e-nv') && vend.includes('e-ok'), vend);
  test('règle commune : composant INACTIF non vendable pris en compte (catalogue complet lu avant le filtre « actif »)', !vend.includes('e-inactif'), vend);
  test('règle commune : colonnes absentes (avant migration) = tout vendable', pv.produitsVendables([{ id: 'z' }, { id: 'y', composants: [{ id: 'z' }] }]).length === 2);
  test('rapprochement WhatsApp : lecture COMPLÈTE (pages + composants par identifiants), règle commune, puis produits actifs',
    wa.includes("import { catalogueWhatsapp, lireCatalogueComplet } from '../_shared/produits-vendables.ts';")
    && /\.eq\('actif', true\)\.order\('id'\)\.range\(debut, fin\)/.test(wa) && /\.select\('\*'\)\.in\('id', ids\)/.test(wa)
    && /return catalogueWhatsapp\(rows\);/.test(wa) && !/\.limit\(1000\)/.test(wa) && !/slice\(0, 200\)/.test(wa));
  test('rapprochement WhatsApp : erreur de lecture → catalogue VIDE (jamais partiel)', /catch \(e\) \{\s*console\.error\('chargerCatalogue : lecture impossible', e\);\s*return \[\];/.test(wa));
  {
    // revue Codex sur 82a9b09 : 1 500 produits actifs (au-delà de l'ancien plafond de 1 000), ensemble en DERNIÈRE page dont le
    // composant non vendable est INACTIF (donc absent de la lecture des actifs) : il doit être lu par identifiant et l'ensemble écarté
    const actifs = [];
    for (let n = 0; n < 1499; n++) actifs.push({ id: 'p' + String(n).padStart(4, '0'), nom: 'Fictif ' + n, actif: true });
    actifs.push({ id: 'p9999-ens', nom: 'Ensemble fictif', actif: true, composants: [{ id: 'cach', qte: 1 }, { id: 'p0001', qte: 1 }] });
    const base = actifs.concat([{ id: 'cach', nom: 'Composant inactif non vendable', actif: false, vendable: false, prix_vente_defini: false }]);
    const pages = [], parIds = [];
    const rows = await pv.lireCatalogueComplet(
      async (d, f2) => { pages.push([d, f2]); return actifs.slice(d, f2 + 1); },
      async (ids) => { parIds.push(ids.slice()); return base.filter(r => ids.includes(r.id)); });
    const vendW = pv.produitsVendables(rows).filter(p => p.actif === true).map(p => p.id);
    test('catalogue complet : lu par pages au-delà du plafond (2 pages pleines + page vide qui arrête la lecture)', pages.length === 3 && pages[1][0] === 1000 && pages[2][0] === 1500 && rows.filter(r => r.actif).length === 1500, pages);
    test('catalogue complet : composant absent de la lecture chargé PAR IDENTIFIANT', parIds.length === 1 && JSON.stringify(parIds[0]) === '["cach"]', parIds);
    test('catalogue complet : ensemble dont le composant (non lu au départ) est non vendable → écarté', !vendW.includes('p9999-ens') && vendW.includes('p1498'), vendW.length);
    let leve = false;
    try { await pv.lireCatalogueComplet(async () => actifs.slice(-2), async () => { throw new Error('panne'); }); } catch (e) { leve = true; }
    test('catalogue complet : erreur de lecture des composants → exception (pas de catalogue partiel)', leve);
    leve = false;
    try { await pv.lireCatalogueComplet(async () => null, async () => []); } catch (e) { leve = true; }
    test('catalogue complet : page illisible → exception', leve);
  }
  test('JARVIS : même règle commune (idsNonVendables)', fs.readFileSync(path.join(racine, 'supabase', 'functions', '_shared', 'jarvis-action-logique.ts'), 'utf8').includes('const nonVendables = idsNonVendables(rows);'));
  const jl = await import('file:///' + path.join(racine, 'supabase', 'functions', '_shared', 'jarvis-action-logique.ts').replace(/\\/g, '/'));
  const catJ = jl.catalogueDepuisBase([{ id: 'n', nom: 'Matelas Nouveau N (fictif)', prix: null, vendable: false, prix_vente_defini: false }, { id: 'a', nom: 'Matelas Fictif A 140×190', prix: 100 }]);
  test('JARVIS creer_commande : produit non vendable refusé', /pas encore vendable/.test(jl.lignesCommande([{ produitId: 'n', produit: 'x', qte: 1 }], catJ).erreur || ''));
  test('JARVIS : produit vendable accepté au prix du catalogue', jl.lignesCommande([{ produitId: 'a', produit: 'x', qte: 1 }], catJ).lignes[0].prixUnit === 100);
  // revue Codex PR 26 sur cf58971 : SAV / commande sans lignes — produit principal contrôlé
  test('JARVIS : commande sans lignes au nom d\'un produit non vendable → refusée', (jl.produitPrincipalNonVendable(null, 'matelas nouveau n (FICTIF)', catJ) || {}).id === 'n'
    && (jl.produitPrincipalNonVendable([], 'Matelas Nouveau N (fictif)', catJ) || {}).id === 'n');
  test('JARVIS : sans lignes, produit vendable ou libellé libre → accepté ; lignes présentes → contrôlées ligne par ligne', jl.produitPrincipalNonVendable(null, 'Matelas Fictif A 140×190', catJ) === null
    && jl.produitPrincipalNonVendable(null, 'Échange — Matelas Nouveau N (fictif)', catJ) === null && jl.produitPrincipalNonVendable([{ produit: 'x' }], 'Matelas Nouveau N (fictif)', catJ) === null);
  const jIdx = fs.readFileSync(path.join(racine, 'supabase', 'functions', 'jarvis-action', 'index.ts'), 'utf8');
  test('JARVIS : SAV et modification du produit principal contrôlés avant écriture', /const nvS = produitPrincipalNonVendable\(sav\.lignes, sav\.produit, catS\);[\s\S]{0,1200}if \(!confirme\)/.test(jIdx)
    && /const nvM = produitPrincipalNonVendable\([\s\S]{0,1500}sb\.from\('commandes'\)\.update\(m\.apres\)/.test(jIdx));

  console.log('\n6. STOCK ENTRANT DISTINCT DU STOCK DISPONIBLE');
  test('stock entrant agrégé par produit', JSON.stringify(bac.arrStockEntrant([{ produit_id: 'pr-a', quantite: 30 }, { produit_id: 'pr-n', quantite: '40' }, { produit_id: 'pr-a', quantite: 5 }])) === JSON.stringify({ 'pr-a': 35, 'pr-n': 40 }));
  B = nouveauBac({ repondre: (url) => url.includes('stock_entrant') ? { ok: true, status: 200, corps: [{ produit_id: 'pr-n', quantite: 40, arrivages: 1 }] } : { ok: true, status: 200, corps: [] } });
  await B.bac.stkChargerArrivage();
  test('inventaire : stock entrant chargé, stock disponible INCHANGÉ (0)', B.bac.ARR_ETAT.entrant['pr-n'] === 40 && B.bac.produits.find(p => p.id === 'pr-n').stock === 0);
  const stk = extraireFonction('function stkRender()');
  test('inventaire : « entrant » affiché à part, getStockDispo (disponible) inchangé', stk.includes('ARR_ETAT.entrant[p.id]') && stk.includes('non compté dans le stock disponible') && extraireFonction('function getStockDispo(p)').includes('return p.stock || 0;'));
  test('base : stock_entrant = arrivages EN ATTENTE seulement, sans aucun prix', /function public\.stock_entrant\(\)[\s\S]*where a\.statut = 'en_attente'/.test(sql) && !/stock_entrant\(\) returns table \([^)]*(revient|fob)/.test(sql));
  test('base : stock_entrant réservé à l\'administrateur et à la collaboratrice', sql.includes("if coalesce((select public.session_role()), '') not in ('admin', 'collab') then return; end if;"));

  console.log('\n7. PRIX DE REVIENT : ADMINISTRATEUR SEULEMENT');
  test('le revient n\'est PAS une colonne de produits (lisible par collaboratrice et livreur)', !/alter table public\.produits[\s\S]{0,400}prix_revient_ht/.test(sql) && sql.includes('create table if not exists public.produits_revient'));
  for (const t of ['arrivages', 'arrivage_lignes', 'produits_revient', 'prix_revient_historique']) test('table ' + t + ' : lecture administrateur seulement, aucune écriture par l\'appli', sql.includes("'" + t + "'") && sql.includes("create policy sess_admin_lecture on public.%I for select to anon using ((select public.session_role()) = ''admin'')"));
  test('historique des revients : ajout seul (modification et suppression refusées)', sql.includes('create trigger prix_revient_historique_fige before update or delete on public.prix_revient_historique'));
  B = nouveauBac({ role: 'collab' }); await B.bac.arrChargerRevients();
  test('collaboratrice : l\'appli ne demande même pas les revients', !B.appels.some(a => a.url.includes('produits_revient')));
  B = nouveauBac({ role: 'livreur' }); await B.bac.stkChargerArrivage();
  test('livreur : ni revient ni stock entrant demandés', B.appels.length === 0);
  test('colonne « Revient HT » masquée hors administrateur', extraireFonction('function stkApplyRoleVisibility()').includes("const voitRevient = role === 'admin';"));
  test('écran Arrivages : administrateur seulement (menu et page)', /admin:\{[\s\S]*?\{p:'arrivages',i:'🚢',l:'Arrivages'\}[\s\S]*?collab:\{/.test(html) && !/collab:\{[\s\S]*?livreur:\{[\s\S]*?\{p:'arrivages'/.test(html.slice(html.indexOf('collab:{'), html.indexOf('function buildUI'))) && extraireFonction('async function arrInit()').includes("if (role !== 'admin')"));

  console.log('\n8. TAUX DE CHANGE DÉFINITIF ET MARGES PASSÉES');
  const rec = sql.slice(sql.indexOf('create or replace function public.recalculer_revient_arrivage'), sql.indexOf('-- 7. Stock ENTRANT'));
  test('recalcul : revient = FOB × nouveau taux + frais répartis sur les quantités attendues', rec.includes('v_frais_u := a.frais_import_ht / v_total;') && rec.includes('round(l.fob_unitaire * p_nouveau_taux + v_frais_u, 4)'));
  test('recalcul : une seule fois (taux ensuite définitif)', rec.includes("if not a.taux_provisoire then return json_build_object('ok', false, 'erreur', 'taux_deja_definitif')") && rec.includes('taux_provisoire = false'));
  test('recalcul : l\'historique provisoire est RELIÉ à une ligne de correction, jamais réécrit', rec.includes("'recalcul_taux'") && rec.includes('update public.prix_revient_historique set remplace_par = v_id where id = h.id'));
  test('recalcul : REJEU depuis le départ de TOUS les lots du produit, ordre de RÉCEPTION, revient effectif (revue Codex P2)',
    rec.includes('order by ar.ordre_reception nulls last, ar.id, o.id') && !rec.includes('ar.recu_le') && rec.includes('left join public.prix_revient_historique c on c.id = o.remplace_par')
    && rec.includes("where o.produit_id = l.produit_id and o.source = 'arrivage'")
    && rec.includes('case when o.arrivage_id = a.id then v_rev else coalesce(c.revient_ht, o.revient_ht) end as revient_effectif')
    && rec.includes('v_cur := interne.revient_apres(x.methode, x.stock_avant, v_cur, x.quantite, x.revient_effectif);')
    && !rec.includes('id > h.id') && !rec.includes('RECALCUL IMPOSSIBLE'));
  test('recalcul : départ = valorisation d\'avant le tout premier lot ; quantités reçues et stock enregistré, jamais le stock courant',
    rec.includes('v_cur := x.revient_moyen_avant; v_prov := coalesce(x.moyen_avant_provisoire, false); v_premier := false;') && !/from public\.produits p?\s*where id = l\.produit_id/.test(rec) && !rec.includes('p.stock'));
  // ----- MODÈLE du rejeu (même algorithme que la base), calcul de référence = arrNouveauRevient de l'appli -----
  const N = bac.arrNouveauRevient;
  const provApres = (m, st, ravant, q, pav, plot) => (q <= 0 ? pav : (m === 'DERNIER_PRIX' || ravant == null || st <= 0) ? plot : (plot || pav));
  function modele() {
    const hist = [], arr = {}; let cur = null, prov = false, idh = 0, ordre = 0;
    return {
      recevoir(a, recuLe, stockAvant, q, rev) { arr[a] = { recuLe, ordre: ++ordre, prov: true }; // ordre = séquence tirée après les verrous
        const r = { id: ++idh, a, source: 'arrivage', st: stockAvant, q, rev, prov: true, moyAv: cur, moyAvProv: prov, remplace: null };
        prov = provApres('CUMP', stockAvant, cur, q, prov, true); cur = N('CUMP', stockAvant, cur, q, rev); hist.push(r); },
      // revient modifié EN DEHORS de l'historique (écriture directe côté serveur) : rupture de continuité
      modifierHorsHistorique(v) { cur = v; },
      finaliser(a, revDef) {
        const h = hist.find(x => x.a === a && x.source === 'arrivage' && x.remplace === null);
        const lots = hist.filter(x => x.source === 'arrivage').sort((x, y) => arr[x.a].ordre - arr[y.a].ordre || (x.a < y.a ? -1 : 1) || x.id - y.id);
        // CONTINUITÉ (revue Codex PR 26 sur a0c1bf8, interne.l039_revient_rejoue) : rejeu de l'historique ACTUEL, sans la correction
        let cA = null, premA = true;
        for (const x of lots) { const corr = x.remplace ? hist.find(y => y.id === x.remplace) : null; if (premA) { cA = x.moyAv; premA = false; } cA = N('CUMP', x.st, cA, x.q, corr ? corr.rev : x.rev); }
        if (Math.round((cur == null ? NaN : cur) * 1e4) !== Math.round((cA == null ? NaN : cA) * 1e4) && !(cur == null && cA == null)) return 'rupture_continuite';
        let c = null, p = false, premier = true;
        for (const x of lots) {
          const corr = x.remplace ? hist.find(y => y.id === x.remplace) : null;
          const revEff = x.a === a ? revDef : (corr ? corr.rev : x.rev), provEff = x.a === a ? false : (corr ? corr.prov : x.prov);
          if (premier) { c = x.moyAv; p = x.moyAvProv; premier = false; }
          p = provApres('CUMP', x.st, c, x.q, p, provEff); c = N('CUMP', x.st, c, x.q, revEff);
        }
        const corr = { id: ++idh, a, source: 'recalcul_taux', rev: revDef, prov: false, remplace: null }; hist.push(corr); h.remplace = corr.id;
        cur = c; prov = p; arr[a].prov = false; return 'ok'; },
      get revient() { return cur; }, get provisoire() { return prov; }, hist };
  }
  // scénario Codex 2 : A 10 à 100 puis B 10 à 200 (stock nul au départ) ; A finalisé à 120, B à 220 → (10×120 + 10×220) / 20 = 170
  let M = modele(); M.recevoir('A', 1, 0, 10, 100); M.recevoir('B', 2, 10, 10, 200); M.finaliser('A', 120); M.finaliser('B', 220);
  test('scénario Codex : A 100→120, B →220, 10 + 10 ⇒ 170, plus provisoire', M.revient === 170 && M.provisoire === false, { r: M.revient, p: M.provisoire });
  M = modele(); M.recevoir('A', 1, 0, 10, 100); M.recevoir('B', 2, 10, 10, 200); M.finaliser('B', 220); M.finaliser('A', 120);
  test('même scénario, corrections dans l\'autre ordre ⇒ 170 aussi', M.revient === 170 && M.provisoire === false, M.revient);
  // scénario Codex 1 : A, B, C reçus ; B puis A finalisés ; C encore provisoire
  const directABC = N('CUMP', 20, N('CUMP', 10, N('CUMP', 0, null, 10, 110), 10, 210), 10, 300);
  M = modele(); M.recevoir('A', 1, 0, 10, 100); M.recevoir('B', 2, 10, 10, 200); M.recevoir('C', 3, 20, 10, 300); M.finaliser('B', 210); M.finaliser('A', 110);
  test('scénario Codex : A, B, C ; B puis A finalisés = calcul direct (A 110, B 210, C 300)', M.revient === directABC, { r: M.revient, directABC });
  test('scénario Codex : C jamais finalisé ⇒ revient encore provisoire', M.provisoire === true);
  M.finaliser('C', 310);
  test('puis C finalisé ⇒ calcul direct au bon taux, plus provisoire', M.revient === N('CUMP', 20, N('CUMP', 10, N('CUMP', 0, null, 10, 110), 10, 210), 10, 310) && M.provisoire === false, M.revient);
  M = modele(); M.recevoir('A', 1, 0, 10, 100); M.recevoir('B', 2, 4, 10, 200); M.finaliser('A', 120);
  test('ventes entre deux lots : poids = stock enregistré à la réception (4), pas le stock courant', M.revient === N('CUMP', 4, 120, 10, 200) && M.provisoire === true, M.revient);
  // réceptions qui se chevauchent : B a commencé AVANT A (heure de début de transaction plus ancienne) mais a obtenu les verrous APRÈS
  const M2 = modele(); M2.recevoir('A', 5, 0, 10, 100); M2.recevoir('B', 1, 10, 10, 200); M2.finaliser('A', 120); M2.finaliser('B', 220);
  test('réceptions qui se chevauchent : le rejeu suit l\'ordre réel (séquence), pas l\'heure de début ⇒ 170', M2.revient === 170, M2.revient);
  // RUPTURE DE CONTINUITÉ (revue Codex PR 26 sur a0c1bf8) : revient changé hors historique entre deux arrivages ⇒ correction REFUSÉE
  let MR = modele(); MR.recevoir('A', 1, 0, 10, 100); MR.modifierHorsHistorique(150); MR.recevoir('B', 2, 10, 10, 200);
  const revAvantR = MR.revient, nbHistR = MR.hist.length;
  test('rupture : revient modifié entre A et B hors historique ⇒ correction de A refusée, rien n\'est écrit (revient et historique inchangés)',
    MR.finaliser('A', 120) === 'rupture_continuite' && MR.revient === revAvantR && MR.hist.length === nbHistR && MR.hist.every(x => x.remplace === null), { r: MR.revient });
  MR = modele(); MR.recevoir('A', 1, 0, 10, 100); MR.recevoir('B', 2, 10, 10, 200); MR.modifierHorsHistorique(99);
  test('rupture : revient modifié après le dernier lot ⇒ correction refusée', MR.finaliser('B', 220) === 'rupture_continuite' && MR.revient === 99);
  MR = modele(); MR.recevoir('A', 1, 0, 10, 100); MR.recevoir('B', 2, 10, 10, 200);
  test('continuité gardée (aucune écriture hors historique) ⇒ corrections successives acceptées', MR.finaliser('B', 220) === 'ok' && MR.finaliser('A', 120) === 'ok' && MR.revient === 170);
  test('base : rupture de continuité contrôlée AVANT toute écriture, correction refusée en entier (rupture_continuite)',
    rec.includes("where interne.l039_continuite_rompue(k.courant, k.rejoue);") && rec.includes("'erreur', 'rupture_continuite'")
    && rec.indexOf("'rupture_continuite'") < rec.indexOf('update public.arrivage_lignes set revient_unitaire_ht')
    && rec.indexOf("'rupture_continuite'") > rec.indexOf('from public.produits_revient where produit_id in')
    && rec.includes('interne.l039_revient_rejoue(d.produit_id)') && rec.includes('left join public.produits_revient pr on pr.produit_id = d.produit_id'));
  const rejF = sql.slice(sql.indexOf('create or replace function interne.l039_revient_rejoue'), sql.indexOf('revoke all on function interne.l039_revient_rejoue'));
  test('base : l039_revient_rejoue = même rejeu que la correction (ordre de réception, revient effectif, sans la correction demandée)',
    rejF.includes('order by ar.ordre_reception nulls last, ar.id, o.id') && rejF.includes('coalesce(c.revient_ht, o.revient_ht) as revient_effectif')
    && rejF.includes("where o.produit_id = p_produit_id and o.source = 'arrivage'") && rejF.includes('v_cur := interne.revient_apres(x.methode, x.stock_avant, v_cur, x.quantite, x.revient_effectif);'));
  const auto10c = sql.slice(sql.indexOf("-- 10. Auto-contrôle à l'application : revient d'un lot"));
  test('base : auto-contrôle EXÉCUTÉ de la continuité (même revient, modifié, absent, sans historique, rien à comparer)',
    ['continuité : même revient à 4 décimales', 'continuité rompue : revient modifié hors historique', 'continuité rompue : revient courant absent',
     'continuité rompue : revient sans historique', 'continuité : rien à comparer'].every(c => auto10c.includes("f := '" + c + "'")));
  const valO = sql.slice(sql.indexOf('create or replace function public.valider_reception_arrivage'), sql.indexOf('create or replace function public.recalculer_revient_arrivage'));
  test('ordre de réception tiré par séquence APRÈS les verrous produits et produits_revient, enregistré sur l\'arrivage',
    valO.indexOf("v_ordre := nextval('public.arrivages_ordre_reception_seq');") > valO.indexOf('perform 1 from public.produits_revient where produit_id in')
    && valO.indexOf('perform 1 from public.produits_revient where produit_id in') > 0 && valO.includes('recu_le = v_instant, ordre_reception = v_ordre')
    && sql.includes('ordre_reception bigint unique,') && sql.includes('create sequence if not exists public.arrivages_ordre_reception_seq;'));
  test('stock_entrees.date_entree = instant RÉEL pris après les verrous (clock_timestamp, même moment que ordre_reception), jamais now()',
    valO.indexOf('v_instant := clock_timestamp();') > valO.indexOf("v_ordre := nextval('public.arrivages_ordre_reception_seq');")
    && valO.indexOf("v_ordre := nextval('public.arrivages_ordre_reception_seq');") > valO.indexOf('perform 1 from public.produits_revient where produit_id in')
    && valO.includes("values (v_instant, l.produit_id, v_rec, 'arrivage:' || a.reference_interne") && !/insert into public\.stock_entrees[\s\S]{0,200}values \(now\(\)/.test(valO)
    && valO.indexOf('insert into public.stock_entrees') > valO.indexOf('v_instant := clock_timestamp();'));
  test('historique jamais réécrit : une ligne de correction par lot finalisé, reliée à l\'original', M.hist.filter(x => x.source === 'recalcul_taux').length === 1 && M.hist.find(x => x.a === 'A' && x.source === 'arrivage').remplace !== null);
  console.log('\n8 bis. REVIENT PROVISOIRE, STOCK_ENTREES, ORDRE DES VERROUS (revue Codex P2)');
  test('CUMP qui intègre un revient précédent provisoire = provisoire (lot OU ancien)', sql.includes("else coalesce(p_prov_lot, false) or coalesce(p_prov_avant, false)")
    && sql.includes('v_prov_apres := interne.revient_provisoire_apres(v_methode, v_stock_avant, v_rev_avant, v_rec, v_prov_avant, a.taux_provisoire);')
    && sql.includes('values (l.produit_id, v_rev_apres, v_methode, v_prov_apres, now(), \'admin\')'));
  test('revient du lot seul (pas de stock / revient inconnu / dernier prix) : provisoire selon le lot', sql.includes("when p_methode = 'DERNIER_PRIX' or p_revient_avant is null or coalesce(p_stock_avant, 0) <= 0 then coalesce(p_prov_lot, false)"));
  test('historique : état provisoire du revient avant / après conservé (sert au recalcul en chaîne)', sql.includes('moyen_avant_provisoire boolean,') && sql.includes('moyen_apres_provisoire boolean not null default false,')
    && rec.includes('v_prov := interne.revient_provisoire_apres(x.methode, x.stock_avant, v_cur, x.quantite, v_prov, x.provisoire_effectif);'));
  const val = sql.slice(sql.indexOf('create or replace function public.valider_reception_arrivage'), sql.indexOf('create or replace function public.recalculer_revient_arrivage'));
  test('réception : entrée écrite aussi dans stock_entrees (motif « arrivage:<réf> »), reçus bons seulement',
    /insert into public\.stock_entrees \(date_entree, app_produit_id, quantite, motif, cmd_id, saisi_par, remarque\)\s+values \(v_instant, l\.produit_id, v_rec, 'arrivage:' \|\| a\.reference_interne/.test(val)
    && val.indexOf('insert into public.stock_entrees') > val.indexOf('if v_rec > 0 then'));
  test('stock_entrees accepte le motif « arrivage:… » (contrainte élargie, motifs existants gardés)', sql.includes("check (motif in ('reassort', 'retour_gls', 'reprise_sav', 'correction') or motif like 'arrivage:%')"));
  test('pas de double comptage : l\'appli lit produits.stock et jamais stock_entrees', !html.includes('stock_entrees'));
  const ordre = (txt) => { const iA = txt.indexOf('from public.arrivages where id = p_arrivage_id for update'), iP = txt.indexOf('perform 1 from public.produits where id in'),
    iR = txt.indexOf('perform 1 from public.produits_revient where produit_id in'), iLit = txt.indexOf('from public.produits_revient where produit_id = l.produit_id'),
    iLitH = txt.indexOf('select * into h from public.prix_revient_historique');
    return { iA, iP, iR, iLit, iLitH, ok: iA > 0 && iP > iA && iR > iP && (iLit < 0 || iLit > iR) && (iLitH < 0 || iLitH > iR) }; };
  test('verrous de la réception : arrivage → produits → produits_revient, AVANT la lecture de l\'ancien revient', ordre(val).ok && ordre(val).iLit > 0, ordre(val));
  test('verrous du recalcul : même ordre (produits puis produits_revient) avant toute lecture', ordre(rec).ok && ordre(rec).iLitH > 0, ordre(rec));
  // v7.5.147 : la réception verrouille aussi les LIGNES de l'arrivage (par id), juste après l'arrivage et avant les produits
  test('verrous triés (par id / par produit_id)', (val.match(/order by id for update/g) || []).length === 2 && (val.match(/order by produit_id for update/g) || []).length === 1
    && val.indexOf('perform 1 from public.arrivage_lignes where arrivage_id = a.id order by id for update;') > val.indexOf('from public.arrivages where id = p_arrivage_id for update')
    && val.indexOf('perform 1 from public.arrivage_lignes where arrivage_id = a.id order by id for update;') < val.indexOf('perform 1 from public.produits where id in')
    && (rec.match(/order by id for update/g) || []).length === 1 && (rec.match(/order by produit_id for update/g) || []).length === 1);
  test('aucune commande touchée (marges passées jamais recalculées)', !/update public\.commandes|alter table public\.commandes/.test(sql));

  console.log('\n8 ter. REVUE CODEX SUR 66def07 (identification par nom, revient calculé par la base, lignes complètes, catalogue JARVIS)');
  {
    // --- point 1 : ligne sans produitId fiable, au NOM (ou à la référence) d'un produit non vendable ---
    ({ bac } = nouveauBac());
    const R = (lignes, anc) => bac.venLignesRefusees(lignes, bac.produits, anc || null);
    test('nom exact d\'un produit non vendable, produitId vide : refusé', JSON.stringify(R([{ produitId: '', produit: 'Matelas Nouveau N (fictif)' }])) === JSON.stringify(['Matelas Nouveau N (fictif)']));
    test('nom à la casse / aux espaces près, produitId « _custom_… » : refusé', R([{ produitId: '_custom_123', produit: '  matelas  NOUVEAU n (FICTIF) ' }]).length === 1);
    test('ancien champ « nom » seul : refusé', R([{ nom: 'Matelas Retiré R' }]).length === 1 && R([{ nom: 'Matelas Retire R' }]).length === 1);
    test('référence interne (« _ugs » TikTok, « sku », ou le nom lui-même) : refusé', R([{ produit: 'Article TikTok', _ugs: 'mc-test-1' }]).length === 1 && R([{ sku: 'MC-TEST-1' }]).length === 1 && R([{ produit: 'MC-TEST-1' }]).length === 1);
    test('ensemble non vendable (composant sans prix) reconnu par son nom : refusé', R([{ produit: 'Ensemble Nouveau N + Sommier' }]).length === 1);
    test('nom d\'un produit VENDABLE sans produitId : accepté (comportement inchangé)', R([{ produit: 'Matelas Fictif A 140 x 190' }]).length === 0);
    test('nom inconnu (hors catalogue) : accepté', R([{ produitId: '_custom_9', produit: 'Article libre fictif' }]).length === 0);
    test('produitId d\'un produit vendable dont le nom est le sien : accepté', R([{ produitId: 'pr-a', produit: 'Matelas Fictif A 140×190' }]).length === 0);
    test('commande déjà prise qui le contenait par son seul nom : ligne figée, reste modifiable', R([{ produit: 'Matelas Retiré R' }], { lignes: [{ produitId: null, produit: 'matelas retiré r' }] }).length === 0);
    const pvN = await import('file:///' + path.join(racine, 'supabase', 'functions', '_shared', 'produits-vendables.ts').replace(/\\/g, '/'));
    const echant = ['  Matelas  Fictif ÉTÉ 140 × 190 x 25 ', 'Sommier 160X200', 'Ensemble Ça Va 90 x190', '', null, 'MC-TEST-1'];
    test('normalisation identique dans l\'appli (venNorm) et les fonctions serveur (nomNormalise)', echant.every(s => bac.venNorm(s) === pvN.nomNormalise(s)), echant.map(s => [bac.venNorm(s), pvN.nomNormalise(s)]));
    test('normalisation : même résultat attendu que l\'auto-contrôle SQL', bac.venNorm('  Matelas  Fictif ÉTÉ 140 × 190 x 25 ') === 'matelas fictif ete 140x190x25' && sql.includes("interne.l039_norm('  Matelas  Fictif ÉTÉ 140 × 190 x 25 ') is distinct from 'matelas fictif ete 140x190x25'"));
    const trig = sql.slice(sql.indexOf('create or replace function interne.commandes_produit_vendable_garde()'), sql.indexOf('create trigger commandes_produit_vendable_garde'));
    const ident = sql.slice(sql.indexOf('create or replace function interne.l039_lignes_identifiees'), sql.indexOf('revoke all on function interne.l039_lignes_identifiees'));
    const designe = sql.slice(sql.indexOf('create or replace function interne.l039_designe'), sql.indexOf('revoke all on function interne.l039_designe'));
    test('base : lignes identifiées (nom / référence) des DEUX côtés AVANT la recherche des produits non vendables',
      trig.indexOf('v_new := interne.l039_lignes_identifiees(v_new);') > 0 && trig.indexOf('v_old := interne.l039_lignes_identifiees(v_old);') > trig.indexOf('into v_old from public.commandes')
      && trig.indexOf('v_new := interne.l039_lignes_identifiees(v_new);') < trig.indexOf('select array_agg(distinct p.id) into v_nv'));
    test('base : produitId EXISTANT fiable ; sinon nom (produit / nom) ou référence (reference / sku / _ugs / nom) d\'un produit NON VENDABLE',
      ident.includes("where q.id = e ->> 'produitId' or interne.l039_designe(e, q.nom, q.reference_interne)")
      && designe.includes("interne.l039_norm(p_nom) in (interne.l039_norm(e ->> 'produit'), interne.l039_norm(e ->> 'nom'))")
      && ["'reference'", "'sku'", "'_ugs'"].every(k => designe.includes('interne.l039_norm(e ->> ' + k + ')')) && ident.includes("'nv', interne.produit_non_vendable(q.id)")
      && ident.includes('order by t.ord') && sql.includes('revoke all on function interne.l039_lignes_identifiees(jsonb) from public, anon, authenticated;'));
    test('base : normalisation SQL (minuscules, accents, ×, espaces, 140 x 190)', sql.includes("translate(lower(coalesce(p, '')), 'àâäáãåçéèêëíìîïñóòôöõúùûüýÿ×', 'aaaaaaceeeeiiiinooooouuuuyyx')")
      && sql.includes("'(\\d) ?x ?(\\d)', '\\1x\\2', 'g'"));

    // --- point 3 : revient du lot calculé (ou vérifié) par la base ---
    const val3 = sql.slice(sql.indexOf('create or replace function public.valider_reception_arrivage'), sql.indexOf('create or replace function public.recalculer_revient_arrivage'));
    test('base : taux et FOB obligatoires, frais répartis sur les quantités ATTENDUES', val3.includes("if a.taux_change is null then return json_build_object('ok', false, 'erreur', 'taux_manquant'); end if;")
      && val3.includes("if v_sans_fob > 0 then return json_build_object('ok', false, 'erreur', 'fob_manquant'); end if;") && val3.includes('v_frais_u := a.frais_import_ht / v_total_att;'));
    test('base : revient du lot CALCULÉ (FOB × taux + frais), revient chargé incohérent refusé AVANT toute écriture de la ligne',
      val3.includes('v_rev_lot := interne.l039_revient_lot(l.fob_unitaire, a.taux_change, v_frais_u);')
      && val3.indexOf('if not interne.l039_revient_coherent(l.revient_unitaire_ht, v_rev_lot) then') > val3.indexOf('v_rev_lot := interne.l039_revient_lot(')
      && val3.indexOf('REVIENT INCOHÉRENT') < val3.indexOf('update public.arrivage_lignes set quantite_recue'));
    test('base : c\'est le revient CALCULÉ qui valorise le stock, entre dans l\'historique et reste sur la ligne',
      val3.includes('interne.revient_apres(v_methode, v_stock_avant, v_rev_avant, v_rec, v_rev_lot)') && val3.includes('values (l.produit_id, v_rev_lot, v_rec, v_stock_avant,')
      && val3.includes('revient_unitaire_ht = v_rev_lot where id = l.id;') && !/revient_apres\([^)]*l\.revient_unitaire_ht/.test(val3) && !/values \(l\.produit_id, l\.revient_unitaire_ht/.test(val3));
    test('base : même formule que le recalcul au taux définitif (FOB × taux + frais par unité, 4 décimales)',
      sql.includes('select round(p_fob * p_taux + coalesce(p_frais_u, 0), 4)') && sql.includes('round(l.fob_unitaire * p_nouveau_taux + v_frais_u, 4)') && sql.includes('v_frais_u := a.frais_import_ht / v_total;'));
    test('base : tolérance d\'arrondi d\'un centime, revient absent rempli par la base', sql.includes('select p_charge is null or (p_calcule is not null and abs(p_charge - p_calcule) <= 0.01)'));
    const auto10 = sql.slice(sql.indexOf('-- 10. Auto-contrôle à l\'application : revient d\'un lot'));
    test('base : auto-contrôle EXÉCUTÉ à l\'application (valeurs fictives : calcul, arrondi, écart toléré / refusé, normalisation)',
      ['revient du lot', 'revient arrondi à 4 décimales', 'écart de 2 centimes refusé', 'revient contredisant FOB, taux et frais refusé', 'nom normalisé'].every(c => auto10.includes("f := '" + c + "'")) && auto10.includes('Migration annulée'));
    // modèle JS du même calcul (valeurs fictives), et l'aperçu de l'écran
    const aR = { id: 9, statut: 'en_attente', taux_change: 1.1, frais_import_ht: 30 };
    const lR = [{ id: 1, arrivage_id: 9, produit_id: 'pr-a', quantite_attendue: 1, fob_unitaire: 10, revient_unitaire_ht: 21 },
                { id: 2, arrivage_id: 9, produit_id: 'pr-b', quantite_attendue: 2, fob_unitaire: 20, revient_unitaire_ht: 5 }];
    test('appli : revient du lot = FOB × taux + frais / attendus (10 × 1,1 + 30 / 3 = 21)', bac.arrRevientCalcule(aR, lR, lR[0]) === 21 && bac.arrRevientCalcule(aR, lR, lR[1]) === 32);
    test('appli : taux absent → incalculable (la base refusera)', bac.arrRevientCalcule(Object.assign({}, aR, { taux_change: null }), lR, lR[0]) === null);
    const vR = bac.arrLignesValorisees(aR, lR);
    test('appli : l\'aperçu utilise le revient calculé ; revient chargé incohérent signalé', vR[0].revient_unitaire_ht === 21 && !vR[0].revient_ecart && vR[1].revient_unitaire_ht === 32 && vR[1].revient_ecart === true && lR[1].revient_unitaire_ht === 5);

    // --- point 4 : plus de lignes historiques que le plafond de la base ---
    const hist = []; for (let n = 1; n <= 2500; n++) hist.push({ id: n, arrivage_id: 100 + (n % 50), produit_id: 'pr-b', quantite_attendue: 1, quantite_recue: 1, revient_unitaire_ht: 1 });
    const recents = [{ id: 9001, arrivage_id: 7, produit_id: 'pr-a', quantite_attendue: 30, fob_unitaire: 10 }, { id: 9002, arrivage_id: 7, produit_id: 'pr-n', quantite_attendue: 40, fob_unitaire: 20 }];
    const arrivRec = Object.assign(arrivage('en_attente'), { taux_change: 1, frais_import_ht: 0 });
    let lignesBase = hist.concat(recents);
    for (const plafond of [1000, 300]) {
      B = nouveauBac({ repondre: (url) => url.includes('/rpc/valider_reception_arrivage') ? { ok: true, status: 200, corps: { ok: true, total_recu: 70 } }
        : url.includes('/arrivages?') ? { ok: true, status: 200, corps: paginer(url, [Object.assign({}, arrivRec)], plafond) }
        : url.includes('/arrivage_lignes?') ? { ok: true, status: 200, corps: paginer(url, lignesBase, plafond) } : { ok: true, status: 200, corps: [] } });
      await B.bac.arrCharger();
      test('plafond ' + plafond + ' : les 2 502 lignes sont lues (pages successives, ordre stable par id)', B.bac.ARR_ETAT.lignes.length === 2502 && B.appels.filter(a => a.url.includes('/arrivage_lignes?')).every(a => a.url.includes('order=id.asc')), B.bac.ARR_ETAT.lignes.length);
      test('plafond ' + plafond + ' : l\'arrivage récent est complet (2 lignes)', B.bac.arrLignesDe(7).length === 2);
      B.bac.arrOuvrir(7); await B.bac.arrValider();
      const rpc = B.appels.filter(a => a.url.includes('/rpc/valider_reception_arrivage'));
      test('plafond ' + plafond + ' : lignes de l\'arrivage relues PAR arrivage_id avant l\'envoi, réception envoyée complète',
        B.appels.some(a => a.url.includes('/arrivage_lignes?') && a.url.includes('arrivage_id=eq.7')) && rpc.length === 1 && rpc[0].body.p_lignes.length === 2, B.toasts);
    }
    // une ligne ajoutée à l'arrivage entre l'affichage et la validation : rien n'est envoyé, l'écran est rafraîchi
    B = nouveauBac({ repondre: (url) => url.includes('/rpc/') ? { ok: true, status: 200, corps: { ok: true } }
      : url.includes('/arrivage_lignes?') ? { ok: true, status: 200, corps: paginer(url, lignesArr().concat([{ id: 73, arrivage_id: 7, produit_id: 'pr-s', quantite_attendue: 5 }])) } : { ok: true, status: 200, corps: [] } });
    B.bac.ARR_ETAT.arrivages = [arrivage('en_attente')]; B.bac.ARR_ETAT.lignes = lignesArr(); B.bac.arrOuvrir(7); await B.bac.arrValider();
    test('lignes changées entre-temps : rien n\'est envoyé, lignes rechargées (3), message clair', !B.appels.some(a => a.url.includes('/rpc/')) && B.bac.arrLignesDe(7).length === 3 && B.toasts.some(t => /ont changé/.test(t.m)));
    B = nouveauBac({ repondre: (url) => url.includes('/arrivage_lignes?') ? { ok: false, status: 503, corps: {} } : { ok: true, status: 200, corps: { ok: true } } });
    B.bac.ARR_ETAT.arrivages = [arrivage('en_attente')]; B.bac.ARR_ETAT.lignes = lignesArr(); B.bac.arrOuvrir(7); await B.bac.arrValider();
    test('lignes illisibles au moment de valider : rien n\'est envoyé', !B.appels.some(a => a.url.includes('/rpc/')) && B.toasts.some(t => /illisibles/.test(t.m)) && B.bac.ARR_ETAT.envoi === false);
    test('écran : plus aucune lecture d\'arrivage_lignes sans pagination', !/fetch\(b \+ 'arrivage_lignes\?select=\*&order=id\.asc'/.test(html) && html.includes("arrLireTout(b + 'arrivage_lignes?select=*&order=id.asc')"));

    // --- point 2 : catalogue JARVIS complet ---
    const ja = fs.readFileSync(path.join(racine, 'supabase', 'functions', 'jarvis-action', 'index.ts'), 'utf8');
    test('JARVIS : catalogue lu par pages (catalogueJarvis / lireCatalogueComplet), plus de select unique plafonné',
      ja.includes('return await catalogueJarvis(') && /\.select\('\*'\)\.order\('id'\)\.range\(debut, fin\)/.test(ja) && /\.select\('\*'\)\.in\('id', ids\)/.test(ja)
      && !/sb\.from\('produits'\)\.select\('\*'\);/.test(ja) && (ja.match(/if \(!cat\) return catalogueIllisible\(\);/g) || []).length === 2);
  }

  console.log('\n8 quater. REVUE CODEX SUR 4ec0313 (produitId et nom contradictoires, pagination du catalogue serveur)');
  {
    // --- point 1 : identifiant d'un produit VENDABLE + nom (ou référence) d'un produit NON VENDABLE = contradiction refusée ---
    ({ bac } = nouveauBac());
    const R = (lignes, anc) => bac.venLignesRefusees(lignes, bac.produits, anc || null);
    const contra = { produitId: 'pr-a', produit: 'Matelas Nouveau N (fictif)', qte: 1, prixUnit: 100 };
    test('insertion : produitId vendable + nom d\'un produit non vendable → refusé', JSON.stringify(R([contra])) === JSON.stringify(['Matelas Nouveau N (fictif)']));
    test('insertion : nom contradictoire à la casse / aux espaces près → refusé', R([{ produitId: 'pr-a', produit: '  matelas nouveau n (FICTIF) ' }]).length === 1);
    test('insertion : produitId vendable + ancien champ « nom » d\'un produit retiré → refusé', R([{ produitId: 'pr-s', nom: 'Matelas Retire R' }]).length === 1);
    test('insertion : produitId vendable + référence (sku / _ugs) d\'un produit non vendable → refusé', R([{ produitId: 'pr-a', produit: 'Article fictif', sku: 'MC-TEST-1' }]).length === 1 && R([{ produitId: 'pr-a', _ugs: 'mc-test-1' }]).length === 1);
    test('insertion : produitId vendable + nom d\'un ENSEMBLE non vendable → refusé', R([{ produitId: 'pr-e1', produit: 'Ensemble Nouveau N + Sommier' }]).length === 1);
    test('nom et identifiant désignant le MÊME produit vendable : accepté (aussi à la casse / au « x » près)', R([{ produitId: 'pr-a', produit: 'Matelas Fictif A 140×190' }, { produitId: 'pr-a', produit: 'matelas fictif a 140 x 190' }]).length === 0);
    test('produitId vendable sans nom ni référence : accepté (inchangé)', R([{ produitId: 'pr-a', qte: 1 }]).length === 0);
    test('produitId vendable + libellé libre (aucun produit non vendable désigné) : accepté (inchangé)', R([{ produitId: 'pr-a', produit: 'Matelas A (livraison 2e étage)' }]).length === 0);
    test('produitId d\'un produit NON vendable à son nom : toujours refusé', R([{ produitId: 'pr-n', produit: 'Matelas Nouveau N (fictif)' }]).length === 1);
    test('upsert d\'une commande déjà prise : ligne contradictoire INCHANGÉE → reste modifiable', R([contra, { produitId: 'pr-s', produit: 'Sommier Fictif 140×190' }], { lignes: [contra] }).length === 0);
    test('upsert d\'une commande déjà prise : ligne contradictoire AJOUTÉE → refusée', R([{ produitId: 'pr-a', produit: 'Matelas Fictif A 140×190' }, contra], { lignes: [{ produitId: 'pr-a', produit: 'Matelas Fictif A 140×190' }] }).length === 1);
    test('upsert : ligne vendable réécrite avec le nom d\'un produit non vendable → refusée', R([contra], { lignes: [{ produitId: 'pr-a', produit: 'Matelas Fictif A 140×190', qte: 1, prixUnit: 100 }] }).length === 1);
    test('appli : venDesigne (nom, référence, rien à comparer)', bac.venDesigne({ produit: 'matelas fictif a 140 x 190' }, bac.produits[0]) === true && bac.venDesigne({ produit: 'Autre' }, bac.produits[0]) === false
      && bac.venDesigne({ _ugs: 'mc-test-1' }, bac.produits[2]) === true && bac.venDesigne({ produitId: 'pr-a' }, bac.produits[0]) === false);
    // même règle dans la base : identifiant gardé seulement s'il est DÉSIGNÉ par la ligne, sinon produit non vendable désigné
    const identQ = sql.slice(sql.indexOf('create or replace function interne.l039_lignes_identifiees'), sql.indexOf('revoke all on function interne.l039_lignes_identifiees'));
    const trigQ = sql.slice(sql.indexOf('create or replace function interne.commandes_produit_vendable_garde()'), sql.indexOf('create trigger commandes_produit_vendable_garde'));
    // v7.5.147 (revue sur 17f631a) : décision déplacée dans la fonction PURE l039_ligne_identifiee (tous les champs examinés)
    const ligneQ = sql.slice(sql.indexOf('create or replace function interne.l039_ligne_identifiee'), sql.indexOf('revoke all on function interne.l039_ligne_identifiee'));
    test('base : produitId existant gardé SEULEMENT si la ligne le désigne (l039_designe), plus de « existe = fiable »',
      identQ.includes("'designe', interne.l039_designe(e, q.nom, q.reference_interne)") && ligneQ.includes("c ->> 'id' = e ->> 'produitId'")
      && ligneQ.includes("coalesce((c ->> 'designe')::boolean, false)") && !identQ.includes("where q.id = e ->> 'produitId') then e"));
    test('base : sinon produit NON VENDABLE désigné par nom ou référence (même fonction l039_designe)', identQ.includes("'nv', interne.produit_non_vendable(q.id)")
      && /where coalesce\(\(c ->> 'designe'\)::boolean, false\) and coalesce\(\(c ->> 'nv'\)::boolean, false\)\n\s+order by c ->> 'id' limit 1/.test(ligneQ));
    test('base : l039_designe pure (immutable), jamais NULL, accès retiré', sql.includes('create or replace function interne.l039_designe(e jsonb, p_nom text, p_ref text) returns boolean\nlanguage sql immutable as $')
      && sql.includes('revoke all on function interne.l039_designe(jsonb, text, text) from public, anon, authenticated;'));
    test('base : insertion ET upsert passent par la même identification (déclencheur before insert or update, lignes actuelles relues)',
      sql.includes('create trigger commandes_produit_vendable_garde before insert or update of lignes, produit, qte, prix, remise_globale, remise_globale_val, remise_globale_type on public.commandes')
      && trigQ.includes('select interne.l039_lignes_effectives(to_jsonb(c.lignes), c.produit::text, to_jsonb(c.qte), to_jsonb(c.prix)),\n           interne.l039_remise_signature(to_jsonb(c.remise_globale_val), c.remise_globale_type::text, to_jsonb(c.remise_globale))\n      into v_old, v_old_remise\n      from public.commandes c where c.id = new.id;') && trigQ.includes('v_new := interne.l039_lignes_identifiees(v_new);') && trigQ.includes('v_old := interne.l039_lignes_identifiees(v_old);'));
    const auto10q = sql.slice(sql.indexOf('-- 10. Auto-contrôle à l\'application : revient d\'un lot'));
    test('base : auto-contrôle EXÉCUTÉ (désignation par nom, autre produit, référence, ligne sans nom, valeurs vides)',
      ["nom désignant le produit de l''identifiant", 'nom désignant un autre produit', 'référence désignant le produit', 'ligne sans nom ni référence', 'nom et référence vides'].every(c => auto10q.includes("f := '" + c + "'")));
    // JARVIS (création de commande) : même contradiction refusée
    const jlQ = await import('file:///' + path.join(racine, 'supabase', 'functions', '_shared', 'jarvis-action-logique.ts').replace(/\\/g, '/'));
    const catQ = jlQ.catalogueDepuisBase([{ id: 'n', nom: 'Matelas Nouveau N (fictif)', prix: null, vendable: false, prix_vente_defini: false }, { id: 'a', nom: 'Matelas Fictif A 140×190', prix: 100 }]);
    test('JARVIS : produitId vendable + nom d\'un produit non vendable → refusé', /pas encore vendable/.test(jlQ.lignesCommande([{ produitId: 'a', produit: 'matelas nouveau n (fictif)', qte: 1 }], catQ).erreur || ''));
    test('JARVIS : produitId vendable + son propre nom (ou un libellé libre) → accepté', !jlQ.lignesCommande([{ produitId: 'a', produit: 'Matelas Fictif A 140 x 190', qte: 1 }], catQ).erreur
      && !jlQ.lignesCommande([{ produitId: 'a', produit: 'Matelas A', qte: 1 }], catQ).erreur);

    // --- point 2 : pagination du catalogue serveur avec un plafond de la base INFÉRIEUR à la page demandée ---
    const pvQ = await import('file:///' + path.join(racine, 'supabase', 'functions', '_shared', 'produits-vendables.ts').replace(/\\/g, '/'));
    const tous = []; for (let n = 0; n < 1499; n++) tous.push({ id: 'p' + String(n).padStart(4, '0'), nom: 'Fictif ' + n, actif: true });
    tous.push({ id: 'p9999-ens', nom: 'Ensemble fictif', actif: true, composants: [{ id: 'p0001', qte: 1 }, { id: 'p1498', qte: 1 }] });
    tous[1498].vendable = false; tous[1498].prix_vente_defini = false; // composant non vendable en DERNIÈRE page
    for (const plafond of [300, 1000, 7]) {
      const pages = [];
      const lus = await pvQ.lireCatalogueComplet(async (d, f) => { pages.push([d, f]); return tous.slice(d, Math.min(f + 1, d + plafond)); }, async () => []);
      const continu = pages.every((pg, i) => pg[0] === Math.min(i * plafond, tous.length));
      test('plafond ' + plafond + ' (page demandée 1 000) : les 1 500 produits lus, avance du nombre reçu, arrêt sur page vide',
        lus.length === 1500 && new Set(lus.map(r => r.id)).size === 1500 && continu && pages.length === Math.ceil(1500 / plafond) + 1, { lus: lus.length, pages: pages.length });
      test('plafond ' + plafond + ' : l\'ensemble dont le composant (dernière page) est non vendable est écarté', !pvQ.produitsVendables(lus).some(r => r.id === 'p9999-ens'));
    }
    const src = fs.readFileSync(path.join(racine, 'supabase', 'functions', '_shared', 'produits-vendables.ts'), 'utf8');
    test('serveur : plus d\'arrêt sur une page « incomplète » (page.length < taillePage)', !/page\.length < taillePage/.test(src) && src.includes('if (!page.length) break;') && src.includes('const debut = rows.length;'));
  }

  console.log('\n8 quinquies. REVUE CODEX SUR 17f631a (tous les champs d\'une ligne examinés, valorisation revérifiée avant la validation)');
  {
    // --- point 1 : identifiant ET nom d'un produit vendable, mais sku / référence / _ugs / ancien « nom » d'un produit NON VENDABLE ---
    ({ bac } = nouveauBac());
    const R = (lignes, anc) => bac.venLignesRefusees(lignes, bac.produits, anc || null);
    const contraSku = { produitId: 'pr-a', produit: 'Matelas Fictif A 140×190', sku: 'MC-TEST-1', qte: 1, prixUnit: 100 };
    test('appli : identifiant + nom vendables, sku d\'un produit non vendable → refusé', JSON.stringify(R([contraSku])) === JSON.stringify(['Matelas Nouveau N (fictif)']), R([contraSku]));
    test('appli : identifiant + nom vendables, référence / _ugs d\'un produit non vendable → refusé', R([{ produitId: 'pr-a', produit: 'Matelas Fictif A 140×190', reference: 'mc-test-1' }]).length === 1
      && R([{ produitId: 'pr-a', produit: 'Matelas Fictif A 140×190', _ugs: ' MC-TEST-1 ' }]).length === 1);
    test('appli : identifiant + nom vendables, ancien champ « nom » d\'un produit retiré → refusé', R([{ produitId: 'pr-a', produit: 'Matelas Fictif A 140×190', nom: 'Matelas Retiré R' }]).length === 1);
    test('appli : venProduitDeLigne rapporte la ligne au produit non vendable', (bac.venProduitDeLigne(contraSku, bac.produits) || {}).id === 'pr-n');
    test('appli : identifiant + nom vendables, aucun autre champ contradictoire → accepté (inchangé)', R([{ produitId: 'pr-a', produit: 'Matelas Fictif A 140×190', sku: 'AUTRE-SKU' }]).length === 0
      && (bac.venProduitDeLigne({ produitId: 'pr-a', produit: 'Matelas Fictif A 140×190' }, bac.produits) || {}).id === 'pr-a');
    test('appli : commande déjà prise avec cette ligne INCHANGÉE → reste modifiable', R([contraSku, { produitId: 'pr-s', produit: 'Sommier Fictif 140×190' }], { lignes: [contraSku] }).length === 0);
    const auto10 = sql.slice(sql.indexOf('-- 10. Auto-contrôle à l\'application : revient d\'un lot'));
    test('base : auto-contrôle EXÉCUTÉ de la décision pure (sku contradictoire, rien de non vendable, identifiant non vendable gardé, nom seul, ligne libre)',
      ["identifiant et nom vendables, sku d''un produit non vendable", 'identifiant et nom vendables, rien de non vendable', 'identifiant non vendable désigné gardé', "nom seul d''un produit non vendable", 'ligne libre inchangée'].every(c => auto10.includes("f := '" + c + "'")));
    test('base : l039_ligne_identifiee pure (immutable), accès retiré', sql.includes('create or replace function interne.l039_ligne_identifiee(e jsonb, p_cands jsonb) returns jsonb\nlanguage sql immutable as $')
      && sql.includes('revoke all on function interne.l039_ligne_identifiee(jsonb, jsonb) from public, anon, authenticated;'));
    // JARVIS : le texte dicté est la seule donnée de la ligne ; nom d'un vendable + référence interne d'un non vendable = refusé
    const jl5 = await import('file:///' + path.join(racine, 'supabase', 'functions', '_shared', 'jarvis-action-logique.ts').replace(/\\/g, '/'));
    const cat5 = jl5.catalogueDepuisBase([{ id: 'n', nom: 'Matelas Nouveau N (fictif)', prix: null, vendable: false, prix_vente_defini: false, reference_interne: 'MC-TEST-1' },
      { id: 'a', nom: 'Matelas Fictif A 140×190', prix: 100, reference_interne: 'MC-A' }]);
    test('JARVIS : référence interne du produit reprise dans le catalogue', cat5.get('n').ref === 'MC-TEST-1');
    test('JARVIS : identifiant vendable + texte = référence d\'un produit non vendable → refusé', /pas encore vendable/.test(jl5.lignesCommande([{ produitId: 'a', produit: 'mc-test-1', qte: 1 }], cat5).erreur || ''));
    test('JARVIS : sans identifiant, texte = référence d\'un produit non vendable → refusé', /pas encore vendable/.test(jl5.lignesCommande([{ produit: 'MC-TEST-1', qte: 1 }], cat5).erreur || ''));
    test('JARVIS : identifiant + nom vendables → accepté (inchangé)', !jl5.lignesCommande([{ produitId: 'a', produit: 'Matelas Fictif A 140×190', qte: 1 }], cat5).erreur);

    // --- point 2 : valorisation revérifiée entre l'aperçu et la validation ---
    const arrV = () => Object.assign(arrivage('en_attente'), { taux_change: 1.1, frais_import_ht: 30, taux_provisoire: true });
    const lignesV = () => [{ id: 72, arrivage_id: 7, produit_id: 'pr-n', quantite_attendue: 40, fob_unitaire: 20, revient_unitaire_ht: null },
      { id: 71, arrivage_id: 7, produit_id: 'pr-a', quantite_attendue: 30, fob_unitaire: 10.5, revient_unitaire_ht: 12.25 }];
    // v7.5.150 : empreinte v2, stock des produits du catalogue fictif (pr-a : 10, pr-n : 0)
    const emp = (a, l, r, m, st) => bac.arrEmpreinte(a, l, r, m, st || null, bac.produits);
    const revV = { 'pr-a': { produit_id: 'pr-a', prix_revient_ht: 40, provisoire: false } };
    test('empreinte : MÊME texte que l\'auto-contrôle SQL (interne.l039_empreinte)', emp(arrV(), lignesV(), revV, 'CUMP') === 'v2|CUMP|1.100000|30.00|t|71:pr-a:30:10.5000:12.2500:40.0000:f:10|72:pr-n:40:20.0000::::0'
      && auto10.includes("is distinct from 'v2|CUMP|1.100000|30.00|t|71:pr-a:30:10.5000:12.2500:40.0000:f:10|72:pr-n:40:20.0000::::0'"), emp(arrV(), lignesV(), revV, 'CUMP'));
    test('empreinte : nombres reçus en texte ou en nombre → même empreinte (échelle fixe)', emp(Object.assign(arrV(), { taux_change: '1.100000', frais_import_ht: '30.00' }), lignesV(), revV, 'CUMP') === emp(arrV(), lignesV(), revV, 'CUMP'));
    const base0 = emp(arrV(), lignesV(), revV, 'CUMP');
    const varie = [['FOB', arrV(), lignesV().map(l => l.id === 71 ? Object.assign(l, { fob_unitaire: 10.6 }) : l), revV, 'CUMP'],
      ['taux', Object.assign(arrV(), { taux_change: 1.12 }), lignesV(), revV, 'CUMP'], ['frais', Object.assign(arrV(), { frais_import_ht: 31 }), lignesV(), revV, 'CUMP'],
      ['taux provisoire', Object.assign(arrV(), { taux_provisoire: false }), lignesV(), revV, 'CUMP'],
      ['quantité attendue', arrV(), lignesV().map(l => l.id === 72 ? Object.assign(l, { quantite_attendue: 41 }) : l), revV, 'CUMP'],
      ['revient chargé', arrV(), lignesV().map(l => l.id === 72 ? Object.assign(l, { revient_unitaire_ht: 22 }) : l), revV, 'CUMP'],
      ['revient actuel du produit', arrV(), lignesV(), { 'pr-a': { prix_revient_ht: 41, provisoire: false } }, 'CUMP'],
      ['revient actuel devenu provisoire', arrV(), lignesV(), { 'pr-a': { prix_revient_ht: 40, provisoire: true } }, 'CUMP'],
      ['méthode', arrV(), lignesV(), revV, 'DERNIER_PRIX']];
    test('empreinte : FOB, taux, frais, taux provisoire, quantités, revient chargé, revient actuel, méthode → empreinte différente',
      varie.every(v => emp(v[1], v[2], v[3], v[4]) !== base0), varie.filter(v => emp(v[1], v[2], v[3], v[4]) === base0).map(v => v[0]));
    test('empreinte : ordre des lignes sans effet', emp(arrV(), lignesV().reverse(), revV, 'CUMP') === base0);
    // écran : l'empreinte de l'aperçu affiché est envoyée à la base
    const repV = (opts) => (url) => url.includes('/rpc/valider_reception_arrivage') ? { ok: true, status: 200, corps: (opts && opts.rpc) || { ok: true, total_recu: 70 } }
      : url.includes('/arrivage_lignes?') ? { ok: true, status: 200, corps: paginer(url, (opts && opts.lignes) || lignesV()) }
      : url.includes('/produits_revient?') ? { ok: true, status: 200, corps: paginer(url, (opts && opts.revients) || Object.values(revV)) } : { ok: true, status: 200, corps: [] };
    const ouvrirV = (B) => { B.bac.ARR_ETAT.arrivages = [arrV()]; B.bac.ARR_ETAT.lignes = lignesV(); B.bac.ARR_ETAT.revients = JSON.parse(JSON.stringify(revV)); B.bac.arrOuvrir(7); };
    B = nouveauBac({ repondre: repV() }); ouvrirV(B); await B.bac.arrValider();
    let rpc = B.appels.filter(a => a.url.includes('/rpc/valider_reception_arrivage'));
    test('validation : l\'empreinte de l\'aperçu affiché est envoyée (p_empreinte)', rpc.length === 1 && rpc[0].body.p_empreinte === base0, rpc[0] && rpc[0].body.p_empreinte);
    // FOB modifié dans la base entre l'aperçu et la validation : rien n'est envoyé, saisies gardées, nouvel aperçu, nouvelle confirmation
    let nbConfirm = 0;
    B = nouveauBac({ repondre: repV({ lignes: lignesV().map(l => l.id === 71 ? Object.assign(l, { fob_unitaire: 11 }) : l) }) });
    B.bac.confirm = () => { nbConfirm++; return true; };
    ouvrirV(B); B.bac.arrSaisie(71, 'recue', '29'); B.bac.arrSaisie(71, 'manquante', '1'); await B.bac.arrValider();
    test('FOB modifié avant l\'envoi : rien n\'est envoyé, message clair, saisies gardées, nouvel aperçu (FOB relu)',
      !B.appels.some(a => a.url.includes('/rpc/')) && B.toasts.some(t => /FOB ou revient de l'arrivage modifié/.test(t.m)) && String(B.bac.ARR_ETAT.saisies[71].recue) === '29'
      && B.bac.arrLignesDe(7).find(l => l.id === 71).fob_unitaire === 11 && B.bac.ARR_ETAT.vue.empreinte !== base0 && B.bac.ARR_ETAT.envoi === false, B.toasts);
    const vue2 = B.bac.ARR_ETAT.vue.empreinte;
    await B.bac.arrValider();
    rpc = B.appels.filter(a => a.url.includes('/rpc/valider_reception_arrivage'));
    test('… puis nouvelle validation : NOUVELLE confirmation demandée, empreinte du nouvel aperçu envoyée', nbConfirm === 2 && rpc.length === 1 && rpc[0].body.p_empreinte === vue2 && vue2 !== base0 && vue2.includes(':11.0000:'), { nbConfirm, n: rpc.length });
    // taux / frais / revient actuel changés dans la base : la base refuse (valorisation_modifiee), l'écran relit tout et redemande
    B = nouveauBac({ repondre: (url) => url.includes('/rpc/') ? { ok: true, status: 200, corps: { ok: false, erreur: 'valorisation_modifiee' } }
      : url.includes('/arrivages?') ? { ok: true, status: 200, corps: paginer(url, [Object.assign(arrV(), { taux_change: 1.2 })]) }
      : url.includes('/arrivage_lignes?') ? { ok: true, status: 200, corps: paginer(url, lignesV()) }
      : url.includes('/produits_revient?') ? { ok: true, status: 200, corps: [revV['pr-a']] } : { ok: true, status: 200, corps: [] } });
    ouvrirV(B); B.bac.arrSaisie(71, 'recue', '29'); B.bac.arrSaisie(71, 'manquante', '1'); await B.bac.arrValider();
    test('base : « valorisation_modifiee » → message clair, données relues (taux 1,2), nouvel aperçu, saisies gardées',
      B.toasts.some(t => /taux, frais, FOB, revient ou stock modifiés depuis l'aperçu/.test(t.m)) && B.bac.ARR_ETAT.arrivages[0].taux_change === 1.2
      && B.bac.ARR_ETAT.vue && B.bac.ARR_ETAT.vue.empreinte !== base0 && String(B.bac.ARR_ETAT.saisies[71].recue) === '29' && B.bac.ARR_ETAT.envoi === false, B.toasts);
    // valeurs changées en mémoire sans nouvel affichage (ex. revients rechargés par l'inventaire) : aucun envoi, aperçu refait
    B = nouveauBac({ repondre: repV() }); ouvrirV(B); B.bac.ARR_ETAT.revients['pr-a'].prix_revient_ht = 45; await B.bac.arrValider();
    test('revient changé en mémoire après l\'affichage : rien n\'est envoyé, aperçu refait', !B.appels.some(a => a.url.includes('/rpc/') || a.url.includes('/arrivage_lignes?')) && B.toasts.some(t => /Aperçu actualisé/.test(t.m)));
    // base : empreinte obligatoire, comparée APRÈS les verrous et AVANT toute écriture
    const valE = sql.slice(sql.indexOf('create or replace function public.valider_reception_arrivage'), sql.indexOf('create or replace function public.recalculer_revient_arrivage'));
    const iCmp = valE.indexOf('if p_empreinte is distinct from interne.l039_empreinte_valorisation(a.id, v_methode) then');
    test('base : empreinte obligatoire (empreinte_requise), signature à 3 arguments, ancienne signature supprimée',
      valE.includes('valider_reception_arrivage(p_arrivage_id bigint, p_lignes jsonb, p_empreinte text) returns json') && valE.includes("if coalesce(p_empreinte, '') = '' then return json_build_object('ok', false, 'erreur', 'empreinte_requise'); end if;")
      && sql.includes('drop function if exists public.valider_reception_arrivage(bigint, jsonb);') && sql.includes('grant execute on function public.valider_reception_arrivage(bigint, jsonb, text) to anon;')
      && !/valider_reception_arrivage\(bigint, jsonb\) (to|from)/.test(sql));
    test('base : empreinte comparée APRÈS les verrous produits / produits_revient et AVANT le numéro d\'ordre et toute écriture',
      iCmp > valE.indexOf('perform 1 from public.produits_revient where produit_id in') && iCmp < valE.indexOf('v_ordre := nextval(') && iCmp < valE.indexOf('update public.') && valE.includes("'erreur', 'valorisation_modifiee'"));
    const empF = sql.slice(sql.indexOf('create or replace function interne.l039_empreinte_valorisation'), sql.indexOf('revoke all on function interne.l039_fmt'));
    test('base : empreinte lue dans arrivages, arrivage_lignes et produits_revient (taux, frais, provisoire, FOB, revient chargé, revient actuel)',
      ['a.taux_change', 'a.frais_import_ht', 'a.taux_provisoire', "'fob_unitaire', l.fob_unitaire", "'revient_unitaire_ht', l.revient_unitaire_ht", "'revient_avant', r.prix_revient_ht", "'revient_avant_provisoire', r.provisoire", "'quantite_attendue', l.quantite_attendue"].every(k => empF.includes(k)));
    test('base : auto-contrôle EXÉCUTÉ de l\'empreinte (texte attendu, taux et frais changés, échelle fixe)', ['empreinte de valorisation', 'empreinte : taux changé', 'empreinte : frais changés', 'nombre à échelle fixe'].every(c => auto10.includes("f := '" + c + "'")));
  }

  console.log('\n8 sexies. REVUE CODEX SUR fd751b8 (état de vente, stock dans l\'empreinte, lignes figées, catalogue complet, saisies figées, revients paginés)');
  {
    const sqlS = sql;
    const auto10 = sqlS.slice(sqlS.indexOf('-- 10. Auto-contrôle à l\'application : revient d\'un lot'));
    const pvS = await import('file:///' + path.join(racine, 'supabase', 'functions', '_shared', 'produits-vendables.ts').replace(/\\/g, '/'));
    let { bac } = nouveauBac();
    // --- 1. prix NULL + « prix défini » interdit (insertion ET modification), prix NULL = non vendable partout ---
    test('base : contraintes « prix défini ⇒ prix renseigné » et « vendable ⇒ prix défini » (insertion et modification)',
      sqlS.includes('add constraint produits_prix_defini_non_null check (not prix_vente_defini or prix is not null);')
      && sqlS.includes('add constraint produits_vendable_prix_defini check (not vendable or prix_vente_defini);'));
    const garde = sqlS.slice(sqlS.indexOf('create or replace function interne.produits_vente_garde()'), sqlS.indexOf('create trigger produits_vente_garde'));
    test('base : déclencheur produits_vente_garde — décision PURE l039_etat_vente_refus (insertion et modification), message « prix NULL »',
      garde.includes('v_refus := interne.l039_etat_vente_refus(tg_op,') && garde.includes("if v_refus = 'prix_null' then") && garde.includes('sans prix (NULL) : refusé')
      && sqlS.includes('revoke all on function interne.l039_etat_vente_refus(text, boolean, boolean, boolean, numeric) from public, anon, authenticated;'));
    test('base : auto-contrôle EXÉCUTÉ de l\'état de vente (insertion et modification, prix NULL, 0, prix fixé, retrait)',
      ['insertion prix défini sans prix', 'modification prix retiré, prix défini', 'modification non vendable, prix défini sans prix', 'modification prix défini sans prix',
       'modification prix défini à 0', 'insertion vendable sans prix défini', "ligne à prix 0 et prix défini non refusée (upsert d''un produit existant ; une vraie création passe d''abord « à définir »)", 'prix fixé (> 0) accepté', 'retrait de la vente accepté'].every(c => auto10.includes("f := '" + c + "'")));
    test('base : upsert de l\'application (sbSaveProduit) d\'un produit « à définir » existant : état de vente actuel repris AVANT les contraintes',
      garde.indexOf("select p.prix_vente_defini, p.vendable, p.prix into v_ex from public.produits p where p.id = new.id;") < garde.indexOf("if tg_op = 'INSERT' and r is not null and r <> 'admin' then")
      && garde.includes('v_existe := found;')
      && garde.includes("if tg_op = 'INSERT' and v_existe and v_ex.prix_vente_defini = false then")
      && garde.includes('new.prix_vente_defini := false; new.vendable := v_ex.vendable; new.prix := v_ex.prix;')
      && garde.indexOf('new.prix := v_ex.prix;') < garde.indexOf('v_refus := interne.l039_etat_vente_refus('));
    // --- 1 bis. CRÉATION (revue Codex PR 26 sur a0c1bf8, puis DÉCISION DE BORHEN du 26/11 « A ») : seul l'administrateur rend vendable ---
    test('base : vraie création (aucun produit de cet identifiant) contrôlée par la décision PURE l039_creation_etat, tous rôles',
      garde.includes("if tg_op = 'INSERT' and not v_existe then") && garde.includes("v_creation := interne.l039_creation_etat(r is null or r = 'admin', new.prix);")
      && garde.includes("if v_creation = 'a_definir' then\n      new.prix := null; new.prix_vente_defini := false; new.vendable := false;")
      && !garde.includes('homonyme') && !garde.includes("v_creation = 'vendable'")
      && garde.indexOf("if tg_op = 'INSERT' and not v_existe then") < garde.indexOf('v_refus := interne.l039_etat_vente_refus(')
      && !/if tg_op = 'INSERT' and r is not null and r <> 'admin' then[\s\S]{0,200}\n    new\.vendable := true; new\.prix_vente_defini := true;/.test(garde)
      && sqlS.includes('revoke all on function interne.l039_creation_etat(boolean, numeric) from public, anon, authenticated;'));
    const creF = sqlS.slice(sqlS.indexOf('create or replace function interne.l039_creation_etat'), sqlS.indexOf('revoke all on function interne.l039_creation_etat'));
    test('base : décision du 26/11 — hors administrateur, création TOUJOURS « à définir » (prix saisi ou non)',
      creF.includes("when p_admin is not true then 'a_definir'") && creF.indexOf("when p_admin is not true then 'a_definir'") < creF.indexOf("when coalesce(p_prix, 0) <= 0 then 'a_definir'")
      && !creF.includes("'vendable'") && sqlS.includes("DÉCISION DE BORHEN du 26/11/2026 (réponse « A »"));
    test('base : auto-contrôle EXÉCUTÉ de la création (collaboratrice avec prix > 0, prix 0, sans prix, négatif, rôle inconnu, administrateur)',
      ['création collaboratrice avec prix > 0 : à définir', 'création collaboratrice à prix 0 : à définir', 'création collaboratrice sans prix : à définir', 'création à prix négatif : à définir',
       'création sans rôle connu avec prix : à définir', 'création administrateur à prix 0 : à définir', 'création administrateur avec prix : état proposé'].every(c => auto10.includes("f := '" + c + "'"))
      && auto10.includes("interne.l039_creation_etat(false, 199) is distinct from 'a_definir'") && auto10.includes('interne.l039_creation_etat(true, 199) is not null'));
    // modification qui rendrait vendable un produit non vendable (composition d'un ensemble comprise) : refusée hors administrateur
    test('base : modification hors administrateur qui rendrait vendable un produit non vendable REFUSÉE (décision PURE + auto-contrôle)',
      garde.includes("if tg_op = 'UPDATE' and interne.l039_rend_vendable_refuse(r is null or r = 'admin', interne.produit_non_vendable(old.id),")
      && garde.includes('interne.l039_composants_non_vendables(new.composants)') && garde.includes("seul l''administrateur le rend vendable (modification refusée)")
      && sqlS.includes('select p_admin is not true and p_ancien_non_vendable is true and p_nouveau_non_vendable is false')
      && ['collaboratrice rend vendable un produit non vendable : refusé', 'administrateur rend vendable : accepté', 'collaboratrice, produit qui reste non vendable : accepté',
          'collaboratrice, produit déjà vendable : accepté', 'collaboratrice, produit qui devient non vendable : accepté'].every(c => auto10.includes("f := '" + c + "'")));
    const cnvF = sqlS.slice(sqlS.indexOf('create or replace function interne.l039_composants_non_vendables'), sqlS.indexOf('revoke all on function interne.l039_composants_non_vendables'));
    test('base : composition non vendable = même règle que produit_non_vendable (composant introuvable compris)',
      cnvF.includes('left join public.produits q on q.id = c ->> \'id\'') && cnvF.includes('q.id is null or not q.vendable or not q.prix_vente_defini or q.prix is null'));
    const catC = [{ id: 'pr-n', nom: 'Matelas Nouveau N (fictif)', prixDefini: false, vendable: false }, { id: 'pr-a', nom: 'Matelas Fictif A 140×190', prix: 100 }];
    test('appli : venCreationEtat = même décision que la base (collaboratrice avec / sans prix, négatif, administrateur)',
      bac.venCreationEtat(false, 199) === 'a_definir' && bac.venCreationEtat(false, 0) === 'a_definir' && bac.venCreationEtat(false, '') === 'a_definir'
      && bac.venCreationEtat(true, -1) === 'a_definir' && bac.venCreationEtat(true, 0) === 'a_definir' && bac.venCreationEtat(true, 199) === null);
    // sauvegarderProduit (création) exécuté
    const bacC = (r, prix, nom) => { const B = nouveauBac({ role: r }); B.bac.produits = catC.map(x => Object.assign({}, x));
      Object.assign(B.bac, { editProduitId: null, closeModal() {}, VEN_LIBELLE: 'Prix à définir — non vendable', venDefinirPrix() {} });
      vm.runInContext(extraireFonction('async function sbSaveProduit(p)'), B.bac); vm.runInContext(extraireFonction('function sauvegarderProduit()'), B.bac);
      const d = B.bac.document.getElementById; d('p-nom').value = nom; d('p-prix').value = prix; d('p-cat').value = 'Matelas'; B.bac.sauvegarderProduit(); return B; };
    const envoi = (B) => B.appels.find(a => a.methode === 'POST' && a.url.includes('/rest/v1/produits'));
    const aDefinir = (B, nom) => B.bac.produits.some(p => p.nom === nom && p.prixDefini === false && p.vendable === false);
    const msgCollab = (B) => B.toasts.some(t => t.t === 'ok' && t.m.includes('Produit créé, le prix sera fixé par l\'administrateur'));
    let BC = bacC('collab', '199', 'Sommier Fictif S'); await new Promise(r => setTimeout(r, 0));
    test('appli : collaboratrice AVEC un prix > 0 ⇒ produit créé « à définir », non vendable, prix NULL envoyé, message clair',
      !!envoi(BC) && envoi(BC).body.prix === null && aDefinir(BC, 'Sommier Fictif S') && msgCollab(BC), envoi(BC) && envoi(BC).body);
    BC = bacC('collab', '', 'Matelas Nouveau Z (fictif)'); await new Promise(r => setTimeout(r, 0));
    test('appli : collaboratrice SANS prix ⇒ produit créé « à définir », non vendable, prix NULL envoyé, message clair',
      !!envoi(BC) && envoi(BC).body.prix === null && aDefinir(BC, 'Matelas Nouveau Z (fictif)') && msgCollab(BC), envoi(BC) && envoi(BC).body);
    BC = bacC('collab', '199', '  matelas  nouveau n (FICTIF) '); await new Promise(r => setTimeout(r, 0));
    test('appli : collaboratrice, HOMONYME d\'une référence en attente avec un prix ⇒ créé « à définir » lui aussi (rien de vendable, aucun refus)',
      !!envoi(BC) && envoi(BC).body.prix === null && BC.bac.produits.length === 3 && BC.bac.produits.every(p => p.id === 'pr-a' || (p.prixDefini === false && p.vendable === false))
      && msgCollab(BC) && !BC.toasts.some(t => t.t === 'err'), BC.toasts);
    BC = bacC('livreur', '199', 'Oreiller Fictif O'); await new Promise(r => setTimeout(r, 0));
    test('appli : livreur avec un prix ⇒ « à définir » (seul l\'administrateur rend vendable)', !!envoi(BC) && envoi(BC).body.prix === null && aDefinir(BC, 'Oreiller Fictif O'));
    BC = bacC('admin', '199', 'Sommier Fictif S'); await new Promise(r => setTimeout(r, 0));
    test('appli : administrateur AVEC un prix ⇒ flux inchangé (vendable, prix envoyé)', !!envoi(BC) && envoi(BC).body.prix === 199
      && BC.bac.produits.some(p => p.nom === 'Sommier Fictif S' && p.prixDefini !== false && p.vendable !== false) && BC.toasts.some(t => t.m === 'Produit ajouté au catalogue ✓'), envoi(BC) && envoi(BC).body);
    BC = bacC('admin', '', 'Sommier Fictif T'); await new Promise(r => setTimeout(r, 0));
    test('appli : administrateur sans prix ⇒ « à définir » (il fixera le prix ensuite)', !!envoi(BC) && envoi(BC).body.prix === null && aDefinir(BC, 'Sommier Fictif T'));
    const nvF = sqlS.slice(sqlS.indexOf('create or replace function interne.produit_non_vendable'), sqlS.indexOf('revoke all on function interne.produit_non_vendable'));
    test('base : produit_non_vendable — prix NULL et composant INTROUVABLE = non vendable', nvF.includes('or p.prix is null') && nvF.includes('left join public.produits q') && nvF.includes('q.id is null or not q.vendable'));
    test('appli : prix NULL = prix non défini (même « prix défini » en base)', bac.venDepuisBase({ prix: null, prix_vente_defini: true }).prixDefini === false && bac.venDepuisBase({ prix: 10 }).prixDefini === true);
    test('serveur : prix NULL = non vendable ; prix non lu (colonne absente) inchangé', pvS.produitsVendables([{ id: 'p', prix: null, prix_vente_defini: true }]).length === 0
      && pvS.produitsVendables([{ id: 'q' }]).length === 1);

    // --- 2. stock dans l'empreinte ---
    const arrS = () => Object.assign(arrivage('en_attente'), { taux_change: 1.1, frais_import_ht: 30, taux_provisoire: true });
    const lignesS = () => [{ id: 71, arrivage_id: 7, produit_id: 'pr-a', quantite_attendue: 30, fob_unitaire: 10.5, revient_unitaire_ht: null }];
    const revS = { 'pr-a': { produit_id: 'pr-a', prix_revient_ht: 40, provisoire: false } };
    const e10 = bac.arrEmpreinte(arrS(), lignesS(), revS, 'CUMP', null, bac.produits);
    test('empreinte v2 : stock actuel du produit inclus (10 en stock)', e10.startsWith('v2|') && e10.endsWith(':f:10'), e10);
    test('empreinte v2 : stock changé (vente) → empreinte différente ; stock lu en base prioritaire sur le catalogue',
      bac.arrEmpreinte(arrS(), lignesS(), revS, 'CUMP', { 'pr-a': 9 }, bac.produits) !== e10 && bac.arrEmpreinte(arrS(), lignesS(), revS, 'CUMP', { 'pr-a': 9 }, bac.produits).endsWith(':f:9'));
    const empV = sqlS.slice(sqlS.indexOf('create or replace function interne.l039_empreinte_valorisation'), sqlS.indexOf('revoke all on function interne.l039_fmt'));
    test('base : empreinte v2 lue avec le stock du produit (après le verrou produits) ; auto-contrôle « stock changé »',
      empV.includes("'stock_avant', coalesce(p.stock, 0)::integer") && empV.includes('left join public.produits p on p.id = l.produit_id')
      && sqlS.includes("select 'v2|' || coalesce(p_methode, '')") && auto10.includes("f := 'empreinte : stock changé'"));
    const repS = (opts) => (url) => url.includes('/rpc/valider_reception_arrivage') ? { ok: true, status: 200, corps: { ok: true, total_recu: 30 } }
      : url.includes('/arrivage_lignes?') ? { ok: true, status: 200, corps: paginer(url, (opts && opts.lignes) || lignesS()) }
      : url.includes('/produits_revient?') ? { ok: true, status: 200, corps: paginer(url, Object.values(revS)) }
      : url.includes('/arrivages?') ? { ok: true, status: 200, corps: paginer(url, [arrS()]) } : { ok: true, status: 200, corps: [] };
    const ouvrirS = (B) => { B.bac.ARR_ETAT.arrivages = [arrS()]; B.bac.ARR_ETAT.lignes = lignesS(); B.bac.ARR_ETAT.revients = JSON.parse(JSON.stringify(revS)); B.bac.arrOuvrir(7); };
    let stockBase = 10, nbConf = 0;
    let B = nouveauBac({ repondre: repS(), stocksBase: () => [{ id: 'pr-a', stock: stockBase }, { id: 'pr-n', stock: 0 }] });
    B.bac.confirm = () => { nbConf++; return true; };
    ouvrirS(B); const vueAvant = B.bac.ARR_ETAT.vue.empreinte; stockBase = 9; await B.bac.arrValider();
    test('vente entre l\'aperçu et la validation (stock 10 → 9) : rien n\'est envoyé, stock relu, nouvel aperçu',
      !B.appels.some(a => a.url.includes('/rpc/')) && B.toasts.some(t => /stock d'un produit changé/.test(t.m)) && B.bac.ARR_ETAT.stocks['pr-a'] === 9
      && B.bac.ARR_ETAT.vue.empreinte !== vueAvant && B.bac.ARR_ETAT.vue.empreinte.endsWith(':f:9') && B.bac.ARR_ETAT.envoi === false, B.toasts);
    test('… aperçu recalculé sur le nouveau stock (9 → 39 ; CUMP (9 × 40 + 30 × revient du lot) / 39)',
      B.bac.arrApercu(B.bac.arrLignesValorisees(arrS(), lignesS()), B.bac.ARR_ETAT.saisies, B.bac.produits, B.bac.ARR_ETAT.revients, 'CUMP', B.bac.ARR_ETAT.stocks)[0].stockApres === 39);
    await B.bac.arrValider();
    let rpcS = B.appels.filter(a => a.url.includes('/rpc/valider_reception_arrivage'));
    test('… puis nouvelle validation : NOUVELLE confirmation, empreinte avec le stock 9 envoyée', nbConf === 2 && rpcS.length === 1 && rpcS[0].body.p_empreinte.endsWith(':f:9'), { nbConf, n: rpcS.length });
    B = nouveauBac({ repondre: repS(), lectureStocks: () => ({ ok: false, status: 503, corps: null }) }); ouvrirS(B); await B.bac.arrValider();
    test('stock des produits illisible juste avant l\'envoi : rien n\'est envoyé, message clair', !B.appels.some(a => a.url.includes('/rpc/')) && B.toasts.some(t => /stock ou revient des produits illisible/.test(t.m)) && B.bac.ARR_ETAT.envoi === false, B.toasts);
    B = nouveauBac({ repondre: repS(), stocksBase: () => [] }); ouvrirS(B); await B.bac.arrValider();
    test('produit de l\'arrivage introuvable dans la base : rien n\'est envoyé (jamais un stock 0 par défaut)', !B.appels.some(a => a.url.includes('/rpc/')) && B.toasts.some(t => /produit introuvable : pr-a/.test(t.m)), B.toasts);
    // produit INACTIF (absent du catalogue chargé par l'appli) : son stock est lu explicitement par identifiant
    const lignesX = () => [{ id: 91, arrivage_id: 7, produit_id: 'pr-inactif', quantite_attendue: 5, fob_unitaire: 10, revient_unitaire_ht: null }];
    B = nouveauBac({ repondre: repS({ lignes: lignesX() }), stocksBase: () => [{ id: 'pr-inactif', stock: 4 }] });
    await B.bac.arrCharger();
    const apX = B.bac.arrApercu(lignesX(), B.bac.arrSaisiesInitiales(lignesX()), B.bac.produits, {}, 'CUMP', B.bac.ARR_ETAT.stocks);
    test('chargement : stock des produits de l\'arrivage lu par identifiants (produit inactif : 4 → 9), filtre in.(…) entre guillemets',
      !B.bac.ARR_ETAT.erreur && B.bac.ARR_ETAT.stocks['pr-inactif'] === 4 && apX[0].stockAvant === 4 && apX[0].stockApres === 9
      && B.appels.some(a => a.url.includes('/rest/v1/produits?select=id,stock&id=' + encodeURIComponent('in.("pr-inactif")') + '&order=id.asc')), { e: B.bac.ARR_ETAT.erreur, s: B.bac.ARR_ETAT.stocks });
    test('filtre in.(…) : guillemets et barres obliques inverses échappés', bac.arrInIds(['a,b', 'x"y', 'c\\d']) === 'in.("a,b","x\\"y","c\\\\d")', bac.arrInIds(['a,b', 'x"y', 'c\\d']));

    // --- 3. lignes figées dans l'appli : même comparaison que la base ---
    const nvL = (o) => Object.assign({ produitId: 'pr-n', produit: 'Matelas Nouveau N (fictif)', qte: 1, prixUnit: 0, prixBrut: 0, remiseLigne: 0, sousTotal: 0 }, o || {});
    const okL = (o) => Object.assign({ produitId: 'pr-a', produit: 'Matelas Fictif A 140×190', qte: 1, prixUnit: 100, prixBrut: 100, remiseLigne: 0, sousTotal: 100 }, o || {});
    const anc = { lignes: [nvL(), okL()] }, cat = bac.produits, NV = ['Matelas Nouveau N (fictif)'];
    const cas = [
      ['commande inchangée → acceptée', [nvL(), okL()], anc, []],
      ['ordre changé et produit vendable modifié → accepté', [okL({ qte: 3, prixBrut: 300, sousTotal: 300 }), nvL()], anc, []],
      ['toutes les lignes du produit non vendable retirées → accepté', [okL()], anc, []],
      ['quantité en texte « 1 » ou 0 (= 1 comme l\'appli) → acceptée', [nvL({ qte: '1' }), okL()], { lignes: [nvL({ qte: 0 }), okL()] }, []],
      ['quantité modifiée (1 → 2) → refusée', [nvL({ qte: 2 }), okL()], anc, NV],
      ['NOUVELLE occurrence du même produit → refusée', [nvL(), nvL(), okL()], anc, NV],
      ['prix modifié → refusé', [nvL({ prixUnit: 5, prixBrut: 5, sousTotal: 5 }), okL()], anc, NV],
      ['remise modifiée → refusée', [nvL({ remiseLigne: 10 }), okL()], anc, NV],
      ['une occurrence retirée sur deux → refusée', [nvL(), okL()], { lignes: [nvL(), nvL(), okL()] }, NV],
      ['commande nouvelle → refusée', [nvL()], null, NV],
      ['ligne au seul NOM du produit non vendable, quantité modifiée → refusée', [{ produit: 'matelas nouveau n (fictif)', qte: 2, prixUnit: 0 }], { lignes: [{ produit: 'Matelas Nouveau N (fictif)', qte: 1, prixUnit: 0 }] }, NV],
    ];
    for (const [nom, lignes, ancienne, attendu] of cas) {
      const r = bac.venLignesRefusees(lignes, cat, ancienne);
      test('appli lignes figées : ' + nom, JSON.stringify(r) === JSON.stringify(attendu), r);
    }
    test('appli lignes figées : signature identique à la base (qte absente ou 0 = 1, prix, remises, type de remise, sous-total)',
      bac.venSignature({ qte: 0, prixUnit: '10', remiseType: 'pct' }) === bac.venSignature({ prixUnit: 10, remiseType: 'pct' })
      && bac.venSignature({ prixUnit: 'abc' }) === bac.venSignature({ prixUnit: null }) && bac.venSignature({ qte: 2 }) !== bac.venSignature({ qte: 1 })
      && sqlS.includes("'qte', coalesce(nullif(interne.l039_nombre(e -> 'qte'), 0), 1)"));
    // v7.5.152 (P2 Codex PR 26 sur 2ce2dad) : montants comparés au centime, des deux côtés
    test('appli lignes figées : montants au centime (59.699999999999996 = 59.7 ; 59.71 ≠ 59.7 ; 1.005 → 1.01 ; texte non numérique → null)',
      bac.venSignature({ qte: 3, prixUnit: 19.9, prixBrut: 3 * 19.9, sousTotal: 3 * 19.9 }) === bac.venSignature({ qte: 3, prixUnit: 19.9, prixBrut: 59.7, sousTotal: 59.7 })
      && bac.venSignature({ prixBrut: 59.71 }) !== bac.venSignature({ prixBrut: 59.7 }) && bac.venCentimes(1.005) === 1.01 && bac.venCentimes(-2.345) === -2.35
      && bac.venCentimes('abc') === null && bac.venCentimes(null) === null);
    test('appli lignes figées : commande importée 3 × 19,90 (59.7) puis ligne recalculée (59.699999999999996) → acceptée ; quantité changée → refusée',
      bac.venLignesRefusees([{ produitId: 'pr-n', produit: 'Matelas Nouveau N (fictif)', qte: 3, prixUnit: 19.9, prixBrut: 3 * 19.9, remiseLigne: 0, remiseVal: 0, remiseType: 'pct', sousTotal: 3 * 19.9 }], cat,
        { lignes: [{ produitId: 'pr-n', produit: 'Matelas Nouveau N (fictif)', qte: 3, prixUnit: 19.9, prixBrut: 59.7, remiseLigne: 0, remiseVal: 0, remiseType: 'pct', sousTotal: 59.7 }] }).length === 0
      && bac.venLignesRefusees([{ produitId: 'pr-n', qte: 4, prixUnit: 19.9, prixBrut: 4 * 19.9, sousTotal: 4 * 19.9 }], cat,
        { lignes: [{ produitId: 'pr-n', qte: 3, prixUnit: 19.9, prixBrut: 59.7, sousTotal: 59.7 }] }).length === 1);
    test('base : signature des lignes au centime (interne.l039_centimes = round(…, 2) pour prix, remises, sous-total) + auto-contrôle 59.7',
      sqlS.includes('select round(interne.l039_nombre(p), 2)')
      && ['prixUnit', 'prixBrut', 'remiseLigne', 'remiseVal', 'sousTotal'].every(k => sqlS.includes("'" + k + "', interne.l039_centimes(e -> '" + k + "')"))
      && sqlS.includes('"prixBrut":59.699999999999996') && sqlS.includes("f := 'arrondi au centime'") && sqlS.includes("f := 'un centime d''écart'"));

    // --- 4. catalogue WhatsApp sans plafond ---
    const rows250 = [];
    for (let n = 0; n < 250; n++) rows250.push({ id: 'w' + String(n).padStart(3, '0'), nom: 'Produit fictif ' + n, cat: 'Matelas', dim: '140x190', prix: 10 + n, actif: true });
    rows250[230] = Object.assign(rows250[230], { vendable: false, prix_vente_defini: false, prix: null });
    rows250.push({ id: 'w-inactif', nom: 'Inactif', prix: 5, actif: false });
    const catW = pvS.catalogueWhatsapp(rows250);
    test('WhatsApp : TOUT le catalogue actif vendable (250 produits, au-delà de l\'ancien plafond de 200), non vendable et inactif écartés',
      catW.length === 249 && catW.some(p => p.id === 'w240') && catW.some(p => p.id === 'w249') && !catW.some(p => p.id === 'w230' || p.id === 'w-inactif')
      && Object.keys(catW[0]).sort().join(',') === 'cat,dim,id,nom,prix', catW.length);

    // --- 5. composant introuvable : signalé, catalogue refusé ---
    let erreurC = '';
    try { await pvS.lireCatalogueComplet(async (d) => (d === 0 ? [{ id: 'ens', composants: [{ id: 'fantome' }, { id: 'a' }] }, { id: 'a' }] : []), async () => []); } catch (e) { erreurC = String(e.message); }
    test('serveur : composant demandé absent de la recherche par identifiants → catalogue REFUSÉ, absence signalée', /composants introuvables : fantome/.test(erreurC), erreurC);
    test('serveur : composant absent des lignes lues = ensemble NON vendable (jamais vendable par défaut)', !pvS.produitsVendables([{ id: 'ens', composants: [{ id: 'fantome' }] }]).some(r => r.id === 'ens'));

    // --- 6. quantités figées avant l'attente, saisies désactivées pendant l'envoi ---
    const lignes6 = () => [{ id: 81, arrivage_id: 7, produit_id: 'pr-a', quantite_attendue: 10, fob_unitaire: 10, revient_unitaire_ht: null }];
    let pendant = null;
    B = nouveauBac({ repondre: (url, init) => {
      if (url.includes('/arrivage_lignes?')) {
        // pendant la relecture : l'utilisateur tente « 0 bonne + 10 manquantes », et une écriture directe modifie l'état
        if (pendant) return { ok: true, status: 200, corps: paginer(url, lignes6()) };
        B.bac.arrSaisie(81, 'recue', '0'); B.bac.arrSaisie(81, 'manquante', '10');
        pendant = { saisie: JSON.stringify(B.bac.ARR_ETAT.saisies[81]), desactive: B.elts['arr-in-81-recue'] && B.elts['arr-in-81-recue'].disabled === true };
        B.bac.ARR_ETAT.saisies[81] = { recue: '0', endommagee: '0', manquante: '10' };
        return { ok: true, status: 200, corps: paginer(url, lignes6()) };
      }
      return repS({ lignes: lignes6() })(url, init);
    } });
    B.bac.ARR_ETAT.arrivages = [arrS()]; B.bac.ARR_ETAT.lignes = lignes6(); B.bac.ARR_ETAT.revients = JSON.parse(JSON.stringify(revS)); B.bac.arrOuvrir(7);
    await B.bac.arrValider();
    rpcS = B.appels.filter(a => a.url.includes('/rpc/valider_reception_arrivage'));
    test('10 bonnes confirmées → 10 bonnes ENVOYÉES, même si la saisie devient « 0 bonne + 10 manquantes » pendant l\'attente',
      rpcS.length === 1 && JSON.stringify(rpcS[0].body.p_lignes) === JSON.stringify([{ ligne_id: 81, recue: 10, endommagee: 0, manquante: 0 }]), rpcS[0] && rpcS[0].body.p_lignes);
    test('… saisie ignorée et champs désactivés pendant l\'envoi', !!pendant && pendant.saisie === JSON.stringify({ recue: 10, endommagee: 0, manquante: 0 }) && pendant.desactive === true, pendant);

    // --- 7. revients lus par pages ---
    const rev1500 = []; for (let n = 0; n < 1500; n++) rev1500.push({ produit_id: 'r' + String(n).padStart(4, '0'), prix_revient_ht: 1 + n, provisoire: false, methode: 'CUMP' });
    B = nouveauBac({ pagination: true, repondre: (url) => url.includes('/produits_revient?') ? { ok: true, status: 200, corps: paginer(url, rev1500, 1000) } : { ok: true, status: 200, corps: [] } });
    const okR = await B.bac.arrChargerRevients();
    const appR = B.appels.filter(a => a.url.includes('/produits_revient?'));
    test('revients : 1 500 lignes lues EN ENTIER par pages (ordre stable produit_id), au-delà du plafond de 1 000',
      okR === true && Object.keys(B.bac.ARR_ETAT.revients).length === 1500 && B.bac.ARR_ETAT.revients['r1499'].prix_revient_ht === 1500
      && appR.length === 3 && appR.every(a => a.url.includes('&order=produit_id.asc&limit=1000&offset=')), { n: Object.keys(B.bac.ARR_ETAT.revients).length, req: appR.length });
    B = nouveauBac({ repondre: (url) => url.includes('/produits_revient?') ? { ok: false, status: 500, corps: null }
      : url.includes('/arrivages?') ? { ok: true, status: 200, corps: paginer(url, [arrS()]) } : url.includes('/arrivage_lignes?') ? { ok: true, status: 200, corps: paginer(url, lignesS()) } : { ok: true, status: 200, corps: [] } });
    B.bac.ARR_ETAT.revients = { 'pr-a': { prix_revient_ht: 99 } }; await B.bac.arrCharger();
    test('revients illisibles : anciennes valeurs effacées, erreur affichée (aucun aperçu calculé sans revient)', Object.keys(B.bac.ARR_ETAT.revients).length === 0 && /Prix de revient illisibles/.test(B.bac.ARR_ETAT.erreur), B.bac.ARR_ETAT.erreur);
    B = nouveauBac({ pagination: true, repondre: (url) => url.includes('stock_entrant') ? { ok: true, status: 200, corps: paginer(url, [{ produit_id: 'pr-n', quantite: 40, arrivages: 1 }]) } : { ok: true, status: 200, corps: [] } });
    await B.bac.arrChargerEntrant();
    test('stock entrant : lu par pages (ordre stable) et compté une seule fois', B.bac.ARR_ETAT.entrant['pr-n'] === 40 && B.appels.filter(a => a.url.includes('stock_entrant')).length === 2
      && B.appels.every(a => !a.url.includes('stock_entrant') || (a.methode === 'POST' && a.url.includes('order=produit_id.asc'))));

    // --- relecture complète : prix de vente réellement appliqué par la base, trois quantités obligatoires ---
    const pN = () => B.bac.produits.find(p => p.id === 'pr-n');
    B = nouveauBac({ repondre: (url, init) => (init && init.method === 'PATCH') ? { ok: true, status: 200, corps: [] } : { ok: true, status: 200, corps: [] } });
    let okP = await B.bac.venDefinirPrix(pN(), 120);
    test('prix de vente : HTTP 200 sans ligne modifiée (droits, produit introuvable) = échec, produit toujours « à définir »', okP === false && pN().prixDefini === false && B.toasts.some(t => /la base ne l'a pas appliqué/.test(t.m)), B.toasts);
    B = nouveauBac({ repondre: (url, init) => (init && init.method === 'PATCH') ? { ok: true, status: 200, corps: [{ id: 'pr-n', prix: 120, prix_vente_defini: true, vendable: true }] } : { ok: true, status: 200, corps: [] } });
    okP = await B.bac.venDefinirPrix(pN(), 120);
    const patch = B.appels.find(a => a.methode === 'PATCH');
    test('prix de vente : ligne renvoyée par la base (prix > 0, prix défini, vendable) → produit vendable', okP === true && pN().prixDefini === true && pN().vendable === true && pN().prix === 120
      && extraireFonction('async function venDefinirPrix(p, prix)').includes("'Prefer': 'return=representation'") && !!patch);
    const valS = sqlS.slice(sqlS.indexOf('create or replace function public.valider_reception_arrivage'), sqlS.indexOf('create or replace function public.recalculer_revient_arrivage'));
    test('base : réception — trois quantités obligatoires (endommagé ou manquant absent n\'est plus 0 par défaut)',
      valS.includes("v_end := (s ->> 'endommagee')::integer; v_man := (s ->> 'manquante')::integer;") && valS.includes('if v_rec is null or v_end is null or v_man is null') && !valS.includes("coalesce((s ->> 'endommagee')::integer, 0)"));
  }

  console.log('\n8 ter. COMMANDE ANCIENNE SANS LIGNES ROUVERTE (v7.5.158, revue Codex PR 26 sur 7e5c4cf + P2 natif)');
  {
    const ouvrir = html.slice(html.indexOf('// Commande ancienne sans lignes'), html.indexOf('// Remise globale', html.indexOf('// Commande ancienne sans lignes')));
    test('ouverture : plus de rapprochement par premier mot du nom ni de filtre « vendable » sur le produit principal',
      !ouvrir.includes("split(' ')[0]") && !ouvrir.includes('aoSelectionnables') && ouvrir.includes('venOptionPrincipale(c, produits)') && ouvrir.includes('venMemoriserPrincipal(div2, c)'));
    const sv = extraireFonction('function saveCmd()');
    test('enregistrement : ligne d\'origine non touchée → produit principal gardé (venGarderPrincipal) et contrôlé comme la base',
      sv.includes('venPrincipalAGarder(existingCmd,') && sv.includes('if (_principalGarde) venGarderPrincipal(cmdData, existingCmd);')
      && sv.includes('venLignesRefusees(existingCmd.lignes, produits, existingCmd, { produit: existingCmd.produit, qte: existingCmd.qte, prix: existingCmd.prix })')
      && sv.indexOf('venGarderPrincipal(cmdData') > sv.indexOf('if (isSavCmd) {'));
  }

  console.log('\n8 quater. REMISE GLOBALE FIGÉE (v7.5.161, revue Codex PR 26 sur 40f0bd6)');
  {
    const NV = 'Matelas Nouveau N (fictif)';
    const lnv = { produitId: 'pr-n', produit: NV, qte: 1, prixUnit: 100, prixBrut: 100, remiseLigne: 0, remiseVal: 0, remiseType: 'pct', sousTotal: 100 };
    const lA = { produitId: 'pr-a', produit: 'Matelas Fictif A 140×190', qte: 1, prixUnit: 200, prixBrut: 200, remiseLigne: 0, remiseVal: 0, remiseType: 'pct', sousTotal: 200 };
    const anc = { lignes: [lnv, lA], remiseGlobale: 30, remiseGlobaleVal: 10, remiseGlobaleType: 'pct' };
    const RR = (lignes, remise, a) => bac.venRemiseRefusee(lignes, bac.produits, a === undefined ? anc : a, null, remise);
    test('signature : écart d\'arrondi accepté, absents = 0, type vide = pct', bac.venRemiseSignature(10, 'pct', 15) === bac.venRemiseSignature('10.004', 'pct', 14.999)
      && bac.venRemiseSignature(null, null, null) === bac.venRemiseSignature(0, '  ', '0'));
    test('ligne figée, remise inchangée (adresse modifiée) → acceptée', RR([lnv, lA], { val: 10, type: 'pct', montant: 30 }).length === 0);
    test('ligne figée, VALEUR de remise modifiée → refusée', JSON.stringify(RR([lnv, lA], { val: 20, type: 'pct', montant: 60 })) === JSON.stringify([NV]));
    test('ligne figée, TYPE de remise modifié → refusé', RR([lnv, lA], { val: 10, type: 'eur', montant: 10 }).length === 1);
    test('ligne figée, MONTANT de remise modifié (même valeur) → refusé', RR([lnv, lA], { val: 10, type: 'pct', montant: 29.99 }).length === 1);
    test('ligne figée, remise effacée → refusée', RR([lnv, lA], { val: 0, type: 'pct', montant: 0 }).length === 1);
    test('ligne figée reconnue par son NOM seul (sans produitId) → remise figée aussi', RR([{ produit: NV, qte: 1, prixUnit: 100, sousTotal: 100 }, lA], { val: 0, type: 'pct', montant: 0 },
      { lignes: [{ produit: NV, qte: 1, prixUnit: 100, sousTotal: 100 }, lA], remiseGlobale: 30, remiseGlobaleVal: 10, remiseGlobaleType: 'pct' }).length === 1);
    test('commande sans ligne non vendable : remise libre', RR([lA], { val: 50, type: 'eur', montant: 50 }, { lignes: [lA], remiseGlobale: 0, remiseGlobaleVal: 0, remiseGlobaleType: 'pct' }).length === 0);
    test('toutes les lignes du produit non vendable retirées : remise libre', RR([lA], { val: 0, type: 'pct', montant: 0 }).length === 0);
    test('commande nouvelle : rien ici (lignes déjà refusées par venLignesRefusees)', RR([lnv], { val: 5, type: 'pct', montant: 5 }, null).length === 0);
    test('commande sans lignes : produit principal non vendable → remise figée', bac.venRemiseRefusee(null, bac.produits, { lignes: null, produit: NV, qte: 1, prix: 100, remiseGlobale: 0, remiseGlobaleVal: 0, remiseGlobaleType: 'pct' },
      { produit: NV, qte: 1, prix: 100 }, { val: 10, type: 'eur', montant: 10 }).length === 1);
    test('montant actuel repris si lignes et remise (valeur, type) identiques', bac.venRemiseAGarder([lA, lnv], anc, 10, 'pct') === true
      && bac.venRemiseAGarder([lnv], anc, 10, 'pct') === false && bac.venRemiseAGarder([lnv, lA], anc, 12, 'pct') === false);
    const sv = extraireFonction('function saveCmd()');
    test('saveCmd : remise contrôlée AVANT tout enregistrement, message clair, montant actuel repris',
      sv.includes('venRemiseRefusee(lignes, produits, existingCmd, null, { val: remGV, type: remGT, montant: remGM })')
      && sv.includes('if (venRemiseAGarder(lignes, existingCmd, remGV, remGT)) remGM = parseFloat(existingCmd.remiseGlobale) || 0;')
      && sv.includes('la remise globale de cette commande (valeur, type, montant) ne peut pas être modifiée')
      && sv.indexOf('venRemiseRefusee(') < sv.indexOf('const cmdData') && sv.indexOf('venRemiseRefusee(') < sv.indexOf('paiAvancePreparer'));
    const trigR = sql.slice(sql.indexOf('create or replace function interne.commandes_produit_vendable_garde()'), sql.indexOf('create trigger commandes_produit_vendable_garde'));
    const sigR = sql.slice(sql.indexOf('create or replace function interne.l039_remise_signature'), sql.indexOf('revoke all on function interne.l039_remise_signature'));
    test('base : signature de remise PURE (valeur, type, montant au centime), accès retiré', sigR.includes('language sql immutable as $$\n') && /\n\$\$;\n?$/.test(sigR)
      && sigR.includes("coalesce(interne.l039_centimes(p_val), 0)") && sigR.includes("coalesce(nullif(btrim(p_type), ''), 'pct')") && sigR.includes("coalesce(interne.l039_centimes(p_montant), 0)")
      && sql.includes('revoke all on function interne.l039_remise_signature(jsonb, text, jsonb) from public, anon, authenticated;'));
    test('base : déclencheur — remise proposée comparée à l\'actuelle (UPDATE et upsert), refus explicite',
      trigR.includes('interne.l039_remise_signature(to_jsonb(new.remise_globale_val), new.remise_globale_type::text, to_jsonb(new.remise_globale))')
      && trigR.includes('v_old_remise := interne.l039_remise_signature(to_jsonb(old.remise_globale_val), old.remise_globale_type::text, to_jsonb(old.remise_globale));')
      && trigR.includes('into v_old, v_old_remise') && trigR.includes('if v_new_remise is distinct from v_old_remise then')
      && trigR.includes('remise globale de la commande modifiée (valeur, type ou montant) : refusé')
      && trigR.indexOf('if v_nv is null then return new; end if;') < trigR.indexOf('if v_new_remise is distinct from v_old_remise then'));
    test('base : déclencheur aussi sur les colonnes de remise globale', sql.includes('create trigger commandes_produit_vendable_garde before insert or update of lignes, produit, qte, prix, remise_globale, remise_globale_val, remise_globale_type on public.commandes'));
    const auto10r = sql.slice(sql.indexOf("-- 10. Auto-contrôle à l'application : revient d'un lot"));
    test('base : auto-contrôle EXÉCUTÉ (remise : arrondi, absente, valeur, type, montant, effacée)',
      ["remise globale : écart d''arrondi accepté", 'remise globale absente = remise nulle en pourcentage', 'remise globale : valeur modifiée', 'remise globale : type modifié',
       "remise globale : montant modifié d''un centime", 'remise globale effacée'].every(c => auto10r.includes("f := '" + c + "'")));
    const jlR = await import('file:///' + path.join(racine, 'supabase', 'functions', '_shared', 'jarvis-action-logique.ts').replace(/\\/g, '/'));
    const catR = jlR.catalogueDepuisBase([{ id: 'n', nom: NV, prix: null, vendable: false, prix_vente_defini: false, reference_interne: 'MC-TEST-1' }, { id: 'a', nom: 'Matelas Fictif A 140×190', prix: 100 }]);
    const idDe = (x) => x ? x.id : null;
    test('JARVIS : produit non vendable d\'une commande (identifiant, nom, référence, produit principal)', idDe(jlR.produitNonVendableDeCommande([{ produitId: 'n' }], '', catR)) === 'n'
      && idDe(jlR.produitNonVendableDeCommande([{ produit: 'matelas nouveau n (fictif)' }], '', catR)) === 'n' && idDe(jlR.produitNonVendableDeCommande([{ produit: 'X', sku: 'mc-test-1' }], '', catR)) === 'n'
      && idDe(jlR.produitNonVendableDeCommande(null, NV, catR)) === 'n' && jlR.produitNonVendableDeCommande([{ produitId: 'a', produit: 'Matelas Fictif A 140×190' }], '', catR) === null);
    const cR = { remise_globale: 30, remise_globale_val: 10, remise_globale_type: 'pct' };
    test('JARVIS : modifier_prix efface une remise existante = remise modifiée ; remise nulle = inchangée', jlR.remiseGlobaleModifiee(cR, jlR.champsPrix({ prix: 100, motif: 'x' }, cR)) === true
      && jlR.remiseGlobaleModifiee({ remise_globale: 0, remise_globale_val: null, remise_globale_type: null }, jlR.champsPrix({ prix: 100, motif: 'x' }, {})) === false);
    const idxR = fs.readFileSync(path.join(racine, 'supabase', 'functions', 'jarvis-action', 'index.ts'), 'utf8');
    const mp = idxR.slice(idxR.indexOf("if (d.action === 'modifier_prix')"), idxR.indexOf("if (d.action === 'annuler_commande')"));
    test('JARVIS : modifier_prix refusé (422) AVANT l\'aperçu si la commande contient un produit non vendable et une remise', mp.includes('if (remiseGlobaleModifiee(c!, p))')
      && mp.includes('produitNonVendableDeCommande(c!.lignes, c!.produit, catP)') && mp.includes('rep(422') && mp.indexOf('rep(422') < mp.indexOf('if (!confirme)'));
  }

  // ══ revue Codex PR 26 sur 4e04efd (v7.5.173) : réponse de validation PERDUE après l'écriture en base = résultat INDÉTERMINÉ ══
  console.log('\n8 septies. RÉPONSE DE VALIDATION PERDUE : RÉSULTAT INDÉTERMINÉ, RELECTURE AVANT TOUTE NOUVELLE TENTATIVE');
  {
    ({ bac } = nouveauBac());
    const I = bac.arrIssueValidation;
    test('issue : { ok: true } en 200 = validée', I(false, 200, { ok: true, total_recu: 70 }) === 'validee');
    test('issue : refus explicite de la fonction ({ ok: false, erreur }) = refusée', I(false, 200, { ok: false, erreur: 'arrivage_deja_traite' }) === 'refusee');
    test('issue : erreur de la base 400 / 401 / 403 / 404 / 422 (opération annulée) = refusée', [400, 401, 403, 404, 422].every(s => I(false, s, { message: 'erreur' }) === 'refusee'));
    test('issue : pas de réponse (coupure) = INDÉTERMINÉE', I(true, 0, null) === 'indeterminee');
    test('issue : corps illisible, 5xx, 408 / 425 / 429, réponse sans « ok » = INDÉTERMINÉE', I(false, 200, null) === 'indeterminee' && [500, 502, 503, 504, 408, 425, 429].every(s => I(false, s, { message: 'x' }) === 'indeterminee') && I(false, 200, { total_recu: 70 }) === 'indeterminee');
    const C = bac.arrConclureRelecture;
    test('relecture : « recu » = validée (même sans mouvement : tout endommagé)', C('recu', 2, 2) === 'validee' && C('recu', 0, 0) === 'validee');
    test('relecture : en attente (ou annulé) SANS mouvement = non validée', C('en_attente', 0, 0) === 'non_validee' && C('annule', 0, 0) === 'non_validee');
    test('relecture : en attente AVEC des mouvements de cet arrivage = incohérente (pas de nouvel envoi)', C('en_attente', 1, 0) === 'incoherente' && C('en_attente', 0, 1) === 'incoherente');
  }
  {
    // v7.5.177 (revue Codex PR 26 sur ce01159) : réponse de la fonction serveur statut_reception_arrivage (relecture SOUS LE VERROU
    // de la réception : statut, historique des revients et mouvements de stock de CET arrivage, comptés par la base)
    const relecture = (url, etat) => {
      if (!url.includes('/rpc/statut_reception_arrivage')) return null;
      if (etat.arrivages) return etat.arrivages;
      const h = etat.historique || [], m = etat.mouvements || [];
      return { ok: true, status: 200, corps: { ok: true, id: 7, statut: etat.statut || 'recu', recu_le: (etat.statut || 'recu') === 'recu' ? '2026-11-26T10:00:00Z' : null,
        historique: h.length, mouvements: m.length, quantite: h.reduce((s, x) => s + x.quantite, 0) } };
    };
    const HIST = [{ id: 1, arrivage_id: 7, produit_id: 'pr-a', quantite: 30 }, { id: 2, arrivage_id: 7, produit_id: 'pr-n', quantite: 40 }], MVT = [{ id: 11, quantite: 30 }, { id: 12, quantite: 40 }];
    const bacPerdu = (rpc, etat) => { const o = { relectures: 0, pendant: null };
      const x = nouveauBac({ repondre: (url) => {
        if (url.includes('/rpc/valider_reception_arrivage')) return rpc(o);
        if (url.includes('/rpc/statut_reception_arrivage')) { o.relectures++; if (o.surRelecture) o.surRelecture(); }
        const rr = relecture(url, typeof etat === 'function' ? etat(o) : etat); if (rr) return rr;
        if (url.includes('/arrivages?')) return { ok: true, status: 200, corps: paginer(url, [arrivage((typeof etat === 'function' ? etat(o) : etat).statut || 'recu')]) };
        if (url.includes('/arrivage_lignes?')) return { ok: true, status: 200, corps: paginer(url, lignesArr()) };
        return { ok: true, status: 200, corps: [] };
      } });
      x.bac.ARR_ETAT.arrivages = [arrivage('en_attente')]; x.bac.ARR_ETAT.lignes = lignesArr(); x.bac.arrOuvrir(7);
      return Object.assign(x, { o, nbRpc: () => x.appels.filter(a => a.url.includes('/rpc/valider_reception_arrivage')).length,
        nbRelectures: () => x.appels.filter(a => a.url.includes('/rpc/statut_reception_arrivage')).length }); };
    // A. la base VALIDE, puis la réponse est perdue (coupure) : jamais « NON validée », vérification puis « validée »
    let X = bacPerdu(() => { throw new Error('Failed to fetch'); }, { statut: 'recu', historique: HIST, mouvements: MVT });
    X.o.surRelecture = () => { if (!X.o.pendant) X.o.pendant = { envoi: X.bac.ARR_ETAT.envoi, bouton: X.elts['arr-btn-valider'].textContent, desactive: X.elts['arr-btn-valider'].disabled, toasts: X.toasts.map(t => t.m) }; };
    await X.bac.arrValider();
    test('validation réussie puis réponse perdue : PENDANT la relecture, résultat INDÉTERMINÉ « vérification en cours… », bouton bloqué, verrou gardé',
      !!X.o.pendant && X.o.pendant.envoi === true && /vérification en cours/.test(X.o.pendant.bouton) && X.o.pendant.desactive === true
      && X.o.pendant.toasts.some(m => /INDÉTERMINÉ — vérification en cours/.test(m)) && !X.o.pendant.toasts.some(m => /NON validée/.test(m)), X.o.pendant);
    test('… statut ET mouvements relus PAR LA FONCTION SERVEUR statut_reception_arrivage (même verrou que la réception), pour CET arrivage',
      X.nbRelectures() >= 1 && X.appels.filter(a => a.url.includes('/rpc/statut_reception_arrivage')).every(a => a.methode === 'POST' && a.body && a.body.p_arrivage_id === 7));
    test('… plus aucune relecture par SELECT direct (qui pouvait lire « en attente » avant le commit de la réception en cours)',
      !X.appels.some(a => a.url.includes('/prix_revient_historique?') || a.url.includes('/mouvements_stock?') || a.url.includes('/arrivages?select=id,statut,recu_le')));
    test('… puis « Réception validée » (vérifié dans la base, 70 articles), JAMAIS « NON validée », une seule validation envoyée',
      X.toasts.some(t => t.t === 'ok' && /Réception validée \(vérifié dans la base : 70 article/.test(t.m)) && !X.toasts.some(t => /NON validée/.test(t.m)) && X.nbRpc() === 1, X.toasts);
    test('… arrivage « recu », plus de bouton Valider, verrou levé, plus rien « à vérifier »', X.bac.ARR_ETAT.arrivages[0].statut === 'recu' && !X.elts['arr-contenu'].innerHTML.includes('arr-btn-valider')
      && X.bac.ARR_ETAT.envoi === false && X.bac.ARR_ETAT.aVerifier === null);
    // A bis. réponse 502 sans corps lisible (passerelle) après validation : même traitement
    X = bacPerdu(() => ({ ok: false, status: 502, corps: undefined }), { statut: 'recu', historique: HIST, mouvements: MVT });
    X.bac.fetch = ((f) => async (url, init) => { const r = await f(url, init); if (url.includes('/rpc/valider_reception_arrivage')) r.json = async () => { throw new Error('corps illisible'); }; return r; })(X.bac.fetch);
    await X.bac.arrValider();
    test('réponse 502 au corps illisible : indéterminée, relue, « validée » (aucun « NON validée »)', X.nbRelectures() >= 1 && X.toasts.some(t => /Réception validée \(vérifié/.test(t.m)) && !X.toasts.some(t => /NON validée/.test(t.m)), X.toasts);
    // B. erreur RÉELLE (refus explicite) : « NON validée » tout de suite, sans relecture, nouvelle tentative possible
    X = bacPerdu(() => ({ ok: true, status: 200, corps: { ok: false, erreur: 'une_saisie_par_ligne_requise' } }), { statut: 'en_attente' });
    await X.bac.arrValider();
    test('erreur réelle (refus de la fonction) : « NON validée : une_saisie_par_ligne_requise » aussitôt, aucune relecture, bouton réactivé',
      X.toasts.some(t => t.t === 'err' && /NON validée : une_saisie_par_ligne_requise/.test(t.m)) && X.nbRelectures() === 0 && X.bac.ARR_ETAT.aVerifier === null && X.bac.ARR_ETAT.envoi === false && X.elts['arr-btn-valider'].disabled === false, X.toasts);
    X = bacPerdu(() => ({ ok: false, status: 400, corps: { code: 'P0001', message: 'contrainte' } }), { statut: 'en_attente' });
    await X.bac.arrValider();
    test('erreur réelle de la base (HTTP 400, opération annulée) : « NON validée » sans relecture', X.toasts.some(t => /NON validée : contrainte/.test(t.m)) && X.nbRelectures() === 0 && X.bac.ARR_ETAT.aVerifier === null);
    // C. réponse perdue AVANT l'écriture (la base n'a rien validé) : relecture « en attente », aucun mouvement -> « NON validée », réessai permis
    X = bacPerdu((o) => { o.n = (o.n || 0) + 1; if (o.n === 1) throw new Error('Failed to fetch'); return { ok: true, status: 200, corps: { ok: true, total_recu: 70 } }; },
      (o) => ({ statut: o.n >= 2 ? 'recu' : 'en_attente' }));
    await X.bac.arrValider();
    test('réponse perdue, base NON validée : après relecture « NON validée (vérifié dans la base… aucun mouvement) — vous pouvez valider de nouveau »',
      X.toasts.some(t => t.t === 'err' && /NON validée \(vérifié dans la base : arrivage « En attente de réception », aucun mouvement\) — vous pouvez valider de nouveau/.test(t.m)) && X.bac.ARR_ETAT.aVerifier === null && X.elts['arr-btn-valider'].disabled === false, X.toasts);
    await X.bac.arrValider();
    test('… nouvelle tentative autorisée APRÈS la relecture : deuxième envoi, « Réception validée »', X.nbRpc() === 2 && X.toasts.some(t => t.t === 'ok' && /Réception validée : 70/.test(t.m)));
    // D. réponse perdue ET relecture impossible : reste INDÉTERMINÉ, aucun nouvel envoi tant que la base n'a pas été relue
    let lectureOk = false;
    X = bacPerdu(() => { throw new Error('Failed to fetch'); }, () => lectureOk ? { statut: 'recu', historique: HIST, mouvements: MVT } : { arrivages: { ok: false, status: 503, corps: [] } });
    await X.bac.arrValider();
    test('relecture impossible : « Résultat INDÉTERMINÉ : vérification impossible (503) », jamais « validée » ni « NON validée »',
      X.toasts.some(t => /Résultat INDÉTERMINÉ : vérification impossible \(503\)/.test(t.m)) && !X.toasts.some(t => /NON validée|Réception validée/.test(t.m)) && X.bac.ARR_ETAT.aVerifier && X.bac.ARR_ETAT.aVerifier.id === 7, X.toasts);
    test('… bouton Valider BLOQUÉ (« vérifiez dans la base »), bouton « Vérifier dans la base » proposé, verrou levé (navigation possible)',
      X.elts['arr-btn-valider'].disabled === true && /Résultat indéterminé : vérifiez dans la base/.test(X.elts['arr-btn-valider'].textContent)
      && X.elts['arr-contenu'].innerHTML.includes('arr-btn-verifier') && X.elts['arr-btn-verifier'].style.display === '' && X.bac.ARR_ETAT.envoi === false);
    await X.bac.arrValider();
    test('… nouvelle validation refusée SANS appel à la base tant que le résultat est indéterminé', X.nbRpc() === 1 && X.toasts.some(t => /validation précédente INDÉTERMINÉ : vérifiez d'abord dans la base/.test(t.m)));
    lectureOk = true; await X.bac.arrVerifierClic();
    test('« Vérifier dans la base » une fois la base joignable : « Réception validée (vérifié…) », plus rien à vérifier, une seule validation envoyée',
      X.toasts.some(t => /Réception validée \(vérifié dans la base/.test(t.m)) && X.bac.ARR_ETAT.aVerifier === null && X.nbRpc() === 1 && X.bac.ARR_ETAT.envoi === false);
    // E. état incohérent (en attente mais mouvements présents) : reste indéterminé, aucun renvoi
    X = bacPerdu(() => { throw new Error('Failed to fetch'); }, { statut: 'en_attente', historique: [HIST[0]], mouvements: [] });
    await X.bac.arrValider(); await X.bac.arrValider();
    test('relecture incohérente (en attente AVEC un mouvement) : reste INDÉTERMINÉ, message « ne revalidez pas », aucun second envoi',
      X.toasts.some(t => /Ne revalidez pas/.test(t.m)) && X.bac.ARR_ETAT.aVerifier && X.nbRpc() === 1, X.toasts);
    // F. (revue Codex PR 26 sur ce01159, P2) réception encore EN COURS dans la base : la fonction serveur n'obtient pas le verrou à temps
    //    -> « verification_occupee » : le résultat reste INDÉTERMINÉ, aucun nouvel envoi, puis relecture une fois la réception finie
    let enCours = true;
    X = bacPerdu(() => { throw new Error('Failed to fetch'); }, () => enCours ? { arrivages: { ok: true, status: 200, corps: { ok: false, erreur: 'verification_occupee' } } } : { statut: 'recu', historique: HIST, mouvements: MVT });
    await X.bac.arrValider();
    test('réception encore en cours (verrou non obtenu) : « INDÉTERMINÉ : vérification impossible (réception encore en cours dans la base) », ni « validée » ni « NON validée »',
      X.toasts.some(t => /Résultat INDÉTERMINÉ : vérification impossible \(réception encore en cours dans la base\)/.test(t.m)) && !X.toasts.some(t => /NON validée|Réception validée/.test(t.m)) && X.bac.ARR_ETAT.aVerifier && X.bac.ARR_ETAT.aVerifier.id === 7, X.toasts);
    await X.bac.arrValider();
    test('… nouvelle validation refusée SANS appel à la base tant que la vérification n\'a pas répondu', X.nbRpc() === 1);
    enCours = false; await X.bac.arrVerifierClic();
    test('… réception terminée : « Vérifier dans la base » conclut « Réception validée (vérifié…) », une seule validation envoyée',
      X.toasts.some(t => /Réception validée \(vérifié dans la base : 70 article/.test(t.m)) && X.bac.ARR_ETAT.aVerifier === null && X.nbRpc() === 1);
    // réponses douteuses de la fonction : jamais de conclusion
    const L = bac.arrLectureStatut;
    test('lecture du statut : réponse correcte acceptée', L(200, { ok: true, id: 7, statut: 'en_attente', recu_le: null, historique: 0, mouvements: 0, quantite: 0 }, 7).ok === true);
    test('lecture du statut : HTTP 500 / 401, corps vide, tableau, ok absent, refus, champs manquants ou faux, autre arrivage = échec (indéterminé)',
      [L(500, { ok: true }, 7), L(401, null, 7), L(200, null, 7), L(200, [], 7), L(200, { statut: 'recu', historique: 0, mouvements: 0, quantite: 0 }, 7),
       L(200, { ok: false, erreur: 'session_admin_requise' }, 7), L(200, { ok: true, statut: 'recu', historique: '2', mouvements: 0, quantite: 0 }, 7),
       L(200, { ok: true, statut: 'recu', historique: -1, mouvements: 0, quantite: 0 }, 7), L(200, { ok: true, statut: null, historique: 0, mouvements: 0, quantite: 0 }, 7),
       L(200, { ok: true, id: 8, statut: 'recu', historique: 0, mouvements: 0, quantite: 0 }, 7)].every(x => x.ok === false));
    // code : plus de « pas de connexion » transformé en « Réception NON validée »
    const env = extraireFonction('async function arrValiderEnvoi(a, ls, saisies, vue)');
    test('code : une coupure après l\'envoi n\'est plus traduite en « NON validée » (plus de j = { ok: false, erreur: \'pas de connexion\' })', !/j = \{ ok: false, erreur: 'pas de connexion' \}/.test(env) && /arrIssueValidation\(sansReponse, http, j\)/.test(env) && /if \(issue === 'indeterminee'\) \{ await arrVerifierReception\(a\); return; \}/.test(env));
  }

  console.log('\n9. VERSION');
  const m = /CACHE_VERSION = 'maxiconfort-v7-5-(\d+)'/.exec(sw);
  test('CACHE_VERSION augmentée (v7-5-177 ou plus)', !!m && Number(m[1]) >= 177, m && m[0]);

  // revue Codex PR 26 sur 636f873 : le banc RÉEL de la 039 ne peut plus « réussir » sans dépendance. Il est lancé ici dans un
  // processus séparé où le paquet est rendu introuvable (aucun téléchargement, aucune base : il s'arrête avant).
  console.log('\nBANC 039 PGLITE : DÉPENDANCE DÉCLARÉE, ÉCHEC EXPLICITE SI ABSENTE');
  {
    const { spawnSync } = require('child_process');
    const banc = path.join(racine, 'outils', 'test-039-pglite.js');
    const cacher = "const M=require('module');const o=M._resolveFilename;M._resolveFilename=function(r,...a){if(r==='@electric-sql/pglite'){const e=new Error('introuvable (simulation)');e.code='MODULE_NOT_FOUND';throw e}return o.call(this,r,...a)};require(process.argv[1])";
    const env = Object.assign({}, process.env); delete env.SAUTER_PGLITE;
    const sans = spawnSync(process.execPath, ['-e', cacher, banc], { encoding: 'utf8', env, timeout: 60000 });
    test('dépendance absente : le banc ÉCHOUE (code ≠ 0) avec un message clair', sans.status !== 0 && sans.status !== null && /ÉCHEC DU BANC 039 PGLITE/.test(sans.stderr) && /n'a PAS été testée/.test(sans.stderr), { status: sans.status, err: (sans.stderr || '').slice(0, 200) });
    const saute = spawnSync(process.execPath, ['-e', cacher, banc], { encoding: 'utf8', env: Object.assign({}, env, { SAUTER_PGLITE: '1' }), timeout: 60000 });
    test('SAUTER_PGLITE=1 explicite : banc sauté (code 0), message « SAUTÉ VOLONTAIREMENT »', saute.status === 0 && /SAUTÉ VOLONTAIREMENT \(SAUTER_PGLITE=1\)/.test(saute.stdout), { status: saute.status, out: (saute.stdout || '').slice(0, 200) });
    const pkgJ = JSON.parse(fs.readFileSync(path.join(racine, 'package.json'), 'utf8'));
    const bancTxt = fs.readFileSync(banc, 'utf8');
    test('package.json : dépendance de développement déclarée en version EXACTE 0.2.17 (= version exigée par le banc)', pkgJ.devDependencies && pkgJ.devDependencies['@electric-sql/pglite'] === '0.2.17' && bancTxt.includes("const VERSION_ATTENDUE = '0.2.17';") && pkgJ.private === true && !pkgJ.dependencies, pkgJ);
    test('banc : autre version installée = échec explicite (plus un simple avertissement)', /pkg\.version !== VERSION_ATTENDUE\) \{[\s\S]{0,300}process\.exit\(2\)/.test(bancTxt));
    const conf = fs.readFileSync(path.join(racine, '_config.yml'), 'utf8');
    test('site publié : package.json, package-lock.json et node_modules exclus (_config.yml)', ['package.json', 'package-lock.json', 'node_modules'].every((x) => new RegExp('^\\s*- ' + x.replace('.', '\\.') + '\\s*$', 'm').test(conf)));
  }
  console.log('\nRÉSULTAT : ' + ok + ' tests réussis, ' + ko + ' échec(s)');
  process.exit(ko ? 1 : 0);
})().catch(e => { console.log('ERREUR : ' + (e && e.stack || e)); process.exit(1); });
