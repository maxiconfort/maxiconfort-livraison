// Banc de test du correctif v7.5.191 / v7.5.192 / v7.5.193 / v7.5.194 / v7.5.195 / v7.5.196 / v7.5.197 / v7.5.198 / v7.5.199 (26-27/11/2026) : le « livré » du livreur ne remontait plus depuis le 24/11.
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
// v7.5.197 : la déduction du stock d'une livraison (stkDemanderDeduction, stkDeductionEnvoyer, stkReprendreDeductions)
// fait partie de CODE_FILE ; l'ancien calcul sur le téléphone (stkDeduireStock) est supprimé.
const CODE_CMD = extraireFonction('async function sbSaveCommande(cmd, oqCtx)'); // v7.5.196
// v7.5.198 (fusion dans la pile #24 → #28) : sbSaveCommande distingue un refus définitif (v7.5.135) ; validerSig s'appuie
// sur le bloc paiement (PAI) et sur les règles de caisse (RT) de la PR 24
const CODE_SYNC = extraireFonction('function syncRefusDefinitif(status)') + '\n' + extraireFonction('function syncMessageRefus(status, texte)');
const CODE_PAI_RT = extraireBloc('var PAI_MODE_SITE', '// PAI-FIN') + '\nvar RT_MOTIF_MIN = 5;\n' + ['function rtArrondi(n)', 'function rtEurTexte(n)', 'function rtResteDu(prix, montantEnc, stpaie)', 'function rtControleDejaPaye(resteDu, qui, motif)', 'function rtLivraisonsTerminees(t)', 'function rtStatutApresArret(t)'].map(extraireFonction).join('\n');

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
      bac._envois.push({ url, method: opt.method || 'GET', body: opt.body ? JSON.parse(opt.body) : null, prefer: opt.headers && opt.headers.Prefer, entetes: opt.headers || {} });
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
// v7.5.197 : base simulée de la fonction public.deduire_stock_livraison (migration 040) — même contrat : idempotente par
// stock_deduit, refus « commande_non_livree » / « commande_introuvable », réponse { ok, deja, retraits, manques }.
// b.absente → 404 PGRST202 (migration pas appliquée) ; b.panne → coupure AVANT la base ; b.perdre = n → l'effet est fait
// en base puis la réponse est perdue (n fois) ; b.http = code → réponse HTTP d'erreur.
// v7.5.198 : même contrat que la 040 révisée — rejeu « deja » avec le résultat COMPLET de la 1re déduction, operation_id,
// stocks_actuels ; recrédit depuis les sorties de la dernière déduction ; mouvements manuels idempotents par clé.
function baseRpc(cmds, stock) {
  const b = { cmds, stock, appels: 0, deductions: 0, recredits: 0, mouvements: 0, absente: false, perdre: 0, panne: false, http: 0, ops: 0, cles: {} };
  const actuels = (ids) => { const o = {}; ids.forEach(id => { if (id in b.stock) o[id] = b.stock[id]; }); return o; };
  b.reponse = (url, opt) => {
    const m = url.match(/\/rest\/v1\/rpc\/(deduire_stock_livraison|recrediter_stock_livraison|mouvement_stock_produit)$/);
    if (!m) return null;
    b.appels++;
    if (b.panne) return 'reseau';
    if (b.absente) return { status: 404, texte: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.' + m[1] }) };
    if (b.http) return { status: b.http, texte: '{}' };
    const corps = JSON.parse(opt.body);
    let rep;
    if (m[1] === 'deduire_stock_livraison') {
      const id = corps.p_cmd_id, c = b.cmds[id];
      if (!c) rep = { ok: false, erreur: 'commande_introuvable' };
      else if (c.stock_deduit) rep = (c.derniere && c.derniere.nature === 'deduction')
        ? Object.assign({}, c.derniere.resultat, { ok: true, deja: true, stock_deduit: true, operation_id: c.derniere.op, stocks_actuels: actuels(c.derniere.resultat.retraits.map(x => x.produit_id)) })
        : { ok: true, deja: true, stock_deduit: true, resultat_inconnu: true, retraits: [], manques: [], stocks_actuels: {} };
      else if (c.statut !== 'livré') rep = { ok: false, erreur: 'commande_non_livree', statut: c.statut };
      else {
        const retraits = [], manques = [];
        (c.lignes || []).forEach(l => {
          if (!(l.p in b.stock)) { manques.push({ produit_id: l.p, nom: l.p, raison: 'produit_introuvable', demande: l.q, retire: 0, manque: l.q }); return; }
          const av = b.stock[l.p]; b.stock[l.p] = Math.max(0, av - l.q);
          retraits.push({ produit_id: l.p, nom: l.p, qte: av - b.stock[l.p], demande: l.q, stock_avant: av, stock_apres: b.stock[l.p] });
          if (av - b.stock[l.p] < l.q) manques.push({ produit_id: l.p, nom: l.p, raison: 'stock_insuffisant', demande: l.q, retire: av - b.stock[l.p], manque: l.q - (av - b.stock[l.p]) });
        });
        c.stock_deduit = true; b.deductions++;
        c.derniere = { nature: 'deduction', op: ++b.ops, resultat: { retraits, manques } };
        rep = Object.assign({}, c.derniere.resultat, { ok: true, deja: false, stock_deduit: true, operation_id: c.derniere.op, stocks_actuels: actuels(retraits.map(x => x.produit_id)) });
      }
    } else if (m[1] === 'recrediter_stock_livraison') {
      const id = corps.p_cmd_id, c = b.cmds[id], sup = !!corps.p_suppression;
      if (b.role && b.role !== 'admin' && b.role !== 'collab') rep = { ok: false, erreur: 'droits_insuffisants' };
      else if (!c && !sup) rep = { ok: false, erreur: 'commande_introuvable' };
      else if (c && !c.stock_deduit) rep = (c.derniere && c.derniere.nature === 'recredit')
        ? Object.assign({}, c.derniere.resultat, { ok: true, deja: true, stock_deduit: false, operation_id: c.derniere.op, stocks_actuels: actuels(c.derniere.resultat.retours.map(x => x.produit_id)) })
        : { ok: true, deja: true, stock_deduit: false, resultat_inconnu: true, retours: [], stocks_actuels: {} };
      else if (c && c.statut === 'livré' && !sup) rep = { ok: false, erreur: 'commande_encore_livree', statut: c.statut };
      // v7.5.209 : suppression d'une commande déduite par une ancienne version (aucune déduction journalisée) : supprimée,
      // rien recrédité, « recredit_manuel_requis » avec les produits (comme la 040)
      else if (sup && c && (!c.derniere || c.derniere.nature !== 'deduction')) { rep = { ok: true, deja: false, stock_deduit: false, recredit_manuel_requis: true, deduction_certaine: !!c.stock_deduit, retours: [], produits: (c.lignes || []).map(l => ({ produit_id: l.p, nom: l.p, qte: l.q })), operation_id: ++b.ops, stocks_actuels: {} }; delete b.cmds[id]; }
      else if (!c.derniere || c.derniere.nature !== 'deduction') rep = { ok: false, erreur: 'sans_journal' };
      else {
        const retours = c.derniere.resultat.retraits.filter(x => x.qte > 0).map(x => { const av = b.stock[x.produit_id]; b.stock[x.produit_id] = av + x.qte; return { produit_id: x.produit_id, nom: x.nom, qte: x.qte, demande: x.qte, stock_avant: av, stock_apres: av + x.qte }; });
        c.stock_deduit = false; b.recredits++;
        c.derniere = { nature: 'recredit', op: ++b.ops, resultat: { retours } };
        rep = Object.assign({}, c.derniere.resultat, { ok: true, deja: false, stock_deduit: false, operation_id: c.derniere.op, stocks_actuels: actuels(retours.map(x => x.produit_id)) });
      }
    } else {
      const k = corps.p_cle, pid = corps.p_produit_id;
      if (b.role && b.role !== 'admin' && b.role !== 'collab') rep = { ok: false, erreur: 'droits_insuffisants' };
      else if (b.cles[k]) rep = b.cles[k].pid !== pid ? { ok: false, erreur: 'cle_deja_utilisee' } : Object.assign({}, b.cles[k].resultat, { ok: true, deja: true, operation_id: b.cles[k].op, stocks_actuels: actuels([pid]) });
      else if (!(pid in b.stock)) rep = { ok: false, erreur: 'produit_introuvable' };
      else {
        const av = b.stock[pid], q = corps.p_qte, t = corps.p_type;
        b.stock[pid] = t === 'sortie' ? Math.max(0, av - q) : t === 'correction' ? q : av + q;
        b.mouvements++;
        b.cles[k] = { pid, op: ++b.ops, resultat: { produit_id: pid, type: t, qte: q, delta: b.stock[pid] - av, stock_avant: av, stock_apres: b.stock[pid] } };
        rep = Object.assign({}, b.cles[k].resultat, { ok: true, deja: false, operation_id: b.cles[k].op, stocks_actuels: actuels([pid]) });
      }
    }
    if (b.perdre > 0) { b.perdre--; return 'reseau'; } // effet fait en base, réponse perdue
    return { status: 200, texte: JSON.stringify(rep) };
  };
  return b;
}
const rpcs = (bac) => bac._envois.filter(e => /\/rpc\/deduire_stock_livraison$/.test(e.url));

(async () => {
  console.log('\n1. LE REJEU NE BOUCLE PLUS QUAND UN PRODUIT ÉCHOUE');
  {
    // ancienne version (avant la correction : refus de la base) puis coupure réseau à chaque essai
    // (v7.5.198 : fiche admin ; le livreur n'écrit plus jamais le stock d'une fiche)
    const bac = nouveauBac({ role: 'admin', reponse: () => 'reseau' });
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

  console.log('\n2. (v7.5.198, réserve Codex n° 3) PLUS AUCUNE ÉCRITURE DU STOCK EN VALEUR ABSOLUE PAR L\'APPAREIL');
  {
    const bac = nouveauBac({ role: 'livreur' });
    const r = await bac.sbSaveProduit(PROD('p 7', 4));
    test('livreur : aucun envoi (ni PATCH ni POST) — une valeur absolue du téléphone écraserait un stock plus récent', bac._envois.length === 0 && r === 'refus', [bac._envois.length, r]);
    test('livreur : comptée dans le récapitulatif « 1 mises à jour de stock anciennes non envoyées (produits : Produit p 7) »', bac._notifs.length === 1 && /^1 mises à jour de stock anciennes non envoyées \(produits : Produit p 7\)/.test(bac._notifs[0][3]) && bac.offlineQueue.length === 0, bac._notifs.map(n => n[3]));
  }
  for (const r of ['admin', 'collab']) {
    const bac = nouveauBac({ role: r });
    await bac.sbSaveProduit(PROD('p9', 5));
    const e = bac._envois[0] || {};
    test(r + ' : fiche existante → POST merge-duplicates SANS le champ stock (la base garde son stock)', e.method === 'POST' && /\/rest\/v1\/produits$/.test(e.url) && /merge-duplicates/.test(e.prefer) && e.body.nom === 'Produit p9' && !('stock' in e.body), [e.method, e.url, e.prefer, e.body]);
    const pN = Object.assign(PROD('pr-neuf', 6, 'Produit Neuf'), { _nouveau: true });
    await bac.sbSaveProduit(pN);
    const eN = bac._envois[1] || {};
    test(r + ' : CRÉATION (marque _nouveau) → stock initial envoyé une fois, marque retirée après l\'enregistrement', eN.body && eN.body.stock === 6 && !('_nouveau' in eN.body) && !('_nouveau' in pN), [eN.body, pN]);
    await bac.sbSaveProduit(pN);
    test(r + ' : sauvegarde suivante du produit créé : sans le stock', !('stock' in (bac._envois[2] || {}).body), bac._envois[2] && bac._envois[2].body);
  }

  console.log('\n3. REFUS DÉFINITIF DE LA BASE (4xx) : PAS DE FILE, UNE SEULE NOTIFICATION PAR PRODUIT');
  for (const r of ['collab', 'admin']) {
    const bac = nouveauBac({ role: r, reponse: () => ({ status: 401, texte: 'new row violates row-level security policy' }) });
    await bac.sbSaveProduit(PROD('p1', 3, 'Matelas Test 140'));
    await bac.sbSaveProduit(PROD('p1', 2, 'Matelas Test 140'));
    await bac.sbSaveProduit(PROD('p2', 2, 'Sommier Test 140'));
    test(r + ' : refus 401 → rien en file', bac.offlineQueue.length === 0, bac.offlineQueue);
    test(r + ' : une notification par produit (2 produits, 3 refus → 2 notifications)', bac._notifs.length === 2, bac._notifs.map(n => n[2]));
    const attendu = 'Fiche produit non enregistrée : Matelas Test 140 (refus de la base) — à vérifier';
    test(r + ' : texte « ' + attendu + ' »', bac._notifs[0] && bac._notifs[0][2] === attendu, bac._notifs[0] && bac._notifs[0][2]);
    test(r + ' : pas de toast « réessai auto »', !bac._toasts.some(t => /réessai/.test(t[0])), bac._toasts);
  }
  {
    const bac = nouveauBac({ role: 'admin', reponse: () => 'reseau' });
    await bac.sbSaveProduit(PROD('p1', 3)); await bac.sbSaveProduit(PROD('p1', 2)); await bac.sbSaveProduit(PROD('p2', 9));
    test('vraie coupure réseau → en file', bac.offlineQueue.length === 2, bac.offlineQueue.length);
    test('une seule entrée par produit, la plus récente (stock 2)', bac.offlineQueue.filter(i => i.data.id === 'p1').length === 1 && bac.offlineQueue.find(i => i.data.id === 'p1').data.stock === 2);
    test('les nouveaux éléments portent le rôle qui les a mis en file', bac.offlineQueue.every(i => i.role === 'admin' && i.oqv === 2), bac.offlineQueue.map(i => i.role));
  }
  {
    const bac = nouveauBac({ role: 'admin', reponse: () => ({ status: 403 }) });
    bac.offlineQueue.push({ type: 'produit', data: PROD('p3', 1), ts: 1, oqv: 2 });
    await bac.offlineQueueFlush();
    test('rejeu d\'un produit refusé (403) : retiré de la file, pas remis', bac.offlineQueue.length === 0 && bac._envois.length === 1, [bac.offlineQueue.length, bac._envois.length]);
  }

  console.log('\n3 bis. (A) ERREURS TEMPORAIRES : GARDÉES EN FILE ET REJOUÉES');
  for (const r of ['admin', 'collab']) {
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
    const bac = nouveauBac({ role: 'admin', reponse: () => (++n === 1 ? { status: 503 } : { status: 201 }) });
    await bac.sbSaveProduit(Object.assign(PROD('p1', 6), { _nouveau: true }));
    test('503 : en file', bac.offlineQueue.length === 1);
    await bac.offlineQueueFlush();
    test('rejeu après la panne : fiche créée avec son stock initial 6, file vide', bac.offlineQueue.length === 0 && bac._envois.length === 2 && bac._envois[1].method === 'POST' && bac._envois[1].body.stock === 6, [bac.offlineQueue.length, bac._envois.map(e => e.method)]);
  }
  {
    // panne qui dure : à chaque rejeu un seul envoi, la file reste à un élément (rejeu borné, pas de boucle)
    const bac = nouveauBac({ role: 'admin', reponse: () => ({ status: 502 }) });
    await bac.sbSaveProduit(PROD('p1', 6));
    await bac.offlineQueueFlush(); await bac.offlineQueueFlush(); await bac.offlineQueueFlush();
    test('panne durable : 1 élément en file, 4 envois au total (1 + 3 rejeux)', bac.offlineQueue.length === 1 && bac._envois.length === 4, [bac.offlineQueue.length, bac._envois.length]);
  }
  {
    // v7.5.197 : déduction de stock d'une livraison : 504 → la DEMANDE (sans quantité) reste en file pour le rejeu
    const bac = nouveauBac({ role: 'livreur', reponse: () => ({ status: 504 }) });
    Object.assign(bac, { produits: [PROD('p1', 5, 'Matelas D')], stkMouvements: [] });
    bac.commandes = [{ id: '#D1', produit: 'Matelas D', qte: 2, client: 'Client Test', statut: 'livré' }];
    const r = await bac.stkDemanderDeduction(bac.commandes[0]);
    const it = bac.offlineQueue.find(i => i.type === 'deduction');
    test('déduction + 504 : demande « deduction|#D1 » gardée en file, aucun stock calculé ni envoyé', r === 'reessayer' && it && it.data.id === '#D1' && !('stock' in it.data) && bac.produits[0].stock === 5 && !bac._envois.some(e => /produits/.test(e.url)), [r, bac.offlineQueue]);
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
    test('livreur : relance impossible (et rien envoyé, v7.5.198)', (await bac.produitsRefusesRelancer()) === 0 && bac._envois.length === 0);
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
      // v7.5.197 : faux stkDemanderDeduction (la vraie fonction est testée plus bas et en sections 8, 16, 23, 28)
      stkDemanderDeduction(c) { ordre.push('stock'); if (deduction === 'leve') throw new Error('produit introuvable'); if (deduction === 'rejette') return Promise.reject(new Error('déduction rejetée')); },
    });
    vm.runInContext('var sigStopId=null, sigPaieEncaisse=false, sigPaieMode="Espèces", sigPrepaidMode=null, sigCmdMarketplace=null, sigCodActif=false, sigCodChoix=null, sigCodMontant=0;', bac);
    vm.runInContext(CODE_PAI_RT, bac); // v7.5.198
    vm.runInContext(CODE_SIG, bac);
    bac.commandes = [{ id: '#T10', client: 'Client Test', prix: 100, statut: 'en-route', paie: 'Espèces', stpaie: 'Payé', montantEnc: 100 }]; // v7.5.198 : « Déjà payé » réservé aux commandes soldées (PR 24, v7.5.171)
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
    // VRAIE demande de déduction (v7.5.197), base injoignable, et une sauvegarde de commande qui rejette
    const { bac, ordre } = bacSignature('normal');
    let nCmd = 0;
    Object.assign(bac, { produits: [PROD('p1', 5, 'Matelas S')], stkMouvements: [] });
    vm.runInContext(CODE_FILE.slice(CODE_FILE.indexOf('// v7.5.197 (décision de Borhen')), bac); // remplace le faux par la vraie fonction
    bac.fetch = async () => { ordre.push('rpc:coupure'); throw new Error('Failed to fetch'); };
    bac.sbSaveCommande = async (c) => { nCmd++; ordre.push('commande:' + c.statut); if (nCmd > 1) throw new Error('panne commande'); };
    bac.commandes[0].produit = 'Matelas S';
    let erreur = null;
    try { bac.validerSig(); } catch (e) { erreur = e; }
    for (let k = 0; k < 10; k++) await new Promise(r => setImmediate(r));
    test('vraie demande, base injoignable : validerSig ne lève pas', erreur === null, erreur && erreur.message);
    test('vraie demande : commande enregistrée « livré » d\'abord, puis UNE demande à la base, aucune 2e sauvegarde de commande', ordre.indexOf('commande:livré') > -1 && ordre.indexOf('commande:livré') < ordre.indexOf('rpc:coupure') && ordre.filter(x => x === 'rpc:coupure').length === 1 && nCmd === 1, ordre); // v7.5.202 : « livré » après la confirmation des pièces (rien à confirmer ici), toujours avant la déduction
    test('vraie demande en échec : gardée en file (deduction|#T10), stock_deduit faux, stock local NON touché (5)', bac.offlineQueue.some(i => i.type === 'deduction' && i.data.id === '#T10') && !bac.commandes[0].stockDeduit && bac.produits[0].stock === 5 && bac.commandes[0].statut === 'livré', bac.offlineQueue.map(i => i.type));
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
  // v7.5.197 : vraie demande de déduction à la base simulée (baseRpc) ; la sauvegarde du « livré » met la commande
  // « livré » dans la base simulée
  function bacLivraison() {
    const { bac } = bacSignature('normal');
    Object.assign(bac, { produits: [PROD('p1', 5, 'Matelas P')], stkMouvements: [] });
    vm.runInContext(CODE_FILE.slice(CODE_FILE.indexOf('// v7.5.197 (décision de Borhen')), bac); // vraie fonction
    const b = baseRpc({ '#T10': { statut: 'en-route', stock_deduit: false, lignes: [{ p: 'p1', q: 1 }] } }, { p1: 5 });
    let retenir = null;
    bac.fetch = async (url, opt = {}) => {
      bac._envois.push({ url, method: opt.method || 'GET', body: opt.body ? JSON.parse(opt.body) : null });
      if (bac.retenirRpc) await new Promise(r => { retenir = r; });
      const r = b.reponse(url, opt) || { status: 200 };
      if (r === 'reseau') throw new Error('Failed to fetch');
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.texte || '', json: async () => [] };
    };
    bac.commandes[0].produit = 'Matelas P'; bac.commandes[0].stockDeduit = false;
    const saves = []; let finir = null;
    bac.sbSaveCommande = (c) => { saves.push({ statut: c.statut, stockDeduit: !!c.stockDeduit, stpaie: c.stpaie, montantEnc: c.montantEnc });
      const enBase = () => { b.cmds[c.id].statut = c.statut; if (c.stockDeduit) b.cmds[c.id].stock_deduit = true; };
      if (saves.length === 1) return new Promise(r => { finir = () => { enBase(); r(); }; }); enBase(); return Promise.resolve(); };
    return { bac, saves, b, finirPremier: () => finir && finir(), libererRpc: () => retenir && retenir() };
  }
  const ANCIEN = (min) => new Date(Date.now() - (min || 1) * 60000).toISOString();
  const perimee = (extra) => Object.assign({ id: '#T10', client: 'Client Test', prix: 100, statut: 'en-route', paie: 'Espèces', stpaie: 'Non payé', montantEnc: 0, stockDeduit: true, updatedAt: ANCIEN(1) }, extra || {});
  {
    // scénario exact de la revue : une relève lit l'ancien statut pendant le premier enregistrement
    const { bac, saves, b, finirPremier } = bacLivraison();
    bac.validerSig();
    await new Promise(r => setImmediate(r));
    const valide = bac.commandes[0];
    test('pendant le 1er enregistrement : 1 seule sauvegarde {livré, stockDeduit:false}', saves.length === 1 && saves[0].statut === 'livré' && saves[0].stockDeduit === false, saves);
    const changé = bac.cmdPollingAppliquer(perimee());
    test('relève périmée (en-route) pendant l\'enregistrement : refusée, la liste garde l\'objet validé', changé === false && bac.commandes[0] === valide && bac.commandes[0].statut === 'livré', [changé, bac.commandes[0].statut]);
    test('Realtime pendant l\'enregistrement : même une version « plus récente » est refusée (verrou)', bac.cmdDistanteAcceptable(valide, perimee({ updatedAt: new Date(Date.now() + 60000).toISOString() })) === false);
    test('pendant le 1er enregistrement : aucune demande de déduction envoyée', rpcs(bac).length === 0);
    finirPremier();
    for (let k = 0; k < 10; k++) await new Promise(r => setImmediate(r));
    // v7.5.197 : plus de 2e sauvegarde de la commande : la base pose elle-même stock_deduit
    test('après le « livré » : UNE demande rpc/deduire_stock_livraison { p_cmd_id: #T10 }, aucune 2e sauvegarde', rpcs(bac).length === 1 && rpcs(bac)[0].body.p_cmd_id === '#T10' && Object.keys(rpcs(bac)[0].body).join() === 'p_cmd_id' && saves.length === 1, [rpcs(bac).map(e => e.body), saves]);
    test('l\'encaissement est dans la sauvegarde du « livré » (Payé, 100)', saves[0].stpaie === 'Payé' && saves[0].montantEnc === 100, saves[0]);
    test('stock déduit une fois PAR LA BASE (5 → 4) ; stock affiché mis à jour depuis la réponse (4)', b.deductions === 1 && b.stock.p1 === 4 && bac.produits[0].stock === 4, [b.deductions, b.stock, bac.produits[0].stock]);
    test('stock_deduit vrai sur l\'objet validé, demande retirée de la file', bac.commandes[0].stockDeduit === true && !bac.offlineQueue.some(i => i.type === 'deduction'));
    test('verrou relâché à la fin', !bac._livEnCours['#T10']);
    test('après la fin : relève périmée (updated_at antérieur au « livré ») toujours refusée', bac.cmdPollingAppliquer(perimee()) === false && bac.commandes[0].statut === 'livré');
    test('après la fin : version sans updated_at et non livrée refusée', bac.cmdPollingAppliquer(perimee({ updatedAt: '' })) === false && bac.commandes[0].statut === 'livré');
    const plusRecente = perimee({ statut: 'reporté', updatedAt: new Date(Date.now() + 60000).toISOString() });
    test('après la fin : version PLUS RÉCENTE (correction admin) acceptée', bac.cmdPollingAppliquer(plusRecente) === true && bac.commandes[0].statut === 'reporté');
  }
  {
    // ceinture et bretelles : même si la liste a été remplacée pendant l'enregistrement, la déduction
    // travaille sur l'objet validé, et la liste le récupère à la fin
    const { bac, saves, b, finirPremier } = bacLivraison();
    bac.validerSig();
    await new Promise(r => setImmediate(r));
    const valide = bac.commandes[0];
    bac.commandes[0] = perimee(); bac.commandes[0].stockDeduit = false; // remplacement forcé (ancien comportement)
    finirPremier();
    for (let k = 0; k < 10; k++) await new Promise(r => setImmediate(r));
    test('liste remplacée de force : une seule sauvegarde {livré}, une seule déduction par la base', saves.length === 1 && saves[0].statut === 'livré' && b.deductions === 1, [saves, b.deductions]);
    test('liste remplacée de force : l\'objet validé y est remis à la fin (stock_deduit vrai)', bac.commandes[0] === valide && bac.commandes[0].statut === 'livré' && valide.stockDeduit === true);
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
    const bac = nouveauBac({ role: 'admin', fileStockee: [{ type: 'produit', data: PROD('p1', 5, 'Ancienne'), ts: 1, oqv: 2, role: 'admin' }],
      reponse: () => { if (++n === 1) bac.offlineQueueAdd('produit', PROD('p1', 3, 'Nouvelle')); return 'reseau'; } });
    await bac.offlineQueueFlush();
    const ps = bac.offlineQueue.filter(i => i.type === 'produit');
    test('fiche : coupure pendant le rejeu de l\'ancienne fiche + nouvelle fiche → seule la nouvelle reste', ps.length === 1 && ps[0].data.nom === 'Nouvelle', ps.map(i => [i.data.nom, i.ts]));
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
    test('ancien élément de stock du livreur rejoué en session ' + rSess + ' : jamais envoyé (v7.5.198), retiré, signalé au récapitulatif', bac._envois.length === 0 && bac.offlineQueue.length === 0 && bac._notifs.length === 1 && /Sommier L/.test(bac._notifs[0][3]), [e.method, bac._notifs.map(n => n[3])]);
  }
  {
    const bac = nouveauBac({ role: 'admin', fileStockee: [{ type: 'produit', data: PROD('p3', 2), ts: 7, oqv: 2, role: 'livreur' }, { type: 'produit', data: PROD('p5', 1), ts: 8, oqv: 2, role: 'livreur' }], reponse: () => 'reseau' });
    await bac.offlineQueueFlush();
    test('deux anciens éléments du livreur : aucun envoi, retirés, UNE seule notification récapitulative (2)', bac._envois.length === 0 && bac.offlineQueue.length === 0 && bac._notifs.length === 1 && /^2 mises à jour/.test(bac._notifs[0][3]), bac._notifs.map(n => n[3]));
  }
  {
    const bac = nouveauBac({ role: 'admin', fileStockee: [{ type: 'produit', data: PROD('p4', 2, 'Matelas Z'), ts: 1, oqv: 2, role: 'livreur' }], reponse: () => ({ status: 403 }) });
    await bac.offlineQueueFlush();
    test('ancien élément du livreur en session admin : pas de fiche gardée, récapitulatif (Matelas Z)', !('mx_produits_refuses' in bac._stockage) && bac._notifs.length === 1 && /Matelas Z/.test(bac._notifs[0][3]), bac._notifs.map(n => n[3]));
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
    test('stockage revenu : 3 anciens éléments purgés et notifiés ; la nouvelle valeur du livreur (valeur absolue) n\'est plus envoyée non plus (v7.5.198, récapitulatif 1), file vide', bac._notifs.length === 2 && /^3 mises à jour de stock anciennes/.test(bac._notifs[0][3]) && /^1 mises à jour de stock anciennes/.test(bac._notifs[1][3]) && envoisP.length === 0 && bac.offlineQueue.length === 0, [bac._notifs.map(n => n[3]), envoisP.map(e => e.body)]);
  }
  {
    // appareil admin : une nouvelle fiche mise en file AVANT la connexion ne retire pas les anciennes fiches
    const bac = nouveauBac({ role: null, fileStockee: ANCIENNE() });
    bac.offlineQueueAdd('produit', PROD('p2', 9, 'Sommier B'));
    test('rôle inconnu : nouvelle fiche p2 ajoutée, ancienne fiche p2 conservée', bac.offlineQueue.filter(i => i.type === 'produit' && i.data.id === 'p2').length === 2 && bac.offlineQueue.length === 6);
    bac.role = 'admin';
    await bac.offlineQueueFlush();
    const p2 = bac._envois.filter(e => /produits/.test(e.url) && e.body.id === 'p2');
    test('session admin : une seule fiche envoyée pour p2, la plus récente (produit absent de la base : stock initial 9), file vide', p2.length === 1 && p2[0].body.stock === 9 && bac.offlineQueue.length === 0, [p2.map(e => e.body.stock), bac.offlineQueue.length]);
  }

  console.log('\n14. (réserve 2, v7.5.194 ; v7.5.198) FICHE ADMIN EN FILE ET SESSION LIVREUR SUR LE MÊME APPAREIL');
  {
    let reseau = false;
    const bac = nouveauBac({ role: 'admin', reponse: () => (reseau ? { status: 201 } : 'reseau') });
    await bac.sbSaveProduit(Object.assign(PROD('p1', 5, 'Matelas K'), { prix: 150 })); // fiche admin, coupure
    bac.role = 'livreur'; // changement de session sur le même appareil
    const r = await bac.sbSaveProduit(PROD('p1', 4, 'Matelas K')); // ancienne façon : stock du livreur
    test('session livreur : aucune mise à jour de stock du livreur n\'entre en file (v7.5.198), la fiche admin reste', r === 'refus' && bac.offlineQueue.length === 1 && bac.offlineQueue[0].role === 'admin' && bac.oqCle(bac.offlineQueue[0]) === 'produit|fiche|p1', bac.offlineQueue.map(i => [i.role, i.data.stock]));
    reseau = true; const n0 = bac._envois.length;
    await bac.offlineQueueFlush();
    test('rejeu en session livreur : la fiche admin attend (rien envoyé)', bac._envois.length === n0 && bac.offlineQueue.length === 1);
    bac.role = 'admin';
    await bac.offlineQueueFlush();
    const post = bac._envois.slice(n0).filter(e => e.method === 'POST');
    test('session admin ensuite : la fiche part (POST, prix 150), file vide', post.length === 1 && post[0].body.prix === 150 && bac.offlineQueue.length === 0, post.map(e => e.body));
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

  console.log('\n16. (réserve 4, v7.5.194 ; v7.5.197) LE VERROU DU « LIVRÉ » ATTEND AUSSI LA RÉPONSE DE LA BASE À LA DÉDUCTION');
  {
    const { bac, saves, b, finirPremier, libererRpc } = bacLivraison();
    bac.retenirRpc = true;
    bac.validerSig();
    await new Promise(r => setImmediate(r));
    finirPremier();
    for (let k = 0; k < 10; k++) await new Promise(r => setImmediate(r));
    test('réponse de la base retardée : seul le « livré » est enregistré, demande envoyée', saves.length === 1 && saves[0].statut === 'livré' && rpcs(bac).length === 1, [saves, rpcs(bac).length]);
    test('réponse de la base retardée : le verrou du « livré » est TOUJOURS posé', !!bac._livEnCours['#T10'] && !bac.commandes[0].stockDeduit);
    test('pendant ce temps, une relève périmée reste refusée', bac.cmdPollingAppliquer(perimee({ updatedAt: new Date(Date.now() + 60000).toISOString() })) === false && bac.commandes[0].statut === 'livré');
    libererRpc();
    for (let k = 0; k < 10; k++) await new Promise(r => setImmediate(r));
    test('réponse arrivée : stock_deduit vrai (posé par la base), stock affiché 4, verrou relâché', bac.commandes[0].stockDeduit === true && bac.produits[0].stock === 4 && b.deductions === 1 && !bac._livEnCours['#T10']);
  }
  {
    const { bac } = bacLivraison();
    bac.fetch = async () => { throw new Error('Failed to fetch'); };
    let resolu = null, rejete = false;
    bac.commandes[0].statut = 'livré';
    bac.stkDemanderDeduction(bac.commandes[0], Promise.reject(new Error('panne commande'))).then(r => { resolu = r; }, () => { rejete = true; });
    for (let k = 0; k < 5; k++) await new Promise(r => setImmediate(r));
    test('stkDemanderDeduction : « livré » en échec puis base injoignable → promesse tenue (« reessayer »), jamais rejetée', resolu === 'reessayer' && !rejete, [resolu, rejete]);
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
    test('base plus ancienne que la fiche : la fiche (produit existant) n\'écrit JAMAIS le stock (v7.5.198) — état final stock 7, nom de la fiche', base.p1.stock === 7 && base.p1.nom === 'Matelas Neuf', base.p1);
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
    test(ordre + ' : ni la fiche ni l\'ancienne valeur du livreur n\'écrivent le stock (base : 7), nom de la fiche, file vide', base.p1.stock === 7 && base.p1.nom === 'Matelas Neuf' && bac.offlineQueue.length === 0, [base.p1, bac.offlineQueue.length]);
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
    test('sauvegarde faite à l\'instant (pas un rejeu) : aucune lecture, stock NON envoyé (base : 3)', bac._lectures.length === 0 && base.p1.stock === 3, [bac._lectures.length, base.p1.stock]);
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
    // session admin : rejeu d'une fiche (ts 1000) ; pendant l'attente réseau, l'admin enregistre une version plus
    // récente du MÊME produit, qui échoue aussi : seule la plus récente reste (avec SA date)
    let n = 0, bac = null, indep = null;
    bac = nouveauBac({ role: 'admin', fileStockee: [{ type: 'produit', data: PROD('p1', 5, 'Matelas C'), ts: 1000, oqv: 2, role: 'admin' }],
      reponse: () => { if (++n === 1) indep = bac.sbSaveProduit(PROD('p1', 5, 'Matelas C2')); return 'reseau'; } });
    await bac.offlineQueueFlush(); await indep;
    const ps = bac.offlineQueue.filter(i => i.type === 'produit').map(i => [i.data.nom, i.ts > 1000 ? 'récent' : i.ts]);
    test('une seule entrée : la sauvegarde indépendante (date récente), pas l\'ancienne version (ts 1000)', ps.length === 1 && ps[0][0] === 'Matelas C2' && ps[0][1] === 'récent', ps);
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
  // v7.5.197 : base simulée (baseRpc) branchée sur un bac complet ; sbSaveCommande met la commande à jour dans la base
  function bacDeduction(cmdsBase, stockBase, opts) {
    const b = baseRpc(cmdsBase, stockBase);
    const bac = nouveauBac(Object.assign({ role: 'livreur' }, opts || {}, { reponse: (url, opt) => b.reponse(url, opt) || { status: 200 } }));
    Object.assign(bac, { produits: Object.keys(stockBase).map(k => PROD(k, stockBase[k], 'Produit ' + k)), stkMouvements: [] });
    bac.sbSaveCommande = async (c, ctx) => { if (b.cmds[c.id]) { b.cmds[c.id].statut = c.statut; if (c.stockDeduit) b.cmds[c.id].stock_deduit = true; } bac.oqSucces('commande', c, ctx && ctx.ts, null); };
    return { bac, b };
  }
  const fileDe = (st) => { try { return JSON.parse(st.mx_offline_queue || '[]'); } catch (e) { return []; } };

  console.log('\n23. (v7.5.197) FERMETURE PENDANT LA SAUVEGARDE DU « LIVRÉ » OU PENDANT L\'ENVOI DE LA DEMANDE : REPRISE, UNE SEULE DÉDUCTION');
  let stockageFerme = null;
  {
    const { bac } = bacSignature('normal');
    vm.runInContext(CODE_FILE.slice(CODE_FILE.indexOf('// v7.5.197 (décision de Borhen')), bac);
    Object.assign(bac, { produits: [PROD('p1', 5, 'Matelas R')], stkMouvements: [] });
    bac.commandes[0].produit = 'Matelas R'; bac.commandes[0].stockDeduit = false;
    let nSave = 0; bac.sbSaveCommande = () => { nSave++; return new Promise(() => {}); }; // l'envoi n'aboutit jamais : application fermée
    bac.validerSig(); await attendre();
    const f = fileDe(bac._stockage);
    const wa = f.find(i => i.type === 'commande' && i.data.id === '#T10'), wd = f.find(i => i.type === 'deduction' && i.data.id === '#T10');
    test('avant l\'envoi du « livré » : demande « deduction|#T10 » gardée dans la file de l\'appareil', !!wd && bac.oqCle(wd) === 'deduction|#T10', f.map(i => i.type));
    test('avant l\'envoi : le « livré » et son encaissement sont gardés dans la file (Payé, 100)', wa && wa.data.statut === 'livré' && wa.data.stpaie === 'Payé' && wa.data.montantEnc === 100, wa);
    test('fermeture pendant l\'envoi du « livré » : aucune demande envoyée à la base', rpcs(bac).length === 0 && nSave === 1, [rpcs(bac).length, nSave]);
    stockageFerme = JSON.parse(JSON.stringify(bac._stockage));
  }
  {
    // rechargement : le « livré » n'était PAS arrivé en base ; rejeu de la file : livré d'abord, puis la demande
    const { bac, b } = bacDeduction({ '#T10': { statut: 'en-route', stock_deduit: false, lignes: [{ p: 'p1', q: 1 }] } }, { p1: 5 }, { stockage: JSON.parse(JSON.stringify(stockageFerme)) });
    bac.commandes = [{ id: '#T10', statut: 'en-route', stockDeduit: false }];
    test('rechargement : la demande et le « livré » sont relus depuis l\'appareil', bac.offlineQueue.some(i => i.type === 'deduction') && bac.offlineQueue.some(i => i.type === 'commande'));
    await bac.offlineQueueFlush(); await attendre();
    test('rejeu : « livré » enregistré puis UNE déduction par la base (5 → 4), file vide', b.cmds['#T10'].statut === 'livré' && b.deductions === 1 && b.stock.p1 === 4 && rpcs(bac).length === 1 && bac.offlineQueue.length === 0, [b.cmds['#T10'], b.deductions, rpcs(bac).length, bac.offlineQueue]);
    await bac.offlineQueueFlush(); await bac.stkReprendreDeductions(true); await attendre();
    test('ensuite : plus aucun envoi (une seule fois)', rpcs(bac).length === 1 && b.deductions === 1);
  }
  {
    // fermeture PENDANT l'envoi de la demande (la base a déduit, la réponse n'est jamais arrivée) puis rechargement
    const { bac, b } = bacDeduction({ '#T11': { statut: 'livré', stock_deduit: false, lignes: [{ p: 'p1', q: 2 }] } }, { p1: 5 });
    bac.commandes = [{ id: '#T11', statut: 'livré', stockDeduit: false }];
    bac.stkDeductionPoser(bac.commandes[0]);
    b.perdre = 1; await bac.stkDeductionEnvoyer('#T11', bac.commandes[0]);
    const st = JSON.parse(JSON.stringify(bac._stockage));
    test('réponse perdue : la base a déduit (5 → 3), la demande reste dans la file de l\'appareil', b.deductions === 1 && b.stock.p1 === 3 && fileDe(st).some(i => i.type === 'deduction' && i.data.id === '#T11'));
    const bac2 = nouveauBac({ role: 'livreur', stockage: st, reponse: (url, opt) => b.reponse(url, opt) || { status: 200 } }); // même base, appareil rechargé
    Object.assign(bac2, { produits: [PROD('p1', 3)], stkMouvements: [] });
    bac2.commandes = [{ id: '#T11', statut: 'livré', stockDeduit: false }];
    await bac2.stkReprendreDeductions(true); await attendre();
    test('rechargement : demande renvoyée, la base répond « deja » : stock toujours 3, demande retirée, stock_deduit vrai', b.deductions === 1 && b.stock.p1 === 3 && !bac2.offlineQueue.some(i => i.type === 'deduction') && bac2.commandes[0].stockDeduit === true, [b.deductions, b.stock, bac2.offlineQueue]);
  }
  {
    // commande annulée entre-temps : la base refuse (commande_non_livree) → demande abandonnée, rien de déduit
    const { bac, b } = bacDeduction({ '#T12': { statut: 'annulé', stock_deduit: false, lignes: [{ p: 'p1', q: 1 }] } }, { p1: 5 }, { fileStockee: [{ type: 'deduction', data: { id: '#T12' }, ts: 1, oqv: 2, role: 'livreur' }] });
    bac.commandes = [{ id: '#T12', statut: 'annulé', stockDeduit: false }];
    await bac.stkReprendreDeductions(true);
    test('commande annulée : demande retirée de la file, rien de déduit', !bac.offlineQueue.length && b.deductions === 0 && b.stock.p1 === 5, bac.offlineQueue);
  }

  console.log('\n24. (réserve 1 sur a84fa19, v7.5.196) UNE VERSION EN FILE N\'ÉCRASE JAMAIS UNE VERSION PLUS RÉCENTE ENREGISTRÉE');
  function bacCommandeReelle(opts) {
    const bac = nouveauBac(opts);
    Object.assign(bac, { paiVerrouBody() {}, showSync() {} });
    vm.runInContext(CODE_SYNC + '\n' + CODE_CMD, bac); // v7.5.198
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
    test('fiche plus récente enregistrée pendant le rejeu : l\'ancienne n\'est pas envoyée (état final « Fiche récente », stock de la base 2 gardé)', posts.length === 1 && base.p1.nom === 'Fiche récente' && base.p1.stock === 2 && bac.offlineQueue.length === 0, [posts.map(p => p.body.nom), base.p1]);
  }
  {
    const bac = nouveauBac({ role: 'admin', fileStockee: [{ type: 'produit', data: PROD('p1', 5, 'Fiche ancienne'), ts: 2, oqv: 2, role: 'admin' }] });
    await bac.sbSaveProduit(PROD('p1', 9, 'Fiche récente'));
    test('fiche : succès direct plus récent → l\'ancienne fiche en file est retirée', bac.offlineQueue.length === 0, bac.offlineQueue);
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

  console.log('\n28. (v7.5.197) DÉDUCTION PAR LA BASE : UN APPEL PAR LIVRÉ, REJEU SANS DOUBLE EFFET, FONCTION ABSENTE, STOCKAGE INDISPONIBLE');
  {
    // un seul appel par « livré », même si plusieurs chemins le demandent en même temps (validerSig + setLvSt + relève)
    const { bac, b } = bacDeduction({ '#U1': { statut: 'livré', stock_deduit: false, lignes: [{ p: 'p1', q: 1 }, { p: 'p2', q: 2 }] } }, { p1: 5, p2: 5 });
    const c = { id: '#U1', statut: 'livré', stockDeduit: false };
    bac.commandes = [c];
    const rs = await Promise.all([bac.stkDemanderDeduction(c), bac.stkDemanderDeduction(c), bac.stkReprendreDeductions(true)]);
    test('trois demandes simultanées : UN seul appel à la base, une seule déduction', rpcs(bac).length === 1 && b.deductions === 1 && rs[0] === 'ok' && rs[1] === 'ok', [rpcs(bac).length, rs]);
    test('stock affiché depuis la réponse (p1 4, p2 3), historique local « sortie-livraison »', bac.produits[0].stock === 4 && bac.produits[1].stock === 3 && bac.stkMouvements.length === 2 && bac.stkMouvements.every(m => m.type === 'sortie-livraison'), [bac.produits.map(p => p.stock), bac.stkMouvements]);
    test('aucun envoi de stock par le téléphone (ni PATCH ni POST produits)', !bac._envois.some(e => /\/rest\/v1\/produits/.test(e.url)));
    await bac.stkDemanderDeduction(c);
    test('commande déjà déduite : plus aucun appel', rpcs(bac).length === 1);
  }
  {
    // réponse perdue (coupure APRÈS l'effet en base) puis rejeu de la file : pas de double effet
    const { bac, b } = bacDeduction({ '#U2': { statut: 'livré', stock_deduit: false, lignes: [{ p: 'p1', q: 1 }] } }, { p1: 5 });
    const c = { id: '#U2', statut: 'livré', stockDeduit: false }; bac.commandes = [c];
    b.perdre = 2;
    const r1 = await bac.stkDemanderDeduction(c);
    test('réponse perdue : « reessayer », demande gardée en file, stock_deduit local encore faux', r1 === 'reessayer' && bac.offlineQueue.some(i => i.type === 'deduction') && !c.stockDeduit && b.deductions === 1);
    await bac.offlineQueueFlush();
    test('1er rejeu, réponse encore perdue : toujours en file, toujours UNE déduction', bac.offlineQueue.some(i => i.type === 'deduction') && b.deductions === 1 && b.stock.p1 === 4);
    await bac.offlineQueueFlush();
    test('2e rejeu : « deja » → demande retirée, stock_deduit vrai, stock 4 (aucune 2e déduction)', !bac.offlineQueue.length && c.stockDeduit === true && b.deductions === 1 && b.stock.p1 === 4 && rpcs(bac).length === 3, [bac.offlineQueue, b.deductions, rpcs(bac).length]);
  }
  {
    // fonction absente de la base (migration 040 pas encore appliquée) : rien n'est perdu
    const { bac, b } = bacDeduction({ '#U3': { statut: 'livré', stock_deduit: false, lignes: [{ p: 'p1', q: 1 }] }, '#U4': { statut: 'livré', stock_deduit: false, lignes: [{ p: 'p1', q: 1 }] } }, { p1: 5 });
    const c3 = { id: '#U3', statut: 'livré', stockDeduit: false }, c4 = { id: '#U4', statut: 'livré', stockDeduit: false }; bac.commandes = [c3, c4];
    b.absente = true;
    await bac.stkDemanderDeduction(c3); await bac.stkDemanderDeduction(c4); await bac.offlineQueueFlush();
    const msg = bac._toasts.filter(t => /mise à jour de la base en attente/.test(t[0]));
    test('404 PGRST202 : les deux demandes restent en file, rien de déduit', bac.offlineQueue.filter(i => i.type === 'deduction').length === 2 && b.deductions === 0, bac.offlineQueue);
    test('« mise à jour de la base en attente » affiché UNE fois, aucune notification d\'erreur', msg.length === 1 && bac._notifs.length === 0, [msg, bac._notifs.map(n => n[2])]);
    await bac.stkReprendreDeductions(false);
    test('relève : pas de nouvel essai avant le délai (5 min)', rpcs(bac).length === 4, rpcs(bac).length);
    b.absente = false; await bac.offlineQueueFlush();
    test('migration appliquée ensuite : les deux déductions sont faites, une fois chacune (5 → 3)', !bac.offlineQueue.length && b.deductions === 2 && b.stock.p1 === 3 && c3.stockDeduit && c4.stockDeduit, [bac.offlineQueue, b.deductions]);
  }
  {
    // stockage local indisponible : signalé clairement, demande gardée EN MÉMOIRE et envoyée au retour du réseau
    const { bac, b } = bacDeduction({ '#U5': { statut: 'livré', stock_deduit: false, lignes: [{ p: 'p1', q: 1 }] } }, { p1: 5 });
    const vraiSet = bac.localStorage.setItem;
    bac.localStorage.setItem = (k, v) => { if (k === 'mx_offline_queue') throw new Error('QuotaExceededError'); return vraiSet(k, v); };
    const c = { id: '#U5', statut: 'livré', stockDeduit: false }; bac.commandes = [c];
    b.panne = true;
    await bac.stkDemanderDeduction(c); await bac.offlineQueueFlush();
    const n = bac._notifs.filter(x => /Stockage de l'appareil indisponible/.test(x[2]));
    test('stockage refusé : UNE notification urgente « Stockage de l\'appareil indisponible — ne pas fermer l\'application »', n.length === 1 && n[0][0] === 'urgent' && /gardées en mémoire seulement/.test(n[0][3]), bac._notifs.map(x => x[2]));
    test('… et un message à l\'écran', bac._toasts.some(t => /Stockage de l'appareil plein ou bloqué/.test(t[0])));
    test('la demande est gardée en mémoire (file), rien dans le téléphone', bac.offlineQueue.some(i => i.type === 'deduction' && i.data.id === '#U5') && !('mx_offline_queue' in bac._stockage));
    bac.offlineQueue = bac.offlineQueue.filter(i => i.type !== 'deduction'); // demande sortie de la file (pire cas)
    b.panne = false; await bac.stkReprendreDeductions(true); await attendre();
    test('demande sortie de la file sans réponse : la relève la remet (commande livrée sur cet appareil) et la base déduit une fois', b.deductions === 1 && c.stockDeduit === true && !bac.offlineQueue.length, [b.deductions, bac.offlineQueue]);
    bac.localStorage.setItem = vraiSet; bac.offlineQueueAdd('tournee', { id: 'T-X' });
    test('stockage revenu : file réécrite dans le téléphone', fileDe(bac._stockage).length === 1);
  }
  {
    // refus définitif (commande d'un autre livreur ou livraison de plus de 2 jours) : retirée + signalée
    const { bac, b } = bacDeduction({}, { p1: 5 });
    const c = { id: '#U6', statut: 'livré', stockDeduit: false }; bac.commandes = [c];
    const r = await bac.stkDemanderDeduction(c);
    test('« commande_introuvable » : demande retirée, notification « Déduction de stock refusée : #U6 — à faire par le bureau »', r === 'refus' && !bac.offlineQueue.length && bac._notifs.some(n => n[2] === 'Déduction de stock refusée : #U6 — à faire par le bureau'), [r, bac._notifs.map(n => n[2])]);
    await bac.stkReprendreDeductions(true);
    test('… jamais renvoyée ensuite', rpcs(bac).length === 1 && b.deductions === 0);
  }
  {
    // session expirée (401) : gardée, signalée une fois, renvoyée après reconnexion
    const { bac, b } = bacDeduction({ '#U7': { statut: 'livré', stock_deduit: false, lignes: [{ p: 'p1', q: 1 }] } }, { p1: 5 });
    const c = { id: '#U7', statut: 'livré', stockDeduit: false }; bac.commandes = [c];
    b.http = 401; await bac.stkDemanderDeduction(c); await bac.offlineQueueFlush();
    test('HTTP 401 : gardée en file, UNE notification « Déduction de stock en attente : #U7 — réessai automatique »', bac.offlineQueue.length === 1 && bac._notifs.filter(n => n[2] === 'Déduction de stock en attente : #U7 — réessai automatique').length === 1, bac._notifs.map(n => n[2]));
    b.http = 0; await bac.offlineQueueFlush();
    test('après reconnexion : déduite une fois', b.deductions === 1 && !bac.offlineQueue.length);
  }
  {
    // le « livré » rejoué échoue encore : la demande attend (pas d'appel inutile refusé « commande_non_livree »)
    const { bac } = bacDeduction({ '#U8': { statut: 'en-route', stock_deduit: false, lignes: [{ p: 'p1', q: 1 }] } }, { p1: 5 }, { fileStockee: [
      { type: 'deduction', data: { id: '#U8' }, ts: 1, oqv: 2, role: 'livreur' },
      { type: 'commande', data: { id: '#U8', statut: 'livré' }, ts: 2, oqv: 2, role: 'livreur' }] });
    bac.sbSaveCommande = async (cm, ctx) => { bac.offlineQueueAdd('commande', cm, ctx); }; // échec : remise en file
    await bac.offlineQueueFlush();
    test('« livré » pas encore enregistré : demande gardée, AUCUN appel à la base', rpcs(bac).length === 0 && bac.offlineQueue.map(i => i.type).sort().join() === 'commande,deduction', bac.offlineQueue.map(i => i.type));
  }
  {
    // v7.5.198 : sbSaveCommande n'envoie plus stock_deduit ni d'en-tête de recrédit
    const bac = bacCommandeReelle({ role: 'admin', reponse: () => ({ status: 201 }) });
    await bac.sbSaveCommande({ id: '#V1', statut: 'annulé', stockDeduit: false, _recredit: true });
    const e = bac._envois.find(x => /\/rest\/v1\/commandes$/.test(x.url)) || {};
    test('sauvegarde de commande : ni stock_deduit dans le corps, ni en-tête x-stock-recredit', e.body && !('stock_deduit' in e.body) && !('x-stock-recredit' in e.entetes), [e.body && Object.keys(e.body).filter(k => /stock/.test(k)), e.entetes]);
  }

  console.log('\n29. (v7.5.198, réserve Codex n° 1) RÉPONSE PERDUE : LE REJEU RESTITUE LE RÉSULTAT COMPLET (MANQUES, INTROUVABLES)');
  {
    const { bac, b } = bacDeduction({ '#W1': { statut: 'livré', stock_deduit: false, lignes: [{ p: 'p1', q: 3 }, { p: 'p-absent', q: 1 }] } }, { p1: 1 });
    b.perdre = 1;
    const c = { id: '#W1', statut: 'livré', client: 'Client Test' }; bac.commandes = [c];
    const r1 = await bac.stkDemanderDeduction(c);
    test('1re réponse perdue (déduction faite en base) : « reessayer », aucune alerte encore', r1 === 'reessayer' && b.deductions === 1 && bac._notifs.length === 0, [r1, bac._notifs]);
    const r2 = await bac.stkDeductionEnvoyer('#W1', c);
    const n = bac._notifs.find(x => /Stock insuffisant à la livraison #W1/.test(x[2]));
    test('rejeu « deja » : l\'insuffisance (manque 2) ET le produit introuvable sont signalés', r2 === 'deja' && n && /p1 : manque 2/.test(n[3]) && /p-absent : introuvable/.test(n[3]), [r2, bac._notifs.map(x => x[2] + ' | ' + x[3])]);
    test('… stock affiché = stock COURANT de la base (0), historique local écrit une fois', bac.produits[0].stock === 0 && bac.stkMouvements.filter(m => m.type === 'sortie-livraison').length === 1 && b.deductions === 1, [bac.produits[0].stock, bac.stkMouvements]);
    const nNotifs = bac._notifs.length;
    b.cmds['#W1'].stock_deduit = true; c.stockDeduit = false; // copie locale en retard : nouvel envoi
    await bac.stkDeductionEnvoyer('#W1', c);
    test('nouveau rejeu de la MÊME opération : ni historique ni alerte en double (operation_id déjà appliqué)', bac._notifs.length === nNotifs && bac.stkMouvements.filter(m => m.type === 'sortie-livraison').length === 1);
    test('… opération retenue sur l\'appareil (mx_stock_ops_appliquees)', JSON.parse(bac._stockage.mx_stock_ops_appliquees || '[]').length === 1);
  }
  {
    // commande déduite par une ancienne version : « deja » sans résultat connu → rien d'appliqué, demande retirée
    const { bac, b } = bacDeduction({ '#W2': { statut: 'livré', stock_deduit: true, lignes: [{ p: 'p1', q: 1 }] } }, { p1: 4 });
    const c = { id: '#W2', statut: 'livré' }; bac.commandes = [c];
    const r = await bac.stkDemanderDeduction(c);
    test('déduite ailleurs (résultat inconnu) : « deja », stock_deduit vrai, aucun historique, file vide', r === 'deja' && c.stockDeduit === true && bac.stkMouvements.length === 0 && bac.offlineQueue.length === 0 && b.stock.p1 === 4, [r, bac.offlineQueue]);
  }

  console.log('\n30. (v7.5.198, réserve Codex n° 2) RECRÉDIT À L\'ANNULATION FAIT PAR LA BASE, UNE SEULE FOIS');
  const CODE_RECREDIT = extraireFonction('function stkReCrediterStock(cmdId, opts)');
  function bacRecredit(cmdsBase, stockBase, opts) {
    const r = bacDeduction(cmdsBase, stockBase, Object.assign({ role: 'admin' }, opts || {}));
    vm.runInContext(CODE_RECREDIT, r.bac);
    return r;
  }
  {
    const { bac, b } = bacRecredit({ '#X1': { statut: 'livré', stock_deduit: false, lignes: [{ p: 'p1', q: 3 }, { p: 'p2', q: 1 }] } }, { p1: 2, p2: 5 });
    const c = { id: '#X1', statut: 'livré', client: 'Client Test' }; bac.commandes = [c];
    await bac.stkDemanderDeduction(c);
    test('livraison : retrait PARTIEL en base (p1 2 sur 3 → 0), p2 5 → 4', b.stock.p1 === 0 && b.stock.p2 === 4);
    c.statut = 'annulé';
    const r = await bac.stkReCrediterStock('#X1');
    const rr = bac._envois.filter(e => /\/rpc\/recrediter_stock_livraison$/.test(e.url));
    test('annulation : statut enregistré, puis UN appel recrediter_stock_livraison { p_cmd_id } sans aucune quantité', r === 'ok' && rr.length === 1 && JSON.stringify(Object.keys(rr[0].body).sort()) === JSON.stringify(['p_cmd_id', 'p_suppression']) && rr[0].body.p_suppression === false, rr.map(e => e.body));
    test('… la base rend EXACTEMENT ce qui est sorti : p1 +2 (pas +3), p2 +1 ; stock affiché à jour ; stock_deduit faux', b.stock.p1 === 2 && b.stock.p2 === 5 && bac.produits.find(p => p.id === 'p1').stock === 2 && c.stockDeduit === false, [b.stock, bac.produits.map(p => p.stock)]);
    test('… historique local « retour-annulation » (2 lignes), demande retirée de la file', bac.stkMouvements.filter(m => m.type === 'retour-annulation').length === 2 && !bac.offlineQueue.some(i => i.type === 'recredit'), bac.offlineQueue);
    await bac.stkReCrediterStock('#X1');
    test('recrédit redemandé : la base répond « deja » — aucun 2e recrédit, aucun historique en double', b.recredits === 1 && b.stock.p1 === 2 && bac.stkMouvements.filter(m => m.type === 'retour-annulation').length === 2);
  }
  {
    // réponse perdue : la demande reste en file, le rejeu répond « deja » avec le même résultat (appliqué une fois)
    const { bac, b } = bacRecredit({ '#X2': { statut: 'livré', stock_deduit: false, lignes: [{ p: 'p1', q: 1 }] } }, { p1: 5 });
    const c = { id: '#X2', statut: 'livré' }; bac.commandes = [c];
    await bac.stkDemanderDeduction(c);
    c.statut = 'annulé'; b.perdre = 1;
    const r1 = await bac.stkReCrediterStock('#X2');
    test('réponse du recrédit perdue : « reessayer », demande « recredit|#X2 » gardée en file (et sur l\'appareil)', r1 === 'reessayer' && bac.offlineQueue.some(i => bac.oqCle(i) === 'recredit|#X2') && fileDe(bac._stockage).some(i => i.type === 'recredit'), bac.offlineQueue);
    await bac.offlineQueueFlush();
    test('rejeu : « deja » → recrédit appliqué une fois à l\'affichage (p1 5), file vide, 1 seul recrédit en base', b.recredits === 1 && b.stock.p1 === 5 && bac.produits[0].stock === 5 && !bac.offlineQueue.length && bac.stkMouvements.filter(m => m.type === 'retour-annulation').length === 1, [b.recredits, bac.offlineQueue]);
  }
  {
    // le nouveau statut n'est pas encore en base (coupure) : la base refuse « commande_encore_livree », la demande attend
    const { bac, b } = bacRecredit({ '#X3': { statut: 'livré', stock_deduit: false, lignes: [{ p: 'p1', q: 1 }] } }, { p1: 5 });
    const c = { id: '#X3', statut: 'livré' }; bac.commandes = [c];
    await bac.stkDemanderDeduction(c);
    c.statut = 'annulé';
    bac.sbSaveCommande = async (cc, ctx) => { bac.offlineQueueAdd('commande', cc, ctx); }; // coupure : statut gardé en file
    const r = await bac.stkReCrediterStock('#X3');
    test('statut pas encore enregistré : « reessayer », rien recrédité, demande gardée', r === 'reessayer' && b.recredits === 0 && bac.offlineQueue.some(i => i.type === 'recredit'), [r, bac.offlineQueue.map(i => i.type)]);
    bac.sbSaveCommande = async (cc, ctx) => { b.cmds[cc.id].statut = cc.statut; bac.oqSucces('commande', cc, ctx && ctx.ts, null); };
    await bac.offlineQueueFlush();
    test('rejeu : le statut part D\'ABORD, puis le recrédit (p1 4 → 5), file vide', b.recredits === 1 && b.stock.p1 === 5 && !bac.offlineQueue.length, [b.recredits, bac.offlineQueue]);
  }
  {
    // relivrée avant que le recrédit parte : rien à recréditer
    const { bac, b } = bacRecredit({ '#X4': { statut: 'livré', stock_deduit: false, lignes: [{ p: 'p1', q: 1 }] } }, { p1: 5 });
    const c = { id: '#X4', statut: 'livré' }; bac.commandes = [c];
    await bac.stkDemanderDeduction(c);
    bac.offlineQueueAdd('recredit', { id: '#X4', suppression: false });
    const r = await bac.stkRecreditEnvoyer('#X4');
    test('commande de nouveau « livré » ici et en base : « abandon », rien recrédité, demande retirée', r === 'abandon' && b.recredits === 0 && !bac.offlineQueue.length);
  }
  {
    const { bac, b } = bacRecredit({ '#X5': { statut: 'annulé', stock_deduit: true, lignes: [{ p: 'p1', q: 1 }] } }, { p1: 5 });
    bac.commandes = [{ id: '#X5', statut: 'annulé', stockDeduit: true }];
    const r = await bac.stkReCrediterStock('#X5');
    test('déduite par une ancienne version (« sans_journal ») : rien recrédité, retirée, notification « Recrédit de stock à faire à la main »', r === 'refus' && b.stock.p1 === 5 && !bac.offlineQueue.length && bac._notifs.some(n => /^Recrédit de stock à faire à la main : #X5/.test(n[2])), bac._notifs.map(n => n[2]));
  }
  {
    const { bac, b } = bacRecredit({ '#X6': { statut: 'livré', stock_deduit: false, lignes: [{ p: 'p1', q: 2 }] } }, { p1: 5 });
    const c = { id: '#X6', statut: 'livré' }; bac.commandes = [c];
    await bac.stkDemanderDeduction(c);
    let nSave = 0; bac.sbSaveCommande = async () => { nSave++; };
    const r = await bac.stkReCrediterStock('#X6', { suppression: true });
    test('suppression d\'une commande livrée : recrédit avec p_suppression = vrai, sans sauvegarde de la commande (p1 3 → 5)', r === 'ok' && nSave === 0 && b.stock.p1 === 5 && bac._envois.some(e => /recrediter/.test(e.url) && e.body.p_suppression === true));
  }
  {
    // v7.5.209 (avis chatgpt-review sur 3fefbc9) : SUPPRESSION d'une commande déduite par une ANCIENNE version (aucune
    // déduction journalisée) : la base supprime et répond « recredit_manuel_requis » ; l'appli prévient le bureau clairement
    const { bac, b } = bacRecredit({ '#X9': { statut: 'livré', stock_deduit: true, lignes: [{ p: 'p1', q: 2 }] } }, { p1: 5 });
    bac.commandes = [{ id: '#X9', statut: 'livré', stockDeduit: true }];
    const r = await bac.stkReCrediterStock('#X9', { suppression: true });
    const n = bac._notifs.find(x => /^Recrédit de stock à faire à la main : #X9 \(commande supprimée\)/.test(x[2]));
    test('suppression d\'une commande déduite par une ancienne version : « recredit_manuel_requis » → rien recrédité (p1 5), demande retirée, notification claire avec le produit (p1 ×2) et message à l\'écran',
      r === 'ok' && b.stock.p1 === 5 && !bac.offlineQueue.length && !!n && /RIEN n'a été recrédité/.test(n[3]) && /p1 ×2/.test(n[3])
      && bac._toasts.some(x => /stock à recréditer à la main/.test(x[0])), [r, bac._notifs.map(x => x.slice(2, 4)), bac._toasts]);
  }
  for (const rS of ['collab', 'livreur']) {
    const { bac, b } = bacRecredit({ '#X7': { statut: 'annulé', stock_deduit: true, lignes: [] } }, { p1: 5 }, { role: rS });
    bac.commandes = [{ id: '#X7', statut: 'annulé' }];
    const r = await bac.stkReCrediterStock('#X7');
    if (rS === 'collab') test('collaboratrice : le recrédit est demandé à la base (même règle que la base)', bac._envois.some(e => /recrediter/.test(e.url)), r);
    else test('livreur : aucun recrédit demandé', r === 'abandon' && !bac._envois.some(e => /recrediter/.test(e.url)) && !bac.offlineQueue.length);
  }
  {
    // session livreur sur l'appareil : un recrédit en file attend la prochaine session admin / collab
    const { bac } = bacRecredit({ '#X8': { statut: 'annulé', stock_deduit: false, lignes: [] } }, { p1: 5 }, { role: 'livreur', fileStockee: [{ type: 'recredit', data: { id: '#X8' }, ts: 1, oqv: 2, role: 'admin' }] });
    await bac.offlineQueueFlush();
    test('recrédit en file, session livreur : rien envoyé, gardé', !bac._envois.some(e => /rpc/.test(e.url)) && bac.offlineQueue.length === 1);
  }
  {
    const { bac, b } = bacRecredit({ '#X9': { statut: 'annulé', stock_deduit: true, lignes: [] } }, { p1: 5 });
    b.absente = true; bac.commandes = [{ id: '#X9', statut: 'annulé' }];
    const r = await bac.stkReCrediterStock('#X9');
    test('fonction absente (040 pas appliquée) : demande gardée, message « mise à jour de la base en attente »', r === 'reessayer' && bac.offlineQueue.some(i => i.type === 'recredit') && bac._toasts.some(t => /mise à jour de la base en attente/.test(t[0])));
  }

  console.log('\n31. (v7.5.198, réserve Codex n° 3) MOUVEMENTS MANUELS FAITS PAR LA BASE, IDEMPOTENTS');
  {
    const { bac, b } = bacRecredit({}, { p1: 10 });
    const p = bac.produits[0];
    const r = await bac.stkMouvementDemander(p, 'entree', 5, 'Arrivage fictif');
    const e = bac._envois.find(x => /\/rpc\/mouvement_stock_produit$/.test(x.url)) || {};
    test('entrée +5 : envoyée comme ÉCART (p_type entree, p_qte 5) avec une clé, jamais une valeur absolue calculée ici', r === 'ok' && e.body && e.body.p_type === 'entree' && e.body.p_qte === 5 && /^mv-/.test(e.body.p_cle) && !('stock' in e.body), e.body);
    test('… stock de la base (15) affiché, file vide', b.stock.p1 === 15 && p.stock === 15 && !bac.offlineQueue.length);
    b.stock.p1 = 12; // une livraison a retiré 3 entre-temps (autre appareil)
    b.perdre = 1;
    const r2 = await bac.stkMouvementDemander(p, 'sortie', 2, 'Casse');
    test('réponse perdue : mouvement gardé en file (clé conservée)', r2 === 'reessayer' && bac.offlineQueue.length === 1 && bac.offlineQueue[0].type === 'mouvement', bac.offlineQueue);
    await bac.offlineQueueFlush();
    test('rejeu : « deja » (même clé) → une seule sortie en base (12 → 10), affichage 10, file vide', b.mouvements === 2 && b.stock.p1 === 10 && p.stock === 10 && !bac.offlineQueue.length, [b.mouvements, b.stock.p1, p.stock]);
  }
  {
    const { bac, b } = bacRecredit({}, { p1: 10 });
    b.panne = true;
    await bac.stkMouvementDemander(bac.produits[0], 'correction', 7, 'Inventaire');
    test('coupure : correction gardée en file et sur l\'appareil', bac.offlineQueue.length === 1 && fileDe(bac._stockage).some(i => i.type === 'mouvement' && i.data.type === 'correction' && i.data.qte === 7));
    bac.role = 'livreur'; b.panne = false;
    await bac.offlineQueueFlush();
    test('session livreur : le mouvement attend (rien envoyé)', b.mouvements === 0 && bac.offlineQueue.length === 1);
    bac.role = 'admin';
    await bac.stkReprendreDeductions(true);
    test('reprise en session admin : correction faite par la base (7), file vide', b.stock.p1 === 7 && !bac.offlineQueue.length);
  }
  {
    const { bac, b } = bacRecredit({}, { p1: 10 });
    const r = await bac.stkMouvementDemander({ id: 'p-absent', nom: 'Produit Absent' }, 'entree', 1, '');
    test('produit absent en base : refus, retiré de la file, notification « Stock non mis à jour : Produit Absent — à vérifier »', r === 'refus' && !bac.offlineQueue.length && bac._notifs.some(n => n[2] === 'Stock non mis à jour : Produit Absent — à vérifier'), bac._notifs.map(n => n[2]));
  }

  console.log('\n32. (v7.5.199, dernière correction ciblée : 3 réserves natives de Codex sur 6de49a2)');
  // bac « bureau » avec une base de produits simulée : création (POST, stock envoyé seulement à la création), lecture
  // avant rejeu, fonctions de stock (baseRpc) ; etat.hors = vrai → toute requête lève (coupure réseau)
  function bacBureau(stockBase, opts) {
    const b = baseRpc({}, stockBase), etat = { hors: false, creations: [] };
    const bac = nouveauBac(Object.assign({ role: 'admin' }, opts || {}, { reponse: (url, opt) => {
      if (etat.hors) return 'reseau';
      const r = b.reponse(url, opt); if (r) return r;
      if (/\/rest\/v1\/produits$/.test(url) && opt.method === 'POST') {
        const corps = JSON.parse(opt.body);
        etat.creations.push(corps);
        if (!(corps.id in b.stock)) b.stock[corps.id] = ('stock' in corps) ? corps.stock : 0;
        else if ('stock' in corps) b.stock[corps.id] = corps.stock; // merge-duplicates
        return { status: 201 };
      }
      return { status: 200 };
    } }));
    bac.lecture = (url) => { if (etat.hors) return 'reseau'; const id = decodeURIComponent((url.match(/id=eq\.([^&]+)/) || [])[1] || ''); return { status: 200, json: (id in b.stock) ? [{ id }] : [] }; };
    Object.assign(bac, { produits: Object.keys(stockBase).map(k => PROD(k, stockBase[k], 'Produit ' + k)), stkMouvements: [], editProduitId: null, ajustProduitId: null,
      closeModal() {}, stkRender() {}, buildProduitOptions() {},
      VEN_LIBELLE: 'Prix à définir — non vendable', venDefinirPrix() {} }); // v7.5.201 (fusion pile 24-28 : arrivage 039)
    return { bac, b, etat };
  }
  {
    // 1. réponse perdue APRÈS la déduction, puis application rechargée : sbLoadAll lit stock_deduit = vrai
    const { bac, b } = bacDeduction({ '#R1': { statut: 'livré', stock_deduit: false, lignes: [{ p: 'p1', q: 3 }, { p: 'p-absent', q: 1 }] } }, { p1: 1 });
    b.perdre = 1;
    const c = { id: '#R1', statut: 'livré', client: 'Client Test' }; bac.commandes = [c];
    const r1 = await bac.stkDemanderDeduction(c);
    test('réserve 1 — réponse perdue : déduction faite en base, demande gardée sur l\'appareil', r1 === 'reessayer' && b.deductions === 1 && fileDe(bac._stockage).some(i => i.type === 'deduction'), [r1, fileDe(bac._stockage)]);
    const bac2 = nouveauBac({ role: 'livreur', stockage: Object.assign({}, bac._stockage), reponse: (url, opt) => b.reponse(url, opt) || { status: 200 } });
    Object.assign(bac2, { produits: [PROD('p1', 1, 'Produit p1')], stkMouvements: [] });
    bac2.commandes = [{ id: '#R1', statut: 'livré', client: 'Client Test', stockDeduit: true }]; // relu par sbLoadAll
    const appels = b.appels;
    await bac2.stkReprendreDeductions(true); await attendre();
    const n = bac2._notifs.find(x => /Stock insuffisant à la livraison #R1/.test(x[2]));
    test('… rechargement : la fonction est RAPPELÉE (résultat idempotent « deja ») avant de retirer la demande', b.appels === appels + 1 && b.deductions === 1, [b.appels - appels, b.deductions]);
    test('… les retraits journalisés passent par dedAppliquer (historique « sortie-livraison » écrit une fois)', bac2.stkMouvements.filter(m => m.type === 'sortie-livraison').length === 1, bac2.stkMouvements);
    test('… les manques sont signalés (p1 : manque 2, p-absent : introuvable)', !!n && /p1 : manque 2/.test(n[3]) && /p-absent : introuvable/.test(n[3]), bac2._notifs.map(x => x[2] + ' | ' + x[3]));
    test('… demande retirée de la file APRÈS la réponse, stock affiché = base (0)', !bac2.offlineQueue.some(i => i.type === 'deduction') && !fileDe(bac2._stockage).some(i => i.type === 'deduction') && bac2.produits[0].stock === 0, [bac2.offlineQueue, bac2.produits[0].stock]);
    await bac2.stkReprendreDeductions(true);
    test('… relance suivante : plus rien à envoyer, aucune alerte en double', b.appels === appels + 1 && bac2._notifs.filter(x => /Stock insuffisant à la livraison #R1/.test(x[2])).length === 1);
  }
  // v7.5.201 (fusion du dropshipping, pile 24-28) : sauvegarderProduit appelle venCreationEtat (arrivage, 039)
  const CODE_FICHE = extraireFonction('function venCreationEtat(estAdmin, prix)') + '\n' + extraireFonction('function sauvegarderProduit()') + '\n' + extraireFonction('function sauvegarderAjustement()');
  {
    // 2. produit créé hors ligne avec un stock de 5, puis entrée de 2 AVANT la synchronisation
    const { bac, b, etat } = bacBureau({});
    vm.runInContext(CODE_FICHE, bac);
    etat.hors = true;
    const el = (id, v) => { bac.document.getElementById(id).value = v; };
    el('p-nom', 'Matelas Neuf Test'); el('p-stock', '5'); el('p-seuil', '2');
    bac.sauvegarderProduit(); await attendre();
    const p = bac.produits[0];
    test('réserve 2 — création hors ligne : fiche gardée en file (stock 5)', !!p && bac.offlineQueue.some(i => i.type === 'produit') && p.stock === 5, [p, bac.offlineQueue]);
    bac.ajustProduitId = p.id; el('aj-qte', '2'); el('aj-type', 'entree'); el('aj-motif', 'Arrivage fictif');
    bac.sauvegarderAjustement(); await attendre();
    test('… entrée de 2 avant la synchronisation : affichage 7, mouvement +2 gardé en file', p.stock === 7 && bac.offlineQueue.some(i => i.type === 'mouvement' && i.data.qte === 2), bac.offlineQueue.map(i => i.type));
    etat.hors = false;
    await bac.offlineQueueFlush(); await attendre();
    const crea = etat.creations.find(x => x.id === p.id) || {};
    test('… synchronisation : la création envoie l\'INSTANTANÉ du stock initial (5), pas le stock courant de l\'objet (7)', crea.stock === 5, crea);
    test('… puis le mouvement +2 : stock en base 7 (et non 9), une seule fois', b.stock[p.id] === 7 && b.mouvements === 1, [b.stock[p.id], b.mouvements]);
    test('… file vide, marques de création retirées, affichage 7', !bac.offlineQueue.length && !('_nouveau' in p) && !('_stockInitial' in p) && p.stock === 7, [bac.offlineQueue, p]);
  }
  {
    // 3. création de produit et ajustement en file au REDÉMARRAGE (reprise lancée avant le rejeu de la fiche)
    const fiche = { id: 'pr-neuf9', nom: 'Produit Neuf 9', cat: 'matelas', dim: '', prix: 0, poids: 0, stock: 7, seuil: 2, _nouveau: true, _stockInitial: 5 };
    const mv = { id: 'mv-test-9', produit_id: 'pr-neuf9', nom: 'Produit Neuf 9', type: 'entree', qte: 2, motif: 'Arrivage fictif' };
    const file = [{ type: 'produit', data: fiche, ts: 1, oqv: 2, role: 'admin' }, { type: 'mouvement', data: mv, ts: 2, oqv: 2, role: 'admin' }];
    const { bac, b } = bacBureau({}, { fileStockee: file });
    bac.produits = [Object.assign({}, fiche)];
    await bac.stkReprendreDeductions(true); await attendre();
    test('réserve 3 — reprise au redémarrage : mouvement NON envoyé tant que la création attend (aucun « produit_introuvable », gardé)', b.appels === 0 && bac.offlineQueue.some(i => i.type === 'mouvement') && !bac._notifs.some(x => /Stock non mis à jour/.test(x[2])), [b.appels, bac.offlineQueue.map(i => i.type), bac._notifs.map(x => x[2])]);
    await bac.offlineQueueFlush(); await attendre();
    test('… rejeu : création (stock initial 5) PUIS mouvement +2 → 7 en base, file vide', b.stock['pr-neuf9'] === 7 && b.mouvements === 1 && !bac.offlineQueue.length, [b.stock, b.mouvements, bac.offlineQueue]);
  }
  {
    // 3 bis. reprise et rejeu lancés EN MÊME TEMPS au démarrage (chargement + retour réseau)
    const fiche = { id: 'pr-neuf10', nom: 'Produit Neuf 10', stock: 5, seuil: 2, _nouveau: true, _stockInitial: 5 };
    const file = [{ type: 'produit', data: fiche, ts: 1, oqv: 2, role: 'admin' }, { type: 'mouvement', data: { id: 'mv-test-10', produit_id: 'pr-neuf10', nom: 'Produit Neuf 10', type: 'entree', qte: 2, motif: '' }, ts: 2, oqv: 2, role: 'admin' }];
    const { bac, b } = bacBureau({}, { fileStockee: file });
    bac.produits = [Object.assign({}, fiche)];
    await Promise.all([bac.stkReprendreDeductions(true), bac.offlineQueueFlush()]); await attendre();
    await bac.stkReprendreDeductions(true); await attendre();
    test('… reprise et rejeu simultanés : 7 en base, mouvement appliqué une fois, file vide', b.stock['pr-neuf10'] === 7 && b.mouvements === 1 && !bac.offlineQueue.length && !bac._notifs.some(x => /Stock non mis à jour/.test(x[2])), [b.stock, b.mouvements, bac.offlineQueue.map(i => i.type), bac._notifs.map(x => x[2])]);
  }
  {
    // 3 ter. création en cours d'envoi (pas en file) et ajustement immédiat : différé, envoyé après l'enregistrement
    const { bac, b } = bacBureau({});
    const p = { id: 'pr-neuf11', nom: 'Produit Neuf 11', stock: 5, seuil: 2, _nouveau: true, _stockInitial: 5 };
    bac.produits = [p];
    const pCrea = bac.sbSaveProduit(p);
    const r = await bac.stkMouvementDemander(p, 'entree', 2, '');
    await pCrea; await attendre();
    test('… création en cours d\'envoi : mouvement différé (gardé), parti dès la création enregistrée → 7', r === 'reessayer' && b.stock['pr-neuf11'] === 7 && b.mouvements === 1 && !bac.offlineQueue.length, [r, b.stock, bac.offlineQueue]);
  }
  {
    // non-régression : produit déjà en base, aucune création en attente → mouvement envoyé tout de suite
    const { bac, b } = bacBureau({ p1: 10 });
    const r = await bac.stkMouvementDemander(bac.produits[0], 'entree', 3, '');
    test('non-régression : produit existant sans création en attente → mouvement immédiat (13)', r === 'ok' && b.stock.p1 === 13, [r, b.stock]);
  }

  console.log('\n7. TEXTE DU CODE');
  // v7.5.196 : chaque mise en file d'un produit est sur une ligne de coupure réseau (catch) ou d'erreur temporaire
  { const lignesE = CODE_PRODUIT.split('\n').filter(l => /sbSaveEchec\('produit'/.test(l));
    test('un refus définitif de produit ne passe pas par sbSaveEchec (seulement coupure ou erreur temporaire)', lignesE.length >= 4 && lignesE.every(l => /catch\(e\)|httpTemporaire\(|etat === 'reseau' \|\| (essai|lu)\.etat === 'temp'/.test(l)), lignesE); }
  test('le rejeu lit une copie (_aRejouer), pas la file qui grandit', /_aRejouer\.length/.test(CODE_REJEU) && !/i < offlineQueue\.length/.test(CODE_REJEU));
  test('loginOk trie les anciens éléments dès que le rôle est connu', /function loginOk\(r\) \{\s*role=r;\s*\/\/[^\n]*\n\s*try \{ oqAppliquerRole\(r\); \}/.test(html));
  test('le bouton « Relancer » existe sur la page Stock', /id="stk-refus-btn"[^>]*onclick="produitsRefusesRelancer\(\)"/.test(html));
  test('relève (polling) : passe par cmdPollingAppliquer et lit updated_at', /CMD_SELECT_COLS = '[^']*,updated_at'/.test(html) && /select=' \+ CMD_SELECT_COLS \+ '&order=updated_at\.desc/.test(html) && /if \(cmdPollingAppliquer\(mapped\)\) updated = true;/.test(html));
  test('Realtime : une version périmée ne remplace pas la commande (cmdDistanteAcceptable)', /if \(!cmdDistanteAcceptable\(commandes\[idx\], mapped\)\) return;/.test(html));
  test('rechargement complet : cmdFusionnerChargees + updated_at lu', /commandes = cmdFusionnerChargees\(commandes, _cmdsAvant\)/.test(html) && /CMD_SELECT_COLS = '[^']*,updated_at'/.test(html) && /select=' \+ CMD_SELECT_COLS \+ '&order=created_at\.desc'/.test(html)); // v7.5.198
  test('setLvSt : « livré » marqué, demande de déduction posée sur l\'objet validé', /livMarquer\(cLv\.id\);[^\n]*\n(\s*\/\/[^\n]*\n)*\s*try \{ stkDeductionPoser\(cLv\); \}/.test(html));
  test('setLvSt et chgStatut : déduction demandée APRÈS l\'enregistrement du « livré »', /var _pLv = sbSaveCommande\(cmd\);[^\n]*\n\s*if \(st === 'livré'\) stkDemanderDeduction\(cmd, _pLv\);/.test(html) && /var _pSc = Promise\.resolve\(sbSaveCommande\(c\)\)\.then\(function\(res\) \{[\s\S]{0,400}?\}\); \/\/ Sync Supabase\n\s*if \(st === 'livré'\) stkDemanderDeduction\(c, _pSc\);/.test(html)); // v7.5.211 : refus définitif → statut remis avant
  const sw = fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8');
  test('CACHE_VERSION augmenté (v7-5-197 ou plus)', /CACHE_VERSION = 'maxiconfort-v7-5-(19[7-9]|[2-9]\d\d)'/.test(sw));
  test('validerSig garde la demande de déduction et le « livré » AVANT l\'envoi (stkDeductionPoser, offlineQueueAdd, puis sbSaveCommande)', /stkDeductionPoser\(_cmdLivre\);[\s\S]{0,200}offlineQueueAdd\('commande', _cmdLivre\);[\s\S]{0,1400}_pLivre = sbSaveCommande\(_cmdLivre\)/.test(CODE_SIG)); // v7.5.202 : envoi après la confirmation des pièces
  test('reprise des demandes au chargement et à la relève (stkReprendreDeductions)', /stkReprendreDeductions\(true\)/.test(html) && /stkReprendreDeductions\(false\)/.test(html));
  // v7.5.197 : la mécanique supprimée n'existe plus dans l'application (déduction calculée sur le téléphone)
  const code = html.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  for (const [nom, re] of [['stkDeduireStock(', /stkDeduireStock\(/], ['mx_deductions_attente', /mx_deductions_attente/], ['PATCH conditionnel &stock=eq.', /&stock=eq\./],
    ['delta en file (oqCtx.delta / item.delta)', /\.delta\b/], ['uid / inclut des deltas', /oqUid\(|oqInclut\(|\.inclut\b/], ['sbPatchStockLivreur / sbLireStockProduit', /sbPatchStockLivreur|sbLireStockProduit/]])
    test('supprimé de l\'appli : ' + nom, !re.test(code), (code.match(re) || [])[0]);
  test('plus d\'en-tête x-stock-recredit ni de marque _recredit dans le code (v7.5.198 : recrédit par la base)', !/_entetes\['x-stock-recredit'\]|cmd\._recredit/.test(html));
  test('chgStatut : recrédit APRÈS l\'enregistrement du nouveau statut (admin et collab)', /var _recredit = \(role === 'admin' \|\| role === 'collab'\) && ancienStatut === 'livré'/.test(html) && /var _pSc = Promise\.resolve\(sbSaveCommande\(c\)\)[\s\S]{0,700}if \(_recredit\) stkReCrediterStock\(id, \{ avant: _pSc \}\);/.test(html)); // v7.5.211
  test('suppression d\'une commande livrée : recrédit par la base (p_suppression)', /if \(cmd\.statut === 'livré'\) stkReCrediterStock\(id, \{ suppression: true \}\);/.test(html));
  test('ajustement manuel du stock : par la base (stkMouvementDemander), plus de sbSaveProduit', /stkMouvementDemander\(p, type, qte, motif\);/.test(extraireFonction('function sauvegarderAjustement()')) && !/sbSaveProduit\(/.test(extraireFonction('function sauvegarderAjustement()')));
  test('fiche produit : stock modifié → correction par la base ; création marquée _nouveau', /stkMouvementDemander\(p, 'correction', data\.stock/.test(extraireFonction('function sauvegarderProduit()')) && /data\._nouveau = true;/.test(extraireFonction('function sauvegarderProduit()')));
  test('sbSaveCommande n\'envoie plus stock_deduit (tenu par la base)', !/stock_deduit:/.test(CODE_CMD));
  test('un seul point d\'appel à la base pour la déduction (rpc/deduire_stock_livraison)', (code.match(/rpc\/deduire_stock_livraison/g) || []).length === 1);

  console.log('\n' + ok + ' réussi(s), ' + ko + ' échec(s)');
  process.exit(ko ? 1 : 0);
})().catch(e => { console.error('ERREUR DU BANC :', e); process.exit(2); });
