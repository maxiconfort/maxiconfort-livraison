// Banc de test du motif d'annulation obligatoire (v7.5.117, 07/10/2026).
// Usage : node outils/test-annulation.js
// Il EXTRAIT le vrai code de maxiconfort-v7.html (bloc ANN-DEBUT … ANN-FIN, sbSaveCommande, chgStatut, setLvSt) et l'exécute
// dans un bac à sable : aucune connexion à la base, aucune donnée réelle. `fetch` est remplacé par un faux qui capture les envois.
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'maxiconfort-v7.html'), 'utf8');
function extraireBloc(debut, fin) { const i = html.indexOf(debut), j = html.indexOf(fin, i); if (i < 0 || j < 0) throw new Error('bloc introuvable : ' + debut); return html.slice(i, j); }
function extraireFonction(signature) { const i = html.indexOf(signature); if (i < 0) throw new Error('fonction introuvable : ' + signature);
  let k = html.indexOf('{', i), n = 0, dansChaine = null, ech = false;
  for (let p = k; p < html.length; p++) { const ch = html[p];
    if (dansChaine) { if (ech) ech = false; else if (ch === '\\') ech = true; else if (ch === dansChaine) dansChaine = null; continue; }
    if (ch === '/' && html[p + 1] === '/') { p = html.indexOf('\n', p); continue; }
    if (ch === "'" || ch === '"' || ch === '`') { dansChaine = ch; continue; }
    if (ch === '{') n++; else if (ch === '}') { n--; if (n === 0) return html.slice(i, p + 1); } }
  throw new Error('accolade non refermée : ' + signature); }

