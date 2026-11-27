// Banc de test « ANCIENNE OFFRE — NE PLUS UTILISER » (v7.5.118, 09/10/2026).
// Usage : node outils/test-ancienne-offre.js
// Il EXTRAIT le vrai code de maxiconfort-v7.html (bloc AO-DEBUT … AO-FIN, buildProduitOptions, recalcTotal, getLignesData,
// sbLoadProduits, sbSaveProduit) et l'exécute dans un bac à sable : aucune connexion à la base, aucune donnée
// réelle. `fetch` est remplacé par un faux qui capture les envois ou rend un faux catalogue.
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'maxiconfort-v7.html'), 'utf8');
function extraireBloc(debut, fin) { const i = html.indexOf(debut), j = html.indexOf(fin, i); if (i < 0 || j < 0) throw new Error('bloc introuvable : ' + debut); return html.slice(i, j); }
function extraireFonction(signature) { const i = html.indexOf(signature); if (i < 0) throw new Error('fonction introuvable : ' + signature);
  let k = html.indexOf('{', i), n = 0, dansChaine = null, ech = false;
  for (let p = k; p < html.length; p++) { const ch = html[p];
    if (dansChaine) { if (ech) ech = false; else if (ch === '\\') ech = true; else if (ch === dansChaine) dansChaine = null; continue; }
    if (ch === '/' && html[p + 1] === '/') { p = html.indexOf('\n', p); continue; }
    if (ch === "'" || ch === '"' || ch === '`') { dansChaine = ch; continue; }
    if (ch === '{') n++; else if (ch === '}') { n--; if (n === 0) return html.slice(i, p + 1); } }
  throw new Error('accolade non refermée : ' + signature); }

// ---------- catalogue fictif (mêmes formes que le vrai : ensemble avec composants, pack actuel, produits simples) ----------
const ANCIEN = 'pr-ancien-blanc', ANCIEN_N = 'pr-ancien-noir', PACK15 = 'pr-pack15-blanc';
const catalogue = () => [
  { id: 'pr-lit', nom: 'Lit Coffre 140×190 Cuir PU Blanc + Sommier À Lattes', cat: 'Lit coffre', dim: '140×190 cm', prix: 249, stock: 4, seuil: 2 },
  { id: 'pr-mat', nom: 'Matelas 140×190×20', cat: 'Matelas', dim: '140×190', prix: 189, stock: 9, seuil: 2 },
  { id: ANCIEN, nom: 'Lit Coffre Blanc 140×190 + Matelas 140×190×20', cat: 'Ensemble', dim: '140×190×20', prix: 379, stock: 0, seuil: 2, composants: [{ id: 'pr-lit', qte: 1 }, { id: 'pr-mat', qte: 1 }], ancienneOffre: true },
  { id: ANCIEN_N, nom: 'Lit Coffre Noir 140×190 + Matelas 140×190×20', cat: 'Ensemble', dim: '140×190', prix: 379, stock: 0, seuil: 2, ancienneOffre: true },
  { id: PACK15, nom: 'PACK LIT COFFRE BLANC 140/190/15', cat: 'Ensemble', dim: '140X190X15', prix: 349, stock: 0, seuil: 2 },
];
// ---------- faux formulaire : une ligne = un <select> de produit + quantité + remise ----------
const option = (value, texte, dataset) => ({ value, textContent: texte, dataset: dataset || {} });
const ligne = (opt, qte, remise, type) => { const st = { textContent: '', style: {} }; return { _st: st, querySelector: s => s === '.ligne-produit' ? { value: opt ? opt.value : '', selectedOptions: opt ? [opt] : [] } : s === '.ligne-qte' ? { value: String(qte || 1) } : s === '.ligne-remise' ? { value: String(remise || 0) } : s === '.ligne-remise-type' ? { value: type || 'pct' } : s === '.ligne-sous-total' ? st : null }; };
function nouveauBac(lignes) { const envois = [], memoire = {}, champs = { 'f-remise-val': { value: '0' }, 'f-remise-type': { value: 'pct' }, 'f-total-display': { textContent: '' }, 'f-remise-display': { textContent: '', style: {} } };
  const bac = { console: { log() {}, warn() {} }, Math, Date, JSON, parseFloat, parseInt, String, Array, Object, Number, isNaN, encodeURIComponent,
    SUPABASE_URL: 'https://exemple.invalid', SUPABASE_KEY: 'cle-de-test', window: {}, commandes: [], produits: catalogue(),
    document: { getElementById: id => champs[id] || null, querySelectorAll: s => s === '#lignes-produits > div' ? (lignes || []) : [], querySelector: () => null },
    localStorage: { setItem(k, v) { memoire[k] = v; }, getItem(k) { return memoire[k] || null; } },
    fetch: async (url, opt) => { envois.push({ url, methode: (opt && opt.method) || 'GET', body: opt && opt.body ? JSON.parse(opt.body) : null }); return { ok: true, text: async () => '', json: async () => bac._reponse || [] }; },
    stkRender() { bac._rendus++; }, sbSaveEchec() { bac._echecs++; }, oqSucces() {}, // v7.5.196 / v7.5.197 : file hors sujet ici
    stkProduit(id) { return (bac.produits || []).find(p => p.id === id) || null; }, oqStockAncienSignaler() {}, // v7.5.198
    _rendus: 0, _echecs: 0, _reponse: null };
  vm.createContext(bac);
  vm.runInContext(extraireBloc('// AO-DEBUT', '// AO-FIN'), bac);
  vm.runInContext(extraireBloc('// ARR-DEBUT', '// ARR-FIN'), bac); // v7.5.136 : buildProduitOptions écarte aussi les produits non vendables
  // v7.5.192 : sbSaveProduit s'appuie sur les fonctions de refus et de fiches refusées définies juste avant elle
  vm.runInContext(extraireFonction('function oqRoleCourant()') + '\n' + extraireBloc('// v7.5.191 : refus de la base sur un produit', 'async function sbSaveProduit(p'), bac);
  for (const f of ['function buildProduitOptions()', 'function recalcTotal()', 'function getLignesData()', 'async function sbLoadProduits()', 'async function sbSaveProduit(p']) vm.runInContext(extraireFonction(f), bac);
  return { bac, envois, memoire, champs }; }
