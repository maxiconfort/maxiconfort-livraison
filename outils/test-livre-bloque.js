// Banc de test du correctif v7.5.191 / v7.5.192 / v7.5.193 / v7.5.194 / v7.5.195 / v7.5.196 (26/11/2026) : le « livré » du livreur ne remontait plus depuis le 24/11.
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
const CODE_ECHEC = extraireFonction('function sbSaveEchec(type, data, ctx, status, detail, oqCtx)');
const CODE_REJEU = extraireBloc('// v7.5.191 : un seul rejeu à la fois', '// Détecter retour en ligne');
const CODE_PRODUIT = extraireBloc('// v7.5.191 : refus de la base sur un produit', 'async function sbDeleteProduit');
const CODE_CONTROLE = extraireBloc('// v7.5.191 (bug du 24/11) : contrôle ADMIN', 'var _pollingInterval');
const CODE_SIG = extraireFonction('function validerSig()');
const CODE_STK = extraireBloc('// v7.5.192 : lance un enregistrement asynchrone', '// v7.5.79 : "Actualiser"');
const CODE_CMD = extraireFonction('async function sbSaveCommande(cmd, oqCtx)'); // v7.5.196

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
    _lectures: [],
    fetch: async (url, opt = {}) => {
      // v7.5.195 : lecture de updated_at d'un produit avant le rejeu d'une fiche : notée à part (par défaut : aucune ligne)
      if (/\/rest\/v1\/produits\?select=id,updated_at/.test(url)&& !(opt.method && opt.method !== 'GET')) {
        bac._lectures.push(url);
        const rl = bac.lecture ? bac.lecture(url) : { status: 200, json: [] };
        if (rl === 'reseau') throw new Error('Failed to fetch');
        return { ok: rl.status >= 200 && rl.status < 300, status: rl.status, text: async () => '', json: async () => rl.json };
      }
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
    // v7.5.196 (réserve Codex 2 sur a84fa19) : sauvegarde produit en échec (exception) → stock_deduit N'EST PAS enregistré
    test('vraie déduction : commande enregistrée « livré » d\'abord, puis stock (rejeté) traité, stock_deduit non enregistré', ordre[0] === 'commande:livré' && ordre.includes('produit:rejet') && !ordre.includes('commande:livré:rejet') && !bac.commandes[0].stockDeduit, ordre);
    test('vraie déduction en échec : notification « Déduction de stock en échec : #T10 — stock à vérifier »', bac._notifs.some(n => n[2] === 'Déduction de stock en échec : #T10 — stock à vérifier'), bac._notifs.map(n => n[2]));
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
    bac.sbSaveProduit = async () => 'ok'; // v7.5.196 : la sauvegarde produit renvoie son résultat
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
    for (let k = 0; k < 5; k++) await new Promise(r => setImmediate(r)); // v7.5.196 : stock_deduit après la réponse produit
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
    bac.sbSaveCommande = async (c, ctx) => {
      if (c.v !== 1) return;
      await new Promise(r => setImmediate(r));
      bac.offlineQueueAdd('commande', { id: '#C1', v: 2 }); // un autre écran modifie la commande pendant le rejeu
      if (mode === 'exception') throw new Error('échec');
      bac.offlineQueueAdd('commande', c, ctx); // comme sbSaveCommande (v7.5.195) : l'échec remet l'ancienne version en file avec son contexte
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
    bac.sbSaveCommande = async (c, ctx) => { bac.offlineQueueAdd('commande', c, ctx); };
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
    bac.sbSaveProduit = () => new Promise(r => { finirProduit = () => { produitFini = true; r('ok'); }; });
    bac.validerSig();
    await new Promise(r => setImmediate(r));
    finirPremier();
    for (let k = 0; k < 10; k++) await new Promise(r => setImmediate(r));
    // v7.5.196 (réserve Codex 2 sur a84fa19) : stock_deduit attend la réponse du produit
    test('réponse produit retardée : seul le « livré » est enregistré, pas encore stock_deduit', saves.length === 1 && saves[0].statut === 'livré' && saves[0].stockDeduit === false, saves);
    test('réponse produit retardée : le verrou du « livré » est TOUJOURS posé', !!bac._livEnCours['#T10'] && !produitFini);
    test('pendant ce temps, une relève périmée reste refusée', bac.cmdPollingAppliquer(perimee({ updatedAt: new Date(Date.now() + 60000).toISOString() })) === false && bac.commandes[0].statut === 'livré');
    finirProduit();
    for (let k = 0; k < 10; k++) await new Promise(r => setImmediate(r));
    test('réponse produit arrivée (ok) : stock_deduit enregistré ensuite, puis verrou relâché', saves.length === 2 && saves[1].stockDeduit === true && saves[1].statut === 'livré' && !bac._livEnCours['#T10'], saves);
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

  console.log('\n19. (P2 sur 6f88c79, v7.5.195) FICHE REFUSÉE RELANCÉE PUIS COUPURE : LA MODIFICATION RÉCENTE N\'EST JAMAIS PERDUE');
  for (const panne of ['reseau', 503]) {
    const stockage = { mx_produits_refuses: JSON.stringify({ p1: { data: PROD('p1', 1, 'Matelas R'), status: 422, ts: 100, role: 'admin' } }) };
    let n = 0, bac = null;
    bac = nouveauBac({ role: 'admin', stockage, reponse: () => {
      if (++n === 1) bac.offlineQueueAdd('produit', PROD('p1', 9, 'Matelas R')); // modification récente pendant la relance
      return panne === 'reseau' ? 'reseau' : { status: panne };
    } });
    await bac.produitsRefusesRelancer();
    const ps = bac.offlineQueue.filter(i => i.type === 'produit' && i.data.id === 'p1');
    test('relance + ' + (panne === 'reseau' ? 'coupure réseau' : 'HTTP 503') + ' : la file garde le NOUVEAU stock 9 (une seule entrée)', ps.length === 1 && ps[0].data.stock === 9 && ps[0].ts > 100, ps.map(i => [i.data.stock, i.ts]));
    test('relance + ' + (panne === 'reseau' ? 'coupure réseau' : 'HTTP 503') + ' : la file enregistrée contient le stock 9', JSON.parse(bac._stockage.mx_offline_queue).filter(i => i.data && i.data.id === 'p1').map(i => i.data.stock).join(',') === '9');
  }
  {
    // sans modification récente : la fiche relancée qui échoue entre en file avec SA date (100), pas l'heure de l'échec
    const stockage = { mx_produits_refuses: JSON.stringify({ p1: { data: PROD('p1', 1, 'Matelas R'), status: 422, ts: 100, role: 'admin' } }) };
    const bac = nouveauBac({ role: 'admin', stockage, reponse: () => ({ status: 503 }) });
    await bac.produitsRefusesRelancer();
    test('relance + HTTP 503 seule : mise en file avec la date de sa version (ts 100)', bac.offlineQueue.length === 1 && bac.offlineQueue[0].ts === 100 && bac.offlineQueue[0].role === 'admin', bac.offlineQueue.map(i => [i.ts, i.role]));
  }

  console.log('\n20. (réserve 1 sur 6f88c79, v7.5.195) FICHE ADMIN ANCIENNE REJOUÉE : LE STOCK LE PLUS RÉCENT EST GARDÉ (ÉTAT FINAL EN BASE)');
  // base simulée : GET updated_at, PATCH du stock (livreur), POST merge-duplicates (fiche : seules les colonnes envoyées changent)
  function bacBase(base, opts) {
    let bac = null;
    bac = nouveauBac(Object.assign({}, opts, { reponse: (url, opt) => {
      const body = opt.body ? JSON.parse(opt.body) : {};
      if (opt.method === 'PATCH') { const id = decodeURIComponent((url.match(/id=eq\.([^&]+)/) || [])[1] || ''); if (!base[id]) return { status: 200, json: [] }; Object.assign(base[id], body); return { status: 200, json: [{ id }] }; }
      if (opt.method === 'POST') { base[body.id] = Object.assign(base[body.id] || { stock: 0 }, body); return { status: 201 }; }
      return { status: 200, json: [] };
    } }));
    bac.lecture = (url) => { const id = decodeURIComponent((url.match(/id=eq\.([^&]+)/) || [])[1] || ''); return { status: 200, json: base[id] ? [{ id, updated_at: base[id].updated_at }] : [] }; };
    return bac;
  }
  const T0 = Date.now() - 600000, iso = t => new Date(t).toISOString();
  {
    const base = { p1: { id: 'p1', nom: 'Matelas', stock: 2, updated_at: iso(T0 + 30000) } }; // livreur : stock 2 APRÈS la fiche
    const bac = bacBase(base, { role: 'admin', fileStockee: [{ type: 'produit', data: PROD('p1', 5, 'Matelas Neuf'), ts: T0, oqv: 2, role: 'admin' }] });
    await bac.offlineQueueFlush();
    const post = bac._envois.find(e => e.method === 'POST') || {};
    test('stock livreur plus récent en base : la fiche part SANS le champ stock', post.body && !('stock' in post.body) && post.body.nom === 'Matelas Neuf', post.body);
    test('état final en base : stock 2 (livreur) gardé, nom de la fiche appliqué, file vide', base.p1.stock === 2 && base.p1.nom === 'Matelas Neuf' && bac.offlineQueue.length === 0, [base.p1, bac.offlineQueue.length]);
  }
  {
    const base = { p1: { id: 'p1', nom: 'Matelas', stock: 7, updated_at: iso(T0 - 30000) } }; // base modifiée AVANT la fiche
    const bac = bacBase(base, { role: 'admin', fileStockee: [{ type: 'produit', data: PROD('p1', 5, 'Matelas Neuf'), ts: T0, oqv: 2, role: 'admin' }] });
    await bac.offlineQueueFlush();
    test('base plus ancienne que la fiche : état final stock 5 (celui de la fiche)', base.p1.stock === 5 && base.p1.nom === 'Matelas Neuf', base.p1);
  }
  {
    const bac = bacBase({}, { role: 'admin', fileStockee: [{ type: 'produit', data: PROD('pN', 4, 'Nouveau'), ts: T0, oqv: 2, role: 'admin' }] });
    await bac.offlineQueueFlush();
    const post = bac._envois.find(e => e.method === 'POST') || {};
    test('produit absent de la base (création) : la fiche part avec son stock (4)', post.body && post.body.stock === 4, post.body);
  }
  for (const ordre of ['fiche puis stock', 'stock puis fiche']) {
    // même appareil (session admin) : une mise à jour du stock du livreur plus récente attend dans la file
    const base = { p1: { id: 'p1', nom: 'Matelas', stock: 7, updated_at: iso(T0 - 30000) } };
    const fiche = { type: 'produit', data: PROD('p1', 5, 'Matelas Neuf'), ts: T0, oqv: 2, role: 'admin' };
    const stock = { type: 'produit', data: PROD('p1', 2, 'Matelas'), ts: T0 + 10000, oqv: 2, role: 'livreur' };
    const bac = bacBase(base, { role: 'admin', fileStockee: ordre === 'fiche puis stock' ? [fiche, stock] : [stock, fiche] });
    await bac.offlineQueueFlush();
    test(ordre + ' : état final en base stock 2 (livreur, plus récent), nom de la fiche, file vide', base.p1.stock === 2 && base.p1.nom === 'Matelas Neuf' && bac.offlineQueue.length === 0, [base.p1, bac.offlineQueue.length]);
  }
  {
    // fiche refusée relancée après une mise à jour du stock du livreur faite en base
    const base = { p1: { id: 'p1', nom: 'Matelas', stock: 3, updated_at: iso(T0 + 1000) } };
    const stockage = { mx_produits_refuses: JSON.stringify({ p1: { data: PROD('p1', 8, 'Matelas Neuf'), status: 422, ts: T0, role: 'admin' } }) };
    const bac = bacBase(base, { role: 'admin', stockage });
    await bac.produitsRefusesRelancer();
    test('relance d\'une fiche ancienne : état final stock 3 (livreur) gardé, fiche retirée des refusées', base.p1.stock === 3 && base.p1.nom === 'Matelas Neuf' && Object.keys(bac.produitsRefusesLire()).length === 0, [base.p1, bac.produitsRefusesLire()]);
  }
  {
    const base = { p1: { id: 'p1', nom: 'Matelas', stock: 3, updated_at: iso(Date.now() + 60000) } };
    const bac = bacBase(base, { role: 'admin' });
    await bac.sbSaveProduit(PROD('p1', 6, 'Matelas'));
    test('sauvegarde faite à l\'instant (pas un rejeu) : aucune lecture, stock 6 envoyé (inchangé)', bac._lectures.length === 0 && base.p1.stock === 6, [bac._lectures.length, base.p1.stock]);
  }
  for (const lu of ['reseau', 503]) {
    const base = { p1: { id: 'p1', nom: 'Matelas', stock: 3, updated_at: iso(T0 - 1000) } };
    const bac = bacBase(base, { role: 'admin', fileStockee: [{ type: 'produit', data: PROD('p1', 5, 'Matelas Neuf'), ts: T0, oqv: 2, role: 'admin' }] });
    bac.lecture = () => (lu === 'reseau' ? 'reseau' : { status: lu });
    await bac.offlineQueueFlush();
    test('lecture de la date impossible (' + lu + ') : rien envoyé, la fiche reste en file avec sa date', bac._envois.length === 0 && bac.offlineQueue.length === 1 && bac.offlineQueue[0].ts === T0 && base.p1.stock === 3, [bac._envois.length, bac.offlineQueue.map(i => i.ts)]);
  }
  {
    const base = { p1: { id: 'p1', nom: 'Matelas', stock: 3, updated_at: iso(T0 - 1000) } };
    const bac = bacBase(base, { role: 'admin', fileStockee: [{ type: 'produit', data: PROD('p1', 5, 'Matelas Neuf'), ts: T0, oqv: 2, role: 'admin' }] });
    bac.lecture = () => ({ status: 403 });
    await bac.offlineQueueFlush();
    test('lecture refusée (403) : prudence, fiche envoyée SANS le stock (base : 3)', base.p1.stock === 3 && base.p1.nom === 'Matelas Neuf', base.p1);
  }

  console.log('\n21. (réserve 2 sur 6f88c79, v7.5.195) PLUS DE VARIABLE GLOBALE : UNE SAUVEGARDE INDÉPENDANTE PENDANT UN REJEU GARDE SA DATE ET SON RÔLE');
  test('_oqRejeuItem n\'existe plus dans la page', !/_oqRejeuItem/.test(html));
  {
    // session admin : rejeu d'une mise à jour du stock du livreur (ts 1000) ; pendant l'attente réseau, l'admin
    // enregistre la fiche du MÊME objet, qui échoue aussi
    let n = 0, bac = null, indep = null;
    bac = nouveauBac({ role: 'admin', fileStockee: [{ type: 'produit', data: PROD('p1', 5, 'Matelas C'), ts: 1000, oqv: 2, role: 'livreur' }],
      reponse: () => { if (++n === 1) indep = bac.sbSaveProduit(bac.offlineQueue[0].data); return 'reseau'; } });
    await bac.offlineQueueFlush(); await indep;
    const ps = bac.offlineQueue.filter(i => i.type === 'produit').map(i => [i.role, i.ts > 1000 ? 'récent' : i.ts]);
    test('deux entrées distinctes : stock du livreur (ts 1000) ET fiche admin (date récente)', ps.length === 2 && ps.some(x => x[0] === 'livreur' && x[1] === 1000) && ps.some(x => x[0] === 'admin' && x[1] === 'récent'), ps);
  }
  {
    // commande : rejeu (ts 1) ; pendant l'attente, une sauvegarde indépendante du même objet échoue (sans contexte)
    const bac = nouveauBac({ role: 'admin', fileStockee: [{ type: 'commande', data: { id: '#K1', v: 1 }, ts: 1, oqv: 2, role: 'admin' }] });
    bac.sbSaveCommande = async (c, ctx) => {
      await new Promise(r => setImmediate(r));
      bac.offlineQueueAdd('commande', c); // sauvegarde indépendante qui échoue : SA date (maintenant)
      bac.offlineQueueAdd('commande', c, ctx); // échec du rejeu : date d'origine (1), ne remplace pas la plus récente
    };
    await bac.offlineQueueFlush();
    test('commande : l\'entrée gardée porte la date de la sauvegarde indépendante (pas ts 1)', bac.offlineQueue.length === 1 && bac.offlineQueue[0].ts > 1, bac.offlineQueue.map(i => i.ts));
  }

  console.log('\n22. (réserve 3 sur 6f88c79, v7.5.195) CONTRÔLE ADMIN : ROTATION ÉQUITABLE DES LECTURES');
  {
    const lus = [];
    const bac = nouveauBac({ role: 'admin', reponse: (url) => {
      const k = Number((url.match(/eq\.%23F(\d+)$/) || [])[1]); lus.push(k);
      return k < 10 ? { status: 500 } : { status: 200, json: [{ id: '#F' + k, statut: 'livré' }] }; // les 10 premières : panne persistante
    } });
    const stops = []; for (let k = 0; k < 12; k++) stops.push({ cmdId: '#F' + k, statut: 'livré' });
    bac.tournees = [{ id: 'T-F', stops }]; bac.commandes = [];
    await bac.livControleNonRemontees(1000); await bac.livControleNonRemontees(130000);
    test('1er contrôle : 10 lectures (F0…F9, toutes en échec)', lus.length === 10 && lus.every(k => k < 10), lus);
    lus.length = 0; await bac.livControleNonRemontees(160000);
    test('contrôle suivant : F10 et F11 (jamais lues) passent en premier', lus.indexOf(10) >= 0 && lus.indexOf(11) >= 0 && lus.length === 10, lus);
    lus.length = 0; await bac.livControleNonRemontees(190000);
    test('ensuite : les commandes en panne sont relues (la plus ancienne tentative d\'abord), F10 et F11 lues livrées non relues', lus.length === 10 && lus.indexOf(10) < 0 && lus.indexOf(11) < 0, lus);
    test('aucune alerte (pannes = on réessaie, F10/F11 livrées)', bac._notifs.length === 0, bac._notifs.length);
  }

  // ══════════ v7.5.196 (réserves Codex sur a84fa19) ══════════
  const attendre = async (n) => { for (let k = 0; k < (n || 12); k++) await new Promise(r => setImmediate(r)); };
  // base simulée : PATCH conditionnel (…&stock=eq.N) respecté, lecture du stock, upsert ; bac.panne(url, opt) → 'reseau'
  function bacStock(base, opts) {
    let bac = null;
    bac = nouveauBac(Object.assign({}, opts, { reponse: (url, opt) => {
      if (bac.panne && bac.panne(url, opt)) return 'reseau';
      const id = decodeURIComponent((url.match(/id=eq\.([^&]+)/) || [])[1] || '');
      const body = opt.body ? JSON.parse(opt.body) : {};
      if (bac.avantReponse) bac.avantReponse(url, opt);
      if (opt.method === 'PATCH') {
        const c = url.match(/&stock=eq\.(-?\d+)/);
        if (!base[id] || (c && base[id].stock !== Number(c[1]))) return { status: 200, json: [] };
        Object.assign(base[id], body); return { status: 200, json: [{ id }] };
      }
      if (opt.method === 'POST' && /\/produits$/.test(url)) { base[body.id] = Object.assign(base[body.id] || { stock: 0 }, body); return { status: 201 }; }
      if (/produits\?select=id,stock&/.test(url)) return { status: 200, json: base[id] ? [{ id, stock: base[id].stock }] : [] };
      return { status: 200, json: [] };
    } }));
    return bac;
  }
  function brancherStock(bac, produits, commandes) {
    Object.assign(bac, { produits, stkMouvements: [], finRender() {}, stkRender() {} });
    bac.stkTrouverProduit = (pid, nom) => bac.produits.find(p => p.id === pid || p.nom === nom) || null;
    if (commandes) bac.commandes = commandes;
    vm.runInContext(CODE_STK, bac);
  }
  const dedDe = (st) => { try { return JSON.parse(st.mx_deductions_attente || '{}'); } catch (e) { return {}; } };
  const fileDe = (st) => { try { return JSON.parse(st.mx_offline_queue || '[]'); } catch (e) { return []; } };
  const patchs = (bac) => bac._envois.filter(e => e.method === 'PATCH');

  console.log('\n23. (P2 sur a84fa19, v7.5.196) FERMETURE PENDANT LA SAUVEGARDE DU « LIVRÉ » PUIS RECHARGEMENT : DÉDUCTION REPRISE UNE FOIS');
  let stockageFerme = null;
  {
    const { bac } = bacSignature('normal');
    brancherStock(bac, [PROD('p1', 5, 'Matelas R')]);
    bac.commandes[0].produit = 'Matelas R'; bac.commandes[0].stockDeduit = false;
    let nSave = 0; bac.sbSaveCommande = () => { nSave++; return new Promise(() => {}); }; // l'envoi n'aboutit jamais : application fermée
    bac.validerSig(); await attendre();
    const ded = dedDe(bac._stockage)['#T10'], wa = fileDe(bac._stockage).find(i => i.type === 'commande' && i.data.id === '#T10');
    test('avant l\'envoi du « livré » : déduction « a_deduire » gardée sur l\'appareil', ded && ded.etat === 'a_deduire' && ded.lignes[0].nom === 'Matelas R', ded);
    test('avant l\'envoi : le « livré » et son encaissement sont gardés dans la file (Payé, 100)', wa && wa.data.statut === 'livré' && wa.data.stpaie === 'Payé' && wa.data.montantEnc === 100, wa);
    test('fermeture pendant l\'envoi : aucune déduction lancée, stock_deduit pas encore vrai', patchs(bac).length === 0 && nSave === 1 && !bac.commandes[0].stockDeduit, [patchs(bac).length, nSave]);
    stockageFerme = JSON.parse(JSON.stringify(bac._stockage));
  }
  {
    // rechargement : la base a reçu le « livré » (stock_deduit faux) ; produits relus
    const base = { p1: { id: 'p1', nom: 'Matelas R', stock: 5 } };
    const bac = bacStock(base, { role: 'livreur', stockage: JSON.parse(JSON.stringify(stockageFerme)) });
    brancherStock(bac, [PROD('p1', 5, 'Matelas R')], [{ id: '#T10', client: 'Client Test', prix: 100, statut: 'livré', stpaie: 'Payé', montantEnc: 100, produit: 'Matelas R', qte: 1, stockDeduit: false }]);
    const saves = []; bac.sbSaveCommande = async (c) => { saves.push({ statut: c.statut, stockDeduit: !!c.stockDeduit, stpaie: c.stpaie }); };
    await bac.dedReprendre(); await attendre();
    test('rechargement : déduction reprise, PATCH conditionnel stock=eq.5 → 4', patchs(bac).length === 1 && /&stock=eq\.5&/.test(patchs(bac)[0].url) && base.p1.stock === 4, [patchs(bac).map(e => e.url), base.p1.stock]);
    test('rechargement : stock_deduit = vrai enregistré (livré gardé), suivi effacé', saves.some(s => s.stockDeduit && s.statut === 'livré' && s.stpaie === 'Payé') && !dedDe(bac._stockage)['#T10'], [saves, dedDe(bac._stockage)]);
    await bac.dedReprendre(); await attendre();
    test('une seule fois : nouvelle reprise sans nouvel envoi (stock 4)', patchs(bac).length === 1 && base.p1.stock === 4, patchs(bac).length);
    await bac.offlineQueueFlush();
    test('le « livré » gardé dans la file est rejoué (livré, Payé)', saves.filter(s => s.statut === 'livré' && s.stpaie === 'Payé').length >= 2, saves);
  }
  {
    // rechargement : le « livré » n'était PAS arrivé en base (en-route) ; il attend dans la file
    const base = { p1: { id: 'p1', nom: 'Matelas R', stock: 5 } };
    const bac = bacStock(base, { role: 'livreur', stockage: JSON.parse(JSON.stringify(stockageFerme)) });
    brancherStock(bac, [PROD('p1', 5, 'Matelas R')], [{ id: '#T10', client: 'Client Test', prix: 100, statut: 'en-route', produit: 'Matelas R', qte: 1, stockDeduit: false }]);
    const saves = []; bac.sbSaveCommande = async (c, ctx) => { saves.push({ statut: c.statut, stockDeduit: !!c.stockDeduit }); bac.oqSucces('commande', c, ctx && ctx.ts, null); };
    await bac.dedReprendre(); await attendre();
    test('« livré » pas encore en base : aucune déduction (rien n\'est deviné)', patchs(bac).length === 0 && dedDe(bac._stockage)['#T10'].etat === 'a_deduire');
    await bac.offlineQueueFlush();
    test('rejeu de la file : le « livré » perdu est renvoyé', saves.length === 1 && saves[0].statut === 'livré', saves);
    bac.commandes[0].statut = 'livré'; // la relève relit la commande « livré »
    await bac.dedReprendre(); await attendre(); await bac.dedReprendre(); await attendre();
    test('ensuite : déduction faite une seule fois (5 → 4) et stock_deduit enregistré', patchs(bac).length === 1 && base.p1.stock === 4 && saves.some(s => s.stockDeduit), [patchs(bac).length, base.p1.stock, saves]);
  }
  {
    // commande annulée entre-temps : la déduction suivie est abandonnée sans envoi
    const bac = bacStock({ p1: { id: 'p1', stock: 5 } }, { role: 'livreur', stockage: JSON.parse(JSON.stringify(stockageFerme)) });
    brancherStock(bac, [PROD('p1', 5, 'Matelas R')], [{ id: '#T10', statut: 'annulé', produit: 'Matelas R', stockDeduit: false }]);
    await bac.dedReprendre();
    test('commande annulée : suivi effacé, aucun envoi', patchs(bac).length === 0 && !dedDe(bac._stockage)['#T10']);
  }

  console.log('\n24. (réserve 1 sur a84fa19, v7.5.196) UNE VERSION EN FILE N\'ÉCRASE JAMAIS UNE VERSION PLUS RÉCENTE ENREGISTRÉE');
  function bacCommandeReelle(opts) {
    const bac = nouveauBac(opts);
    Object.assign(bac, { paiVerrouBody() {}, showSync() {} });
    vm.runInContext(CODE_CMD, bac);
    return bac;
  }
  {
    const bac = bacCommandeReelle({ role: 'admin', fileStockee: [{ type: 'commande', data: { id: '#K2', client: 'Ancien' }, ts: 1, oqv: 2, role: 'admin' }] });
    await bac.sbSaveCommande({ id: '#K2', client: 'Récent' });
    test('sauvegarde réussie de la version récente : l\'ancienne version quitte la file', bac.offlineQueue.length === 0, bac.offlineQueue);
    bac._envois.length = 0; await bac.offlineQueueFlush();
    test('rejeu ensuite : rien n\'est renvoyé (la version récente n\'est pas écrasée)', bac._envois.length === 0, bac._envois.map(e => e.body && e.body.client));
    bac.offlineQueueAdd('commande', { id: '#K2', client: 'Ancien' }, { ts: 1, role: 'admin' });
    test('une ancienne version qui échoue après coup n\'entre plus en file', bac.offlineQueue.length === 0, bac.offlineQueue.length);
    bac.offlineQueueAdd('commande', { id: '#K2', client: 'Plus récent encore' });
    test('une version plus récente que le succès entre toujours en file', bac.offlineQueue.length === 1);
  }
  {
    // pendant un rejeu : une fiche plus récente est enregistrée directement → la fiche en file (plus ancienne) est sautée
    const base = { p1: { id: 'p1', nom: 'Matelas', stock: 2 } };
    const bac = bacStock(base, { role: 'admin', fileStockee: [
      { type: 'commande', data: { id: '#K5' }, ts: 1, oqv: 2, role: 'admin' },
      { type: 'produit', data: PROD('p1', 5, 'Fiche ancienne'), ts: 2, oqv: 2, role: 'admin' }] });
    bac.sbSaveCommande = async () => { await bac.sbSaveProduit(PROD('p1', 9, 'Fiche récente')); };
    await bac.offlineQueueFlush();
    const posts = bac._envois.filter(e => e.method === 'POST');
    test('fiche plus récente enregistrée pendant le rejeu : l\'ancienne n\'est pas envoyée (état final « Fiche récente », stock 9)', posts.length === 1 && base.p1.nom === 'Fiche récente' && base.p1.stock === 9 && bac.offlineQueue.length === 0, [posts.map(p => p.body.nom), base.p1]);
  }
  {
    const bac = nouveauBac({ role: 'admin', fileStockee: [{ type: 'produit', data: PROD('p1', 5, 'Fiche ancienne'), ts: 2, oqv: 2, role: 'admin' }] });
    await bac.sbSaveProduit(PROD('p1', 9, 'Fiche récente'));
    test('fiche : succès direct plus récent → l\'ancienne fiche en file est retirée', bac.offlineQueue.length === 0, bac.offlineQueue);
  }

  console.log('\n25. (réserve 2 sur a84fa19, v7.5.196) stock_deduit = vrai SEULEMENT QUAND TOUS LES PRODUITS SONT ENREGISTRÉS');
  function cmdDeux(id) { return { id, client: 'Client D', statut: 'livré', stockDeduit: false, lignes: [{ produitId: 'p1', nom: 'Matelas 1', qte: 1 }, { produitId: 'p2', nom: 'Sommier 2', qte: 1 }] }; }
  {
    const base = { p1: { id: 'p1', stock: 5 }, p2: { id: 'p2', stock: 5 } };
    const bac = bacStock(base, { role: 'livreur' });
    bac.avantReponse = () => {};
    const rep0 = bac.fetch; bac.fetch = async (url, opt) => (/id=eq\.p2/.test(url) && opt && opt.method === 'PATCH') ? { ok: false, status: 403, text: async () => 'refus', json: async () => [] } : rep0(url, opt);
    brancherStock(bac, [PROD('p1', 5, 'Matelas 1'), PROD('p2', 5, 'Sommier 2')], [cmdDeux('#D2')]);
    const saves = []; bac.sbSaveCommande = async (c) => { saves.push(!!c.stockDeduit); };
    await bac.stkDeduireStock('#D2', bac.commandes[0]); await attendre();
    test('un produit refusé définitivement : stock_deduit reste faux (aucune sauvegarde stock_deduit = vrai)', !bac.commandes[0].stockDeduit && !saves.includes(true), saves);
    test('état « echec » gardé + notification « Déduction de stock en échec : #D2 — stock à vérifier »', dedDe(bac._stockage)['#D2'].etat === 'echec' && bac._notifs.some(n => n[2] === 'Déduction de stock en échec : #D2 — stock à vérifier'), [dedDe(bac._stockage), bac._notifs.map(n => n[2])]);
    const n0 = bac._envois.length; await bac.stkDeduireStock('#D2', bac.commandes[0]); await bac.dedReprendre(); await attendre();
    test('en échec : jamais redéduite automatiquement (aucun nouvel envoi)', bac._envois.length === n0 && base.p1.stock === 4, [bac._envois.length - n0, base.p1.stock]);
  }
  {
    const base = { p1: { id: 'p1', stock: 5 }, p2: { id: 'p2', stock: 5 } };
    const bac = bacStock(base, { role: 'livreur' });
    let coupure = true; bac.panne = (url) => coupure && /id=eq\.p2/.test(url);
    brancherStock(bac, [PROD('p1', 5, 'Matelas 1'), PROD('p2', 5, 'Sommier 2')], [cmdDeux('#D3')]);
    const saves = []; bac.sbSaveCommande = async (c) => { saves.push(!!c.stockDeduit); };
    await bac.stkDeduireStock('#D3', bac.commandes[0]); await attendre();
    const e = dedDe(bac._stockage)['#D3'];
    test('un produit gardé en file (coupure) : « déduction en attente », stock_deduit faux', e && e.etat === 'envoi' && Object.keys(e.produits).join() === 'p2' && !bac.commandes[0].stockDeduit && !saves.includes(true), [e, saves]);
    coupure = false; await bac.offlineQueueFlush(); await attendre();
    test('rejeu réussi du produit : stock_deduit = vrai enregistré, suivi effacé (p2 5 → 4)', bac.commandes[0].stockDeduit === true && saves.includes(true) && !dedDe(bac._stockage)['#D3'] && base.p2.stock === 4, [saves, dedDe(bac._stockage), base.p2]);
  }
  {
    // tout réussit : comportement normal (stock_deduit vrai, suivi effacé)
    const base = { p1: { id: 'p1', stock: 5 }, p2: { id: 'p2', stock: 5 } };
    const bac = bacStock(base, { role: 'livreur' });
    brancherStock(bac, [PROD('p1', 5, 'Matelas 1'), PROD('p2', 5, 'Sommier 2')], [cmdDeux('#D4')]);
    const saves = []; bac.sbSaveCommande = async (c) => { saves.push(!!c.stockDeduit); };
    await bac.stkDeduireStock('#D4', bac.commandes[0]); await attendre();
    test('tous les produits enregistrés : stock_deduit vrai, suivi effacé, 4/4', saves.includes(true) && !dedDe(bac._stockage)['#D4'] && base.p1.stock === 4 && base.p2.stock === 4, [saves, base]);
  }

  {
    // deux livraisons du même produit : la 1re en file (coupure), la 2e enregistrée tout de suite → la 1re reste
    // « en attente » (le succès de la 2e ne la conclut pas) ; conclue après SON rejeu
    const base = { p1: { id: 'p1', stock: 5 } };
    const bac = bacStock(base, { role: 'livreur' });
    let coupure = true; bac.panne = () => coupure;
    const c1 = { id: '#D5', statut: 'livré', stockDeduit: false, produit: 'Matelas 1', qte: 1 }, c2 = { id: '#D6', statut: 'livré', stockDeduit: false, produit: 'Matelas 1', qte: 1 };
    brancherStock(bac, [PROD('p1', 5, 'Matelas 1')], [c1, c2]);
    const saves = []; bac.sbSaveCommande = async (c) => { saves.push([c.id, !!c.stockDeduit]); };
    await bac.stkDeduireStock('#D5', c1); await attendre();
    coupure = false; await bac.stkDeduireStock('#D6', c2); await attendre();
    test('2e livraison enregistrée : la 1re (en file) n\'est PAS conclue, la 2e l\'est', !c1.stockDeduit && c2.stockDeduit === true && dedDe(bac._stockage)['#D5'].etat === 'envoi' && !dedDe(bac._stockage)['#D6'], [c1.stockDeduit, c2.stockDeduit, dedDe(bac._stockage)]);
    await bac.offlineQueueFlush(); await attendre();
    test('rejeu de la 1re : conclue (stock_deduit vrai), stock final 3 (deux déductions)', c1.stockDeduit === true && !dedDe(bac._stockage)['#D5'] && base.p1.stock === 3, [c1.stockDeduit, dedDe(bac._stockage), base.p1]);
  }

  console.log('\n26. (réserve 3 sur a84fa19, v7.5.196) PATCH DU LIVREUR CONDITIONNEL (stock=eq.<avant>), DELTA RÉAPPLIQUÉ UNE FOIS');
  {
    const base = { p1: { id: 'p1', stock: 5 } };
    const bac = bacStock(base, { role: 'livreur' });
    const r = await bac.sbSaveProduit(PROD('p1', 4), { avant: 5, delta: 1 });
    test('sans conflit : un PATCH …&stock=eq.5, base 4, résultat « ok »', r === 'ok' && patchs(bac).length === 1 && /&stock=eq\.5&/.test(patchs(bac)[0].url) && base.p1.stock === 4, [r, patchs(bac).map(e => e.url), base.p1]);
  }
  {
    const base = { p1: { id: 'p1', stock: 7 } }; // réassort fait ailleurs : 7 au lieu de 5
    const bac = bacStock(base, { role: 'livreur' });
    const r = await bac.sbSaveProduit(PROD('p1', 4), { avant: 5, delta: 1 });
    test('conflit (stock changé ailleurs) : relecture puis delta réappliqué → 6 (le réassort n\'est pas écrasé)', r === 'ok' && base.p1.stock === 6 && patchs(bac).length === 2 && /&stock=eq\.7&/.test(patchs(bac)[1].url) && bac._notifs.length === 0, [r, base.p1, patchs(bac).map(e => e.url)]);
  }
  {
    const base = { p1: { id: 'p1', stock: 7 } };
    const bac = bacStock(base, { role: 'livreur' });
    let n = 0; bac.avantReponse = (url, opt) => { if (opt.method === 'PATCH' && ++n === 2) base.p1.stock = 8; }; // encore changé entre la relecture et le 2e essai
    const r = await bac.sbSaveProduit(PROD('p1', 4, 'Matelas Z'), { avant: 5, delta: 1 });
    test('deux conflits : rien d\'écrasé (8), « Stock non mis à jour : Matelas Z — à vérifier », pas de file', r === 'refus' && base.p1.stock === 8 && bac._notifs.some(x => x[2] === 'Stock non mis à jour : Matelas Z — à vérifier') && bac.offlineQueue.length === 0, [r, base.p1, bac._notifs.map(x => x[2])]);
  }
  {
    // deux déductions du même produit en coupure : un seul élément en file, les deltas s'additionnent
    const base = { p1: { id: 'p1', stock: 6 } }; // +1 réassort pendant la coupure (5 → 6)
    const bac = bacStock(base, { role: 'livreur' });
    let coupure = true; bac.panne = () => coupure;
    await bac.sbSaveProduit(PROD('p1', 4), { avant: 5, delta: 1 });
    await bac.sbSaveProduit(PROD('p1', 3), { avant: 4, delta: 1 });
    const it = bac.offlineQueue[0] || {};
    test('coupure : un seul élément en file, avant 5, delta 2', bac.offlineQueue.length === 1 && it.avant === 5 && it.delta === 2, bac.offlineQueue);
    coupure = false; await bac.offlineQueueFlush();
    test('rejeu : conflit (6 ≠ 5) → 6 − 2 = 4 (aucune déduction perdue, réassort gardé), file vide', base.p1.stock === 4 && bac.offlineQueue.length === 0, [base.p1, bac.offlineQueue]);
  }
  {
    // un rejeu réussit pendant qu'une nouvelle déduction (qui l'avait fusionné) attend : pas de double compte
    const base = { p1: { id: 'p1', stock: 5 } };
    const bac = bacStock(base, { role: 'livreur', fileStockee: [{ type: 'produit', data: PROD('p1', 4), ts: 1, oqv: 2, role: 'livreur', avant: 5, delta: 1 }] });
    let n = 0; bac.avantReponse = (url, opt) => { if (opt.method === 'PATCH' && ++n === 1) bac.offlineQueueAdd('produit', PROD('p1', 3), { ts: 2, role: 'livreur', avant: 4, delta: 1 }); };
    await bac.offlineQueueFlush();
    const it = bac.offlineQueue[0] || {};
    test('rejeu réussi (5 → 4) : l\'élément récent ne garde que SON delta (avant 4, delta 1)', base.p1.stock === 4 && bac.offlineQueue.length === 1 && it.avant === 4 && it.delta === 1, [base.p1, bac.offlineQueue]);
    await bac.offlineQueueFlush();
    test('second rejeu : 4 → 3 (deux déductions, ni plus ni moins)', base.p1.stock === 3 && bac.offlineQueue.length === 0, [base.p1, bac.offlineQueue]);
  }
  {
    const base = { p1: { id: 'p1', stock: 5 } };
    const bac = bacStock(base, { role: 'livreur', fileStockee: [{ type: 'produit', data: PROD('p1', 2), ts: 1, oqv: 2, role: 'livreur' }] });
    await bac.offlineQueueFlush();
    test('ancien élément sans delta (v7.5.191-195) : valeur absolue comme avant (PATCH sans condition)', base.p1.stock === 2 && patchs(bac).length === 1 && !/stock=eq/.test(patchs(bac)[0].url), patchs(bac).map(e => e.url));
  }

  console.log('\n27. (réserve 4 sur a84fa19, v7.5.196) ANCIENNES FICHES ADMIN : DÉDOUBLONNÉES APRÈS LE TRI AVEC LES FICHES RÉCENTES, SELON LEUR DATE');
  for (const [lib, tsAncien, tsRecent, gagnant] of [['ancienne fiche plus ANCIENNE', 5, 10, 'Fiche oqv'], ['ancienne fiche plus RÉCENTE', 10, 5, 'Fiche sans oqv']]) {
    const base = { p1: { id: 'p1', nom: 'Matelas', stock: 1, updated_at: new Date(0).toISOString() } };
    const bac = bacStock(base, { role: null, fileStockee: [
      { type: 'produit', data: PROD('p1', 6, 'Fiche sans oqv'), ts: tsAncien },
      { type: 'produit', data: PROD('p1', 7, 'Fiche oqv'), ts: tsRecent, oqv: 2, role: 'admin' }] });
    bac.lecture = () => ({ status: 200, json: [{ id: 'p1', updated_at: new Date(0).toISOString() }] });
    bac.role = 'admin'; bac.oqAppliquerRole('admin');
    const ps = bac.offlineQueue.filter(i => i.type === 'produit');
    test(lib + ' : une seule fiche après le tri (« ' + gagnant + ' »)', ps.length === 1 && ps[0].data.nom === gagnant, ps.map(i => [i.data.nom, i.ts]));
    await bac.offlineQueueFlush();
    const posts = bac._envois.filter(e => e.method === 'POST');
    test(lib + ' : un seul envoi, état final « ' + gagnant + ' »', posts.length === 1 && base.p1.nom === gagnant, [posts.map(p => p.body.nom), base.p1.nom]);
  }

  console.log('\n7. TEXTE DU CODE');
  // v7.5.196 : chaque mise en file d'un produit est sur une ligne de coupure réseau (catch) ou d'erreur temporaire
  { const lignesE = CODE_PRODUIT.split('\n').filter(l => /sbSaveEchec\('produit'/.test(l));
    test('un refus définitif de produit ne passe pas par sbSaveEchec (seulement coupure ou erreur temporaire)', lignesE.length >= 5 && lignesE.every(l => /catch\(e\)|httpTemporaire\(|etat === 'reseau' \|\| (essai|lu)\.etat === 'temp'/.test(l)), lignesE); }
  test('le rejeu lit une copie (_aRejouer), pas la file qui grandit', /_aRejouer\.length/.test(CODE_REJEU) && !/i < offlineQueue\.length/.test(CODE_REJEU));
  test('loginOk trie les anciens éléments dès que le rôle est connu', /function loginOk\(r\) \{\s*role=r;\s*\/\/[^\n]*\n\s*try \{ oqAppliquerRole\(r\); \}/.test(html));
  test('le bouton « Relancer » existe sur la page Stock', /id="stk-refus-btn"[^>]*onclick="produitsRefusesRelancer\(\)"/.test(html));
  test('relève (polling) : passe par cmdPollingAppliquer et lit updated_at', /select=' \+ CMD_SELECT_COLS \+ ',updated_at&order=updated_at\.desc/.test(html) && /if \(cmdPollingAppliquer\(mapped\)\) updated = true;/.test(html));
  test('Realtime : une version périmée ne remplace pas la commande (cmdDistanteAcceptable)', /if \(!cmdDistanteAcceptable\(commandes\[idx\], mapped\)\) return;/.test(html));
  test('rechargement complet : cmdFusionnerChargees + updated_at lu', /commandes = cmdFusionnerChargees\(commandes, _cmdsAvant\)/.test(html) && /select=' \+ CMD_SELECT_COLS \+ ',updated_at&order=created_at\.desc'/.test(html));
  test('setLvSt : « livré » marqué et déduction sur l\'objet validé', /livMarquer\(cLv\.id\);[^\n]*\n[^\n]*\n\s*try \{ stkDeduireStock\(cLv\.id, cLv\); \}/.test(html));
  const sw = fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8');
  test('CACHE_VERSION augmenté (v7-5-196 ou plus)', /CACHE_VERSION = 'maxiconfort-v7-5-(19[6-9]|[2-9]\d\d)'/.test(sw));
  test('validerSig garde la déduction et le « livré » AVANT l\'envoi (dedPoser, offlineQueueAdd, puis sbSaveCommande)', /dedPoser\(_cmdLivre\);[\s\S]{0,200}offlineQueueAdd\('commande', _cmdLivre\);[\s\S]{0,200}_pLivre = sbSaveCommande\(_cmdLivre\)/.test(CODE_SIG));
  test('reprise des déductions au chargement et à la relève (dedReprendre)', (html.match(/dedReprendre\(\)/g) || []).length >= 2);

  console.log('\n' + ok + ' réussi(s), ' + ko + ' échec(s)');
  process.exit(ko ? 1 : 0);
})().catch(e => { console.error('ERREUR DU BANC :', e); process.exit(2); });
