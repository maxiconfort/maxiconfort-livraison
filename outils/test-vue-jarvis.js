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
{ // v7.5.127 (relecture, MAJEUR) : le VRAI cmdPeuplerFiltresSelects garde l'origine demandée même sans commande chargée
  const k = html.indexOf('function cmdPeuplerFiltresSelects()'); const fin = html.indexOf('\n}\n', k);
  const opts = []; const sel = { value: 'TikTok Shop', set innerHTML(h) { opts.length = 0; (h.match(/value="([^"]*)"/g) || []).forEach((m) => opts.push(m.slice(7, -1))); }, appendChild(o) { opts.push(o.value); } };
  const bac = { commandes: [{ origine: 'LeBonCoin', adresse: '' }], produits: [], JVUE_ORIGINES: b.JVUE_ORIGINES, cmdExtraireVille: () => '', document: { getElementById: (id) => (id === 'cmd-filter-origine' ? sel : null), createElement: () => ({}) } };
  vm.createContext(bac); vm.runInContext(html.slice(k, fin + 2) + '\ncmdPeuplerFiltresSelects();', bac);
  test('v7.5.127 : origine sans commande chargée gardée dans le menu (jamais « toutes »)', opts.includes('TikTok Shop') && sel.value === 'TikTok Shop', opts);
  test('v7.5.127 : filtre Origine insensible à la casse', /\(c\.origine \|\| ''\)\.toLowerCase\(\) !== origine\.toLowerCase\(\)/.test(html));
}
{ // v7.5.128 (recette JARVIS 09/11 22:45) : tournées au jour demandé, optimiser, autres rubriques
  console.log('\n2 bis. TOURNÉES, OPTIMISER, RUBRIQUES (v7.5.128)');
  test('tournees:tomorrow', JSON.stringify(L('#jarvis=tournees:tomorrow')) === JSON.stringify({ vue: 'tournees', jour: 'tomorrow', livreur: '', appliquer: false }));
  test('tournees::RANOU (livreur sans jour)', L('#jarvis=tournees::RANOU').livreur === 'RANOU');
  test('tournees:2026-11-10:RANOU', L('#jarvis=tournees:2026-11-10:RANOU').livreur === 'RANOU');
  test('optim:tomorrow::appliquer accepté (livreur facultatif)', L('#jarvis=optim:tomorrow::appliquer').appliquer === true);
  test('optim:today:RANOU:appliquer', L('#jarvis=optim:today:RANOU:appliquer').appliquer === true);
  test('« lancer » n’existe plus (le calcul part à l’ouverture)', b.jvueLire('#jarvis=optim:today:RANOU:lancer') === null);
  test('page:suivi / page:stock', L('#jarvis=page:suivi').page === 'suivi' && L('#jarvis=page:stock').page === 'stock');
  for (const h of ['#jarvis=tournees:hier', '#jarvis=tournees:today:XX', '#jarvis=optim:appliquer', '#jarvis=optim::RANOU:appliquer', '#jarvis=optim:today:RANOU:effacer', '#jarvis=page:pins', '#jarvis=page:inconnue', '#jarvis=tournees:today:RANOU:appliquer'])
    test('v7.5.128 refusé : ' + h, b.jvueLire(h) === null);
  test('jour « demain » à l’heure de l’appareil', b.jvueJour('tomorrow', new Date(2026, 10, 9, 23, 30).getTime()) === '2026-11-10');
  test('tournées du jour filtrées par livreur', b.jvueTourneesDuJour([{ id: 'T1', date: '2026-11-10', livreur: 'RANOU' }, { id: 'T2', date: '2026-11-10', livreur: 'GLS' }, { id: 'T3', date: '2026-11-11', livreur: 'RANOU' }], '2026-11-10', 'RANOU').map((t) => t.id).join() === 'T1');
  test('écriture (optimiser) refusée hors fenêtre JARVIS', (() => { const w = b.window; b.window = { top: null }; b.window.top = b.window; const r = b.jvueDansJarvis(); b.window = w; return r === false; })());
  test('écriture : origine du parent = JARVIS sur cet appareil seulement (127.0.0.1 / localhost)', /127\\\.0\\\.0\\\.1\|localhost\)/.test(html) && !/ts\\\.net/.test(html.slice(html.indexOf('function jvueDansJarvis'), html.indexOf('function jvueDansJarvis') + 600)));
  { const w = b.window, a = b.location.ancestorOrigins; b.window = { top: {} }; const essai = (o) => { b.location.ancestorOrigins = [o]; return b.jvueDansJarvis(); };
    test('origines refusées : Tailscale public, autre site, https local', !essai('https://x.y.ts.net') && !essai('https://pirate.example') && !essai('https://127.0.0.1:49265'));
    test('origine acceptée : http://127.0.0.1:49265', essai('http://127.0.0.1:49265')); b.window = w; b.location.ancestorOrigins = a; }
}
test('v7.5.128 : enregistrer l’ordre — une fois par tournée en 2 min, seulement sur l’ordre déjà calculé de CETTE tournée', /Date\.now\(\) - deja < 120000/.test(html) && /optimTourneeId === lo\[0\]\.id && typeof optimStops/.test(html) && /optimCalculeFini === lo\[0\]\.id/.test(html) && /optimCalculeFini = optimTourneeId;/.test(html) && /async function optimCharger\(\) \{\n  optimCalculeFini = null;/.test(html) && !/optimLancer\(\)/.test(html.slice(html.indexOf('// JVUE-DEBUT'), html.indexOf('// JVUE-FIN'))));
test('v7.5.128 : plus aucun caractère invisible « retour arrière » dans l’appli (code postal de l’optimiseur)', !/\x08/.test(html) && /a\.match\(\/\\b\(75\|77/.test(html));
console.log('\n3. MISE EN LIGNE');
test('CACHE_VERSION augmentée (v7-5-128)', /CACHE_VERSION = 'maxiconfort-v7-5-128'/.test(fs.readFileSync(path.join(racine, 'service-worker.js'), 'utf8')));
console.log('\n' + ok + ' OK, ' + ko + ' échec(s)'); process.exit(ko ? 1 : 0);
