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
function fauxElement(id) { return { id, value: '', checked: true, open: false, style: {}, dataset: {}, innerHTML: '', textContent: '', disabled: false, classList: { add() {}, remove() {}, contains() { return false; } }, querySelectorAll() { return []; }, insertAdjacentHTML() {}, parentNode: null }; }
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
    findCmdForStop(s) { return bac.commandes.find((c) => c.id === s.cmdId) || null; }, findStopForCmd: () => null, retirerStockCamion() {},
    sendCmdSmsAsync() {}, annDemanderMotif() {}, fmtDate: (d) => d, paiVerrouBody() {},
  };
  vm.createContext(bac);
  vm.runInContext(extraireBloc('var PAI_MODE_SITE', '// PAI-FIN'), bac);
  vm.runInContext(extraireBloc('// ── RT-DEBUT', '// RT-FIN'), bac);
  vm.runInContext(extraireFonction('async function sbSaveCommande(cmd)'), bac);
  vm.runInContext('var sigStopId=null, sigPaieEncaisse=false, sigPaieMode="Espèces", sigPrepaidMode=null, sigCmdMarketplace=null, sigCtx=null, scv=null, sigCodActif=false, sigCodChoix=null, sigCodMontant=0;', bac);
  vm.runInContext(extraireBloc('// v7.5.129 : choix simple Espèces / Carte bleue / Déjà payé.', 'var sigCodActif = false;'), bac);
  vm.runInContext('var MODES_PAIE = ' + JSON.stringify([{ id: 'LeBonCoin', cat: 'prepaye' }, { id: 'Déjà payé', cat: 'prepaye' }, { id: 'Espèces', cat: 'livreur' }]) + ';', bac);
  for (const f of ['function _sigPaieBtns(actif)', 'function sigTogglePaie(encaisse)', 'function sigDejaPaye()', 'function sigSelectMode(mode)', 'function sigCodChoisir(ch)', 'function paiSigPreparer(cmdSig, banner)', 'function validerSig()',
    'function setLvSt(tid, idx, st, _annOk)', 'function getMontantEspecesCmd(c)', 'function getMontantCBCmd(c)', 'function getCmdsLivresParTournee(t)',
    'function rtOutilsPage()', 'function rtDepensesEspecesTournee(t, liste)', 'function lvClotureHtml(t)', 'function lvCloturerTournee(tid)',
    'function lvReporter(tid, idx, statut)', 'function lvFermerReport()', 'function lvValiderReport()', 'function lvAbsent(tid, idx)',
    // v7.5.130 : dépenses du livreur
    'function ouvrirDepenseLivreur(cible)', 'function depLvSelectMode(mode)', 'async function validerDepenseLivreur()', 'function rtLignesDepenses(r)', 'function rtEchapper(s)', 'function renderLivreurCaisse(t)'])
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
  { const cmd = LBC(); const { bac, envois } = preparer(cmd); bac.sigChoixSimple('deja');
    bac.validerSig(); await attendre(); const b = envois[0] && envois[0].body;
    test('Déjà payé : Payé, rien encaissé sur place (comportement existant)', b && b.stpaie === 'Payé' && b.paie === 'Déjà payé' && !b.encaisse_par, b);
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
    els['dep-lv-montant'].value = '40';
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
  test('CACHE_VERSION augmentée (v7-5-130 ou plus)', /CACHE_VERSION = 'maxiconfort-v7-5-1([3-9]\d)'/.test(fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8')));

  console.log('\n' + ok + ' OK, ' + ko + ' échec(s)');
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
