// Banc de test « JARVIS montre l'appli » (v7.5.122, 06/11/2026). Usage : node outils/test-vue-jarvis.js
// Extrait le vrai bloc JVUE de maxiconfort-v7.html et l'exécute dans un bac à sable (aucune connexion, aucune donnée réelle).
const fs = require('fs'), path = require('path'), vm = require('vm');
const racine = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(racine, 'maxiconfort-v7.html'), 'utf8');
let ok = 0, ko = 0;
const test = (nom, cond, det) => { if (cond) { ok++; console.log('  OK    ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (det ? ' — ' + JSON.stringify(det).slice(0, 200) : '')); } };
const i = html.indexOf('// JVUE-DEBUT'), j = html.indexOf('// JVUE-FIN');
const bloc = html.slice(i, j);
const appels = []; let minuteur = null;
const b = { location: { hash: '' }, role: null, commandes: [], window: { addEventListener() {} }, document: { addEventListener() {}, querySelector: () => null, getElementById: () => ({ value: 'GLS' }) },
  setInterval: (f) => { minuteur = f; return 1; }, clearInterval: () => { minuteur = null; }, setTimeout: (f) => f(),
  goTo: (p) => appels.push('goTo:' + p), ouvrirCmd: (id) => appels.push('fiche:' + id), cmdFiltreRapide: (p) => appels.push('preset:' + p), decodeURIComponent, JSON };
vm.createContext(b); vm.runInContext(bloc, b);

console.log('\n1. LECTURE DE L\'ANCRE (fonction pure)');
const L = (h) => JSON.parse(JSON.stringify(b.jvueLire(h)));
test('fiche:2145 → #2145', JSON.stringify(L('#jarvis=fiche:2145')) === JSON.stringify({ vue: 'fiche', id: '#2145' }));
test('commandes de demain RANOU', JSON.stringify(L('#jarvis=commandes:tomorrow:RANOU')) === JSON.stringify({ vue: 'commandes', preset: 'tomorrow', livreur: 'RANOU' }));
test('ancre encodée acceptée', L('#jarvis=commandes%3Alate').preset === 'late');
test('tournées et accueil', L('#jarvis=tournees').vue === 'tournees' && L('#jarvis=accueil').vue === 'accueil');
for (const h of ['', '#autre', '#jarvis=fiche:21;drop', '#jarvis=fiche:<script>', '#jarvis=commandes:hier', '#jarvis=commandes:today:INCONNU', '#jarvis=supprimer:2145', '#jarvis=fiche:2145&x=1', '#jarvis=%E0%A4%A'])
  test('refusé : ' + (h || '(vide)'), b.jvueLire(h) === null);

console.log('\n2. APPLICATION (navigation seulement)');
const lancer = (h, role, cmds) => { appels.length = 0; b.location.hash = h; b.role = role; b.commandes = cmds; b.jvueAppliquer(); if (minuteur) minuteur(); return appels.slice(); };
test('personne connecté : rien ne bouge (attend l\'écran du code)', lancer('#jarvis=fiche:2145', null, []).length === 0);
test('livreur : jamais de vue bureau', lancer('#jarvis=fiche:2145', 'livreur', [{ id: '#2145' }]).length === 0);
test('collab : fiche ouverte', JSON.stringify(lancer('#jarvis=fiche:2145', 'collab', [{ id: '#2145' }])) === JSON.stringify(['goTo:commandes', 'fiche:#2145']));
test('fiche inconnue : page commandes seulement', JSON.stringify(lancer('#jarvis=fiche:9999', 'admin', [{ id: '#2145' }])) === JSON.stringify(['goTo:commandes']));
test('demain RANOU : page commandes + filtre rapide', JSON.stringify(lancer('#jarvis=commandes:tomorrow:RANOU', 'collab', [{ id: '#1' }])) === JSON.stringify(['goTo:commandes', 'preset:tomorrow']));
test('tournées', JSON.stringify(lancer('#jarvis=tournees', 'admin', [{ id: '#1' }])) === JSON.stringify(['goTo:tournees']));
test('aucune écriture dans le bloc', !/sbSave|rpcPin|fetch\(|sessionEcrire|localStorage\.setItem|\.insert\(|\.update\(/.test(bloc));

console.log('\n3. MISE EN LIGNE');
test('CACHE_VERSION augmentée (v7-5-122)', /CACHE_VERSION = 'maxiconfort-v7-5-122'/.test(fs.readFileSync(path.join(racine, 'service-worker.js'), 'utf8')));
console.log('\n' + ok + ' OK, ' + ko + ' échec(s)'); process.exit(ko ? 1 : 0);
