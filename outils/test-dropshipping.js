// Banc de test du dropshipping encadré et de la provenance de chaque pièce (v7.5.199, migration 041, 27/11/2026).
// Usage : node outils/test-dropshipping.js
// Il EXTRAIT le vrai code de maxiconfort-v7.html (bloc DROP-DEBUT … DROP-FIN, file d'attente hors ligne et son rejeu,
// calculerProgressionChargement) et l'exécute dans un bac à sable : aucune connexion, `fetch` remplacé par un faux qui note
// ce qui serait envoyé. VALEURS FICTIVES (dépôt public) : aucun client, fournisseur ni prix réel.
// La base elle-même (fonctions drop_*) est testée par outils/test-041-pglite.js.
const fs = require('fs'), path = require('path'), vm = require('vm');
const racine = path.join(__dirname, '..');
const html = fs.readFileSync(process.env.MX_HTML || path.join(racine, 'maxiconfort-v7.html'), 'utf8').replace(/\r\n/g, '\n');
function extraireBloc(debut, fin) { const i = html.indexOf(debut), j = html.indexOf(fin, i + 1); if (i < 0 || j < 0) throw new Error('bloc introuvable : ' + debut); return html.slice(i, j); }
function extraireFonction(signature) {
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
const test = (nom, cond, det) => { if (cond) { ok++; console.log('  OK    ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (det !== undefined ? ' — ' + JSON.stringify(det).slice(0, 300) : '')); } };
const attendre = async (n) => { for (let k = 0; k < (n || 6); k++) await new Promise((r) => setImmediate(r)); };

const CODE_DROP = extraireBloc('// DROP-DEBUT', '// DROP-FIN');
const CODE_FILE = extraireBloc('var offlineQueue = [];', '// v7.5.68 : échec');
const CODE_REJEU = extraireBloc('// v7.5.191 : un seul rejeu à la fois', '// Détecter retour en ligne');
const CODE_PROG = extraireFonction('function calculerProgressionChargement(t)');
const CODE_EUR = extraireFonction('function paiEur(n)'); // montants affichés comme dans l'appli

function fauxElement(id) { return { id, value: '', style: {}, dataset: {}, innerHTML: '', textContent: '', disabled: false, remove() {}, appendChild() {}, parentNode: null }; }
function nouveauBac({ role = 'livreur', reponse = () => ({ status: 200, json: { ok: true } }), stock = {} } = {}) {
  const els = {}, stockage = Object.assign({}, stock);
  const bac = {
    console: { log() {}, warn() {}, error() {} }, Math, Date, JSON, String, Array, Object, Number, parseInt, parseFloat, isNaN, Promise, encodeURIComponent, URL,
    setTimeout: () => 0, clearTimeout() {}, navigator: { onLine: true },
    SUPABASE_URL: 'https://exemple.invalid', SUPABASE_KEY: 'cle-de-test', role, livNom: 'LIVREUR-TEST',
    localStorage: { getItem: (k) => (k in stockage ? stockage[k] : null), setItem: (k, v) => { stockage[k] = String(v); }, removeItem: (k) => { delete stockage[k]; } },
    document: { getElementById: (id) => (els[id] = els[id] || fauxElement(id)), createElement: (t) => fauxElement(t), querySelectorAll: () => [], querySelector: () => null, body: { appendChild() {} } },
    toast(m, t) { bac._toasts.push([m, t]); }, _toasts: [], notifAjout(...a) { bac._notifs.push(a); }, _notifs: [],
    confirm: () => true, _envois: [],
    fetch: async (url, opt = {}) => {
      const env = { url, method: opt.method || 'GET', body: opt.body && typeof opt.body === 'string' ? JSON.parse(opt.body) : null };
      bac._envois.push(env);
      const r = reponse(url, opt, env);
      if (r === 'reseau') throw new Error('Failed to fetch');
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => (r.json === undefined ? '' : JSON.stringify(r.json)), json: async () => r.json };
    },
    commandes: [], tournees: [], depenses: [], chargements: {}, currentLvTourneeId: null, currentCmdId: null,
    sbSaveCommande: async () => ({ ok: true }), sbSaveTournee: async () => {}, sbSaveDepense: async () => {}, sbSaveVehicule: async () => {}, sbSaveEntretien: async () => {}, sbSaveLivreur: async () => {}, sbSaveProduit: async () => 'ok',
    renderLivreur() { bac._rendus++; }, _rendus: 0, sasGenererListe() {}, sasMettreAJourCompteur() {}, toggleChargement(c, i, v) { bac._coches.push([c, i, v]); }, _coches: [],
    findCmdForStop(s) { return bac.commandes.find((c) => c.id === s.cmdId) || null; },
    prompt: () => bac._prompt, _prompt: null, dropFicheCommande() {}, livEstLivre: (st) => st === 'livré' || st === 'livre',
  };
  vm.createContext(bac);
  vm.runInContext(CODE_EUR + '\n' + CODE_FILE +'\n' + CODE_REJEU + '\n' + CODE_DROP + '\n' + CODE_PROG, bac);
  return { bac, els, stockage };
}
const PIECE = (id, champs) => Object.assign({ id, cmd_id: '#D1', ligne_idx: 0, piece_idx: 0, produit_id: 'p-m', libelle: 'Matelas fictif', provenance: null, livraison: null, drop_actif: false, fournisseurs: [], camion: [] }, champs || {});

(async () => {
  // ════════════════════════════════════════════════════════════════════════════════════
  console.log('\n1. FONCTIONS PURES');
  const { bac: p } = nouveauBac();
  test('montant : virgule acceptée, arrondi au centime', JSON.stringify(p.dropMontant('12,345')) === JSON.stringify({ ok: true, montant: 12.35 }));
  test('montant : vide, 0, négatif, texte refusés', ['', '0', '-3', 'abc', null].every((v) => p.dropMontant(v).ok === false));
  test('montant : plafond 5 000 €', p.dropMontant('5000').ok === true && p.dropMontant('5000,01').ok === false);
  test('écart payé − prévu', p.dropEcart(160, 165) === 5 && p.dropEcart(160, 158.5) === -1.5 && p.dropEcart(160, 160) === 0);
  test('chemin du ticket = <livreur>/<commande sans #>/<fichier> (même règle que la base)', p.dropCheminTicket('LIVREUR-TEST', '#2145', 7, 111) === 'livreur-test/2145/ticket-7-111.jpg');
  const ps2 = [PIECE(1, { provenance: 'depot' }), PIECE(2, { piece_idx: 1, provenance: null }), PIECE(3, { ligne_idx: 1, provenance: 'fournisseur' })];
  test('ligne : complète seulement si chaque pièce a sa provenance', p.dropEtatLigne(ps2, 0).complete === false && p.dropEtatLigne(ps2, 1).complete === true);
  test('ligne chargée : pièces déclarées ET (cochée, ou aucune pièce Dépôt)', p.dropLigneChargee(ps2, 1, false) === true && p.dropLigneChargee([PIECE(1, { provenance: 'depot' })], 0, false) === false
    && p.dropLigneChargee([PIECE(1, { provenance: 'depot' })], 0, true) === true && p.dropLigneChargee(ps2, 0, true) === false);
  test('ligne sans pièces connues : règle d\'avant (case cochée)', p.dropLigneChargee([], 0, true) === true && p.dropLigneChargee([], 0, false) === false);
  test('blocage : provenance manquante', /Provenance manquante : Matelas fictif/.test(p.dropRaisonBlocage([PIECE(1)], {})));
  test('blocage : enlèvement non payé', /Enlèvement non validé/.test(p.dropRaisonBlocage([PIECE(1, { provenance: 'fournisseur', achat: { statut: 'prevu' } })], { 1: true })));
  test('pas de blocage pour une pièce fournisseur non payée déclarée « Pas livrée »', p.dropRaisonBlocage([PIECE(1, { provenance: 'fournisseur', achat: { statut: 'prevu' } })], { 1: false }) === '');
  test('blocage : pièces pas encore indiquées livrées / pas livrées', /pièce par pièce/.test(p.dropRaisonBlocage([PIECE(1, { provenance: 'depot' })], {})));
  test('tout est en règle : pas de blocage', p.dropRaisonBlocage([PIECE(1, { provenance: 'depot' }), PIECE(2, { provenance: 'fournisseur', achat: { statut: 'paye' } })], { 1: true, 2: true }) === '');
  test('commande sans pièces : jamais bloquée', p.dropRaisonBlocage([], {}) === '');
  test('enlèvements : seulement les pièces fournisseur non confirmées', p.dropEnlevements([PIECE(1, { provenance: 'fournisseur' }), PIECE(2, { provenance: 'depot' }), PIECE(3, { provenance: 'fournisseur', livraison: 'livree' })]).map((x) => x.id).join() === '1');
  test('liste de confirmation : pièce déjà confirmée gardée, sinon choix du livreur', JSON.stringify(p.dropListeConfirmation([PIECE(1, { livraison: 'livree' }), PIECE(2), PIECE(3)], { 2: true, 3: false })) === JSON.stringify([{ id: 1, livree: true }, { id: 2, livree: true }, { id: 3, livree: false }]));
  test('libellés (décision de Borhen du 27/11) : « Dépôt — stock BMS », « Dépôt — stock tampon (X) », « À prendre chez X », « Déjà dans le camion »',
    p.dropProvLib('depot') === 'Dépôt — stock BMS' && p.dropProvLib('tampon', 'F fictif') === 'Dépôt — stock tampon (F fictif)' && p.dropProvLib('fournisseur', 'F fictif') === 'À prendre chez F fictif'
    && p.dropProvLib('fournisseur') === 'À prendre chez le fournisseur' && p.dropProvLib('camion') === 'Déjà dans le camion' && !/conteneur/.test(JSON.stringify(p.DROP_PROV_LIB)));
  test('ligne : une pièce « stock tampon » est aussi à prendre au dépôt (case à cocher)', p.dropEtatLigne([PIECE(1, { provenance: 'tampon' })], 0).depot === true && p.dropLigneChargee([PIECE(1, { provenance: 'tampon' })], 0, false) === false);
  test('entrée de stock tampon (CAISSE TTC, MARGE HT) : lignes vides ignorées, prix PAYÉ TTC par pièce, HT de facture facultatif, totaux TTC et HT',
    JSON.stringify(p.dropTamponPreparer([{ produit_id: 'p-s', qte: '2', prix: '36' }, { produit_id: '', qte: '', prix: '' }, { produit_id: 'p-m', qte: '1', prix: '96,6', ht: '80,5' }], 20))
    === JSON.stringify({ ok: true, lignes: [{ produit_id: 'p-s', qte: 2, prix_ttc: 36 }, { produit_id: 'p-m', qte: 1, prix_ttc: 96.6, prix_ht: 80.5 }], total_ttc: 168.6, total_ht: 140.5, total: 140.5 }),
    p.dropTamponPreparer([{ produit_id: 'p-s', qte: '2', prix: '36' }, { produit_id: 'p-m', qte: '1', prix: '96,6', ht: '80,5' }], 20));
  test('entrée de stock tampon : HT de facture supérieur au TTC refusé ; quantité > 10 000 refusée', /HT de la facture invalide/.test(p.dropTamponPreparer([{ produit_id: 'x', qte: '1', prix: '10', ht: '11' }], 20).erreur)
    && /quantité invalide/.test(p.dropTamponPreparer([{ produit_id: 'x', qte: '10001', prix: '10' }], 20).erreur));
  test('entrée de stock tampon : pièce, quantité ou prix manquant refusés', /choisissez la pièce/.test(p.dropTamponPreparer([{ qte: '1', prix: '3' }]).erreur) && /quantité invalide/.test(p.dropTamponPreparer([{ produit_id: 'x', qte: '1,5', prix: '3' }]).erreur)
    && /prix payé TTC/.test(p.dropTamponPreparer([{ produit_id: 'x', qte: '1', prix: '' }]).erreur) && /au moins une pièce/.test(p.dropTamponPreparer([{}]).erreur));
  test('code : aucun prix d\'achat ni nom de fournisseur écrit en dur dans le bloc (dépôt public)', !/prix_achat_ht\s*[:=]\s*\d/.test(CODE_DROP) && !/\d+(,\d+)?\s*€\s*HT/.test(CODE_DROP));

  // ════════════════════════════════════════════════════════════════════════════════════
  console.log('\n2. MODULE INACTIF TANT QUE LA MIGRATION 041 N\'EST PAS APPLIQUÉE');
  {
    const { bac } = nouveauBac({ reponse: () => ({ status: 404, json: { code: 'PGRST202' } }) });
    test('drop_version absente → module inactif', (await bac.dropVerifier()) === false && bac.dropActif === false);
    bac.dropPieces['#D1'] = { pieces: [PIECE(1)] };
    test('module inactif : « Livré » jamais bloqué, rien affiché', bac.dropBloqueLivre('#D1') === '' && bac.dropSasLigneHtml({ id: '#D1' }, 0) === '' && bac.dropEnlevementHtml({}, { cmdId: '#D1' }, 0) === '' && bac.dropLivraisonHtml({}, { cmdId: '#D1' }, 0) === '');
    const { bac: b2 } = nouveauBac({ reponse: () => 'reseau' });
    test('pas de réseau : état inconnu (rien de bloqué)', (await b2.dropVerifier()) === false && b2.dropActif === null);
    const { bac: b3 } = nouveauBac({ reponse: () => ({ status: 200, json: '041' }) });
    test('drop_version = 041 → module actif', (await b3.dropVerifier()) === true && b3.dropActif === true);
  }

  // ════════════════════════════════════════════════════════════════════════════════════
  console.log('\n3. 1er PARE-FEU : ÉCRAN DE CHARGEMENT (trois gros boutons par pièce)');
  {
    const { bac } = nouveauBac({ reponse: (url, opt, env) => {
      if (/drop_declarer/.test(url)) return { status: 200, json: { ok: true, piece: Object.assign(PIECE(env.body.p_piece_id), { provenance: env.body.p_provenance, fournisseur_id: env.body.p_fournisseur_id }) } };
      if (/drop_pieces/.test(url)) return { status: 200, json: { ok: true, pieces: bac.dropPieces['#D1'].pieces } };
      return { status: 200, json: { ok: true } }; } });
    bac.dropActif = true;
    bac.dropPieces['#D1'] = { pieces: [PIECE(1, { drop_actif: true, fournisseurs: [{ id: 11, nom: 'Fournisseur fictif A', prix_prevu_ht: 160 }, { id: 12, nom: 'Fournisseur fictif B', prix_prevu_ht: 170 }], camion: [{ id: 'sc-1', achete: true }] }),
      PIECE(2, { piece_idx: 1, produit_id: 'p-s', libelle: 'Sommier fictif' })], at: Date.now() };
    const h = bac.dropSasLigneHtml({ id: '#D1' }, 0);
    test('pièce activée : Dépôt + un bouton par fournisseur (TTC attendu : 160 HT → 192 TTC) + Déjà dans le camion', (h.match(/data-prov="depot"/g) || []).length === 2 && (h.match(/data-prov="fournisseur"/g) || []).length === 2
      && /À prendre chez Fournisseur fictif A<br><small>192 € TTC/.test(h) && (h.match(/data-prov="camion"/g) || []).length === 1 && /data-sc="sc-1"/.test(h), h);
    test('stock tampon : un bouton « Dépôt — stock tampon » par fournisseur qui en a (quantité, SANS prix)', (() => { bac.dropPieces['#D2'] = { pieces: [PIECE(5, { cmd_id: '#D2', tampon: [{ fournisseur_id: 21, nom: 'Fournisseur fictif T', restant: 4 }] })] }; const ht = bac.dropSasLigneHtml({ id: '#D2' }, 0); return /data-prov="tampon" data-f="21"/.test(ht) && /Dépôt — stock tampon<br><small>Fournisseur fictif T · 4 en stock/.test(ht) && /Dépôt — stock BMS/.test(ht); })());
    test('pièce non activée : pas de bouton fournisseur ; pas de camion sans pièce disponible', !/data-piece="2" data-prov="fournisseur"/.test(h) && !/data-piece="2" data-prov="camion"/.test(h));
    test('noms échappés (pas d\'injection)', bac.dropEchap('<img onerror=x>') === '&lt;img onerror=x&gt;');
    await bac.dropDeclarer('#D1', 1, 'fournisseur', 11, null); await attendre();
    const env = bac._envois.find((e) => /drop_declarer/.test(e.url));
    test('déclaration envoyée à la base (pièce, provenance, fournisseur)', env && env.body.p_piece_id === 1 && env.body.p_provenance === 'fournisseur' && env.body.p_fournisseur_id === 11);
    // ligne entièrement déclarée avec une pièce Dépôt : la case « chargé » est cochée automatiquement
    bac.dropPieces['#D1'].pieces[0].provenance = 'fournisseur';
    await bac.dropDeclarer('#D1', 2, 'depot', null, null); await attendre();
    test('dernière pièce de la ligne déclarée (Dépôt) : la ligne est cochée « chargée »', bac._coches.some((c) => c[0] === '#D1' && c[1] === 0 && c[2] === true), bac._coches);
    const { bac: bR } = nouveauBac({ reponse: () => 'reseau' }); bR.dropActif = true; bR.dropPieces['#D1'] = { pieces: [PIECE(1)] };
    await bR.dropDeclarer('#D1', 1, 'depot', null, null);
    test('pas de réseau : message clair, rien de supposé', bR._toasts.some((t) => /Pas de réseau/.test(t[0])) && bR.dropPieces['#D1'].pieces[0].provenance === null);
    const { bac: bE } = nouveauBac({ reponse: () => ({ status: 200, json: { ok: false, erreur: 'dropshipping_inactif' } }) }); bE.dropActif = true; bE.dropPieces['#D1'] = { pieces: [PIECE(1)] };
    await bE.dropDeclarer('#D1', 1, 'fournisseur', 11, null);
    test('refus de la base : message en français', bE._toasts.some((t) => /pas activée en dropshipping/.test(t[0])));
    // progression du chargement (vrai calculerProgressionChargement)
    bac.commandes = [{ id: '#D1', client: 'Client fictif', lignes: [{ produit: 'Ensemble fictif', qte: 1 }, { produit: 'Oreiller fictif', qte: 1 }] }];
    bac.dropPieces['#D1'] = { pieces: [PIECE(1, { provenance: 'fournisseur' }), PIECE(2, { piece_idx: 1, provenance: 'camion' })] };
    let prog = bac.calculerProgressionChargement({ stops: [{ cmdId: '#D1' }] });
    test('chargement : ligne sans pièce Dépôt (fournisseur + camion) comptée chargée sans être cochée ; ligne sans pièces : règle d\'avant', prog.total === 2 && prog.charges === 1, prog);
    bac.dropPieces['#D1'].pieces[1].provenance = null; bac.chargements['#D1'] = { 0: { charge: true } };
    prog = bac.calculerProgressionChargement({ stops: [{ cmdId: '#D1' }] });
    test('chargement : ligne cochée mais une pièce sans provenance → PAS chargée (écran bloqué)', prog.charges === 0, prog);
  }

  // ════════════════════════════════════════════════════════════════════════════════════
  console.log('\n4. 2e PARE-FEU : ARRÊT « ENLÈVEMENT » AVANT LE CLIENT, « ENLEVÉ ET PAYÉ »');
  {
    const { bac, els } = nouveauBac({ reponse: (url) => {
      if (/storage\/v1\/object\/drop-tickets/.test(url)) return { status: 200, json: { Key: 'x' } };
      if (/drop_enlever_payer/.test(url)) return { status: 200, json: { ok: true, ecart: 6, depense: { id: 'drop-9', date: '2026-11-27', cat: 'Achat fournisseur', montant: 198, livreur: 'LIVREUR-TEST', modePaie: 'Espèces', tourneeId: 'T-1', comment: 'Dropshipping' } } };
      if (/drop_pieces/.test(url)) return { status: 200, json: { ok: true, pieces: [] } };
      return { status: 200, json: { ok: true } }; } });
    bac.dropActif = true;
    bac.commandes = [{ id: '#D1', livreur: 'LIVREUR-TEST' }];
    bac.dropPieces['#D1'] = { pieces: [PIECE(1, { provenance: 'fournisseur', fournisseur: { nom: 'Fournisseur fictif A', adresse: '1 rue Fictive' }, achat: { statut: 'prevu', prix_prevu_ht: 160 } })] };
    const h = bac.dropEnlevementHtml({ id: 'T-1' }, { cmdId: '#D1', client: 'Client fictif', statut: 'en-route' }, 2);
    test('arrêt d\'enlèvement affiché avant l\'arrêt 3 : fournisseur, adresse, pièce, TTC à payer (et HT prévu), Waze, « Enlevé et payé »', /Enlèvement avant l'arrêt 3/.test(h) && /Fournisseur fictif A/.test(h) && /1 rue Fictive/.test(h)
      && /Matelas fictif<\/strong> · à payer <strong>192 € TTC<\/strong> <small>\(160 € HT\)/.test(h) && /waze\.com/.test(h) && /dropOuvrirEnlevement\('#D1',1\)/.test(h), h);
    test('commande déjà livrée : plus d\'arrêt d\'enlèvement', bac.dropEnlevementHtml({}, { cmdId: '#D1', statut: 'livré' }, 0) === '');
    bac.dropOuvrirEnlevement('#D1', 1);
    els['drop-enl-montant'] = Object.assign(fauxElement('drop-enl-montant'), { value: '' });
    await bac.dropValiderEnlevement();
    test('montant vide : refusé (montant payé TTC)', /montant payé TTC/.test(els['drop-enl-msg'].textContent), els['drop-enl-msg'].textContent);
    els['drop-enl-montant'].value = '198';
    els['drop-enl-ht'] = Object.assign(fauxElement('drop-enl-ht'), { value: '199' });
    await bac.dropValiderEnlevement();
    test('HT de la facture supérieur au TTC payé : refusé', /HT de la facture invalide/.test(els['drop-enl-msg'].textContent));
    els['drop-enl-ht'].value = '';
    await bac.dropValiderEnlevement();
    test('sans Espèces / CB : refusé', /Espèces ou CB/.test(els['drop-enl-msg'].textContent));
    bac.dropEnlMode('especes');
    await bac.dropValiderEnlevement();
    test('sans photo du ticket : refusé', /photo du ticket/.test(els['drop-enl-msg'].textContent));
    vm.runInContext('_dropEnl.photo = { taille: 1 };', bac);
    await bac.dropValiderEnlevement(); await attendre();
    const up = bac._envois.find((e) => /storage\/v1\/object\/drop-tickets\/livreur-test\/D1\/ticket-1-/.test(e.url));
    const rp = bac._envois.find((e) => /rpc\/drop_enlever_payer/.test(e.url));
    test('photo envoyée dans le dossier du livreur (stockage privé)', !!up && up.method === 'POST');
    test('« Enlevé et payé » envoyé : pièce, montant TTC PAYÉ (198), HT de facture vide (calculé par la base), espèces, chemin du ticket', rp && rp.body.p_piece_id === 1 && rp.body.p_montant_ttc === 198 && rp.body.p_montant_ht === null && rp.body.p_mode === 'especes' && /^livreur-test\/D1\/ticket-1-\d+\.jpg$/.test(rp.body.p_ticket_path), rp && rp.body);
    test('dépense de la tournée ajoutée sur le téléphone = TTC payé 198 (caisse du livreur en TTC)', bac.depenses.length === 1 && bac.depenses[0].modePaie === 'Espèces' && bac.depenses[0].tourneeId === 'T-1' && bac.depenses[0].montant === 198);
    test('message : TTC payé, écart TTC (198 − 192 = +6) signalé au bureau', bac._toasts.some((t) => /Enlevé et payé : 198 € TTC \(espèces\) — écart \+6 € signalé au bureau/.test(t[0])), bac._toasts);
    test('rien ne reste dans la file après la réponse de la base', bac.offlineQueue.length === 0);
    // photo refusée par le stockage : l'enlèvement part quand même, sans chemin (alerte « ticket manquant » côté base)
    const { bac: bP, els: eP } = nouveauBac({ reponse: (url) => (/storage/.test(url) ? { status: 403, json: {} } : { status: 200, json: { ok: true, ecart: 0 } }) });
    bP.dropActif = true; bP.commandes = [{ id: '#D1', livreur: 'LIVREUR-TEST' }];
    bP.dropPieces['#D1'] = { pieces: [PIECE(1, { provenance: 'fournisseur', achat: { statut: 'prevu', prix_prevu_ht: 160 } })] };
    bP.dropOuvrirEnlevement('#D1', 1); eP['drop-enl-montant'] = Object.assign(fauxElement('x'), { value: '160' }); bP.dropEnlMode('cb'); vm.runInContext('_dropEnl.photo = { taille: 1 };', bP);
    await bP.dropValiderEnlevement(); await attendre();
    const rp2 = bP._envois.find((e) => /drop_enlever_payer/.test(e.url));
    test('photo non envoyée : enlèvement enregistré SANS chemin (le bureau est prévenu), mode CB', rp2 && rp2.body.p_ticket_path === null && rp2.body.p_mode === 'cb' && bP._toasts.some((t) => /Photo du ticket non envoyée/.test(t[0])));
    // hors réseau : gardé dans la file, rejoué plus tard sans double effet (fonction idempotente)
    const { bac: bH, els: eH } = nouveauBac({ reponse: () => 'reseau' });
    bH.dropActif = true; bH.commandes = [{ id: '#D1', livreur: 'LIVREUR-TEST' }];
    bH.dropPieces['#D1'] = { pieces: [PIECE(1, { provenance: 'fournisseur', achat: { statut: 'prevu', prix_prevu_ht: 160 } })] };
    bH.dropOuvrirEnlevement('#D1', 1); eH['drop-enl-montant'] = Object.assign(fauxElement('x'), { value: '160' }); bH.dropEnlMode('especes'); vm.runInContext('_dropEnl.photo = { taille: 1 };', bH);
    await bH.dropValiderEnlevement(); await attendre();
    test('hors réseau : « Enlevé et payé » gardé dans la file (clé drop|enl:<pièce>, commande notée)', bH.offlineQueue.length === 1 && bH.oqCle(bH.offlineQueue[0]) === 'drop|enl:1' && bH.offlineQueue[0].data.cmdId === '#D1'
      && bH._toasts.some((t) => /envoyé dès le retour du réseau/.test(t[0])));
  }

  // ════════════════════════════════════════════════════════════════════════════════════
  console.log('\n5. 3e PARE-FEU : LIVRAISON PIÈCE PAR PIÈCE, PUIS DÉDUCTION');
  {
    const { bac } = nouveauBac({ reponse: (url) => (/drop_pieces/.test(url) ? { status: 200, json: { ok: true, pieces: [] } } : { status: 200, json: { ok: true } }) });
    bac.dropActif = true;
    bac.dropPieces['#D1'] = { pieces: [PIECE(1, { provenance: 'depot' }), PIECE(2, { piece_idx: 1, provenance: 'fournisseur', achat: { statut: 'paye' } })] };
    let h = bac.dropLivraisonHtml({ id: 'T-1' }, { cmdId: '#D1', statut: 'arrivé' }, 0);
    test('deux boutons par pièce (Livrée / Pas livrée) + cadenas tant que rien n\'est indiqué', (h.match(/✅ Livrée/g) || []).length === 2 && (h.match(/✖ Pas livrée/g) || []).length === 2 && /🔒 Indiquez pièce par pièce/.test(h));
    test('« Livré » BLOQUÉ tant que les pièces ne sont pas indiquées', /pièce par pièce/.test(bac.dropBloqueLivre('#D1')));
    bac.dropChoisirLivraison('#D1', 1, true); bac.dropChoisirLivraison('#D1', 2, false);
    test('pièces indiquées : « Livré » débloqué ; choix gardés sur l\'appareil', bac.dropBloqueLivre('#D1') === '' && JSON.parse(bac.localStorage.getItem('mx_drop_confirm'))['#D1']['2'] === false);
    const r = await bac.dropApresLivre('#D1'); await attendre();
    const env = bac._envois.find((e) => /drop_confirmer_livraison/.test(e.url));
    test('après « Livré » : confirmation envoyée à la base (toutes les pièces)', r === 'ok' && env && env.body.p_cmd_id === '#D1' && JSON.stringify(env.body.p_pieces) === JSON.stringify([{ id: 1, livree: true }, { id: 2, livree: false }]), env && env.body);
    bac.dropPieces['#D1'] = { pieces: [PIECE(1, { provenance: null })] }; // pièces relues après l'envoi : on repart d'une pièce sans provenance
    test('une pièce sans provenance : « Livré » bloqué', /Provenance manquante/.test(bac.dropBloqueLivre('#D1')));
    // rejeu de la file : la déduction du stock attend la confirmation des pièces
    const { bac: bF } = nouveauBac({ reponse: (url) => (/drop_confirmer_livraison/.test(url) ? 'reseau' : { status: 200, json: { ok: true, deja: false, stock_deduit: true, retraits: [], manques: [] } }) });
    bF.dropActif = true; bF.commandes = [{ id: '#D1', statut: 'livré' }];
    vm.runInContext("offlineQueue = [{ type: 'drop', data: { id: 'conf:#D1', fn: 'drop_confirmer_livraison', params: { p_cmd_id: '#D1', p_pieces: [] }, cmdId: '#D1' }, ts: 1, oqv: 2, role: 'livreur' }, { type: 'deduction', data: { id: '#D1' }, ts: 2, oqv: 2, role: 'livreur' }];", bF);
    await bF.offlineQueueFlush(); await attendre();
    test('rejeu, confirmation en échec : déduction NON envoyée, les deux restent en file', !bF._envois.some((e) => /deduire_stock_livraison/.test(e.url)) && bF.offlineQueue.length === 2, bF.offlineQueue.map((x) => x.type));
    bF.fetch = async (url, opt) => { bF._envois.push({ url, body: opt.body ? JSON.parse(opt.body) : null }); return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, deja: false, stock_deduit: true, retraits: [], manques: [], pieces: [] }), json: async () => ({ ok: true }) }; };
    vm.runInContext('_dedProchain = {};', bF);
    await bF.offlineQueueFlush(); await attendre();
    await bF.offlineQueueFlush(); await attendre();
    const iC = bF._envois.findIndex((e) => /drop_confirmer_livraison/.test(e.url) && e.body), iD = bF._envois.findIndex((e) => /deduire_stock_livraison/.test(e.url));
    test('réseau revenu : confirmation des pièces PUIS déduction, file vide', iC > -1 && iD > iC && bF.offlineQueue.length === 0, { iC, iD, file: bF.offlineQueue.map((x) => x.type) });
    // reporté / client absent
    const { bac: bN } = nouveauBac(); bN.dropActif = true;
    bN.dropPieces['#D1'] = { pieces: [PIECE(1, { provenance: 'fournisseur', achat: { statut: 'paye' } })] }; bN.dropConfirm['#D1'] = { 1: true };
    await bN.dropApresNonLivre('#D1'); await attendre();
    test('reporté / absent : la base met les pièces achetées dans le stock du camion ; choix effacés', bN._envois.some((e) => /drop_commande_non_livree/.test(e.url) && e.body.p_cmd_id === '#D1') && !bN.dropConfirm['#D1']);
    const { bac: bR } = nouveauBac({ reponse: () => ({ status: 200, json: { ok: false, erreur: 'enlevement_non_paye' } }) }); bR.dropActif = true;
    bR.dropPieces['#D1'] = { pieces: [PIECE(1, { provenance: 'depot' })] }; bR.dropConfirm['#D1'] = { 1: true };
    const rr = await bR.dropApresLivre('#D1');
    test('confirmation refusée par la base : retirée de la file, notification URGENTE « livraison NON enregistrée », la déduction ATTEND', rr === 'refus' && bR.offlineQueue.length === 0
      && bR._notifs.some((n) => n[0] === 'urgent' && /Livraison NON enregistrée/.test(n[2])) && bR.dropDeductionPermise('#D1') === false, bR._notifs);
  }

  // ════════════════════════════════════════════════════════════════════════════════════
  console.log('\n6. ADMINISTRATEUR : BILAN DU JOUR, FICHE');
  {
    const { bac } = nouveauBac({ role: 'admin' });
    const h = bac.dropBilanHtml({ ventes_ht: 2300, cout_produits_ht: 765, gls_ht: 12.5, resultat_ht: 1522.5, charges_fixes_ht: null, resultat_net_ht: null, commandes: 5, pieces_cout_inconnu: 0,
      commandes_cout_estime: 3, commandes_gls_non_renseigne: 0, detail: [{ cmd_id: '#D1', vente_ht: 600, cout_ht: 205, gls_ht: null, marge_ht: 395, cout_estime: false, provenances: { depot: 1, fournisseur: 1 } }] });
    test('bilan : ventes livrées HT, coût des produits, GLS, résultat, « sans les charges fixes »', /Ventes livrées HT/.test(h) && /2\s?300 €/.test(h) && /765 €/.test(h) && /12,50 €/.test(h) && /1\s?522,50 €/.test(h) && /Sans les charges fixes/.test(h), h.slice(0, 400));
    test('bilan : détail par commande (marge, provenance)', /395 €/.test(h) && /Dépôt — stock BMS ×1, À prendre chez le fournisseur ×1/.test(h));
    const f = bac.dropPiecesAdminHtml({ ok: true, vente_ht: 600, cout_ht: 205, marge_ht: 395, pieces: [{ libelle: 'Matelas fictif', provenance: 'fournisseur', fournisseur: 'Fournisseur fictif A', montant_paye_ht: 165, montant_paye_ttc: 198, prix_prevu_ht: 160, mode: 'especes', paye_at: '2026-11-27T08:00:00Z', ticket_path: 'livreur-test/D1/t.jpg', livraison: 'livree', cout_ht: 165, fige: true }] });
    test('fiche : provenance, fournisseur, prix payé, mode, heure, lien du ticket, coût, marge', /À prendre chez Fournisseur fictif A/.test(f) && /payé <strong>198 € TTC<\/strong> \(caisse, espèces\) · coût <strong>165 € HT<\/strong> \(prévu 160 € HT\)/.test(f) && /dropVoirTicket\('livreur-test\/D1\/t\.jpg'\)/.test(f) && /marge 395 € HT/.test(f), f);
  }

  // ════════════════════════════════════════════════════════════════════════════════════
  console.log('\n7. POINTS D\'ACCROCHE DANS L\'APPLICATION');
  const setLv = extraireFonction('function setLvSt(tid, idx, st, _annOk)');
  const sig = extraireFonction('function validerSig()');
  test('setLvSt : « Livré » bloqué par dropBloqueLivre AVANT la fenêtre de signature', setLv.indexOf('dropBloqueLivre(s.cmdId)') > -1 && setLv.indexOf('dropBloqueLivre') < setLv.indexOf("if(st==='livré'){"));
  test('setLvSt : reporté / absent → dropApresNonLivre', /\(st === 'reporté' \|\| st === 'absent'\)[^\n]*dropApresNonLivre\(s\.cmdId\)/.test(setLv));
  test('validerSig (v7.5.202) : pièces revérifiées ; pièces à confirmer : confirmation → « livré » (seulement si elle a réussi) → déduction (seulement si permise) ; rien à confirmer : « livré » immédiat comme avant',
    sig.indexOf('dropBloqueLivre(s.cmdId)') > -1 && sig.indexOf('dropApresLivre(_cmdLivre.id)') < sig.indexOf('stkDeductionPoser(_cmdLivre)')
    && /Promise\.resolve\(_aConf \? _pDrop : 'rien'\)[\s\S]{0,200}if \(!_dropOk\(\)\) return null;\s*if \(_aConf\) \{ try \{ _pLivre = sbSaveCommande\(_cmdLivre\)/.test(sig)
    && /if \(!_aConf\) \{ try \{ _pLivre = sbSaveCommande\(_cmdLivre\)/.test(sig) && /dropAConfirmer\(_cmdLivre\.id\)/.test(sig)
    && /!dropDeductionPermise\(_cmdLivre\.id\)\) return null;[\s\S]{0,120}return stkDemanderDeduction\(_cmdLivre\)/.test(sig));
  test('écran de chargement : boutons de provenance sous chaque ligne', /dropSasLigneHtml\(cmd, idx\)/.test(extraireFonction('function sasGenererListe(t)')));
  test('vue livreur : arrêt « Enlèvement » avant la carte du client, pièces livrées dans la carte', /dropEnlevementHtml\(t, s, i\)[^\n]*\n\s*'<div class="lv-card '/.test(html) && /dropLivraisonHtml\(t, s, i\)/.test(html));
  test('fiche commande et détail de tournée (admin) : provenance et marge', /role === 'admin' && typeof dropFicheCommande === 'function'/.test(extraireFonction('function ouvrirCmd(id)')) && /dropTourneeDetail\(t\)/.test(extraireFonction('function afficherTournee(id)')));
  test('page admin « Dropshipping » : page, menu Plus, titre, ouverture', html.includes('id="p-drop"') && html.includes("{p:'drop',i:'🔀',l:'Dropshipping'}") && html.includes("drop:'Dropshipping'") && /if\(p==='drop' && typeof dropPageInit === 'function'\) dropPageInit\(\);/.test(html));
  test('page admin : réservée à l\'administrateur', /if \(role !== 'admin'\) \{ el\.innerHTML = '<div class="card">Réservé/.test(extraireFonction('async function dropPageInit()')));
  test('CACHE_VERSION = maxiconfort-v7-5-201 ou plus', /CACHE_VERSION = 'maxiconfort-v7-5-(20[1-9]|2[1-9]\d|[3-9]\d\d)'/.test(fs.readFileSync(path.join(racine, 'service-worker.js'), 'utf8')));
  test('migration 041 présente dans le dépôt', fs.existsSync(path.join(racine, 'supabase', 'migrations', '041_dropshipping_provenance.sql')));


  // ════════════════════════════════════════════════════════════════════════════════════
  console.log('\n8. v7.5.201 : RÉSERVES DE LA REVUE CODEX SUR 53c7b59 ET DÉCISION DE BORHEN CORRIGÉE (CAISSE TTC, MARGE HT)');
  {
    const { bac: q8 } = nouveauBac();
    test('TTC attendu = HT × (1 + TVA), mêmes arrondis que la base (160 → 192 ; 83,33 → 100 ; TVA 10 % : 160 → 176)', q8.dropTtc(160, 20) === 192 && q8.dropTtc(83.33, 20) === 100 && q8.dropTtc(160, 10) === 176);
    test('coût HT d\'un TTC payé = TTC ÷ (1 + TVA) (198 → 165 ; 187 à 10 % → 170) ; TVA absente ou hors 0..100 = 20 %', q8.dropHtDeTtc(198, 20) === 165 && q8.dropHtDeTtc(187, 10) === 170 && q8.dropTva(null) === 20 && q8.dropTva(150) === 20 && q8.dropTva('5,5'.replace(',', '.')) === 5.5);
    // réserve n° 2 : livraison bloquée tant que les pièces ne peuvent pas être contrôlées
    test('pièces jamais lues (hors ligne) : livraison BLOQUÉE avec un message clair', /Pièces pas encore contrôlées/.test(q8.dropRaisonLivraison(undefined, {}, true, true)));
    test('commande GLS ou module inactif : jamais bloquée', q8.dropRaisonLivraison(undefined, {}, true, false) === '' && q8.dropRaisonLivraison(undefined, {}, false, true) === '');
    test('découpage PÉRIMÉ : livraison bloquée (réinitialisation par le bureau)', /découpage périmé/.test(q8.dropRaisonLivraison({ pieces: [PIECE(1, { provenance: 'depot' })], perime: true }, { 1: true }, true, true)));
    test('quantité hors bornes : livraison bloquée, à valider par le bureau', /50 par ligne, 20 par composant, 200 pièces/.test(q8.dropRaisonLivraison({ pieces: [], refus: 'quantite_hors_borne' }, {}, true, true)));
    test('dérogation de l\'administrateur : plus de blocage', q8.dropRaisonLivraison({ pieces: [PIECE(1)], derogation: true }, {}, true, true) === '');
    // réserve P1 : déduction seulement après le SUCCÈS de la confirmation
    test('déduction : confirmation encore en file → attend', q8.dropDeductionPermiseDe({ pieces: [PIECE(1)] }, true, undefined, true) === false);
    test('déduction : confirmation REFUSÉE → attend (jamais sur un échec)', q8.dropDeductionPermiseDe({ pieces: [PIECE(1)] }, false, { refus: 'x' }, true) === false);
    test('déduction : pièces connues non confirmées et aucun succès noté → attend', q8.dropDeductionPermiseDe({ pieces: [PIECE(1)] }, false, undefined, true) === false);
    test('déduction : confirmation réussie, ou pièces toutes confirmées, ou commande sans pièces, ou module inactif → part',
      q8.dropDeductionPermiseDe({ pieces: [PIECE(1)] }, false, 'ok', true) && q8.dropDeductionPermiseDe({ pieces: [PIECE(1, { livraison: 'livree' })] }, false, undefined, true)
      && q8.dropDeductionPermiseDe(undefined, false, undefined, true) && q8.dropDeductionPermiseDe({ pieces: [PIECE(1)] }, false, undefined, false));
  }
  {
    // réserve n° 2 : état actif du module gardé sur l'appareil ; sans réseau : bloqué au lieu de tout laisser passer
    const { bac } = nouveauBac({ reponse: () => 'reseau', stock: { mx_drop_actif: '041' } });
    bac.commandes = [{ id: '#H1', transporteur: 'RANOU' }, { id: '#H2', transporteur: 'GLS' }];
    test('hors ligne au démarrage, module actif la dernière fois : considéré ACTIF', (await bac.dropVerifier()) === false && bac.dropActif === null && bac.dropModuleActif() === true);
    test('hors ligne, pièces jamais lues : « Livré » BLOQUÉ, message clair ; commande GLS non bloquée', /Pièces pas encore contrôlées/.test(bac.dropBloqueLivre('#H1')) && bac.dropBloqueLivre('#H2') === '');
    bac.dropPieces['#H1'] = { pieces: [PIECE(1, { cmd_id: '#H1', provenance: 'depot' })] };
    test('hors ligne, pièces en cache : contrôle normal (pièce par pièce)', /pièce par pièce/.test(bac.dropBloqueLivre('#H1')));
    test('arrêt du livreur : la raison du blocage est affichée', /Indiquez pièce par pièce/.test(bac.dropLivraisonHtml({}, { cmdId: '#H1', statut: 'arrivé' }, 0)) && /Pièces pas encore contrôlées/.test(bac.dropLivraisonHtml({}, { cmdId: '#H9', statut: 'arrivé' }, 0)));
    const { bac: bA } = nouveauBac({ reponse: () => ({ status: 404, json: { code: 'PGRST202' } }), stock: { mx_drop_actif: '041' } });
    await bA.dropVerifier();
    test('la base répond « fonction absente » : module inactif, cache effacé', bA.dropModuleActif() === false && bA.localStorage.getItem('mx_drop_actif') === null);
    const { bac: bO } = nouveauBac({ reponse: () => ({ status: 200, json: '041' }) });
    await bO.dropVerifier();
    test('la base répond 041 : état actif gardé sur l\'appareil', bO.localStorage.getItem('mx_drop_actif') === '041');
    const { bac: bQ } = nouveauBac({ reponse: (url) => (/drop_pieces/.test(url) ? { status: 200, json: { ok: false, erreur: 'quantite_hors_borne', detail: { max: 50 } } } : { status: 200, json: { ok: true } }) });
    bQ.dropActif = true; await bQ.dropChargerPieces('#Q1');
    test('découpage refusé (hors bornes) : gardé, livraison bloquée avec la raison', bQ.dropPieces['#Q1'].refus === 'quantite_hors_borne' && /50 par ligne/.test(bQ.dropBloqueLivre('#Q1')));
    const { bac: bP } = nouveauBac({ reponse: (url) => (/drop_pieces/.test(url) ? { status: 200, json: { ok: true, perime: true, tva_pct: 10, pieces: [PIECE(1, { provenance: 'depot' })] } } : { status: 200, json: { ok: true } }) });
    bP.dropActif = true; await bP.dropChargerPieces('#P1'); bP.dropChoisirLivraison('#P1', 1, true);
    test('découpage périmé (réponse de la base) : « Livré » bloqué même pièces indiquées ; taux de TVA de la base gardé', /découpage périmé/.test(bP.dropBloqueLivre('#P1')) && bP.dropTvaDe('#P1') === 10);
  }
  {
    // réserve P1 + n° 1 : rejeu de la file — « livré » et déduction attendent la confirmation des pièces
    let reseau = true; const sav = [];
    const { bac: bF } = nouveauBac({ reponse: (url) => (reseau ? 'reseau' : { status: 200, json: { ok: true, deja: false, stock_deduit: true, retraits: [], manques: [], pieces: [] } }) });
    bF.dropActif = true; bF.commandes = [{ id: '#F1', statut: 'livré' }];
    bF.sbSaveCommande = async (c) => { sav.push(c.id); return { ok: true }; };
    bF.dropPieces['#F1'] = { pieces: [PIECE(1, { cmd_id: '#F1', provenance: 'depot' })] };
    vm.runInContext("offlineQueue = [{ type: 'drop', data: { id: 'conf:#F1', fn: 'drop_confirmer_livraison', params: { p_cmd_id: '#F1', p_pieces: [{ id: 1, livree: true }] }, cmdId: '#F1' }, ts: 1, oqv: 2, role: 'livreur' },"
      + " { type: 'commande', data: { id: '#F1', statut: 'livré' }, ts: 2, oqv: 2, role: 'livreur' }, { type: 'deduction', data: { id: '#F1' }, ts: 3, oqv: 2, role: 'livreur' }];", bF);
    await bF.offlineQueueFlush(); await attendre();
    test('rejeu, confirmation à réessayer : le « livré » N\'EST PAS envoyé (la base le refuserait), ni la déduction ; tout reste en file',
      sav.length === 0 && !bF._envois.some((e) => /deduire_stock_livraison/.test(e.url)) && bF.offlineQueue.length === 3, { sav, file: bF.offlineQueue.map((x) => x.type) });
    reseau = false; vm.runInContext('_dedProchain = {};', bF);
    await bF.offlineQueueFlush(); await attendre(); await bF.offlineQueueFlush(); await attendre();
    const iC = bF._envois.findIndex((e) => /drop_confirmer_livraison/.test(e.url) && e.body), iD = bF._envois.findIndex((e) => /deduire_stock_livraison/.test(e.url));
    test('réseau revenu : confirmation PUIS « livré » PUIS déduction ; succès noté', iC > -1 && sav.length >= 1 && iD > iC && bF.dropConfEtat['#F1'] === 'ok' && bF.offlineQueue.length === 0, { iC, iD, sav, file: bF.offlineQueue.map((x) => x.type) });
    // confirmation refusée : la déduction ne part JAMAIS
    const { bac: bX } = nouveauBac({ reponse: (url) => (/drop_confirmer_livraison/.test(url) ? { status: 200, json: { ok: false, erreur: 'decoupage_perime' } } : { status: 200, json: { ok: true, deja: false, stock_deduit: true, retraits: [], manques: [] } }) });
    bX.dropActif = true; bX.commandes = [{ id: '#X1', statut: 'livré' }];
    bX.dropPieces['#X1'] = { pieces: [PIECE(1, { cmd_id: '#X1', provenance: 'depot' })] };
    vm.runInContext("offlineQueue = [{ type: 'drop', data: { id: 'conf:#X1', fn: 'drop_confirmer_livraison', params: { p_cmd_id: '#X1', p_pieces: [] }, cmdId: '#X1' }, ts: 1, oqv: 2, role: 'livreur' }, { type: 'deduction', data: { id: '#X1' }, ts: 2, oqv: 2, role: 'livreur' }];", bX);
    await bX.offlineQueueFlush(); await attendre();
    test('confirmation REFUSÉE (découpage périmé) : déduction NON envoyée (gardée en file), message clair', !bX._envois.some((e) => /deduire_stock_livraison/.test(e.url))
      && bX.offlineQueue.some((x) => x.type === 'deduction') && bX._notifs.some((n) => /Livraison NON enregistrée/.test(n[2]) && /réinitialiser/.test(n[3])), bX._notifs);
    const repr = extraireFonction('function stkReprendreDeductions(force)'), dem = extraireFonction('function stkDemanderDeduction(cmd, pAvant)');
    test('reprise au démarrage et demande directe : jamais avant le succès de la confirmation (dropDeductionPermise)', /!dropDeductionPermise\(id\)\) return;/.test(repr) && /!dropDeductionPermise\(cmd\.id\)\) return 'reessayer';/.test(dem));
    test('confirmation : un nouvel envoi efface l\'ancien résultat (relivraison : nouveau cycle)', /delete dropConfEtat\[cmdId\]/.test(extraireFonction('function dropApresLivre(cmdId)')));
  }
  {
    // réserve P1 (~l.6216) : entrée de stock tampon au résultat indéterminé — même clé gardée, rejouée, jamais en double
    let mode = 'reseau'; const cles = [];
    const { bac, els } = nouveauBac({ role: 'admin', reponse: (url, opt, env) => {
      if (/drop_tampon_entree/.test(url)) { cles.push(env.body.p_cle); if (mode === 'reseau') return 'reseau'; if (mode === '500') return { status: 500, json: { message: 'x' } };
        return { status: 200, json: { ok: true, deja: cles.length > 1, total_ht: 60, total_ttc: 72, lots: [] } }; }
      return { status: 200, json: { ok: true } }; } });
    bac.dropActif = true; bac.dropPageInit = async () => {};
    vm.runInContext("dropTamponLignes = [{ produit_id: 'p-s', qte: '2', prix: '36', ht: '' }]; dropAdm.reglages = { drop_tva_pct: '20' };", bac);
    els['drop-t-f'] = Object.assign(fauxElement('drop-t-f'), { value: '7' }); els['drop-t-date'] = Object.assign(fauxElement('d'), { value: '2026-11-27' }); els['drop-t-mode'] = Object.assign(fauxElement('m'), { value: 'cb' });
    await bac.dropTamponEnregistrer();
    const att = JSON.parse(bac.localStorage.getItem('mx_drop_tampon_attente') || 'null');
    test('pas de réseau : résultat INDÉTERMINÉ → clé et paramètres GARDÉS sur l\'appareil (TTC envoyé)', !!att && att.params.p_cle === cles[0] && att.params.p_lignes[0].prix_ttc === 36 && bac._toasts.some((t) => /Résultat inconnu/.test(t[0])), att);
    await bac.dropTamponEnregistrer();
    test('nouvelle entrée REFUSÉE tant que l\'entrée en attente n\'est pas vérifiée (aucun 2e envoi)', cles.length === 1 && bac._toasts.some((t) => /attend sa vérification/.test(t[0])));
    test('page : bandeau « Vérifier / renvoyer » et bouton d\'entrée désactivé', /Vérifier \/ renvoyer/.test(bac.dropTamponHtml({ fournisseurs: [], tampon: null })) && /dropTamponEnregistrer\(\)" disabled/.test(bac.dropTamponHtml({ fournisseurs: [], tampon: null })));
    mode = '500'; await bac.dropTamponRejouer();
    test('erreur 500 au rejeu : toujours indéterminé, MÊME clé, toujours gardée', cles.length === 2 && cles[1] === cles[0] && !!bac.localStorage.getItem('mx_drop_tampon_attente'));
    mode = 'ok'; await bac.dropTamponRejouer();
    test('rejeu : MÊME clé et mêmes paramètres ; « deja » de la base = vérifié sans doublon ; attente effacée', cles.length === 3 && cles[2] === cles[0] && bac.localStorage.getItem('mx_drop_tampon_attente') === null
      && bac._toasts.some((t) => /déjà enregistrée \(vérifiée, aucun doublon\)/.test(t[0])), bac._toasts.slice(-2));
    test('issue d\'un envoi (pure) : réseau / 5xx = indéterminé, refus de la base = refus, ok = ok',
      bac.dropTamponIssue({ reseau: true }) === 'indetermine' && bac.dropTamponIssue({ httpOk: false, statut: 503 }) === 'indetermine' && bac.dropTamponIssue({ httpOk: true, corps: null }) === 'indetermine'
      && bac.dropTamponIssue({ httpOk: true, corps: { ok: false, erreur: 'prix_invalide' } }) === 'refus' && bac.dropTamponIssue({ httpOk: true, corps: { ok: true } }) === 'ok');
  }
  {
    // réserve n° 1 : exception explicite de l'administrateur
    const { bac } = nouveauBac({ role: 'admin', reponse: () => ({ status: 200, json: { ok: true, deja: false, cycle: 1 } }) });
    bac._prompt = 'ok';
    await bac.dropDeroger('#D1');
    test('dérogation : motif de moins de 5 caractères refusé, rien envoyé', !bac._envois.some((e) => /drop_livre_sans_confirmation/.test(e.url)) && bac._toasts.some((t) => /Motif obligatoire/.test(t[0])));
    bac._prompt = 'Livré par le bureau, pièces vues'; bac.dropPieces['#D1'] = { pieces: [PIECE(1)] };
    await bac.dropDeroger('#D1');
    const e = bac._envois.find((x) => /drop_livre_sans_confirmation/.test(x.url));
    test('dérogation : envoyée avec le motif, journalisée par la base ; « Livré » débloqué', e && e.body.p_cmd_id === '#D1' && e.body.p_motif === 'Livré par le bureau, pièces vues' && bac.dropPieces['#D1'].derogation === true
      && bac.dropRaisonLivraison(bac.dropPieces['#D1'], {}, true, true) === '');
    test('rejeu de la file : un « livré » attend la confirmation de ses pièces', /item\.type === 'commande' && item\.data && \(item\.data\.statut === 'livré' \|\| item\.data\.statut === 'livre'\)[\s\S]{0,160}drop\|conf:/.test(CODE_REJEU));
  }
  test('caisse HT/TTC (décision de Borhen corrigée) : l\'enlèvement envoie p_montant_ttc (TTC payé), jamais l\'ancien p_montant_ht seul', /p_montant_ttc: m\.montant/.test(CODE_DROP) && /p_montant_ht: mht/.test(CODE_DROP));

  console.log('\n' + ok + ' OK, ' + ko + ' échec(s)');
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERREUR DU BANC :', e); process.exit(1); });
