// Banc de test « Validation livreur simplifiée et Retour de tournée » (v7.5.129, 25/11/2026).
// Usage : node outils/test-retour-tournee.js
// Il EXTRAIT le vrai code de maxiconfort-v7.html (bloc RT-DEBUT … RT-FIN, bloc paiement PAI, signature
// validerSig, setLvSt, report, clôture) et l'exécute dans un bac à sable : aucune connexion à la base,
// aucune donnée réelle. `fetch` est remplacé par un faux qui capture ce qui serait envoyé.
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'maxiconfort-v7.html'), 'utf8').replace(/\r\n/g, '\n');

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
let ok = 0, ko = 0;
function test(nom, cond, detail) { if (cond) { ok++; console.log('  OK    ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : '')); } }
const attendre = () => new Promise((r) => setImmediate(r));

// ---------- faux navigateur ----------
function fauxElement(id) { return { id, value: '', checked: true, open: false, style: {}, dataset: {}, innerHTML: '', textContent: '', disabled: false, classList: { add() {}, remove() {}, contains() { return false; } }, querySelectorAll() { return []; }, insertAdjacentHTML() {}, remove() {}, parentNode: null }; }
function nouveauBac(role) {
  const els = {}; const envois = []; const tourneesSauvees = [];
  const bac = {
    console, setTimeout: (f) => 0, Math, Date, JSON, parseFloat, parseInt, String, Array, Object, Number, isNaN,
    SUPABASE_URL: 'https://exemple.invalid', SUPABASE_KEY: 'cle-de-test',
    document: { getElementById: (id) => (els[id] = els[id] || fauxElement(id)), querySelectorAll: () => [], querySelector: () => null },
    localStorage: { setItem() {}, getItem() { return null; } },
    fetch: async (url, opt) => { envois.push({ url, body: JSON.parse(opt.body) }); return { ok: true, text: async () => '' }; },
    offlineQueueAdd() {}, showSync() {}, toast(m, t) { bac._toasts.push([m, t]); }, _toasts: [],
    commandes: [], tournees: [], depenses: [], livNom: 'RANOU', role: role || 'livreur', societe: { tel: '' }, stockCamion: [], LV_APERCU_ACTIF: false,
    stkDeduireStock() {}, clearSig() {}, renderLivreur() {}, renderTournees() {}, renderCmds() {}, renderDash() {}, finRender() {},
    sbSaveTournee(t) { tourneesSauvees.push(JSON.parse(JSON.stringify(t))); }, notifAjout(...a) { bac._notifs.push(a); }, _notifs: [],
    confirm: () => bac._confirm, _confirm: true, genererBonLivraison() {}, brevoSendSMS: async () => false, cmdOrigineMarketplace: () => null,
    findCmdForStop(s) { return bac.commandes.find((c) => c.id === s.cmdId) || null; }, findStopForCmd: () => null, retirerStockCamion() {}, _mx: {}, mxLire(k) { return Object.prototype.hasOwnProperty.call(bac._mx, k) ? bac._mx[k] : null; }, mxEcrire(k, v) { bac._mx[k] = v; }, mxSupprimer(k) { delete bac._mx[k]; },
    sendCmdSmsAsync() {}, annDemanderMotif() {}, fmtDate: (d) => d, paiVerrouBody() {},
  };
  vm.createContext(bac);
  vm.runInContext(extraireBloc('var PAI_MODE_SITE', '// PAI-FIN'), bac);
  vm.runInContext(extraireBloc('// ── RT-DEBUT', '// RT-FIN'), bac);
  vm.runInContext(extraireFonction('function syncRefusDefinitif(status)') + ' ' + extraireFonction('function syncMessageRefus(status, texte)') + ' ' + extraireFonction('async function sbSaveCommande(cmd, opts)'), bac);
  vm.runInContext('var sigStopId=null, sigPaieEncaisse=false, sigPaieMode="Espèces", sigPrepaidMode=null, sigCmdMarketplace=null, sigCtx=null, scv=null, sigCodActif=false, sigCodChoix=null, sigCodMontant=0;', bac);
  vm.runInContext(extraireBloc('// v7.5.129 : choix simple Espèces / Carte bleue / Déjà payé.', 'var sigCodActif = false;'), bac);
  vm.runInContext('var MODES_PAIE = ' + JSON.stringify([{ id: 'LeBonCoin', cat: 'prepaye' }, { id: 'Déjà payé', cat: 'prepaye' }, { id: 'Espèces', cat: 'livreur' }]) + ';', bac);
  for (const f of ['function _sigPaieBtns(actif)', 'function sigTogglePaie(encaisse)', 'function sigDejaPaye()', 'function sigSelectMode(mode)', 'function sigCodChoisir(ch)', 'function paiSigPreparer(cmdSig, banner)', 'function validerSig()',
    'function setLvSt(tid, idx, st, _annOk)', 'function getMontantEspecesCmd(c)', 'function getMontantCBCmd(c)', 'function getCmdsLivresParTournee(t)',
    'function rtOutilsPage()', 'function rtDepensesEspecesTournee(t, liste)', 'function lvClotureHtml(t)', 'function lvCloturerTournee(tid)',
    'function lvReporter(tid, idx, statut)', 'function lvFermerReport()', 'function lvValiderReport()', 'function lvAbsent(tid, idx)',
    // v7.5.130 : dépenses du livreur
    'function ouvrirDepenseLivreur(cible)', 'function depLvSelectMode(mode)', 'async function validerDepenseLivreur()', 'function rtLignesDepenses(r)', 'function rtEchapper(s)', 'function renderLivreurCaisse(t)',
    // v7.5.135 : contrôles des dépenses (tournée clôturée, point de caisse validé, journal)
    'function rtRemiseValideeTournee(t)', 'function depLvTourneeVisee(cible)', 'function depLvControle(t)', 'function depLvAuteur()', 'function depLvQuand()',
    // v7.5.171 : verrou du point de caisse validé (tous les chemins des dépenses)
    'function depVerrouCaisse(etats)'])
    vm.runInContext(extraireFonction(f), bac);
  vm.runInContext('var lvReportCible = null, depLvCatSelected = "", depLvCible = null, currentLvTourneeId = null;', bac);
  let _n = 0; bac.generateId = (p) => p + '-test-' + (++_n);
  bac.sigMixteRecap = () => {};
  return { bac, els, envois, tourneesSauvees };
}
const LBC = (plus) => Object.assign({ id: '#T3', client: 'Client LBC', tel: '', adresse: 'ADRESSE 75000 Paris', produit: 'Matelas test', prix: 180, paie: 'Espèces', stpaie: 'Non payé', montantEnc: 0, statut: 'en-route', date: '2026-11-25', instr: '', origine: 'LeBonCoin', refMarketplace: '', transporteur: 'RANOU', livreur: 'RANOU' }, plus || {});

(async () => {
  // ══════════ 1. Fonctions pures ══════════
  console.log('\n1. FONCTIONS PURES (bloc RT)');
  const { bac: p } = nouveauBac();
  test('résultats = valeurs EXISTANTES (livré, reporté, absent)', JSON.stringify(p.RT_RESULTATS) === JSON.stringify(['livré', 'reporté', 'absent']));
  test('arrêt validé : livré / reporté / absent / annulé', ['livré', 'reporté', 'absent', 'annulé'].every((s) => p.rtArretValide({ statut: s })));
  test('arrêt NON validé : en attente / en route / arrivé / problème / vide', ['en-attente', 'en-route', 'arrivé', 'problème', '', undefined].every((s) => !p.rtArretValide({ statut: s })));
  const T = { stops: [{ client: 'A', statut: 'livré' }, { client: 'B', statut: 'en-route' }, { client: 'C', statut: 'absent' }, { client: 'D' }] };
  test('arrêts à valider : index et clients', JSON.stringify(p.rtArretsAValider(T.stops).map((x) => x.idx + x.client)) === JSON.stringify(['1B', '3D']));
  test('clôture refusée tant qu\'un arrêt n\'a pas de résultat', p.rtPeutCloturer(T).ok === false && /2 arrêts sans résultat/.test(p.rtPeutCloturer(T).raison));
  test('clôture refusée sur une tournée vide', p.rtPeutCloturer({ stops: [] }).ok === false);
  test('clôture acceptée : livré + reporté + absent + annulé', p.rtPeutCloturer({ stops: [{ statut: 'livré' }, { statut: 'reporté' }, { statut: 'absent' }, { statut: 'annulé' }] }).ok === true);
  test('reste dû : non payé = prix', p.rtResteDu(180, 0, 'Non payé') === 180);
  test('reste dû : partiel = prix − acompte', p.rtResteDu(180, 50, 'Partiel') === 130);
  test('reste dû : payé = 0', p.rtResteDu(180, 180, 'Payé') === 0);
  test('reste dû : « Non payé » ignore un montant encaissé périmé', p.rtResteDu(180, 40, 'Non payé') === 180);
  test('montant vide = reste dû, sans motif', JSON.stringify(p.rtControleMontant(180, '', '')) === JSON.stringify({ ok: true, montant: 180, baisse: false, erreur: '' }));
  test('montant égal (virgule acceptée)', p.rtControleMontant(180.5, '180,5', '').ok === true && p.rtControleMontant(180.5, '180,5', '').baisse === false);
  test('montant plus haut que le reste dû : refusé', p.rtControleMontant(180, '200', 'motif long').ok === false);
  test('montant plus bas SANS motif : refusé', p.rtControleMontant(180, '150', '').ok === false && p.rtControleMontant(180, '150', 'abc').ok === false);
  test('montant plus bas AVEC motif : accepté, « baisse »', JSON.stringify(p.rtControleMontant(180, '150', 'remise geste commercial')) === JSON.stringify({ ok: true, montant: 150, baisse: true, erreur: '' }));
  test('montant négatif ou texte : refusé', p.rtControleMontant(180, '-5', 'motif long').ok === false && p.rtControleMontant(180, 'abc', 'motif long').ok === false);
  test('statut après : payé / partiel / non payé', p.rtStatutApres(180, 0, 180) === 'Payé' && p.rtStatutApres(180, 0, 150) === 'Partiel' && p.rtStatutApres(180, 50, 130) === 'Payé' && p.rtStatutApres(180, 0, 0) === 'Non payé');
  test('date de report : vide acceptée', p.rtDateReportValide('', '2026-11-25').ok === true && p.rtDateReportValide('', '2026-11-25').date === '');
  test('date de report : après la tournée acceptée', p.rtDateReportValide('2026-11-28', '2026-11-25').date === '2026-11-28');
  test('date de report : même jour ou avant refusée', !p.rtDateReportValide('2026-11-25', '2026-11-25').ok && !p.rtDateReportValide('2026-11-20', '2026-11-25').ok);
  test('date de report : format invalide refusé', !p.rtDateReportValide('28/11/2026', '2026-11-25').ok && !p.rtDateReportValide('2026-13-45', '2026-11-25').ok);

  // ══════════ 2. Point de caisse ══════════
  console.log('\n2. POINT DE CAISSE (rtPointCaisse avec les vrais calculs getMontantEspecesCmd / getMontantCBCmd)');
  {
    const { bac } = nouveauBac('admin');
    const cmds = [
      LBC({ id: '#E1', client: 'Esp', prix: 200, paie: 'Espèces', stpaie: 'Payé', montantEnc: 200, statut: 'livré' }),
      LBC({ id: '#E2', client: 'EspPart', prix: 300, paie: 'Espèces', stpaie: 'Partiel', montantEnc: 250, statut: 'livré' }),
      LBC({ id: '#C1', client: 'Carte', prix: 150, paie: 'CB', stpaie: 'Payé', montantEnc: 150, statut: 'livré' }),
      LBC({ id: '#M1', client: 'Mixte', prix: 100, paie: 'Mixte', stpaie: 'Payé', montantEnc: 100, paie_especes: 40, paie_cb: 60, statut: 'livré' }),
      LBC({ id: '#D1', client: 'Deja', prix: 120, paie: 'LeBonCoin', stpaie: 'Payé', montantEnc: 120, statut: 'livré' }),
      LBC({ id: '#N1', client: 'NonPaye', prix: 90, paie: 'Espèces', stpaie: 'Non payé', montantEnc: 0, statut: 'livré' }),
      LBC({ id: '#R1', client: 'Reporte', statut: 'reporté' }), LBC({ id: '#A1', client: 'Absent', statut: 'absent' }),
    ];
    bac.commandes = cmds;
    const t = { id: 'T-1', livreur: 'RANOU', date: '2026-11-25', stops: cmds.map((c) => ({ cmdId: c.id, client: c.client, statut: c.statut, prix: c.prix })).concat([{ cmdId: '#X', client: 'Annule', statut: 'annulé' }]) };
    t.stops[6].reportAu = '2026-11-28';
    const deps = [{ livreur: 'RANOU', modePaie: 'Espèces', montant: 30, date: '2026-11-25' }, { livreur: 'RANOU', modePaie: 'CB', montant: 50, date: '2026-11-25' }, { livreur: 'AUTRE', modePaie: 'Espèces', montant: 99, date: '2026-11-25' }];
    const pt = bac.rtPointCaisse(t, bac.getCmdsLivresParTournee(t), bac.rtDepensesEspecesTournee(t, deps), bac.rtOutilsPage());
    test('espèces = 200 + 250 (partiel) + 40 (part espèces du mixte)', pt.especes === 490, pt);
    test('carte bleue = 150 + 60 (part CB du mixte), 2 paiements', pt.cb === 210 && pt.nbCb === 2, pt);
    test('dépenses espèces du livreur seulement (CB et autre livreur exclus)', pt.depEspeces === 30, pt);
    test('espèces attendues = espèces − dépenses espèces', pt.aRemettre === 460, pt);
    test('déjà payées : 1 commande (120 €)', pt.dejaPaye.nb === 1 && pt.dejaPaye.montant === 120, pt);
    test('reste à encaisser : 50 (partiel) + 90 (non payé)', pt.resteAEncaisser.montant === 140 && pt.resteAEncaisser.nb === 2, pt);
    test('reportés : 1 avec la date proposée', pt.reportes.length === 1 && pt.reportes[0].reportAu === '2026-11-28', pt.reportes);
    test('absents : 1 ; livrés : 6 ; annulés : 1 ; aucun arrêt à valider', pt.absents.length === 1 && pt.livres === 6 && pt.annules === 1 && pt.aValider === 0, pt);
    const t2 = { id: 'T-2', livreur: 'RANOU', date: '2026-11-25', stops: [{ cmdId: '#E1', statut: 'livré' }, { cmdId: '#Z', statut: 'en-route' }] };
    test('arrêt sans résultat compté dans le point de caisse', bac.rtPointCaisse(t2, [], [], bac.rtOutilsPage()).aValider === 1);
    test('sans dépense ni commande : tout à zéro', bac.rtPointCaisse({ stops: [] }, [], [], {}).aRemettre === 0);
    const enLigne = LBC({ id: '#S1', origine: 'Site Maxiconfort', refMarketplace: '7000000000001', paySource: 'SHOPIFY_ONLINE', paie: 'Site Maxiconfort', stpaie: 'Payé', montantEnc: 259, prix: 259, statut: 'livré', date: '2026-11-25' });
    const pS = bac.rtPointCaisse({ stops: [{ cmdId: '#S1', statut: 'livré' }] }, [enLigne], [], bac.rtOutilsPage());
    test('commande payée en ligne : jamais dans les espèces, comptée « déjà payée »', pS.especes === 0 && pS.cb === 0 && pS.dejaPaye.nb === 1 && pS.resteAEncaisser.nb === 0, pS);
  }

  // ══════════ 3. Signature : choix simple et montant ══════════
  console.log('\n3. SIGNATURE (vraie validerSig) : Espèces / Carte bleue / Déjà payé, montant à la baisse avec motif');
  const preparer = (cmd) => { const x = nouveauBac(); const { bac } = x; bac.commandes = [cmd];
    const stop = { cmdId: cmd.id, client: cmd.client, produit: cmd.produit, prix: cmd.prix, paie: cmd.paie, stpaie: cmd.stpaie, statut: 'en-route', tel: '' };
    bac.tournees = [{ id: 'T-TEST', livreur: 'RANOU', date: '2026-11-25', statut: 'en cours', stops: [stop] }];
    bac.document.getElementById('sig-nom').value = 'Signataire Test'; bac.document.getElementById('sig-legal-check').checked = true;
    vm.runInContext('sigStopId = { tid: "T-TEST", idx: 0 };', bac);
    const pris = bac.paiSigPreparer(cmd, bac.document.getElementById('sig-prepaye-banner'));
    if (!pris) bac.sigChoixReinit(cmd, stop);
    return Object.assign(x, { stop, pris }); };
  { const cmd = LBC(); const { bac, envois, stop, els } = preparer(cmd);
    test('ouverture : rien de présélectionné, montant pré-rempli = reste dû', bac.sigChoixFait === false && els['sig-montant'].value === '180' && els['sig-montant-wrap'].style.display === 'none');
    bac.validerSig(); await attendre();
    test('validation SANS choix : refusée, rien n\'est enregistré', stop.statut !== 'livré' && envois.length === 0 && /Espèces, Carte bleue ou Déjà payé/.test(bac._toasts.pop()[0]));
    bac.sigChoixSimple('esp');
    test('Espèces choisi : champ montant visible', els['sig-montant-wrap'].style.display === 'block');
    bac.validerSig(); await attendre(); const b = envois[0] && envois[0].body;
    test('Espèces, montant complet : livré, Payé, montant encaissé = prix', stop.statut === 'livré' && b && b.statut === 'livré' && b.stpaie === 'Payé' && b.paie === 'Espèces' && b.montant_enc === 180, b);
  }
  { const cmd = LBC(); const { bac, envois, stop, els } = preparer(cmd); bac.sigChoixSimple('esp');
    els['sig-montant'].value = '150'; els['sig-montant-motif'].value = '';
    bac.validerSig(); await attendre();
    test('Espèces plus bas SANS motif : refusé', stop.statut !== 'livré' && envois.length === 0);
    els['sig-montant'].value = '200'; els['sig-montant-motif'].value = 'motif quelconque'; bac.validerSig(); await attendre();
    test('montant plus HAUT que le reste dû : refusé', stop.statut !== 'livré' && envois.length === 0);
    els['sig-montant'].value = '150'; els['sig-montant-motif'].value = 'Geste commercial accordé'; bac.validerSig(); await attendre(); const b = envois[0] && envois[0].body;
    test('Espèces plus bas AVEC motif : Partiel, 150 € encaissés', b && b.stpaie === 'Partiel' && b.montant_enc === 150 && b.paie === 'Espèces', b);
    test('trace dans la fiche (montant, reste dû, motif)', b && /Encaissé 150 € \(Espèces\) au lieu de 180 € — motif : Geste commercial accordé/.test(b.instr), b && b.instr);
    test('alerte « encaissement incomplet » au bureau', bac._notifs.some((n) => /Encaissement incomplet/.test(n[2])));
    test('arrêt : montant et motif notés', stop.enc && stop.enc.montant === 150 && stop.enc.motif === 'Geste commercial accordé', stop.enc);
    const pt = bac.rtPointCaisse(bac.tournees[0], bac.getCmdsLivresParTournee(bac.tournees[0]), [], bac.rtOutilsPage());
    test('point de caisse : 150 € espèces, 30 € restent à encaisser', pt.especes === 150 && pt.resteAEncaisser.montant === 30, pt);
  }
  { const cmd = LBC(); const { bac, envois, stop, els } = preparer(cmd); bac.sigChoixSimple('cb');
    els['sig-montant'].value = '100'; els['sig-montant-motif'].value = 'Reste payé par virement'; els['sig-ticket'].value = 'TK-77';
    bac.validerSig(); await attendre(); const b = envois[0] && envois[0].body;
    test('Carte bleue plus bas avec motif et ticket : Partiel, 100 €, ticket gardé', b && b.paie === 'CB' && b.stpaie === 'Partiel' && b.montant_enc === 100 && b.ticket_cb === 'TK-77', b);
  }
  { const cmd = LBC(); const { bac, envois, stop, els } = preparer(cmd); bac.sigChoixSimple('cb'); els['sig-ticket'].value = '';
    bac.validerSig(); await attendre();
    test('Carte bleue sans ticket : toujours refusé (règle existante)', stop.statut !== 'livré' && envois.length === 0);
  }
  { const cmd = LBC(); const { bac, envois, els } = preparer(cmd); bac.sigChoixSimple('esp');
    els['sig-montant'].value = '0'; els['sig-montant-motif'].value = 'Client refuse de payer, litige';
    bac.validerSig(); await attendre(); const b = envois[0] && envois[0].body;
    test('0 € avec motif : « Non payé », 0 € encaissé, trace écrite', b && b.stpaie === 'Non payé' && b.montant_enc === 0 && /au lieu de 180 €/.test(b.instr), b);
  }
  { const cmd = LBC({ stpaie: 'Partiel', montantEnc: 50 }); const { bac, envois, els } = preparer(cmd);
    test('acompte de 50 € : montant pré-rempli = 130 €', els['sig-montant'].value === '130');
    bac.sigChoixSimple('esp'); bac.validerSig(); await attendre(); const b = envois[0] && envois[0].body;
    test('acompte puis reste encaissé : Payé, montant encaissé = prix', b && b.stpaie === 'Payé' && b.montant_enc === 180, b);
  }
  { const cmd = LBC({ stpaie: 'Payé', montantEnc: 180 }); const { bac, envois, stop } = preparer(cmd); bac.sigChoixSimple('esp');
    bac.validerSig(); await attendre();
    test('commande déjà soldée + Espèces : refusé (sinon comptée deux fois en caisse)', stop.statut !== 'livré' && envois.length === 0 && /Déjà payé/.test(bac._toasts.pop()[0]));
    bac.sigChoixSimple('deja'); bac.validerSig(); await attendre();
    test('commande déjà soldée + Déjà payé : accepté', stop.statut === 'livré' && envois.length === 1);
  }
  { const cmd = LBC({ stpaie: 'Payé', montantEnc: 180 }); const { bac, envois } = preparer(cmd); bac.sigChoixSimple('deja');
    bac.validerSig(); await attendre(); const b = envois[0] && envois[0].body;
    test('Déjà payé (commande soldée dans la base) : Payé, rien encaissé sur place', b && b.stpaie === 'Payé' && b.paie === 'Déjà payé' && !b.encaisse_par, b);
  }
  { const cmd = LBC(); const { bac, envois, stop } = preparer(cmd); bac.sigChoixSimple('deja');
    bac.validerSig(); await attendre();
    test('v7.5.171 : Déjà payé sur une commande « Non payé » (0 € encaissé) : REFUSÉ au livreur, rien enregistré', stop.statut !== 'livré' && envois.length === 0 && /n'est pas payée[\s\S]*encaissez ou signalez au bureau/.test(bac._toasts.pop()[0]));
  }
  { const cmd = LBC(); const { bac, envois, els } = preparer(cmd); bac.sigAutreCas('non');
    bac.validerSig(); await attendre(); const b = envois[0] && envois[0].body;
    test('« Autres cas » → Non payé : livré, Non payé (comportement existant)', b && b.statut === 'livré' && b.stpaie === 'Non payé', b);
  }
  { const cmd = LBC(); const { bac, envois, els } = preparer(cmd); bac.sigAutreCas('Mixte');
    bac.document.getElementById('sig-paie-esp').value = '100'; bac.document.getElementById('sig-paie-cb').value = '80'; els['sig-ticket'].value = 'TK-5';
    bac.validerSig(); await attendre(); const b = envois[0] && envois[0].body;
    test('« Autres cas » → Espèces + CB : inchangé (Mixte, 180 €)', b && b.paie === 'Mixte' && b.montant_enc === 180, b);
  }
  { const SITE = LBC({ id: '#S2', origine: 'Site Maxiconfort', refMarketplace: '7000000000002', paySource: 'SHOPIFY_ONLINE', paie: 'Site Maxiconfort', stpaie: 'Payé', montantEnc: 259, prix: 259 });
    const { bac, envois, pris, stop } = preparer(SITE); bac.validerSig(); await attendre(); const b = envois[0] && envois[0].body;
    // le verrou paiVerrouBody retire volontairement paie / stpaie / montant_enc du corps envoyé (la base garde le paiement en ligne)
    test('commande payée en ligne : écran dédié inchangé, aucun choix demandé, paiement jamais renvoyé', pris === true && bac.sigChoixFait === null && b && b.statut === 'livré' && !('montant_enc' in b) && !('stpaie' in b) && stop.stpaie === 'Payé', { pris, choix: bac.sigChoixFait, statut: b && b.statut, cles: b && Object.keys(b).filter((k) => /paie|montant/.test(k)) });
  }

  // ══════════ 3 bis. Acompte : encaissé PENDANT la tournée (revue Codex P1, v7.5.132) ══════════
  console.log('\n3 bis. ACOMPTE SÉPARÉ DE L\'ENCAISSEMENT DE LA TOURNÉE (revue Codex P1)');
  const pointDe = (bac) => bac.rtPointCaisse(bac.tournees[0], bac.getCmdsLivresParTournee(bac.tournees[0]), [], bac.rtOutilsPage());
  { const cmd = LBC({ stpaie: 'Partiel', montantEnc: 50 }); const { bac, envois, stop, els } = preparer(cmd);
    bac.sigChoixSimple('cb'); els['sig-ticket'].value = 'TK-A1';
    test('acompte 50 € : montant pré-rempli 130 €', els['sig-montant'].value === '130');
    bac.validerSig(); await attendre(); const b = envois[0] && envois[0].body;
    test('acompte 50 € + 130 € CB : cumul de la commande 180 €, « Payé »', b && b.montant_enc === 180 && b.stpaie === 'Payé' && b.paie === 'CB', b);
    test('arrêt : acompte noté (encAvant = 50), montant encaissé sur la tournée = 130 €', stop.encAvant === 50 && stop.enc && stop.enc.montant === 130, { encAvant: stop.encAvant, enc: stop.enc });
    const pt = pointDe(bac);
    test('point de caisse : 130 € de CB attendus (et non 180 €), 0 € d\'espèces', pt.cb === 130 && pt.especes === 0 && pt.resteAEncaisser.montant === 0, pt);
    bac.depenses = []; bac.renderLivreurCaisse(bac.tournees[0]); const h = els['lv-caisse-summary'].innerHTML;
    test('caisse du livreur : CB +130 (et non +180)', /\+130 €/.test(h) && !/\+180 €/.test(h), h.slice(0, 300));
  }
  { const cmd = LBC({ stpaie: 'Partiel', montantEnc: 50 }); const { bac, envois, els } = preparer(cmd);
    bac.sigChoixSimple('esp'); els['sig-montant'].value = '100'; els['sig-montant-motif'].value = 'Le client paiera le reste demain';
    bac.validerSig(); await attendre(); const b = envois[0] && envois[0].body;
    test('acompte 50 € + 100 € espèces (baisse avec motif) : cumul 150 €, « Partiel »', b && b.montant_enc === 150 && b.stpaie === 'Partiel', b);
    const pt = pointDe(bac);
    test('point de caisse : 100 € d\'espèces attendus (et non 150 €), 30 € restent à encaisser', pt.especes === 100 && pt.resteAEncaisser.montant === 30, pt);
  }
  { const cmd = LBC({ stpaie: 'Partiel', montantEnc: 50 }); const { bac, envois, els } = preparer(cmd);
    bac.sigAutreCas('Mixte'); bac.document.getElementById('sig-paie-esp').value = '80'; bac.document.getElementById('sig-paie-cb').value = '50'; els['sig-ticket'].value = 'TK-M';
    bac.validerSig(); await attendre(); const b = envois[0] && envois[0].body;
    test('acompte 50 € + espèces 80 € + CB 50 € : cumul 180 €, « Payé » (acompte gardé)', b && b.montant_enc === 180 && b.stpaie === 'Payé' && b.paie === 'Mixte', b);
    const pt = pointDe(bac);
    test('point de caisse Mixte : 80 € espèces, 50 € CB', pt.especes === 80 && pt.cb === 50, pt);
  }
  { const { bac: p } = nouveauBac();
    test('arrêt signé avant cette version (sans encAvant) : calcul d\'origine conservé', p.rtEncaisseTournee({ paie: 'CB', stpaie: 'Payé', montantEnc: 180 }, { statut: 'livré' }) === null);
    test('encaissement complété plus tard (« Encaisser ») : cumul − acompte', JSON.stringify(p.rtEncaisseTournee({ paie: 'Espèces', stpaie: 'Payé', montantEnc: 180 }, { encAvant: 50 })) === JSON.stringify({ esp: 130, cb: 0 }));
    test('commande repassée « Non payé » : rien sur la tournée', JSON.stringify(p.rtEncaisseTournee({ paie: 'Espèces', stpaie: 'Non payé', montantEnc: 0 }, { encAvant: 0 })) === JSON.stringify({ esp: 0, cb: 0 }));
  }

  // ══════════ 3 quater. Éditeur de paiement du livreur et acompte (revue Codex sur 0fb4eae, v7.5.133) ══════════
  console.log('\n3 quater. ÉDITEUR DE PAIEMENT (« Encaisser » / ✏️) ET ACOMPTE (revue Codex)');
  { const { bac: p } = nouveauBac();
    test('cumul éditeur Mixte : acompte 50 + 60 + 70 = 180, « Payé »', JSON.stringify(p.rtCumulEditeur(180, 50, 'Mixte', 'Partiel', 60, 70, 50)) === JSON.stringify({ montantEnc: 180, stpaie: 'Payé' }));
    test('cumul éditeur Mixte sans acompte : 100 + 80 = 180, « Payé » (inchangé)', JSON.stringify(p.rtCumulEditeur(180, 0, 'Mixte', 'Payé', 100, 80, 0)) === JSON.stringify({ montantEnc: 180, stpaie: 'Payé' }));
    test('cumul éditeur Mixte incomplet : acompte 50 + 40 + 40 = 130, « Partiel »', JSON.stringify(p.rtCumulEditeur(180, 50, 'Mixte', 'Payé', 40, 40, 50)) === JSON.stringify({ montantEnc: 130, stpaie: 'Partiel' }));
    test('« Non payé » avec acompte : reste « Partiel », cumul = acompte (pas de fausse dette)', JSON.stringify(p.rtCumulEditeur(180, 50, 'Espèces', 'Non payé', 0, 0, 50)) === JSON.stringify({ montantEnc: 50, stpaie: 'Partiel' }));
    test('« Non payé » sans acompte : 0 €, « Non payé » (inchangé)', JSON.stringify(p.rtCumulEditeur(180, 0, 'Espèces', 'Non payé', 0, 0, 0)) === JSON.stringify({ montantEnc: 0, stpaie: 'Non payé' }));
    test('« Payé » : cumul = prix ; « Partiel » sans montant : cumul inchangé', p.rtCumulEditeur(180, 50, 'CB', 'Payé', 0, 0, 50).montantEnc === 180 && p.rtCumulEditeur(180, 50, 'Espèces', 'Partiel', 0, 0, 120).montantEnc === 120);
  }
  const editeur = async (cmdPlus, stopPlus, fenetre, roleEd, motifPrompt) => {
    const x = nouveauBac(roleEd); const { bac, els } = x;
    for (const f of ['function lvPaieMixteRecap()', 'async function lvPaieValider()']) vm.runInContext(extraireFonction(f), bac);
    bac.renderFinance = () => {};
    const cmd = LBC(Object.assign({ statut: 'livré' }, cmdPlus)); bac.commandes = [cmd];
    const stop = Object.assign({ cmdId: cmd.id, client: cmd.client, prix: cmd.prix, statut: 'livré', paie: cmd.paie, stpaie: cmd.stpaie }, stopPlus);
    bac.tournees = [{ id: 'T-ED', livreur: 'RANOU', date: '2026-11-25', statut: 'en cours', stops: [stop] }];
    const sh = bac.document.getElementById('lv-paie-sheet');
    Object.assign(sh.dataset, { mode: fenetre.mode, statut: fenetre.statut || 'Payé', tid: 'T-ED', idx: '0', prixTotal: String(cmd.prix), acompte: String(stop.encAvant || 0) });
    bac.document.getElementById('lv-paie-esp').value = String(fenetre.esp || 0); bac.document.getElementById('lv-paie-cb').value = String(fenetre.cb || 0);
    bac.prompt = () => (motifPrompt != null ? motifPrompt : 'TK-ED');
    bac.lvPaieMixteRecap(); const statutRecap = sh.dataset.statut; const recap = bac.document.getElementById('lv-paie-mixte-recap').textContent;
    await bac.lvPaieValider(); await attendre();
    return Object.assign(x, { cmd, stop, statutRecap, recap, b: x.envois[0] && x.envois[0].body });
  };
  { const r = await editeur({ stpaie: 'Partiel', montantEnc: 50 }, { encAvant: 50 }, { mode: 'Mixte', esp: 60, cb: 70 });
    test('éditeur Mixte avec acompte 50 € : le récapitulatif annonce « Payé » (180 €), plus « partiel »', r.statutRecap === 'Payé' && /180\.00 €/.test(r.recap), { statut: r.statutRecap, recap: r.recap });
    test('éditeur Mixte avec acompte : cumul enregistré 180 € (et non 130 €), « Payé »', r.b && r.b.montant_enc === 180 && r.b.stpaie === 'Payé' && r.b.paie === 'Mixte', r.b);
    const pt = r.bac.rtPointCaisse(r.bac.tournees[0], r.bac.getCmdsLivresParTournee(r.bac.tournees[0]), [], r.bac.rtOutilsPage());
    test('point de caisse après l\'éditeur : 60 € espèces, 70 € CB, rien ne reste dû', pt.especes === 60 && pt.cb === 70 && pt.resteAEncaisser.montant === 0, pt);
  }
  { const r = await editeur({ stpaie: 'Partiel', montantEnc: 50, paie: 'Espèces' }, { encAvant: 50 }, { mode: 'Espèces', statut: 'Non payé' });
    test('éditeur « Non payé » avec acompte : cumul 50 €, « Partiel » (pas de dette de 180 €)', r.b && r.b.montant_enc === 50 && r.b.stpaie === 'Partiel' && r.stop.stpaie === 'Partiel', r.b);
  }
  { const r = await editeur({ stpaie: 'Partiel', montantEnc: 50, paie: 'CB' }, { encAvant: 50 }, { mode: 'CB', statut: 'Payé' });
    const pt = r.bac.rtPointCaisse(r.bac.tournees[0], r.bac.getCmdsLivresParTournee(r.bac.tournees[0]), [], r.bac.rtOutilsPage());
    test('éditeur « Payé » en CB avec acompte : cumul 180 €, 130 € de CB sur la tournée', r.b && r.b.montant_enc === 180 && r.b.ticket_cb === 'TK-ED' && pt.cb === 130, { b: r.b && r.b.montant_enc, cb: pt.cb });
  }
  { const r = await editeur({ stpaie: 'Non payé', montantEnc: 0 }, {}, { mode: 'Mixte', esp: 100, cb: 80 });
    test('éditeur Mixte sans acompte (arrêt ancien) : 180 € « Payé », comme avant', r.b && r.b.montant_enc === 180 && r.b.stpaie === 'Payé', r.b);
  }
  test('autres chemins qui réécrivent le cumul : signature (acompte compris), admin = montant saisi (cumul explicite, motif + journal)', /cmd\.montantEnc = Math\.round\(\(_avantEnc \+ sigPaieEsp \+ sigPaieCb\) \* 100\) \/ 100;/.test(html) && /c\.paie = nMode; c\.stpaie = nStatut; c\.montantEnc = rawMontant;/.test(html));

  // ══════════ 3 quinquies. Récapitulatif Mixte de la SIGNATURE avec acompte (revue Codex sur 34ec6d5, v7.5.134) ══════════
  console.log('\n3 quinquies. RÉCAPITULATIF MIXTE DE LA SIGNATURE (vraie fonction sigMixteRecap) ET ACOMPTE');
  const recapSig = (cmdPlus, esp, cb) => {
    const cmd = LBC(cmdPlus); const x = preparer(cmd); const { bac } = x;
    vm.runInContext(extraireFonction('function sigMixteRecap()'), bac); // la VRAIE fonction de la page (le banc la remplaçait par un faux)
    bac.document.getElementById('sig-paie-esp').value = String(esp); bac.document.getElementById('sig-paie-cb').value = String(cb);
    bac.sigMixteRecap();
    return Object.assign(x, { texte: bac.document.getElementById('sig-mixte-recap').textContent });
  };
  { const r = recapSig({ stpaie: 'Partiel', montantEnc: 50 }, 60, 70);
    test('signature Mixte, acompte 50 € + 60 € + 70 € : « MATCH parfait » (plus de « manque 50.00 € »)', /Total : 180\.00 €/.test(r.texte) && /MATCH parfait/.test(r.texte) && /acompte 50\.00 €/.test(r.texte) && !/manque/.test(r.texte), r.texte);
    r.bac.document.getElementById('sig-ticket').value = 'TK-R'; r.bac.sigAutreCas('Mixte'); r.bac.document.getElementById('sig-paie-esp').value = '60'; r.bac.document.getElementById('sig-paie-cb').value = '70'; r.bac.document.getElementById('sig-ticket').value = 'TK-R';
    r.bac.validerSig(); await attendre(); const b = r.envois[0] && r.envois[0].body;
    test('signature Mixte avec acompte : le récapitulatif et l\'enregistrement disent la même chose (Payé, 180 €)', b && b.stpaie === 'Payé' && b.montant_enc === 180, b);
  }
  { const r = recapSig({ stpaie: 'Partiel', montantEnc: 50 }, 40, 40);
    test('signature Mixte, acompte 50 € + 40 € + 40 € : « manque 50.00 € » (vrai reste)', /Total : 130\.00 €/.test(r.texte) && /manque 50\.00 €/.test(r.texte), r.texte);
  }
  { const r = recapSig({ stpaie: 'Partiel', montantEnc: 50 }, 0, 0);
    test('signature Mixte, rien saisi : l\'acompte est signalé comme déjà compté', /Saisir les 2 montants/.test(r.texte) && /acompte de 50\.00 € déjà compté/.test(r.texte), r.texte);
  }
  { const r = recapSig({ stpaie: 'Non payé', montantEnc: 0 }, 100, 80);
    test('signature Mixte sans acompte : 180.00 € « MATCH parfait » (comme avant)', /Total : 180\.00 €/.test(r.texte) && /MATCH parfait/.test(r.texte) && !/acompte/.test(r.texte), r.texte);
  }

  // ══════════ 3 ter. Tournée clôturée gardée à l'écran (revue Codex P2, v7.5.132) ══════════
  console.log('\n3 ter. TOURNÉE CLÔTURÉE GARDÉE À L\'ÉCRAN (revue Codex P2)');
  { const { bac: p } = nouveauBac();
    vm.runInContext(extraireFonction('function lvListeNav(mesTournees, courante, aujourdhui)'), p);
    const AUJ = '2026-11-25';
    const mes = [{ id: 'T-AUJ', date: AUJ, statut: 'terminée' }, { id: 'T-DEMAIN', date: '2026-11-26', statut: 'préparée' }, { id: 'T-HIER', date: '2026-11-24', statut: 'terminée' }];
    test('tournée affichée terminée aujourd\'hui : gardée', p.rtTourneeAGarder(mes, 'T-AUJ', null, AUJ).id === 'T-AUJ');
    test('après rechargement : tournée mémorisée à la clôture gardée', p.rtTourneeAGarder(mes, null, { id: 'T-AUJ', date: AUJ }, AUJ).id === 'T-AUJ');
    test('mémoire d\'un autre jour, ou tournée non terminée : rien de gardé', p.rtTourneeAGarder(mes, null, { id: 'T-AUJ', date: '2026-11-24' }, AUJ) === null && p.rtTourneeAGarder(mes, 'T-DEMAIN', null, AUJ) === null && p.rtTourneeAGarder(mes, 'T-HIER', null, AUJ) === null);
    const nav = p.lvListeNav(mes, mes[0], AUJ).map((x) => x.id).join();
    test('navigation : la tournée clôturée du jour reste accessible (avec celle de demain)', nav === 'T-AUJ,T-DEMAIN', nav);
    test('navigation : une tournée terminée d\'un autre jour n\'y est pas', !/T-HIER/.test(nav));
  }
  { const { bac } = nouveauBac();
    const AUJ = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
    bac.commandes = [LBC({ id: '#G1', statut: 'livré', stpaie: 'Payé', montantEnc: 180 })];
    bac.tournees = [{ id: 'T-G', livreur: 'RANOU', date: AUJ, statut: 'en cours', stops: [{ cmdId: '#G1', client: 'A', statut: 'livré' }] }];
    bac.lvCloturerTournee('T-G');
    test('clôture : la tournée est mémorisée pour rester affichée (même après rechargement)', JSON.parse(bac._mx['mx_lv_tournee_cloturee'] || 'null').id === 'T-G');
    test('la page garde la tournée terminée du jour avant de choisir la suivante, sauf changement explicite', /var _garder = LV_APERCU_ID \? null : rtTourneeAGarder\(myTournees, currentLvTourneeId, _memoClo, lvToday\);\s*if \(_garder\) myT = _garder;/.test(html) && /LV_APERCU_ID = LV_NAV\[j\]\.id;\s*try \{ mxSupprimer\('mx_lv_tournee_cloturee'\)/.test(html));
  }

  // ══════════ 4. Reporté / absent : valeurs de statut existantes ══════════
  console.log('\n4. REPORTÉ (date facultative) ET CLIENT ABSENT');
  { const cmd = LBC({ id: '#R9', date: '2026-11-25' }); const { bac, envois, els, tourneesSauvees } = nouveauBac();
    bac.commandes = [cmd]; bac.tournees = [{ id: 'T-R', livreur: 'RANOU', date: '2026-11-25', statut: 'en cours', stops: [{ cmdId: '#R9', client: 'Client LBC', statut: 'en-route' }] }];
    bac.lvReporter('T-R', 0); els['report-date'].value = '2026-11-25'; bac.lvValiderReport(); await attendre();
    test('report au même jour : refusé, rien n\'est enregistré', bac.tournees[0].stops[0].statut === 'en-route' && envois.length === 0);
    els['report-date'].value = '2026-11-28'; bac.lvValiderReport(); await attendre(); const b = envois[0] && envois[0].body;
    test('report avec date : statut « reporté » (valeur existante) sur l\'arrêt et la commande', bac.tournees[0].stops[0].statut === 'reporté' && b && b.statut === 'reporté', b);
    test('date proposée notée sur l\'arrêt et dans les instructions', bac.tournees[0].stops[0].reportAu === '2026-11-28' && /Report demandé par le client au 2026-11-28/.test(b.instr), b && b.instr);
    test('la date de livraison de la commande n\'est PAS changée (le bureau replanifie)', b.date_livraison === '2026-11-25', b.date_livraison);
    test('tournée enregistrée', tourneesSauvees.length === 1);
  }
  { const cmd = LBC({ id: '#R8' }); const { bac, envois, els } = nouveauBac();
    bac.commandes = [cmd]; bac.tournees = [{ id: 'T-R', livreur: 'RANOU', date: '2026-11-25', statut: 'en cours', stops: [{ cmdId: '#R8', client: 'X', statut: 'en-route' }] }];
    bac.lvReporter('T-R', 0); els['report-date'].value = ''; bac.lvValiderReport(); await attendre();
    test('report sans date : accepté, rien ajouté aux instructions', bac.tournees[0].stops[0].statut === 'reporté' && envois[0].body.instr === '' && bac.tournees[0].stops[0].reportAu === '');
  }
  { const cmd = LBC({ id: '#A9' }); const { bac, envois, els } = nouveauBac();
    bac.commandes = [cmd]; bac.tournees = [{ id: 'T-A', livreur: 'RANOU', date: '2026-11-25', statut: 'en cours', stops: [{ cmdId: '#A9', client: 'Y', statut: 'en-route' }] }];
    bac.lvAbsent('T-A', 0);
    test('client absent : la fenêtre s\'ouvre (titre « Client absent », date facultative), rien n\'est encore enregistré', els['m-report'].style.display === 'flex' && /Client absent/.test(els['report-titre'].textContent) && /Reporter au/.test(els['report-label'].textContent) && envois.length === 0);
    bac.lvFermerReport(); await attendre();
    test('client absent annulé : rien ne change', bac.tournees[0].stops[0].statut === 'en-route' && envois.length === 0);
    bac.lvAbsent('T-A', 0); els['report-date'].value = ''; bac.lvValiderReport(); await attendre();
    test('client absent sans date : statut « absent » (valeur existante) sur l\'arrêt et la commande, instructions inchangées', bac.tournees[0].stops[0].statut === 'absent' && envois[0].body.statut === 'absent' && envois[0].body.instr === '');
  }
  { const cmd = LBC({ id: '#A8', date: '2026-11-25' }); const { bac, envois, els } = nouveauBac();
    bac.commandes = [cmd]; bac.tournees = [{ id: 'T-A', livreur: 'RANOU', date: '2026-11-25', statut: 'en cours', stops: [{ cmdId: '#A8', client: 'Z', statut: 'en-route' }] }];
    bac.lvAbsent('T-A', 0); els['report-date'].value = '2026-11-20'; bac.lvValiderReport(); await attendre();
    test('client absent, date passée : refusée', bac.tournees[0].stops[0].statut === 'en-route' && envois.length === 0);
    els['report-date'].value = '2026-11-27'; bac.lvValiderReport(); await attendre(); const b = envois[0] && envois[0].body;
    test('client absent AVEC date : statut « absent », date notée sur l\'arrêt et dans les instructions', bac.tournees[0].stops[0].statut === 'absent' && bac.tournees[0].stops[0].reportAu === '2026-11-27' && b && /Client absent — à reporter au 2026-11-27/.test(b.instr), b && b.instr);
    test('client absent avec date : date de livraison inchangée', b && b.date_livraison === '2026-11-25');
    const pt = bac.rtPointCaisse(bac.tournees[0], [], [], bac.rtOutilsPage());
    test('Retour de tournée : l\'absent porte sa date de report', pt.absents.length === 1 && pt.absents[0].reportAu === '2026-11-27', pt.absents);
  }

  // ══════════ 4 bis. Dépenses du livreur ══════════
  console.log('\n4 bis. DÉPENSES DU LIVREUR (déduites des espèces à remettre)');
  { const { bac: p } = nouveauBac();
    test('reste à remettre = espèces − dépenses espèces', JSON.stringify(p.rtResteARemettre(500, 75.5)) === JSON.stringify({ reste: 424.5, aRembourser: 0 }));
    test('dépenses > espèces : rien à remettre, différence à rembourser au livreur', JSON.stringify(p.rtResteARemettre(40, 65)) === JSON.stringify({ reste: 0, aRembourser: 25 }));
    test('dépense : catégorie obligatoire', p.rtDepenseValide('', 10).ok === false);
    test('dépense : montant > 0 (virgule acceptée), 5 000 € au plus', p.rtDepenseValide('Péage', '12,40').montant === 12.4 && !p.rtDepenseValide('Péage', '0').ok && !p.rtDepenseValide('Péage', 'abc').ok && !p.rtDepenseValide('Péage', 6000).ok);
    const T = [{ id: 'T-HIER', livreur: 'RANOU', date: '2026-11-24', statut: 'terminée' }, { id: 'T-DEMAIN', livreur: 'RANOU', date: '2026-11-26', statut: 'préparée' }, { id: 'T-AUJ', livreur: 'RANOU', date: '2026-11-25', statut: 'en cours' }, { id: 'T-AUTRE', livreur: 'AUTRE', date: '2026-11-25' }];
    test('rattachement : la tournée affichée (pas un aperçu)', p.rtTourneePourDepense(T, 'ranou', 'T-AUJ', false, '2026-11-25').id === 'T-AUJ');
    test('rattachement : en aperçu de demain → la tournée du JOUR (avant : la première non terminée, parfois à venir)', p.rtTourneePourDepense(T, 'RANOU', 'T-DEMAIN', true, '2026-11-25').id === 'T-AUJ');
    test('rattachement : jamais la tournée d\'un autre livreur', p.rtTourneePourDepense(T, 'RANOU', 'T-AUTRE', false, '2026-11-25').id === 'T-AUJ' && p.rtTourneePourDepense(T, 'PERSONNE', null, false, '2026-11-25') === null);
    const deps = [{ id: 'd1', livreur: 'RANOU', tourneeId: 'T-AUJ', date: '2026-11-25', modePaie: 'Espèces', montant: 30 }, { id: 'd2', livreur: 'RANOU', tourneeId: 'T-HIER', date: '2026-11-25', modePaie: 'Espèces', montant: 99 }, { id: 'd3', livreur: 'RANOU', date: '2026-11-25', modePaie: 'Espèces', montant: 10 }, { id: 'd4', livreur: 'RANOU', tourneeId: 'T-AUJ', modePaie: 'CB', montant: 50 }, { id: 'd5', livreur: 'CAISSE', date: '2026-11-25', montant: 7 }];
    test('dépenses d\'une tournée : par identifiant de tournée, sinon par date ; jamais CAISSE', p.rtDepensesTournee(T[2], deps).map((d) => d.id).join() === 'd1,d3,d4');
    test('seules les dépenses en espèces sont déduites (CB société exclue)', p.rtDepensesEspeces(p.rtDepensesTournee(T[2], deps)).map((d) => d.id).join() === 'd1,d3');
  }
  { // plusieurs dépenses + déduction dans le point de caisse et la caisse du livreur
    const { bac, els } = nouveauBac();
    bac.commandes = [LBC({ id: '#P1', statut: 'livré', stpaie: 'Payé', montantEnc: 300, prix: 300, paie: 'Espèces' }), LBC({ id: '#P2', statut: 'livré', stpaie: 'Payé', montantEnc: 200, prix: 200, paie: 'Espèces' })];
    bac.tournees = [{ id: 'T-P', livreur: 'RANOU', date: '2026-11-25', statut: 'en cours', stops: [{ cmdId: '#P1', client: 'A', statut: 'livré' }, { cmdId: '#P2', client: 'B', statut: 'livré' }] }];
    bac.depenses = [{ id: 'e1', livreur: 'RANOU', tourneeId: 'T-P', date: '2026-11-25', cat: 'Carburant', modePaie: 'Espèces', montant: 60 }, { id: 'e2', livreur: 'RANOU', tourneeId: 'T-P', date: '2026-11-25', cat: 'Péage', modePaie: 'Espèces', montant: 14.5 }, { id: 'e3', livreur: 'RANOU', tourneeId: 'T-P', date: '2026-11-25', cat: 'Achat fournisseur', modePaie: 'CB', montant: 120 }];
    const pt = bac.rtPointCaisse(bac.tournees[0], bac.getCmdsLivresParTournee(bac.tournees[0]), bac.rtDepensesEspecesTournee(bac.tournees[0], bac.depenses), bac.rtOutilsPage());
    test('plusieurs dépenses : 500 € encaissés − (60 + 14,50) = 425,50 € à remettre (la CB société n\'est pas déduite)', pt.especes === 500 && pt.depEspeces === 74.5 && pt.aRemettre === 425.5 && pt.depenses.length === 2, pt);
    bac.renderLivreurCaisse(bac.tournees[0]); const h = els['lv-caisse-summary'].innerHTML;
    test('caisse du livreur : « Espèces à remettre » = 425,50 €, calcul écrit, bouton « Ajouter une dépense »', /Espèces à remettre/.test(h) && /425,50 €/.test(h) && /Espèces encaissées 500 € − dépenses payées en espèces 74,50 €/.test(h) && /Ajouter une dépense/.test(h), h.slice(0, 200));
    test('caisse du livreur : chaque dépense listée avec son bouton de correction', /lvModifierDepense\('e1'\)/.test(h) && /lvModifierDepense\('e2'\)/.test(h) && /lvModifierDepense\('e3'\)/.test(h));
    test('caisse du livreur : bloc de clôture et caisse disent le même montant', /Espèces à remettre : 425,50 €/.test((bac.tournees[0].statut = 'terminée', bac.lvClotureHtml(bac.tournees[0]))));
  }
  { // dépense saisie par le livreur : rattachée à la tournée affichée du jour, déduite tout de suite
    const { bac, els, envois } = nouveauBac();
    const AUJ = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
    bac.tournees = [{ id: 'T-FUTUR', livreur: 'RANOU', date: '2099-01-01', statut: 'préparée', stops: [] }, { id: 'T-JOUR', livreur: 'RANOU', date: AUJ, statut: 'en cours', stops: [] }];
    vm.runInContext('currentLvTourneeId = "T-JOUR";', bac);
    bac.ouvrirDepenseLivreur(); vm.runInContext('depLvCatSelected = "Parking";', bac); els['dep-lv-montant'].value = '8'; els['dep-lv-comment'].value = 'Parking client';
    await bac.validerDepenseLivreur(); const b = envois[0] && envois[0].body;
    test('livreur : dépense rattachée à SA tournée du jour (pas la tournée à venir), date de la tournée, espèces', b && b.tournee_id === 'T-JOUR' && b.date_depense === AUJ && b.livreur === 'RANOU' && b.mode_paie === 'Espèces' && b.montant === 8 && b.cat === 'Parking', b);
    test('livreur : la dépense est dans la liste locale (déduction immédiate)', bac.depenses.length === 1 && bac.depenses[0].tourneeId === 'T-JOUR');
    bac.ouvrirDepenseLivreur(); vm.runInContext('depLvCatSelected = "Parking";', bac); els['dep-lv-montant'].value = '0';
    await bac.validerDepenseLivreur();
    test('livreur : montant nul refusé', envois.length === 1 && bac.depenses.length === 1);
  }
  { // dépense ajoutée puis corrigée par l'administrateur depuis le Retour de tournée
    const { bac, els, envois } = nouveauBac('admin');
    bac.livNom = '';
    bac.commandes = [LBC({ id: '#Q1', statut: 'livré', stpaie: 'Payé', montantEnc: 250, prix: 250, paie: 'Espèces' })];
    bac.tournees = [{ id: 'T-Q', livreur: 'RANOU', date: '2026-11-24', statut: 'terminée', stops: [{ cmdId: '#Q1', client: 'A', statut: 'livré' }] }];
    const r = { t: bac.tournees[0], point: { aRembourser: 0 } };
    test('Retour de tournée : bouton « + Ajouter une dépense du livreur » branché sur la tournée', /ouvrirDepenseLivreur\(\{ tid: 'T-Q' \}\)/.test(bac.rtLignesDepenses(r)));
    bac.ouvrirDepenseLivreur({ tid: 'T-Q' });
    test('écran Dépense ouvert par l\'admin : sous-titre de la tournée', /Tournée T-Q · RANOU/.test(els['dep-lv-sous-titre'].textContent));
    vm.runInContext('depLvCatSelected = "Achat fournisseur";', bac); els['dep-lv-montant'].value = '45'; els['dep-lv-comment'].value = 'Visserie';
    await bac.validerDepenseLivreur(); let b = envois[0] && envois[0].body;
    test('admin : dépense ajoutée au nom du LIVREUR de la tournée, à la date et sur l\'identifiant de la tournée', b && b.livreur === 'RANOU' && b.tournee_id === 'T-Q' && b.date_depense === '2026-11-24' && b.montant === 45, b);
    const id = bac.depenses[0].id;
    test('Retour de tournée : la dépense apparaît avec son bouton ✏️', new RegExp("depId: '" + id + "'").test(bac.rtLignesDepenses(r)) && /Visserie/.test(bac.rtLignesDepenses(r)));
    bac.ouvrirDepenseLivreur({ tid: 'T-Q', depId: id });
    test('correction : montant et commentaire pré-remplis, titre « Corriger »', els['dep-lv-montant'].value === '45' && els['dep-lv-comment'].value === 'Visserie' && /Corriger/.test(els['dep-lv-titre'].textContent));
    els['dep-lv-montant'].value = '40'; els['dep-lv-motif'].value = 'Ticket relu : 40 €'; // v7.5.135 : motif obligatoire
    await bac.validerDepenseLivreur(); b = envois[1] && envois[1].body;
    test('correction : même identifiant (mise à jour, pas de doublon), nouveau montant', b && b.id === id && b.montant === 40 && bac.depenses.length === 1, b);
    const pt = bac.rtPointCaisse(bac.tournees[0], bac.getCmdsLivresParTournee(bac.tournees[0]), bac.rtDepensesEspecesTournee(bac.tournees[0], bac.depenses), bac.rtOutilsPage());
    test('point de caisse après correction : 250 − 40 = 210 € à remettre', pt.aRemettre === 210, pt);
    // la validation enregistre bien le montant APRÈS dépenses (mécanisme existant validerRemiseCaisse / caisse_remises)
    bac.window = { _paiRemisesAttendu: { 't_T-Q': { especes: pt.aRemettre, cb: pt.cb } } }; bac.caissesRemises = {}; bac.prompt = () => '200';
    const reponses = ['200', 'Il manque 10 € : ticket perdu']; bac.prompt = () => reponses.shift();
    vm.runInContext(extraireFonction('function paiCalculRemise(attendu, saisie)'), bac);
    vm.runInContext(extraireFonction('async function validerRemiseCaisse(key)'), bac);
    await bac.validerRemiseCaisse('t_T-Q'); const rem = envois.find((e) => /caisse_remises/.test(e.url));
    test('validation du point de caisse : caisse_remises reçoit le RESTE À REMETTRE (210 €), la somme remise et l\'écart', rem && rem.body.especes_attendues === 210 && rem.body.especes_remises === 200 && rem.body.ecart === -10 && rem.body.commentaire === 'Il manque 10 € : ticket perdu', rem && rem.body);
  }
  { // v7.5.131 : nom du livreur de la remise (avant : « t » pour toute clé « t_<tournée> »)
    const { bac: p } = nouveauBac('admin');
    const T = [{ id: 'T-12', livreur: 'RANOU' }];
    test('clé « t_T-12 » : livreur = celui de la tournée, période = id de la tournée', JSON.stringify(p.rtInfosRemise('t_T-12', null, T)) === JSON.stringify({ livreur: 'RANOU', periode: 'T-12' }));
    test('clé « t_T-12 » : le livreur du montant attendu passe en premier', p.rtInfosRemise('t_T-12', { livreur: 'KARIM' }, T).livreur === 'KARIM');
    test('clé « t_… » d\'une tournée inconnue : livreur vide (jamais « t »)', p.rtInfosRemise('t_T-99', null, T).livreur === '' && p.rtInfosRemise('t_T-99', null, T).periode === 'T-99');
    test('id de tournée contenant « _ » : gardé entier', p.rtInfosRemise('t_T_2026_5', null, [{ id: 'T_2026_5', livreur: 'RANOU' }]).periode === 'T_2026_5');
    test('ancienne clé « LIVREUR_période » : découpage d\'origine', JSON.stringify(p.rtInfosRemise('JEAN PIERRE_2026-05-01', null, [])) === JSON.stringify({ livreur: 'JEAN PIERRE', periode: '2026-05-01' }));
    const { bac, envois } = nouveauBac('admin');
    bac.tournees = [{ id: 'T-Q', livreur: 'RANOU', date: '2026-11-24', statut: 'terminée', stops: [] }];
    bac.window = { _paiRemisesAttendu: { 't_T-Q': { especes: 210, cb: 0, tournee: 'T-Q', livreur: 'RANOU' } } }; bac.caissesRemises = {};
    const rep = ['210']; bac.prompt = () => rep.shift();
    vm.runInContext(extraireFonction('function paiCalculRemise(attendu, saisie)'), bac);
    vm.runInContext(extraireFonction('async function validerRemiseCaisse(key)'), bac);
    await bac.validerRemiseCaisse('t_T-Q'); const rem = envois.find((e) => /caisse_remises/.test(e.url));
    test('validation : caisse_remises.livreur = « RANOU » et periode = « T-Q » (plus de « t »)', rem && rem.body.livreur === 'RANOU' && rem.body.periode === 'T-Q' && rem.body.ecart === 0, rem && rem.body);
  }
  { // v7.5.131 : centimes dans la carte Retour de tournée
    const k = html.indexOf('var eur = function(n){', html.indexOf('window._paiRemisesAttendu = {};'));
    test('carte Retour de tournée : montants avec centimes (paiEur, plus d\'arrondi à l\'euro)', k > 0 && /var eur = function\(n\)\{ return paiEur\(n\); \};/.test(html.slice(k, k + 60)));
    const { bac: p } = nouveauBac('admin');
    test('paiEur : 231,60 € et − 58,40 € (et non 232 € / 58 €)', p.paiEur(231.6) === '231,60 €' && p.paiEur(58.4) === '58,40 €' && p.paiEur(-31.6) === '-31,60 €');
  }
  test('la page transmet bien le reste à remettre (après dépenses) à la validation', /_paiRemisesAttendu\[r\.caisseKey\] = \{ especes: r\.aRemettre/.test(html) && /var aRemettre = Math\.max\(0, especes - depEspLv\);/.test(html));

  // ══════════ 5. Clôture de la tournée ══════════
  console.log('\n5. CLÔTURE DE LA TOURNÉE PAR LE LIVREUR');
  { const { bac, tourneesSauvees } = nouveauBac();
    bac.commandes = [LBC({ id: '#K1', statut: 'livré', stpaie: 'Payé', montantEnc: 180 })];
    bac.tournees = [{ id: 'T-K', livreur: 'RANOU', date: '2026-11-25', statut: 'en cours', stops: [{ cmdId: '#K1', client: 'A', statut: 'livré' }, { cmdId: '#K2', client: 'B', statut: 'en-route' }] }];
    test('bloc de clôture : bouton désactivé et client sans résultat cité', /disabled/.test(bac.lvClotureHtml(bac.tournees[0])) && /2\. B/.test(bac.lvClotureHtml(bac.tournees[0])));
    bac.lvCloturerTournee('T-K');
    test('clôture refusée tant qu\'un arrêt n\'a pas de résultat', bac.tournees[0].statut === 'en cours' && tourneesSauvees.length === 0);
    bac.tournees[0].stops[1].statut = 'absent';
    test('bloc de clôture : bouton actif, espèces à remettre affichées après clôture', !/disabled/.test(bac.lvClotureHtml(bac.tournees[0])));
    bac._confirm = false; bac.lvCloturerTournee('T-K');
    test('clôture annulée par le livreur : rien ne change', bac.tournees[0].statut === 'en cours' && tourneesSauvees.length === 0);
    bac._confirm = true; bac.lvCloturerTournee('T-K');
    test('clôture confirmée : tournée « terminée » enregistrée', bac.tournees[0].statut === 'terminée' && tourneesSauvees.length === 1 && tourneesSauvees[0].statut === 'terminée');
    test('après clôture : « Espèces à remettre : 180 € »', /Espèces à remettre : 180 €/.test(bac.lvClotureHtml(bac.tournees[0])));
    bac.LV_APERCU_ACTIF = true;
    test('en aperçu d\'une autre journée : pas de bloc de clôture', bac.lvClotureHtml(bac.tournees[0]) === '');
    bac.LV_APERCU_ACTIF = false; bac.role = 'admin';
    test('administrateur dans la vue livreur : pas de bloc de clôture', bac.lvClotureHtml(bac.tournees[0]) === '');
  }

  // ══════════ 7. Revue Codex sur f09037c (v7.5.135) ══════════
  console.log('\n7. REVUE CODEX SUR f09037c : Mixte contrôlé, relevé de l\'encaissement, dépenses uniques / figées / journalisées, refus de la base');
  // 7.1 Mixte : mêmes garde-fous que le montant unique
  const mixte = (cmd, esp, cb, motif) => { const x = preparer(cmd); x.bac.sigAutreCas('Mixte'); x.els['sig-ticket'].value = 'TK-MX';
    x.bac.document.getElementById('sig-paie-esp').value = String(esp); x.bac.document.getElementById('sig-paie-cb').value = String(cb);
    x.bac.document.getElementById('sig-mixte-motif').value = motif || ''; return x; };
  { const x = mixte(LBC(), 100, 50, ''); x.bac.validerSig(); await attendre();
    test('Mixte 100 + 50 sur 180 € SANS motif : refusé (avant : accepté sans motif ni alerte)', x.stop.statut !== 'livré' && x.envois.length === 0 && /motif obligatoire/.test(x.bac._toasts.pop()[0]));
    x.bac.document.getElementById('sig-mixte-motif').value = 'Le client paiera le reste par virement'; x.bac.validerSig(); await attendre(); const b = x.envois[0] && x.envois[0].body;
    test('Mixte plus bas AVEC motif : « Partiel », 150 € encaissés, trace « au lieu de 180 € » + motif', b && b.stpaie === 'Partiel' && b.montant_enc === 150 && b.paie === 'Mixte' && /au lieu de 180/.test(b.instr) && /par virement/.test(b.instr), b);
    test('Mixte plus bas : alerte « Encaissement incomplet » au bureau (30 € restent dus)', x.bac._notifs.some((n) => /Encaissement incomplet/.test(n[2]) && /30/.test(n[3])), x.bac._notifs);
    test('Mixte plus bas : motif noté sur l\'arrêt', x.stop.enc && x.stop.enc.motif === 'Le client paiera le reste par virement', x.stop.enc);
  }
  { const x = mixte(LBC(), 150, 50, 'motif quelconque'); x.bac.validerSig(); await attendre();
    test('Mixte 150 + 50 sur 180 € : refusé (jamais plus que le reste dû ; avant : accepté, « Partiel »)', x.stop.statut !== 'livré' && x.envois.length === 0 && /dépasser/.test(x.bac._toasts.pop()[0]));
  }
  { const x = mixte(LBC({ stpaie: 'Payé', montantEnc: 180 }), 100, 80, ''); x.bac.validerSig(); await attendre();
    test('Mixte sur une commande DÉJÀ SOLDÉE : refusé (« Déjà payé »), rien enregistré', x.stop.statut !== 'livré' && x.envois.length === 0 && /Déjà payé/.test(x.bac._toasts.pop()[0]));
  }
  { const x = mixte(LBC({ stpaie: 'Partiel', montantEnc: 50 }), 100, 50, ''); x.bac.validerSig(); await attendre();
    test('Mixte avec acompte 50 € : 100 + 50 dépasse le reste dû (130 €) -> refusé', x.stop.statut !== 'livré' && x.envois.length === 0);
  }
  { const { bac: p } = nouveauBac();
    test('rtControleMixte : montant négatif refusé', p.rtControleMixte(180, -10, 200, 'motif long').ok === false);
    test('rtControleMixte : total exact accepté sans motif', p.rtControleMixte(180, '100', '80', '').ok === true && p.rtControleMixte(180, '100', '80', '').baisse === false);
    test('rtControleMixte : rien saisi refusé', p.rtControleMixte(180, 0, 0, '').ok === false);
    const x = preparer(LBC()); vm.runInContext(extraireFonction('function sigMixteRecap()'), x.bac); x.bac.sigAutreCas('Mixte');
    x.bac.document.getElementById('sig-paie-esp').value = '100'; x.bac.document.getElementById('sig-paie-cb').value = '50'; x.bac.sigMixteRecap();
    const vu = x.els['sig-mixte-motif-wrap'].style.display; x.bac.document.getElementById('sig-paie-cb').value = '80'; x.bac.sigMixteRecap();
    test('affichage : le champ motif Mixte apparaît quand le total est plus bas, disparaît au total exact', vu === 'block' && x.els['sig-mixte-motif-wrap'].style.display === 'none');
  }
  // 7.2 Relevé de ce qui est encaissé PENDANT la tournée : un paiement ultérieur ne change rien après coup
  { const x = preparer(LBC()); x.bac.sigChoixSimple('esp'); x.els['sig-montant'].value = '100'; x.els['sig-montant-motif'].value = 'Le reste sera payé au bureau';
    x.bac.validerSig(); await attendre();
    test('signature 100 € espèces sur 180 € : relevé de l\'arrêt = 100 € espèces, 0 € CB', JSON.stringify(x.stop.encTournee) === JSON.stringify({ esp: 100, cb: 0 }), x.stop.encTournee);
    const avant = pointDe(x.bac);
    const c = x.bac.commandes[0]; c.paie = 'CB'; c.stpaie = 'Payé'; c.montantEnc = 180; // le bureau encaisse plus tard les 80 € restants par carte
    const apres = pointDe(x.bac);
    test('paiement ULTÉRIEUR (80 € CB au bureau) : la tournée garde 100 € espèces, 0 € CB (avant : 0 € espèces, 180 € CB)', apres.especes === 100 && apres.cb === 0 && avant.especes === 100, { avant, apres });
    x.bac.depenses = []; x.bac.renderLivreurCaisse(x.bac.tournees[0]); const h = x.els['lv-caisse-summary'].innerHTML;
    test('caisse du livreur : même relevé (+100 € espèces, aucune CB)', /\+100 €/.test(h) && !/CB \(TPE\)/.test(h), h.slice(0, 300));
  }
  { const x = mixte(LBC(), 80, 100, ''); x.bac.validerSig(); await attendre();
    const c = x.bac.commandes[0]; c.paie = 'Espèces'; c.stpaie = 'Payé'; c.montantEnc = 180; delete c.paie_especes; delete c.paie_cb; // correction faite plus tard
    const pt = pointDe(x.bac);
    test('Mixte 80 / 100 puis correction de la commande : la tournée garde 80 € espèces et 100 € CB', JSON.stringify(x.stop.encTournee) === JSON.stringify({ esp: 80, cb: 100 }) && pt.especes === 80 && pt.cb === 100, pt);
  }
  { const x = preparer(LBC({ stpaie: 'Payé', montantEnc: 180 })); x.bac.sigChoixSimple('deja'); x.bac.validerSig(); await attendre();
    test('« Déjà payé » : relevé 0 € / 0 €', JSON.stringify(x.stop.encTournee) === JSON.stringify({ esp: 0, cb: 0 }), x.stop.encTournee);
  }
  { const x = preparer(LBC()); x.bac.sigAutreCas('non'); x.bac.validerSig(); await attendre();
    test('« Non payé » : relevé 0 € / 0 €', JSON.stringify(x.stop.encTournee) === JSON.stringify({ esp: 0, cb: 0 }), x.stop.encTournee);
  }
  { const r = await editeur({ stpaie: 'Partiel', montantEnc: 50, paie: 'CB' }, { encAvant: 50, encTournee: { esp: 0, cb: 0 } }, { mode: 'CB', statut: 'Payé' });
    test('correction par le livreur PENDANT la tournée (« Encaisser ») : le relevé suit (130 € CB, acompte exclu)', JSON.stringify(r.stop.encTournee) === JSON.stringify({ esp: 0, cb: 130 }), r.stop.encTournee);
  }
  { const { bac: p } = nouveauBac();
    test('relevé présent : il fait foi, quel que soit le cumul actuel de la commande', JSON.stringify(p.rtEncaisseTournee({ paie: 'CB', stpaie: 'Payé', montantEnc: 999 }, { encAvant: 0, encTournee: { esp: 60, cb: 0 } })) === JSON.stringify({ esp: 60, cb: 0 }));
  }
  // 7.3 Dépense sans identifiant de tournée : une seule tournée
  { const { bac } = nouveauBac('admin');
    bac.tournees = [{ id: 'T-B', livreur: 'RANOU', date: '2026-11-25', statut: 'terminée', stops: [] }, { id: 'T-A', livreur: 'RANOU', date: '2026-11-25', statut: 'terminée', stops: [] }, { id: 'T-K', livreur: 'KARIM', date: '2026-11-25', stops: [] }];
    const deps = [{ id: 'sans', livreur: 'RANOU', date: '2026-11-25', modePaie: 'Espèces', montant: 30 }, { id: 'avecB', livreur: 'RANOU', tourneeId: 'T-B', date: '2026-11-25', modePaie: 'Espèces', montant: 12 }];
    const dA = bac.rtDepensesEspecesTournee(bac.tournees[1], deps).map((d) => d.id), dB = bac.rtDepensesEspecesTournee(bac.tournees[0], deps).map((d) => d.id);
    test('deux tournées le même jour : la dépense sans tournée n\'est comptée QU\'UNE fois (première tournée, T-A)', dA.join() === 'sans' && dB.join() === 'avecB', { dA, dB });
    const pA = bac.rtPointCaisse(bac.tournees[1], [], bac.rtDepensesEspecesTournee(bac.tournees[1], deps), bac.rtOutilsPage()), pB = bac.rtPointCaisse(bac.tournees[0], [], bac.rtDepensesEspecesTournee(bac.tournees[0], deps), bac.rtOutilsPage());
    test('total des dépenses déduites sur la journée = 42 € (30 + 12), et non 72 €', pA.depEspeces + pB.depEspeces === 42, { a: pA.depEspeces, b: pB.depEspeces });
    test('une tournée d\'un autre livreur le même jour ne change pas le rattachement', bac.rtDepenseDeTournee(deps[0], bac.tournees[1], bac.tournees) === true && bac.rtDepenseDeTournee(deps[0], bac.tournees[2], bac.tournees) === false);
    test('sans liste de tournées : règle d\'origine (par la date)', bac.rtDepenseDeTournee(deps[0], bac.tournees[0]) === true);
    test('les autres calculs de caisse utilisent la même attribution (5 endroits, plus aucun rattachement « par la date » isolé)', (html.match(/rtDepenseDeTournee\(d, tP?, tournees\)/g) || []).length === 5 && !/d\.tourneeId \? d\.tourneeId === t/.test(html));
  }
  // 7.4 Tournée clôturée / point de caisse validé : plus d'ajout ni de correction hors circuit
  const AUJ7 = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
  { const { bac, els, envois } = nouveauBac();
    bac.tournees = [{ id: 'T-CL', livreur: 'RANOU', date: AUJ7, statut: 'terminée', stops: [] }]; vm.runInContext('currentLvTourneeId = "T-CL";', bac);
    els['m-dep-livreur'] = fauxElement('m-dep-livreur'); els['m-dep-livreur'].style.display = 'none'; bac.ouvrirDepenseLivreur();
    test('livreur, tournée CLÔTURÉE : l\'écran Dépense ne s\'ouvre pas, message clair', els['m-dep-livreur'].style.display === 'none' && /Tournée clôturée/.test(bac._toasts.pop()[0]));
    vm.runInContext('depLvCatSelected = "Parking";', bac); els['dep-lv-montant'] = fauxElement('dep-lv-montant'); els['dep-lv-montant'].value = '9'; await bac.validerDepenseLivreur();
    test('livreur, tournée clôturée : l\'enregistrement est refusé même si l\'écran était resté ouvert', envois.length === 0 && bac.depenses.length === 0);
    bac.depenses = [{ id: 'dx', livreur: 'RANOU', tourneeId: 'T-CL', date: AUJ7, cat: 'Péage', modePaie: 'Espèces', montant: 5, comment: '' }];
    vm.runInContext(extraireFonction('function lvModifierDepense(depId)'), bac);
    let cree = 0; bac.document.createElement = () => { cree++; return fauxElement('x'); };
    bac.lvModifierDepense('dx');
    test('livreur, tournée clôturée : la correction (✏️) est refusée', cree === 0 && /Tournée clôturée/.test(bac._toasts.pop()[0]));
  }
  { const { bac, els, envois } = nouveauBac('admin'); bac.livNom = '';
    bac.tournees = [{ id: 'T-V', livreur: 'RANOU', date: '2026-11-24', statut: 'terminée', stops: [] }];
    bac.ouvrirDepenseLivreur({ tid: 'T-V' }); vm.runInContext('depLvCatSelected = "Carburant";', bac); els['dep-lv-montant'].value = '20';
    await bac.validerDepenseLivreur();
    test('bureau, tournée clôturée, point de caisse PAS encore validé : ajout possible', envois.length === 1 && envois[0].body.tournee_id === 'T-V');
    bac.caissesRemises = { 't_T-V': { validee: true } };
    bac.ouvrirDepenseLivreur({ tid: 'T-V' });
    test('point de caisse VALIDÉ : ajout refusé (« annulez d\'abord la validation »)', /annulez d'abord la validation/.test(bac._toasts.pop()[0]));
    vm.runInContext('depLvCible = { tid: "T-V", depId: "' + bac.depenses[0].id + '" }; depLvCatSelected = "Carburant";', bac); els['dep-lv-montant'].value = '99'; els['dep-lv-motif'].value = 'motif assez long';
    await bac.validerDepenseLivreur();
    test('point de caisse validé : correction refusée, montant inchangé', envois.length === 1 && bac.depenses[0].montant === 20);
    const h = bac.rtLignesDepenses({ t: bac.tournees[0], point: { aRembourser: 0 } });
    test('Retour de tournée validé : plus de bouton ✏️ ni « + Ajouter », mention « dépenses figées »', !/ouvrirDepenseLivreur/.test(h) && /dépenses figées/.test(h), h);
  }
  // 7.5 Journal des corrections
  { const { bac, els, envois } = nouveauBac('admin'); bac.livNom = '';
    bac.tournees = [{ id: 'T-J', livreur: 'RANOU', date: '2026-11-24', statut: 'terminée', stops: [] }];
    bac.ouvrirDepenseLivreur({ tid: 'T-J' }); vm.runInContext('depLvCatSelected = "Achat fournisseur";', bac); els['dep-lv-montant'].value = '45'; els['dep-lv-comment'].value = 'Visserie';
    await bac.validerDepenseLivreur(); const id = bac.depenses[0].id;
    bac.ouvrirDepenseLivreur({ tid: 'T-J', depId: id });
    test('correction : champ motif affiché et vide', els['dep-lv-motif-wrap'].style.display === 'block' && els['dep-lv-motif'].value === '');
    els['dep-lv-montant'].value = '40'; await bac.validerDepenseLivreur();
    test('correction SANS motif : refusée, rien envoyé, montant inchangé', envois.length === 1 && bac.depenses[0].montant === 45 && /motif obligatoire/.test(bac._toasts.pop()[0]));
    els['dep-lv-motif'].value = 'Ticket relu : 40 €'; await bac.validerDepenseLivreur(); const b = envois[1] && envois[1].body;
    test('correction AVEC motif : nouveau montant + ligne de journal (avant → après, auteur, motif) dans le commentaire', b && b.montant === 40 && /^Visserie\n— Journal des corrections —\n/.test(b.comment) && /administrateur : montant 45,00 € → 40,00 € · motif : Ticket relu : 40 €/.test(b.comment), b && b.comment);
    bac.ouvrirDepenseLivreur({ tid: 'T-J', depId: id });
    test('réouverture : le commentaire affiché est le texte seul (sans le journal)', els['dep-lv-comment'].value === 'Visserie');
    els['dep-lv-montant'].value = '40'; els['dep-lv-mode-cb'].dataset.selected = '1'; els['dep-lv-motif'].value = 'Payé avec la carte société';
    await bac.validerDepenseLivreur(); const b2 = envois[2] && envois[2].body;
    test('deuxième correction : le journal garde les deux lignes, dans l\'ordre', b2 && bac.rtDepenseJournal(b2.comment).length === 2 && /montant 45,00/.test(bac.rtDepenseJournal(b2.comment)[0]) && /payée Espèces → CB société/.test(bac.rtDepenseJournal(b2.comment)[1]), b2 && b2.comment);
    const h = bac.rtLignesDepenses({ t: bac.tournees[0], point: { aRembourser: 0 } });
    test('Retour de tournée : le journal est visible sous la dépense', (h.match(/🕓 Corrigée le/g) || []).length === 2 && /Visserie/.test(h), h);
  }
  { const { bac, envois } = nouveauBac();
    bac.tournees = [{ id: 'T-O', livreur: 'RANOU', date: AUJ7, statut: 'en cours', stops: [] }];
    bac.depenses = [{ id: 'dm', livreur: 'RANOU', tourneeId: 'T-O', date: AUJ7, cat: 'Péage', modePaie: 'Espèces', montant: 5, comment: 'A86' }];
    vm.runInContext(extraireFonction('function lvModifierDepense(depId)'), bac);
    const enfants = {};
    bac.document.createElement = () => fauxElement('cree');
    bac.document.body = { appendChild(e) { enfants[e.id] = e; } };
    const base = bac.document.getElementById; bac.document.getElementById = (id) => { if (enfants[id]) return enfants[id]; const e = base(id); if (!e.addEventListener) e.addEventListener = function(ev, fn) { this._clic = fn; }; return e; };
    bac.lvModifierDepense('dm'); const feuille = enfants['lv-dep-sheet'];
    test('livreur, tournée en cours : la correction du mode s\'ouvre avec un motif obligatoire', !!feuille && /MOTIF DE LA CORRECTION/.test(feuille.innerHTML));
    feuille.dataset.mode = 'CB'; bac.document.getElementById('lv-dep-motif').value = '';
    await bac.document.getElementById('lv-dep-valider')._clic();
    test('changement de mode SANS motif : refusé, rien envoyé', envois.length === 0 && bac.depenses[0].modePaie === 'Espèces');
    bac.document.getElementById('lv-dep-motif').value = 'Payé avec la carte société';
    bac.fetch = async (url, opt) => { envois.push({ url, body: opt && opt.body ? JSON.parse(opt.body) : null }); return { ok: false, json: async () => [] }; };
    await bac.document.getElementById('lv-dep-valider')._clic();
    const p = envois.find((e) => e.body && 'mode_paie' in e.body);
    test('changement de mode AVEC motif : mode CB et journal envoyés ensemble', p && p.body.mode_paie === 'CB' && /livreur RANOU : payée Espèces → CB société · motif : Payé avec la carte société/.test(p.body.comment) && bac.rtDepenseTexte(p.body.comment) === 'A86', p && p.body);
  }
  // 7.6 Refus de la base ≠ coupure réseau (sbSaveCommande, constat du 26/11)
  {
    const essai = async (reponse, opts) => { const { bac } = nouveauBac('admin'); const file = [];
      bac.offlineQueueAdd = (t, d) => file.push([t, d && d.id]); bac._sync = []; bac.showSync = (m, t) => bac._sync.push([m, t]);
      bac.fetch = async () => { if (reponse === 'reseau') throw new Error('Failed to fetch'); return { ok: reponse.status < 300, status: reponse.status, text: async () => reponse.texte || '' }; };
      const cmd = LBC({ id: '#R' + (reponse.status || 0) }); let res, leve = null;
      try { res = await bac.sbSaveCommande(cmd, opts); } catch (e) { leve = e; }
      return { bac, file, res, leve, cmd }; };
    let r = await essai({ status: 400, texte: '{"code":"P0001","message":"Produit non vendable : ancienne offre"}' });
    test('refus 400 (produit non vendable) : PAS mis en file d\'attente, résultat « définitif »', r.file.length === 0 && r.res && r.res.definitif === true && r.res.ok === false, r.res);
    test('refus 400 : message clair à l\'écran avec la raison donnée par la base, jamais « Sync en attente »', /NON enregistrée[\s\S]*Produit non vendable/.test((r.bac._toasts.pop() || [''])[0]) && r.bac._sync.some((s) => /refusée par la base/.test(s[0]) && s[1] === 'err') && !r.bac._sync.some((s) => /Sync en attente/.test(s[0])));
    test('refus 400 : alerte gardée dans les notifications, commande marquée', r.bac._notifs.some((n) => /Refusée par la base/.test(n[2]) && /Produit non vendable/.test(n[3])) && r.cmd._syncRefus && r.cmd._syncRefus.status === 400);
    r = await essai({ status: 403, texte: '{"message":"new row violates row-level security policy"}' });
    test('refus 403 (droits) : définitif, pas de file d\'attente', r.file.length === 0 && r.res.definitif === true);
    r = await essai({ status: 503, texte: 'Service Unavailable' });
    test('erreur 503 (base indisponible) : mise en file d\'attente « Sync en attente » (passagère)', r.file.length === 1 && r.res.definitif === false && r.bac._sync.some((s) => /Sync en attente/.test(s[0])));
    r = await essai('reseau');
    test('coupure réseau : mise en file d\'attente (comme avant)', r.file.length === 1 && r.res.reseau === true);
    r = await essai({ status: 503 }, { depuisFile: true });
    test('rejeu de la file + erreur passagère : erreur levée, AUCUN nouvel ajout à la file', !!r.leve && r.file.length === 0);
    r = await essai({ status: 422, texte: '{"message":"contrainte"}' }, { depuisFile: true });
    test('rejeu de la file + refus définitif : pas d\'erreur levée, résultat « définitif »', !r.leve && r.res.definitif === true && r.file.length === 0);
    r = await essai({ status: 201 });
    test('enregistrement réussi : ok, marque de refus effacée', r.res.ok === true && !r.cmd._syncRefus);
    const { bac: p } = nouveauBac();
    test('classement : 400 / 401 / 403 / 404 / 409 / 422 = définitif ; 0 / 408 / 429 / 500 / 503 = passager', [400, 401, 403, 404, 409, 422].every((s) => p.syncRefusDefinitif(s)) && [0, 408, 429, 500, 503].every((s) => !p.syncRefusDefinitif(s)));
    // vraie file d'attente : un refus définitif en sort, une erreur passagère y reste UNE fois, aucune boucle
    const { bac: q } = nouveauBac('admin'); const appels = [];
    delete q.offlineQueueAdd; vm.runInContext('var offlineQueue = [];', q);
    vm.runInContext(extraireFonction('function offlineQueueAdd(type, data)') + ' ' + extraireFonction('async function offlineQueueFlush()'), q);
    q.fetch = async (url, opt) => { const id = JSON.parse(opt.body).id; appels.push(id); if (appels.length > 20) throw new Error('boucle'); return id === '#DEF' ? { ok: false, status: 400, text: async () => '{"message":"refus"}' } : { ok: false, status: 503, text: async () => '' }; };
    q.offlineQueueAdd('commande', LBC({ id: '#DEF' })); q.offlineQueueAdd('commande', LBC({ id: '#TMP' })); q.offlineQueueAdd('commande', LBC({ id: '#TMP', instr: 'version plus récente' }));
    test('file : une seule entrée par commande (la plus récente)', q.offlineQueue.length === 2 && q.offlineQueue[1].data.instr === 'version plus récente');
    await q.offlineQueueFlush();
    test('rejeu : 2 envois seulement (plus de boucle), refus définitif retiré, erreur passagère gardée une fois', appels.length === 2 && q.offlineQueue.length === 1 && q.offlineQueue[0].data.id === '#TMP', { appels, file: q.offlineQueue.map((i) => i.data.id) });
    test('rejeu : l\'utilisatrice est prévenue du refus', q._toasts.some((t) => /refusée\(s\) par la base/.test(t[0])));
    q.fetch = async () => ({ ok: true, status: 201, text: async () => '' }); await q.offlineQueueFlush();
    test('retour du réseau : la file se vide', q.offlineQueue.length === 0);
  }

  // ══════════ 8. Revue Codex sur 3c3aa05 (v7.5.171) ══════════
  console.log('\n8. REVUE CODEX SUR 3c3aa05 : « Déjà payé » contrôlé, livraisons terminées ≠ clôture, verrou du point de caisse partout');
  // 8.1 « Déjà payé » réservé aux commandes déjà soldées dans la base
  { const { bac: p } = nouveauBac();
    test('règle pure : commande soldée (reste dû 0) -> accepté, sans forçage', JSON.stringify(p.rtControleDejaPaye(0, 'livreur', '')) === JSON.stringify({ ok: true, force: false, reste: 0, erreur: '' }));
    test('règle pure : non soldée + livreur -> refusé même avec un motif (« encaissez ou signalez au bureau »)', !p.rtControleDejaPaye(180, 'livreur', 'motif très long').ok && /reste dû 180,00 €\) : encaissez ou signalez au bureau/.test(p.rtControleDejaPaye(180, 'livreur', 'x').erreur));
    test('règle pure : non soldée + collaboratrice (ni livreur ni administrateur) -> refusé', !p.rtControleDejaPaye(180, 'collab', 'motif très long').ok);
    test('règle pure : non soldée + administrateur SANS motif (ou trop court) -> refusé', !p.rtControleDejaPaye(180, 'admin', '').ok && !p.rtControleDejaPaye(180, 'admin', 'abc').ok && /motif obligatoire/.test(p.rtControleDejaPaye(180, 'admin', '').erreur));
    test('règle pure : non soldée + administrateur AVEC motif -> accepté, « forcé », reste dû gardé', JSON.stringify(p.rtControleDejaPaye(130, 'admin', 'virement reçu le 25/11')) === JSON.stringify({ ok: true, force: true, reste: 130, erreur: '' }));
  }
  { const x = preparer(LBC({ stpaie: 'Partiel', montantEnc: 50 })); x.bac.sigChoixSimple('deja');
    test('signature, acompte 50 € sur 180 € : avertissement dès le choix « Déjà payé » (reste dû 130 €), pas de champ motif pour le livreur', x.els['sig-deja-info'].style.display === 'block' && /130,00 €/.test(x.els['sig-deja-info'].textContent) && x.els['sig-deja-motif-wrap'].style.display === 'none', x.els['sig-deja-info'].textContent);
    x.bac.validerSig(); await attendre();
    test('signature, acompte partiel + « Déjà payé » par le livreur : refusé, rien enregistré', x.stop.statut !== 'livré' && x.envois.length === 0 && /encaissez ou signalez au bureau/.test(x.bac._toasts.pop()[0]));
    x.bac.sigChoixSimple('esp');
    test('changement de choix (Espèces) : l\'avertissement « Déjà payé » disparaît', x.els['sig-deja-info'].style.display === 'none');
  }
  { const x = preparer(LBC({ stpaie: 'Partiel', montantEnc: 180 })); x.bac.sigChoixSimple('deja');
    test('signature, acompte couvrant TOUT le prix : pas d\'avertissement', x.els['sig-deja-info'].style.display === 'none');
    x.bac.validerSig(); await attendre(); const b = x.envois[0] && x.envois[0].body;
    test('signature, acompte couvrant tout + « Déjà payé » : accepté, Payé, aucune trace de forçage', x.stop.statut === 'livré' && b && b.stpaie === 'Payé' && !/FORCÉ/.test(b.instr || '') && !x.stop.dejaForce, b);
  }
  { const x = preparer(LBC()); x.bac.role = 'admin'; x.bac.sigChoixSimple('deja');
    test('administrateur, commande non payée : champ motif affiché', x.els['sig-deja-motif-wrap'].style.display === 'block' && /motif obligatoire pour forcer/.test(x.els['sig-deja-info'].textContent));
    x.bac.validerSig(); await attendre();
    test('administrateur SANS motif : refusé, rien enregistré', x.stop.statut !== 'livré' && x.envois.length === 0 && /motif obligatoire/.test(x.bac._toasts.pop()[0]));
    x.els['sig-deja-motif'].value = 'Virement reçu le 25/11, vérifié'; x.bac.validerSig(); await attendre(); const b = x.envois[0] && x.envois[0].body;
    test('administrateur AVEC motif : « Déjà payé » forcé, Payé', x.stop.statut === 'livré' && b && b.stpaie === 'Payé' && b.paie === 'Déjà payé', b);
    test('forçage journalisé dans la fiche (reste dû, motif, auteur) et sur l\'arrêt', b && /« Déjà payé » FORCÉ sans paiement enregistré \(reste dû 180 €\) — motif : Virement reçu le 25\/11, vérifié \(administrateur, /.test(b.instr) && x.stop.dejaForce && x.stop.dejaForce.reste === 180 && x.stop.dejaForce.motif === 'Virement reçu le 25/11, vérifié', b && b.instr);
    test('forçage signalé au bureau (notification)', x.bac._notifs.some((n) => /« Déjà payé » forcé/.test(n[2]) && /Virement reçu/.test(n[3])));
    test('après validation : champ motif vidé et masqué', x.els['sig-deja-motif'].value === '' && x.els['sig-deja-motif-wrap'].style.display === 'none');
  }
  // éditeur de paiement du livreur (après la signature) : même règle
  { const r = await editeur({ stpaie: 'Payé', montantEnc: 180, paie: 'Espèces' }, { encTournee: { esp: 180, cb: 0 }, paie: 'Espèces', stpaie: 'Payé' }, { mode: 'Déjà payé', statut: 'Payé' });
    test('éditeur, livreur : 180 € encaissés en espèces à l\'arrêt puis « Déjà payé » -> refusé (sinon les espèces disparaissent de la caisse)', r.envois.length === 0 && r.cmd.paie === 'Espèces' && r.stop.paie === 'Espèces' && /encaissez ou signalez au bureau/.test(r.bac._toasts.pop()[0]));
  }
  { const r = await editeur({ stpaie: 'Non payé', montantEnc: 0, paie: 'Espèces' }, { paie: 'Espèces', stpaie: 'Non payé' }, { mode: 'Déjà payé', statut: 'Payé' });
    test('éditeur, livreur : commande « Non payé » -> « Déjà payé » refusé, dette conservée', r.envois.length === 0 && r.cmd.stpaie === 'Non payé');
  }
  { const r = await editeur({ stpaie: 'Payé', montantEnc: 180, paie: 'Déjà payé' }, { paie: 'Déjà payé', stpaie: 'Payé', encTournee: { esp: 0, cb: 0 } }, { mode: 'Déjà payé', statut: 'Payé' });
    test('éditeur, livreur : arrêt déjà « Déjà payé » (contrôlé à la signature) -> accepté', r.envois.length === 1 && r.b && r.b.stpaie === 'Payé');
  }
  { const r = await editeur({ stpaie: 'Payé', montantEnc: 180, paie: 'Virement' }, { paie: 'Espèces', stpaie: 'Non payé', encTournee: { esp: 0, cb: 0 } }, { mode: 'Déjà payé', statut: 'Payé' });
    test('éditeur, livreur : commande soldée par le bureau (virement), rien encaissé à l\'arrêt -> accepté', r.envois.length === 1 && r.b && r.b.paie === 'Déjà payé');
  }
  { const r = await editeur({ stpaie: 'Non payé', montantEnc: 0, paie: 'Espèces' }, { paie: 'Espèces', stpaie: 'Non payé' }, { mode: 'Déjà payé', statut: 'Payé' }, 'admin', '');
    test('éditeur, administrateur SANS motif : refusé', r.envois.length === 0 && /motif obligatoire/.test(r.bac._toasts.pop()[0]));
  }
  { const r = await editeur({ stpaie: 'Non payé', montantEnc: 0, paie: 'Espèces' }, { paie: 'Espèces', stpaie: 'Non payé' }, { mode: 'Déjà payé', statut: 'Payé' }, 'admin', 'Payé sur TikTok Shop, vérifié');
    test('éditeur, administrateur AVEC motif : forcé et journalisé (fiche, arrêt, notification)', r.envois.length === 1 && r.b && r.b.stpaie === 'Payé' && /FORCÉ[\s\S]*motif : Payé sur TikTok Shop, vérifié \(administrateur, /.test(r.b.instr) && r.stop.dejaForce && r.bac._notifs.some((n) => /« Déjà payé » forcé/.test(n[2])), r.b && r.b.instr);
  }
  // 8.2 Livraisons terminées (automatique) ≠ tournée clôturée (geste explicite)
  { const { bac: p } = nouveauBac();
    test('fin des livraisons : tous livrés/annulés = terminées ; tournée vide ou arrêt restant = non', p.rtLivraisonsTerminees({ stops: [{ statut: 'livré' }, { statut: 'annulé' }] }) && !p.rtLivraisonsTerminees({ stops: [] }) && !p.rtLivraisonsTerminees({ stops: [{ statut: 'livré' }, { statut: 'reporté' }] }));
    test('statut après un arrêt : livraisons terminées -> « en cours » (plus « terminée » d\'office)', p.rtStatutApresArret({ statut: 'en cours', stops: [{ statut: 'livré' }] }) === 'en cours' && p.rtStatutApresArret({ statut: 'préparée', stops: [{ statut: 'annulé' }] }) === 'en cours');
    test('statut après un arrêt : tournée déjà clôturée -> reste « terminée » ; en route -> « en cours » ; sinon inchangé', p.rtStatutApresArret({ statut: 'terminée', stops: [{ statut: 'livré' }] }) === 'terminée' && p.rtStatutApresArret({ statut: 'préparée', stops: [{ statut: 'en-route' }] }) === 'en cours' && p.rtStatutApresArret({ statut: 'préparée', stops: [{ statut: 'en-attente' }] }) === 'préparée');
  }
  { const x = preparer(LBC()); const { bac, els, envois } = x; bac.sigChoixSimple('esp'); bac.validerSig(); await attendre();
    const t = bac.tournees[0];
    test('dernière signature : arrêt livré, la tournée reste « en cours » (pas clôturée d\'office)', x.stop.statut === 'livré' && t.statut === 'en cours', t.statut);
    const h = bac.lvClotureHtml(t);
    test('bloc de fin : « Livraisons terminées », invitation aux dépenses du retour, bouton « Clôturer ma tournée » actif', /Livraisons terminées/.test(h) && /dépenses du retour/.test(h) && /🏁 Clôturer ma tournée/.test(h) && !/disabled/.test(h) && !/✅ Tournée clôturée/.test(h), h.slice(0, 400));
    test('livraisons terminées : le livreur peut encore ajouter une dépense (règle)', bac.rtDepenseModifiable(t, 'livreur', false).ok === true);
    const n0 = envois.length;
    els['m-dep-livreur'] = fauxElement('m-dep-livreur'); els['m-dep-livreur'].style.display = 'none';
    bac.depLvTourneeVisee = () => t; // la tournée du test (date fixe) est celle que le livreur regarde
    bac.ouvrirDepenseLivreur();
    test('livraisons terminées : l\'écran Dépense s\'ouvre (péage du retour)', els['m-dep-livreur'].style.display === 'flex');
    vm.runInContext('depLvCatSelected = "Péage"; currentLvTourneeId = "T-TEST";', bac); els['dep-lv-montant'].value = '6,40'; await bac.validerDepenseLivreur();
    const dern = envois[envois.length - 1] && envois[envois.length - 1].body;
    test('livraisons terminées : la dépense du retour est enregistrée sur la tournée', envois.length === n0 + 1 && dern && dern.tournee_id === 'T-TEST' && dern.montant === 6.4, dern);
    bac.lvCloturerTournee('T-TEST');
    test('« Clôturer ma tournée » (geste explicite) : tournée « terminée »', t.statut === 'terminée');
    bac.ouvrirDepenseLivreur();
    test('après la clôture explicite : dépense refusée au livreur (« Tournée clôturée »)', /Tournée clôturée/.test(bac._toasts.pop()[0]));
  }
  { const sig = extraireFonction('function validerSig()'), st = extraireFonction('function setLvSt(tid, idx, st, _annOk)'), modif = extraireFonction('function sauvegarderModif()');
    test('code : validerSig et setLvSt ne clôturent plus la tournée d\'office', !/statut\s*=\s*'terminée'/.test(sig) && !/statut\s*=\s*'terminée'/.test(st) && /rtStatutApresArret\(t\)/.test(sig) && /rtStatutApresArret\(t\)/.test(st));
    test('code : une modification de la tournée par le bureau ne la clôture plus d\'office', /if \(rtLivraisonsTerminees\(t\)\) t\.statut = \(t\.statut === 'terminée'\) \? 'terminée' : 'en cours';/.test(modif));
  }
  // 8.3 Verrou du point de caisse validé sur la liste Finance (modifier, enregistrer, supprimer, ajouter)
  const bacFinance = () => { const x = nouveauBac('admin'); const { bac } = x; bac.livNom = '';
    for (const f of ['function modifierDepense(id)', 'async function sauvegarderDepenseEdit()', 'function supprimerDepense(id)', 'function sauvegarderDepense()']) vm.runInContext(extraireFonction(f), bac);
    bac.window = {}; bac._ouvert = 0; bac._supprimees = []; bac._sauvees = [];
    bac.ouvrirAjoutDepense = () => { bac._ouvert++; }; bac.lockBtn = () => {}; bac.closeModal = () => {}; bac.finRender = () => {}; bac.depSelectMode = () => {}; bac.validerFormDepense = () => true;
    bac.sbDeleteDepense = (id) => { bac._supprimees.push(id); }; bac.sbSaveDepense = async (d) => { bac._sauvees.push(d); };
    bac._confirmes = 0; bac.confirm = () => { bac._confirmes++; return true; };
    bac.console = { log() {}, warn() {}, error() {} };
    bac.document.getElementById('dep-mode-cb').style.background = ''; bac.document.getElementById('dep-mode-cb').style.borderColor = '';
    bac.document.getElementById('dep-cat').options = []; bac.document.getElementById('dep-livreur').options = []; bac.document.getElementById('dep-livreur').appendChild = () => {}; bac.document.createElement = () => ({});
    bac.tournees = [{ id: 'T-F', livreur: 'RANOU', date: '2026-11-24', statut: 'terminée', stops: [] }, { id: 'T-G', livreur: 'RANOU', date: '2026-11-23', statut: 'terminée', stops: [] }];
    bac.caissesRemises = { 't_T-F': { validee: true } };
    bac.depenses = [{ id: 'df', livreur: 'RANOU', tourneeId: 'T-F', date: '2026-11-24', cat: 'Carburant', modePaie: 'Espèces', montant: 30, comment: '' },
      { id: 'dn', livreur: 'RANOU', date: '2026-11-24', cat: 'Péage', modePaie: 'Espèces', montant: 5, comment: '' },
      { id: 'dg', livreur: 'RANOU', tourneeId: 'T-G', date: '2026-11-23', cat: 'Parking', modePaie: 'Espèces', montant: 4, comment: '' }];
    const champs = (v) => { for (const k of Object.keys(v)) bac.document.getElementById(k).value = v[k]; };
    return Object.assign(x, { champs }); };
  { const { bac, envois, champs } = bacFinance();
    bac.modifierDepense('df');
    test('Finance, point de caisse validé : « Modifier » refusé (annulez d\'abord la validation), fenêtre non ouverte', bac._ouvert === 0 && /annulez d'abord la validation/.test(bac._toasts.pop()[0]) && !bac.window._depEditMode);
    bac.modifierDepense('dn');
    test('Finance : dépense SANS tournée, rattachée par la date à la tournée validée -> refusée aussi', bac._ouvert === 0 && /T-F/.test(bac._toasts.pop()[0]));
    bac.supprimerDepense('df');
    test('Finance, point de caisse validé : « Supprimer » refusé, ni confirmation ni suppression', bac._confirmes === 0 && bac._supprimees.length === 0 && bac.depenses.length === 3 && /annulez d'abord la validation/.test(bac._toasts.pop()[0]));
    bac.window._depEditMode = 'df'; champs({ 'dep-montant': '99', 'dep-date': '2026-11-24', 'dep-cat': 'Carburant', 'dep-livreur': 'RANOU', 'dep-comment': '' });
    await bac.sauvegarderDepenseEdit();
    test('Finance : enregistrement d\'une correction ouverte AVANT la validation -> refusé, rien envoyé, montant inchangé', envois.length === 0 && bac.depenses[0].montant === 30 && /annulez d'abord la validation/.test(bac._toasts.pop()[0]));
    bac.window._depEditMode = 'dg'; bac.depenses[2].tourneeId = null; champs({ 'dep-montant': '4', 'dep-date': '2026-11-24', 'dep-cat': 'Parking', 'dep-livreur': 'RANOU', 'dep-comment': '' });
    await bac.sauvegarderDepenseEdit();
    test('Finance : correction qui ferait ENTRER une dépense dans la tournée validée (date changée) -> refusée', envois.length === 0 && bac.depenses[2].date === '2026-11-23');
    bac.window._depEditMode = null; champs({ 'dep-montant': '12', 'dep-date': '2026-11-24', 'dep-cat': 'Carburant', 'dep-livreur': 'RANOU', 'dep-comment': 'ajout tardif' });
    bac.sauvegarderDepense();
    test('Finance : AJOUT d\'une dépense espèces du livreur à la date de la tournée validée -> refusé, rien ajouté', bac.depenses.length === 3 && bac._sauvees.length === 0 && /annulez d'abord la validation/.test(bac._toasts.pop()[0]));
    champs({ 'dep-date': '2026-11-22' }); bac.sauvegarderDepense(); await attendre();
    test('Finance : ajout à une autre date (aucune tournée validée) -> accepté', bac.depenses.length === 4 && bac._sauvees.length === 1);
  }
  { const { bac, envois, champs } = bacFinance(); bac.caissesRemises = {}; // validation annulée
    bac.modifierDepense('df');
    test('validation annulée : « Modifier » ouvre la fenêtre', bac._ouvert === 1 && bac.window._depEditMode === 'df');
    champs({ 'dep-montant': '28', 'dep-date': '2026-11-24', 'dep-cat': 'Carburant', 'dep-livreur': 'RANOU', 'dep-comment': '' });
    await bac.sauvegarderDepenseEdit();
    test('validation annulée : la correction est enregistrée (PATCH envoyé)', envois.length === 1 && /depenses\?id=eq\.df/.test(envois[0].url) && envois[0].body.montant === 28 && bac.depenses[0].montant === 28, envois[0]);
    bac.supprimerDepense('dg');
    test('validation annulée : la suppression passe (confirmation puis suppression)', bac._confirmes === 1 && bac._supprimees[0] === 'dg' && bac.depenses.length === 2);
  }
  { const { bac, envois } = nouveauBac();
    bac.tournees = [{ id: 'T-O2', livreur: 'RANOU', date: AUJ7, statut: 'en cours', stops: [] }];
    bac.depenses = [{ id: 'dm2', livreur: 'RANOU', tourneeId: 'T-O2', date: AUJ7, cat: 'Péage', modePaie: 'Espèces', montant: 5, comment: '' }];
    vm.runInContext(extraireFonction('function lvModifierDepense(depId)'), bac);
    const enfants = {}; bac.document.createElement = () => fauxElement('cree'); bac.document.body = { appendChild(e) { enfants[e.id] = e; } };
    const base = bac.document.getElementById; bac.document.getElementById = (id) => { if (enfants[id]) return enfants[id]; const e = base(id); if (!e.addEventListener) e.addEventListener = function(ev, fn) { this._clic = fn; }; return e; };
    bac.lvModifierDepense('dm2'); const feuille = enfants['lv-dep-sheet'];
    bac.caissesRemises = { 't_T-O2': { validee: true } }; // validation arrivée pendant que la fenêtre était ouverte
    feuille.dataset.mode = 'CB'; bac.document.getElementById('lv-dep-motif').value = 'Payé avec la carte société';
    await bac.document.getElementById('lv-dep-valider')._clic();
    test('livreur : changement de mode enregistré APRÈS la validation du point de caisse -> refusé, rien envoyé', envois.length === 0 && bac.depenses[0].modePaie === 'Espèces' && /annulez d'abord la validation/.test(bac._toasts.pop()[0]));
  }

  // ══════════ 6. Garde-fous (lecture du code) ══════════
  console.log('\n6. GARDE-FOUS (lecture du code)');
  const blocRT = extraireBloc('// ── RT-DEBUT', '// RT-FIN');
  test('bloc RT pur : aucune écriture, aucun accès à la page', !/fetch\(|sbSave|localStorage|document\.|window\./.test(blocRT));
  const stDefs = (html.match(/var stDefs = \[([\s\S]*?)\];/) || [])[1] || '';
  test('aucun nouveau statut : les boutons utilisent livré / reporté / absent déjà présents dans stDefs', ["k:'livré'", "k:'reporté'", "k:'absent'"].every((k) => stDefs.includes(k)) && /k:'livré'.*k:'reporté'.*k:'absent'/.test(html.slice(html.indexOf('var resBtns'), html.indexOf('var resBtns') + 600)));
  test('trois gros boutons Livré / Reporté / Client absent dans la carte', /'Livré'[\s\S]{0,200}'Reporté'[\s\S]{0,200}'Client absent'/.test(html.slice(html.indexOf('var resBtns'), html.indexOf('var resBtns') + 800)));
  test('signature : boutons Espèces / Carte bleue / Déjà payé', /id="sig-lv-esp"[\s\S]{0,200}Espèces[\s\S]{0,300}id="sig-lv-cb"[\s\S]{0,200}Carte bleue[\s\S]{0,300}id="sig-paie-deja"[\s\S]{0,200}Déjà payé/.test(html));
  test('fenêtre « Reporté » avec date facultative', /id="m-report"[\s\S]{0,1500}type="date" id="report-date"/.test(html));
  test('Retour de tournée : bouton « Valider le point de caisse » branché sur validerRemiseCaisse (caisse_remises)', /validerRemiseCaisse\(\\'' \+ r\.caisseKey \+ '\\'\)"[^>]*>✅ Valider le point de caisse/.test(html));
  test('validerRemiseCaisse écrit toujours dans caisse_remises (mécanisme existant)', /rest\/v1\/caisse_remises', \{\s*method: 'POST'/.test(extraireFonction('async function validerRemiseCaisse(key)')));
  test('ancre JARVIS (bloc JVUE) présente', html.indexOf('// JVUE-DEBUT') > 0 && html.indexOf('// JVUE-FIN') > html.indexOf('// JVUE-DEBUT'));
  test('CACHE_VERSION augmentée (v7-5-171 ou plus)', /CACHE_VERSION = 'maxiconfort-v7-5-1(7[1-9]|[89]\d)'/.test(fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8')));

  console.log('\n' + ok + ' OK, ' + ko + ' échec(s)');
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
