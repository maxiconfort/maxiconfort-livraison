// Banc de test du chargement du camion côté livreur (v7.5.119, 10/10/2026).
// Usage : node outils/test-chargement.js
// Il EXTRAIT le vrai code de maxiconfort-v7.html (bloc STO-DEBUT … STO-FIN, toggleChargement,
// calculerProgressionChargement, sasEstDeverrouille, sasMarquerDeverrouille, sasDoitAfficher,
// sasValiderEtDemarrer) et l'exécute dans un bac à sable : aucune connexion, aucune donnée réelle.
//
// Ce qui est vérifié en priorité (panne du 10/10 sur le téléphone du livreur) :
//   - téléphone qui n'enregistre RIEN (localStorage qui refuse) : le livreur coche tout,
//     valide, et l'écran « CHARGEMENT OBLIGATOIRE » ne doit PAS revenir ;
//   - réseau qui ne répond jamais : cocher une ligne doit quand même faire avancer le compteur.
const fs = require('fs'), path = require('path'), vm = require('vm');
// MX_HTML permet de rejouer le banc sur une ancienne version (contrôle : le test doit y échouer)
const html = fs.readFileSync(process.env.MX_HTML || path.join(__dirname, '..', 'maxiconfort-v7.html'), 'utf8');
function extraireBloc(debut, fin) { const i = html.indexOf(debut), j = html.indexOf(fin, i); if (i < 0 || j < 0) throw new Error('bloc introuvable : ' + debut); return html.slice(i, j + fin.length); }
function extraireFonction(signature) {
  const i = html.indexOf(signature); if (i < 0) throw new Error('fonction introuvable : ' + signature);
  let k = html.indexOf('{', i), n = 0, dansChaine = null, ech = false;
  for (let p = k; p < html.length; p++) { const ch = html[p];
    if (dansChaine) { if (ech) ech = false; else if (ch === '\\') ech = true; else if (ch === dansChaine) dansChaine = null; continue; }
    if (ch === '/' && html[p + 1] === '/') { p = html.indexOf('\n', p); continue; }
    if (ch === "'" || ch === '"' || ch === '`') { dansChaine = ch; continue; }
    if (ch === '{') n++; else if (ch === '}') { n--; if (n === 0) return html.slice(i, p + 1); } }
  throw new Error('accolade non refermée : ' + signature);
}

// bloc mémoire de l'appareil : on part du DÉBUT DE LA LIGNE qui porte le marqueur
// (le commentaire d'en-tête change selon les versions, le marqueur non)
function blocStockage() {
  const i = html.indexOf('STO-DEBUT'); if (i < 0) throw new Error('marqueur STO-DEBUT introuvable');
  const debut = html.lastIndexOf('\n', i) + 1;
  const fin = html.indexOf('// STO-FIN', i); if (fin < 0) throw new Error('marqueur STO-FIN introuvable');
  return html.slice(debut, fin + '// STO-FIN'.length);
}

// stockage simulé : 'ok' = normal, 'refus' = setItem lève (WebView Android), 'muet' = accepte mais perd tout
function fauxStockage(mode) {
  const d = {};
  return {
    setItem(k, v) { if (mode === 'refus') throw new Error('QuotaExceededError'); if (mode === 'muet') return; d[k] = String(v); },
    getItem(k) { return k in d ? d[k] : null; },
    removeItem(k) { delete d[k]; },
    _contenu: d,
  };
}

function nouveauBac({ stockage = 'ok', reseau = 'ok' } = {}) {
  const bac = {
    console, Math, Date, JSON, parseInt, parseFloat, String, Array, Object, Number, isNaN, Promise, setTimeout, Error,
    SUPABASE_URL: 'https://exemple.invalid', SUPABASE_KEY: 'cle-de-test',
    localStorage: fauxStockage(stockage),
    role: 'livreur', livNom: 'RANOU', currentLvTourneeId: 'T-1',
    commandes: [], tournees: [], stockCamion: [],
    document: { getElementById: () => null, querySelectorAll: () => [] },
    // réseau : 'mort' = la requête ne répond JAMAIS (cas 4G au dépôt)
    fetch: (url, opt) => (reseau === 'mort' ? new Promise(() => {}) : Promise.resolve({ ok: true, text: async () => '' })),
    ajouterStockCamion: (...a) => (reseau === 'mort' ? new Promise(() => {}) : Promise.resolve('sc1')),
    retirerStockCamion: () => (reseau === 'mort' ? new Promise(() => {}) : Promise.resolve()),
    logMouvementStock: () => Promise.resolve(),
    findCmdForStop(s) { return bac.commandes.find(c => c.id === s.cmdId) || null; },
    toast() {}, renderLivreur() {}, sasCacher() {}, sasGenererListe() {}, sasMettreAJourCompteur() {},
  };
  vm.createContext(bac);
  vm.runInContext(blocStockage(), bac);
  vm.runInContext('var chargements = {};', bac);
  for (const f of ['async function toggleChargement(cmdId, ligneIdx, charge)', 'function calculerProgressionChargement(t)',
    'function sasEstDeverrouille(tid)', 'function sasMarquerDeverrouille(tid, mode)', 'function sasDoitAfficher(t)',
    'function sasValiderEtDemarrer(tid)']) vm.runInContext(extraireFonction(f), bac);
  // une tournée de 2 clients, 3 lignes à charger au total
  bac.commandes.push({ id: '#T1', client: 'CLIENT A', lignes: [{ produit: 'Matelas 140', qte: 1 }, { produit: 'Sommier 140', qte: 1 }], livreur: 'RANOU' });
  bac.commandes.push({ id: '#T2', client: 'CLIENT B', lignes: [{ produit: 'Lit NICO', qte: 1 }], livreur: 'RANOU' });
  bac.tournees.push({ id: 'T-1', livreur: 'RANOU', statut: 'préparée', stops: [{ cmdId: '#T1', client: 'CLIENT A', statut: 'en-attente' }, { cmdId: '#T2', client: 'CLIENT B', statut: 'en-attente' }] });
  return bac;
}

