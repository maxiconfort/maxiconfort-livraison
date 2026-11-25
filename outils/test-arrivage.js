// Banc de test « ARRIVAGES, PRIX DE REVIENT, PRODUITS NON VENDABLES » (v7.5.136 + migration 039, 25/11/2026).
// Usage : node outils/test-arrivage.js
// Il EXTRAIT le vrai code de maxiconfort-v7.html (bloc ARR-DEBUT … ARR-FIN, bloc AO, buildProduitOptions, sbLoadProduits) et
// l'exécute dans un bac à sable : aucune connexion à la base, VALEURS FICTIVES uniquement (aucun prix réel dans ce dépôt public).
// La migration SQL n'est pas exécutée ici (pas de base de test locale) : ses règles sont vérifiées sur le texte du fichier, et
// le calcul du revient est le même des deux côtés (constante et formule comparées).
const fs = require('fs'), path = require('path'), vm = require('vm');
const racine = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(racine, 'maxiconfort-v7.html'), 'utf8');
const sql = fs.readFileSync(path.join(racine, 'supabase', 'migrations', '039_arrivages_prix_revient.sql'), 'utf8');
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
      const rep = o.repondre ? o.repondre(url, init) : { ok: true, status: 200, corps: [] };
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
    : url.includes('/arrivages?') ? { ok: true, status: 200, corps: [arrivage('recu')] } : url.includes('/arrivage_lignes?') ? { ok: true, status: 200, corps: lignesArr() } : { ok: true, status: 200, corps: [] } });
  B.bac.ARR_ETAT.arrivages = [arrivage('en_attente')]; B.bac.ARR_ETAT.lignes = lignesArr();
  B.bac.arrOuvrir(7);
  const p1 = B.bac.arrValider(), p2 = B.bac.arrValider(); await Promise.all([p1, p2]);
  const nbRpc = () => B.appels.filter(a => a.url.includes('/rpc/valider_reception_arrivage')).length;
  test('double clic : une seule validation envoyée', nbRpc() === 1, nbRpc());
  test('après succès : arrivage relu « recu », plus de bouton Valider', B.bac.ARR_ETAT.arrivages[0].statut === 'recu' && !B.elts['arr-contenu'].innerHTML.includes('arr-btn-valider'), B.elts['arr-contenu'].innerHTML.slice(0, 200));
  B.bac.ARR_ETAT.arrivages = [arrivage('recu')]; await B.bac.arrValider();
  test('nouvelle tentative sur un arrivage reçu : refusée sans appel à la base', nbRpc() === 1 && B.toasts.some(t => t.t === 'err' && /déjà été traité/.test(t.m)), B.toasts);
  B = nouveauBac({ repondre: (url) => url.includes('/rpc/') ? { ok: true, status: 200, corps: { ok: false, erreur: 'arrivage_deja_traite', statut: 'recu' } } : { ok: true, status: 200, corps: [] } });
  B.bac.ARR_ETAT.arrivages = [arrivage('en_attente')]; B.bac.ARR_ETAT.lignes = lignesArr(); B.bac.arrOuvrir(7); await B.bac.arrValider();
  test('la base refuse (validé ailleurs entre-temps) : message clair, rien n\'est compté comme reçu', B.toasts.some(t => t.t === 'err' && /NON validée : arrivage_deja_traite/.test(t.m)), B.toasts);
  B = nouveauBac({ confirmer: false }); B.bac.ARR_ETAT.arrivages = [arrivage('en_attente')]; B.bac.ARR_ETAT.lignes = lignesArr(); B.bac.arrOuvrir(7); await B.bac.arrValider();
  test('sans confirmation : rien n\'est envoyé', !B.appels.some(a => a.url.includes('/rpc/')));
  B = nouveauBac(); B.bac.ARR_ETAT.arrivages = [arrivage('en_attente')]; B.bac.ARR_ETAT.lignes = lignesArr(); B.bac.arrOuvrir(7); B.bac.arrSaisie(71, 'recue', '29'); await B.bac.arrValider();
  test('total faux : rien n\'est envoyé', !B.appels.some(a => a.url.includes('/rpc/')) && B.toasts.some(t => /Contrôle à corriger/.test(t.m)));
  B = nouveauBac({ role: 'collab' }); B.bac.ARR_ETAT.arrivages = [arrivage('en_attente')]; B.bac.ARR_ETAT.lignes = lignesArr(); B.bac.ARR_ETAT.ouvert = 7; await B.bac.arrValider();
  test('collaboratrice : validation refusée par l\'appli (et par la base)', !B.appels.some(a => a.url.includes('/rpc/')));

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
  test('enregistrement d\'une commande : ligne nouvelle avec produit non vendable refusée', JSON.stringify(bac.venLignesRefusees([{ produitId: 'pr-a' }, { produitId: 'pr-n' }], bac.produits, null)) === JSON.stringify(['Matelas Nouveau N (fictif)']));
  test('commande déjà prise qui le contenait : reste modifiable (ligne figée)', bac.venLignesRefusees([{ produitId: 'pr-retire' }], bac.produits, { lignes: [{ produitId: 'pr-retire' }] }).length === 0);
  test('produit hors catalogue (commande du site) : comportement inchangé', bac.venLignesRefusees([{ produitId: '_custom_X' }], bac.produits, null).length === 0);
  const saveCmd = extraireFonction('function saveCmd()');
  test('saveCmd applique le refus avant tout enregistrement', saveCmd.includes('venLignesRefusees(lignes, produits, existingCmd)') && saveCmd.indexOf('venLignesRefusees') < saveCmd.indexOf('paiAvancePreparer'));
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
  test('base : déclencheur sur commandes (lignes nouvelles seulement, upsert compris)', sql.includes('create trigger commandes_produit_vendable_garde before insert or update of lignes on public.commandes') && sql.includes('select to_jsonb(c.lignes) into v_old from public.commandes c where c.id = new.id'));
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
  test('rapprochement WhatsApp : règle commune sur TOUT le catalogue, puis produits actifs', wa.includes("import { produitsVendables } from '../_shared/produits-vendables.ts';")
    && /produitsVendables\(\(data as any\[\]\) \|\| \[\]\)\.filter\(\(p: any\) => p\.actif === true\)/.test(wa) && !/from\('produits'\)\.select\('\*'\)\.eq\('actif'/.test(wa));
  test('JARVIS : même règle commune (idsNonVendables)', fs.readFileSync(path.join(racine, 'supabase', 'functions', '_shared', 'jarvis-action-logique.ts'), 'utf8').includes('const nonVendables = idsNonVendables(rows);'));
  const jl = await import('file:///' + path.join(racine, 'supabase', 'functions', '_shared', 'jarvis-action-logique.ts').replace(/\\/g, '/'));
  const catJ = jl.catalogueDepuisBase([{ id: 'n', nom: 'Matelas Nouveau N (fictif)', prix: null, vendable: false, prix_vente_defini: false }, { id: 'a', nom: 'Matelas Fictif A 140×190', prix: 100 }]);
  test('JARVIS creer_commande : produit non vendable refusé', /pas encore vendable/.test(jl.lignesCommande([{ produitId: 'n', produit: 'x', qte: 1 }], catJ).erreur || ''));
  test('JARVIS : produit vendable accepté au prix du catalogue', jl.lignesCommande([{ produitId: 'a', produit: 'x', qte: 1 }], catJ).lignes[0].prixUnit === 100);

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
  test('écran Arrivages : administrateur seulement (v7.5.137 : page hors menu, bascule Inventaire / Arrivages de la page Stock réservée à l’admin)', /admin:\{[\s\S]*?cachees:\['sante','arrivages'\][\s\S]*?collab:\{/.test(html) && html.includes("s.style.display = role==='admin' ? '' : 'none'") && !/collab:\{[\s\S]*?livreur:\{[\s\S]*?\{p:'arrivages'/.test(html.slice(html.indexOf('collab:{'), html.indexOf('function buildUI'))) && extraireFonction('async function arrInit()').includes("if (role !== 'admin')"));

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
      finaliser(a, revDef) {
        const h = hist.find(x => x.a === a && x.source === 'arrivage' && x.remplace === null);
        const lots = hist.filter(x => x.source === 'arrivage').sort((x, y) => arr[x.a].ordre - arr[y.a].ordre || (x.a < y.a ? -1 : 1) || x.id - y.id);
        let c = null, p = false, premier = true;
        for (const x of lots) {
          const corr = x.remplace ? hist.find(y => y.id === x.remplace) : null;
          const revEff = x.a === a ? revDef : (corr ? corr.rev : x.rev), provEff = x.a === a ? false : (corr ? corr.prov : x.prov);
          if (premier) { c = x.moyAv; p = x.moyAvProv; premier = false; }
          p = provApres('CUMP', x.st, c, x.q, p, provEff); c = N('CUMP', x.st, c, x.q, revEff);
        }
        const corr = { id: ++idh, a, source: 'recalcul_taux', rev: revDef, prov: false, remplace: null }; hist.push(corr); h.remplace = corr.id;
        cur = c; prov = p; arr[a].prov = false; },
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
  const valO = sql.slice(sql.indexOf('create or replace function public.valider_reception_arrivage'), sql.indexOf('create or replace function public.recalculer_revient_arrivage'));
  test('ordre de réception tiré par séquence APRÈS les verrous produits et produits_revient, enregistré sur l\'arrivage',
    valO.indexOf("v_ordre := nextval('public.arrivages_ordre_reception_seq');") > valO.indexOf('perform 1 from public.produits_revient where produit_id in')
    && valO.indexOf('perform 1 from public.produits_revient where produit_id in') > 0 && valO.includes('recu_le = clock_timestamp(), ordre_reception = v_ordre')
    && sql.includes('ordre_reception bigint unique,') && sql.includes('create sequence if not exists public.arrivages_ordre_reception_seq;'));
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
    /insert into public\.stock_entrees \(date_entree, app_produit_id, quantite, motif, cmd_id, saisi_par, remarque\)\s+values \(now\(\), l\.produit_id, v_rec, 'arrivage:' \|\| a\.reference_interne/.test(val)
    && val.indexOf('insert into public.stock_entrees') > val.indexOf('if v_rec > 0 then'));
  test('stock_entrees accepte le motif « arrivage:… » (contrainte élargie, motifs existants gardés)', sql.includes("check (motif in ('reassort', 'retour_gls', 'reprise_sav', 'correction') or motif like 'arrivage:%')"));
  test('pas de double comptage : l\'appli lit produits.stock et jamais stock_entrees', !html.includes('stock_entrees'));
  const ordre = (txt) => { const iA = txt.indexOf('from public.arrivages where id = p_arrivage_id for update'), iP = txt.indexOf('perform 1 from public.produits where id in'),
    iR = txt.indexOf('perform 1 from public.produits_revient where produit_id in'), iLit = txt.indexOf('from public.produits_revient where produit_id = l.produit_id'),
    iLitH = txt.indexOf('select * into h from public.prix_revient_historique');
    return { iA, iP, iR, iLit, iLitH, ok: iA > 0 && iP > iA && iR > iP && (iLit < 0 || iLit > iR) && (iLitH < 0 || iLitH > iR) }; };
  test('verrous de la réception : arrivage → produits → produits_revient, AVANT la lecture de l\'ancien revient', ordre(val).ok && ordre(val).iLit > 0, ordre(val));
  test('verrous du recalcul : même ordre (produits puis produits_revient) avant toute lecture', ordre(rec).ok && ordre(rec).iLitH > 0, ordre(rec));
  test('verrous triés (par id / par produit_id)', (val.match(/order by id for update/g) || []).length === 1 && (val.match(/order by produit_id for update/g) || []).length === 1
    && (rec.match(/order by id for update/g) || []).length === 1 && (rec.match(/order by produit_id for update/g) || []).length === 1);
  test('aucune commande touchée (marges passées jamais recalculées)', !/update public\.commandes|alter table public\.commandes/.test(sql));

  console.log('\n9. VERSION');
  const m = /CACHE_VERSION = 'maxiconfort-v7-5-(\d+)'/.exec(sw);
  test('CACHE_VERSION augmentée (v7-5-136 ou plus)', !!m && Number(m[1]) >= 136, m && m[0]);

  console.log('\nRÉSULTAT : ' + ok + ' tests réussis, ' + ko + ' échec(s)');
  process.exit(ko ? 1 : 0);
})().catch(e => { console.log('ERREUR : ' + (e && e.stack || e)); process.exit(1); });