let ok = 0, ko = 0; const test = (nom, cond, det) => { if (cond) { ok++; console.log('  OK   ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (det !== undefined ? ' — ' + JSON.stringify(det) : '')); } };

(async () => {
  console.log('\n1. NOUVELLE COMMANDE : L\'ANCIENNE OFFRE N\'EST PLUS PROPOSÉE');
  let { bac } = nouveauBac(); let opts = bac.buildProduitOptions();
  test('l\'ancien pack blanc n\'est pas dans la liste de choix', !opts.includes('value="' + ANCIEN + '"'), opts);
  test('l\'ancien pack noir n\'est pas dans la liste de choix', !opts.includes('value="' + ANCIEN_N + '"'));
  test('les autres produits y sont toujours (lit, matelas, pack actuel)', ['pr-lit', 'pr-mat', PACK15].every(id => opts.includes('value="' + id + '"')));
  test('le pack actuel 15 cm est proposé à 349 €', opts.includes('PACK LIT COFFRE BLANC 140/190/15 — 349 €'), opts);
  test('la liste ne contient aucune mention de prix à 299 €', !opts.includes('299'));
  test('si le marqueur est levé côté serveur (retour arrière), l\'offre redevient sélectionnable', (() => { bac.produits.find(p => p.id === ANCIEN).ancienneOffre = false; const o = bac.buildProduitOptions(); bac.produits.find(p => p.id === ANCIEN).ancienneOffre = true; return o.includes('value="' + ANCIEN + '"'); })());

  console.log('\n2. NOUVELLE COMMANDE DU PACK ACTUEL : PRIX DU CATALOGUE');
  let B = nouveauBac([ligne(option(PACK15, 'PACK LIT COFFRE BLANC 140/190/15 — 349 €'), 1)]); bac = B.bac; bac.recalcTotal(); let l = bac.getLignesData();
  test('une ligne, produit = pack actuel', l.length === 1 && l[0].produitId === PACK15 && l[0].produit === 'PACK LIT COFFRE BLANC 140/190/15', l);
  test('prix unitaire 349 €, sous-total 349 €', l[0].prixUnit === 349 && l[0].sousTotal === 349, l[0]);
  test('total affiché 349 €', B.champs['f-total-display'].textContent.replace(/\s/g, '') === '349€', B.champs['f-total-display'].textContent);

  console.log('\n3. ANCIENNE COMMANDE ROUVERTE : PRODUIT ET PRIX D\'ORIGINE CONSERVÉS');
  const nomAncien = catalogue().find(p => p.id === ANCIEN).nom, fige = (prix) => option(ANCIEN, nomAncien + ' — ' + prix + ' € · ANCIENNE OFFRE, NE PLUS UTILISER', { ancienne: '1', prixUnit: String(prix), customNom: nomAncien });
  B = nouveauBac([ligne(fige(299), 1)]); bac = B.bac; bac.recalcTotal(); l = bac.getLignesData();
  test('commande prise à 299 € : le prix reste 299 € (pas le prix catalogue 379 €)', l.length === 1 && l[0].prixUnit === 299 && l[0].sousTotal === 299 && l[0].prixBrut === 299, l);
  test('le produit reste le même (même identifiant, même nom, sans mention ajoutée)', l[0].produitId === ANCIEN && l[0].produit === nomAncien, l[0]);
  test('total affiché 299 €', B.champs['f-total-display'].textContent.replace(/\s/g, '') === '299€', B.champs['f-total-display'].textContent);
  B = nouveauBac([ligne(fige(379), 1, 80, 'eur')]); bac = B.bac; l = bac.getLignesData();
  test('commande prise à 379 € avec 80 € de remise : inchangée (379 − 80 = 299)', l[0].prixUnit === 379 && l[0].remiseLigne === 80 && l[0].sousTotal === 299, l[0]);
  B = nouveauBac([ligne(option('_custom_Produit du site', 'Produit du site — 193.23 €', { prixUnit: '193.23', customNom: 'Produit du site' }), 2)]); l = B.bac.getLignesData();
  test('produit hors catalogue (commande du site) : comportement inchangé', l[0].produitId === '_custom_Produit du site' && l[0].produit === 'Produit du site' && l[0].prixUnit === 193.23 && l[0].qte === 2, l[0]);
  B = nouveauBac([ligne(null, 1)]); test('ligne sans produit choisi : ignorée, comme avant', B.bac.getLignesData().length === 0);

  console.log('\n3 bis. COMMANDE IMPORTÉE (3 × 19,90) DONT LE PRODUIT EST DEVENU NON VENDABLE : SIMPLE CHANGEMENT D\'ADRESSE (v7.5.152, P2 Codex PR 26)');
  {
    // ligne telle que tiktok-sync l'enregistre (prixBrut et sousTotal arrondis au centime), valeurs FICTIVES
    const NV = { id: 'pr-taie-nv', nom: 'Taie Fictive NV', cat: 'Linge', prix: 19.9, vendable: false, stock: 0, seuil: 2 };
    const origine = { produitId: '', produit: 'Taie Fictive NV', sku: 'SKU-FICTIF-1', qte: 3, prixUnit: 19.9, prixBrut: 59.7, remiseLigne: 0, remiseVal: 0, remiseType: 'pct', sousTotal: 59.7 };
    // ligne du formulaire MODIFIABLE (mêmes sélecteurs que le vrai formulaire), remplie comme à l'ouverture de la commande
    const divModifiable = () => { const opt = option(NV.id, 'Taie Fictive NV — 19.9 € · NON VENDABLE (prix à définir)', { ancienne: '1', prixUnit: '19.9', customNom: 'Taie Fictive NV' });
      const champs = { '.ligne-produit': { value: NV.id, selectedOptions: [opt] }, '.ligne-qte': { value: '3' }, '.ligne-remise': { value: '0' }, '.ligne-remise-type': { value: 'pct' }, '.ligne-sous-total': { textContent: '', style: {} } };
      return { _c: champs, querySelector: s => champs[s] || null }; };
    let d = divModifiable(); B = nouveauBac([d]); bac = B.bac; bac.produits.push(NV); bac.venMemoriserLigne(d, origine);
    l = bac.getLignesData();
    test('adresse ou date seule modifiée : la ligne figée part TELLE QUELLE (valeurs d\'origine, champs importés compris)', l.length === 1 && JSON.stringify(l[0]) === JSON.stringify(origine), l);
    test('…et l\'appli ne la refuse pas', bac.venLignesRefusees(l, bac.produits, { lignes: [origine] }).length === 0);
    test('la copie gardée est indépendante (modifier la ligne envoyée ne change pas l\'origine)', (() => { l[0].qte = 99; return bac.getLignesData()[0].qte === 3; })());
    d = divModifiable(); B = nouveauBac([d]); bac = B.bac; bac.produits.push(NV); l = bac.getLignesData();
    test('ligne recalculée (non mémorisée) : 3 * 19.9 = 59.699999999999996 acceptée quand même (comparaison au centime)', l.length === 1 && l[0].prixBrut !== 59.7 && bac.venLignesRefusees(l, bac.produits, { lignes: [origine] }).length === 0, l[0]);
    d = divModifiable(); B = nouveauBac([d]); bac = B.bac; bac.produits.push(NV); bac.venMemoriserLigne(d, origine); d._c['.ligne-qte'].value = '4'; l = bac.getLignesData();
    test('quantité changée (3 → 4) : la ligne est recalculée et refusée (produit non vendable)', l.length === 1 && l[0].qte === 4 && JSON.stringify(bac.venLignesRefusees(l, bac.produits, { lignes: [origine] })) === JSON.stringify(['Taie Fictive NV']), l[0]);
    d = divModifiable(); B = nouveauBac([d]); bac = B.bac; bac.produits.push(NV); bac.venMemoriserLigne(d, origine); d._c['.ligne-remise'].value = '5'; l = bac.getLignesData();
    test('remise changée : la ligne est recalculée (plus la ligne d\'origine) et refusée', l[0].remiseVal === 5 && bac.venLignesRefusees(l, bac.produits, { lignes: [origine] }).length === 1, l[0]);
    const dOk = { querySelector: s => s === '.ligne-produit' ? { value: 'pr-mat', selectedOptions: [option('pr-mat', 'Matelas 140×190×20 — 189 €')] } : s === '.ligne-qte' ? { value: '1' } : s === '.ligne-remise' ? { value: '0' } : s === '.ligne-remise-type' ? { value: 'pct' } : null };
    B = nouveauBac([dOk]); bac = B.bac; bac.venMemoriserLigne(dOk, { produitId: 'pr-mat', produit: 'Matelas 140×190×20', qte: 1, prixUnit: 150, sousTotal: 150 }); l = bac.getLignesData();
    test('ligne d\'un produit VENDABLE (non figée) : prix du catalogue, comme avant (la mémorisation ne vaut que pour une ligne figée)', l[0].prixUnit === 189, l[0]);
  }

  console.log('\n3 ter. ANCIENNE COMMANDE SANS LIGNES ROUVERTE : LIGNE D\'ORIGINE RECONSTRUITE (v7.5.158, revue Codex PR 26 sur 7e5c4cf)');
  {
    // valeurs FICTIVES
    const NV = { id: 'pr-taie-nv', nom: 'Taie Fictive NV', cat: 'Linge', prix: 19.9, vendable: false, stock: 0, seuil: 2 };
    const cmdNV = { id: 'CMD-FICTIVE-1', produit: 'Taie Fictive NV', qte: 3, prix: 59.7, prixBrut: 59.7, lignes: null, remiseGlobaleVal: 0, remiseGlobaleType: 'pct' };
    const cmdMat = { id: 'CMD-FICTIVE-2', produit: 'Matelas 140×190×20', qte: 1, prix: 199, fraisPort: 10, lignes: [], remiseGlobaleVal: 0, remiseGlobaleType: 'pct' };
    // ligne du formulaire remplie comme openCmd le fait (option figée ajoutée, quantité saisie)
    const divPrincipale = (b, c) => { const op = b.venOptionPrincipale(c, b.produits); const opt = option(op.value, op.texte, Object.assign({}, op.dataset));
      const ch = { '.ligne-produit': { value: op.value, selectedOptions: [opt] }, '.ligne-qte': { value: String(op.qte) }, '.ligne-remise': { value: '0' }, '.ligne-remise-type': { value: 'pct' }, '.ligne-sous-total': { textContent: '', style: {} } };
      const d = { _c: ch, _op: op, querySelector: s => ch[s] || null }; b.venMemoriserPrincipal(d, c); return d; };
    const principal = c => ({ produit: c.produit, qte: c.qte, prix: c.prix });
    B = nouveauBac([]); bac = B.bac; bac.produits.push(NV);
    let op = bac.venOptionPrincipale(cmdNV, bac.produits);
    test('produit principal devenu non vendable : option FIGÉE au même produit (même identifiant), 19,9 € l\'unité, mention non vendable',
      op.value === NV.id && op.dataset.ancienne === '1' && op.dataset.principal === '1' && op.dataset.prixUnit === '19.9' && op.dataset.customNom === 'Taie Fictive NV' && op.qte === 3 && op.texte.includes('NON VENDABLE'), op);
    op = bac.venOptionPrincipale({ produit: 'Matelas ancien modèle fictif', qte: 2, prix: 300 }, bac.produits);
    test('libellé dont seul le PREMIER MOT ressemble à un produit (« Matelas … ») : AUCUN autre produit choisi (« _custom_ » + libellé)', op.value === '_custom_Matelas ancien modèle fictif' && op.dataset.prixUnit === '150', op);
    op = bac.venOptionPrincipale(cmdMat, bac.produits);
    test('nom exact d\'un produit vendable : ce produit-là, prix unitaire hors port (199 − 10 = 189)', op.value === 'pr-mat' && op.dataset.prixUnit === '189' && !op.texte.includes('NON VENDABLE'), op);
    test('commande sans libellé : rien à reconstruire', bac.venOptionPrincipale({ produit: '  ' }, bac.produits) === null && bac.venOptionPrincipale(null, bac.produits) === null);

    let d = divPrincipale(bac, cmdNV); B = nouveauBac([d]); bac = B.bac; bac.produits.push(NV); d = divPrincipale(bac, cmdNV); B.bac.document.querySelectorAll = () => [d];
    l = bac.getLignesData();
    test('changement d\'adresse seul : le formulaire a bien une ligne (plus de refus « Ajoutez au moins un produit »), au produit commandé', l.length === 1 && l[0].produitId === NV.id && l[0].produit === 'Taie Fictive NV' && l[0].qte === 3, l);
    test('…la commande est gardée telle quelle (venPrincipalAGarder)', bac.venPrincipalAGarder(cmdNV, [d], '0', 'pct') === true);
    let garde = bac.venGarderPrincipal({ produit: 'autre', lignes: l, qte: 9, prix: 1, prixBrut: 1 }, cmdNV);
    test('…produit, quantité, prix et lignes d\'origine conservés (produit inchangé)', garde.produit === 'Taie Fictive NV' && garde.lignes === null && garde.qte === 3 && garde.prix === 59.7 && garde.prixBrut === 59.7, garde);
    test('…et le contrôle non vendable (même règle que la base) l\'accepte', bac.venLignesRefusees(cmdNV.lignes, bac.produits, cmdNV, principal(cmdNV)).length === 0);
    test('commande à lignes []: lignes [] gardées', bac.venGarderPrincipal({}, cmdMat).lignes.length === 0 && Array.isArray(bac.venGarderPrincipal({}, cmdMat).lignes));
    d = divPrincipale(bac, cmdNV); d._c['.ligne-qte'].value = '4';
    test('quantité changée (3 → 4) : la commande n\'est plus gardée telle quelle', bac.venPrincipalAGarder(cmdNV, [d], '0', 'pct') === false);
    B = nouveauBac([d]); B.bac.produits.push(NV); l = B.bac.getLignesData();
    test('…la ligne recalculée est REFUSÉE (produit non vendable modifié)', l.length === 1 && JSON.stringify(B.bac.venLignesRefusees(l, B.bac.produits, cmdNV)) === JSON.stringify(['Taie Fictive NV']), l);
    d = divPrincipale(bac, cmdNV); d._c['.ligne-remise'].value = '5';
    test('remise de ligne changée : plus gardée telle quelle', bac.venPrincipalAGarder(cmdNV, [d], '0', 'pct') === false);
    d = divPrincipale(bac, cmdNV);
    test('remise globale changée : plus gardée telle quelle', bac.venPrincipalAGarder(cmdNV, [d], '10', 'pct') === false && bac.venPrincipalAGarder(cmdNV, [d], '0', 'eur') === false);
    const dAutre = ligne(option('pr-lit', 'Lit — 249 €'), 1);
    test('autre ligne ajoutée : plus gardée telle quelle', bac.venPrincipalAGarder(cmdNV, [d, dAutre], '0', 'pct') === false);
    test('commande AVEC lignes : jamais concernée', bac.venPrincipalAGarder(Object.assign({}, cmdNV, { lignes: [{ produitId: NV.id }] }), [d], '0', 'pct') === false);
    // changement de produit VERS un non vendable : la ligne d'origine (vendable) remplacée par le produit non vendable
    B = nouveauBac([]); bac = B.bac; bac.produits.push(NV); d = divPrincipale(bac, cmdMat);
    const optNV = option(NV.id, 'Taie Fictive NV — 19.9 €'); d._c['.ligne-produit'].value = NV.id; d._c['.ligne-produit'].selectedOptions = [optNV];
    test('produit changé (matelas → produit non vendable) : plus gardée telle quelle', bac.venPrincipalAGarder(cmdMat, [d], '0', 'pct') === false);
    B = nouveauBac([d]); B.bac.produits.push(NV); l = B.bac.getLignesData();
    test('…et REFUSÉE (produit non vendable ajouté)', l.length === 1 && l[0].produitId === NV.id && JSON.stringify(B.bac.venLignesRefusees(l, B.bac.produits, cmdMat)) === JSON.stringify(['Taie Fictive NV']), l);
    d = divPrincipale(bac, cmdMat); d._c['.ligne-produit'].selectedOptions = [option('pr-mat', 'Matelas 140×190×20 — 189 €')];
    test('même produit re-choisi dans la liste (option normale, prix catalogue) : ligne recalculée, plus gardée telle quelle', bac.venPrincipalAGarder(cmdMat, [d], '0', 'pct') === false);
    d = divPrincipale(bac, cmdMat);
    test('produit vendable inchangé (simple changement d\'adresse) : gardé tel quel, accepté', bac.venPrincipalAGarder(cmdMat, [d], '0', 'pct') === true && bac.venLignesRefusees(cmdMat.lignes, bac.produits, cmdMat, principal(cmdMat)).length === 0);
  }

  console.log('\n4. HISTORIQUE ET STOCK : MENTION VISIBLE, DÉDUCTION INTACTE');
  ({ bac } = nouveauBac());
  test('libellé exact « ANCIENNE OFFRE — NE PLUS UTILISER »', bac.AO_LIBELLE === 'ANCIENNE OFFRE — NE PLUS UTILISER' && bac.aoBadge().includes('ANCIENNE OFFRE — NE PLUS UTILISER'));
  test('commande contenant l\'ancien pack : repérée', bac.aoCommande({ lignes: [{ produitId: ANCIEN, produit: nomAncien, prixUnit: 299 }] }, bac.produits) === true);
  test('commande à plusieurs lignes dont l\'ancien pack : repérée', bac.aoCommande({ lignes: [{ produitId: 'pr-mat' }, { produitId: ANCIEN_N }] }, bac.produits) === true);
  test('commande ancienne sans lignes, au nom exact de l\'ancien pack : repérée', bac.aoCommande({ produit: nomAncien }, bac.produits) === true);
  test('commande d\'un autre produit : non repérée', bac.aoCommande({ lignes: [{ produitId: PACK15 }, { produitId: '_custom_x', produit: 'Lit Coffre 140x190 Blanc' }] }, bac.produits) === false);
  test('commande vide ou absente : non repérée, sans erreur', bac.aoCommande(null, bac.produits) === false && bac.aoCommande({}, bac.produits) === false);
  const trouve = bac.produits.find(p => p.id === ANCIEN); // v7.5.198 : la base retrouve le produit par son identifiant (040)
  test('stock : l\'ancien pack est toujours retrouvé par son identifiant', !!trouve && trouve.id === ANCIEN, trouve && trouve.id);
  test('stock : ses composants (lit + matelas) sont toujours dans le catalogue', !!trouve && trouve.composants.length === 2 && trouve.composants.every(c => bac.produits.some(p => p.id === c.id)));

  console.log('\n5. CATALOGUE LU DANS LA BASE : LE MARQUEUR SUIT LA BASE, L\'APPAREIL NE PEUT PAS LE CHANGER');
  B = nouveauBac(); bac = B.bac; bac.produits.forEach(p => { delete p.ancienneOffre; });   // appareil avec un ancien catalogue en mémoire : aucune offre marquée
  test('avant lecture de la base (ancien catalogue en mémoire) : l\'offre est encore proposée', bac.buildProduitOptions().includes('value="' + ANCIEN + '"'));
  bac._reponse = [{ id: ANCIEN, nom: nomAncien, cat: 'Ensemble', dim: '140×190×20', prix: '379', stock: 20, seuil: 2, actif: true, ancienne_offre: true, composants: [{ id: 'pr-lit', qte: 1 }, { id: 'pr-mat', qte: 1 }] },
    { id: PACK15, nom: 'PACK LIT COFFRE BLANC 140/190/15', cat: 'Ensemble', dim: '140X190X15', prix: '349', stock: 0, seuil: 2, actif: true, ancienne_offre: false }];
  await bac.sbLoadProduits();
  test('après lecture de la base : l\'ancien pack est marqué', bac.aoEst(bac.produits.find(p => p.id === ANCIEN)) === true);
  test('après lecture de la base : il n\'est plus proposé', !bac.buildProduitOptions().includes('value="' + ANCIEN + '"'));
  test('après lecture de la base : il reste dans le catalogue en mémoire, avec ses composants', (bac.produits.find(p => p.id === ANCIEN).composants || []).length === 2);
  test('le pack actuel prend le prix de la base (349 €) et n\'est pas marqué', bac.produits.find(p => p.id === PACK15).prix === 349 && bac.aoEst(bac.produits.find(p => p.id === PACK15)) === false);
  const copie = JSON.parse(B.memoire.mx_produits_custom || '[]');
  test('la copie gardée sur l\'appareil est mise à jour (marqueur compris)', copie.some(p => p.id === ANCIEN && p.ancienneOffre === true) && copie.some(p => p.id === PACK15 && p.prix === 349), copie.length);
  const n0 = B.envois.length; await bac.sbSaveProduit(bac.produits.find(p => p.id === ANCIEN)); const e = B.envois[n0];
  test('enregistrement d\'une fiche produit par l\'appareil : le marqueur n\'est PAS envoyé', !!e && e.methode === 'POST' && !('ancienne_offre' in e.body) && !('ancienneOffre' in e.body), e && Object.keys(e.body));
  test('…et les autres champs partent comme avant (nom, prix, stock, composants, actif)', e.body.id === ANCIEN && e.body.nom === nomAncien && e.body.prix === 379 && e.body.actif === true && Array.isArray(e.body.composants), e.body);
  test('ligne sans marqueur dans la base (valeur absente) : non marquée', bac.aoDepuisBase({ id: 'x' }) === false && bac.aoDepuisBase({ ancienne_offre: null }) === false && bac.aoDepuisBase({ ancienne_offre: 'true' }) === false);

  console.log('\n6. LE RESTE DE L\'APPLICATION N\'EST PAS TOUCHÉ');
  const garde = s => html.includes(s);
  test('service après-vente : la liste des produits à livrer passe par la même liste de choix', garde("(typeof buildProduitOptions === 'function' ? buildProduitOptions() : '')"));
  test('fiche d\'une commande : mention ajoutée sans modifier la commande', garde("if (aoCommande(c, produits)) produitsHtml +="));
  test('stock : mention ajoutée sous le nom du produit', garde('${aoEst(p)?`<div>${aoBadge()}</div>`:\'\'}'));
  test('le chargement du catalogue lit le marqueur à deux endroits (chargement et temps réel)', html.split('ancienneOffre: aoDepuisBase(r)').length - 1 === 2);
  // 10/10/2026 : le numéro n'est plus écrit en dur (il monte à chaque mise en ligne) ;
  // on vérifie qu'il est au moins 7.5.118, la version qui a introduit « ancienne offre ».
  const versionCache = (fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8').match(/maxiconfort-v(\d+)-(\d+)-(\d+)/) || []).slice(1).map(Number);
  test('la version du cache de l\'application est au moins 7.5.118', versionCache.length === 3 && (versionCache[0] > 7 || (versionCache[0] === 7 && (versionCache[1] > 5 || (versionCache[1] === 5 && versionCache[2] >= 118)))), versionCache.join('.'));

  console.log(`\nRÉSULTAT : ${ok} tests réussis, ${ko} échec(s)`); process.exitCode = ko ? 1 : 0;
})().catch(e => { console.error('ERREUR :', e.stack || e.message); process.exit(1); });
