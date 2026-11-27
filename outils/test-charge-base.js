// Banc de test de la GARDE DE CHARGE (v7.5.211, incident du 27/11/2026 : base saturée, 504/522, « statement timeout »).
// Usage : node outils/test-charge-base.js — exécute le vrai bloc CHARGE de maxiconfort-v7.html dans un bac à sable :
// aucune connexion, fausse base, faux minuteurs, horloge simulée, valeurs fictives seulement.
const fs = require('fs'), path = require('path'), vm = require('vm');
const racine = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(racine, 'maxiconfort-v7.html'), 'utf8').replace(/\r\n/g, '\n');
let ok = 0, ko = 0;
const test = (nom, cond, det) => { if (cond) { ok++; console.log('  OK    ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (det !== undefined ? ' — ' + JSON.stringify(det).slice(0, 300) : '')); } };
const tranche = (debut, fin) => { const i = html.indexOf(debut), j = html.indexOf(fin, i); if (i < 0 || j < 0) throw new Error('introuvable : ' + debut); return html.slice(i, j); };
const fonction = (entete) => { const i = html.indexOf(entete); if (i < 0) throw new Error('introuvable : ' + entete); return html.slice(i, html.indexOf('\n}\n', i) + 2); };
const attendre = async (n) => { for (let k = 0; k < (n || 6); k++) await new Promise((r) => setImmediate(r)); };

// bac à sable : horloge simulée (t), minuteurs relevés, fausse base (réponse programmable), onglet caché ou non
function nouveauBac(opts) {
  const o = opts || {};
  const etat = { t: 1e12, requetes: [], minuteurs: [], reponse: o.reponse || (() => ({ status: 200, json: [] })), cache: false };
  const DateSim = function (...a) { return a.length ? new Date(...a) : new Date(etat.t); };
  DateSim.now = () => etat.t; DateSim.parse = Date.parse; DateSim.UTC = Date.UTC;
  const bac = { console: { log() {}, warn() {} }, JSON, Math, Number, String, Object, Array, parseFloat, parseInt, isNaN, Promise, Error, AbortController,
    Date: DateSim,
    setTimeout: (f, ms) => { etat.minuteurs.push({ f, ms, actif: true }); return etat.minuteurs.length; },
    clearTimeout: (id) => { if (id && etat.minuteurs[id - 1]) etat.minuteurs[id - 1].actif = false; },
    document: { get hidden() { return etat.cache; }, getElementById: () => null },
    fetch: async (url) => {
      etat.requetes.push(url);
      const r = etat.reponse(url);
      if (r === 'reseau') throw new Error('Failed to fetch');
      return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, json: async () => r.json };
    } };
  vm.createContext(bac);
  vm.runInContext(tranche('// CHARGE-DEBUT', '// CHARGE-FIN'), bac);
  return { bac, etat };
}

(async () => {
  console.log('\n1. UNE SEULE LECTURE EN COURS PAR CLÉ, RÉPONSE GARDÉE AU MOINS 60 S');
  {
    const { bac, etat } = nouveauBac({ reponse: () => ({ status: 200, json: [{ id: '#1' }] }) });
    const lire = () => bac.chargeFetch('https://x.invalid/rest/v1/commandes?select=id,prix', {});
    const ps = []; for (let k = 0; k < 10; k++) ps.push(bac.chargeUnique('mois', 60000, lire));
    const res = await Promise.all(ps);
    test('10 appels simultanés → 1 seule requête', etat.requetes.length === 1, etat.requetes.length);
    test('les 10 appelants reçoivent la même réponse', res.every((r) => Array.isArray(r) && r[0].id === '#1'));
    etat.t += 59000; await bac.chargeUnique('mois', 60000, lire);
    test('59 s plus tard : réponse gardée, aucune requête', etat.requetes.length === 1, etat.requetes.length);
    etat.t += 2000; await bac.chargeUnique('mois', 60000, lire);
    test('61 s plus tard : 1 nouvelle requête', etat.requetes.length === 2, etat.requetes.length);
    await bac.chargeUnique('mois', 5000, lire); etat.t += 10000; await bac.chargeUnique('mois', 5000, lire);
    test('durée demandée plus courte (5 s) : toujours gardée 60 s au minimum', etat.requetes.length === 2, etat.requetes.length);
    await bac.chargeUnique('autre-cle', 60000, lire);
    test('autre clé : sa propre lecture', etat.requetes.length === 3);
  }

  console.log('\n2. ATTENTE CROISSANTE APRÈS UNE ERREUR 5xx OU UN DÉLAI DÉPASSÉ (10 s, 30 s, 60 s, puis 5 min au plus)');
  {
    let statut = 503;
    const { bac, etat } = nouveauBac({ reponse: () => (statut === 'reseau' ? 'reseau' : { status: statut, json: statut === 200 ? [{ id: '#2' }] : {} }) });
    const lire = () => bac.chargeFetch('https://x.invalid/rest/v1/commandes?select=id', {});
    const pauses = [];
    for (let k = 0; k < 5; k++) {
      const t0 = etat.t, n0 = etat.requetes.length;
      const r = await bac.chargeUnique('mois', 60000, lire);
      test('échec n° ' + (k + 1) + ' : une requête, aucune réponse inventée', etat.requetes.length === n0 + 1 && r === undefined, [etat.requetes.length - n0, r]);
      pauses.push(bac.CHARGE_ETAT.pauseJusqua - t0);
      // pendant la pause : aucun appel ne part, même répété
      for (let j = 0; j < 20; j++) await bac.chargeUnique('mois', 60000, lire);
      etat.t += pauses[k] - 1; await bac.chargeUnique('mois', 60000, lire);
      test('pendant l’attente (' + (pauses[k] / 1000) + ' s) : 0 requête malgré 21 appels', etat.requetes.length === n0 + 1, etat.requetes.length - n0);
      etat.t += 1;
    }
    test('attentes successives = 10 s, 30 s, 60 s, 5 min, 5 min (plafond)', JSON.stringify(pauses) === JSON.stringify([10000, 30000, 60000, 300000, 300000]), pauses);
    test('pause générale aussi : chargeEnPause vrai juste après un échec', (() => { bac.chargeEchec(); return bac.chargeEnPause(); })());
    etat.t += 300001; statut = 200;
    const ok2 = await bac.chargeUnique('mois', 60000, lire);
    test('succès après les échecs : réponse prise, compteur et pause remis à zéro', Array.isArray(ok2) && bac.CHARGE_ETAT.echecs === 0 && bac.CHARGE_ETAT.pauseJusqua === 0 && !bac.CHARGE_ETAT.echecsCle.mois);
    // délai dépassé / réseau : même traitement que 5xx
    statut = 'reseau'; etat.t += 61000;
    const avant = etat.requetes.length; const r3 = await bac.chargeUnique('mois', 60000, lire);
    test('réseau coupé ou délai dépassé : dernière réponse connue rendue, attente de 10 s posée', r3 === ok2 && bac.CHARGE_ETAT.pauseJusqua - etat.t === 10000 && etat.requetes.length === avant + 1);
    // un refus 401/403 n'est pas une surcharge : pas de pause générale (la clé attend quand même avant de réessayer)
    statut = 401; etat.t += 400000; bac.chargeSucces(); delete bac.CHARGE_ETAT.echecsCle.mois; bac.CHARGE_ETAT.cache = {};
    await bac.chargeUnique('mois', 60000, lire);
    test('refus 401 : pas de pause générale ; la clé attend 10 s avant de réessayer', bac.CHARGE_ETAT.pauseJusqua === 0 && bac.CHARGE_ETAT.echecsCle.mois.pasAvant - etat.t === 10000);
    test('chargeNoterReponse : 504 et 522 → pause ; 200 → levée', (() => { bac.chargeSucces(); bac.chargeNoterReponse(504); const a = bac.chargeEnPause(); bac.chargeNoterReponse(522); const d = bac.CHARGE_ETAT.pauseJusqua - etat.t; bac.chargeNoterReponse(200); return a && d === 30000 && !bac.chargeEnPause(); })());
    test('délai de lecture lourde : abandon programmé à 20 s', bac.CHARGE_DELAI_LECTURE === 20000 && etat.minuteurs.some((m) => m.ms === 20000));
  }

  console.log('\n3. ONGLET CACHÉ : AUCUNE LECTURE DE RAFRAÎCHISSEMENT');
  {
    const { bac, etat } = nouveauBac({ reponse: () => ({ status: 200, json: [{ id: '#3' }] }) });
    const lire = () => bac.chargeFetch('https://x.invalid/rest/v1/commandes?select=id', {});
    const r1 = await bac.chargeUnique('mois', 60000, lire);
    etat.cache = true; etat.t += 120000;
    const r2 = await bac.chargeUnique('mois', 60000, lire);
    test('onglet caché, réponse périmée : aucune requête, dernière réponse rendue', etat.requetes.length === 1 && r2 === r1);
    const r3 = await bac.chargeUnique('jamais-lue', 60000, lire);
    test('onglet caché, rien de connu : aucune requête, undefined', etat.requetes.length === 1 && r3 === undefined);
    etat.cache = false; await bac.chargeUnique('mois', 60000, lire);
    test('onglet de nouveau visible : lecture reprise', etat.requetes.length === 2);
  }

  console.log('\n4. ÉVÉNEMENTS TEMPS RÉEL REGROUPÉS (débounce d’au moins 5 s)');
  {
    const { bac, etat } = nouveauBac();
    let rendus = 0;
    for (let k = 0; k < 50; k++) bac.chargeRegrouper('rt-commandes', () => { rendus++; });
    const actifs = etat.minuteurs.filter((m) => m.actif);
    test('rafale de 50 événements → 1 seul affichage programmé', actifs.length === 1, actifs.length);
    test('programmé à 5 s ou plus', actifs[0].ms >= 5000, actifs[0].ms);
    actifs[0].f();
    test('à l’échéance : 1 seul affichage', rendus === 1, rendus);
    test('le temps réel « commandes » passe par le regroupement (plus de renderDash/renderCmds à chaque événement)',
      /table:'commandes'\}, function\(payload\) \{[\s\S]*?chargeRegrouper\('rt-commandes', function\(\) \{ renderDash\(\); renderCmds\(\); \}\);[\s\S]*?\.on\('postgres_changes', \{event:'\*', schema:'public', table:'tournees'\}/.test(html)
      && !/tdbSignaler\('commandes'\); \/\/ v7\.5\.138\n\s*renderDash\(\); renderCmds\(\); renderTournees\(\); renderLivreur\(\);/.test(html));
    test('signaux du tableau de bord regroupés à 5 s (avant 0,8 s)', /var TDB_RELECTURE_MIN = 60000, TDB_REGROUPEMENT = 5000;/.test(html) && /renderDash\(\); \}, TDB_REGROUPEMENT\);/.test(fonction('function tdbSignaler(quoi) {')));
  }

  console.log('\n5. CHARGEMENT COMPLET (sbLoadAll) : UNIQUE, AU PLUS UNE FOIS PAR MINUTE, JAMAIS CACHÉ NI EN PAUSE');
  {
    const { bac, etat } = nouveauBac();
    let appels = 0, finir = null;
    bac.sbLoadAll = () => { appels++; return new Promise((r) => { finir = r; }); };
    const p1 = bac.sbChargerTout({ premier: true }), p2 = bac.sbChargerTout(), p3 = bac.sbChargerTout({ sansEspacement: true });
    await attendre();
    test('3 demandes pendant un chargement → 1 seul chargement, même promesse', appels === 1 && p1 === p2 && p2 === p3);
    finir(); await attendre();
    test('chargement terminé : résultat « fait »', (await p1) === true);
    etat.t += 30000; const r4 = await bac.sbChargerTout();
    test('30 s après : refusé (au plus une fois par minute)', appels === 1 && r4 === false);
    etat.t += 31000; const p5 = bac.sbChargerTout(); await attendre(); finir(); await p5;
    test('61 s après : nouveau chargement', appels === 2);
    etat.t += 61000; etat.cache = true; await bac.sbChargerTout();
    test('onglet caché : aucun chargement', appels === 2);
    etat.cache = false; bac.chargeEchec(); await bac.sbChargerTout(); await bac.sbChargerTout({ sansEspacement: true });
    test('pendant l’attente après erreur : aucun chargement (même la reprise « liste vide »)', appels === 2);
    const p6 = bac.sbChargerTout({ premier: true }); await attendre(); finir(); await p6;
    test('premier chargement au démarrage : toujours lancé', appels === 3);
  }

  console.log('\n6. COMPTEURS DU MOIS (renderCmdStatsJour, appelé à CHAQUE renderCmds) : 1 lecture au lieu d’une par affichage');
  {
    const { bac, etat } = nouveauBac({ reponse: () => ({ status: 200, json: [{ id: '#4', prix: 100, date_commande: '2026-11-27', date_livraison: '2026-11-28', statut: 'en-attente', origine: 'LeBonCoin' }] }) });
    etat.t = new Date(2026, 10, 27, 18, 40).getTime();
    const box = { style: {}, innerHTML: '' };
    Object.assign(bac, { SUPABASE_URL: 'https://x.invalid', SUPABASE_KEY: 'k', role: 'admin', cmdStatsSel: { jour: '', sem: '', mois: '' }, cmdStatsCache: {} });
    bac.document.getElementById = (id) => (id === 'cmd-stats-jour' ? box : null);
    vm.runInContext(fonction('async function cmdFetchRange(dMin, dMaxExcl) {') + '\n' + fonction('async function renderCmdStatsJour() {'), bac);
    const ps = []; for (let k = 0; k < 20; k++) ps.push(bac.renderCmdStatsJour());
    await Promise.all(ps);
    test('20 affichages simultanés (rafale temps réel) → 1 seule requête du mois', etat.requetes.length === 1 && /date_commande=gte\.2026-11-01/.test(etat.requetes[0]), etat.requetes.length);
    test('compteurs affichés (1 commande)', /<strong>1<\/strong> cmd/.test(box.innerHTML));
    etat.t += 30000; for (let k = 0; k < 20; k++) await bac.renderCmdStatsJour();
    test('20 affichages de plus dans la minute → toujours 1 requête', etat.requetes.length === 1, etat.requetes.length);
    etat.t += 31000; await bac.renderCmdStatsJour();
    test('après 60 s : 1 nouvelle lecture', etat.requetes.length === 2, etat.requetes.length);
    // base saturée : 504 → attente, compteurs gardés (pas remplacés par 0)
    etat.reponse = () => ({ status: 504, json: {} }); etat.t += 61000;
    for (let k = 0; k < 20; k++) await bac.renderCmdStatsJour();
    test('base en 504 : 1 requête puis plus rien pendant l’attente (20 affichages)', etat.requetes.length === 3, etat.requetes.length);
    test('base en 504 : derniers compteurs connus gardés (pas « 0 cmd »)', /<strong>1<\/strong> cmd/.test(box.innerHTML));
    // période passée choisie (plage immuable) : un échec n'est pas gardé comme « 0 » définitif
    etat.t += 400000; bac.chargeSucces(); bac.CHARGE_ETAT.echecsCle = {};
    const r = await bac.cmdFetchRange('2026-10-01', '2026-11-01');
    test('plage passée en échec : pas gardée comme définitive (relue plus tard)', r.nb === 0 && !bac.cmdStatsCache['2026-10-01_2026-11-01']);
  }

  console.log('\n7. BRANCHEMENTS DANS L’APPLI (lecture du code)');
  {
    const sl = fonction('async function sbLoadAll() {');
    test('sbLoadAll : plus de 2e requête « select=id » de comptage (total de la même réponse)', !/commandes\?select=id'/.test(sl) && /if \(cmdsTotal != null\) cmdTotalCount = cmdsTotal;/.test(sl));
    test('sbLoadAll : 5xx noté, délai dépassé / réseau → pause', /chargeNoterReponse\(rCmds\.status\)/.test(sl) && /catch\(e\) \{\n\s*console\.warn\('sbLoadAll erreur:', e\.message\);\n\s*if \(typeof chargeEchec === 'function'\) chargeEchec\(\);/.test(sl));
    test('plus aucun appel direct de sbLoadAll() hors de la garde (démarrage, reprise, rafraîchissement 60 s)', (html.match(/sbLoadAll\(\)/g) || []).length === 2 && /async function sbLoadAll\(\) \{/.test(html) &&/return sbLoadAll\(\);/.test(html));
    test('rafraîchissement automatique 60 s : passe par sbChargerTout', /if \(typeof sbChargerTout === 'function'\) \{\n\s*sbChargerTout\(\)\.then\(function\(\)\{/.test(html));
    const sp = fonction('function startPolling() {');
    test('relève : jamais deux à la fois, jamais onglet caché, jamais pendant la pause', /if \(_pollingEnCours\) return;/.test(sp) && /chargeOngletCache\(\)\) return;/.test(sp) && /chargeEnPause\(\)\) \{ cmdSynchroPerdue\(/.test(sp) && /\} finally \{ _pollingEnCours = false; \}/.test(sp));
    test('relève : réponse notée (5xx → pause), abandon après 15 s', /chargeNoterReponse\(rC\.status\)/.test(sp) && /_ctlRel\.abort\(\); \} catch\(e\) \{\} \}, 15000\)/.test(sp));
    const tdb = tranche('// TDB-DEBUT', '// TDB-FIN');
    test('tableau : lecture seulement affiché, visible, hors pause et hors chargement complet', /function tdbLecturePermise\(\) \{\n\s*if \(!tdbVisible\(\)\) return false;\n\s*if \(typeof chargeOngletCache === 'function' && chargeOngletCache\(\)\) return false;\n\s*if \(typeof chargeEnPause === 'function' && chargeEnPause\(\)\) return false;\n\s*if \(typeof _chargeToutVol !== 'undefined' && _chargeToutVol\) return false;/.test(tdb)
      && /!tropTot && tdbLecturePermise\(\)\) tdbCharger\(P, cle\);/.test(tdb));
    test('tableau : 5xx et délai dépassé d’une page → pause', /chargeNoterReponse\(r\.status\); throw new Error\('HTTP ' \+ r\.status\);/.test(tdb) && /catch \(e\) \{ if \(typeof chargeEchec === 'function'\) chargeEchec\(\); throw e; \}/.test(tdb));
    test('vérification drop_version : pas de nouvelle avant 15 s après un échec', /if \(_dropVerifEchecA && Date\.now\(\) - _dropVerifEchecA < 15000\) return false;/.test(fonction('async function dropVerifier() {')));
    test('pièces d’une tournée : pas de nouvelle passe avant 15 s après un échec', /_dropTourneeEchecA\[t\.id\] && Date\.now\(\) - _dropTourneeEchecA\[t\.id\] < 15000\) return;/.test(fonction('async function dropChargerTournee(t, apres, force) {')));
    test('bloc CHARGE : aucune écriture (lectures seulement)', !/method:\s*'(POST|PATCH|DELETE)'|sbSave|localStorage\.setItem/.test(tranche('// CHARGE-DEBUT', '// CHARGE-FIN')));
    const sw = fs.readFileSync(path.join(racine, 'service-worker.js'), 'utf8');
    test('version : CACHE_VERSION maxiconfort-v7-5-211 et en-tête v7.5.211', /const CACHE_VERSION = 'maxiconfort-v7-5-211';/.test(sw) && /^\/\/ v7\.5\.211 - /m.test(sw));
  }

  console.log('\n' + ok + ' OK, ' + ko + ' échec(s)');
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERREUR DU BANC :', e); process.exit(1); });
