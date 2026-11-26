// Banc de test du correctif v7.5.191 / v7.5.192 / v7.5.193 / v7.5.194 (26/11/2026) : le « livré » du livreur ne remontait plus depuis le 24/11.
// Usage : node outils/test-livre-bloque.js
// Il EXTRAIT le vrai code de maxiconfort-v7.html (file d'attente hors ligne, sbSaveProduit, validerSig, contrôle
// admin des livraisons non remontées) et l'exécute dans un bac à sable : aucune connexion à la base, aucune
// donnée réelle. `fetch` est remplacé par un faux qui enregistre ce qui serait envoyé et répond ce qu'on lui dit.
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(process.env.MX_HTML || path.join(__dirname, '..', 'maxiconfort-v7.html'), 'utf8').replace(/\r\n/g, '\n');

function extraireBloc(debut, fin) { const i = html.indexOf(debut), j = html.indexOf(fin, i + 1); if (i < 0 || j < 0) throw new Error('bloc introuvable : ' + debut); return html.slice(i, j); }
function extraireFonction(signature) { // du mot-clé jusqu'à l'accolade fermante correspondante
  const i = html.indexOf(signature); if (i < 0) throw new Error('fonction introuvable : ' + signature);
  let k = html.indexOf('{', i), n = 0, dansChaine = null, ech = false;
  for (let p = k; p < html.length; p++) { const ch = html[p];
    if (dansChaine) { if (ech) ech = false; else if (ch === '\\') ech = true; else if (ch === dansChaine) dansChaine = null; continue; }
    if (ch === '/' && html[p + 1] === '/') { p = html.indexOf('\n', p); continue; }
    if (ch === "'" || ch === '"' || ch === '`') { dansChaine = ch; continue; }
    if (ch === '{') n++; else if (ch === '}') { n--; if (n === 0) return html.slice(i, p + 1); } }
  throw new Error('accolade non refermée : ' + signature);
}

const CODE_FILE = extraireBloc('var offlineQueue = [];', '// v7.5.68 : échec');
const CODE_ECHEC = extraireFonction('function sbSaveEchec(type, data, ctx, status, detail)');
const CODE_REJEU = extraireBloc('// v7.5.191 : un seul rejeu à la fois', '// Détecter retour en ligne');
const CODE_PRODUIT = extraireBloc('// v7.5.191 : refus de la base sur un produit', 'async function sbDeleteProduit');
const CODE_CONTROLE = extraireBloc('// v7.5.191 (bug du 24/11) : contrôle ADMIN', 'var _pollingInterval');
const CODE_SIG = extraireFonction('function validerSig()');
const CODE_STK = extraireBloc('// v7.5.192 : lance un enregistrement asynchrone', '// v7.5.79 : "Actualiser"');

function fauxElement(id) { return { id, value: '', checked: true, style: {}, dataset: {}, innerHTML: '', textContent: '', classList: { add() {}, remove() {}, contains() { return false; } } }; }

// reponse(url, opt) → { status } (réponse HTTP) ou 'reseau' (fetch qui lève)
function nouveauBac({ role = 'livreur', fileStockee = null, stockage = {}, reponse = () => ({ status: 200 }) } = {}) {
  if (fileStockee) stockage.mx_offline_queue = JSON.stringify(fileStockee);
  const els = {};
  const bac = {
    console: { log() {}, warn() {}, error() {} }, Math, Date, JSON, String, Array, Object, Number, parseInt, parseFloat, isNaN, Promise, encodeURIComponent,
    setTimeout: () => 0,
    SUPABASE_URL: 'https://exemple.invalid', SUPABASE_KEY: 'cle-de-test', role, livNom: 'LIVREUR-TEST',
    localStorage: { getItem: k => (k in stockage ? stockage[k] : null), setItem: (k, v) => { stockage[k] = String(v); bac._ecritures++; }, removeItem: k => { delete stockage[k]; } }, _ecritures: 0, _stockage: stockage,
    document: { getElementById: id => (els[id] = els[id] || fauxElement(id)), querySelectorAll: () => [], querySelector: () => null },
    toast(m, t) { bac._toasts.push([m, t]); }, _toasts: [], notifAjout(...a) { bac._notifs.push(a); }, _notifs: [],
    _envois: [],
    fetch: async (url, opt = {}) => {
      bac._envois.push({ url, method: opt.method || 'GET', body: opt.body ? JSON.parse(opt.body) : null, prefer: opt.headers && opt.headers.Prefer });
      if (bac._envois.length > 500) throw new Error('trop d\'envois : boucle ?');
      const r = reponse(url, opt);
      if (r === 'reseau') throw new Error('Failed to fetch');
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.texte || '', json: async () => (r.json !== undefined ? r.json : [{ id: 'x' }]) };
    },
    sbSaveCommande: async () => {}, sbSaveTournee: async () => {}, sbSaveDepense: async () => {}, sbSaveVehicule: async () => {}, sbSaveEntretien: async () => {}, sbSaveLivreur: async () => {},
    commandes: [], tournees: [],
  };
  vm.createContext(bac);
  vm.runInContext(CODE_FILE + '\n' + CODE_ECHEC + '\n' + CODE_REJEU + '\n' + CODE_PRODUIT + '\n' + CODE_CONTROLE, bac);
  return bac;
}