let ok = 0, ko = 0;
const test = (nom, cond, det) => { if (cond) { ok++; console.log('  OK    ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (det !== undefined ? ' — ' + JSON.stringify(det) : '')); } };
const souffler = () => new Promise(r => setImmediate(r));
// coche une ligne comme le fait l'écran : on n'ATTEND PAS l'enregistrement
const cocher = (bac, cmdId, idx) => { const p = bac.toggleChargement(cmdId, idx, true); if (p && p.catch) p.catch(() => {}); };
const tournee = (bac) => bac.tournees[0];

(async () => {
  console.log('\n1. CAS NORMAL (téléphone qui enregistre, réseau correct)');
  let bac = nouveauBac();
  test('au départ, l\'écran de chargement s\'affiche', bac.sasDoitAfficher(tournee(bac)) === true);
  test('3 produits à charger', bac.calculerProgressionChargement(tournee(bac)).total === 3, bac.calculerProgressionChargement(tournee(bac)));
  cocher(bac, '#T1', 0); cocher(bac, '#T1', 1); cocher(bac, '#T2', 0);
  await souffler();
  test('les 3 lignes sont comptées comme chargées', bac.calculerProgressionChargement(tournee(bac)).charges === 3, bac.calculerProgressionChargement(tournee(bac)));
  bac.sasValiderEtDemarrer('T-1');
  test('après validation, l\'écran ne revient pas', bac.sasDoitAfficher(tournee(bac)) === false);

  console.log('\n2. TÉLÉPHONE QUI REFUSE D\'ENREGISTRER (panne du livreur, 10/10)');
  bac = nouveauBac({ stockage: 'refus' });
  cocher(bac, '#T1', 0); cocher(bac, '#T1', 1); cocher(bac, '#T2', 0);
  await souffler();
  test('les cases cochées sont bien comptées', bac.calculerProgressionChargement(tournee(bac)).charges === 3);
  bac.sasValiderEtDemarrer('T-1');
  test('le déverrouillage est retenu en mémoire', bac.sasEstDeverrouille('T-1') === true);
  test('l\'écran de chargement NE REVIENT PAS (c\'était le blocage)', bac.sasDoitAfficher(tournee(bac)) === false);

  console.log('\n3. TÉLÉPHONE QUI ACCEPTE MAIS PERD TOUT (stockage muet)');
  bac = nouveauBac({ stockage: 'muet' });
  cocher(bac, '#T1', 0); cocher(bac, '#T1', 1); cocher(bac, '#T2', 0);
  await souffler();
  bac.sasValiderEtDemarrer('T-1');
  test('déverrouillage retenu malgré le stockage muet', bac.sasEstDeverrouille('T-1') === true);
  test('l\'écran de chargement ne revient pas', bac.sasDoitAfficher(tournee(bac)) === false);

  console.log('\n4. RÉSEAU QUI NE RÉPOND JAMAIS (4G faible au dépôt)');
  bac = nouveauBac({ reseau: 'mort' });
  cocher(bac, '#T1', 0); cocher(bac, '#T1', 1); cocher(bac, '#T2', 0);
  await souffler();
  test('le compteur avance quand même (l\'écran ne fige plus)', bac.calculerProgressionChargement(tournee(bac)).charges === 3, bac.calculerProgressionChargement(tournee(bac)));
  bac.sasValiderEtDemarrer('T-1');
  test('la tournée peut démarrer sans réseau', bac.sasDoitAfficher(tournee(bac)) === false);

  console.log('\n5. GARDE-FOUS CONSERVÉS');
  bac = nouveauBac();
  cocher(bac, '#T1', 0);
  await souffler();
  test('chargement incomplet : l\'écran reste affiché', bac.sasDoitAfficher(tournee(bac)) === true);
  test('progression partielle 1/3', bac.calculerProgressionChargement(tournee(bac)).charges === 1);
  // déverrouillage d'hier : ne doit pas servir aujourd'hui
  bac = nouveauBac();
  const hier = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  bac.mxEcrire('mx_sas_deverrouille_T-1', JSON.stringify({ date: hier, mode: 'normal' }));
  test('déverrouillage de la veille ignoré', bac.sasEstDeverrouille('T-1') === false);
  test('donc l\'écran de chargement revient le lendemain', bac.sasDoitAfficher(tournee(bac)) === true);
  // admin et collaboratrice ne voient jamais cet écran
  bac = nouveauBac(); bac.role = 'admin';
  test('aucun écran de chargement pour l\'admin', bac.sasDoitAfficher(tournee(bac)) === false);
  bac = nouveauBac(); bac.role = 'collab';
  test('aucun écran de chargement pour la collaboratrice', bac.sasDoitAfficher(tournee(bac)) === false);
  // tournée déjà commencée
  bac = nouveauBac(); tournee(bac).stops[0].statut = 'livré';
  test('tournée déjà commencée : pas de blocage au rechargement', bac.sasDoitAfficher(tournee(bac)) === false);

  console.log('\n' + ok + ' OK, ' + ko + ' échec(s)');
  process.exit(ko ? 1 : 0);
})();
