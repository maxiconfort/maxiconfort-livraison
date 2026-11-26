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
// revue Codex PR 27 sur c33c8b3 : services écartés AVANT les alertes (service à stock nul, service sous son seuil), et jamais valorisés
const prodsS = prods.concat([
  { id: 's0', nom: 'Livraison étage (fictif)', cat: 'Service', prix: 30, stock: 0, seuil: 1 },
  { id: 's1', nom: 'Reprise ancien matelas (fictif)', cat: 'Service', prix: 25, stock: 1, seuil: 3 },
]);
const svS = bac.tdbStock(prodsS, {}, true);
test('service à stock nul : pas compté en rupture', svS.ruptures === 1, svS);
test('service sous son seuil : pas compté en stock bas', svS.bas === 1, svS);
test('services : valeur du stock inchangée (prix de vente)', svS.valeurVente === 1600 && svS.base === 'vente', svS);
const srS = bac.tdbStock(prodsS, { a: { prix_revient_ht: '110.5' }, s1: { prix_revient_ht: '10' }, s: { prix_revient_ht: '5' } }, true);
test('services : jamais valorisés au revient ni comptés en stock', srS.valeurRevient === 442 && srS.connus === 1 && srS.enStock === 2, srS);
test('seuls les services : aucune alerte, valeur nulle', (() => { const x = bac.tdbStock(prodsS.filter((q) => q.cat === 'Service'), {}, true); return x.ruptures === 0 && x.bas === 0 && x.valeurVente === 0 && x.enStock === 0; })());
test('services écartés AVANT le comptage des alertes (dans le filtre initial)', /var phys = \(liste \|\| \[\]\)\.filter\(function \(p\) \{ return !!p && !\(Array\.isArray\(p\.composants\) && p\.composants\.length\) && p\.cat !== 'Service'; \}\);/.test(html));

