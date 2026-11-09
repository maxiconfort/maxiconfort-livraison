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
  closePanel: () => appels.push('fermer'), goTo: (p) => appels.push('goTo:' + p), ouvrirCmd: (id) => appels.push('fiche:' + id), toast: () => {}, cmdFiltreRapide: (p) => appels.push('preset:' + p), decodeURIComponent, JSON };
vm.createContext(b); vm.runInContext(bloc, b);

console.log('\n1. LECTURE DE L\'ANCRE (fonction pure)');
const L = (h) => JSON.parse(JSON.stringify(b.jvueLire(h)));
test('fiche:2145 → #2145', JSON.stringify(L('#jarvis=fiche:2145')) === JSON.stringify({ vue: 'fiche', id: '#2145' }));
test('commandes de demain RANOU', JSON.stringify(L('#jarvis=commandes:tomorrow:RANOU')) === JSON.stringify({ vue: 'commandes', preset: 'tomorrow', livreur: 'RANOU', statut: '', origine: '' }));
test('ancre encodée acceptée', L('#jarvis=commandes%3Alate').preset === 'late');
test('numéro de demande accepté (même vue redemandée)', L('#jarvis=fiche:2145;1730900000').id === '#2145');
test('paramètres', L('#jarvis=parametres').vue === 'parametres');
test('v7.5.126 : GLS en attente', JSON.stringify(L('#jarvis=commandes:all:GLS:en-attente')) === JSON.stringify({ vue: 'commandes', preset: 'all', livreur: 'GLS', statut: 'en-attente', origine: '' }));
test('v7.5.126 : statut sans livreur (champ vide)', JSON.stringify(L('#jarvis=commandes:week::annul%C3%A9')) === JSON.stringify({ vue: 'commandes', preset: 'week', livreur: '', statut: 'annulé', origine: '' }));
test('v7.5.127 : origine seule', JSON.stringify(L('#jarvis=commandes:all:::TikTok%20Shop')) === JSON.stringify({ vue: 'commandes', preset: 'all', livreur: '', statut: '', origine: 'TikTok Shop' }));
test('v7.5.127 : statut + origine', L('#jarvis=commandes:week::en-attente:LeBonCoin').origine === 'LeBonCoin');
for (const h of ['#jarvis=commandes:all:::Inconnu', '#jarvis=commandes:all::::', '#jarvis=commandes:all:::', '#jarvis=commandes:all:::TikTok%20Shop:x', '#jarvis=commandes:all:::%3Cscript%3E'])
  test('v7.5.127 refusé : ' + h, b.jvueLire(h) === null);
for (const h of ['#jarvis=commandes:all:GLS:supprime', '#jarvis=commandes:all:GLS:en-attente:x', '#jarvis=commandes:all:', '#jarvis=commandes:all::', '#jarvis=commandes:all:XX:en-attente'])
  test('v7.5.126 refusé : ' + h, b.jvueLire(h) === null);
test('tournées et accueil', L('#jarvis=tournees').vue === 'tournees' && L('#jarvis=accueil').vue === 'accueil');
for (const h of ['', '#autre', '#jarvis=fiche:21;drop', '#jarvis=fiche:<script>', '#jarvis=commandes:hier', '#jarvis=commandes:today:INCONNU', '#jarvis=supprimer:2145', '#jarvis=fiche:2145&x=1', '#jarvis=fiche:2145;abc', '#jarvis=%E0%A4%A'])
  test('refusé : ' + (h || '(vide)'), b.jvueLire(h) === null);

