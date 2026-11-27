// Banc de test de la page COMMANDES allégée (v7.5.190, demande de Borhen du 26/11/2026). Usage : node outils/test-commandes-filtres.js
// Extrait le VRAI code de maxiconfort-v7.html (bloc CMDF, cmdAppliquerFiltres, cmdResetFiltres, cmdFiltreRapide…) et l'exécute
// dans un bac à sable : aucune connexion, aucune donnée réelle, commandes fictives seulement.
// Couvre : période sur la date de prise / de livraison, combinaison avec les autres filtres, mémorisation sur l'appareil,
// bouton « Effacer », tri des deux colonnes de dates, total (montant pour l'administrateur, jamais pour la collaboratrice),
// un seul bouton « Nouvelle commande », compteur des filtres, vue JARVIS.
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'maxiconfort-v7.html'), 'utf8').replace(/\r\n/g, '\n');
let ok = 0, ko = 0;
const test = (nom, cond, det) => { if (cond) { ok++; console.log('  OK    ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (det !== undefined ? ' — ' + JSON.stringify(det).slice(0, 300) : '')); } };
const egal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tranche = (debut, fin) => { const i = html.indexOf(debut), j = html.indexOf(fin, i); if (i < 0 || j < 0) throw new Error('introuvable : ' + debut); return html.slice(i, j); };
function fonction(signature) { // du mot-clé jusqu'à l'accolade fermante correspondante (chaînes et commentaires ignorés)
  const i = html.indexOf(signature); if (i < 0) throw new Error('fonction introuvable : ' + signature);
  let n = 0, dans = null, ech = false;
  for (let p = html.indexOf('{', i); p < html.length; p++) { const ch = html[p];
    if (dans) { if (ech) ech = false; else if (ch === '\\') ech = true; else if (ch === dans) dans = null; continue; }
    if (ch === '/' && html[p + 1] === '/') { p = html.indexOf('\n', p); continue; }
    if (ch === "'" || ch === '"' || ch === '`') { dans = ch; continue; }
    if (ch === '{') n++; else if (ch === '}') { n--; if (n === 0) return html.slice(i, p + 1); } }
  throw new Error('accolade non refermée : ' + signature);
}
const BLOC = tranche('// CMDF-DEBUT', '// CMDF-FIN');

// ---------- faux navigateur ----------
function classes() { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle(c, v) { const on = v === undefined ? !s.has(c) : !!v; if (on) s.add(c); else s.delete(c); return on; } }; }
function element(id) { return { id, value: '', innerHTML: '', textContent: '', style: {}, attrs: {}, classList: classes(), setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; }, querySelectorAll() { return []; }, querySelector() { return null; } }; }
function nouveauBac(opt) {
  const o = opt || {}; const els = {}; const stock = Object.assign({}, o.stock || {}); const rendus = [];
  const el = (id) => (els[id] = els[id] || element(id));
  // panneaux repliés au départ, comme dans la page
  el('cmdf-panneau-periode').style.display = 'none'; el('cmd-filtres-panneau').style.display = 'none';
  const seg = el('cmdf-champ'); const segBtns = ['prise', 'livraison'].map((v) => { const b = element('seg-' + v); b.attrs['data-v'] = v; return b; }); seg.querySelectorAll = () => segBtns;
  const ths = ['prise', 'livraison'].map((v) => { const th = element('th-' + v); th.attrs['data-tri'] = v; const fl = element('fl-' + v); th.querySelector = () => fl; th.fl = fl; return th; });
  const quick = ['today', 'tomorrow', 'week', 'late', 'all'].map((p) => { const b = element('q-' + p); b.dataset = { preset: p }; return b; });
  const bac = {
    console, JSON, Math, Date, Number, String, Object, Array, Set, isNaN, parseFloat,
    role: o.role === undefined ? 'admin' : o.role,
    commandes: o.commandes || [], produits: [],
    document: { getElementById: el, querySelectorAll: (q) => (q === 'th.cmdf-tri' ? ths : q === '.cmd-quick' ? quick : []) },
    localStorage: o.sansStockage ? { getItem() { throw new Error('bloqué'); }, setItem() { throw new Error('bloqué'); } }
      : { getItem: (k) => (Object.prototype.hasOwnProperty.call(stock, k) ? stock[k] : null), setItem: (k, v) => { stock[k] = String(v); } },
    renderCmds: (l) => rendus.push(l.map((c) => c.id)),
    cmdPeuplerFiltresSelects: () => {},
    paiFiltre: (c, v) => c.paiTest === v,
  };
  vm.createContext(bac);
  vm.runInContext(BLOC, bac);
  for (const f of ['function cmdGetTransporteur(c)', 'function cmdExtraireVille(adresse)', 'function cmdUpdateQuickBtns(active)', 'function cmdFiltreRapide(preset)', 'function cmdResetFiltres()', 'function cmdAppliquerFiltres()'])
    vm.runInContext(fonction(f), bac);
  vm.runInContext('var cmdPresetActif = "";', bac);
  return { bac, els, el, stock, rendus, ths, segBtns, dernier: () => rendus[rendus.length - 1] };
}
const C = (id, o) => Object.assign({ id, client: 'Client ' + id, tel: '', adresse: '75001 Paris', produit: 'Matelas', prix: 100, statut: 'en-attente', origine: 'LeBonCoin', transporteur: 'RANOU', livreur: '', dateCmd: '', date: '' }, o);
const CMDS = [
  C('#1', { dateCmd: '2026-11-02', date: '2026-11-20', prix: 300 }),
  C('#2', { dateCmd: '2026-11-03', date: '2026-11-05', prix: 450.5, transporteur: 'GLS' }),
  C('#3', { dateCmd: '2026-11-15', date: '2026-11-26', prix: 200 }),
  C('#4', { dateCmd: '2026-11-26', date: '', prix: 80 }), // pas encore planifiée
  C('#5', { dateCmd: '2026-10-30', date: '2026-11-04', prix: 999, statut: 'annulé' }),
  C('#SAV9', { dateCmd: '2026-11-10', date: '2026-11-12', prix: 0, origine: 'SAV - Remboursement', montantEnc: 50 }),
];

console.log('\n1. FONCTIONS PURES (bloc CMDF)');
{
  const { bac } = nouveauBac();
  const N = (o) => JSON.parse(JSON.stringify(bac.cmdfNormaliser(o)));
  test('défaut : aucune période, date de livraison, aucun tri, filtres repliés', egal(N(null), { du: '', au: '', champ: 'livraison', tri: '', sens: 'desc', ouvert: false }));
  test('valeurs inattendues → défaut (dates mal formées, champ, tri, sens, ouvert)', egal(N({ du: '3/11', au: 'x', champ: 'autre', tri: 'client', sens: 'n', ouvert: 'oui' }), N(null)));
  test('bornes inversées remises dans l’ordre', egal([N({ du: '2026-11-26', au: '2026-11-03' }).du, N({ du: '2026-11-26', au: '2026-11-03' }).au], ['2026-11-03', '2026-11-26']));
  const P = (c, e) => bac.cmdfDansPeriode(c, bac.cmdfNormaliser(e));
  test('période sur la date de LIVRAISON (bornes comprises)', CMDS.filter((c) => P(c, { du: '2026-11-05', au: '2026-11-20' })).map((c) => c.id).join() === '#1,#2,#SAV9');
  test('période sur la date de PRISE (bornes comprises)', CMDS.filter((c) => P(c, { du: '2026-11-03', au: '2026-11-26', champ: 'prise' })).map((c) => c.id).join() === '#2,#3,#4,#SAV9');
  test('sans date de livraison : exclue dès qu’une borne est posée', !P(CMDS[3], { du: '2026-11-01' }) && P(CMDS[3], {}));
  test('borne seule « depuis »', CMDS.filter((c) => P(c, { du: '2026-11-15', champ: 'prise' })).map((c) => c.id).join() === '#3,#4');
  test('date avec heure (ISO) acceptée', P({ date: '2026-11-20T10:00:00Z' }, { du: '2026-11-20', au: '2026-11-20' }));
  const T = (tri, sens) => bac.cmdfTrier(CMDS.slice(), bac.cmdfNormaliser({ tri, sens })).map((c) => c.id).join();
  test('tri date de prise, récent → ancien', T('prise', 'desc') === '#4,#3,#SAV9,#2,#1,#5', T('prise', 'desc'));
  test('tri date de prise, ancien → récent', T('prise', 'asc') === '#5,#1,#2,#SAV9,#3,#4', T('prise', 'asc'));
  test('tri date de livraison : sans date toujours en bas (dans les deux sens)', T('livraison', 'desc') === '#3,#1,#SAV9,#2,#5,#4' && T('livraison', 'asc') === '#5,#2,#SAV9,#1,#3,#4', [T('livraison', 'desc'), T('livraison', 'asc')]);
  test('aucun tri : ordre d’origine inchangé', T('', 'desc') === CMDS.map((c) => c.id).join());
  let e = bac.cmdfNormaliser(null);
  e = bac.cmdfClicTri(e, 'prise'); const c1 = [e.tri, e.sens];
  e = bac.cmdfClicTri(e, 'prise'); const c2 = [e.tri, e.sens];
  e = bac.cmdfClicTri(e, 'livraison'); const c3 = [e.tri, e.sens];
  test('1er clic récent → ancien, 2e clic inverse, autre colonne → récent → ancien', egal([c1, c2, c3], [['prise', 'desc'], ['prise', 'asc'], ['livraison', 'desc']]));
  const Lb = (o) => bac.cmdfLibellePeriode(bac.cmdfNormaliser(o), 2026);
  test('libellé compact « 03/11 → 26/11 »', Lb({ du: '2026-11-03', au: '2026-11-26' }) === '03/11 → 26/11');
  test('libellé sans période : « Période »', Lb({}) === 'Période');
  test('libellé une borne : « depuis » / « jusqu’au »', Lb({ du: '2026-11-03' }) === 'depuis 03/11' && Lb({ au: '2026-11-26' }) === 'jusqu\'au 26/11');
  test('autre année : année courte ajoutée', Lb({ du: '2025-12-20', au: '2026-01-05' }) === '20/12/25 → 05/01');
  test('compteur des filtres actifs', bac.cmdfNbActifs(['', 'GLS', '', 'Matelas', '']) === 2 && bac.cmdfNbActifs(['', '', '', '', '']) === 0);
  const nombres = (s) => s.replace(/[  ]/g, ' ');
  test('total ADMIN : « N commandes · X € » (annulée hors montant, remboursement négatif)', nombres(bac.cmdfTotal(CMDS, 'admin')) === '6 commandes · 980,5 € (hors annulées)', bac.cmdfTotal(CMDS, 'admin'));
  test('total ADMIN sans annulée : pas de mention', nombres(bac.cmdfTotal(CMDS.slice(0, 3), 'admin')) === '3 commandes · 950,5 €', bac.cmdfTotal(CMDS.slice(0, 3), 'admin'));
  test('total COLLABORATRICE : nombre seul, aucun montant', bac.cmdfTotal(CMDS, 'collab') === '6 commandes' && !/€|\d,\d/.test(bac.cmdfTotal(CMDS, 'collab')));
  test('rôle inconnu / non connecté : jamais de montant', bac.cmdfTotal(CMDS, null) === '6 commandes' && bac.cmdfTotal(CMDS, 'livreur') === '6 commandes');
  test('singulier et liste vide', bac.cmdfTotal([CMDS[0]], 'collab') === '1 commande' && bac.cmdfTotal([], 'collab') === '0 commande' && nombres(bac.cmdfTotal([], 'admin')) === '0 commande · 0 €');
}

console.log('\n2. PAGE : PÉRIODE COMBINÉE AUX AUTRES FILTRES (vrai cmdAppliquerFiltres)');
{
  const x = nouveauBac({ commandes: CMDS });
  x.bac.cmdAppliquerFiltres();
  test('sans filtre : toutes les commandes', x.dernier().join() === CMDS.map((c) => c.id).join());
  x.el('cmdf-du').value = '2026-11-01'; x.el('cmdf-au').value = '2026-11-30'; x.bac.cmdfPeriodeChange();
  test('période 01/11 → 30/11 (livraison)', x.dernier().join() === '#1,#2,#3,#5,#SAV9', x.dernier());
  test('bouton « Période » : période active affichée et allumé', x.el('cmdf-btn-periode').textContent === '01/11 → 30/11' && x.el('cmdf-btn-periode').classList.contains('on'));
  x.el('cmd-filter-transporteur').value = 'GLS'; x.bac.cmdAppliquerFiltres();
  test('+ transporteur GLS', x.dernier().join() === '#2', x.dernier());
  test('compteur « Filtres » = 1', /cmdf-nb">1</.test(x.el('cmdf-btn-filtres').innerHTML), x.el('cmdf-btn-filtres').innerHTML);
  x.el('cmd-filter-transporteur').value = ''; x.el('cmd-search').value = 'client #3'; x.bac.cmdAppliquerFiltres();
  test('+ recherche', x.dernier().join() === '#3', x.dernier());
  x.el('cmd-search').value = ''; x.el('cmd-filter-statut').value = 'en-attente'; x.bac.cmdAppliquerFiltres();
  test('+ statut', x.dernier().join() === '#1,#2,#3,#SAV9', x.dernier());
  x.el('cmd-filter-statut').value = ''; x.bac.cmdfChamp('prise');
  test('bascule sur la date de prise', x.dernier().join() === '#1,#2,#3,#4,#SAV9', x.dernier());
  test('choix « Date de prise » allumé', x.segBtns[0].classList.contains('on') && !x.segBtns[1].classList.contains('on'));
  x.bac.cmdFiltreRapide('week');
  const avecSemaine = x.dernier().length;
  test('bouton rapide combiné à la période (jamais plus large que la période)', avecSemaine <= 5 && x.dernier().every((id) => ['#1', '#2', '#3', '#4', '#SAV9'].includes(id)), x.dernier());
  x.bac.cmdFiltreRapide('all');
  test('« Tout » : la période reste appliquée', x.dernier().join() === '#1,#2,#3,#4,#SAV9', x.dernier());
}

console.log('\n3. MÉMORISATION SUR L’APPAREIL ET BOUTON « EFFACER »');
{
  const x = nouveauBac({ commandes: CMDS });
  x.el('cmdf-du').value = '2026-11-03'; x.el('cmdf-au').value = '2026-11-26'; x.bac.cmdfPeriodeChange(); x.bac.cmdfChamp('prise');
  x.bac.cmdfTrierPar('livraison'); x.bac.cmdfBasculer('filtres');
  const memo = JSON.parse(x.stock.mx_cmd_filtres_v1);
  test('choix mémorisé (période, champ, tri, panneau ouvert)', egal(memo, { du: '2026-11-03', au: '2026-11-26', champ: 'prise', tri: 'livraison', sens: 'desc', ouvert: true }), memo);
  test('aucune donnée client dans la mémoire', !/Client|Paris|#\d/.test(x.stock.mx_cmd_filtres_v1));
  const y = nouveauBac({ commandes: CMDS, stock: x.stock }); y.bac.cmdAppliquerFiltres();
  test('rechargement : même liste, triée, cases et boutons remis', y.dernier().join() === '#3,#SAV9,#2,#4' && y.el('cmdf-du').value === '2026-11-03' && y.el('cmdf-au').value === '2026-11-26' && y.el('cmdf-btn-periode').textContent === '03/11 → 26/11', y.dernier());
  test('rechargement : panneau « Filtres » ouvert, flèche ↓ sur « À livrer le » seulement', y.el('cmd-filtres-panneau').style.display === '' && y.ths[1].fl.textContent === '↓' && y.ths[0].fl.textContent === '' && y.ths[1].attrs['aria-sort'] === 'descending' && y.ths[0].attrs['aria-sort'] === 'none');
  y.el('cmd-filter-ville').value = 'Paris'; y.el('cmd-search').value = 'x';
  y.bac.cmdResetFiltres();
  const apres = JSON.parse(y.stock.mx_cmd_filtres_v1);
  test('« Effacer » : période remise à zéro et mémorisée vide', apres.du === '' && apres.au === '' && apres.champ === 'livraison' && y.el('cmdf-du').value === '' && y.el('cmdf-btn-periode').textContent === 'Période' && !y.el('cmdf-btn-periode').classList.contains('on'), apres);
  test('« Effacer » : autres filtres vidés, toutes les commandes revenues (triées)', y.el('cmd-filter-ville').value === '' && y.el('cmd-search').value === '' && y.dernier().length === CMDS.length && y.dernier()[0] === '#3', y.dernier());
  test('« Effacer » : compteur des filtres à zéro', y.el('cmdf-btn-filtres').innerHTML === 'Filtres');
  test('« Effacer » garde les préférences (tri, panneau ouvert)', apres.tri === 'livraison' && apres.ouvert === true);
  const z = nouveauBac({ commandes: CMDS, stock: { mx_cmd_filtres_v1: '{pas du json' } }); z.bac.cmdAppliquerFiltres();
  test('mémoire illisible : défaut, la page marche', z.dernier().length === CMDS.length && z.el('cmdf-btn-periode').textContent === 'Période');
  const w = nouveauBac({ commandes: CMDS, sansStockage: true }); w.bac.cmdfTrierPar('prise'); w.bac.cmdfBasculer('filtres');
  test('stockage bloqué (navigation privée) : rien ne casse, le tri marche quand même', w.dernier()[0] === '#4' && w.el('cmd-filtres-panneau').style.display === '');
}

console.log('\n4. PANNEAUX REPLIÉS, TRI PAR CLIC');
{
  const x = nouveauBac({ commandes: CMDS }); x.bac.cmdAppliquerFiltres();
  test('« Filtres » replié par défaut', x.el('cmd-filtres-panneau').style.display === 'none' && x.el('cmdf-btn-filtres').attrs['aria-expanded'] === 'false');
  x.bac.cmdfBasculer('filtres');
  test('« Filtres » : ouvre puis referme', x.el('cmd-filtres-panneau').style.display === '' && (x.bac.cmdfBasculer('filtres'), x.el('cmd-filtres-panneau').style.display === 'none'));
  x.bac.cmdfBasculer('periode');
  test('« Période » ouvre le petit panneau', x.el('cmdf-panneau-periode').style.display === '' && x.el('cmdf-btn-periode').attrs['aria-expanded'] === 'true');
  x.bac.cmdfBasculer('periode');
  test('… et le referme', x.el('cmdf-panneau-periode').style.display === 'none');
  x.bac.cmdfTrierPar('prise');
  test('clic « Date prise » : récent → ancien, flèche ↓', x.dernier().join() === '#4,#3,#SAV9,#2,#1,#5' && x.ths[0].fl.textContent === '↓' && x.ths[1].fl.textContent === '');
  x.bac.cmdfTrierPar('prise');
  test('2e clic : ancien → récent, flèche ↑', x.dernier().join() === '#5,#1,#2,#SAV9,#3,#4' && x.ths[0].fl.textContent === '↑');
}

console.log('\n5. TOTAL : ADMINISTRATEUR / COLLABORATRICE');
{
  const a = nouveauBac({ commandes: CMDS, role: 'admin' });
  a.el('cmd-filter-transporteur').value = 'RANOU'; a.bac.cmdAppliquerFiltres();
  test('admin : nombre et montant de la liste FILTRÉE', a.el('cmdf-total').textContent.replace(/[  ]/g, ' ') === '5 commandes · 530 € (hors annulées)', a.el('cmdf-total').textContent);
  const c = nouveauBac({ commandes: CMDS, role: 'collab' });
  c.el('cmd-filter-transporteur').value = 'RANOU'; c.bac.cmdAppliquerFiltres();
  test('collaboratrice : « 5 commandes », aucun montant', c.el('cmdf-total').textContent === '5 commandes');
  c.el('cmdf-du').value = '2026-11-01'; c.el('cmdf-au').value = '2026-11-30'; c.bac.cmdfPeriodeChange();
  test('collaboratrice avec période : toujours sans montant', c.el('cmdf-total').textContent === '4 commandes', c.el('cmdf-total').textContent);
}

console.log('\n6. VUE JARVIS (#jarvis=commandes…) : la période mémorisée ne cache rien');
{
  const x = nouveauBac({ commandes: CMDS, stock: { mx_cmd_filtres_v1: JSON.stringify({ du: '2026-11-25', au: '2026-11-26' }) } });
  x.bac.cmdAppliquerFiltres();
  test('avant : période mémorisée appliquée', x.dernier().join() === '#3');
  x.bac.cmdfViderPeriode(); x.bac.cmdFiltreRapide('all');
  test('vue JARVIS : toutes les commandes, bouton « Période » éteint', x.dernier().length === CMDS.length && x.el('cmdf-btn-periode').textContent === 'Période');
  test('… sans effacer le choix mémorisé de l’appareil', JSON.parse(x.stock.mx_cmd_filtres_v1).du === '2026-11-25');
  const jv = tranche('// JVUE-DEBUT', '// JVUE-FIN');
  test('le bloc JVUE appelle cmdfViderPeriode avant le filtre rapide (et n’écrit rien lui-même)', /cmdfViderPeriode\(\);[\s\S]*cmdFiltreRapide\(v\.preset\)/.test(jv) && !/localStorage\.setItem/.test(jv));
}
// v7.5.194 (revue Codex PR 28 sur 096b938) : APRÈS la vue JARVIS, une interaction qui enregistre les réglages (cmdfEcrire : tri,
// « Filtres », date de prise / livraison) ne doit pas mémoriser la période vidée ; la période revient au chargement suivant.
{
  const MEMO = JSON.stringify({ du: '2026-11-25', au: '2026-11-26' });
  const lu = (x) => JSON.parse(x.stock.mx_cmd_filtres_v1);
  const x = nouveauBac({ commandes: CMDS, stock: { mx_cmd_filtres_v1: MEMO } });
  x.bac.cmdAppliquerFiltres(); x.bac.cmdfViderPeriode(); x.bac.cmdFiltreRapide('all');
  x.bac.cmdfTrierPar('livraison');
  test('vue JARVIS puis clic sur le tri : tri enregistré, période mémorisée INTACTE (25/11 → 26/11)', lu(x).tri === 'livraison' && lu(x).du === '2026-11-25' && lu(x).au === '2026-11-26', x.stock.mx_cmd_filtres_v1);
  test('… l’écran garde la vue JARVIS : toutes les commandes, période toujours ignorée', x.dernier().length === CMDS.length && x.el('cmdf-btn-periode').textContent === 'Période');
  x.bac.cmdfBasculer('filtres');
  test('… puis clic sur « Filtres » : panneau mémorisé ouvert, période mémorisée INTACTE', lu(x).ouvert === true && lu(x).du === '2026-11-25' && lu(x).au === '2026-11-26', x.stock.mx_cmd_filtres_v1);
  x.bac.cmdfViderPeriode(); x.bac.cmdfTrierPar('livraison');
  test('… deuxième vue JARVIS d’affilée puis tri : toujours la période d’origine', lu(x).du === '2026-11-25' && lu(x).au === '2026-11-26' && lu(x).sens === 'asc', x.stock.mx_cmd_filtres_v1);
  // rechargement de la page (même appareil) : la période revient et filtre de nouveau
  const y = nouveauBac({ commandes: CMDS, stock: { mx_cmd_filtres_v1: x.stock.mx_cmd_filtres_v1 } });
  y.bac.cmdAppliquerFiltres();
  test('rechargement après la vue JARVIS : période RESTAURÉE et appliquée (#3 seule), bouton « Période » allumé', y.dernier().join() === '#3' && y.el('cmdf-btn-periode').classList.contains('on') && y.el('cmdf-btn-periode').textContent !== 'Période', y.dernier());
  // date de prise / livraison changée pendant la vue JARVIS : la période mémorisée reste ENTIÈRE (bornes ET champ de date)
  // v7.5.200 (revue Codex PR 28 sur 62f910d et c825409) : avant, le nouveau champ était enregistré avec les anciennes bornes
  const z = nouveauBac({ commandes: CMDS, stock: { mx_cmd_filtres_v1: MEMO } });
  z.bac.cmdAppliquerFiltres();
  const avantJarvis = z.dernier().join();
  z.bac.cmdfViderPeriode(); z.bac.cmdfChamp('prise');
  test('vue JARVIS puis « Date de prise » : période mémorisée INTACTE, champ compris (25/11 → 26/11 sur la date de livraison)', lu(z).champ === 'livraison' && lu(z).du === '2026-11-25' && lu(z).au === '2026-11-26', z.stock.mx_cmd_filtres_v1);
  z.bac.cmdfTrierPar('livraison'); z.bac.cmdfBasculer('filtres');
  test('… puis tri et « Filtres » : préférences enregistrées, champ mémorisé toujours « livraison »', lu(z).champ === 'livraison' && lu(z).tri === 'livraison' && lu(z).ouvert === true && lu(z).du === '2026-11-25', z.stock.mx_cmd_filtres_v1);
  { // rechargement de la page après ce changement de champ : le choix de période revient À L'IDENTIQUE
    const y2 = nouveauBac({ commandes: CMDS, stock: { mx_cmd_filtres_v1: z.stock.mx_cmd_filtres_v1 } });
    y2.bac.cmdAppliquerFiltres();
    const e2 = y2.bac.cmdfEtatCourant();
    test('rechargement après « Date de prise » dans la vue JARVIS : même choix de période (bornes ET date de livraison), même liste qu’avant la vue (#3)',
      e2.du === '2026-11-25' && e2.au === '2026-11-26' && e2.champ === 'livraison' && avantJarvis === '#3' && y2.dernier().join() === avantJarvis, { e2, liste: y2.dernier(), avantJarvis });
    // sans la correction, les mêmes bornes sur la date de PRISE auraient donné une autre liste (#4) : le test couvre bien le défaut
    const y3 = nouveauBac({ commandes: CMDS, stock: { mx_cmd_filtres_v1: JSON.stringify({ du: '2026-11-25', au: '2026-11-26', champ: 'prise' }) } });
    y3.bac.cmdAppliquerFiltres();
    test('(mêmes bornes sur la date de prise : autre liste, #4 — preuve que le champ compte)', y3.dernier().join() === '#4', y3.dernier());
  }
  { // choix EXPLICITE d'une période dans la vue JARVIS, après avoir changé le champ : bornes et champ de l'écran mémorisés
    const q = nouveauBac({ commandes: CMDS, stock: { mx_cmd_filtres_v1: MEMO } });
    q.bac.cmdAppliquerFiltres(); q.bac.cmdfViderPeriode(); q.bac.cmdfChamp('prise');
    q.el('cmdf-du').value = '2026-11-25'; q.el('cmdf-au').value = '2026-11-26'; q.bac.cmdfPeriodeChange();
    const q2 = nouveauBac({ commandes: CMDS, stock: { mx_cmd_filtres_v1: q.stock.mx_cmd_filtres_v1 } }); q2.bac.cmdAppliquerFiltres();
    test('période choisie à la main après « Date de prise » : bornes ET « prise » mémorisés, restaurés au rechargement (#4)', lu(q).champ === 'prise' && q2.bac.cmdfEtatCourant().champ === 'prise' && q2.dernier().join() === '#4', [q.stock.mx_cmd_filtres_v1, q2.dernier()]);
  }
  // choix EXPLICITE d'une période après la vue JARVIS : c'est lui qui est mémorisé (et gardé par les clics suivants)
  z.el('cmdf-du').value = '2026-11-01'; z.el('cmdf-au').value = ''; z.bac.cmdfPeriodeChange(); z.bac.cmdfTrierPar('prise');
  test('période choisie à la main après la vue JARVIS : nouvelle période mémorisée (depuis 01/11), gardée après un tri', lu(z).du === '2026-11-01' && lu(z).au === '' && lu(z).tri === 'prise', z.stock.mx_cmd_filtres_v1);
  // « Effacer » après la vue JARVIS : choix explicite → période mémorisée vide
  const w = nouveauBac({ commandes: CMDS, stock: { mx_cmd_filtres_v1: MEMO } });
  w.bac.cmdAppliquerFiltres(); w.bac.cmdfViderPeriode(); w.bac.cmdResetFiltres(); w.bac.cmdfTrierPar('prise');
  test('« Effacer » après la vue JARVIS : période mémorisée VIDE (choix explicite), même après un tri', lu(w).du === '' && lu(w).au === '', w.stock.mx_cmd_filtres_v1);
  // mémoire bloquée (navigation privée) : aucune erreur
  const v = nouveauBac({ commandes: CMDS, sansStockage: true });
  let err = null; try { v.bac.cmdfViderPeriode(); v.bac.cmdfTrierPar('livraison'); v.bac.cmdfBasculer('filtres'); } catch (e) { err = e; }
  test('mémoire bloquée : vue JARVIS puis tri et « Filtres » sans erreur', err === null, err);
}

console.log('\n7. STRUCTURE DE LA PAGE');
{
  const page = tranche('<div class="page" id="p-commandes">', '<!-- ─── PAGE TOURNÉES');
  test('un seul bouton « Nouvelle commande » sur la page Commandes : aucun dans la barre de recherche', !/>\+ Nouvelle commande</.test(page) &&!/openNewCmd\(\)/.test(page));
  test('celui du haut de l’écran est gardé (admin et collaboratrice)', (html.match(/topBtn:\{l:'\+ Nouvelle commande',fn:'openNewCmd\(\)'\}/g) || []).length === 2);
  test('UN bouton « Période » et UN bouton « Filtres » dans la barre', (page.match(/id="cmdf-btn-periode"/g) || []).length === 1 && (page.match(/id="cmdf-btn-filtres"/g) || []).length === 1);
  test('panneau Période : Du, Au, date de prise / de livraison', /id="cmdf-du"/.test(page) && /id="cmdf-au"/.test(page) && /data-v="prise"[^>]*>Date de prise</.test(page) && /data-v="livraison"[^>]*>Date de livraison</.test(page));
  test('les 5 listes de filtres sont dans le panneau « Filtres », replié par défaut', (() => { const p = tranche('id="cmd-filtres-panneau"', '<div class="cmdf-total"'); return /^id="cmd-filtres-panneau" style="display:none"/.test(p) && ['transporteur', 'origine', 'ville', 'produit', 'paiement'].every((k) => p.includes('id="cmd-filter-' + k + '"')); })());
  test('boutons rapides gardés (Aujourd’hui, Demain, Cette semaine, En retard, Tout) + « Effacer »', ['today', 'tomorrow', 'week', 'late', 'all'].every((p) => page.includes('data-preset="' + p + '"')) && /onclick="cmdResetFiltres\(\)"[^>]*>🗑 Effacer</.test(page));
  test('les 3 cases de dates/chiffres gardées (cmd-stats-jour)', page.includes('<div id="cmd-stats-jour"'));
  test('ligne du total au-dessus du tableau', page.indexOf('id="cmdf-total"') > 0 && page.indexOf('id="cmdf-total"') < page.indexOf('id="cmd-table-wrap"'));
  test('en-têtes « Date prise » et « À livrer le » cliquables, flèche seulement', /data-tri="prise" onclick="cmdfTrierPar\('prise'\)"[^>]*>📅 Date prise<span class="cmdf-fl"><\/span>/.test(page) && /data-tri="livraison" onclick="cmdfTrierPar\('livraison'\)"[^>]*>🚚 À livrer le<span class="cmdf-fl"><\/span>/.test(page));
  const css = tranche('/* v7.5.190 (Commandes allégée', '\n/* ── Pastilles');
  test('style D : couleurs par variables seulement (mode nuit), aucune couleur en dur', /var\(--carte\)/.test(css) && /var\(--texte\)/.test(css) && !/#[0-9a-fA-F]{3,6}\b|rgba?\(/.test(css), css.slice(0, 200));
  test('téléphone (≤ 600 px) : recherche sur toute la largeur', /@media \(max-width:600px\)\{ \.cmdf-barre \.srch\{flex:1 1 100%\}/.test(css));
  test('mémoire : localStorage protégé par try/catch', /function cmdfLire\(\) \{ try \{/.test(BLOC) && /function cmdfEcrire\(e\) \{ try \{/.test(BLOC));
  test('aucune écriture vers la base dans le bloc', !/fetch\(|sbSave|rpcPin|SUPABASE_URL/.test(BLOC));
}

console.log('\n' + ok + ' réussis, ' + ko + ' en échec');
process.exit(ko ? 1 : 0);