// ---------- faux navigateur (juste ce qu'il faut pour la fenêtre de motif) ----------
function nouveauBac(roleS) {
  const parId = {}; const envois = [], tournee = [];
  const element = tag => { const e = { tag, style: {}, children: [], value: '', textContent: '', dataset: {}, classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild(c) { e.children.push(c); c.parent = e; return c; }, remove() { if (e.parent) e.parent.children = e.parent.children.filter(x => x !== e); bac._fenetre = null; }, set id(v) { e._id = v; parId[v] = e; }, get id() { return e._id; } }; return e; };
  const body = element('body'); const origAppend = body.appendChild; body.appendChild = c => { bac._fenetre = c; return origAppend(c); };
  const bac = { console, setTimeout: () => 0, Math, Date, JSON, parseFloat, parseInt, String, Array, Object, Number, isNaN,
    SUPABASE_URL: 'https://exemple.invalid', SUPABASE_KEY: 'cle-de-test',
    document: { body, createElement: element, getElementById: id => (parId[id] && bac._fenetre ? parId[id] : null), querySelectorAll: () => [], querySelector: () => null },
    localStorage: { setItem() {}, getItem() { return null; } },
    fetch: async (url, opt) => { envois.push({ url, body: JSON.parse(opt.body) }); return { ok: true, text: async () => '' }; },
    offlineQueueAdd() {}, showSync() {}, toast(m, t) { bac._toasts.push([m, t]); }, _toasts: [], _fenetre: null,
    commandes: [], tournees: [], livNom: roleS === 'livreur' ? 'RANOU' : '', role: roleS, stockCamion: [],
    stkDeduireStock() {}, stkReCrediterStock() {}, reconcilierTournees() {}, renderCmds() {}, renderDash() {}, renderTournees() {}, renderLivreur() {}, suiviAppliquerFiltres() {},
    closePanel() {}, ouvrirCmd() {}, sbSaveTournee(t) { tournee.push(JSON.parse(JSON.stringify(t))); }, retirerStockCamion() {}, paiVerrouBody() {}, findCmdForStop(s) { return bac.commandes.find(c => c.id === s.cmdId) || null; } };
  vm.createContext(bac);
  vm.runInContext(extraireBloc('// ANN-DEBUT', '// ANN-FIN'), bac);
  for (const f of ['async function sbSaveCommande(cmd)', 'function chgStatut(id, st, _annOk)', 'function setLvSt(tid, idx, st, _annOk)']) vm.runInContext(extraireFonction(f), bac);
  return { bac, envois, tournee, champ: id => parId[id] };
}
let ok = 0, ko = 0; const test = (nom, cond, det) => { if (cond) { ok++; console.log('  OK   ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (det !== undefined ? ' — ' + JSON.stringify(det) : '')); } };
const attendre = () => new Promise(r => setImmediate(r));
const cmd = plus => Object.assign({ id: '#T1', client: 'CLIENT TEST', tel: '', adresse: 'ADRESSE 75000 Paris', produit: 'TEST', prix: 100, statut: 'en-attente', paie: 'Espèces', stpaie: 'Non payé', montantEnc: 0, livreur: 'RANOU', origine: 'LeBonCoin' }, plus);

(async () => {
  console.log('\n1. LISTE DES MOTIFS ET RÈGLES DE SAISIE');
  let { bac } = nouveauBac('admin'); const M = vm.runInContext('ANN_MOTIFS', bac);
  test('les 8 motifs demandés + « Motif inconnu / non communiqué par le client »', M.length === 9 && ['Rupture de stock', 'Délai trop long', 'Client injoignable', 'Client a changé d\'avis', 'Problème de livraison', 'Prix / désaccord commercial', 'Doublon / erreur de commande', 'Autre', 'Motif inconnu / non communiqué par le client'].every(x => M.includes(x)), M);
  test('aucun motif choisi : refusé', bac.annMotifErreur('', '') !== '');
  test('motif hors liste : refusé', bac.annMotifErreur('N\'importe quoi', '') !== '');
  test('« Autre » sans commentaire : refusé', bac.annMotifErreur('Autre', '  ') !== '');
  test('« Autre » avec commentaire : accepté', bac.annMotifErreur('Autre', 'client parti') === '');
  test('motif de la liste sans commentaire : accepté', bac.annMotifErreur('Client injoignable', '') === '');
  test('commande non annulée : aucun champ d\'annulation envoyé', Object.keys(bac.annCorps(cmd({ annMotif: 'Autre' }))).length === 0);
  test('commande annulée sans motif saisi (simple ré-enregistrement) : aucun champ envoyé', Object.keys(bac.annCorps(cmd({ statut: 'annulé' }))).length === 0);

  console.log('\n2. FICHE DU BUREAU : ANNULER DEMANDE LE MOTIF AVANT TOUT');
  let B = nouveauBac('admin'); bac = B.bac; bac.commandes.push(cmd());
  bac.chgStatut('#T1', 'annulé'); await attendre();
  test('la fenêtre de motif s\'ouvre', !!bac._fenetre && bac._fenetre.id === 'm-ann-motif');
  test('tant que le motif n\'est pas confirmé : statut inchangé et RIEN n\'est envoyé à la base', bac.commandes[0].statut === 'en-attente' && B.envois.length === 0, [bac.commandes[0].statut, B.envois.length]);
  B.champ('ann-motif-ok').onclick(); await attendre();
  test('« Confirmer » sans motif : refusé, la fenêtre reste, rien n\'est envoyé', !!bac._fenetre && bac.commandes[0].statut === 'en-attente' && B.envois.length === 0);
  B.champ('ann-motif-sel').value = 'Autre'; B.champ('ann-motif-ok').onclick(); await attendre();
  test('« Autre » sans commentaire : refusé', !!bac._fenetre && bac.commandes[0].statut === 'en-attente' && B.envois.length === 0);
  B.champ('ann-motif-non').onclick(); await attendre();
  test('« Ne pas annuler » : la commande n\'est pas modifiée, rien n\'est envoyé', !bac._fenetre && bac.commandes[0].statut === 'en-attente' && B.envois.length === 0);
  bac.chgStatut('#T1', 'annulé'); B.champ('ann-motif-sel').value = 'Client injoignable'; B.champ('ann-motif-ok').onclick(); await attendre();
  let e = B.envois[B.envois.length - 1];
  test('motif confirmé : la commande passe « annulé »', bac.commandes[0].statut === 'annulé');
  test('l\'enregistrement emporte le motif', !!e && e.body.statut === 'annulé' && e.body.annulation_motif === 'Client injoignable' && e.body.annulation_commentaire === null, e && e.body);
  test('le paiement envoyé est celui de la fiche, sans changement', e.body.paie === 'Espèces' && e.body.stpaie === 'Non payé' && e.body.montant_enc === 0, [e.body.paie, e.body.stpaie, e.body.montant_enc]);
  const n = B.envois.length; bac.chgStatut('#T1', 'en-attente'); await attendre(); e = B.envois[B.envois.length - 1];
  test('remise « en attente » : aucune fenêtre, aucun champ d\'annulation envoyé', !bac._fenetre && B.envois.length === n + 1 && !('annulation_motif' in e.body), e.body);
  bac.chgStatut('#T1', 'livré'); await attendre();
  test('les autres statuts (livré…) ne demandent aucun motif', !bac._fenetre && bac.commandes[0].statut === 'livré');
  bac.chgStatut('#T1', 'annulé'); B.champ('ann-motif-sel').value = 'Autre'; B.champ('ann-motif-com').value = '  erreur de saisie du client  '; B.champ('ann-motif-ok').onclick(); await attendre(); e = B.envois[B.envois.length - 1];
  test('« Autre » + commentaire : envoyés (commentaire nettoyé)', e.body.annulation_motif === 'Autre' && e.body.annulation_commentaire === 'erreur de saisie du client', e.body);

  console.log('\n3. CARTE DU LIVREUR : MÊME RÈGLE');
  B = nouveauBac('livreur'); bac = B.bac; bac.commandes.push(cmd()); bac.tournees.push({ id: 'T1', statut: 'en cours', livreur: 'RANOU', stops: [{ cmdId: '#T1', client: 'CLIENT TEST', statut: 'arrivé', prix: 100 }, { cmdId: '#T2', client: 'AUTRE', statut: 'en-attente', prix: 50 }] });
  bac.setLvSt('T1', 0, 'annulé'); await attendre();
  test('la fenêtre de motif s\'ouvre', !!bac._fenetre);
  test('sans motif confirmé : arrêt et commande inchangés, rien n\'est envoyé', bac.tournees[0].stops[0].statut === 'arrivé' && bac.commandes[0].statut === 'en-attente' && B.envois.length === 0 && B.tournee.length === 0);
  B.champ('ann-motif-sel').value = 'Motif inconnu / non communiqué par le client'; B.champ('ann-motif-ok').onclick(); await attendre(); e = B.envois[B.envois.length - 1];
  test('motif confirmé : arrêt et commande « annulé », motif envoyé avec la commande', bac.tournees[0].stops[0].statut === 'annulé' && bac.commandes[0].statut === 'annulé' && !!e && e.body.annulation_motif === 'Motif inconnu / non communiqué par le client', e && e.body);
  test('la tournée est enregistrée une fois', B.tournee.length === 1);
  bac.setLvSt('T1', 1, 'reporté'); await attendre();
  test('« reporté » ne demande aucun motif d\'annulation', !bac._fenetre && bac.tournees[0].stops[1].statut === 'reporté');

  console.log(`\nRÉSULTAT : ${ok} tests réussis, ${ko} échec(s)`); process.exitCode = ko ? 1 : 0;
})().catch(e => { console.error('ERREUR :', e.stack || e.message); process.exit(1); });
