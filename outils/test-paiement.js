// Banc de test du correctif paiement v7.5.113 (03/10/2026).
// Usage : node outils/test-paiement.js
// Il EXTRAIT le vrai code de maxiconfort-v7.html (fonctions de paiement, sbSaveCommande,
// signature du livreur) et l'exécute dans un bac à sable : aucune connexion à la base,
// aucune donnée réelle. `fetch` est remplacé par un faux qui capture ce qui serait envoyé.
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'maxiconfort-v7.html'), 'utf8');

function extraireBloc(debut, fin) { const i = html.indexOf(debut), j = html.indexOf(fin, i); if (i < 0 || j < 0) throw new Error('bloc introuvable : ' + debut); return html.slice(i, j); }
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

// ---------- faux navigateur ----------
function fauxElement(id) { return { id, value: '', checked: true, style: {}, dataset: {}, innerHTML: '', textContent: '', disabled: false, classList: { add() {}, remove() {}, contains() { return false; } }, querySelectorAll() { return []; }, parentNode: null }; }
function nouveauBac() {
  const els = {}; const envois = []; const sauvegardesTournee = [];
  const bac = {
    console, setTimeout: (f) => 0, Math, Date, JSON, parseFloat, parseInt, String, Array, Object, Number, isNaN,
    SUPABASE_URL: 'https://exemple.invalid', SUPABASE_KEY: 'cle-de-test',
    document: { getElementById: id => (els[id] = els[id] || fauxElement(id)), querySelectorAll: () => [], querySelector: () => null },
    localStorage: { setItem() {}, getItem() { return null; } },
    fetch: async (url, opt) => { envois.push({ url, body: JSON.parse(opt.body) }); return { ok: true, text: async () => '' }; },
    offlineQueueAdd() {}, showSync() {}, toast(m, t) { bac._toasts.push([m, t]); }, _toasts: [],
    commandes: [], tournees: [], livNom: 'RANOU', role: 'livreur', societe: { tel: '' },
    stkDeduireStock() {}, clearSig() {}, renderLivreur() {}, renderTournees() {}, renderCmds() {}, renderDash() {}, finRender() {},
    sbSaveTournee(t) { sauvegardesTournee.push(JSON.parse(JSON.stringify(t))); }, notifAjout(...a) { bac._notifs.push(a); }, _notifs: [],
    confirm: () => false, genererBonLivraison() {}, brevoSendSMS: async () => false, cmdOrigineMarketplace: () => null,
    findCmdForStop(s) { return bac.commandes.find(c => c.id === s.cmdId) || null; },
  };
  vm.createContext(bac);
  vm.runInContext(extraireBloc('var PAI_MODE_SITE', '// PAI-FIN'), bac);
  vm.runInContext(extraireFonction('async function sbSaveCommande(cmd)'), bac);
  vm.runInContext('var sigStopId=null, sigPaieEncaisse=false, sigPaieMode="Espèces", sigPrepaidMode=null, sigCmdMarketplace=null, sigCtx=null, scv=null;', bac);
  vm.runInContext('var sigCodActif=false, sigCodChoix=null, sigCodMontant=0;', bac);
  for (const f of ['function _sigPaieBtns(actif)', 'function sigTogglePaie(encaisse)', 'function sigDejaPaye()', 'function sigSelectMode(mode)', 'function sigCodChoisir(ch)', 'function paiSigPreparer(cmdSig, banner)', 'function validerSig()', 'function chgStopPaie(tid, idx, val)', 'function chgPaieMode(id, val)', 'function chgPaieStatut(id, val)'])
    vm.runInContext(extraireFonction(f), bac);
  return { bac, els, envois, sauvegardesTournee };
}

