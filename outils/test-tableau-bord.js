// Banc de test du TABLEAU DE BORD et des MENUS ALLÉGÉS (v7.5.137, 25/11/2026). Usage : node outils/test-tableau-bord.js
// Exécute le vrai bloc TDB de maxiconfort-v7.html dans un bac à sable : aucune connexion, valeurs fictives seulement.
const fs = require('fs'), path = require('path'), vm = require('vm');
const racine = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(racine, 'maxiconfort-v7.html'), 'utf8').replace(/\r\n/g, '\n');
let ok = 0, ko = 0;
const test = (nom, cond, det) => { if (cond) { ok++; console.log('  OK    ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (det !== undefined ? ' — ' + JSON.stringify(det).slice(0, 300) : '')); } };
const egal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tranche = (debut, fin) => { const i = html.indexOf(debut), j = html.indexOf(fin, i); if (i < 0 || j < 0) throw new Error('introuvable : ' + debut); return html.slice(i, j); };
const fonction = (entete) => { const i = html.indexOf(entete); if (i < 0) throw new Error('introuvable : ' + entete); return html.slice(i, html.indexOf('\n}\n', i) + 2); };

const bac = { console, JSON, Math, Date, Number, String, Object, Array, parseFloat, parseInt, isNaN, zones: [] };
vm.createContext(bac);
vm.runInContext(tranche('// TDB-DEBUT', '// TDB-FIN'), bac);
vm.runInContext(tranche('var ZONES_IDF_DEFAUT = [', '\n];\n') + '\n];\n' + fonction('function getZoneFromAdresse(adresse) {'), bac);
const D = (a, m, j, h) => new Date(a, m - 1, j, h || 12, 0, 0).getTime();

console.log('\n1. PÉRIODES (heure de l’appareil) ET PÉRIODE PRÉCÉDENTE À DATE ÉGALE');
const P = (mode, t) => { const r = bac.tdbPeriodes(mode, t); return [r.du, r.au, r.pdu, r.pau]; };
const mer = D(2026, 11, 25); // mercredi 25/11/2026
test('jour : aujourd’hui vs même jour la semaine dernière', egal(P('jour', mer), ['2026-11-25', '2026-11-25', '2026-11-18', '2026-11-18']));
test('jour : libellé « vs mercredi dernier »', bac.tdbPeriodes('jour', mer).vs === 'vs mercredi dernier');
test('semaine : lundi → dimanche, comparée au lundi → mercredi précédents', egal(P('semaine', mer), ['2026-11-23', '2026-11-29', '2026-11-16', '2026-11-18']));
test('semaine commencée un lundi : 1 jour comparé à 1 jour', egal(P('semaine', D(2026, 11, 23)), ['2026-11-23', '2026-11-29', '2026-11-16', '2026-11-16']));
test('semaine : dimanche (fin de semaine) comparé à la semaine entière', egal(P('semaine', D(2026, 11, 29)), ['2026-11-23', '2026-11-29', '2026-11-16', '2026-11-22']));
test('mois : novembre entier vs 1 → 25 octobre', egal(P('mois', mer), ['2026-11-01', '2026-11-30', '2026-10-01', '2026-10-25']));
test('mois : 31 mars vs février entier (28 jours)', egal(P('mois', D(2026, 3, 31)), ['2026-03-01', '2026-03-31', '2026-02-01', '2026-02-28']));
test('mois : janvier comparé à décembre de l’année d’avant', egal(P('mois', D(2027, 1, 10)), ['2027-01-01', '2027-01-31', '2026-12-01', '2026-12-10']));
test('année : 2026 vs 2025 jusqu’au 25 novembre', egal(P('annee', mer), ['2026-01-01', '2026-12-31', '2025-01-01', '2025-11-25']));
test('année : 29 février comparé au 28 février', egal(P('annee', D(2028, 2, 29)), ['2028-01-01', '2028-12-31', '2027-01-01', '2027-02-28']));
test('23 h 30 : toujours aujourd’hui (jamais l’heure UTC)', bac.tdbPeriodes('jour', D(2026, 11, 25, 23)).du === '2026-11-25' && bac.tdbPeriodes('jour', new Date(2026, 10, 25, 0, 30).getTime()).du === '2026-11-25');
test('mode inconnu → Jour', bac.tdbPeriodes('tout', mer).mode === 'jour');
test('bornes du mois (Top zones) toujours le mois en cours', (() => { const r = bac.tdbPeriodes('annee', mer); return r.moisDu === '2026-11-01' && r.moisAu === '2026-11-30'; })());

console.log('\n2. CHIFFRE D’AFFAIRES, VENTES, ENCAISSÉ, LIVRAISONS');
// format de la base (lecture limitée à la période)
const C = (id, o) => Object.assign({ id, prix: 100, statut: 'en-attente', stpaie: 'Non payé', montant_enc: 0, date_commande: '2026-11-20', date_livraison: '2026-11-25', origine: 'LeBonCoin', adresse: '', livreur: 'RANOU' }, o);
const base = [
  C('#1', { prix: 300, statut: 'livré', stpaie: 'Payé', montant_enc: 300, date_commande: '2026-11-25' }),
  C('#2', { prix: 450.5, statut: 'livré', stpaie: 'Payé', montant_enc: 0 }), // payé sans montant saisi : le prix compte (ancienne règle)
  C('#3', { prix: 200, statut: 'livré', stpaie: 'Partiel', montant_enc: 50, date_commande: '2026-11-25' }), // partiel : pas « encaissé » (ancienne règle)
  C('#4', { prix: 999, statut: 'annulé', date_commande: '2026-11-25' }), // annulée : ni CA, ni vente, ni prévue
  C('#5', { prix: 150, statut: 'en-attente', date_commande: '2026-11-25' }), // prévue, pas livrée ; vente du jour
  C('#SAV12', { prix: 0, statut: 'livré', origine: 'SAV - échange', date_commande: '2026-11-25' }), // SAV : livré (0 €) mais pas une vente
  C('#6', { prix: 80, statut: 'livré', date_commande: '2026-11-26', date_livraison: '2026-11-25' }), // saisie rétroactive : pas une vente
  C('#7', { prix: 500, statut: 'livré', stpaie: 'Payé', montant_enc: 500, date_commande: '2026-11-10', date_livraison: '2026-11-18' }), // mercredi dernier
  C('#8', { prix: 120, statut: 'en-attente', date_commande: '2026-11-18', date_livraison: '' }), // vente de mercredi dernier, pas planifiée
];
const L = base.map(bac.tdbLigne);
const j = bac.tdbChiffres(L, '2026-11-25', '2026-11-25');
test('CA du jour = livrées par date de livraison (300 + 450,50 + 200 + 0 + 80)', j.ca === 1030.5, j);
test('livrées / prévues du jour (annulée exclue)', j.livrees === 5 && j.prevues === 6, j);
test('encaissé = livrées « Payé » (montant encaissé, sinon prix)', j.encaisse === 750.5, j);
test('ventes du jour = prises le jour, hors annulée, SAV et rétroactive', j.ventes === 3 && j.pris === 650, j);
const p = bac.tdbChiffres(L, '2026-11-18', '2026-11-18');
test('période précédente (mercredi dernier)', p.ca === 500 && p.livrees === 1 && p.ventes === 1 && p.pris === 120, p);
test('écart du CA : +106 %', egal(bac.tdbEcart(j.ca, p.ca), { dir: 'hausse', pct: 106 }), bac.tdbEcart(j.ca, p.ca));
test('écart en baisse', egal(bac.tdbEcart(800, 1000), { dir: 'baisse', pct: -20 }));
test('rien avant : « nouveau », jamais +100 % inventé', egal(bac.tdbEcart(500, 0), { dir: 'nouveau', pct: null }) && egal(bac.tdbEcart(0, 0), { dir: 'egal', pct: 0 }));
const m = bac.tdbChiffres(L, '2026-11-01', '2026-11-30');
test('mois : CA = toutes les livrées du mois', m.ca === 1530.5 && m.livrees === 6, m);
test('mois : ventes = 3 du jour + 3 antérieures (#2, #7, #8), hors SAV / rétroactive / annulée', m.ventes === 6, m);
// même règle que les compteurs « commandes prises » de la page Commandes (renderCmdStatsJour)
{
  const src = fonction('async function renderCmdStatsJour() {');
  const iv = src.slice(src.indexOf('  function isVraieCmd(c) {'), src.indexOf('  }\n', src.indexOf('  function isVraieCmd(c) {')) + 4);
  const b2 = {}; vm.createContext(b2); vm.runInContext(iv, b2);
  const commeCompteurs = base.filter((c) => c.statut !== 'annulé').filter(b2.isVraieCmd).filter((c) => (c.origine || '').toUpperCase().indexOf('SAV') !== 0).map((c) => c.id);
  const tdb = L.filter(bac.tdbEstVente).map((l) => l.id);
  test('ventes : exactement les filtres de renderCmdStatsJour (annulées, SAV, rétroactives)', egal(commeCompteurs, tdb), { commeCompteurs, tdb });
}
// format de l'appli (commandes chargées) : mêmes chiffres
{
  const appli = base.map((c) => ({ id: c.id, prix: c.prix, statut: c.statut, stpaie: c.stpaie, montantEnc: c.montant_enc, date: c.date_livraison, dateCmd: c.date_commande, origine: c.origine, adresse: c.adresse, livreur: c.livreur }));
  test('format appli = format base', egal(bac.tdbChiffres(appli.map(bac.tdbLigne), '2026-11-01', '2026-11-30'), m));
}
test('livreurs de la période', egal(bac.tdbLivreurs(L, '2026-11-25', '2026-11-25').map((x) => [x.nom, x.nb]), [['RANOU', 5]]));

console.log('\n3. TOP ZONES DU MOIS (getZoneFromAdresse + zones par défaut)');
bac.zones = bac.ZONES_IDF_DEFAUT;
const Z = [
  C('#z1', { statut: 'livré', prix: 300, adresse: '1 rue A 75011 Paris' }), C('#z2', { statut: 'livré', prix: 400, adresse: '2 rue B 93100 Montreuil' }),
  C('#z3', { statut: 'livré', prix: 350, adresse: '3 rue C 93200 Saint-Denis' }), C('#z4', { statut: 'livré', prix: 900, adresse: '4 rue D 69001 Lyon' }),
  C('#z5', { statut: 'en-attente', prix: 5000, adresse: '5 rue E 92130 Issy' }), C('#z6', { statut: 'livré', prix: 7000, adresse: '6 rue F 94200 Ivry', date_livraison: '2026-10-31' }),
  C('#z7', { statut: 'livré', prix: 60, adresse: 'sans code postal' }),
].map(bac.tdbLigne);
const top = bac.tdbTopZones(Z, '2026-11-01', '2026-11-30', bac.getZoneFromAdresse, 5);
test('classement par CA livré du mois (non livrée et autre mois exclues ; adresse sans département = Province, comme la page Zones)', egal(top.map((z) => [z.nom, z.nb, z.ca]), [['Province', 2, 960], ['Seine-Saint-Denis (93)', 2, 750], ['Paris (75)', 1, 300]]), top);
test('limité à 5 zones', bac.tdbTopZones(Z, '2026-11-01', '2026-11-30', bac.getZoneFromAdresse, 2).length === 2);
test('zone introuvable / fonction en erreur → « Non identifié »', bac.tdbTopZones(Z.slice(0, 1), '2026-11-01', '2026-11-30', () => { throw new Error('x'); }, 5)[0].nom === 'Non identifié');
test('la page Zones et le tableau de bord partagent la même liste', /function renderZoneStats\(\) \{[\s\S]*?var ZONES_IDF = ZONES_IDF_DEFAUT;/.test(html) && /function tdbZoneDe\(adresse\) \{[\s\S]*?getZoneFromAdresse\(adresse\)/.test(html));

console.log('\n4. STOCK');
const prods = [
  { id: 'a', nom: 'Matelas A', cat: 'Matelas', prix: 300, stock: 4, seuil: 2 },
  { id: 'b', nom: 'Matelas B', cat: 'Matelas', prix: 200, stock: 2, seuil: 2 },
  { id: 'c', nom: 'Sommier C', cat: 'Sommier', prix: 150, stock: 0, seuil: 1 },
  { id: 'e', nom: 'Ensemble', cat: 'Ensemble', prix: 450, stock: 0, seuil: 1, composants: [{ id: 'a', qte: 1 }] },
  { id: 's', nom: 'Montage', cat: 'Service', prix: 40, stock: 5, seuil: 0 },
];
const sv = bac.tdbStock(prods, {}, true);
test('ruptures et stock bas (ensembles exclus, comme l’inventaire)', sv.ruptures === 1 && sv.bas === 1, sv);
test('valeur au prix de vente (services et ensembles exclus)', sv.valeurVente === 1600 && sv.base === 'vente', sv);
const sr = bac.tdbStock(prods, { a: { prix_revient_ht: '110.5' } }, true);
test('admin avec prix de revient : valeur au revient + nombre de références connues', sr.base === 'revient' && sr.valeurRevient === 442 && sr.connus === 1 && sr.enStock === 2, sr);
test('collaboratrice : jamais la base « revient »', bac.tdbStock(prods, { a: { prix_revient_ht: 1 } }, false).base === 'vente');

console.log('\n5. AFFICHAGE — ADMIN AVEC MONTANTS, COLLABORATRICE SANS AUCUN MONTANT');
const P0 = bac.tdbPeriodes('jour', mer);
const entree = (admin, stock) => ({ P: P0, admin, cur: j, prev: p, zones: top, livreurs: bac.tdbLivreurs(L, P0.du, P0.au), stock });
const hA = bac.tdbHtml(entree(true, sv)), hR = bac.tdbHtml(entree(true, sr)), hC = bac.tdbHtml(entree(false, sv));
test('admin : CA, pris, encaissé en euros', hA.includes('1 030,50 €') || /1.030,50.€/.test(hA), hA.slice(0, 400));
test('admin : comparaison affichée (+106 % vs mercredi dernier)', /\+106 % <span>vs mercredi dernier/.test(hA));
test('admin : carte Marge sans calcul inventé', hA.includes('Marge') && hA.includes('disponible dès les prix de revient saisis') && /Marge<\/div><div class="tdb-carte-v">—/.test(hA));
test('admin : livraisons livrées / prévues', hA.includes('5 / 6'));
test('admin : valeur « au prix de vente » explicite sans revient', hA.includes('Valeur au prix de vente') && !hA.includes('prix de revient HT'));
test('admin : valeur au prix de revient quand produits_revient est lisible', hR.includes('Valeur au prix de revient HT') && hR.includes('revient connu pour 1 / 2'));
test('admin : Top zones du mois avec lien vers la page Zones', hA.includes('Top zones du mois') && hA.includes("tdbAller('zones')") && hA.includes('Seine-Saint-Denis (93)'));
test('collab : AUCUN signe €', !hC.includes('€'), hC.match(/.{40}€.{10}/));
test('collab : aucun montant (ni CA, ni encaissé, ni valeur, ni marge)', !/1.030|750,5|1.600|Marge|Valeur|Encaissé|Chiffre d/.test(hC));
test('collab : mêmes cartes en nombres (livrées, ventes, livraisons, stock, zones)', hC.includes('Commandes livrées') && hC.includes('5 / 6') && hC.includes('Ruptures') && hC.includes('Top zones du mois') && hC.includes('2 livraisons'));
test('collab : pas de lien vers la page Zones (réservée à l’admin)', !hC.includes("tdbAller('zones')"));
test('noms échappés (zone, livreur)', !bac.tdbHtml(Object.assign(entree(true, sv), { zones: [{ id: 'x', nom: '<img src=x>', couleur: 'red', nb: 1, ca: 1 }] })).includes('<img'));
test('Commandes récentes : colonne Montant pour l’admin seulement', /var A = role === 'admin'[\s\S]*?\(A \? '<th>Montant<\/th>' : ''\)/.test(fonction('function tdbRecentes() {')));
test('lecture de la base : SELECT seulement, limitée à la période, par pages de 1 000', (() => { const f = tranche('async function tdbLire(filtre) {', 'async function tdbCharger'); return /Range/.test(f) && !/method|POST|PATCH|DELETE/.test(f) && f.includes("'/rest/v1/commandes?select='"); })());
test('aucune écriture dans le bloc TDB', !/sbSave|rpcPin|method:\s*'(POST|PATCH|DELETE)'|localStorage\.setItem|\.insert\(|\.update\(/.test(tranche('// TDB-DEBUT', '// TDB-FIN')));

console.log('\n6. MENUS');
const roles = (() => { const b3 = { commandes: [] }; vm.createContext(b3); vm.runInContext(tranche('const ROLES = {', '\nfunction buildUI').replace('const ROLES', 'var ROLES'), b3); return b3.ROLES; })();
const pages = (r) => (r.nav || []).concat(r.plus || []).filter((n) => n.p).map((n) => n.p);
test('admin : 6 entrées principales', egal(roles.admin.nav.map((n) => n.p), ['dashboard', 'commandes', 'tournees', 'stock', 'finance', 'pins']), roles.admin.nav.map((n) => n.l));
test('admin : libellés Tableau de bord, Stock / Arrivages, Réglages', egal(roles.admin.nav.map((n) => n.l), ['Tableau de bord', 'Commandes', 'Tournées', 'Stock / Arrivages', 'Encaissements', 'Réglages']));
test('admin : « Plus » = Suivi, Optimiser, Notifications, Géolocalisation, Camions, Vue livreur, Zones', egal(roles.admin.plus.map((n) => n.p), ['suivi', 'optim', 'notifs', 'gps', 'camion', 'livreur', 'zones']));
test('Santé société retirée du menu, gardée hors menu (JARVIS)', !pages(roles.admin).includes('sante') && roles.admin.cachees.includes('sante') && html.includes('id="p-sante"'));
test('collab : Tableau de bord, Commandes, Tournées, Stock + Plus (Suivi, Optimiser, Notifications)', egal(roles.collab.nav.map((n) => n.p), ['dashboard', 'commandes', 'tournees', 'stock']) && egal(roles.collab.plus.map((n) => n.p), ['suivi', 'optim', 'notifs']));
test('collab : aucune page financière ni réservée à l’admin', !pages(roles.collab).some((x) => ['finance', 'pins', 'sante', 'zones', 'gps', 'arrivages'].includes(x)) && !roles.collab.cachees);
test('collab : garde toutes ses pages d’avant (aucune perdue)', ['dashboard', 'commandes', 'tournees', 'suivi', 'optim', 'notifs', 'stock'].every((x) => pages(roles.collab).includes(x)));
test('livreur : inchangé (Ma tournée, Mon camion)', egal(roles.livreur.nav.map((n) => [n.p, n.l]), [['livreur', 'Ma tournée'], ['camion', 'Mon camion']]) && !roles.livreur.plus);
{
  const jp = (html.match(/var JVUE_PAGES = (\[[^\]]*\]);/) || [])[1]; const liste = JSON.parse(jp.replace(/'/g, '"'));
  const admin = pages(roles.admin).concat(roles.admin.cachees);
  test('JARVIS : chaque page de l’ancre reste joignable par l’admin (menu, « Plus » ou hors menu)', liste.every((x) => admin.includes(x)), liste.filter((x) => !admin.includes(x)));
}
test('« Plus » : vraies entrées .ni[data-p] (trouvées par l’ancre JARVIS même repliées), bouton sans data-p', /function navItemHtml\(n\) \{[\s\S]*?'<div class="ni" data-p="' \+ n\.p/.test(html) && /id="nav-plus-btn" role="button"/.test(html) && !/class="ni ni-plus"[^>]*data-p=/.test(html));
test('« Plus » s’ouvre quand la page affichée y est rangée', html.includes("if(el && el.closest && el.closest('#nav-plus')) navPlusOuvrir(true);"));
test('badge des notifications recopié sur « Plus »', html.includes("document.getElementById('plus-nav-badge')"));
test('Zones : onglet de la page Encaissements, ouvert depuis « Plus »', /function navVers\(p, el\) \{[\s\S]*?goTo\('finance', el\);[\s\S]*?showFinTab\('zones'/.test(html));

console.log('\n7. CODE MORT RETIRÉ, CODE UTILE GARDÉ');
test('renderDashCanaux retiré (jamais appelé : #dash-canaux-section n’existait pas)', !/renderDashCanaux|dash-canaux-section|dash-canal-periode/.test(html));
test('carte « Statuts du jour » aux chiffres figés retirée', !html.includes('Statuts du jour') && !html.includes('_renderDashCore'));
test('doublon showFinanceTab retiré, showFinTab gardé', !html.includes('showFinanceTab') && html.includes('function showFinTab(tab, el)'));
test('analyse par canal (renderCanauxVente) gardée, repliée, admin seulement', html.includes('function renderCanauxVente()') && /<details class="tdb-canaux" id="tdb-canaux"/.test(html) && /d\.style\.display = role === 'admin' \? '' : 'none'/.test(html));
test('sélecteur Jour / Semaine / Mois / Année (sans « Tout »)', /id="dash-periode-seg"[^\n]*data-v="jour"[^\n]*data-v="semaine"[^\n]*data-v="mois"[^\n]*data-v="annee"/.test(html) && !/segDashPeriode\('all'\)/.test(html));
test('id de page conservé pour JARVIS (p-dashboard)', html.includes('<div class="page on" id="p-dashboard">'));

console.log('\n8. MISE EN LIGNE');
test('CACHE_VERSION augmentée (v7-5-139 ou plus)', (() => { const m2 = /CACHE_VERSION = 'maxiconfort-v7-5-(\d+)'/.exec(fs.readFileSync(path.join(racine, 'service-worker.js'), 'utf8')); return m2 && Number(m2[1]) >= 139; })());
console.log('\n' + ok + ' OK, ' + ko + ' échec(s)'); process.exit(ko ? 1 : 0);
