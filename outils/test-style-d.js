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
// v7.5.170 (PR 27) : périodes lues dans la page (le tableau de bord de la PR 27 n'a plus « Tout » et s'ouvre sur « Jour »)
const SEG_HTML = (html.match(/<div class="seg-d" id="dash-periode-seg"[\s\S]*?<\/div>/) || [''])[0];
const MENU_HTML = (html.match(/<select id="dash-periode"[\s\S]*?<\/select>/) || [''])[0];
const VALEURS = [...SEG_HTML.matchAll(/data-v="([a-z]+)"/g)].map((m) => m[1]);
const DEFAUT = ((MENU_HTML.match(/<option value="([a-z]+)" selected>/) || [])[1]) || VALEURS[0];
function nouveauBac(opt) {
  const o = opt || {};
  const els = {}; const ecouteurs = []; const stock = Object.assign({}, o.stock || {}); const rendus = [];
  const racine = element('html'); const meta = element('meta');
  const mq = { matches: !!o.systemeSombre, addEventListener(ev, fn) { ecouteurs.push(fn); }, addListener(fn) { ecouteurs.push(fn); } };
  // sélecteur segmenté : les boutons data-v de la page (PR 27 : Jour / Semaine / Mois / Année, « Jour » par défaut)
  const seg = element('dash-periode-seg'); const boutons = VALEURS.map((v) => { const b = element('b-' + v); b.attrs['data-v'] = v; if (v === DEFAUT) b.classList.add('on'); return b; });
  seg.querySelectorAll = () => boutons;
  const sel = element('dash-periode'); sel.value = DEFAUT;
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
  test('page : périodes Jour / Semaine / Mois / Année, « Jour » par défaut (PR 27)', VALEURS.join() === 'jour,semaine,mois,annee' && DEFAUT === 'jour', { VALEURS, DEFAUT });
  const x = nouveauBac();
  test('au départ : « Jour » (valeur d\'origine du menu caché), un seul bouton allumé', x.sel.value === 'jour' && actifs(x.boutons).join() === 'jour');
  x.bac.segDashPeriode('semaine');
  test('clic « Semaine » : le menu d\'origine #dash-periode passe à « semaine »', x.sel.value === 'semaine');
  test('clic « Semaine » : un seul bouton allumé, « Semaine »', actifs(x.boutons).join() === 'semaine', actifs(x.boutons));
  test('clic « Semaine » : le tableau de bord est recalculé avec la nouvelle période', x.rendus.length === 1 && x.rendus[0] === 'semaine', x.rendus);
  for (const v of ['mois', 'annee', 'jour']) x.bac.segDashPeriode(v);
  test('Mois, Année puis Jour : chaque changement recalcule, avec la bonne valeur, dans l\'ordre', x.rendus.join() === 'semaine,mois,annee,jour', x.rendus);
  test('« Jour » : seul « Jour » est allumé', actifs(x.boutons).join() === 'jour');
  x.sel.value = 'mois'; x.bac.segDashSynchro();
  test('menu d\'origine changé ailleurs : la synchronisation rallume le bon bouton (« Mois »)', actifs(x.boutons).join() === 'mois');
  const y = nouveauBac(); delete y.bac.renderDash; y.bac.segDashPeriode('annee');
  test('sans renderDash (page pas encore prête) : pas d\'erreur, valeur posée', y.sel.value === 'annee' && actifs(y.boutons).join() === 'annee');
  // la page lit bien la période dans le menu d'origine (tableau de bord de la PR 27 : tdbRendre / tdbCleAffichee, repli « jour »)
  const rendre = extraireFonction('function tdbRendre()'), cleAff = extraireFonction('function tdbCleAffichee()');
  test('le tableau de bord lit la période dans #dash-periode (tdbRendre et tdbCleAffichee, repli « jour »)', [rendre, cleAff].every((f) => /getElementById\('dash-periode'\), mode = \(sel && sel\.value\) \|\| 'jour'/.test(f)));
  test('renderDash redessine le tableau de bord (tdbRendre)', /function renderDash\(\) \{ try \{ tdbRendre\(\);/.test(html));
  test('page : un bouton par période, branché sur segDashPeriode', VALEURS.every((v) => SEG_HTML.includes("segDashPeriode('" + v + "')")), SEG_HTML.slice(0, 200));
  test('page : le menu d\'origine reste là (caché) avec les mêmes valeurs', /class="seg-d-cache"/.test(MENU_HTML) && VALEURS.every((v) => MENU_HTML.includes('value="' + v + '"')), MENU_HTML.slice(0, 200));
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

console.log('\n' + ok + ' OK, ' + ko + ' échec(s)');
process.exit(ko ? 1 : 0);
