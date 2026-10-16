// Banc de test de la navigation du livreur entre ses tournées (v7.5.120, 16/10/2026).
// Usage : node outils/test-vue-livreur.js
// Il EXTRAIT le vrai code de maxiconfort-v7.html (bloc NAVLV-DEBUT … NAVLV-FIN) et l'exécute
// dans un bac à sable : aucune connexion, aucune donnée réelle.
//
// Demande de Borhen : le livreur doit pouvoir voir la tournée SUIVANTE ; s'il n'y a rien
// le lendemain, la flèche doit l'emmener à la prochaine journée qui existe.
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(process.env.MX_HTML || path.join(__dirname, '..', 'maxiconfort-v7.html'), 'utf8');
function blocNav() {
  const i = html.indexOf('NAVLV-DEBUT'); if (i < 0) throw new Error('marqueur NAVLV-DEBUT introuvable');
  const debut = html.lastIndexOf('\n', i) + 1;
  const fin = html.indexOf('// NAVLV-FIN', i); if (fin < 0) throw new Error('marqueur NAVLV-FIN introuvable');
  return html.slice(debut, fin + '// NAVLV-FIN'.length);
}

const AUJ = '2026-10-16'; // vendredi
function jour(n) { const d = new Date(AUJ + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

function nouveauBac() {
  const elements = {};
  const el = () => ({ style: {}, innerHTML: '', textContent: '', disabled: false });
  for (const id of ['lv-nav-tournees', 'lv-nav-label', 'lv-nav-prec', 'lv-nav-suiv']) elements[id] = el();
  const bac = {
    console, Math, Date, JSON, String, Number, Array, Object, parseInt, isNaN,
    document: { getElementById: id => elements[id] || null },
    fmtDate: d => d, currentLvTourneeId: null, renderLivreur() { bac._rendus = (bac._rendus || 0) + 1; },
    _elements: elements,
  };
  vm.createContext(bac);
  vm.runInContext(blocNav(), bac);
  return bac;
}
const tournee = (id, date, nbStops = 3, statut = 'préparée') => ({ id, date, statut, livreur: 'RANOU', stops: Array.from({ length: nbStops }, (_, i) => ({ cmdId: '#' + id + i, statut: 'en-attente' })) });

let ok = 0, ko = 0;
const test = (nom, cond, det) => { if (cond) { ok++; console.log('  OK    ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (det !== undefined ? ' — ' + JSON.stringify(det) : '')); } };

console.log('\n1. LISTE NAVIGABLE : AUJOURD\'HUI + LES JOURNÉES SUIVANTES');
let bac = nouveauBac();
let mes = [tournee('T-1', AUJ), tournee('T-2', jour(1)), tournee('T-3', jour(4))];
let liste = bac.lvListeNav(mes, mes[0], AUJ);
test('les 3 journées sont navigables', liste.length === 3);
test('elles sont dans l\'ordre des dates', liste.map(t => t.id).join(',') === 'T-1,T-2,T-3', liste.map(t => t.id));

console.log('\n2. RIEN DEMAIN : LA FLÈCHE SAUTE AU JOUR SUIVANT QUI EXISTE (demande Borhen)');
bac = nouveauBac();
mes = [tournee('T-1', AUJ), tournee('T-9', jour(5))]; // demain et les 4 jours suivants : vides
bac.LV_NAV = bac.lvListeNav(mes, mes[0], AUJ);
bac.currentLvTourneeId = 'T-1';
bac.lvNaviguerTournee(1);
test('on arrive directement sur la journée du ' + jour(5), bac.currentLvTourneeId === 'T-9', bac.currentLvTourneeId);
test('c\'est bien marqué comme un aperçu choisi à la main', bac.LV_APERCU_ID === 'T-9');

console.log('\n3. ALLER-RETOUR ET BUTÉES');
bac = nouveauBac();
mes = [tournee('T-1', AUJ), tournee('T-2', jour(1)), tournee('T-3', jour(2))];
bac.LV_NAV = bac.lvListeNav(mes, mes[0], AUJ); bac.currentLvTourneeId = 'T-1';
bac.lvNaviguerTournee(1); bac.lvNaviguerTournee(1);
test('deux fois « suivante » : on est sur la 3e journée', bac.currentLvTourneeId === 'T-3');
bac.lvNaviguerTournee(1);
test('au bout, « suivante » ne fait rien', bac.currentLvTourneeId === 'T-3');
bac.lvNaviguerTournee(-1); bac.lvNaviguerTournee(-1);
test('retour sur la tournée du jour', bac.currentLvTourneeId === 'T-1');
bac.lvNaviguerTournee(-1);
test('avant la tournée du jour, « précédente » ne fait rien', bac.currentLvTourneeId === 'T-1');

console.log('\n4. CE QU\'IL NE DOIT PAS VOIR');
bac = nouveauBac();
mes = [tournee('T-0', jour(-3)), tournee('T-1', AUJ), tournee('T-2', jour(1)), tournee('T-F', jour(2), 3, 'terminée')];
liste = bac.lvListeNav(mes, mes[1], AUJ);
test('les journées passées ne sont pas proposées', !liste.some(t => t.id === 'T-0'), liste.map(t => t.id));
test('une tournée déjà terminée n\'est pas proposée', !liste.some(t => t.id === 'T-F'));
// tournée en retard affichée : elle doit rester accessible
bac = nouveauBac();
mes = [tournee('T-R', jour(-1)), tournee('T-2', jour(1))];
liste = bac.lvListeNav(mes, mes[0], AUJ);
test('une tournée en retard affichée reste accessible', liste.some(t => t.id === 'T-R') && liste.length === 2, liste.map(t => t.id));

console.log('\n5. LIBELLÉS ET BARRE');
bac = nouveauBac();
test('la journée du jour est annoncée AUJOURD\'HUI', bac.lvLibelleNav(tournee('T-1', AUJ), AUJ).includes('AUJOURD\'HUI'));
test('le lendemain est annoncé DEMAIN', bac.lvLibelleNav(tournee('T-2', jour(1)), AUJ).includes('DEMAIN'));
test('le nombre de clients est affiché', bac.lvLibelleNav(tournee('T-3', jour(3), 4), AUJ).includes('4 client'));
test('une tournée en retard est signalée', bac.lvLibelleNav(tournee('T-R', jour(-1)), AUJ).includes('EN RETARD'));
// barre masquée quand il n'y a qu'une seule journée
bac = nouveauBac(); mes = [tournee('T-1', AUJ)];
bac.LV_NAV = bac.lvListeNav(mes, mes[0], AUJ); bac.currentLvTourneeId = 'T-1';
bac.lvRendreNav(AUJ, mes[0]);
test('une seule journée : pas de barre de navigation', bac._elements['lv-nav-tournees'].style.display === 'none');
// barre visible + repère aperçu
bac = nouveauBac(); mes = [tournee('T-1', AUJ), tournee('T-2', jour(1))];
bac.LV_NAV = bac.lvListeNav(mes, mes[0], AUJ); bac.currentLvTourneeId = 'T-1';
bac.lvRendreNav(AUJ, mes[0]);
test('deux journées : la barre s\'affiche', bac._elements['lv-nav-tournees'].style.display === 'flex');
test('sur sa journée, pas de mention APERÇU', !bac._elements['lv-nav-label'].innerHTML.includes('APERÇU'));
test('flèche « précédente » désactivée sur la 1re journée', bac._elements['lv-nav-prec'].disabled === true);
bac.currentLvTourneeId = 'T-2'; bac.lvRendreNav(AUJ, mes[0]);
test('sur une autre journée : mention APERÇU', bac._elements['lv-nav-label'].innerHTML.includes('APERÇU'));
test('flèche « suivante » désactivée sur la dernière', bac._elements['lv-nav-suiv'].disabled === true);

console.log('\n' + ok + ' OK, ' + ko + ' échec(s)');
process.exit(ko ? 1 : 0);
