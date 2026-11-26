// Banc de test du correctif v7.5.191 (26/11/2026) : le « livré » du livreur ne remontait plus depuis le 24/11.
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

function fauxElement(id) { return { id, value: '', checked: true, style: {}, dataset: {}, innerHTML: '', textContent: '', classList: { add() {}, remove() {}, contains() { return false; } } }; }

// reponse(url, opt) → { status } (réponse HTTP) ou 'reseau' (fetch qui lève)
function nouveauBac({ role = 'livreur', fileStockee = null, reponse = () => ({ status: 200 }) } = {}) {
  const stockage = {}; if (fileStockee) stockage.mx_offline_queue = JSON.stringify(fileStockee);
  const els = {};
  const bac = {
    console: { log() {}, warn() {}, error() {} }, Math, Date, JSON, String, Array, Object, Number, parseInt, parseFloat, isNaN, Promise, encodeURIComponent,
    setTimeout: () => 0,
    SUPABASE_URL: 'https://exemple.invalid', SUPABASE_KEY: 'cle-de-test', role, livNom: 'LIVREUR-TEST',
    localStorage: { getItem: k => (k in stockage ? stockage[k] : null), setItem: (k, v) => { stockage[k] = String(v); bac._ecritures++; } }, _ecritures: 0, _stockage: stockage,
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

  console.log('\n3. REFUS DE LA BASE (4xx) : PAS DE FILE, UNE SEULE NOTIFICATION PAR PRODUIT');
  for (const r of ['livreur', 'admin']) {
    const bac = nouveauBac({ role: r, reponse: () => ({ status: 401, texte: 'new row violates row-level security policy' }) });
    await bac.sbSaveProduit(PROD('p1', 3, 'Matelas Test 140'));
    await bac.sbSaveProduit(PROD('p1', 2, 'Matelas Test 140'));
    await bac.sbSaveProduit(PROD('p2', 2, 'Sommier Test 140'));
    test(r + ' : refus 401 → rien en file', bac.offlineQueue.length === 0, bac.offlineQueue);
    test(r + ' : une notification par produit (2 produits, 3 refus → 2 notifications)', bac._notifs.length === 2, bac._notifs.map(n => n[2]));
    test(r + ' : texte « Stock non mis à jour : <produit> — à vérifier »', bac._notifs[0] && bac._notifs[0][2] === 'Stock non mis à jour : Matelas Test 140 — à vérifier', bac._notifs[0] && bac._notifs[0][2]);
    test(r + ' : pas de toast « réessai auto »', !bac._toasts.some(t => /réessai/.test(t[0])), bac._toasts);
  }
  {
    const bac = nouveauBac({ role: 'livreur', reponse: () => 'reseau' });
    await bac.sbSaveProduit(PROD('p1', 3)); await bac.sbSaveProduit(PROD('p1', 2)); await bac.sbSaveProduit(PROD('p2', 9));
    test('vraie coupure réseau → en file', bac.offlineQueue.length === 2, bac.offlineQueue.length);
    test('une seule entrée par produit, la plus récente (stock 2)', bac.offlineQueue.filter(i => i.data.id === 'p1').length === 1 && bac.offlineQueue.find(i => i.data.id === 'p1').data.stock === 2);
  }
  {
    const bac = nouveauBac({ role: 'livreur', reponse: () => ({ status: 403 }) });
    bac.offlineQueue.push({ type: 'produit', data: PROD('p3', 1), ts: 1, oqv: 2 });
    await bac.offlineQueueFlush();
    test('rejeu d\'un produit refusé (403) : retiré de la file, pas remis', bac.offlineQueue.length === 0 && bac._envois.length === 1, [bac.offlineQueue.length, bac._envois.length]);
  }

  console.log('\n4. ANCIENNES MISES À JOUR DE STOCK PURGÉES AU CHARGEMENT');
  {
    const ancienne = [
      { type: 'produit', data: PROD('p1', 5, 'Matelas A'), ts: 1 },
      { type: 'commande', data: { id: '#9001', statut: 'livré' }, ts: 2 },
      { type: 'produit', data: PROD('p1', 4, 'Matelas A'), ts: 3 },
      { type: 'produit', data: PROD('p2', 7, 'Sommier B'), ts: 4 },
      { type: 'tournee', data: { id: 'T-1' }, ts: 5 },
    ];
    const bac = nouveauBac({ role: 'livreur', fileStockee: ancienne });
    test('les 3 éléments produit sont retirés au chargement', bac.offlineQueue.filter(i => i.type === 'produit').length === 0, bac.offlineQueue.map(i => i.type));
    test('commande et tournée restent en file', bac.offlineQueue.map(i => i.type).join(',') === 'commande,tournee');
    test('la file nettoyée est réécrite dans le téléphone', JSON.parse(bac._stockage.mx_offline_queue).length === 2);
    test('pas de notification avant la connexion', bac._notifs.length === 0);
    bac.oqSignalerPurge();
    const n = bac._notifs[0] || [];
    test('après la connexion : UNE notification récapitulative', bac._notifs.length === 1, bac._notifs.length);
    test('elle dit « 3 mises à jour de stock anciennes non envoyées (produits : Matelas A, Sommier B) — stock à vérifier à l\'inventaire »', /^3 mises à jour de stock anciennes non envoyées \(produits : Matelas A, Sommier B\) — stock à vérifier à l'inventaire/.test(n[3] || ''), n[3]);
    bac.oqSignalerPurge();
    test('une seule fois', bac._notifs.length === 1);
    await bac.offlineQueueFlush();
    test('le rejeu n\'envoie aucun ancien stock', !bac._envois.some(e => /produits/.test(e.url)), bac._envois.map(e => e.url));
  }
  {
    const bac = nouveauBac({ role: 'livreur', fileStockee: [{ type: 'produit', data: PROD('p5', 2), ts: 1, oqv: 2 }] });
    test('un produit mis en file par la version corrigée (coupure réseau) est gardé', bac.offlineQueue.length === 1);
    bac.oqSignalerPurge();
    test('et ne déclenche pas la notification de purge', bac._notifs.length === 0);
  }
  {
    const bac = nouveauBac({ fileStockee: [{ type: 'commande', data: { id: '#1' }, ts: 1 }] });
    bac.oqSignalerPurge();
    test('file sans ancien produit : aucune notification', bac._notifs.length === 0 && bac.offlineQueue.length === 1);
  }

  console.log('\n5. validerSig ENREGISTRE LA COMMANDE MÊME SI LA DÉDUCTION DU STOCK LÈVE');
  function bacSignature(deduction) {
    const bac = nouveauBac({ role: 'livreur' });
    const ordre = [];
    Object.assign(bac, {
      clearSig() {}, renderLivreur() {}, renderTournees() {}, renderCmds() {}, renderDash() {}, confirm: () => false, genererBonLivraison() {},
      brevoSendSMS: async () => false, societe: { tel: '' }, paiTraceEncaissement: () => '',
      sbSaveTournee(t) { ordre.push('tournee'); },
      sbSaveCommande: async (c) => { ordre.push('commande:' + c.statut); },
      stkDeduireStock(id) { ordre.push('stock'); if (deduction === 'leve') throw new Error('produit introuvable'); },
    });
    vm.runInContext('var sigStopId=null, sigPaieEncaisse=false, sigPaieMode="Espèces", sigPrepaidMode=null, sigCmdMarketplace=null, sigCodActif=false, sigCodChoix=null, sigCodMontant=0;', bac);
    vm.runInContext(CODE_SIG, bac);
    bac.commandes = [{ id: '#T10', client: 'Client Test', prix: 100, statut: 'en-route', paie: 'Espèces', stpaie: 'Non payé', montantEnc: 0 }];
    bac.tournees = [{ id: 'T-10', livreur: 'LIVREUR-TEST', statut: 'en cours', stops: [{ cmdId: '#T10', client: 'Client Test', produit: 'Matelas', prix: 100, statut: 'en-route' }] }];
    bac.document.getElementById('sig-nom').value = 'Client Test';
    vm.runInContext('sigStopId = { tid: "T-10", idx: 0 }; sigPrepaidMode = "Déjà payé";', bac);
    return { bac, ordre };
  }
  for (const cas of ['normal', 'leve']) {
    const { bac, ordre } = bacSignature(cas);
    let erreur = null;
    try { bac.validerSig(); } catch (e) { erreur = e; }
    await new Promise(r => setImmediate(r));
    const lib = cas === 'leve' ? 'déduction qui lève' : 'déduction normale';
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

  console.log('\n6. CONTRÔLE ADMIN : LIVRAISON NON REMONTÉE (LECTURE SEULE)');
  {
    const bac = nouveauBac({ role: 'admin' });
    bac.tournees = [{ id: 'T-1', stops: [{ cmdId: '#1', statut: 'livré' }, { cmdId: '#2', statut: 'livré' }, { cmdId: '#3', statut: 'livré' }, { cmdId: '#4', statut: 'en-route' }, { cmdId: '#5', statut: 'livré' }] }];
    bac.commandes = [{ id: '#1', statut: 'en-route' }, { id: '#2', statut: 'livré' }, { id: '#3', statut: 'annulé' }, { id: '#4', statut: 'en-route' }];
    test('écarts trouvés : seulement #1 (livrée, annulée, en route et commande absente ignorées)', JSON.stringify(bac.livNonRemontees(bac.tournees, bac.commandes)) === '["#1"]', bac.livNonRemontees(bac.tournees, bac.commandes));
    const t0 = 1000000;
    bac.livControleNonRemontees(t0);
    test('premier constat : pas encore d\'alerte (laisse le temps au livreur d\'enregistrer)', bac._notifs.length === 0);
    bac.livControleNonRemontees(t0 + 60000);
    test('après 1 min : toujours pas d\'alerte', bac._notifs.length === 0);
    bac.livControleNonRemontees(t0 + 130000);
    test('après 2 min : une alerte « Livraison non remontée : #1 — vérifier »', bac._notifs.length === 1 && bac._notifs[0][2] === 'Livraison non remontée : #1 — vérifier', bac._notifs.map(n => n[2]));
    bac.livControleNonRemontees(t0 + 400000);
    test('une seule fois par commande et par session', bac._notifs.length === 1);
    test('aucune écriture (aucun envoi à la base)', bac._envois.length === 0 && bac.commandes[0].statut === 'en-route');
  }
  {
    const bac = nouveauBac({ role: 'admin' });
    bac.tournees = [{ id: 'T-1', stops: [{ cmdId: '#1', statut: 'livré' }] }];
    bac.commandes = [{ id: '#1', statut: 'en-route' }];
    bac.livControleNonRemontees(1000);
    bac.commandes[0].statut = 'livré'; bac.livControleNonRemontees(5000); // remontée entre-temps
    bac.commandes[0].statut = 'en-route'; bac.livControleNonRemontees(130000);
    test('un écart résorbé repart de zéro (pas d\'alerte sur un écart de quelques secondes)', bac._notifs.length === 0);
  }
  for (const r of ['livreur', 'collab']) {
    const bac = nouveauBac({ role: r });
    bac.tournees = [{ id: 'T-1', stops: [{ cmdId: '#1', statut: 'livré' }] }]; bac.commandes = [{ id: '#1', statut: 'en-route' }];
    bac.livControleNonRemontees(1); bac.livControleNonRemontees(500000);
    test(r + ' : pas de contrôle (administrateur seulement)', bac._notifs.length === 0);
  }

  console.log('\n7. TEXTE DU CODE');
  test('sbSaveEchec n\'est plus appelé pour un refus HTTP de produit', !/sbSaveEchec\('produit', p, 'Produit', resp(L)?\.status/.test(CODE_PRODUIT));
  test('le rejeu lit une copie (_aRejouer), pas la file qui grandit', /_aRejouer\.length/.test(CODE_REJEU) && !/i < offlineQueue\.length/.test(CODE_REJEU));
  const sw = fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8');
  test('CACHE_VERSION augmenté (v7-5-191)', /CACHE_VERSION = 'maxiconfort-v7-5-191'/.test(sw));

  console.log('\n' + ok + ' réussi(s), ' + ko + ' échec(s)');
  process.exit(ko ? 1 : 0);
})().catch(e => { console.error('ERREUR DU BANC :', e); process.exit(2); });
