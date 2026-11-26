// Banc de test « habillage style D » (PR 25, revue Codex sur d9c4e2a) : sélecteur de période segmenté du tableau
// de bord et mode nuit (choix mémorisé sur l'appareil, sinon réglage clair / sombre de l'appareil — décision de Borhen).
// Usage : node outils/test-style-d.js
// Il EXTRAIT le vrai code de maxiconfort-v7.html (fonctions segDashPeriode, segDashSynchro, themeSysteme, themeEstSombre,
// themeMajBouton, themeLireChoix, toggleDarkMode, initDarkMode) et l'exécute dans un bac à sable : aucune connexion,
// aucune donnée réelle, aucun téléchargement.
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'maxiconfort-v7.html'), 'utf8').replace(/\r\n/g, '\n');

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
let ok = 0, ko = 0;
function test(nom, cond, detail) { if (cond) { ok++; console.log('  OK    ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : '')); } }

// ---------- faux navigateur ----------
function classes() { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle(c, v) { const on = v === undefined ? !s.has(c) : !!v; if (on) s.add(c); else s.delete(c); return on; }, liste: () => [...s].sort() }; }
function element(id) { return { id, value: '', innerHTML: '', title: '', attrs: {}, classList: classes(), setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, querySelectorAll() { return []; } }; }
function nouveauBac(opt) {
  const o = opt || {};
  const els = {}; const ecouteurs = []; const stock = Object.assign({}, o.stock || {}); const rendus = [];
  const racine = element('html'); const meta = element('meta');
  const mq = { matches: !!o.systemeSombre, addEventListener(ev, fn) { ecouteurs.push(fn); }, addListener(fn) { ecouteurs.push(fn); } };
  // sélecteur segmenté : 5 boutons data-v comme dans la page
  const seg = element('dash-periode-seg'); const boutons = ['jour', 'semaine', 'mois', 'annee', 'all'].map((v) => { const b = element('b-' + v); b.attrs['data-v'] = v; if (v === 'mois') b.classList.add('on'); return b; });
  seg.querySelectorAll = () => boutons;
  const sel = element('dash-periode'); sel.value = 'mois';
  els['dash-periode'] = sel; els['dash-periode-seg'] = seg;
  const bac = {
    console, Array, JSON, Object, String,
    document: { documentElement: racine, getElementById: (id) => (els[id] = els[id] || element(id)), querySelector: (q) => (/theme-color/.test(q) ? meta : null), addEventListener() {} },
    window: { matchMedia: (q) => (/prefers-color-scheme: dark/.test(q) ? mq : { matches: false }) },
    localStorage: { getItem: (k) => (Object.prototype.hasOwnProperty.call(stock, k) ? stock[k] : null), setItem: (k, v) => { stock[k] = String(v); } },
    renderDash: () => rendus.push(sel.value),
  };
  vm.createContext(bac);
  for (const f of ['function segDashPeriode(v)', 'function segDashSynchro()', 'function themeSysteme()', 'function themeEstSombre()', 'function themeMajBouton()', 'function themeLireChoix()', 'function toggleDarkMode()', 'function initDarkMode()'])
    vm.runInContext(extraireFonction(f), bac);
  return { bac, els, sel, boutons, rendus, stock, racine, meta, mq, ecouteurs };
}
const actifs = (boutons) => boutons.filter((b) => b.classList.contains('on')).map((b) => b.attrs['data-v']);

console.log('\n1. SÉLECTEUR DE PÉRIODE DU TABLEAU DE BORD (segDashPeriode / segDashSynchro)');
{
  const x = nouveauBac();
  test('au départ : « Mois » (valeur d\'origine du menu caché)', x.sel.value === 'mois' && actifs(x.boutons).join() === 'mois');
  x.bac.segDashPeriode('semaine');
  test('clic « Semaine » : le menu d\'origine #dash-periode passe à « semaine »', x.sel.value === 'semaine');
  test('clic « Semaine » : un seul bouton allumé, « Semaine »', actifs(x.boutons).join() === 'semaine', actifs(x.boutons));
  test('clic « Semaine » : le tableau de bord est recalculé avec la nouvelle période', x.rendus.length === 1 && x.rendus[0] === 'semaine', x.rendus);
  for (const v of ['jour', 'annee', 'all']) x.bac.segDashPeriode(v);
  test('Jour, Année puis Tout : chaque changement recalcule, avec la bonne valeur, dans l\'ordre', x.rendus.join() === 'semaine,jour,annee,all', x.rendus);
  test('« Tout » : seul « Tout » est allumé', actifs(x.boutons).join() === 'all');
  x.sel.value = 'jour'; x.bac.segDashSynchro();
  test('menu d\'origine changé ailleurs : la synchronisation rallume le bon bouton (« Jour »)', actifs(x.boutons).join() === 'jour');
  const y = nouveauBac(); delete y.bac.renderDash; y.bac.segDashPeriode('annee');
  test('sans renderDash (page pas encore prête) : pas d\'erreur, valeur posée', y.sel.value === 'annee' && actifs(y.boutons).join() === 'annee');
  // la page lit bien la période dans le menu d'origine
  const coeur = extraireFonction('function _renderDashCore()');
  test('le calcul du tableau de bord lit la période dans #dash-periode (jour, semaine, mois, année, tout)', /getElementById\('dash-periode'\)\?\.value \|\| 'mois'/.test(coeur) && ["'jour'", "'semaine'", "'mois'"].every((v) => coeur.includes('periodeMode === ' + v)));
  const segHtml = (html.match(/<div class="seg-d" id="dash-periode-seg"[\s\S]*?<\/div>/) || [''])[0];
  test('page : 5 boutons Jour / Semaine / Mois / Année / Tout branchés sur segDashPeriode', ['jour', 'semaine', 'mois', 'annee', 'all'].every((v) => segHtml.includes('data-v="' + v + '" ') && segHtml.includes("segDashPeriode('" + v + "')")), segHtml.slice(0, 200));
  const menu = (html.match(/<select id="dash-periode"[\s\S]*?<\/select>/) || [''])[0];
  test('page : le menu d\'origine reste là (caché) avec les mêmes valeurs', /class="seg-d-cache"/.test(menu) && ['jour', 'semaine', 'mois', 'annee', 'all'].every((v) => menu.includes('value="' + v + '"')), menu.slice(0, 200));
}

console.log('\n2. MODE NUIT : CHOIX MÉMORISÉ SUR L\'APPAREIL (mx_theme)');
{
  const x = nouveauBac({ systemeSombre: false });
  x.bac.initDarkMode();
  test('sans choix, appareil en clair : mode jour, aucune classe forcée', !x.bac.themeEstSombre() && x.racine.classList.liste().length === 0, x.racine.classList.liste());
  x.bac.toggleDarkMode();
  test('bouton « nuit » : mode nuit, choix mémorisé « dark »', x.bac.themeEstSombre() && x.stock.mx_theme === 'dark' && x.racine.classList.contains('dark-mode') && !x.racine.classList.contains('light-mode'));
  test('bouton mis à jour : icône soleil, « Passer en mode jour », barre du téléphone sombre', /icd-soleil/.test(x.els['btn-dark-mode'].innerHTML) && x.els['btn-dark-mode'].title === 'Passer en mode jour' && x.meta.attrs.content === '#0f1513');
  x.bac.toggleDarkMode();
  test('second appui : mode jour, choix mémorisé « light »', !x.bac.themeEstSombre() && x.stock.mx_theme === 'light' && x.racine.classList.contains('light-mode'));
  const r = nouveauBac({ stock: { mx_theme: 'dark' }, systemeSombre: false }); r.bac.initDarkMode();
  test('rechargement avec « dark » mémorisé, appareil en clair : le choix l\'emporte (nuit)', r.bac.themeEstSombre() && r.racine.classList.contains('dark-mode'));
  const l = nouveauBac({ stock: { mx_theme: 'light' }, systemeSombre: true }); l.bac.initDarkMode();
  test('rechargement avec « light » mémorisé, appareil en sombre : le choix l\'emporte (jour)', !l.bac.themeEstSombre() && l.racine.classList.contains('light-mode') && /icd-lune/.test(l.els['btn-dark-mode'].innerHTML));
  const e = nouveauBac({ systemeSombre: false }); e.bac.localStorage.setItem = () => { throw new Error('stockage plein'); }; e.bac.initDarkMode(); e.bac.toggleDarkMode();
  test('stockage indisponible : la bascule marche quand même (rien n\'est mémorisé)', e.bac.themeEstSombre());
}

console.log('\n3. MODE NUIT : PRÉFÉRENCE DE L\'APPAREIL (prefers-color-scheme, décision de Borhen)');
{
  const x = nouveauBac({ systemeSombre: true }); x.bac.initDarkMode();
  test('sans choix, appareil en SOMBRE : mode nuit (sans classe forcée), bouton « Passer en mode jour »', x.bac.themeEstSombre() && x.racine.classList.liste().length === 0 && x.els['btn-dark-mode'].title === 'Passer en mode jour');
  test('l\'appli écoute les changements de réglage de l\'appareil (une seule fois)', x.ecouteurs.length === 1 && (x.bac.initDarkMode(), x.ecouteurs.length === 1));
  x.mq.matches = false; x.ecouteurs[0]();
  test('appareil repassé en CLAIR pendant l\'utilisation : bouton et barre suivent (mode jour)', !x.bac.themeEstSombre() && x.els['btn-dark-mode'].title === 'Passer en mode nuit' && x.meta.attrs.content === '#faf7f2');
  x.mq.matches = true; x.ecouteurs[0]();
  test('appareil repassé en SOMBRE : mode nuit de nouveau', x.bac.themeEstSombre() && /icd-soleil/.test(x.els['btn-dark-mode'].innerHTML));
  x.bac.toggleDarkMode();
  test('choix manuel ensuite : il est mémorisé (« light ») et l\'emporte sur l\'appareil sombre', x.stock.mx_theme === 'light' && !x.bac.themeEstSombre());
  const v = nouveauBac(); v.bac.window = {}; v.bac.initDarkMode();
  test('navigateur sans matchMedia : mode jour par défaut, pas d\'erreur', !v.bac.themeEstSombre());
  const css = html.slice(0, html.indexOf('</style>', html.indexOf('id="style-d"')));
  test('feuille de style : réglage sombre de l\'appareil appliqué sauf choix « jour » (:root:not(.light-mode))', /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\.light-mode\)\s*\{/.test(css));
  test('feuille de style : choix « nuit » appliqué même si l\'appareil est en clair (:root.dark-mode)', /:root\.dark-mode\s*\{/.test(css));
  const init = extraireFonction('function initDarkMode()');
  test('plus de passage automatique 20 h - 7 h (aucune lecture de l\'heure)', !/getHours/.test(init) && !/getHours/.test(extraireFonction('function themeEstSombre()')) && !/getHours/.test(extraireFonction('function themeSysteme()')));
  test('initDarkMode est appelée au démarrage de l\'appli', /initDarkMode\(\);/.test(html.replace(extraireFonction('function initDarkMode()'), '')));
}

// ══════════ Revue Codex sur a12696a (v7.5.172) : texte lisible sur les fonds de couleur, de jour comme de nuit ══════════
console.log('\nCONTRASTE DU TEXTE SUR LES FONDS DE COULEUR (mode jour et mode nuit)');
{
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const contraste = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const styleD = html.slice(html.indexOf('id="style-d"'), html.indexOf('</style>', html.indexOf('id="style-d"')));
  const blocJour = styleD.slice(styleD.indexOf(':root{'), styleD.indexOf('@media (prefers-color-scheme: dark)'));
  const blocNuitAppareil = styleD.slice(styleD.indexOf(':root:not(.light-mode){'), styleD.indexOf(':root.dark-mode{'));
  const blocNuitChoisie = styleD.slice(styleD.indexOf(':root.dark-mode{'));
  const jeton = (bloc, nom) => { const m = new RegExp('--' + nom + ':\\s*(#[0-9a-fA-F]{6})').exec(bloc); return m ? m[1].toLowerCase() : null; };
  const paires = [['vert-plein', 'sur-vert'], ['green', 'sur-vert'], ['blue', 'sur-bleu'], ['red', 'sur-rouge'], ['orange', 'sur-orange'], ['violet', 'sur-violet']];
  for (const [nomBloc, bloc] of [['nuit (réglage de l\'appareil)', blocNuitAppareil], ['nuit (choix « nuit »)', blocNuitChoisie]]) {
    const mesures = paires.map(([fond, encre]) => [fond, jeton(bloc, fond), jeton(bloc, encre)]);
    test('mode ' + nomBloc + ' : chaque encre « sur-… » est définie', mesures.every((m) => m[1] && m[2]), mesures);
    test('mode ' + nomBloc + ' : encre lisible sur chaque fond de couleur (contraste ≥ 4,5:1)', mesures.every((m) => m[1] && m[2] && contraste(m[1], m[2]) >= 4.5), mesures.map((m) => m[0] + ' ' + (m[1] && m[2] ? contraste(m[1], m[2]).toFixed(2) : '?')));
    test('mode ' + nomBloc + ' : le BLANC y serait illisible (contraste < 3:1), d\'où la correction', mesures.filter((m) => m[0] !== 'red').every((m) => m[1] && contraste(m[1], '#ffffff') < 3));
  }
  // v7.5.176 (revue Codex PR 25, P2) : paires de JOUR mesurées (ratio WCAG réel), comme la nuit
  test('jeton lu malgré des espaces après les deux-points (expression « \\s* » réelle)', jeton('--green:   #123456;', 'green') === '#123456' && jeton('--green:sss#123456;', 'green') === null);
  { const mesures = paires.map(([fond, encre]) => [fond, jeton(blocJour, fond), jeton(blocJour, encre)]);
    test('mode jour : chaque encre « sur-… » est définie', mesures.every((m) => m[1] && m[2]), mesures);
    test('mode jour : encre lisible sur chaque fond de couleur (contraste ≥ 4,5:1 : boutons .btn-g, succès, export CSV, « Espèces à remettre »…)', mesures.every((m) => m[1] && m[2] && contraste(m[1], m[2]) >= 4.5), mesures.map((m) => m[0] + ' ' + (m[1] && m[2] ? contraste(m[1], m[2]).toFixed(2) : '?')));
    test('mode jour : vert plein + texte blanc ≥ 4,5:1 (avant #2f9e6b : 3,37:1)', jeton(blocJour, 'sur-vert') === '#ffffff' && contraste(jeton(blocJour, 'vert-plein'), '#ffffff') >= 4.5 && contraste(jeton(blocJour, 'green'), '#ffffff') >= 4.5 && contraste(jeton(blocJour, 'teal'), '#ffffff') >= 4.5);
    test('mode jour : l\'ancien vert #2f9e6b n\'est plus la valeur d\'aucun jeton ni d\'aucun style', !/(--[a-z-]+|color|background(?:-color)?)\s*:\s*#2f9e6b/i.test(html));
    test('mode jour : le vert reste lisible comme TEXTE sur les fonds clairs (carte, fond, vert clair : ≥ 4,5:1)', ['carte', 'fond', 'gl'].every((f) => jeton(blocJour, f) && contraste(jeton(blocJour, 'green'), jeton(blocJour, f)) >= 4.5), ['carte', 'fond', 'gl'].map((f) => f + ' ' + (jeton(blocJour, f) ? contraste(jeton(blocJour, 'green'), jeton(blocJour, f)).toFixed(2) : '?')));
    test('calcul WCAG vérifié sur des valeurs connues (noir/blanc 21:1, #2f9e6b/blanc 3,37:1)', Math.abs(contraste('#000000', '#ffffff') - 21) < 0.01 && contraste('#2f9e6b', '#ffffff').toFixed(2) === '3.37');
  }
  const caisse = extraireFonction('function renderLivreurCaisse(t)');
  test('« Ma caisse du jour » : montant positif sur fond vert plein écrit avec l\'encre « sur-vert » (plus de blanc)', /netARemettre > 0 \? 'var\(--vert-plein\)'/.test(caisse) && (caisse.match(/netARemettre > 0 \? 'var\(--sur-vert\)'/g) || []).length === 2 && !/'#fff'/.test(caisse));
  // toute la page : plus de texte blanc dans un style dont le fond est une couleur qui s'éclaircit la nuit
  const restes = [];
  const examiner = (seg) => { const f = seg.match(/background(?:-color)?:\s*var\(--(green|teal|blue|red|orange|violet|vert-plein)\)/g) || [];
    if (f.length && /(^|[;{"\s])color:\s*(#fff\b|#ffffff\b|white\b)/.test(seg)) restes.push(seg.slice(0, 120)); };
  (html.match(/style="[^"]*"/g) || []).forEach(examiner);
  (html.match(/<style[^>]*>[\s\S]*?<\/style>/g) || []).forEach((b) => (b.match(/\{[^{}]*\}/g) || []).forEach(examiner));
  test('page entière : aucun texte blanc sur fond vert / bleu / rouge / orange / violet (styles et feuilles de style)', restes.length === 0, restes);
  const fondJs = /(?:background|cssText)[^\n]{0,200}var\(--(?:green|blue|red|orange|violet)\)[^\n]{0,200}\n?[^\n]{0,200}\? *'#fff'/;
  test('code : plus de « ? \'#fff\' » posé sur un fond de couleur (boutons actifs, réorganisation, catégories de dépense)', !fondJs.test(html));
}

console.log('\n' + ok + ' OK, ' + ko + ' échec(s)');
process.exit(ko ? 1 : 0);