let ok = 0, ko = 0;
function test(nom, cond, detail) { if (cond) { ok++; console.log('  OK   ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (detail ? ' — ' + detail : '')); } }
const SITE = (plus) => Object.assign({ id: '#T1', client: 'Client Test', tel: '', adresse: '1 rue du Test 75001 Paris', produit: 'Ensemble 140x190', prix: 259, prixBrut: 259, paie: 'Site Maxiconfort', stpaie: 'Payé', montantEnc: 259, livreur: '', statut: 'en-attente', date: '2026-10-05', instr: 'Commande site #9999. ', origine: 'Site Maxiconfort', refMarketplace: '7000000000001', transporteur: 'RANOU' }, plus || {});
const COD = (plus) => SITE(Object.assign({ id: '#T2', prix: 269, prixBrut: 269, paie: 'Espèces', stpaie: 'Non payé', montantEnc: 0, instr: 'Commande site #9998. 💵 PAIEMENT À LA LIVRAISON : 269 € à encaisser (espèces ou CB). ', refMarketplace: '7000000000002' }, plus || {}));
const LBC = (plus) => Object.assign({ id: '#T3', client: 'Client LBC', prix: 180, paie: 'Espèces', stpaie: 'Non payé', montantEnc: 0, statut: 'en-attente', instr: '', origine: 'LeBonCoin', refMarketplace: '', transporteur: 'RANOU' }, plus || {});

(async () => {
  // ══════════ 1. Classement ══════════
  console.log('\n1. CLASSEMENT DES COMMANDES');
  { const { bac } = nouveauBac(); const S = c => bac.paiSituation(c);
    test('payée en ligne -> en_ligne, reste 0 €', S(SITE()).type === 'en_ligne' && S(SITE()).du === 0);
    test('payée en ligne mal étiquetée « Espèces » (historique) -> toujours en_ligne', S(SITE({ paie: 'Espèces' })).type === 'en_ligne');
    test('paiement à la livraison non livré -> à encaisser 269 €', S(COD()).type === 'cod_a_encaisser' && S(COD()).du === 269);
    test('paiement à la livraison avec décimales (312.55 €) reconnu', S(COD({ prix: 312.55, instr: '💵 PAIEMENT À LA LIVRAISON : 312.55 € à encaisser (espèces ou CB). ' })).du === 312.55);
    test('paiement à la livraison encaissé CB -> cod_encaisse, reste 0 €', S(COD({ paie: 'CB', stpaie: 'Payé', montantEnc: 269, statut: 'livré' })).type === 'cod_encaisse' && S(COD({ paie: 'CB', stpaie: 'Payé', montantEnc: 269, statut: 'livré' })).du === 0);
    test('paiement à la livraison livré non encaissé -> cod_non_encaisse, reste 269 €', S(COD({ statut: 'livré' })).type === 'cod_non_encaisse' && S(COD({ statut: 'livré' })).du === 269);
    test('commande du site non payée sans consigne -> anomalie (à encaisser, jamais « payée »)', S(SITE({ stpaie: 'Non payé', montantEnc: 0 })).type === 'anomalie' && bac.paiAEncaisser(SITE({ stpaie: 'Non payé', montantEnc: 0 })));
    test('autre origine (LeBonCoin) -> autre : comportement inchangé', S(LBC()).type === 'autre');
    test('origine site saisie à la main sans identifiant Shopify -> autre', S(SITE({ refMarketplace: '' })).type === 'autre');
    test('bandeau payée en ligne : « DÉJÀ PAYÉ EN LIGNE » + « 0 € »', /DÉJÀ PAYÉ EN LIGNE/.test(bac.paiBandeau(SITE(), true)) && /Reste à encaisser : 0 €/.test(bac.paiBandeau(SITE(), true)));
    test('bandeau paiement à la livraison : « À ENCAISSER : 269 € »', /PAIEMENT À LA LIVRAISON/.test(bac.paiBandeau(COD(), true)) && /À ENCAISSER : 269 €/.test(bac.paiBandeau(COD(), true)));
    test('bandeau après encaissement CB : « ENCAISSÉ À LA LIVRAISON », « CB : 269 € », « Reste dû : 0 € »', /ENCAISSÉ À LA LIVRAISON/.test(bac.paiBandeau(COD({ paie: 'CB', stpaie: 'Payé', montantEnc: 269, statut: 'livré' }), true)) && /CB : 269 € · Reste dû : 0 €/.test(bac.paiBandeau(COD({ paie: 'CB', stpaie: 'Payé', montantEnc: 269, statut: 'livré' }), true)));
    test('aucun bandeau pour une autre origine', bac.paiBandeau(LBC(), true) === '' && bac.paiBadge(LBC()) === '');
    test('arrêt de tournée : jamais « Espèces » pour une payée en ligne', bac.paiModeStop(SITE({ paie: 'Espèces' })) === 'Site Maxiconfort' && bac.paiModeStop(COD()) === 'Espèces' && bac.paiModeStop(LBC({ paie: 'CB' })) === 'CB');
  }

  // ══════════ 2. Enregistrement de la fiche (cause A de l'anomalie) ══════════
  console.log('\n2. ENREGISTREMENT DE LA FICHE COMMANDE');
  { const { bac } = nouveauBac(); const avant = SITE();
    // le formulaire renvoie un mode VIDE (la liste n'avait pas « Site Maxiconfort ») : c'était le bug
    const formulaire = (plus) => Object.assign({}, avant, { paie: '', stpaie: 'Payé', montantEnc: 259 }, plus);
    for (const [nom, plus] of [['date', { date: '2026-10-09' }], ['livreur', { livreur: 'RANOU' }], ['adresse', { adresse: '99 avenue Modifiée 93100 Montreuil' }], ['commentaire', { instr: 'Commande site #9999. Appeler avant de passer.' }], ['produit', { produit: 'Ensemble 160x200', prix: 279, prixBrut: 279 }]]) {
      const apres = bac.paiProtegerEdition(avant, formulaire(plus));
      test(`modification ${nom} : mode « Site Maxiconfort », statut « Payé », montant payé 259 €`, apres.paie === 'Site Maxiconfort' && apres.stpaie === 'Payé' && apres.montantEnc === 259, JSON.stringify([apres.paie, apres.stpaie, apres.montantEnc])); }
    const force = bac.paiProtegerEdition(avant, formulaire({ paie: 'Espèces', stpaie: 'Non payé', montantEnc: 0 }));
    test('même si le formulaire renvoie « Espèces / Non payé / 0 € » : paiement inchangé', force.paie === 'Site Maxiconfort' && force.stpaie === 'Payé' && force.montantEnc === 259);
    const orig = bac.paiProtegerEdition(avant, formulaire({ origine: '', refMarketplace: '' }));
    test("l'origine et l'identifiant Shopify ne peuvent pas être effacés", orig.origine === 'Site Maxiconfort' && orig.refMarketplace === '7000000000001');
    const cod = bac.paiProtegerEdition(COD(), Object.assign({}, COD(), { instr: 'Sonner deux fois.' }));
    test('paiement à la livraison : la consigne « à encaisser » ne peut pas être effacée par un commentaire', /PAIEMENT À LA LIVRAISON : 269 € à encaisser/.test(cod.instr) && /Sonner deux fois/.test(cod.instr) && bac.paiSituation(cod).type === 'cod_a_encaisser', cod.instr);
    const lbc = bac.paiProtegerEdition(LBC({ paie: 'LeBonCoin', stpaie: 'Payé' }), Object.assign({}, LBC({ paie: '', stpaie: 'Payé' })));
    test('autre origine : un mode absent de la liste n\'est plus remplacé par « Espèces »', lbc.paie === 'LeBonCoin');
    const libre = bac.paiProtegerEdition(LBC({ paie: 'Espèces' }), LBC({ paie: 'CB', stpaie: 'Payé' }));
    test('autre origine : le mode reste modifiable normalement', libre.paie === 'CB' && libre.stpaie === 'Payé');
  }

  // ══════════ 3. Écriture en base : vrai sbSaveCommande, faux réseau ══════════
  console.log('\n3. ÉCRITURE EN BASE (vraie fonction sbSaveCommande, réseau simulé)');
  { const scenarios = [['date de livraison', c => { c.date = '2026-10-09'; }, b => b.date_livraison === '2026-10-09'], ['livreur', c => { c.livreur = 'RANOU'; }, b => b.livreur === 'RANOU'], ['tournée (livreur + date)', c => { c.livreur = 'RANOU'; c.date = '2026-10-06'; }, b => b.livreur === 'RANOU' && b.date_livraison === '2026-10-06'], ['adresse', c => { c.adresse = '99 avenue Modifiée 93100 Montreuil'; }, b => /Montreuil/.test(b.adresse)], ['commentaire', c => { c.instr += 'Appeler avant.'; }, b => /Appeler avant/.test(b.instr)], ['statut de livraison -> reporté', c => { c.statut = 'reporté'; }, b => b.statut === 'reporté'], ['statut de livraison -> livré', c => { c.statut = 'livré'; }, b => b.statut === 'livré'], ['produit et prix', c => { c.produit = 'Ensemble 160x200'; c.prix = 279; }, b => b.prix === 279]];
    for (const [nom, modif, attendu] of scenarios) { const { bac, envois } = nouveauBac(); const c = SITE(); modif(c); await bac.sbSaveCommande(c); const b = envois[0].body;
      test(`payée en ligne, modification ${nom} : ni mode, ni statut, ni montant envoyés à la base ; la modification, elle, est envoyée`, !('paie' in b) && !('stpaie' in b) && !('montant_enc' in b) && attendu(b), JSON.stringify({ paie: b.paie, stpaie: b.stpaie, montant_enc: b.montant_enc })); }
    { const { bac, envois } = nouveauBac(); const c = SITE({ paie: '' }); c.date = '2026-10-09'; await bac.sbSaveCommande(c);
      test('mémoire abîmée (mode vide) : « Espèces » n\'est PAS écrit en base', !('paie' in envois[0].body)); }
    { const { bac, envois } = nouveauBac(); const c = SITE({ paie: 'Espèces' }); c.livreur = 'RANOU'; await bac.sbSaveCommande(c);
      test('commande historique mal étiquetée : son libellé n\'est ni réécrit ni corrigé (aucune correction rétroactive)', !('paie' in envois[0].body) && !('stpaie' in envois[0].body)); }
    { const { bac, envois } = nouveauBac(); const c = COD(); c.livreur = 'RANOU'; await bac.sbSaveCommande(c); const b = envois[0].body;
      test('paiement à la livraison : statut « Non payé » et 0 € bien écrits (le livreur devra encaisser)', b.stpaie === 'Non payé' && b.montant_enc === 0 && b.paie === 'Espèces'); }
    { const { bac, envois } = nouveauBac(); const c = LBC({ paie: 'CB', stpaie: 'Payé', montantEnc: 180 }); await bac.sbSaveCommande(c); const b = envois[0].body;
      test('autre origine : paiement écrit comme avant (aucune régression)', b.paie === 'CB' && b.stpaie === 'Payé' && b.montant_enc === 180); }
    { const { bac, envois } = nouveauBac(); const c = SITE({ _nouveau: true }); await bac.sbSaveCommande(c);
      test('création d\'une commande : le paiement saisi est bien écrit', envois[0].body.paie === 'Site Maxiconfort' && envois[0].body.stpaie === 'Payé'); }
    { const { bac, envois } = nouveauBac(); const c = SITE({ _finOK: true, paie: 'Virement' }); await bac.sbSaveCommande(c);
      test('modification financière volontaire de l\'administrateur (confirmée) : autorisée', envois[0].body.paie === 'Virement'); }
  }

  // ══════════ 4. Écran du livreur : vraie fonction de signature ══════════
  console.log('\n4. SIGNATURE DU LIVREUR (vraies fonctions paiSigPreparer et validerSig)');
  const preparer = (cmd) => { const x = nouveauBac(); const { bac, els } = x; bac.commandes = [cmd]; const stop = { cmdId: cmd.id, client: cmd.client, produit: cmd.produit, prix: cmd.prix, paie: bac.paiModeStop(cmd), stpaie: cmd.stpaie, statut: 'en-route', tel: '' }; bac.tournees = [{ id: 'T-TEST', livreur: 'RANOU', date: '2026-10-03', statut: 'en cours', stops: [stop] }];
    bac.document.getElementById('sig-nom').value = 'Signataire Test'; bac.document.getElementById('sig-legal-check').checked = true; vm.runInContext('sigStopId = { tid: "T-TEST", idx: 0 };', bac);
    const pris = bac.paiSigPreparer(cmd, bac.document.getElementById('sig-prepaye-banner')); return Object.assign(x, { stop, pris }); };
  { // 4a. payée en ligne (cas réel des #1855 et #1823 : étiquetées « Espèces » en base)
    const cmd = SITE({ id: '#1855-test', prix: 199, montantEnc: 199, paie: 'Espèces' }); const { bac, els, envois, stop, pris, sauvegardesTournee } = preparer(cmd);
    test('payée en ligne : l\'application prend la main, la question « Paiement ? » est masquée', pris === true && els['sig-paie-question'].style.display === 'none' && els['sig-paie-mode-wrap'].style.display === 'none');
    test('payée en ligne : bandeau « DÉJÀ PAYÉ EN LIGNE — 0 € À ENCAISSER »', /DÉJÀ PAYÉ EN LIGNE/.test(els['sig-prepaye-banner'].innerHTML) && /0 € À ENCAISSER/.test(els['sig-prepaye-banner'].innerHTML));
    test('payée en ligne : aucun bouton d\'encaissement proposé', !els['sig-cod-wrap'] || els['sig-cod-wrap'].style.display === 'none');
    bac.validerSig();
    test('payée en ligne, livraison signée : arrêt « Site Maxiconfort / Payé », RIEN en espèces', stop.statut === 'livré' && stop.paie === 'Site Maxiconfort' && stop.stpaie === 'Payé', JSON.stringify([stop.paie, stop.stpaie]));
    const esp = sauvegardesTournee[0].stops.filter(s => s.statut === 'livré' && s.paie === 'Espèces').reduce((a, s) => a + s.prix, 0);
    test('payée en ligne, livraison signée : espèces attendues de la tournée = 0 €', esp === 0);
    test('payée en ligne, livraison signée : statut « livré » écrit, paiement non réécrit en base', envois[0].body.statut === 'livré' && !('paie' in envois[0].body) && !('stpaie' in envois[0].body) && !('montant_enc' in envois[0].body)); }
  { // 4b. le livreur tente de changer le mode sur la carte
    const cmd = SITE(); const { bac, envois, stop } = preparer(cmd); bac.chgStopPaie('T-TEST', 0, 'Espèces');
    test('payée en ligne : changer le mode en « Espèces » depuis la carte est refusé', stop.paie === 'Site Maxiconfort' && cmd.paie === 'Site Maxiconfort' && envois.length === 0); }
  { // 4c. paiement à la livraison : aucun choix présélectionné, validation bloquée
    const cmd = COD(); const { bac, els, envois, stop, pris } = preparer(cmd);
    test('paiement à la livraison : avertissement « MONTANT À ENCAISSER : 269 € »', pris === true && /PAIEMENT À LA LIVRAISON/.test(els['sig-cod-titre'].innerHTML) && /MONTANT À ENCAISSER : 269 €/.test(els['sig-cod-titre'].innerHTML) && els['sig-cod-wrap'].style.display === 'block');
    test('paiement à la livraison : aucun choix présélectionné', vm.runInContext('sigCodChoix', bac) === null && vm.runInContext('sigCodActif', bac) === true);
    bac.validerSig();
    test('paiement à la livraison : signature REFUSÉE tant que le livreur n\'a rien déclaré', stop.statut !== 'livré' && envois.length === 0 && /ESPÈCES, CB ou NON ENCAISSÉ/.test((bac._toasts[0] || [''])[0])); }
  { // 4d. encaissé par CB avec ticket
    const cmd = COD(); const { bac, els, envois, stop, sauvegardesTournee } = preparer(cmd); bac.sigCodChoisir('cb');
    test('choix CB : le champ « n° de ticket » apparaît', els['sig-cod-ticket-wrap'].style.display === 'block'); els['sig-cod-ticket'].value = '0042'; bac.validerSig(); const b = envois[0].body;
    test('encaissé CB : commande « CB / Payé / 269 € », reste dû 0 €', b.paie === 'CB' && b.stpaie === 'Payé' && b.montant_enc === 269 && bac.paiSituation(cmd).type === 'cod_encaisse' && bac.paiSituation(cmd).du === 0);
    test('encaissé CB : trace avec montant, ticket, livreur, date et heure', /Encaissé à la livraison : CB 269 € — ticket n° 0042 \(RANOU, \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}\)/.test(b.instr), b.instr);
    test('encaissé CB : arrêt « CB / Payé », détail de l\'encaissement conservé sur l\'arrêt', stop.paie === 'CB' && stop.stpaie === 'Payé' && stop.enc && stop.enc.choix === 'cb' && stop.enc.montant === 269 && stop.enc.ticket === '0042' && stop.enc.par === 'RANOU' && !!stop.enc.at);
    test('encaissé CB : la consigne d\'origine reste dans la fiche', /PAIEMENT À LA LIVRAISON : 269 € à encaisser/.test(b.instr)); }
  { // 4e. encaissé en espèces
    const cmd = COD(); const { bac, envois, stop, sauvegardesTournee } = preparer(cmd); bac.sigCodChoisir('esp'); bac.validerSig(); const b = envois[0].body;
    const esp = sauvegardesTournee[0].stops.filter(s => s.statut === 'livré' && s.stpaie === 'Payé' && s.paie === 'Espèces').reduce((a, s) => a + s.prix, 0);
    test('encaissé espèces : commande « Espèces / Payé / 269 € »', b.paie === 'Espèces' && b.stpaie === 'Payé' && b.montant_enc === 269);
    test('encaissé espèces : 269 € entrent dans les espèces attendues de la tournée', esp === 269); }
  { // 4f. non encaissé
    const cmd = COD(); const { bac, envois, stop } = preparer(cmd); bac.sigCodChoisir('non'); bac.validerSig(); const b = envois[0].body;
    test('non encaissé : la commande reste « Non payé », 0 € encaissé, jamais « Payée »', b.stpaie === 'Non payé' && b.montant_enc === 0 && stop.stpaie === 'Non payé');
    test('non encaissé : classée « LIVRÉ — NON ENCAISSÉ », reste dû 269 €', bac.paiSituation(cmd).type === 'cod_non_encaisse' && bac.paiSituation(cmd).du === 269);
    test('non encaissé : alerte créée + trace dans la fiche', bac._notifs.some(n => /NON ENCAISSÉ/.test(n[2])) && /NON ENCAISSÉ à la livraison : 269 € restent dus/.test(b.instr));
    test('non encaissé : ressort dans le filtre « Impayés / anomalies »', bac.paiFiltre(cmd, 'anomalie') && bac.paiFiltre(cmd, 'cod_ko') && !bac.paiFiltre(cmd, 'cod_ok')); }
  { // 4g. autres origines : écran habituel
    const cmd = LBC(); const { pris, els } = preparer(cmd);
    test('autre origine : l\'écran de signature habituel n\'est pas modifié', pris === false && (!els['sig-cod-wrap'] || els['sig-cod-wrap'].style.display === 'none')); }

  // ══════════ 5. Filtres et tableau de bord ══════════
  console.log('\n5. FILTRES ET TABLEAU DE BORD');
  { const { bac } = nouveauBac(); const L = [SITE({ dateCmd: '2026-10-02' }), SITE({ id: '#h', paie: 'Espèces', statut: 'livré', dateCmd: '2026-10-01' }), COD({ dateCmd: '2026-10-02' }), COD({ id: '#c2', paie: 'CB', stpaie: 'Payé', montantEnc: 269, statut: 'livré', dateCmd: '2026-10-01' }), COD({ id: '#c3', statut: 'livré', dateCmd: '2026-10-03' }), LBC({ id: '#l1', paie: 'Espèces', stpaie: 'Payé', montantEnc: 180, statut: 'livré', dateCmd: '2026-10-02' }), LBC({ id: '#l2', statut: 'livré', dateCmd: '2026-10-02' }), SITE({ id: '#vieux', dateCmd: '2026-09-15' })];
    const n = v => L.filter(c => bac.paiFiltre(c, v)).length;
    test('filtre « Payées en ligne » : 3', n('en_ligne') === 3); test('filtre « Paiement à la livraison » : 3', n('cod') === 3);
    test('filtre « Paiement à la livraison encaissé » : 1', n('cod_ok') === 1); test('filtre « Paiement à la livraison non encaissé » : 2', n('cod_ko') === 2);
    test('filtre « Impayés / anomalies » : 2 (1 paiement à la livraison livré non encaissé + 1 LeBonCoin livré non payé)', n('anomalie') === 2);
    const r = bac.paiTotaux(L, '2026-10');
    test('tableau de bord — PAYÉ EN LIGNE : 518 € (2 commandes d\'octobre, dont celle étiquetée « Espèces »)', r.enLigne === 518 && r.nEnLigne === 2, JSON.stringify(r));
    test('tableau de bord — À ENCAISSER À LA LIVRAISON : 269 €', r.aEncaisser === 269 && r.nAEncaisser === 1);
    test('tableau de bord — ENCAISSÉ ESPÈCES PAR LIVREURS : 180 € (la payée en ligne étiquetée « Espèces » n\'y est PAS)', r.especes === 180);
    test('tableau de bord — ENCAISSÉ CB PAR LIVREURS : 269 €', r.cb === 269);
    test('tableau de bord — NON ENCAISSÉ : 449 € (269 + 180), 2 commandes', r.nonEncaisse === 449 && r.nNonEncaisse === 2); }

  console.log(`\nRÉSULTAT : ${ok} tests réussis, ${ko} échec(s)`);
  process.exit(ko ? 1 : 0);
})().catch(e => { console.error('ERREUR DU BANC DE TEST :', e); process.exit(2); });