console.log('\n5. AFFICHAGE — ADMIN AVEC MONTANTS, COLLABORATRICE SANS AUCUN MONTANT');
const P0 = bac.tdbPeriodes('jour', mer);
const entree = (admin, stock) => ({ P: P0, admin, cur: j, prev: p, zones: top, livreurs: bac.tdbLivreurs(L, P0.du, P0.au), stock });
const hA = bac.tdbHtml(entree(true, sv)), hR = bac.tdbHtml(entree(true, sr)), hC = bac.tdbHtml(entree(false, sv));
test('admin : CA, pris, encaissé en euros', hA.includes('1 030,50 €') || /1.030,50.€/.test(hA), hA.slice(0, 400));
test('admin : comparaison affichée (+106 % vs mercredi dernier)', /\+106 % <span>vs mercredi dernier/.test(hA));
test('admin : carte Marge sans calcul inventé', hA.includes('Marge') && hA.includes('disponible dès les prix de revient saisis') && /Marge<\/div><div class="tdb-carte-v">—/.test(hA));
test('admin : livraisons livrées / prévues', hA.includes('5 / 6'));
test('admin : valeur « au prix de vente » explicite sans revient', hA.includes('Valeur au prix de vente') && !hA.includes('prix de revient HT'));
test('admin : valeur au prix de revient quand produits_revient est lisible (1 référence sur 2 : PARTIELLE, dit explicitement)', hR.includes('Valeur au prix de revient HT, partielle (1 référence sur 2)') && hR.includes('revient inconnu pour 1 référence en stock, non comptée'));
{ // v7.5.154 (revue Codex PR 27 sur aa07e1e) : valeur au revient partielle affichée comme telle ; complète = libellé normal
  const sP = bac.tdbStock([{ id: 'a', cat: 'Matelas', prix: 10, stock: 2, seuil: 1 }, { id: 'b', cat: 'Matelas', prix: 10, stock: 3, seuil: 1 }, { id: 'c', cat: 'Sommier', prix: 10, stock: 1, seuil: 0 }], { a: { prix_revient_ht: '4' } }, true);
  test('tdbStock : revient connu pour 1 référence sur 3 en stock → partielle', sP.base === 'revient' && sP.partielle === true && sP.connus === 1 && sP.enStock === 3 && sP.valeurRevient === 8, sP);
  const hP = bac.tdbHtml(entree(true, sP));
  test('affichage : « Valeur au prix de revient HT, partielle (1 référence sur 3) », 2 références non comptées', hP.includes('Valeur au prix de revient HT, partielle (1 référence sur 3)') && hP.includes('revient inconnu pour 2 références en stock, non comptées'), hP.match(/Valeur au prix de revient[^<]*/));
  const sC = bac.tdbStock([{ id: 'a', cat: 'Matelas', prix: 10, stock: 2, seuil: 1 }, { id: 'z', cat: 'Matelas', prix: 10, stock: 0, seuil: 1 }], { a: { prix_revient_ht: '4' } }, true);
  const hC2 = bac.tdbHtml(entree(true, sC));
  test('revient connu pour toutes les références en stock → valeur complète, sans mention « partielle »', sC.partielle === false && hC2.includes('Valeur au prix de revient HT<small>revient connu pour 1 / 1 référence en stock') && !hC2.includes('partielle'));
  const hCol = bac.tdbHtml(entree(false, sP));
  test('collaboratrice : jamais la valeur au revient, partielle ou non (aucun montant, aucune mention)', !/revient|partielle|Valeur|€/.test(hCol));
  test('collaboratrice : tdbStock ne passe jamais en base « revient »', bac.tdbStock([{ id: 'a', cat: 'Matelas', prix: 10, stock: 2 }], { a: { prix_revient_ht: '4' } }, false).base === 'vente');
}
test('admin : Top zones du mois avec lien vers la page Zones', hA.includes('Top zones du mois') && hA.includes("tdbAller('zones')") && hA.includes('Seine-Saint-Denis (93)'));
test('collab : AUCUN signe €', !hC.includes('€'), hC.match(/.{40}€.{10}/));
test('collab : aucun montant (ni CA, ni encaissé, ni valeur, ni marge)', !/1.030|750,5|1.600|Marge|Valeur|Encaissé|Chiffre d/.test(hC));
test('collab : mêmes cartes en nombres (livrées, ventes, livraisons, stock, zones)', hC.includes('Commandes livrées') && hC.includes('5 / 6') && hC.includes('Ruptures') && hC.includes('Top zones du mois') && hC.includes('2 livraisons'));
test('collab : pas de lien vers la page Zones (réservée à l’admin)', !hC.includes("tdbAller('zones')"));
test('noms échappés (zone, livreur)', !bac.tdbHtml(Object.assign(entree(true, sv), { zones: [{ id: 'x', nom: '<img src=x>', couleur: 'red', nb: 1, ca: 1 }] })).includes('<img'));
test('bloc « Paiements — mois » retiré du tableau de bord (et sa fonction, sans autre appelant)', !/dash-paiements|paiRenderDash|paiOuvrirFiltre/.test(html));
test('admin : carte Encaissé cliquable → page Encaissements', /tdb-carte tdb-lien" role="link"[^>]*onclick="tdbAller\('finance'\)"[^>]*><div class="tdb-carte-l">Encaissé/.test(hA), hA.match(/.{80}Encaissé.{20}/));
test('collab : aucune carte vers Encaissements', !hC.includes("tdbAller('finance')"));
test('Commandes récentes : colonne Montant pour l’admin seulement', /var A = role === 'admin'[\s\S]*?\(A \? '<th>Montant<\/th>' : ''\)/.test(fonction('function tdbRecentes() {')));
test('lecture de la base : SELECT seulement, limitée à la période, par pages de 1 000 (clé : id croissant, après le dernier reçu)', (() => { const f = tranche('async function tdbLire(filtre) {', 'async function tdbCharger'); return f.includes("'&id=gt.' + encodeURIComponent(dernier)") && f.includes("'&order=id.asc&limit=' + TDB_PAGE") && /var TDB_PAGE = 1000;/.test(html) && !/Range|offset/.test(f) && !/method|POST|PATCH|DELETE/.test(f) && f.includes("'/rest/v1/commandes?select='"); })());
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
test('« Plus » ouvert seulement si la page affichée y est rangée, refermé sinon (v7.5.138)', html.includes("navPlusOuvrir(!!(el && el.closest && el.closest('#nav-plus')));") && !html.includes('navPlusOuvrir(true)') && !html.includes('mx_nav_plus'));
{ // le vrai goTo : « Plus » suit la page affichée
  const g = fonction('function goTo(p, el) {'); const appels = [];
  const ni = (dansPlus) => ({ classList: { add() {} }, getAttribute: () => null, closest: (s) => (s === '#nav-plus' && dansPlus ? {} : null) });
  const doc = { querySelectorAll: () => [], getElementById: () => ({ classList: { add() {}, remove() {} } }), querySelector: () => null };
  const bg = { document: doc, role: 'admin', NAV_PARENT: {}, closeSidebarMobile() {}, renderCmds() {}, suiviInit() {}, santeRender() {}, navPlusOuvrir: (o) => appels.push(o), showFinTab() {} };
  vm.createContext(bg); vm.runInContext(g, bg);
  bg.goTo('suivi', ni(true)); bg.goTo('commandes', ni(false)); bg.goTo('sante', null);
  test('goTo : page de « Plus » → ouvert ; page principale → refermé ; page hors menu → refermé', egal(appels, [true, false, false]), appels);
}
test('badge des notifications recopié sur « Plus »', html.includes("document.getElementById('plus-nav-badge')"));
test('Zones : onglet de la page Encaissements, ouvert depuis « Plus »', /function navVers\(p, el\) \{[\s\S]*?goTo\('finance', el\);[\s\S]*?showFinTab\('zones'/.test(html));

console.log('\n7. CODE MORT RETIRÉ, CODE UTILE GARDÉ');
test('renderDashCanaux retiré (jamais appelé : #dash-canaux-section n’existait pas)', !/renderDashCanaux|dash-canaux-section|dash-canal-periode/.test(html));
test('carte « Statuts du jour » aux chiffres figés retirée', !html.includes('Statuts du jour') && !html.includes('_renderDashCore'));
test('doublon showFinanceTab retiré, showFinTab gardé', !html.includes('showFinanceTab') && html.includes('function showFinTab(tab, el)'));
test('analyse par canal (renderCanauxVente) gardée, repliée, admin seulement', html.includes('function renderCanauxVente()') && /<details class="tdb-canaux" id="tdb-canaux"/.test(html) && /d\.style\.display = role === 'admin' \? '' : 'none'/.test(html));
test('sélecteur Jour / Semaine / Mois / Année (sans « Tout »)', /id="dash-periode-seg"[^\n]*data-v="jour"[^\n]*data-v="semaine"[^\n]*data-v="mois"[^\n]*data-v="annee"/.test(html) && !/segDashPeriode\('all'\)/.test(html));
test('id de page conservé pour JARVIS (p-dashboard)', html.includes('<div class="page on" id="p-dashboard">'));

console.log('\n7 bis. FRAÎCHEUR DES CHIFFRES (revue Codex de b425c03)');
(async () => {
  // bac à sable : vraie lecture par période (tdbCharger / tdbRendre) avec une fausse base et de faux minuteurs
  const minuteurs = []; let rendus = 0, lectures = 0; const enAttente = [];
  const pageOn = { on: true };
  const elContenu = { innerHTML: '' };
  const b4 = { console, JSON, Math, Date, Number, String, Object, Array, parseFloat, parseInt, isNaN, Promise, zones: [],
    role: 'admin', commandes: [{ id: '#1' }], cmdTotalCount: 5000, produits: [], SUPABASE_URL: 'https://x.invalid', SUPABASE_KEY: 'k',
    setTimeout: (f, ms) => { minuteurs.push({ f, ms }); return minuteurs.length; }, clearTimeout: () => {},
    renderDash: () => { rendus++; }, getZoneFromAdresse: () => null, arrChargerRevients: () => Promise.resolve(),
    document: { getElementById: (id) => (id === 'tdb-contenu' ? elContenu : id === 'p-dashboard' ? { classList: { contains: () => pageOn.on } } : id === 'dash-periode' ? { value: 'mois' } : null) },
    fetch: () => { lectures++; return new Promise((ok) => { enAttente.push(() => ok({ ok: true, json: async () => [] })); }); } };
  vm.createContext(b4); vm.runInContext(tranche('// TDB-DEBUT', '// TDB-FIN'), b4);
  const attendre = () => new Promise((r) => setImmediate(r));
  b4.tdbRendre(); // base incomplète → lecture par période (3 requêtes)
  const n1 = lectures;
  b4.tdbSignaler('commandes'); // une commande change PENDANT la lecture
  enAttente.splice(0).forEach((l) => l()); await attendre(); await attendre(); await attendre();
  test('lecture par période lancée (base non chargée en entier ; Mois = 2 requêtes)', n1 === 2, n1);
  test('commande changée pendant la lecture : résultat périmé, relecture relancée aussitôt', b4.TDB_ETAT.gen === 1 && b4.TDB_ETAT.at === 0 && lectures === 4, [b4.TDB_ETAT.at, lectures]);
  for (let k = 0; k < 10 && enAttente.length; k++) { enAttente.splice(0).forEach((l) => l()); await attendre(); await attendre(); }
  await attendre();
  test('lecture terminée sans changement : gardée (at posé)', b4.TDB_ETAT.at > 0);
  const l2 = lectures; minuteurs.length = 0; b4.tdbRendre();
  test('lecture fraîche : pas de nouvelle requête', lectures === l2);
  const exp = minuteurs.filter((m) => m.ms > 50000);
  test('relecture programmée à l’expiration (≈ 60 s)', exp.length === 1 && exp[0].ms <= 60200, minuteurs.map((m) => m.ms));
  b4.TDB_ETAT.at = Date.now() - 61000; exp[0].f();
  test('à l’expiration, tableau affiché : nouvelle lecture', lectures > l2, [l2, lectures]);
  for (let k = 0; k < 10 && enAttente.length; k++) { enAttente.splice(0).forEach((l) => l()); await attendre(); await attendre(); }
  minuteurs.length = 0; b4.tdbSignaler('commandes');
  test('signal « commandes » : cache périmé (at = 0)', b4.TDB_ETAT.at === 0);
  const sig = minuteurs.find((m) => m.ms === 800); rendus = 0; sig.f();
  test('signal : tableau affiché redessiné une fois (regroupé)', rendus === 1);
  pageOn.on = false; rendus = 0; b4.tdbSignaler('produits'); minuteurs[minuteurs.length - 1].f();
  test('signal : tableau non affiché → rien (recalculé à l’ouverture)', rendus === 0);
  b4.TDB_ETAT.revientsDemandes = true; b4.tdbSignaler('revients');
  test('signal « revients » : prix de revient relus au prochain rendu', b4.TDB_ETAT.revientsDemandes === false);
  // branchements dans l'appli
  const f = (e) => fonction(e);
  test('sauvegarde locale d’une commande → signal', /tdbSignaler\('commandes'\)[^\n]*\n\}$/.test(f('async function sbSaveCommande(cmd) {')));
  test('temps réel commandes → signal', /table:'commandes'\}, function\(payload\) \{[\s\S]*?tdbSignaler\('commandes'\)[\s\S]*?renderDash\(\); renderCmds\(\)/.test(html));
  test('relève périodique (polling) → signal', /if \(updated\) \{\n\s*if \(typeof tdbSignaler === 'function'\) tdbSignaler\('commandes'\);/.test(f('function startPolling() {')));
  test('ajustement de stock → signal produits', f('function sauvegarderAjustement() {').includes("tdbSignaler('produits')"));
  test('chargement des produits → signal produits', f('async function sbLoadProduits() {').includes("tdbSignaler('produits')"));
  test('temps réel produits → signal produits', /table:'produits'\}, function\(payload\) \{[\s\S]*?tdbSignaler\('produits'\)[\s\S]*?\.subscribe\(\);/.test(html));
  test('réception d’arrivage → produits relus + revient relu', /await sbLoadProduits\(\); \} catch\(e\) \{\}\n\s*if \(typeof tdbSignaler === 'function'\) tdbSignaler\('revients'\);/.test(f('async function arrValider() {')));
  test('ouverture de la page Tableau de bord → recalcul', f('function goTo(p, el) {').includes("if(p==='dashboard') renderDash();"));
  console.log('\n7 ter. REVUE CODEX DE 8705c41 (date égale, lectures concurrentes, pagination, classements de la collaboratrice)');
  { // 1. comparaison à date égale : rien après aujourd'hui dans les chiffres comparés
    const Ps = bac.tdbPeriodes('semaine', mer), Pm = bac.tdbPeriodes('mois', mer), Pa = bac.tdbPeriodes('annee', mer);
    test('période en cours comparée jusqu’à aujourd’hui (cau = aujourd’hui ; fin de période gardée pour les prévues)', Ps.cau === '2026-11-25' && Pm.cau === '2026-11-25' && Pa.cau === '2026-11-25' && Ps.au === '2026-11-29');
    const fut = base.concat([
      C('#f1', { prix: 999, statut: 'en-attente', date_commande: '2026-11-27', date_livraison: '2026-11-28' }), // commande saisie à l'avance (date future)
      C('#f2', { prix: 700, statut: 'livré', stpaie: 'Payé', montant_enc: 700, date_commande: '2026-11-20', date_livraison: '2026-11-27' }), // livraison datée dans le futur
      C('#f3', { prix: 60, statut: 'en-attente', date_commande: '2026-11-24', date_livraison: '2026-11-28' }), // prise cette semaine, livraison samedi
    ]).map(bac.tdbLigne);
    for (const [nom, P, pris, nb] of [['semaine', Ps, 60, 1], ['mois', Pm, 760, 2], ['année', Pa, 760, 2]]) { // prises avant aujourd'hui : #f3 (et #f2, prise le 20/11) ; #f1 (27/11) jamais
      const d = bac.tdbDonnees(fut, P, true, () => null), sans = bac.tdbDonnees(L, P, true, () => null);
      test(nom + ' : commande future exclue de « pris » et des ventes', d.cur.pris === sans.cur.pris + pris && d.cur.ventes === sans.cur.ventes + nb, [d.cur, sans.cur]);
      test(nom + ' : livraison datée du futur exclue du CA, des livrées et de l’encaissé', d.cur.ca === sans.cur.ca && d.cur.livrees === sans.cur.livrees && d.cur.encaisse === sans.cur.encaisse, d.cur);
      test(nom + ' : prévues comptées sur la période entière (jusqu’à sa fin)', d.cur.prevuesPeriode === sans.cur.prevuesPeriode + 3 && d.cur.prevues === sans.cur.prevues, d.cur);
    }
    const ds = bac.tdbDonnees(fut, Ps, true, () => null);
    const hS = bac.tdbHtml(Object.assign({ P: Ps, admin: true, stock: sv }, ds));
    test('affichage : livrées / prévues de la période entière, CA à date égale', hS.includes(ds.cur.livrees + ' / ' + ds.cur.prevuesPeriode) && hS.includes(bac.tdbEur(ds.cur.ca)) && ds.cur.ca === bac.tdbDonnees(L, Ps, true, () => null).cur.ca, ds.cur);
    test('top zones et livreurs : rien après aujourd’hui', bac.tdbDonnees(fut, Pm, true, () => null).zones.reduce((s, z) => s + z.nb, 0) === bac.tdbDonnees(L, Pm, true, () => null).zones.reduce((s, z) => s + z.nb, 0) && ds.livreurs.reduce((s, l) => s + l.nb, 0) === bac.tdbDonnees(L, Ps, true, () => null).livreurs.reduce((s, l) => s + l.nb, 0));
  }
  { // 5. collaboratrice : classements par NOMBRE, jamais par CA
    const Zc = [
      C('#c1', { statut: 'livré', prix: 5000, adresse: '1 rue A 75011 Paris', livreur: 'ZED' }),
      C('#c2', { statut: 'livré', prix: 100, adresse: '2 rue B 93100 Montreuil', livreur: 'ZED' }), C('#c3', { statut: 'livré', prix: 100, adresse: '3 rue C 93200 Saint-Denis', livreur: 'ALI' }),
      C('#c4', { statut: 'livré', prix: 100, adresse: '4 rue D 93300 Aubervilliers', livreur: 'ALI' }),
      C('#c5', { statut: 'livré', prix: 50, adresse: '5 rue E 92130 Issy' }), C('#c6', { statut: 'livré', prix: 50, adresse: '6 rue F 92100 Boulogne' }),
    ].map(bac.tdbLigne);
    const za = bac.tdbTopZones(Zc, '2026-11-01', '2026-11-30', bac.getZoneFromAdresse, 2), zc = bac.tdbTopZones(Zc, '2026-11-01', '2026-11-30', bac.getZoneFromAdresse, 2, true);
    test('admin : top 2 par CA (Paris, 1 livraison à 5 000 €, d’abord)', egal(za.map((z) => z.nom), ['Paris (75)', 'Seine-Saint-Denis (93)']), za);
    test('collab : top 2 par NOMBRE (93 : 3, 92 : 2 ; Paris écarté)', egal(zc.map((z) => [z.nom, z.nb]), [['Seine-Saint-Denis (93)', 3], ['Hauts-de-Seine (92)', 2]]), zc);
    test('collab : aucun montant dans les zones (champ ca absent)', zc.every((z) => !('ca' in z)));
    const la = bac.tdbLivreurs(Zc.slice(0, 4), '2026-11-01', '2026-11-30'), lc = bac.tdbLivreurs(Zc.slice(0, 4), '2026-11-01', '2026-11-30', true);
    test('livreurs à égalité : admin départagé par CA (ZED), collab par nom (ALI)', egal(la.map((l) => l.nom), ['ZED', 'ALI']) && egal(lc.map((l) => l.nom), ['ALI', 'ZED']), [la, lc]);
    test('collab : aucun montant chez les livreurs (champ ca absent)', lc.every((l) => !('ca' in l)));
    const Pm2 = bac.tdbPeriodes('mois', mer), dC = bac.tdbDonnees(Zc, Pm2, false, bac.getZoneFromAdresse);
    test('tdbDonnees collab : classements par nombre, aucun montant affiché', dC.zones[0].nb === 3 && !bac.tdbHtml(Object.assign({ P: Pm2, admin: false, stock: sv }, dC)).includes('€'), dC.zones);
  }
  { // 2. lectures concurrentes : la dernière lancée gagne, les réponses obsolètes sont ignorées
    const enCours = []; let lectures = 0; const periode = { value: 'mois' }; const el = { innerHTML: '' };
    const b5 = { console, JSON, Math, Date, Number, String, Object, Array, parseFloat, parseInt, isNaN, Promise, zones: [],
      role: 'admin', commandes: [{ id: '#1' }], cmdTotalCount: 5000, produits: [], SUPABASE_URL: 'https://x.invalid', SUPABASE_KEY: 'k',
      setTimeout: () => 0, clearTimeout: () => {}, renderDash: () => {}, getZoneFromAdresse: () => null, arrChargerRevients: () => new Promise(() => {}),
      document: { getElementById: (id) => (id === 'tdb-contenu' ? el : id === 'p-dashboard' ? { classList: { contains: () => true } } : id === 'dash-periode' ? periode : null) },
      // v7.5.157 : page suivante (filtre id=gt.) d'une base FICTIVE dont tout tient sur une page → vide, aussitôt (tdbLire lit jusqu'à une page vide)
      fetch: (u, o) => { if (/[?&]id=gt\./.test(u)) return Promise.resolve({ ok: true, json: async () => [] }); lectures++; return new Promise((ok) => { enCours.push((rows) => ok({ ok: true, json: async () => rows })); }); } };
    vm.createContext(b5); vm.runInContext(tranche('// TDB-DEBUT', '// TDB-FIN'), b5);
    const attendre = async () => { for (let k = 0; k < 6; k++) await new Promise((r) => setImmediate(r)); };
    const ligne = (id) => ({ id, prix: 1, statut: 'livré', stpaie: '', montant_enc: 0, date_commande: '2026-11-01', date_livraison: '2026-11-01', origine: '', adresse: '', livreur: '' });
    b5.tdbRendre(); const mois = enCours.splice(0); // Mois : 2 lectures
    periode.value = 'semaine'; b5.tdbRendre(); const sem = enCours.splice(0); // Semaine : 3 lectures
    test('changement rapide de période : deux lectures distinctes lancées', mois.length === 2 && sem.length === 3 && b5.TDB_ETAT.req === 2, [mois.length, sem.length]);
    sem.forEach((r) => r([ligne('#S')])); await attendre(); // la plus récente répond d'abord
    const apres = lectures;
    test('réponse de la lecture la plus récente gardée', b5.TDB_ETAT.cle.indexOf('semaine:') === 0 && egal(b5.TDB_ETAT.lignes.map((l) => l.id), ['#S']) && b5.TDB_ETAT.at > 0, b5.TDB_ETAT.cle);
    mois.forEach((r) => r([ligne('#M')])); await attendre(); // l'ancienne arrive après
    test('réponse obsolète (Mois) arrivée après : ignorée, rien remplacé', b5.TDB_ETAT.cle.indexOf('semaine:') === 0 && egal(b5.TDB_ETAT.lignes.map((l) => l.id), ['#S']), [b5.TDB_ETAT.cle, b5.TDB_ETAT.lignes]);
    test('réponse obsolète : aucune relecture inutile déclenchée', lectures === apres && enCours.length === 0, [apres, lectures]);
    // ordre inverse : l'ancienne d'abord, puis la récente
    periode.value = 'annee'; b5.TDB_ETAT.at = 0; b5.tdbRendre(); const an = enCours.splice(0);
    periode.value = 'jour'; b5.tdbRendre(); const jr = enCours.splice(0);
    an.forEach((r) => r([ligne('#A')])); await attendre();
    test('ancienne réponse (Année) arrivée la première : ignorée, lecture Jour toujours attendue', egal(Object.keys(b5.TDB_ETAT.vols).map((k) => k.split(':')[0]), ['jour']) && !b5.TDB_ETAT.lignes.some((l) => l.id === '#A') && enCours.length === 0, b5.TDB_ETAT.vols);
    jr.forEach((r) => r([ligne('#J')])); await attendre();
    test('puis la récente (Jour) : gardée et affichée', b5.TDB_ETAT.cle.indexOf('jour:') === 0 && egal(b5.TDB_ETAT.lignes.map((l) => l.id), ['#J']) && Object.keys(b5.TDB_ETAT.vols).length === 0);
  }
  { // 4. pagination complète, garde-fou explicite
    // v7.5.157 (revue Codex PR 27 sur 25550c3, point 2) : pagination par CLÉ (id croissant, &id=gt.<dernier reçu>, &limit=)
    // base FICTIVE triée par identifiant ; au plus « plafond » lignes rendues par réponse (réglage max-rows) ; « pendant » modifie la base
    // juste avant de répondre à une page (insertion / suppression pendant la lecture)
    let pages = 0; const urls = [];
    const idDe = (n) => 'C' + String(n).padStart(6, '0');
    const b6 = { console, JSON, Math, Date, Number, String, Object, Array, parseFloat, parseInt, isNaN, Promise, encodeURIComponent, SUPABASE_URL: 'https://x.invalid', SUPABASE_KEY: 'k',
      plafond: 1000, base: [], pendant: null,
      fetch: (url, o) => {
        pages++; urls.push(url);
        if (b6.pendant) b6.pendant(pages);
        const m = /[?&]id=gt\.([^&]*)/.exec(url), apres = m ? decodeURIComponent(m[1]) : null;
        const lim = Number((/[?&]limit=(\d+)/.exec(url) || [])[1] || 1e9);
        const tri = b6.base.slice().sort();
        const rows = tri.filter((id) => apres == null || id > apres).slice(0, Math.min(lim, b6.plafond)).map((id) => ({ id }));
        return Promise.resolve({ ok: true, json: async () => rows });
      } };
    vm.createContext(b6); vm.runInContext(tranche('// TDB-DEBUT', '// TDB-FIN'), b6);
    b6.base = Array.from({ length: 31005 }, (_, k) => idDe(k));
    const tout = await b6.tdbLire('');
    test('au-delà de 30 pages : la lecture continue jusqu’à la dernière (31 005 lignes, 32 pages + page vide de fin)', tout.length === 31005 && pages === 33 && new Set(tout.map((r) => r.id)).size === 31005, [tout.length, pages]);
    test('pagination par clé : 1re page sans filtre d’identifiant, suivantes après le DERNIER identifiant reçu (encodé), ordre id croissant, aucune plage « Range »',
      !/id=gt\./.test(urls[0]) && urls[1].includes('&id=gt.' + encodeURIComponent(idDe(999)) + '&order=id.asc&limit=1000') && urls.every((u) => u.includes('&order=id.asc&limit=1000'))
      && !/Range|offset=/.test(tranche('async function tdbLire(filtre) {', 'async function tdbCharger')), urls.slice(0, 2));
    // base qui plafonne chaque réponse SOUS 1 000 lignes (réglage max-rows)
    b6.plafond = 300; pages = 0; urls.length = 0;
    const tout300 = await b6.tdbLire('');
    test('plafond de la base à 300 lignes par réponse : TOUT est lu (31 005 lignes, sans trou ni doublon), page suivante après le dernier reçu',
      tout300.length === 31005 && new Set(tout300.map((r) => r.id)).size === 31005 && tout300[300].id === idDe(300) && pages === Math.ceil(31005 / 300) + 1 && urls[1].includes('&id=gt.' + idDe(299)), [tout300.length, pages]);
    b6.plafond = 1000;
    // INSERTIONS et SUPPRESSIONS pendant la lecture : ni trou ni doublon pour les lignes présentes du début à la fin
    b6.base = Array.from({ length: 5000 }, (_, k) => idDe(2 * k)); // identifiants pairs : C000000, C000002, …, C009998
    const initiale = b6.base.slice();
    const supprimees = [idDe(10), idDe(500), idDe(1998), idDe(4000), idDe(9000)]; // 3 déjà lues à la 2e page, 2 pas encore
    b6.pendant = (n) => {
      if (n === 2) { b6.base = b6.base.filter((id) => supprimees.indexOf(id) < 0); b6.base.push(idDe(11), idDe(13), idDe(501), idDe(4001), idDe(9001)); }
      if (n === 4) { b6.base.push(idDe(3)); b6.base = b6.base.filter((id) => id !== idDe(1000)); }
    };
    const presentes = initiale.filter((id) => supprimees.indexOf(id) < 0 && id !== idDe(1000)); // présentes du début à la fin
    pages = 0; urls.length = 0;
    const lu = await b6.tdbLire(''); b6.pendant = null;
    const vus = {}; let doublons = 0; lu.forEach((r) => { if (vus[r.id]) doublons++; vus[r.id] = 1; });
    const trous = presentes.filter((id) => !vus[id]);
    test('insertion / suppression PENDANT la lecture : toutes les lignes présentes du début à la fin lues une fois (aucun trou), aucun doublon',
      trous.length === 0 && doublons === 0 && presentes.length === 4994 && pages >= 6 && !vus[idDe(4000)] && !vus[idDe(9000)], { trous: trous.slice(0, 5), doublons, n: lu.length, pages });
    test('… les lignes insérées après le curseur sont lues (C004001, C009001), celles insérées avant ne le sont pas (lecture stable)',
      !!vus[idDe(4001)] && !!vus[idDe(9001)] && !vus[idDe(3)] && !vus[idDe(11)], Object.keys(vus).filter((k) => /C0000(0[0-9]|1[0-3])$/.test(k)));
    { // ancienne pagination par DÉCALAGE sur le même scénario : un trou (preuve que le test couvre le défaut)
      let base2 = initiale.slice(), n2 = 0; const lus2 = {};
      for (let deb = 0; ; deb += 1000) {
        n2++; if (n2 === 2) { base2 = base2.filter((id) => supprimees.indexOf(id) < 0); }
        const page = base2.slice().sort().slice(deb, deb + 1000); if (!page.length) break; page.forEach((id) => { lus2[id] = 1; });
      }
      test('(par décalage, la même suppression aurait fait sauter des lignes présentes)', initiale.filter((id) => supprimees.indexOf(id) < 0).some((id) => !lus2[id]));
    }
    const deb0 = []; const f0 = b6.fetch; b6.fetch = (u, o) => { deb0.push(u); return Promise.resolve({ ok: true, json: async () => (deb0.length === 1 ? [{ id: '#a' }, { id: '#b' }] : []) }); };
    const court = await b6.tdbLire('');
    test('page de 2 lignes puis page vide : 2 lignes, la 2e requête part de l’identifiant #b (encodé %23b)', court.length === 2 && deb0.length === 2 && !/id=gt/.test(deb0[0]) && deb0[1].includes('&id=gt.%23b&'), deb0);
    b6.fetch = () => Promise.resolve({ ok: true, json: async () => [{ id: '#a' }, { id: '#b' }] }); let errI = '';
    try { await b6.tdbLire(''); } catch (e) { errI = e.message; }
    test('page qui renvoie un identifiant déjà lu (filtre ignoré) : erreur explicite, jamais de doublon ni de boucle', /identifiant déjà lu/.test(errI) && /chiffres non calculés/.test(errI), errI);
    b6.fetch = () => Promise.resolve({ ok: true, json: async () => [{ prix: 1 }] }); errI = '';
    try { await b6.tdbLire(''); } catch (e) { errI = e.message; }
    test('ligne sans identifiant : erreur explicite', /identifiant absent/.test(errI), errI);
    b6.fetch = f0; b6.base = Array.from({ length: 31005 }, (_, k) => idDe(k));
    b6.TDB_PAGES_MAX = 3; let err = '';
    try { await b6.tdbLire(''); } catch (e) { err = e.message; }
    test('garde-fou atteint : erreur explicite (jamais de chiffres tronqués en silence)', /chiffres non calculés/.test(err), err);
    test('erreur de lecture affichée dans la note (motif compris)', tranche('// TDB-DEBUT', '// TDB-FIN').includes("'Lecture de la base impossible (' + TDB_ETAT.erreur + ')"));
    test('plus aucune limite silencieuse à 30 pages', !/page < 30/.test(tranche('// TDB-DEBUT', '// TDB-FIN')));
  }
  console.log('\n7 quater. REVUE CODEX PR 27 SUR 5cca91d (échec de lecture sans boucle, preuve de chargement complet)');
  { // a) échec de lecture : avertissement gardé, aucune relecture immédiate, nouvelle tentative différée (plafonnée) ou par « Réessayer »
    const minuteurs = []; let lectures = 0, echoue = true; const el = { innerHTML: '' };
    const b7 = { console, JSON, Math, Date, Number, String, Object, Array, parseFloat, parseInt, isNaN, Promise, zones: [],
      role: 'admin', commandes: [{ id: '#1' }], cmdTotalCount: 5000, produits: [], SUPABASE_URL: 'https://x.invalid', SUPABASE_KEY: 'k',
      setTimeout: (f, ms) => { minuteurs.push({ f, ms }); return minuteurs.length; }, clearTimeout: () => {},
      renderDash: () => { b7.tdbRendre(); }, getZoneFromAdresse: () => null, arrChargerRevients: () => new Promise(() => {}),
      document: { getElementById: (id) => (id === 'tdb-contenu' ? el : id === 'p-dashboard' ? { classList: { contains: () => true } } : id === 'dash-periode' ? { value: 'mois' } : null) },
      fetch: () => { lectures++; return Promise.resolve(echoue ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, json: async () => [] }); } };
    vm.createContext(b7); vm.runInContext(tranche('// TDB-DEBUT', '// TDB-FIN'), b7);
    const attendre = async () => { for (let k = 0; k < 12; k++) await new Promise((r) => setImmediate(r)); };
    b7.tdbRendre(); await attendre();
    test('échec : une seule lecture (Mois = 2 requêtes), aucune boucle de requêtes', lectures === 2, lectures);
    test('échec : avertissement affiché avec le motif et le bouton « Réessayer », pas « Mise à jour… »',
      /Lecture de la base impossible \(HTTP 503\)/.test(el.innerHTML) && el.innerHTML.includes('tdbReessayer()') && !el.innerHTML.includes('Mise à jour depuis la base'), el.innerHTML.slice(0, 300));
    const d1 = b7.TDB_ETAT.reessaiA - Date.now();
    test('échec : nouvelle tentative programmée dans ≈ 60 s', b7.TDB_ETAT.echecs === 1 && d1 > 58000 && d1 <= 60000 && minuteurs.some((m) => m.ms > 58000 && m.ms <= 60200), [d1, minuteurs.map((m) => m.ms)]);
    for (let k = 0; k < 5; k++) b7.tdbRendre();
    b7.tdbSignaler('commandes'); minuteurs.filter((m) => m.ms === 800).forEach((m) => m.f()); await attendre();
    test('pendant le délai : rendus répétés et signal « commandes » → aucune requête, avertissement toujours visible',
      lectures === 2 && /Lecture de la base impossible/.test(el.innerHTML) && /Nouvelle tentative automatique vers \d\d:\d\d/.test(el.innerHTML), [lectures, el.innerHTML.slice(0, 200)]);
    // délai écoulé : la tentative programmée relit ; pendant la lecture, l'avertissement reste (« Nouvelle tentative en cours… »)
    let enAttente = []; b7.fetch = () => { lectures++; return new Promise((ok) => enAttente.push(ok)); };
    b7.TDB_ETAT.reessaiA = Date.now() - 1; minuteurs[minuteurs.length - 1].f();
    test('délai écoulé : nouvelle tentative lancée (2 requêtes), avertissement gardé pendant la lecture',
      lectures === 4 && /Lecture de la base impossible/.test(el.innerHTML) && el.innerHTML.includes('Nouvelle tentative en cours') && !el.innerHTML.includes('Mise à jour depuis la base'), [lectures, el.innerHTML.slice(0, 200)]);
    enAttente.splice(0).forEach((ok) => ok({ ok: false, status: 500, json: async () => ({}) })); await attendre();
    const d2 = b7.TDB_ETAT.reessaiA - Date.now();
    test('2e échec : délai doublé (≈ 120 s), toujours aucune boucle', b7.TDB_ETAT.echecs === 2 && d2 > 118000 && d2 <= 120000 && lectures === 4 && enAttente.length === 0, [d2, lectures]);
    test('délai plafonné à 10 min', b7.tdbDelaiReessai(1) === 60000 && b7.tdbDelaiReessai(3) === 240000 && b7.tdbDelaiReessai(10) === 600000 && b7.tdbDelaiReessai(50) === 600000);
    // bouton « Réessayer » : relecture immédiate ; succès → compteur remis à zéro, avertissement retiré
    b7.tdbReessayer();
    test('« Réessayer » : relecture immédiate', lectures === 6, lectures);
    b7.tdbReessayer();
    test('« Réessayer » pendant une lecture : pas de requête en double', lectures === 6, lectures);
    enAttente.splice(0).forEach((ok) => ok({ ok: true, json: async () => [] })); await attendre();
    test('succès après échecs : compteur remis à zéro, plus d’avertissement', b7.TDB_ETAT.echecs === 0 && b7.TDB_ETAT.reessaiA === 0 && !/Lecture de la base impossible/.test(el.innerHTML) && !el.innerHTML.includes('tdbReessayer()'), el.innerHTML.slice(0, 200));
  }
  { // b) complétude : preuve posée par sbLoadAll (liste ET total de la même réponse), jamais commandes.length ≥ cmdTotalCount
    const ligneBase = (n) => ({ id: '#' + n, client: 'Client fictif', prix: 10, statut: 'en-attente', date_livraison: '2026-11-25', date_commande: '2026-11-20' });
    const charger = async (nb, total, opts) => {
      const o = opts || {};
      const b8 = { console: { log() {}, warn() {} }, JSON, Math, Date, Number, String, Object, Array, parseFloat, parseInt, isNaN, Promise,
        commandes: [], tournees: [], caissesRemises: {}, nextCmdId: 1, cmdTotalCount: 0, cmdAllLoaded: false, CMD_SELECT_COLS: 'id,client', SUPABASE_URL: 'https://x.invalid', SUPABASE_KEY: 'k',
        localStorage: { getItem: () => null, setItem() {} }, AbortController: function () { this.signal = {}; this.abort = () => {}; },
        setTimeout: () => 0, clearTimeout: () => {}, renderCmds() {}, renderDash() {}, renderTournees() {}, renderLivreur() {}, toast() {}, reconcilierTournees() {},
        document: { querySelector: () => null, getElementById: () => null },
        fetch: async (url, init) => {
          const h = (init && init.headers) || {};
          if (url.endsWith('/commandes?select=id')) return { ok: true, headers: { get: () => '0-0/' + (o.totalSepare != null ? o.totalSepare : total) }, json: async () => [] };
          if (url.includes('/commandes?')) return o.echec ? { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) }
            : { ok: true, headers: { get: (k) => (k === 'Content-Range' && h.Prefer === 'count=exact' && !o.sansTotal ? '0-' + (nb - 1) + '/' + total : null) }, json: async () => Array.from({ length: nb }, (_, k) => ligneBase(k + 1)) };
          return { ok: true, headers: { get: () => null }, json: async () => [] };
        } };
      vm.createContext(b8);
      vm.runInContext(html.slice(html.indexOf('var cmdChargementComplet = false;'), html.indexOf('var _pollingInterval = null;')), b8);
      vm.runInContext(fonction('async function sbLoadAll() {'), b8);
      vm.runInContext(tranche('// TDB-DEBUT', '// TDB-FIN'), b8);
      if (!o.sansTempsReel) b8.cmdTempsReelStatut('SUBSCRIBED', 1); // v7.5.154 : temps réel connecté bien avant la lecture
      if (o.avant) o.avant(b8);
      await b8.sbLoadAll();
      return b8;
    };
    let b = await charger(1000, 1001);
    test('1 000 chargées sur 1 001 : chargement NON complet (preuve absente)', b.commandes.length === 1000 && b.cmdChargementComplet === false && b.tdbLocalComplet() === false, [b.commandes.length, b.cmdChargementComplet]);
    b.commandes.unshift({ id: '#2000' }); // une insertion par temps réel ou relève
    const ancienneRegle = b.commandes.length > 0 && b.cmdTotalCount > 0 && b.commandes.length >= b.cmdTotalCount;
    test('+ 1 insertion (1 001 = total) : toujours NON complet → le tableau lit la base par période', b.commandes.length === 1001 && b.cmdTotalCount === 1001 && b.tdbLocalComplet() === false, [b.commandes.length, b.cmdTotalCount]);
    test('(preuve que le cas est couvert : l’ancienne règle length ≥ total l’aurait cru complet)', ancienneRegle === true);
    b = await charger(1001, 1001);
    test('1 001 chargées sur 1 001 (total de la même réponse) : complet', b.cmdChargementComplet === true && b.tdbLocalComplet() === true);
    b.commandes.unshift({ id: '#2000' });
    test('complet puis 1 insertion : reste complet (la nouvelle est dans la liste)', b.tdbLocalComplet() === true);
    b = await charger(1000, 1000, { totalSepare: 1000, sansTotal: true });
    test('réponse sans total (Content-Range absent) : jamais complet, même si le comptage séparé coïncide', b.cmdChargementComplet === false && b.tdbLocalComplet() === false);
    b = await charger(0, 0, { echec: true, avant: (x) => { x.cmdChargementComplet = true; x.commandes = [{ id: '#1' }]; } });
    test('lecture en échec : preuve retirée (incertain)', b.cmdChargementComplet === false && b.tdbLocalComplet() === false);
    test('cmdTotalDepuisEntete : « 0-999/1001 » → 1001, « */0 » → 0, « 0-9/* » ou absent → inconnu', b.cmdTotalDepuisEntete('0-999/1001') === 1001 && b.cmdTotalDepuisEntete('*/0') === 0 && b.cmdTotalDepuisEntete('0-9/*') === null && b.cmdTotalDepuisEntete(null) === null);
    test('tableau : plus aucune comparaison commandes.length ≥ cmdTotalCount', !/commandes\.length >= cmdTotalCount/.test(tranche('// TDB-DEBUT', '// TDB-FIN')));
    // v7.5.154 (revue Codex PR 27 sur aa07e1e) : preuve retirée dès que la synchronisation n'est plus garantie ; reconnexion
    b = await charger(1001, 1001);
    test('synchro : complet au départ (temps réel connecté avant la lecture)', b.tdbLocalComplet() === true);
    let signaux = 0; b.tdbSignaler = () => { signaux++; };
    b.cmdTempsReelStatut('CHANNEL_ERROR');
    test('temps réel en ERREUR : preuve retirée → le tableau lit la base par période, tableau prévenu', b.cmdChargementComplet === false && b.tdbLocalComplet() === false && signaux === 1);
    b.cmdTempsReelStatut('SUBSCRIBED');
    test('reconnexion : la preuve n’est PAS rendue (changements manqués pendant la coupure)', b.tdbLocalComplet() === false);
    await new Promise((r) => setTimeout(r, 5)); await b.sbLoadAll();
    test('reconnexion puis nouvelle lecture complète (commencée après la reconnexion) : preuve rendue', b.cmdChargementComplet === true && b.tdbLocalComplet() === true);
    for (const st of ['TIMED_OUT', 'CLOSED']) {
      b = await charger(1001, 1001); b.cmdTempsReelStatut(st);
      test('temps réel ' + st + ' : preuve retirée', b.tdbLocalComplet() === false);
    }
    b = await charger(1001, 1001, { sansTempsReel: true });
    test('temps réel jamais connecté : lecture complète SANS preuve', b.cmdChargementComplet === false && b.tdbLocalComplet() === false);
    b = await charger(1001, 1001, { avant: (x) => { x.cmdTempsReelStatut('SUBSCRIBED', Date.now() + 60000); } });
    test('temps réel connecté APRÈS le début de la lecture : pas de preuve (changements entre-temps non garantis)', b.tdbLocalComplet() === false);
    b = await charger(1001, 1001, { avant: (x) => { const f0 = x.fetch; x.fetch = async (u, i) => { if (u.includes('/commandes?select=id,client')) x.cmdSynchroPerdue('relève', Date.now() + 1); return f0(u, i); }; } });
    test('perte de synchronisation PENDANT la lecture complète : pas de preuve', b.tdbLocalComplet() === false);
    b = await charger(1001, 1001); b.cmdSynchroPerdue('relève HTTP 503');
    test('relève (polling) en échec : preuve retirée', b.tdbLocalComplet() === false);
    b = await charger(1001, 1001); b.cmdVisibilite('hidden', 1000); b.cmdVisibilite('visible', 1000 + 30000);
    test('onglet masqué 30 s : preuve gardée', b.tdbLocalComplet() === true);
    b.cmdVisibilite('hidden', 2000); b.cmdVisibilite('visible', 2000 + b.CMD_VEILLE_MAX + 1);
    test('onglet masqué plus de 60 s : preuve retirée', b.tdbLocalComplet() === false);
    test('branchements : statut du canal actuel (subscribe), relève en échec (HTTP et exception), retour au premier plan, ancien canal remplacé',
      html.includes('if (_sbCanalNo === sbRealtimeCanalNo) cmdTempsReelStatut(status);') && html.includes("} else cmdSynchroPerdue('relève HTTP ' + rC.status);")
      && html.includes("console.warn('Polling erreur:', e.message); cmdSynchroPerdue('relève');") && html.includes('cmdVisibilite(document.visibilityState);')
      && /if \(sbRealtimeChannel\) \{\s*\/\/[^\n]*\n\s*cmdTempsReelStatut\('CLOSED'\);/.test(html)
      && html.includes('cmdChargementComplet = cmdsComplet && _rejeu.incertains === 0 && cmdSynchroGarantieDepuis(_cmdDebutLecture);'));
  }
  console.log('\n7 sexies. REVUE CODEX PR 27 SUR 25550c3 (événements temps réel reçus pendant le chargement complet)');
  { // a) un événement reçu entre la lecture de la liste et la fin de l'attente des tournées n'est plus écrasé par l'instantané
    const T1 = '2026-11-26T10:00:00.000001+00:00', T0 = '2026-11-26 09:59:59.999999+00', T2 = '2026-11-26T10:00:05+00:00';
    const ligne = (id, o) => Object.assign({ id, client: 'Client fictif', statut: 'en-attente', updated_at: T1 }, o || {});
    const charger = async (snapshot, pendantTournees, opts) => {
      const o = opts || {};
      const b = { console: { log() {}, warn() {} }, JSON, Math, Date, Number, String, Object, Array, parseFloat, parseInt, isNaN, isFinite, Promise,
        commandes: [], tournees: [], caissesRemises: {}, nextCmdId: 1, cmdTotalCount: 0, cmdAllLoaded: false, CMD_SELECT_COLS: 'id,client,statut,updated_at',
        SUPABASE_URL: 'https://x.invalid', SUPABASE_KEY: 'k',
        localStorage: { getItem: () => null, setItem() {} }, AbortController: function () { this.signal = {}; this.abort = () => {}; },
        setTimeout: () => 0, clearTimeout: () => {}, renderCmds() {}, renderDash() {}, renderTournees() {}, renderLivreur() {}, toast() {}, reconcilierTournees() {},
        document: { querySelector: () => null, getElementById: () => null },
        fetch: async (url, init) => {
          if (url.endsWith('/commandes?select=id')) return { ok: true, headers: { get: () => '0-0/' + snapshot.length }, json: async () => [] };
          if (url.includes('/commandes?')) {
            if (o.echec) throw new Error('réseau');
            return { ok: true, headers: { get: (k) => (k === 'Content-Range' ? '0-' + (snapshot.length - 1) + '/' + snapshot.length : null) }, json: async () => JSON.parse(JSON.stringify(snapshot)) };
          }
          if (url.includes('/tournees?')) { if (pendantTournees) pendantTournees(b); return { ok: true, headers: { get: () => null }, json: async () => [] }; }
          return { ok: true, headers: { get: () => null }, json: async () => [] };
        } };
      vm.createContext(b);
      vm.runInContext(html.slice(html.indexOf('var cmdChargementComplet = false;'), html.indexOf('var _pollingInterval = null;')), b);
      vm.runInContext(fonction('async function sbLoadAll() {'), b);
      vm.runInContext(tranche('// TDB-DEBUT', '// TDB-FIN'), b);
      b.cmdTempsReelStatut('SUBSCRIBED', 1);
      if (o.avant) o.avant(b);
      await b.sbLoadAll();
      return b;
    };
    // même chemin que le gestionnaire temps réel « commandes » (sbStartRealtime) : file, puis application à la liste actuelle
    const evenement = (b, p) => { b.cmdRtRecu(p); b.cmdTempsReelAppliquer(p); };
    const ids = (b) => b.commandes.map((c) => c.id).sort();
    let b = await charger([ligne('#1')], (x) => evenement(x, { eventType: 'INSERT', new: ligne('#2', { updated_at: T2 }), old: {} }));
    test('insertion #2 PENDANT l’attente des tournées : #2 gardée après l’instantané (rejouée), preuve accordée (liste réellement complète)',
      egal(ids(b), ['#1', '#2']) && b.cmdChargementComplet === true && b.tdbLocalComplet() === true, [ids(b), b.cmdChargementComplet]);
    const sansRejeu = await charger([ligne('#1')], (x) => evenement(x, { eventType: 'INSERT', new: ligne('#2', { updated_at: T2 }), old: {} }), { avant: (x) => { x.cmdRejouerFile = () => ({ incertains: 0 }); } });
    test('(preuve que le test couvre le défaut : sans rejeu, l’instantané écrase #2 — la liste ne contient que #1)', egal(ids(sansRejeu), ['#1']), ids(sansRejeu));
    b = await charger([ligne('#1')], (x) => evenement(x, { eventType: 'UPDATE', new: ligne('#1', { statut: 'livré', updated_at: T2 }), old: { id: '#1' } }));
    test('modification PLUS RÉCENTE que l’instantané : appliquée (livré), preuve accordée', b.commandes.length === 1 && b.commandes[0].statut === 'livré' && b.cmdChargementComplet === true, b.commandes);
    b = await charger([ligne('#1', { statut: 'livré' })], (x) => evenement(x, { eventType: 'UPDATE', new: ligne('#1', { statut: 'en-attente', updated_at: T0 }), old: { id: '#1' } }));
    test('événement PLUS ANCIEN que l’instantané (arrivé en retard) : ignoré, l’instantané gagne, preuve accordée', b.commandes[0].statut === 'livré' && b.cmdChargementComplet === true, b.commandes);
    b = await charger([ligne('#1')], (x) => evenement(x, { eventType: 'UPDATE', new: ligne('#1', { updated_at: '2026-11-26 10:00:00.000001+00' }), old: { id: '#1' } }));
    test('même date (écrite autrement) et mêmes valeurs : ignoré, preuve accordée', b.commandes[0].statut === 'en-attente' && b.cmdChargementComplet === true);
    b = await charger([ligne('#1')], (x) => evenement(x, { eventType: 'UPDATE', new: ligne('#1', { statut: 'livré' }), old: { id: '#1' } }));
    test('même date mais valeurs DIFFÉRENTES (ordre indécidable) : instantané gardé, preuve REFUSÉE', b.commandes[0].statut === 'en-attente' && b.cmdChargementComplet === false && b.tdbLocalComplet() === false);
    b = await charger([ligne('#1')], (x) => evenement(x, { eventType: 'UPDATE', new: ligne('#1', { statut: 'livré', updated_at: null }), old: { id: '#1' } }));
    test('date de mise à jour absente : preuve REFUSÉE', b.cmdChargementComplet === false);
    b = await charger([ligne('#1'), ligne('#3')], (x) => evenement(x, { eventType: 'DELETE', new: {}, old: { id: '#3' } }));
    test('suppression #3 pendant l’attente : retirée de l’instantané, preuve accordée', egal(ids(b), ['#1']) && b.cmdChargementComplet === true, ids(b));
    b = await charger([ligne('#1')], (x) => evenement(x, { eventType: 'DELETE', new: {}, old: {} }));
    test('suppression sans identifiant : preuve REFUSÉE', b.cmdChargementComplet === false);
    b = await charger([ligne('#1')], (x) => { evenement(x, { eventType: 'INSERT', new: ligne('#2', { updated_at: T2 }), old: {} }); evenement(x, { eventType: 'UPDATE', new: ligne('#2', { statut: 'livré', updated_at: '2026-11-26T10:00:06+00:00' }), old: { id: '#2' } }); });
    test('insertion puis modification de #2 pendant l’attente : rejouées dans l’ordre (#2 livrée)', egal(ids(b), ['#1', '#2']) && b.commandes.find((c) => c.id === '#2').statut === 'livré' && b.cmdChargementComplet === true);
    test('file fermée à la fin du chargement : un événement ultérieur n’est plus mis en file', b.cmdRtFiles.length === 0);
    b = await charger([ligne('#1')], null, { echec: true, avant: (x) => { x.commandes = [{ id: '#9' }]; } });
    test('chargement en échec : file fermée, liste gardée, pas de preuve', b.cmdRtFiles.length === 0 && ids(b).join() === '#9' && b.cmdChargementComplet === false);
    // deux chargements simultanés : chacun reçoit l'événement dans SA file
    b = await charger([ligne('#1')], null);
    const f1 = b.cmdRtOuvrir(), f2 = b.cmdRtOuvrir(); b.cmdRtRecu({ eventType: 'INSERT', new: ligne('#4'), old: {} }); b.cmdRtFermer(f1); b.cmdRtFermer(f2);
    test('deux chargements simultanés : l’événement est rangé dans les deux files', f1.length === 1 && f2.length === 1 && b.cmdRtFiles.length === 0);
    test('horodatages : écritures équivalentes égales, microsecondes comparées, fuseau appliqué, illisible → null',
      b.cmdComparerDates('2026-11-26T10:00:00.123456+00:00', '2026-11-26 10:00:00.123456+00') === 0 && b.cmdComparerDates('2026-11-26T10:00:00.123456Z', '2026-11-26T10:00:00.123457Z') === -1
      && b.cmdComparerDates('2026-11-26T11:00:00+01:00', '2026-11-26T10:00:00Z') === 0 && b.cmdComparerDates('', T1) === null && b.cmdComparerDates('hier', T1) === null);
    test('branchements : gestionnaire temps réel → file AVANT tout le reste (suppressions comprises) ; file ouverte avant la lecture ; updated_at lu',
      /table:'commandes'\}, function\(payload\) \{\n\s*cmdRtRecu\(payload\);[^\n]*\n\s*\/\/[^\n]*\n\s*if \(!cmdTempsReelAppliquer\(payload\)\) return;\n/.test(html)
      && html.indexOf('_cmdFile = cmdRtOuvrir();') < html.indexOf("var rCmds = await fetch(SUPABASE_URL + '/rest/v1/commandes?select=' + CMD_SELECT_COLS")
      && html.indexOf('_cmdFile = cmdRtOuvrir();') > html.indexOf('async function sbLoadAll() {')
      && /var CMD_SELECT_COLS = '[^']*,updated_at';/.test(html));
  }
  console.log('\n7 septies. REVUE CODEX PR 27 SUR 8dc087f (suppression reçue par le temps réel APRÈS le chargement initial)');
  {
    const ligne = (id, x) => Object.assign({ id, client: 'Client fictif', prix: 100, statut: 'en-attente', updated_at: '2026-11-26T10:00:00.000001+00:00' }, x || {});
    // même bac à sable que 7 sexies (25550c3) ; « base » = contenu FICTIF de la table, modifiable entre deux lectures complètes
    const charger = async (rows) => {
      const b = { console: { log() {}, warn() {} }, JSON, Math, Date, Number, String, Object, Array, parseFloat, parseInt, isNaN, isFinite, Promise,
        commandes: [], tournees: [], caissesRemises: {}, nextCmdId: 1, cmdTotalCount: 0, cmdAllLoaded: false, CMD_SELECT_COLS: 'id,client,statut,updated_at',
        SUPABASE_URL: 'https://x.invalid', SUPABASE_KEY: 'k', _base: rows,
        localStorage: { getItem: () => null, setItem() {} }, AbortController: function () { this.signal = {}; this.abort = () => {}; },
        setTimeout: () => 0, clearTimeout: () => {}, renderCmds() {}, renderDash() {}, renderTournees() {}, renderLivreur() {}, toast() {}, reconcilierTournees() {},
        document: { querySelector: () => null, getElementById: () => null },
        fetch: async (url) => {
          const snapshot = b._base;
          if (url.endsWith('/commandes?select=id')) return { ok: true, headers: { get: () => '0-0/' + snapshot.length }, json: async () => [] };
          if (url.includes('/commandes?')) return { ok: true, headers: { get: (k) => (k === 'Content-Range' ? '0-' + (snapshot.length - 1) + '/' + snapshot.length : null) }, json: async () => JSON.parse(JSON.stringify(snapshot)) };
          return { ok: true, headers: { get: () => null }, json: async () => [] };
        } };
      vm.createContext(b);
      vm.runInContext(html.slice(html.indexOf('var cmdChargementComplet = false;'), html.indexOf('var _pollingInterval = null;')), b);
      vm.runInContext(fonction('async function sbLoadAll() {'), b);
      vm.runInContext(tranche('// TDB-DEBUT', '// TDB-FIN'), b);
      b.cmdTempsReelStatut('SUBSCRIBED', 1);
      await b.sbLoadAll();
      return b;
    };
    // même chemin que le gestionnaire temps réel « commandes » (sbStartRealtime) : file des chargements en cours, puis liste actuelle
    const recu = (b, p) => { b.cmdRtRecu(p); return b.cmdTempsReelAppliquer(p); };
    const ids = (b) => b.commandes.map((c) => c.id).sort();
    let b = await charger([ligne('#1'), ligne('#2'), ligne('#3')]);
    test('départ : 3 commandes chargées en entier, preuve accordée', egal(ids(b), ['#1', '#2', '#3']) && b.tdbLocalComplet() === true, [ids(b), b.cmdChargementComplet]);
    let signaux = 0; b.tdbSignaler = () => { signaux++; };
    let change = recu(b, { eventType: 'DELETE', new: {}, old: { id: '#2' } });
    test('suppression de #2 APRÈS le chargement (payload.old.id) : #2 retirée de la liste locale, affichage rafraîchi', change === true && egal(ids(b), ['#1', '#3']), ids(b));
    test('…preuve toujours accordée (la liste reste exacte) : les chiffres locaux ne comptent plus #2', b.tdbLocalComplet() === true && !b.commandes.some((c) => c.id === '#2'));
    const ancien = { commandes: [{ id: '#1' }, { id: '#2' }] }; { const p = { eventType: 'DELETE', new: {}, old: { id: '#2' } }; const r = p.new; if (!(!r || !r.id)) ancien.commandes = []; }
    test('(preuve que le cas est couvert : l’ancien gestionnaire, arrêté faute de payload.new.id, gardait #2)', ancien.commandes.length === 2);
    b = await charger([ligne('#1'), ligne('#2')]); signaux = 0; b.tdbSignaler = () => { signaux++; };
    change = recu(b, { eventType: 'DELETE', new: {}, old: {} });
    test('suppression SANS identifiant (ancienne ligne non transmise) : liste gardée, preuve RETIRÉE → le tableau lit la base par période, tableau prévenu',
      change === true && egal(ids(b), ['#1', '#2']) && b.cmdChargementComplet === false && b.tdbLocalComplet() === false && signaux === 1, [ids(b), b.cmdChargementComplet, signaux]);
    b = await charger([ligne('#1')]);
    recu(b, { eventType: 'DELETE', new: {}, old: null });
    test('suppression sans ancienne ligne du tout (old absent) : preuve retirée, sans erreur', b.tdbLocalComplet() === false);
    b = await charger([ligne('#1'), ligne('#2')]); recu(b, { eventType: 'DELETE', new: {}, old: {} });
    b._base = [ligne('#1')]; // #2 supprimée dans la base
    await new Promise((r) => setTimeout(r, 5)); await b.sbLoadAll();
    test('lecture complète suivante (commencée après la perte) : liste relue (#2 disparue), preuve rendue', egal(ids(b), ['#1']) && b.tdbLocalComplet() === true, [ids(b), b.cmdChargementComplet]);
    b = await charger([ligne('#1')]);
    test('insertion et modification : appliquées comme avant ; événement sans identifiant (hors suppression) : ignoré',
      recu(b, { eventType: 'INSERT', new: ligne('#5'), old: {} }) === true && recu(b, { eventType: 'UPDATE', new: ligne('#1', { statut: 'livré' }), old: { id: '#1' } }) === true
      && recu(b, { eventType: 'UPDATE', new: {}, old: {} }) === false && egal(ids(b), ['#1', '#5']) && b.commandes.find((c) => c.id === '#1').statut === 'livré' && b.tdbLocalComplet() === true);
  }

  console.log('\n7 quinquies. REVUE CODEX PR 27 SUR a46f8aa (lectures suivies par période, champs échappés)');
  { // a) Mois → Semaine → Mois : la réponse de la période AFFICHÉE est toujours prise, aucune lecture redondante, quel que soit l'ordre
    const banc = () => {
      const s = { enCours: [], lectures: 0, periode: { value: 'mois' }, el: { innerHTML: '' } };
      s.b = { console, JSON, Math, Date, Number, String, Object, Array, parseFloat, parseInt, isNaN, Promise, zones: [],
        role: 'admin', commandes: [{ id: '#1' }], cmdTotalCount: 5000, produits: [], SUPABASE_URL: 'https://x.invalid', SUPABASE_KEY: 'k',
        setTimeout: () => 0, clearTimeout: () => {}, renderDash: () => {}, getZoneFromAdresse: () => null, arrChargerRevients: () => new Promise(() => {}),
        document: { getElementById: (id) => (id === 'tdb-contenu' ? s.el : id === 'p-dashboard' ? { classList: { contains: () => true } } : id === 'dash-periode' ? s.periode : null) },
        // v7.5.157 : page suivante (filtre id=gt.) d'une base FICTIVE dont tout tient sur une page → vide, aussitôt (tdbLire lit jusqu'à une page vide)
        fetch: (u, o) => { if (/[?&]id=gt\./.test(u)) return Promise.resolve({ ok: true, json: async () => [] }); s.lectures++; return new Promise((ok) => { s.enCours.push((rows) => ok({ ok: true, json: async () => rows })); }); } };
      vm.createContext(s.b); vm.runInContext(tranche('// TDB-DEBUT', '// TDB-FIN'), s.b);
      s.aller = (v) => { s.periode.value = v; s.b.tdbRendre(); return s.enCours.splice(0); };
      return s;
    };
    const attendre = async () => { for (let k = 0; k < 8; k++) await new Promise((r) => setImmediate(r)); };
    const ligne = (id) => ({ id, prix: 1, statut: 'livré', stpaie: '', montant_enc: 0, date_commande: '2026-11-01', date_livraison: '2026-11-01', origine: '', adresse: '', livreur: '' });
    const ids = (s) => (s.b.TDB_ETAT.lignes || []).map((l) => l.id);
    // ordre 1 : retour sur Mois, puis Mois répond, puis Semaine
    let s = banc(); let m = s.aller('mois'), w = s.aller('semaine'), m2 = s.aller('mois');
    test('Mois → Semaine → Mois : aucune lecture Mois redondante (2 + 3 requêtes seulement)', m.length === 2 && w.length === 3 && m2.length === 0 && s.lectures === 5, [m.length, w.length, m2.length, s.lectures]);
    test('… pendant l\'attente : « Mise à jour depuis la base… » (rien d\'une autre période affiché)', /Mise à jour depuis la base/.test(s.el.innerHTML) && s.b.TDB_ETAT.lignes === null);
    m.forEach((r) => r([ligne('#M')])); await attendre();
    test('ordre 1 : la réponse Mois (période affichée) est prise', s.b.TDB_ETAT.cle.indexOf('mois:') === 0 && egal(ids(s), ['#M']) && s.b.TDB_ETAT.at > 0, [s.b.TDB_ETAT.cle, ids(s)]);
    w.forEach((r) => r([ligne('#W')])); await attendre();
    test('ordre 1 : la réponse Semaine arrivée ensuite est ignorée (rien remplacé, aucune relecture)', egal(ids(s), ['#M']) && s.lectures === 5 && s.enCours.length === 0, [ids(s), s.lectures]);
    // ordre 2 : retour sur Mois, Semaine répond d'abord, puis Mois
    s = banc(); m = s.aller('mois'); w = s.aller('semaine'); m2 = s.aller('mois');
    w.forEach((r) => r([ligne('#W')])); await attendre();
    test('ordre 2 : Semaine répond d\'abord (Mois affiché) → ignorée, Mois toujours attendu, aucune relecture', s.b.TDB_ETAT.lignes === null && egal(Object.keys(s.b.TDB_ETAT.vols).map((k) => k.split(':')[0]), ['mois']) && s.lectures === 5, [s.b.TDB_ETAT.vols, s.lectures]);
    m.forEach((r) => r([ligne('#M')])); await attendre();
    test('ordre 2 : puis Mois répond → prise et affichée', s.b.TDB_ETAT.cle.indexOf('mois:') === 0 && egal(ids(s), ['#M']) && s.lectures === 5);
    // ordre 3 : Mois répond PENDANT que Semaine est affichée, puis retour sur Mois → reprise de cette lecture, aucune requête
    s = banc(); m = s.aller('mois'); w = s.aller('semaine');
    m.forEach((r) => r([ligne('#M')])); await attendre();
    test('ordre 3 : Mois répond pendant que Semaine est affichée → rien remplacé', s.b.TDB_ETAT.lignes === null && !!s.b.TDB_ETAT.cache[Object.keys(s.b.TDB_ETAT.cache)[0]]);
    m2 = s.aller('mois');
    test('ordre 3 : retour sur Mois → lecture déjà reçue reprise, aucune requête', m2.length === 0 && s.lectures === 5 && egal(ids(s), ['#M']) && s.b.TDB_ETAT.cle.indexOf('mois:') === 0, [m2.length, s.lectures, ids(s)]);
    w.forEach((r) => r([ligne('#W')])); await attendre();
    test('ordre 3 : la réponse Semaine arrivée après est ignorée', egal(ids(s), ['#M']) && s.lectures === 5);
    // ordre 4 : une commande change entre-temps → la lecture mise de côté est périmée, relue
    s = banc(); m = s.aller('mois'); w = s.aller('semaine');
    m.forEach((r) => r([ligne('#M')])); await attendre();
    s.b.tdbSignaler('commandes'); m2 = s.aller('mois');
    test('ordre 4 : commande changée depuis la lecture mise de côté → Mois relu (2 requêtes), ancienne réponse jamais affichée', m2.length === 2 && s.b.TDB_ETAT.lignes === null, [m2.length, ids(s)]);
    test('code : plus d\'« enCours » global, lectures suivies par période (vols)', !/TDB_ETAT\.enCours/.test(tranche('// TDB-DEBUT', '// TDB-FIN')) && tranche('// TDB-DEBUT', '// TDB-FIN').includes('if (TDB_ETAT.vols[cle]) return;'));
  }
  { // b) commandes récentes et autres insertions du tableau : valeurs échappées, plus d'identifiant dans un onclick
    const recEl = { innerHTML: '', onclick: null, contains: () => true }; const ouverts = [];
    const b9 = { console, JSON, Math, Date, Number, String, Object, Array, parseFloat, parseInt, isNaN, role: 'admin', ORIGINE_CONFIG: {}, ouvrirCmd: (id) => ouverts.push(id),
      document: { getElementById: (id) => (id === 'dash-recent' ? recEl : null) } };
    vm.createContext(b9);
    vm.runInContext(tranche('// TDB-DEBUT', '// TDB-FIN') + '\n' + fonction('function tdbRecentes() {') + '\n' + fonction('function origineBadge(o) {') + '\n' + fonction('function stBdg(s){'), b9);
    const mal = '<img src=x onerror=alert(1)>';
    b9.commandes = [{ id: "#1'); alert('x", client: mal, tel: "06' onmouseover='x", produit: mal, prix: '<b>9</b>', origine: mal, livreur: mal, statut: mal }];
    b9.tdbRecentes();
    const h = recEl.innerHTML;
    test('récentes : nom, téléphone, produit, montant, canal, livreur, statut échappés (<img onerror>, apostrophe)', !/<img/i.test(h) && !h.includes('<b>9</b>') && h.includes('&lt;img src=x onerror=alert(1)&gt;') && h.includes('06&#39; onmouseover=&#39;x'), h.slice(0, 400));
    test('récentes : aucun onclick dans le tableau, identifiant porté par data-cmd-id échappé', !/onclick=/i.test(h) && h.includes('data-cmd-id="#1&#39;); alert(&#39;x"'), h.slice(0, 200));
    const tr = { getAttribute: (k) => (k === 'data-cmd-id' ? "#1'); alert('x" : null) };
    recEl.onclick({ target: { closest: (sel) => (sel === 'tr[data-cmd-id]' ? tr : null) } });
    recEl.onclick({ target: { closest: () => null } });
    test('récentes : clic sur une ligne → ouvrirCmd(identifiant tel quel), clic ailleurs → rien', egal(ouverts, ["#1'); alert('x"]), ouverts);
    b9.tdbRecentes();
    test('récentes : un seul écouteur (propriété remplacée, jamais cumulée)', typeof recEl.onclick === 'function');
    // autres insertions : zones (nom, couleur dans style), livreurs, stock, titre, note
    const P = bac.tdbPeriodes('mois', mer);
    const hZ = bac.tdbHtml({ P, admin: true, cur: bac.tdbDonnees([], P, true, () => null).cur, prev: bac.tdbDonnees([], P, true, () => null).prev, stock: { ruptures: 0, bas: 0 },
      zones: [{ nom: mal, couleur: 'red;background:url(https://x.invalid/a)"><img src=x onerror=alert(2)>', nb: 1, ca: 10 }], livreurs: [{ nom: mal, nb: 1, ca: 10 }], note: mal });
    test('zones / livreurs / note : noms échappés, couleur hors liste blanche remplacée (aucune injection dans style)', !/<img/i.test(hZ) && !hZ.includes('url(') && hZ.includes('background:#a39b90') && hZ.includes('&lt;img src=x onerror=alert(1)&gt;'), hZ.slice(0, 300));
    test('couleur de zone : codes #rgb / #rrggbb et noms gardés, le reste neutralisé', bac.tdbCouleur('#1a2B3c') === '#1a2B3c' && bac.tdbCouleur('#abc') === '#abc' && bac.tdbCouleur('teal') === 'teal'
      && bac.tdbCouleur('red;x:y') === '#a39b90' && bac.tdbCouleur('"') === '#a39b90' && bac.tdbCouleur(null) === '#a39b90');
  }
  console.log('\n8. MISE EN LIGNE');

test('CACHE_VERSION augmentée (v7-5-160 ou plus, au-dessus de la PR 26)', (() => { const m2 = /CACHE_VERSION = 'maxiconfort-v7-5-(\d+)'/.exec(fs.readFileSync(path.join(racine, 'service-worker.js'), 'utf8')); return m2 && Number(m2[1]) >= 160; })());
console.log('\n' + ok + ' OK, ' + ko + ' échec(s)'); process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