console.log('\n2. APPLICATION (navigation seulement)');
const lancer = (h, role, cmds) => { appels.length = 0; b.location.hash = h; b.role = role; b.commandes = cmds; b.jvueAppliquer(); if (minuteur) minuteur(); return appels.slice(); };
test('personne connecté : rien ne bouge (attend l\'écran du code)', lancer('#jarvis=fiche:2145', null, []).length === 0);
test('livreur : jamais de vue bureau', lancer('#jarvis=fiche:2145', 'livreur', [{ id: '#2145' }]).length === 0);
test('collab : fiche ouverte', JSON.stringify(lancer('#jarvis=fiche:2145', 'collab', [{ id: '#2145' }])) === JSON.stringify(['goTo:commandes', 'fiche:#2145']));
test('chiffre en trop entendu (21405) : #2145 ouvert s\'il est le seul possible', JSON.stringify(lancer('#jarvis=fiche:21405', 'admin', [{ id: '#2145' }, { id: '#1999' }])) === JSON.stringify(['goTo:commandes', 'fiche:#2145']));
test('4 chiffres : jamais rapproché', JSON.stringify(lancer('#jarvis=fiche:2146', 'admin', [{ id: '#214' }])) === JSON.stringify(['goTo:commandes']));
test('deux possibilités : rien n\'est ouvert', JSON.stringify(lancer('#jarvis=fiche:21455', 'admin', [{ id: '#2145' }, { id: '#2155' }])) === JSON.stringify(['goTo:commandes']));
test('fiche inconnue : page commandes seulement', JSON.stringify(lancer('#jarvis=fiche:9999', 'admin', [{ id: '#2145' }])) === JSON.stringify(['goTo:commandes']));
test('demain RANOU : page commandes + filtre rapide', JSON.stringify(lancer('#jarvis=commandes:tomorrow:RANOU', 'collab', [{ id: '#1' }])) === JSON.stringify(['fermer', 'goTo:commandes', 'preset:tomorrow']));
test('tournées', JSON.stringify(lancer('#jarvis=tournees', 'admin', [{ id: '#1' }])) === JSON.stringify(['fermer', 'goTo:tournees']));
test('paramètres : admin seulement', JSON.stringify(lancer('#jarvis=parametres', 'admin', [{ id: '#1' }])) === JSON.stringify(['fermer', 'goTo:pins']) && JSON.stringify(lancer('#jarvis=parametres', 'collab', [{ id: '#1' }])) === JSON.stringify(['fermer']));
test('fiche ouverte : jamais refermée par une vue fiche, refermée par la liste', JSON.stringify(lancer('#jarvis=commandes:all', 'admin', [{ id: '#1' }])) === JSON.stringify(['fermer', 'goTo:commandes', 'preset:all']) && lancer('#jarvis=fiche:2145', 'admin', [{ id: '#2145' }]).indexOf('fermer') < 0);
test('menu de gauche qui défile (écran court)', /\.sidebar\{[^}]*overflow-y:auto\}/.test(html));
test('aucune écriture dans le bloc', !/sbSave|rpcPin|fetch\(|sessionEcrire|localStorage\.setItem|\.insert\(|\.update\(/.test(bloc));

{ // v7.5.126 : le menu « Statut » est positionné (et vidé quand la vue n'en demande pas)
  const champs = {}; const avant = b.document.getElementById; b.document.getElementById = (id) => (champs[id] = champs[id] || { value: 'ancien' });
  lancer('#jarvis=commandes:all:GLS:en-attente', 'admin', [{ id: '#1' }]);
  test('v7.5.126 : GLS + en attente appliqués', champs['cmd-filter-transporteur'].value === 'GLS' && champs['cmd-filter-statut'].value === 'en-attente', champs);
  lancer('#jarvis=commandes:tomorrow:RANOU', 'admin', [{ id: '#1' }]);
  test('v7.5.126 : sans statut demandé, le filtre Statut est vidé', champs['cmd-filter-statut'].value === '', champs);
  test('v7.5.126 : recherche et autres filtres vidés', ['cmd-search', 'cmd-filter-origine', 'cmd-filter-ville', 'cmd-filter-produit', 'cmd-filter-paiement'].every((id) => champs[id] && champs[id].value === ''), champs);
  lancer('#jarvis=commandes:all:::TikTok%20Shop', 'admin', [{ id: '#1' }]);
  test('v7.5.127 : origine posée', champs['cmd-filter-origine'].value === 'TikTok Shop' && champs['cmd-filter-statut'].value === '' && champs['cmd-filter-transporteur'].value === '', champs);
  lancer('#jarvis=commandes:all:GLS', 'admin', [{ id: '#1' }]);
  test('v7.5.127 : sans origine demandée, le filtre Origine est vidé', champs['cmd-filter-origine'].value === '', champs);
  b.document.getElementById = avant;
}
console.log('\n3. MISE EN LIGNE');
test('CACHE_VERSION augmentée (v7-5-127)', /CACHE_VERSION = 'maxiconfort-v7-5-127'/.test(fs.readFileSync(path.join(racine, 'service-worker.js'), 'utf8')));
console.log('\n' + ok + ' OK, ' + ko + ' échec(s)'); process.exit(ko ? 1 : 0);