let ok = 0, ko = 0;
const test = (nom, cond, det) => { if (cond) { ok++; console.log('  OK    ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (det !== undefined ? ' — ' + JSON.stringify(det) : '')); } };
const PROD = (id, stock, nom) => ({ id, nom: nom || ('Produit ' + id), cat: 'matelas', dim: '140x190', prix: 100, stock, seuil: 2 });

(async () => {
  console.log('\n1. LE REJEU NE BOUCLE PLUS QUAND UN PRODUIT ÉCHOUE');
  {
    // ancienne version (avant la correction : refus de la base) puis coupure réseau à chaque essai
    const bac = nouveauBac({ role: 'livreur', reponse: () => 'reseau' });
    bac.offlineQueueAdd('produit', PROD('p1', 3));
    bac.offlineQueueAdd('commande', { id: '#T1', statut: 'livré' });
    // une commande qui échoue et se remet en file à chaque rejeu (comme sbSaveCommande)
    bac.sbSaveCommande = async (c) => { bac.offlineQueueAdd('commande', c); };
    await bac.offlineQueueFlush();
    test('un rejeu = au plus un envoi par élément (pas de boucle)', bac._envois.length === 1, bac._envois.length);
    test('la file ne grossit pas : un produit + une commande', bac.offlineQueue.length === 2, bac.offlineQueue.map(i => i.type));
    await bac.offlineQueueFlush(); await bac.offlineQueueFlush();
    test('trois rejeux : toujours 2 éléments, 3 envois produit au total', bac.offlineQueue.length === 2 && bac._envois.length === 3, [bac.offlineQueue.length, bac._envois.length]);
  }
  {
    const bac = nouveauBac({ role: 'livreur' });
    bac.offlineQueueAdd('commande', { id: '#T2' });
    let n = 0; bac.sbSaveCommande = async () => { n++; await new Promise(r => setImmediate(r)); };
    await Promise.all([bac.offlineQueueFlush(), bac.offlineQueueFlush()]);
    test('deux rejeux lancés en même temps : un seul rejoue (verrou)', n === 1, n);
    test('la commande rejouée avec succès quitte la file', bac.offlineQueue.length === 0, bac.offlineQueue.length);
    bac.offlineQueueAdd('commande', { id: '#T3' }); await bac.offlineQueueFlush();
    test('après le rejeu, le verrou est relâché (rejeu suivant possible)', n === 2, n);
  }
  {
    const bac = nouveauBac({ role: 'admin' });
    bac.offlineQueueAdd('commande', { id: '#T4', v: 1 });
    bac.sbSaveCommande = async (c) => { if (c.v === 1) bac.offlineQueueAdd('tournee', { id: 'T-AJ' }); };
    await bac.offlineQueueFlush();
    test('ce qui est ajouté pendant le rejeu est gardé pour le rejeu suivant', bac.offlineQueue.length === 1 && bac.offlineQueue[0].type === 'tournee', bac.offlineQueue);
  }

  console.log('\n2. LIVREUR : PATCH DU STOCK, JAMAIS D\'AJOUT (POST)');
  {
    const bac = nouveauBac({ role: 'livreur' });
    await bac.sbSaveProduit(PROD('p 7', 4));
    const e = bac._envois[0] || {};
    test('un seul envoi', bac._envois.length === 1, bac._envois.length);
    test('méthode PATCH (pas de POST)', e.method === 'PATCH', e.method);
    test('sur la fiche existante : produits?id=eq.<id>', /\/rest\/v1\/produits\?id=eq\.p%207(&|$)/.test(e.url), e.url);
    test('corps = { stock, updated_at } seulement', e.body && Object.keys(e.body).sort().join(',') === 'stock,updated_at' && e.body.stock === 4, e.body);
    test('pas de « merge-duplicates »', !/merge-duplicates/.test(e.prefer || ''), e.prefer);
    test('aucune notification, file vide', bac._notifs.length === 0 && bac.offlineQueue.length === 0);
  }
  {
    const bac = nouveauBac({ role: 'livreur', reponse: () => ({ status: 200, json: [] }) });
    await bac.sbSaveProduit(PROD('p8', 1));
    test('PATCH sans ligne modifiée : signalé, pas mis en file', bac._notifs.length === 1 && bac.offlineQueue.length === 0, [bac._notifs.length, bac.offlineQueue.length]);
  }
  for (const r of ['admin', 'collab']) {
    const bac = nouveauBac({ role: r });
    await bac.sbSaveProduit(PROD('p9', 5));
    const e = bac._envois[0] || {};
    test(r + ' : comportement inchangé (POST merge-duplicates, fiche complète)', e.method === 'POST' && /\/rest\/v1\/produits$/.test(e.url) && /merge-duplicates/.test(e.prefer) && e.body.nom === 'Produit p9' && e.body.stock === 5, [e.method, e.url, e.prefer]);
  }

  console.log('\n3. REFUS DÉFINITIF DE LA BASE (4xx) : PAS DE FILE, UNE SEULE NOTIFICATION PAR PRODUIT');
  for (const r of ['livreur', 'admin']) {
    const bac = nouveauBac({ role: r, reponse: () => ({ status: 401, texte: 'new row violates row-level security policy' }) });
    await bac.sbSaveProduit(PROD('p1', 3, 'Matelas Test 140'));
    await bac.sbSaveProduit(PROD('p1', 2, 'Matelas Test 140'));
    await bac.sbSaveProduit(PROD('p2', 2, 'Sommier Test 140'));
    test(r + ' : refus 401 → rien en file', bac.offlineQueue.length === 0, bac.offlineQueue);
    test(r + ' : une notification par produit (2 produits, 3 refus → 2 notifications)', bac._notifs.length === 2, bac._notifs.map(n => n[2]));
    const attendu = r === 'livreur' ? 'Stock non mis à jour : Matelas Test 140 — à vérifier' : 'Fiche produit non enregistrée : Matelas Test 140 (refus de la base) — à vérifier';
    test(r + ' : texte « ' + attendu + ' »', bac._notifs[0] && bac._notifs[0][2] === attendu, bac._notifs[0] && bac._notifs[0][2]);
    test(r + ' : pas de toast « réessai auto »', !bac._toasts.some(t => /réessai/.test(t[0])), bac._toasts);
  }
  {
    const bac = nouveauBac({ role: 'livreur', reponse: () => 'reseau' });
    await bac.sbSaveProduit(PROD('p1', 3)); await bac.sbSaveProduit(PROD('p1', 2)); await bac.sbSaveProduit(PROD('p2', 9));
    test('vraie coupure réseau → en file', bac.offlineQueue.length === 2, bac.offlineQueue.length);
    test('une seule entrée par produit, la plus récente (stock 2)', bac.offlineQueue.filter(i => i.data.id === 'p1').length === 1 && bac.offlineQueue.find(i => i.data.id === 'p1').data.stock === 2);
    test('les nouveaux éléments portent le rôle qui les a mis en file', bac.offlineQueue.every(i => i.role === 'livreur' && i.oqv === 2), bac.offlineQueue.map(i => i.role));
  }
  {
    const bac = nouveauBac({ role: 'livreur', reponse: () => ({ status: 403 }) });
    bac.offlineQueue.push({ type: 'produit', data: PROD('p3', 1), ts: 1, oqv: 2 });
    await bac.offlineQueueFlush();
    test('rejeu d\'un produit refusé (403) : retiré de la file, pas remis', bac.offlineQueue.length === 0 && bac._envois.length === 1, [bac.offlineQueue.length, bac._envois.length]);
  }

  console.log('\n3 bis. (A) ERREURS TEMPORAIRES : GARDÉES EN FILE ET REJOUÉES');
  for (const r of ['livreur', 'admin', 'collab']) {
    for (const st of [408, 425, 429, 500, 502, 503, 504, 520]) {
      const bac = nouveauBac({ role: r, reponse: () => ({ status: st, texte: 'temporaire' }) });
      await bac.sbSaveProduit(PROD('p1', 3, 'Matelas T'));
      const methode = (bac._envois[0] || {}).method;
      test(r + ' : HTTP ' + st + ' (' + methode + ') → gardé en file, aucune notification de refus', bac.offlineQueue.length === 1 && bac.offlineQueue[0].data.id === 'p1' && bac._notifs.length === 0, [bac.offlineQueue.length, bac._notifs.map(n => n[2])]);
    }
    for (const st of [400, 401, 403, 404, 409, 422, 418]) {
      const bac = nouveauBac({ role: r, reponse: () => ({ status: st }) });
      await bac.sbSaveProduit(PROD('p1', 3, 'Matelas T'));
      test(r + ' : HTTP ' + st + ' → refus définitif (pas de file, une notification)', bac.offlineQueue.length === 0 && bac._notifs.length === 1, [bac.offlineQueue.length, bac._notifs.length]);
    }
  }
  {
    // une 503 au premier envoi, puis la base répond : la valeur finit par arriver (le stock n'est pas faussé)
    let n = 0;
    const bac = nouveauBac({ role: 'livreur', reponse: () => (++n === 1 ? { status: 503 } : { status: 200, json: [{ id: 'p1' }] }) });
    await bac.sbSaveProduit(PROD('p1', 6));
    test('503 : en file', bac.offlineQueue.length === 1);
    await bac.offlineQueueFlush();
    test('rejeu après la panne : PATCH du stock 6 envoyé, file vide', bac.offlineQueue.length === 0 && bac._envois.length === 2 && bac._envois[1].method === 'PATCH' && bac._envois[1].body.stock === 6, [bac.offlineQueue.length, bac._envois.map(e => e.method)]);
  }
  {
    // panne qui dure : à chaque rejeu un seul envoi, la file reste à un élément (rejeu borné, pas de boucle)
    const bac = nouveauBac({ role: 'admin', reponse: () => ({ status: 502 }) });
    await bac.sbSaveProduit(PROD('p1', 6));
    await bac.offlineQueueFlush(); await bac.offlineQueueFlush(); await bac.offlineQueueFlush();
    test('panne durable : 1 élément en file, 4 envois au total (1 + 3 rejeux)', bac.offlineQueue.length === 1 && bac._envois.length === 4, [bac.offlineQueue.length, bac._envois.length]);
  }
  {
    // déduction de stock du livreur : 504 pendant la livraison → la valeur déduite reste en file pour le rejeu
    const bac = nouveauBac({ role: 'livreur', reponse: () => ({ status: 504 }) });
    Object.assign(bac, { produits: [PROD('p1', 5, 'Matelas D')], stkMouvements: [], finRender() {}, stkRender() {} });
    bac.stkTrouverProduit = () => bac.produits[0];
    bac.commandes = [{ id: '#D1', produit: 'Matelas D', qte: 2, client: 'Client Test' }];
    vm.runInContext(CODE_STK, bac);
    bac.stkDeduireStock('#D1');
    for (let k = 0; k < 5; k++) await new Promise(r => setImmediate(r));
    const it = bac.offlineQueue.find(i => i.type === 'produit');
    test('stkDeduireStock + 504 : la nouvelle valeur (3) reste en file pour le rejeu', it && it.data.stock === 3, bac.offlineQueue);
  }

  console.log('\n4. (B, C) ANCIENS ÉLÉMENTS PRODUIT : TRI SELON LE RÔLE, RÉCAPITULATIF DURABLE');
  const ANCIENNE = () => [
    { type: 'produit', data: PROD('p1', 5, 'Matelas A'), ts: 1 },
    { type: 'commande', data: { id: '#9001', statut: 'livré' }, ts: 2 },
    { type: 'produit', data: PROD('p1', 4, 'Matelas A'), ts: 3 },
    { type: 'produit', data: PROD('p2', 7, 'Sommier B'), ts: 4 },
    { type: 'tournee', data: { id: 'T-1' }, ts: 5 },
  ];
  const recapDe = (st) => { try { return JSON.parse(st.mx_oq_purge_recap || 'null'); } catch (e) { return null; } };
  {
    const bac = nouveauBac({ role: null, fileStockee: ANCIENNE() });
    test('au chargement (rôle pas encore connu) : rien n\'est retiré', bac.offlineQueue.length === 5, bac.offlineQueue.length);
    await bac.offlineQueueFlush();
    test('rôle inconnu : aucun rejeu (attente de la connexion)', bac._envois.length === 0 && bac.offlineQueue.length === 5, [bac._envois.length, bac.offlineQueue.length]);
    bac.role = 'livreur'; bac.oqAppliquerRole('livreur'); // = loginOk('livreur')
    test('session livreur : les 3 éléments produit sont retirés', bac.offlineQueue.filter(i => i.type === 'produit').length === 0, bac.offlineQueue.map(i => i.type));
    test('commande et tournée restent en file', bac.offlineQueue.map(i => i.type).join(',') === 'commande,tournee');
    test('la file nettoyée est réécrite dans le téléphone', JSON.parse(bac._stockage.mx_offline_queue).length === 2);
    test('le récapitulatif est gardé dans le téléphone (clé mx_oq_purge_recap)', (recapDe(bac._stockage) || {}).n === 3, bac._stockage.mx_oq_purge_recap);
    test('pas de notification avant le démarrage de l\'appli', bac._notifs.length === 0);
    bac.oqSignalerPurge();
    const n = bac._notifs[0] || [];
    test('ensuite : UNE notification récapitulative', bac._notifs.length === 1, bac._notifs.length);
    test('elle dit « 3 mises à jour de stock anciennes non envoyées (produits : Matelas A, Sommier B) — stock à vérifier à l\'inventaire »', /^3 mises à jour de stock anciennes non envoyées \(produits : Matelas A, Sommier B\) — stock à vérifier à l'inventaire/.test(n[3] || ''), n[3]);
    test('récapitulatif effacé une fois la notification créée', !('mx_oq_purge_recap' in bac._stockage));
    bac.oqSignalerPurge();
    test('une seule fois', bac._notifs.length === 1);
    await bac.offlineQueueFlush();
    test('le rejeu n\'envoie aucun ancien stock', !bac._envois.some(e => /produits/.test(e.url)), bac._envois.map(e => e.url));
  }
  {
    // C : rechargement AVANT que la notification ait été créée
    const stockage = {};
    const bac1 = nouveauBac({ role: null, fileStockee: ANCIENNE(), stockage });
    bac1.role = 'livreur'; bac1.oqAppliquerRole('livreur');
    bac1.notifAjout = () => { throw new Error('pas prêt'); }; // notification impossible à ce moment-là
    bac1.oqSignalerPurge();
    test('notification pas créée : récapitulatif conservé', (recapDe(stockage) || {}).n === 3);
    const bac2 = nouveauBac({ role: null, stockage }); // rechargement de la page, avant la connexion
    test('après rechargement : la file reste nettoyée (2 éléments)', bac2.offlineQueue.length === 2, bac2.offlineQueue.length);
    test('après rechargement : récapitulatif toujours là', (recapDe(stockage) || {}).n === 3);
    bac2.role = 'livreur'; bac2.oqAppliquerRole('livreur'); bac2.oqSignalerPurge();
    test('après connexion : la notification récapitulative est créée (3, Matelas A, Sommier B)', bac2._notifs.length === 1 && /^3 mises à jour de stock anciennes non envoyées \(produits : Matelas A, Sommier B\)/.test(bac2._notifs[0][3]), bac2._notifs.map(x => x[3]));
    test('puis le récapitulatif est effacé', !('mx_oq_purge_recap' in stockage));
  }
  {
    // C : rechargement avant même la connexion (tri pas encore fait) : les anciens éléments attendent, rien n'est perdu
    const stockage = {};
    nouveauBac({ role: null, fileStockee: ANCIENNE(), stockage });
    const bac2 = nouveauBac({ role: null, stockage });
    test('rechargement avant connexion : anciens éléments toujours en file, pas de récapitulatif prématuré', bac2.offlineQueue.length === 5 && !('mx_oq_purge_recap' in stockage));
  }
  for (const r of ['admin', 'collab']) {
    // B : appareil admin / collab : les anciennes fiches complètes sont CONSERVÉES (une par produit, la plus récente)
    const bac = nouveauBac({ role: null, fileStockee: ANCIENNE() });
    bac.role = r; bac.oqAppliquerRole(r);
    const prods = bac.offlineQueue.filter(i => i.type === 'produit');
    test(r + ' : anciennes fiches conservées, une par produit (p1, p2)', prods.map(i => i.data.id).sort().join(',') === 'p1,p2', prods.map(i => i.data.id));
    test(r + ' : la plus récente gardée (p1 stock 4, ts 3)', (prods.find(i => i.data.id === 'p1') || { data: {} }).data.stock === 4);
    test(r + ' : commande et tournée intactes', bac.offlineQueue.filter(i => i.type !== 'produit').map(i => i.type).join(',') === 'commande,tournee');
    test(r + ' : aucune notification de purge, aucun récapitulatif', bac._notifs.length === 0 && !('mx_oq_purge_recap' in bac._stockage));
    await bac.offlineQueueFlush();
    const envoisP = bac._envois.filter(e => /produits/.test(e.url));
    test(r + ' : rejouées (2 upserts POST de fiches complètes), file vide', envoisP.length === 2 && envoisP.every(e => e.method === 'POST' && e.body.nom) && bac.offlineQueue.length === 0, envoisP.map(e => [e.method, e.body && e.body.id]));
  }
  {
    // B : rejeu lancé alors que le rôle est déjà connu : le tri est fait AVANT le rejeu
    const bac = nouveauBac({ role: 'admin', fileStockee: ANCIENNE() });
    await bac.offlineQueueFlush();
    test('rejeu avec rôle connu : tri fait avant le rejeu (2 fiches rejouées)', bac._envois.filter(e => /produits/.test(e.url)).length === 2);
  }
  {
    const bac = nouveauBac({ role: 'livreur', fileStockee: [{ type: 'produit', data: PROD('p5', 2), ts: 1, oqv: 2 }] });
    bac.oqAppliquerRole('livreur');
    test('un produit mis en file par la version corrigée (coupure réseau) est gardé', bac.offlineQueue.length === 1);
    bac.oqSignalerPurge();
    test('et ne déclenche pas la notification de purge', bac._notifs.length === 0);
  }
  {
    const bac = nouveauBac({ fileStockee: [{ type: 'commande', data: { id: '#1' }, ts: 1 }] });
    bac.oqAppliquerRole('livreur'); bac.oqSignalerPurge();
    test('file sans ancien produit : aucune notification', bac._notifs.length === 0 && bac.offlineQueue.length === 1);
  }

  console.log('\n4 bis. (D) FICHE PRODUIT ADMIN / COLLAB REFUSÉE : GARDÉE ET RELANÇABLE');
  for (const r of ['admin', 'collab']) {
    let refus = true;
    const bac = nouveauBac({ role: r, reponse: () => (refus ? { status: 422, texte: 'violation' } : { status: 201 }) });
    await bac.sbSaveProduit(PROD('p1', 3, 'Matelas R'));
    await bac.sbSaveProduit(Object.assign(PROD('p1', 2, 'Matelas R'), { prix: 120 }));
    const liste = JSON.parse(bac._stockage.mx_produits_refuses || '{}');
    test(r + ' : fiche gardée dans mx_produits_refuses, une par id, la plus récente (stock 2, prix 120)', Object.keys(liste).join(',') === 'p1' && liste.p1.data.stock === 2 && liste.p1.data.prix === 120 && liste.p1.status === 422, liste);
    test(r + ' : notification « Fiche produit non enregistrée : Matelas R (refus de la base) — à vérifier » (une seule)', bac._notifs.length === 1 && bac._notifs[0][2] === 'Fiche produit non enregistrée : Matelas R (refus de la base) — à vérifier', bac._notifs.map(n => n[2]));
    const btn = bac.document.getElementById('stk-refus-btn');
    test(r + ' : bouton « Relancer » visible sur la page Stock', btn.style.display === '' && /Relancer 1 fiche/.test(btn.textContent), [btn.style.display, btn.textContent]);
    await bac.produitsRefusesRelancer();
    test(r + ' : relance encore refusée → fiche toujours gardée, nouvelle notification', 'p1' in JSON.parse(bac._stockage.mx_produits_refuses || '{}') && bac._notifs.length === 2);
    refus = false;
    const nEnv = bac._envois.length;
    const n = await bac.produitsRefusesRelancer();
    test(r + ' : relance acceptée → fiche complète renvoyée puis retirée de la liste', n === 1 && bac._envois.length === nEnv + 1 && bac._envois[nEnv].body.prix === 120 && !('mx_produits_refuses' in bac._stockage), [n, bac._stockage.mx_produits_refuses]);
    test(r + ' : bouton masqué ensuite', btn.style.display === 'none');
  }
  {
    const bac = nouveauBac({ role: 'livreur', reponse: () => ({ status: 403 }) });
    await bac.sbSaveProduit(PROD('p1', 3, 'Matelas L'));
    test('livreur : pas de liste de fiches (stock en valeur absolue, rien à relancer)', !('mx_produits_refuses' in bac._stockage));
    test('livreur : relance impossible', (await bac.produitsRefusesRelancer()) === 0 && bac._envois.length === 1);
  }

  console.log('\n5. (F) validerSig ENREGISTRE LA COMMANDE MÊME SI LA DÉDUCTION DU STOCK ÉCHOUE');
  const rejetsNonTraites = [];
  process.on('unhandledRejection', (e) => { rejetsNonTraites.push(e && e.message); });
  function bacSignature(deduction) {
    const bac = nouveauBac({ role: 'livreur' });
    const ordre = [];
    Object.assign(bac, {
      clearSig() {}, renderLivreur() {}, renderTournees() {}, renderCmds() {}, renderDash() {}, confirm: () => false, genererBonLivraison() {},
      brevoSendSMS: async () => false, societe: { tel: '' }, paiTraceEncaissement: () => '',
      sbSaveTournee(t) { ordre.push('tournee'); },
      sbSaveCommande: async (c) => { ordre.push('commande:' + c.statut); },
      stkDeduireStock(id) { ordre.push('stock'); if (deduction === 'leve') throw new Error('produit introuvable'); if (deduction === 'rejette') return Promise.reject(new Error('déduction rejetée')); },
    });
    vm.runInContext('var sigStopId=null, sigPaieEncaisse=false, sigPaieMode="Espèces", sigPrepaidMode=null, sigCmdMarketplace=null, sigCodActif=false, sigCodChoix=null, sigCodMontant=0;', bac);
    vm.runInContext(CODE_SIG, bac);
    bac.commandes = [{ id: '#T10', client: 'Client Test', prix: 100, statut: 'en-route', paie: 'Espèces', stpaie: 'Non payé', montantEnc: 0 }];
    bac.tournees = [{ id: 'T-10', livreur: 'LIVREUR-TEST', statut: 'en cours', stops: [{ cmdId: '#T10', client: 'Client Test', produit: 'Matelas', prix: 100, statut: 'en-route' }] }];
    bac.document.getElementById('sig-nom').value = 'Client Test';
    vm.runInContext('sigStopId = { tid: "T-10", idx: 0 }; sigPrepaidMode = "Déjà payé";', bac);
    return { bac, ordre };
  }
  for (const cas of ['normal', 'leve', 'rejette']) {
    const { bac, ordre } = bacSignature(cas);
    let erreur = null;
    try { bac.validerSig(); } catch (e) { erreur = e; }
    for (let k = 0; k < 5; k++) await new Promise(r => setImmediate(r));
    const lib = cas === 'leve' ? 'déduction qui lève' : cas === 'rejette' ? 'déduction qui rejette une promesse' : 'déduction normale';
    test(lib + ' : validerSig ne lève pas', erreur === null, erreur && erreur.message);
    test(lib + ' : commande enregistrée « livré »', ordre.includes('commande:livré'), ordre);
    test(lib + ' : la commande est enregistrée AVANT la déduction du stock', ordre.indexOf('commande:livré') >= 0 && ordre.indexOf('commande:livré') < ordre.indexOf('stock'), ordre);
    test(lib + ' : la tournée est enregistrée aussi', ordre.includes('tournee'), ordre);
    test(lib + ' : arrêt et commande passés à « livré »', bac.tournees[0].stops[0].statut === 'livré' && bac.commandes[0].statut === 'livré');
  }
  {
    // la déduction du stock ne tourne qu'après la FIN de l'enregistrement de la commande
    const { bac, ordre } = bacSignature('normal');
    let finir; bac.sbSaveCommande = (c) => { ordre.push('commande:debut'); return new Promise(r => { finir = () => { ordre.push('commande:fin'); r(); }; }); };
    bac.validerSig();
    await new Promise(r => setImmediate(r));
    test('pas de déduction tant que l\'enregistrement n\'est pas fini', !ordre.includes('stock'), ordre);
    finir(); await new Promise(r => setImmediate(r));
    test('déduction juste après la fin de l\'enregistrement', ordre.indexOf('commande:fin') < ordre.indexOf('stock'), ordre);
  }
  {
    // VRAIE fonction stkDeduireStock, dont les enregistrements asynchrones (produit, commande) rejettent
    const { bac, ordre } = bacSignature('normal');
    let nCmd = 0;
    Object.assign(bac, { produits: [PROD('p1', 5, 'Matelas S')], stkMouvements: [], finRender() {}, stkRender() {} });
    bac.stkTrouverProduit = () => bac.produits[0];
    vm.runInContext(CODE_STK, bac); // remplace le faux stkDeduireStock par le vrai
    bac.sbSaveProduit = async () => { ordre.push('produit:rejet'); throw new Error('panne produit'); };
    bac.sbSaveCommande = async (c) => { nCmd++; ordre.push('commande:' + c.statut + (nCmd > 1 ? ':rejet' : '')); if (nCmd > 1) throw new Error('panne commande'); };
    bac.commandes[0].produit = 'Matelas S';
    let erreur = null;
    try { bac.validerSig(); } catch (e) { erreur = e; }
    for (let k = 0; k < 10; k++) await new Promise(r => setImmediate(r));
    test('vraie déduction, enregistrements qui rejettent : validerSig ne lève pas', erreur === null, erreur && erreur.message);
    test('vraie déduction : commande enregistrée « livré » d\'abord, puis stock (rejeté) traité', ordre[0] === 'commande:livré' && ordre.includes('produit:rejet') && ordre.includes('commande:livré:rejet'), ordre);
    test('vraie déduction : stock local déduit (5 → 4) et commande toujours « livré »', bac.produits[0].stock === 4 && bac.commandes[0].statut === 'livré', [bac.produits[0].stock, bac.commandes[0].statut]);
  }
  await new Promise(r => setTimeout(r, 20));
  test('aucun rejet de promesse non traité pendant toute la section 5', rejetsNonTraites.length === 0, rejetsNonTraites);

  console.log('\n6. (E) CONTRÔLE ADMIN : LIVRAISON NON REMONTÉE (LECTURE SEULE)');
  {
    // #5 n'est pas dans la liste chargée : son statut est lu en base (ici « livré » → rien à signaler)
    const bac = nouveauBac({ role: 'admin', reponse: (url) => (/commandes\?select=id,statut&id=eq\.%235$/.test(url) ? { status: 200, json: [{ id: '#5', statut: 'livré' }] } : { status: 500 }) });
    bac.tournees = [{ id: 'T-1', stops: [{ cmdId: '#1', statut: 'livré' }, { cmdId: '#2', statut: 'livré' }, { cmdId: '#3', statut: 'livré' }, { cmdId: '#4', statut: 'en-route' }, { cmdId: '#5', statut: 'livré' }] }];
    bac.commandes = [{ id: '#1', statut: 'en-route' }, { id: '#2', statut: 'livré' }, { id: '#3', statut: 'annulé' }, { id: '#4', statut: 'en-route' }];
    test('écarts dans la liste : seulement #1 (livrée, annulée, en route ignorées)', JSON.stringify(bac.livNonRemontees(bac.tournees, bac.commandes)) === '["#1"]', bac.livNonRemontees(bac.tournees, bac.commandes));
    test('commande absente de la liste : #5 (à lire en base)', JSON.stringify(bac.livNonRemonteesAbsentes(bac.tournees, bac.commandes)) === '["#5"]');
    const t0 = 1000000;
    await bac.livControleNonRemontees(t0);
    test('premier constat : pas encore d\'alerte, aucune lecture (laisse le temps au livreur d\'enregistrer)', bac._notifs.length === 0 && bac._envois.length === 0);
    await bac.livControleNonRemontees(t0 + 60000);
    test('après 1 min : toujours pas d\'alerte ni de lecture', bac._notifs.length === 0 && bac._envois.length === 0);
    await bac.livControleNonRemontees(t0 + 130000);
    test('après 2 min : une alerte « Livraison non remontée : #1 — vérifier »', bac._notifs.length === 1 && bac._notifs[0][2] === 'Livraison non remontée : #1 — vérifier', bac._notifs.map(n => n[2]));
    test('après 2 min : statut de #5 lu en base (GET select=id,statut, id=eq.)', bac._envois.length === 1 && bac._envois[0].method === 'GET' && /\/rest\/v1\/commandes\?select=id,statut&id=eq\.%235$/.test(bac._envois[0].url), bac._envois.map(e => [e.method, e.url]));
    await bac.livControleNonRemontees(t0 + 400000);
    test('une seule fois par commande et par session (ni nouvelle alerte, ni nouvelle lecture)', bac._notifs.length === 1 && bac._envois.length === 1, [bac._notifs.length, bac._envois.length]);
    test('aucune écriture (seulement des lectures GET)', bac._envois.every(e => e.method === 'GET') && bac.commandes[0].statut === 'en-route');
  }
  for (const [lib, rep, attendu] of [
    ['en base « en-route »', { status: 200, json: [{ id: '#7', statut: 'en-route' }] }, 'Livraison non remontée : #7 — vérifier'],
    ['introuvable en base', { status: 200, json: [] }, 'Livraison non remontée : #7 — commande introuvable'],
    ['en base « annulé »', { status: 200, json: [{ id: '#7', statut: 'annulé' }] }, null],
  ]) {
    const bac = nouveauBac({ role: 'admin', reponse: () => rep });
    bac.tournees = [{ id: 'T-7', stops: [{ cmdId: '#7', statut: 'livré' }] }]; bac.commandes = [];
    await bac.livControleNonRemontees(1000); await bac.livControleNonRemontees(130000); await bac.livControleNonRemontees(400000);
    if (attendu) test('commande absente de la liste, ' + lib + ' : une alerte « ' + attendu + ' »', bac._notifs.length === 1 && bac._notifs[0][2] === attendu && bac._envois.length === 1, [bac._notifs.map(n => n[2]), bac._envois.length]);
    else test('commande absente de la liste, ' + lib + ' : pas d\'alerte, une seule lecture', bac._notifs.length === 0 && bac._envois.length === 1, [bac._notifs.length, bac._envois.length]);
  }
  {
    // lecture impossible (panne ou réseau) : pas d'alerte, nouvelle tentative au contrôle suivant
    let n = 0;
    const bac = nouveauBac({ role: 'admin', reponse: () => (++n === 1 ? 'reseau' : n === 2 ? { status: 503 } : { status: 200, json: [{ id: '#8', statut: 'en-route' }] }) });
    bac.tournees = [{ id: 'T-8', stops: [{ cmdId: '#8', statut: 'livré' }] }]; bac.commandes = [];
    await bac.livControleNonRemontees(1000); await bac.livControleNonRemontees(130000);
    test('lecture en échec (réseau) : pas d\'alerte', bac._notifs.length === 0 && bac._envois.length === 1);
    await bac.livControleNonRemontees(160000);
    test('lecture en échec (503) : pas d\'alerte', bac._notifs.length === 0 && bac._envois.length === 2);
    await bac.livControleNonRemontees(190000); await bac.livControleNonRemontees(220000);
    test('lecture réussie ensuite : une alerte, plus aucune lecture', bac._notifs.length === 1 && bac._envois.length === 3, [bac._notifs.length, bac._envois.length]);
  }
  {
    const bac = nouveauBac({ role: 'admin' });
    bac.tournees = [{ id: 'T-1', stops: [{ cmdId: '#1', statut: 'livré' }] }];
    bac.commandes = [{ id: '#1', statut: 'en-route' }];
    await bac.livControleNonRemontees(1000);
    bac.commandes[0].statut = 'livré'; await bac.livControleNonRemontees(5000); // remontée entre-temps
    bac.commandes[0].statut = 'en-route'; await bac.livControleNonRemontees(130000);
    test('un écart résorbé repart de zéro (pas d\'alerte sur un écart de quelques secondes)', bac._notifs.length === 0);
  }
  for (const r of ['livreur', 'collab']) {
    const bac = nouveauBac({ role: r });
    bac.tournees = [{ id: 'T-1', stops: [{ cmdId: '#1', statut: 'livré' }, { cmdId: '#9', statut: 'livré' }] }]; bac.commandes = [{ id: '#1', statut: 'en-route' }];
    await bac.livControleNonRemontees(1); await bac.livControleNonRemontees(500000);
    test(r + ' : pas de contrôle ni de lecture (administrateur seulement)', bac._notifs.length === 0 && bac._envois.length === 0);
  }

  console.log('\n8. (P2, v7.5.193) LE « LIVRÉ » VALIDÉ N\'EST JAMAIS ANNULÉ PAR UNE RELÈVE PÉRIMÉE');
  function bacLivraison() {
    const { bac } = bacSignature('normal');
    Object.assign(bac, { produits: [PROD('p1', 5, 'Matelas P')], stkMouvements: [], finRender() {}, stkRender() {} });
    bac.stkTrouverProduit = () => bac.produits[0];
    vm.runInContext(CODE_STK, bac); // vraie fonction stkDeduireStock
    bac.sbSaveProduit = async () => {};
    bac.commandes[0].produit = 'Matelas P'; bac.commandes[0].stockDeduit = false;
    const saves = []; let finir = null;
    bac.sbSaveCommande = (c) => { saves.push({ statut: c.statut, stockDeduit: !!c.stockDeduit, stpaie: c.stpaie, montantEnc: c.montantEnc });
      if (saves.length === 1) return new Promise(r => { finir = r; }); return Promise.resolve(); };
    return { bac, saves, finirPremier: () => finir && finir() };
  }
  const ANCIEN = (min) => new Date(Date.now() - (min || 1) * 60000).toISOString();
  const perimee = (extra) => Object.assign({ id: '#T10', client: 'Client Test', prix: 100, statut: 'en-route', paie: 'Espèces', stpaie: 'Non payé', montantEnc: 0, stockDeduit: true, updatedAt: ANCIEN(1) }, extra || {});
  {
    // scénario exact de la revue : une relève lit l'ancien statut pendant le premier enregistrement
    const { bac, saves, finirPremier } = bacLivraison();
    bac.validerSig();
    await new Promise(r => setImmediate(r));
    const valide = bac.commandes[0];
    test('pendant le 1er enregistrement : 1 seule sauvegarde {livré, stockDeduit:false}', saves.length === 1 && saves[0].statut === 'livré' && saves[0].stockDeduit === false, saves);
    const changé = bac.cmdPollingAppliquer(perimee());
    test('relève périmée (en-route) pendant l\'enregistrement : refusée, la liste garde l\'objet validé', changé === false && bac.commandes[0] === valide && bac.commandes[0].statut === 'livré', [changé, bac.commandes[0].statut]);
    test('Realtime pendant l\'enregistrement : même une version « plus récente » est refusée (verrou)', bac.cmdDistanteAcceptable(valide, perimee({ updatedAt: new Date(Date.now() + 60000).toISOString() })) === false);
    finirPremier();
    for (let k = 0; k < 10; k++) await new Promise(r => setImmediate(r));
    test('2e sauvegarde = {livré, stockDeduit:true} (et non {en-route, stockDeduit:true})', saves.length === 2 && saves[1].statut === 'livré' && saves[1].stockDeduit === true, saves);
    test('l\'encaissement est conservé dans la 2e sauvegarde (Payé, 100)', saves[1].stpaie === 'Payé' && saves[1].montantEnc === 100, saves[1]);
    test('stock déduit une fois (5 → 4)', bac.produits[0].stock === 4, bac.produits[0].stock);
    test('verrou relâché à la fin', !bac._livEnCours['#T10']);
    test('après la fin : relève périmée (updated_at antérieur au « livré ») toujours refusée', bac.cmdPollingAppliquer(perimee()) === false && bac.commandes[0].statut === 'livré');
    test('après la fin : version sans updated_at et non livrée refusée', bac.cmdPollingAppliquer(perimee({ updatedAt: '' })) === false && bac.commandes[0].statut === 'livré');
    const plusRecente = perimee({ statut: 'reporté', updatedAt: new Date(Date.now() + 60000).toISOString() });
    test('après la fin : version PLUS RÉCENTE (correction admin) acceptée', bac.cmdPollingAppliquer(plusRecente) === true && bac.commandes[0].statut === 'reporté');
  }
  {
    // ceinture et bretelles : même si la liste a été remplacée pendant l'enregistrement, la déduction
    // travaille sur l'objet validé, et la liste le récupère à la fin
    const { bac, saves, finirPremier } = bacLivraison();
    bac.validerSig();
    await new Promise(r => setImmediate(r));
    const valide = bac.commandes[0];
    bac.commandes[0] = perimee(); bac.commandes[0].stockDeduit = false; // remplacement forcé (ancien comportement)
    finirPremier();
    for (let k = 0; k < 10; k++) await new Promise(r => setImmediate(r));
    test('liste remplacée de force : la 2e sauvegarde reste {livré, stockDeduit:true}', saves.length === 2 && saves[1].statut === 'livré' && saves[1].stockDeduit === true, saves);
    test('liste remplacée de force : l\'objet validé y est remis à la fin', bac.commandes[0] === valide && bac.commandes[0].statut === 'livré');
  }
  {
    // témoin : l'ancien appel (recherche dans la liste) reproduisait bien le bug
    const { bac, saves } = bacLivraison();
    bac.commandes[0] = perimee({ stockDeduit: false });
    bac.stkDeduireStock('#T10');
    test('témoin : sans l\'objet validé, la déduction réenregistrait {en-route, stockDeduit:true}', saves.length === 1 && saves[0].statut === 'en-route' && saves[0].stockDeduit === true, saves);
  }
  {
    // rechargement complet (sbLoadAll) : la version locale livrée est gardée si la version lue est périmée
    const bac = nouveauBac({ role: 'livreur' });
    const loc = { id: '#R1', statut: 'livré' }, autre = { id: '#R2', statut: 'en-attente' };
    bac.livMarquer('#R1');
    const res = bac.cmdFusionnerChargees([{ id: '#R1', statut: 'en-route', updatedAt: ANCIEN(5) }, { id: '#R2', statut: 'confirmé', updatedAt: ANCIEN(5) }], [loc, autre]);
    test('rechargement : commande livrée localement gardée face à une version périmée', res[0] === loc, res[0]);
    test('rechargement : les autres commandes sont bien remplacées par la base', res[1].statut === 'confirmé');
    const res2 = bac.cmdFusionnerChargees([{ id: '#R1', statut: 'annulé', updatedAt: new Date(Date.now() + 1000).toISOString() }], [loc]);
    test('rechargement : version plus récente acceptée', res2[0].statut === 'annulé');
  }
  {
    // aucune livraison locale : la relève fonctionne comme avant
    const bac = nouveauBac({ role: 'admin' });
    bac.commandes = [{ id: '#N1', statut: 'en-attente', stpaie: 'Non payé', livreur: '', montantEnc: 0, paie: 'Espèces' }];
    test('sans « livré » local : un changement distant remplace la commande', bac.cmdPollingAppliquer({ id: '#N1', statut: 'en-route', stpaie: 'Non payé', livreur: '', montantEnc: 0, paie: 'Espèces', updatedAt: ANCIEN(10) }) === true && bac.commandes[0].statut === 'en-route');
    test('sans changement : rien n\'est remplacé', bac.cmdPollingAppliquer({ id: '#N1', statut: 'en-route', stpaie: 'Non payé', livreur: '', montantEnc: 0, paie: 'Espèces' }) === false);
    test('nouvelle commande : ajoutée en tête', bac.cmdPollingAppliquer({ id: '#N2', statut: 'en-attente' }) === true && bac.commandes[0].id === '#N2');
  }

  console.log('\n9. (réserve 1, v7.5.193) REJEU CONCURRENT : LA MODIFICATION LA PLUS RÉCENTE GAGNE');
  for (const mode of ['remise en file', 'exception']) {
    const bac = nouveauBac({ role: 'admin', fileStockee: [{ type: 'commande', data: { id: '#C1', v: 1 }, ts: 1, oqv: 2, role: 'admin' }] });
    bac.sbSaveCommande = async (c) => {
      if (c.v !== 1) return;
      await new Promise(r => setImmediate(r));
      bac.offlineQueueAdd('commande', { id: '#C1', v: 2 }); // un autre écran modifie la commande pendant le rejeu
      if (mode === 'exception') throw new Error('échec');
      bac.offlineQueueAdd('commande', c); // comme sbSaveCommande : l'échec remet l'ancienne version en file
    };
    await bac.offlineQueueFlush();
    const cs = bac.offlineQueue.filter(i => i.type === 'commande');
    test('commande, échec par ' + mode + ' : une seule entrée, la PLUS RÉCENTE (v2)', cs.length === 1 && cs[0].data.v === 2, cs.map(i => [i.data.v, i.ts]));
    test('commande, échec par ' + mode + ' : la file enregistrée contient v2', JSON.parse(bac._stockage.mx_offline_queue).filter(i => i.type === 'commande').map(i => i.data.v).join(',') === '2');
  }
  {
    let n = 0;
    const bac = nouveauBac({ role: 'livreur', fileStockee: [{ type: 'produit', data: PROD('p1', 5), ts: 1, oqv: 2, role: 'livreur' }],
      reponse: () => { if (++n === 1) bac.offlineQueueAdd('produit', PROD('p1', 3)); return 'reseau'; } });
    await bac.offlineQueueFlush();
    const ps = bac.offlineQueue.filter(i => i.type === 'produit');
    test('produit : coupure pendant le rejeu de l\'ancien stock (5) + nouvelle valeur (3) → seule la nouvelle reste', ps.length === 1 && ps[0].data.stock === 3, ps.map(i => [i.data.stock, i.ts]));
  }
  {
    const bac = nouveauBac({ role: 'admin', fileStockee: [{ type: 'commande', data: { id: '#C2', v: 1 }, ts: 1, oqv: 2 }] });
    bac.sbSaveCommande = async (c) => { bac.offlineQueueAdd('commande', c); };
    await bac.offlineQueueFlush();
    test('élément remis en file par son propre rejeu : garde sa date d\'origine (ts 1)', bac.offlineQueue.length === 1 && bac.offlineQueue[0].ts === 1, bac.offlineQueue.map(i => i.ts));
  }
  {
    const bac = nouveauBac({ role: 'admin' });
    const r = bac.oqDedoublonner([{ type: 'produit', data: { id: 'x', s: 'récent' }, ts: 50, oqv: 2 }, { type: 'tournee', data: { id: 'T' }, ts: 2 }, { type: 'produit', data: { id: 'x', s: 'ancien' }, ts: 10, oqv: 2 }]);
    test('dédoublonnage par date : la plus récente gagne même placée avant', r.length === 2 && r[0].data.s === 'récent' && r[1].type === 'tournee', r.map(i => i.data.s || i.type));
  }

  console.log('\n10. (réserve 2, v7.5.193) RÔLE D\'ORIGINE RESPECTÉ AU REJEU (CHANGEMENT DE SESSION)');
  for (const rOrig of ['admin', 'collab']) {
    const bac = nouveauBac({ role: 'livreur', fileStockee: [{ type: 'produit', data: PROD('p1', 5, 'Matelas F'), ts: 1, oqv: 2, role: rOrig }, { type: 'commande', data: { id: '#L1' }, ts: 2, oqv: 2, role: 'livreur' }] });
    let nCmd = 0; bac.sbSaveCommande = async () => { nCmd++; };
    await bac.offlineQueueFlush();
    test('fiche ' + rOrig + ' en file, session livreur : rien n\'est envoyé pour le produit', !bac._envois.some(e => /produits/.test(e.url)), bac._envois.map(e => e.method));
    test('fiche ' + rOrig + ', session livreur : elle reste en file (et la commande part)', bac.offlineQueue.length === 1 && bac.offlineQueue[0].type === 'produit' && bac.offlineQueue[0].role === rOrig && nCmd === 1, bac.offlineQueue.map(i => i.type));
    test('fiche ' + rOrig + ', session livreur : toujours enregistrée dans le téléphone', JSON.parse(bac._stockage.mx_offline_queue).some(i => i.type === 'produit' && i.role === rOrig));
    bac.role = rOrig === 'admin' ? 'collab' : 'admin'; // nouvelle session admin / collab sur l'appareil
    await bac.offlineQueueFlush();
    const e = bac._envois.find(x => /produits/.test(x.url)) || {};
    test('fiche ' + rOrig + ', puis session ' + bac.role + ' : fiche complète envoyée (POST), file vide', e.method === 'POST' && e.body && e.body.nom === 'Matelas F' && bac.offlineQueue.length === 0, [e.method, bac.offlineQueue.length]);
  }
  for (const rSess of ['admin', 'collab']) {
    const bac = nouveauBac({ role: rSess, fileStockee: [{ type: 'produit', data: PROD('p2', 4, 'Sommier L'), ts: 1, oqv: 2, role: 'livreur' }] });
    await bac.offlineQueueFlush();
    const e = bac._envois[0] || {};
    test('élément du livreur rejoué en session ' + rSess + ' : PATCH { stock, updated_at } seulement', e.method === 'PATCH' && /produits\?id=eq\.p2/.test(e.url) && Object.keys(e.body || {}).sort().join(',') === 'stock,updated_at' && e.body.stock === 4 && bac.offlineQueue.length === 0, [e.method, e.body]);
  }
  {
    const bac = nouveauBac({ role: 'admin', fileStockee: [{ type: 'produit', data: PROD('p3', 2), ts: 7, oqv: 2, role: 'livreur' }], reponse: () => 'reseau' });
    await bac.offlineQueueFlush();
    test('élément du livreur, coupure au rejeu en session admin : remis en file avec rôle livreur et date d\'origine', bac.offlineQueue.length === 1 && bac.offlineQueue[0].role === 'livreur' && bac.offlineQueue[0].ts === 7, bac.offlineQueue.map(i => [i.role, i.ts]));
  }
  {
    const bac = nouveauBac({ role: 'admin', fileStockee: [{ type: 'produit', data: PROD('p4', 2, 'Matelas Z'), ts: 1, oqv: 2, role: 'livreur' }], reponse: () => ({ status: 403 }) });
    await bac.offlineQueueFlush();
    test('élément du livreur refusé au rejeu en session admin : traité comme le livreur (pas de fiche gardée)', !('mx_produits_refuses' in bac._stockage) && bac._notifs.length === 1 && bac._notifs[0][2] === 'Stock non mis à jour : Matelas Z — à vérifier', bac._notifs.map(n => n[2]));
  }

  console.log('\n11. (réserve 3, v7.5.193) CONTRÔLE ADMIN : UN NOUVEL ÉCART EST DE NOUVEAU CONTRÔLÉ');
  {
    const bac = nouveauBac({ role: 'admin', reponse: () => ({ status: 200, json: [{ id: '#A1', statut: 'livré' }] }) });
    bac.tournees = [{ id: 'T-A', stops: [{ cmdId: '#A1', statut: 'livré' }] }]; bac.commandes = [];
    await bac.livControleNonRemontees(1000); await bac.livControleNonRemontees(130000);
    test('absente, lue « livré » en base : pas d\'alerte', bac._notifs.length === 0 && bac._envois.length === 1);
    await bac.livControleNonRemontees(200000);
    test('tant que cet écart dure : plus de lecture', bac._envois.length === 1);
    bac.commandes = [{ id: '#A1', statut: 'en-route' }]; // la relève la fait entrer dans la liste, rétrogradée
    await bac.livControleNonRemontees(210000);
    test('nouvel écart (dans la liste, « en-route ») : pas d\'alerte avant 2 min', bac._notifs.length === 0);
    await bac.livControleNonRemontees(340000);
    test('nouvel écart après 2 min : alerte « Livraison non remontée : #A1 — vérifier »', bac._notifs.length === 1 && bac._notifs[0][2] === 'Livraison non remontée : #A1 — vérifier', bac._notifs.map(n => n[2]));
  }
  {
    const bac = nouveauBac({ role: 'admin' });
    bac.tournees = [{ id: 'T-B', stops: [{ cmdId: '#B1', statut: 'livré' }] }]; bac.commandes = [{ id: '#B1', statut: 'en-route' }];
    await bac.livControleNonRemontees(1000); await bac.livControleNonRemontees(130000);
    test('écart dans la liste : 1re alerte', bac._notifs.length === 1);
    bac.commandes[0].statut = 'livré'; await bac.livControleNonRemontees(140000);
    bac.commandes[0].statut = 'en-route'; await bac.livControleNonRemontees(150000);
    test('écart résorbé puis revenu : pas de nouvelle alerte avant 2 min', bac._notifs.length === 1);
    await bac.livControleNonRemontees(280000);
    test('écart revenu, après 2 min : 2e alerte', bac._notifs.length === 2, bac._notifs.length);
    await bac.livControleNonRemontees(600000);
    test('puis une seule fois tant qu\'il dure', bac._notifs.length === 2);
  }
  {
    let st = 'livré';
    const bac = nouveauBac({ role: 'admin', reponse: () => ({ status: 200, json: [{ id: '#C9', statut: st }] }) });
    bac.tournees = [{ id: 'T-C', stops: [{ cmdId: '#C9', statut: 'livré' }] }]; bac.commandes = [];
    await bac.livControleNonRemontees(1000); await bac.livControleNonRemontees(130000);
    bac.commandes = [{ id: '#C9', statut: 'livré' }]; await bac.livControleNonRemontees(140000); // écart résorbé
    bac.commandes = []; st = 'en-route'; // de nouveau absente de la liste, et rétrogradée en base
    await bac.livControleNonRemontees(150000); await bac.livControleNonRemontees(280000);
    test('absente de nouveau : nouvelle lecture en base, puis alerte', bac._envois.length === 2 && bac._notifs.length === 1 && bac._notifs[0][2] === 'Livraison non remontée : #C9 — vérifier', [bac._envois.length, bac._notifs.map(n => n[2])]);
  }

  console.log('\n12. (réserve 4, v7.5.193) RÉCAPITULATIF NON ÉCRIT : AUCUNE PURGE');
  {
    const bac = nouveauBac({ role: null, fileStockee: ANCIENNE() });
    const vraiSet = bac.localStorage.setItem; let panne = true;
    bac.localStorage.setItem = (k, v) => { if (panne && k === 'mx_oq_purge_recap') throw new Error('QuotaExceededError'); return vraiSet(k, v); };
    bac.role = 'livreur';
    const r = bac.oqAppliquerRole('livreur');
    test('écriture du récapitulatif en échec : tri non appliqué', r === false && bac.offlineQueue.length === 5, [r, bac.offlineQueue.length]);
    test('la file enregistrée garde les anciens éléments (trace durable)', JSON.parse(bac._stockage.mx_offline_queue).filter(i => i.type === 'produit').length === 3);
    let nCmd = 0; bac.sbSaveCommande = async () => { nCmd++; };
    await bac.offlineQueueFlush();
    test('rejeu pendant la panne : le « livré » part, aucun ancien stock envoyé', nCmd === 1 && !bac._envois.some(e => /produits/.test(e.url)), [nCmd, bac._envois.map(e => e.url)]);
    test('rejeu pendant la panne : les 3 anciens éléments restent en file et dans le téléphone', bac.offlineQueue.filter(i => i.type === 'produit').length === 3 && JSON.parse(bac._stockage.mx_offline_queue).filter(i => i.type === 'produit').length === 3);
    test('aucune notification de purge sans récapitulatif', bac._notifs.length === 0);
    panne = false;
    await bac.offlineQueueFlush();
    test('stockage revenu : purge faite au rejeu suivant, récapitulatif écrit puis notifié', bac.offlineQueue.filter(i => i.type === 'produit').length === 0 && bac._notifs.length === 1 && /^3 mises à jour de stock anciennes/.test(bac._notifs[0][3]) && !bac._envois.some(e => /produits/.test(e.url)), [bac.offlineQueue.length, bac._notifs.map(n => n[3])]);
  }

  console.log('\n13. (P2 + réserve 1, v7.5.194) UNE NOUVELLE MISE EN FILE NE SUPPRIME JAMAIS UN ANCIEN ÉLÉMENT PAS ENCORE TRIÉ');
  {
    // scénario exact de la revue native : deux anciens éléments (ici trois), stockage qui refuse le récapitulatif
    const bac = nouveauBac({ role: null, fileStockee: ANCIENNE() });
    const vraiSet = bac.localStorage.setItem; let panne = true;
    bac.localStorage.setItem = (k, v) => { if (panne && k === 'mx_oq_purge_recap') throw new Error('QuotaExceededError'); return vraiSet(k, v); };
    bac.role = 'livreur';
    test('récapitulatif refusé : tri non appliqué', bac.oqAppliquerRole('livreur') === false && bac.offlineQueue.length === 5);
    bac.offlineQueueAdd('produit', PROD('p1', 2, 'Matelas A')); // nouvelle mise à jour du même produit
    const anciens = bac.offlineQueue.filter(i => i.type === 'produit' && !i.oqv);
    test('après offlineQueueAdd : les 3 anciens éléments sont toujours en file (dont les 2 de p1)', anciens.length === 3 && anciens.filter(i => i.data.id === 'p1').length === 2, bac.offlineQueue.map(i => [i.type, i.data.id, !!i.oqv]));
    test('après offlineQueueAdd : la nouvelle mise à jour est ajoutée à côté', bac.offlineQueue.filter(i => i.type === 'produit' && i.oqv).length === 1);
    test('la file enregistrée dans le téléphone garde aussi les anciens éléments', JSON.parse(bac._stockage.mx_offline_queue).filter(i => i.type === 'produit' && !i.oqv).length === 3);
    panne = false;
    await bac.offlineQueueFlush();
    const envoisP = bac._envois.filter(e => /produits/.test(e.url));
    test('stockage revenu : 3 anciens éléments purgés et notifiés, seule la nouvelle valeur (2) envoyée', bac._notifs.length === 1 && /^3 mises à jour de stock anciennes/.test(bac._notifs[0][3]) && envoisP.length === 1 && envoisP[0].body.stock === 2 && bac.offlineQueue.length === 0, [bac._notifs.map(n => n[3]), envoisP.map(e => e.body)]);
  }
  {
    // appareil admin : une nouvelle fiche mise en file AVANT la connexion ne retire pas les anciennes fiches
    const bac = nouveauBac({ role: null, fileStockee: ANCIENNE() });
    bac.offlineQueueAdd('produit', PROD('p2', 9, 'Sommier B'));
    test('rôle inconnu : nouvelle fiche p2 ajoutée, ancienne fiche p2 conservée', bac.offlineQueue.filter(i => i.type === 'produit' && i.data.id === 'p2').length === 2 && bac.offlineQueue.length === 6);
    bac.role = 'admin';
    await bac.offlineQueueFlush();
    const p2 = bac._envois.filter(e => /produits/.test(e.url) && e.body.id === 'p2');
    test('session admin : la dernière fiche envoyée pour p2 est la plus récente (stock 9), file vide', p2.length >= 1 && p2[p2.length - 1].body.stock === 9 && bac.offlineQueue.length === 0, [p2.map(e => e.body.stock), bac.offlineQueue.length]);
  }

  console.log('\n14. (réserve 2, v7.5.194) STOCK DU LIVREUR ET FICHE ADMIN : DEUX INTENTIONS DISTINCTES');
  {
    let reseau = false;
    const bac = nouveauBac({ role: 'admin', reponse: () => (reseau ? { status: 200, json: [{ id: 'p1' }] } : 'reseau') });
    await bac.sbSaveProduit(Object.assign(PROD('p1', 5, 'Matelas K'), { prix: 150 })); // fiche admin, coupure
    bac.role = 'livreur'; // changement de session sur le même appareil
    await bac.sbSaveProduit(PROD('p1', 4, 'Matelas K')); // stock du livreur, coupure
    test('les deux intentions restent en file (fiche admin + stock du livreur)', bac.offlineQueue.length === 2 && bac.offlineQueue.map(i => i.role).sort().join(',') === 'admin,livreur', bac.offlineQueue.map(i => [i.role, i.data.stock]));
    test('clés distinctes : produit|fiche|p1 et produit|stock|p1', bac.offlineQueue.map(i => bac.oqCle(i)).sort().join(',') === 'produit|fiche|p1,produit|stock|p1');
    await bac.sbSaveProduit(PROD('p1', 3, 'Matelas K')); // nouvelle déduction du livreur, coupure
    test('nouvelle valeur du livreur : remplace seulement l\'ancienne valeur du livreur (fiche admin intacte)', bac.offlineQueue.length === 2 && bac.offlineQueue.find(i => i.role === 'livreur').data.stock === 3 && bac.offlineQueue.find(i => i.role === 'admin').data.prix === 150);
    test('dédoublonnage : les deux intentions survivent', bac.oqDedoublonner(bac.offlineQueue).length === 2);
    reseau = true; const n0 = bac._envois.length; // les essais pendant la coupure sont enregistrés aussi
    await bac.offlineQueueFlush();
    const env = bac._envois.slice(n0).filter(e => /produits/.test(e.url) && e.method === 'PATCH');
    test('session livreur : le stock du livreur part (PATCH 3), la fiche admin attend', env.length === 1 && env[0].body.stock === 3 && bac.offlineQueue.length === 1 && bac.offlineQueue[0].role === 'admin');
    bac.role = 'admin';
    await bac.offlineQueueFlush();
    const post = bac._envois.slice(n0).filter(e => e.method === 'POST');
    test('session admin ensuite : la fiche complète part (POST, prix 150), file vide', post.length === 1 && post[0].body.prix === 150 && bac.offlineQueue.length === 0, post.map(e => e.body));
  }

  console.log('\n15. (réserve 3, v7.5.194) FICHES REFUSÉES : VERSIONS COMPARÉES (RELANCE ET SAUVEGARDES CONCURRENTES)');
  const REFUS = (id, ts, stock) => JSON.stringify({ [id]: { data: PROD(id, stock, 'Matelas V'), status: 422, ts, role: 'admin' } });
  {
    // relance alors qu'une modification PLUS RÉCENTE de la fiche attend dans la file
    const stockage = { mx_produits_refuses: REFUS('p1', 100, 1) };
    const bac = nouveauBac({ role: 'admin', stockage, fileStockee: [{ type: 'produit', data: PROD('p1', 8, 'Matelas V'), ts: 200, oqv: 2, role: 'admin' }] });
    const n = await bac.produitsRefusesRelancer();
    test('relance : la fiche refusée (plus ancienne) n\'est pas renvoyée, elle reste gardée', n === 0 && bac._envois.length === 0 && 'p1' in JSON.parse(stockage.mx_produits_refuses));
    await bac.offlineQueueFlush();
    test('la version plus récente part (stock 8) et retire la fiche refusée plus ancienne', bac._envois.length === 1 && bac._envois[0].body.stock === 8 && !('mx_produits_refuses' in stockage), [bac._envois.map(e => e.body.stock), stockage.mx_produits_refuses]);
  }
  {
    // succès d'une ANCIENNE sauvegarde (file) : la fiche refusée plus récente n'est pas retirée
    const stockage = { mx_produits_refuses: REFUS('p1', 200, 2) };
    const bac = nouveauBac({ role: 'admin', stockage, fileStockee: [{ type: 'produit', data: PROD('p1', 6, 'Matelas V'), ts: 100, oqv: 2, role: 'admin' }] });
    await bac.offlineQueueFlush();
    const o = JSON.parse(stockage.mx_produits_refuses || '{}');
    test('ancienne sauvegarde réussie : la fiche refusée plus récente reste gardée (ts 200, stock 2)', o.p1 && o.p1.ts === 200 && o.p1.data.stock === 2, o);
  }
  {
    // refus d'une ANCIENNE version : ne remplace pas la fiche refusée plus récente
    const stockage = { mx_produits_refuses: REFUS('p1', 200, 2) };
    const bac = nouveauBac({ role: 'admin', stockage, reponse: () => ({ status: 422 }), fileStockee: [{ type: 'produit', data: PROD('p1', 6, 'Matelas V'), ts: 100, oqv: 2, role: 'admin' }] });
    await bac.offlineQueueFlush();
    const o = JSON.parse(stockage.mx_produits_refuses || '{}');
    test('refus d\'une version plus ancienne : la fiche gardée reste la plus récente (ts 200, stock 2)', o.p1 && o.p1.ts === 200 && o.p1.data.stock === 2, o);
  }
  {
    // concurrent : la relance (ancienne version) est en cours quand une version plus récente est refusée
    const stockage = { mx_produits_refuses: REFUS('p1', 100, 1) };
    const bac = nouveauBac({ role: 'admin', stockage, reponse: (u, o) => (JSON.parse(o.body).stock === 1 ? { status: 201 } : { status: 422 }) });
    const vraiFetch = bac.fetch; let ouvrir; const porte = new Promise(r => { ouvrir = r; });
    bac.fetch = async (u, o) => { if (JSON.parse(o.body).stock === 1) await porte; return vraiFetch(u, o); };
    const relance = bac.produitsRefusesRelancer();
    await new Promise(r => setImmediate(r));
    await bac.sbSaveProduit(PROD('p1', 7, 'Matelas V')); // nouvelle version, refusée pendant la relance
    ouvrir(); await relance;
    const o = JSON.parse(stockage.mx_produits_refuses || '{}');
    test('relance réussie APRÈS le refus d\'une version plus récente : la plus récente reste gardée (stock 7)', o.p1 && o.p1.data.stock === 7, o);
  }

  console.log('\n16. (réserve 4, v7.5.194) LE VERROU DU « LIVRÉ » ATTEND AUSSI LES SAUVEGARDES PRODUIT');
  {
    const { bac, saves, finirPremier } = bacLivraison();
    let finirProduit = null, produitFini = false;
    bac.sbSaveProduit = () => new Promise(r => { finirProduit = () => { produitFini = true; r(); }; });
    bac.validerSig();
    await new Promise(r => setImmediate(r));
    finirPremier();
    for (let k = 0; k < 10; k++) await new Promise(r => setImmediate(r));
    test('réponse produit retardée : commande déjà enregistrée deux fois (livré, puis stock_deduit)', saves.length === 2 && saves[1].statut === 'livré' && saves[1].stockDeduit === true, saves);
    test('réponse produit retardée : le verrou du « livré » est TOUJOURS posé', !!bac._livEnCours['#T10'] && !produitFini);
    test('pendant ce temps, une relève périmée reste refusée', bac.cmdPollingAppliquer(perimee({ updatedAt: new Date(Date.now() + 60000).toISOString() })) === false && bac.commandes[0].statut === 'livré');
    finirProduit();
    for (let k = 0; k < 10; k++) await new Promise(r => setImmediate(r));
    test('réponse produit arrivée : verrou relâché', !bac._livEnCours['#T10']);
  }
  {
    const { bac } = bacLivraison();
    bac.sbSaveCommande = async () => {};
    let fin = null; bac.sbSaveProduit = () => new Promise(r => { fin = r; });
    let resolu = false;
    bac.stkDeduireStock('#T10').then(() => { resolu = true; });
    for (let k = 0; k < 5; k++) await new Promise(r => setImmediate(r));
    test('stkDeduireStock : sa promesse attend la sauvegarde produit', resolu === false);
    fin(); for (let k = 0; k < 5; k++) await new Promise(r => setImmediate(r));
    test('stkDeduireStock : promesse tenue après la sauvegarde produit', resolu === true);
  }
  {
    const { bac } = bacLivraison();
    bac.sbSaveCommande = async () => {};
    bac.sbSaveProduit = async () => { throw new Error('panne produit'); };
    let resolu = false, rejete = false;
    bac.stkDeduireStock('#T10').then(() => { resolu = true; }, () => { rejete = true; });
    for (let k = 0; k < 5; k++) await new Promise(r => setImmediate(r));
    test('sauvegarde produit en échec : la promesse est tenue (jamais rejetée)', resolu && !rejete);
  }

  console.log('\n17. (réserve 5, v7.5.194) COMMANDE ABSENTE LUE « LIVRÉE » : RELUE TOUTES LES 10 MIN');
  {
    let st = 'livré';
    const bac = nouveauBac({ role: 'admin', reponse: () => ({ status: 200, json: [{ id: '#R5', statut: st }] }) });
    bac.tournees = [{ id: 'T-R', stops: [{ cmdId: '#R5', statut: 'livré' }] }]; bac.commandes = [];
    await bac.livControleNonRemontees(1000); await bac.livControleNonRemontees(130000);
    test('lue « livré » : pas d\'alerte, 1 lecture', bac._notifs.length === 0 && bac._envois.length === 1);
    st = 'en-route'; // régression ultérieure en base
    await bac.livControleNonRemontees(400000); await bac.livControleNonRemontees(729000);
    test('avant 10 min : pas de nouvelle lecture', bac._envois.length === 1, bac._envois.length);
    await bac.livControleNonRemontees(731000);
    test('après 10 min : relue, régression signalée « Livraison non remontée : #R5 — vérifier »', bac._envois.length === 2 && bac._notifs.length === 1 && bac._notifs[0][2] === 'Livraison non remontée : #R5 — vérifier', [bac._envois.length, bac._notifs.map(n => n[2])]);
    await bac.livControleNonRemontees(2000000);
    test('alerte faite : plus aucune lecture pour cet écart', bac._envois.length === 2 && bac._notifs.length === 1);
  }
  {
    const bac = nouveauBac({ role: 'admin', reponse: () => ({ status: 200, json: [{ id: 'x', statut: 'livré' }] }) });
    const stops = []; for (let k = 0; k < 15; k++) stops.push({ cmdId: '#M' + k, statut: 'livré' });
    bac.tournees = [{ id: 'T-M', stops }]; bac.commandes = [];
    await bac.livControleNonRemontees(1000); await bac.livControleNonRemontees(130000);
    test('15 commandes absentes : au plus 10 lectures par contrôle', bac._envois.length === 10, bac._envois.length);
    await bac.livControleNonRemontees(160000);
    test('les 5 autres sont lues au contrôle suivant', bac._envois.length === 15, bac._envois.length);
    await bac.livControleNonRemontees(200000);
    test('puis plus rien avant 10 min', bac._envois.length === 15, bac._envois.length);
  }

  console.log('\n18. (réserve 6, v7.5.194) FICHE REFUSÉE ET STOCKAGE INDISPONIBLE : GARDÉE EN MÉMOIRE, MESSAGE HONNÊTE');
  {
    let refus = true;
    const bac = nouveauBac({ role: 'admin', reponse: () => (refus ? { status: 422 } : { status: 201 }) });
    const vraiSet = bac.localStorage.setItem;
    bac.localStorage.setItem = (k, v) => { if (k === 'mx_produits_refuses') throw new Error('QuotaExceededError'); return vraiSet(k, v); };
    await bac.sbSaveProduit(Object.assign(PROD('p1', 3, 'Matelas M'), { prix: 130 }));
    const n = bac._notifs[0] || [];
    test('stockage indisponible : rien dans le téléphone', !('mx_produits_refuses' in bac._stockage));
    test('notification honnête « … (refus de la base) — non gardée sur l\'appareil » (urgente)', bac._notifs.length === 1 && n[0] === 'urgent' && n[2] === 'Fiche produit non enregistrée : Matelas M (refus de la base) — non gardée sur l\'appareil' && /que tant que l'application reste ouverte/.test(n[3]), n);
    test('la fiche reste en mémoire (bouton « Relancer 1 fiche »)', 'p1' in bac.produitsRefusesLire() && /Relancer 1 fiche/.test(bac.document.getElementById('stk-refus-btn').textContent));
    refus = false;
    const r = await bac.produitsRefusesRelancer();
    test('relance acceptée : fiche complète renvoyée (prix 130) puis retirée de la mémoire', r === 1 && bac._envois[1] && bac._envois[1].body.prix === 130 && Object.keys(bac.produitsRefusesLire()).length === 0);
  }
  {
    const bac = nouveauBac({ role: 'admin', reponse: () => ({ status: 422 }) });
    await bac.sbSaveProduit(PROD('p1', 3, 'Matelas N'));
    const vraiSet = bac.localStorage.setItem;
    bac.localStorage.setItem = (k, v) => { if (k === 'mx_produits_refuses') throw new Error('QuotaExceededError'); return vraiSet(k, v); };
    await bac.sbSaveProduit(PROD('p1', 2, 'Matelas N'));
    test('déjà signalée, puis stockage en échec : nouvelle notification « non gardée sur l\'appareil »', bac._notifs.length === 2 && /non gardée sur l'appareil$/.test(bac._notifs[1][2]), bac._notifs.map(x => x[2]));
    test('la version la plus récente (stock 2) est en mémoire', bac.produitsRefusesLire().p1.data.stock === 2);
  }

  console.log('\n7. TEXTE DU CODE');
  test('un refus définitif de produit ne passe pas par sbSaveEchec (seulement si httpTemporaire)', (CODE_PRODUIT.match(/sbSaveEchec\('produit', p, 'Produit', resp(L)?\.status/g) || []).length === 2 && (CODE_PRODUIT.match(/if \(httpTemporaire\(resp(L)?\.status\)\) \{ sbSaveEchec/g) || []).length === 2);
  test('le rejeu lit une copie (_aRejouer), pas la file qui grandit', /_aRejouer\.length/.test(CODE_REJEU) && !/i < offlineQueue\.length/.test(CODE_REJEU));
  test('loginOk trie les anciens éléments dès que le rôle est connu', /function loginOk\(r\) \{\s*role=r;\s*\/\/[^\n]*\n\s*try \{ oqAppliquerRole\(r\); \}/.test(html));
  test('le bouton « Relancer » existe sur la page Stock', /id="stk-refus-btn"[^>]*onclick="produitsRefusesRelancer\(\)"/.test(html));
  test('relève (polling) : passe par cmdPollingAppliquer et lit updated_at', /select=' \+ CMD_SELECT_COLS \+ ',updated_at&order=updated_at\.desc/.test(html) && /if \(cmdPollingAppliquer\(mapped\)\) updated = true;/.test(html));
  test('Realtime : une version périmée ne remplace pas la commande (cmdDistanteAcceptable)', /if \(!cmdDistanteAcceptable\(commandes\[idx\], mapped\)\) return;/.test(html));
  test('rechargement complet : cmdFusionnerChargees + updated_at lu', /commandes = cmdFusionnerChargees\(commandes, _cmdsAvant\)/.test(html) && /select=' \+ CMD_SELECT_COLS \+ ',updated_at&order=created_at\.desc'/.test(html));
  test('setLvSt : « livré » marqué et déduction sur l\'objet validé', /livMarquer\(cLv\.id\);[^\n]*\n[^\n]*\n\s*try \{ stkDeduireStock\(cLv\.id, cLv\); \}/.test(html));
  const sw = fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8');
  test('CACHE_VERSION augmenté (v7-5-194 ou plus)', /CACHE_VERSION = 'maxiconfort-v7-5-(19[4-9]|[2-9]\d\d)'/.test(sw));

  console.log('\n' + ok + ' réussi(s), ' + ko + ' échec(s)');
  process.exit(ko ? 1 : 0);
})().catch(e => { console.error('ERREUR DU BANC :', e); process.exit(2); });
