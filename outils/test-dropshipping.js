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
    // v7.5.205 (avis chatgpt-review n° 2 sur 76ebd77) : premier démarrage SANS réseau et SANS état gardé = état INCONNU ; la
    // migration peut déjà être active → « Livré » BLOQUÉ pour les commandes concernées (nos livreurs), jamais pour GLS
    let reseau = false;
    const { bac: b2 } = nouveauBac({ reponse: (url) => (!reseau ? 'reseau' : (/drop_version/.test(url) ? { status: 404, json: { code: 'PGRST202' } } : { status: 200, json: { ok: true } })) });
    b2.commandes = [{ id: '#I1', transporteur: 'RANOU', livreur: 'LIVREUR-TEST' }, { id: '#I2', transporteur: 'GLS', livreur: 'LIVREUR-TEST' }];
    test('pas de réseau, aucun état gardé : état INCONNU', (await b2.dropVerifier()) === false && b2.dropActif === null && b2.dropEtatInconnu() === true && b2.dropModuleActif() === false);
    // v7.5.211 (avis chatgpt-review sur 3aba95e, point 2) : commande GLS (non concernée) : « Livré » seulement après une lecture
    // CONCLUANTE de ses pièces — sans réseau : en attente, puis refus clair (à réessayer), jamais permis à l'aveugle
    const i2a = b2.dropBloqueLivre('#I2'); await attendre();
    test('état inconnu : « Livré » BLOQUÉ pour une commande de nos livreurs (message clair) ; commande GLS : en attente de la lecture de ses pièces, puis refus « à réessayer » (lecture impossible)',
      /pas encore vérifié \(premier démarrage sans réseau\)/.test(b2.dropBloqueLivre('#I1')) && i2a === b2.DROP_MSG_VERIF && b2.dropBloqueLivre('#I2') === b2.DROP_MSG_VERIF_ECHEC, [b2.dropBloqueLivre('#I1'), i2a, b2.dropBloqueLivre('#I2')]);
    test('état inconnu : commande inconnue de l\'appareil traitée comme concernée (côté sûr)', /pas encore vérifié/.test(b2.dropBloqueLivre('#I9')));
    reseau = true;
    vm.runInContext('Date = { now: function() { return 9e15; } };', b2);   // 30 s écoulées : nouvelle vérification permise
    b2.dropBloqueLivre('#I1'); await attendre();
    test('réseau revenu, migration ABSENTE : module inactif, « Livré » débloqué (commande GLS comprise)', b2.dropActif === false && b2.dropEtatInconnu() === false && b2.dropBloqueLivre('#I1') === '' && b2.dropBloqueLivre('#I2', true) === '');
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
    // v7.5.205 (avis chatgpt-review sur 5d095d5, point 2) : la provenance ne prouve PAS la présence physique — la dernière
    // déclaration d'une ligne qui contient une pièce Dépôt NE coche PAS la ligne ; elle reste « à charger » tant que le
    // livreur ne l'a pas cochée lui-même (confirmation de chargement distincte)
    bac.dropPieces['#D1'].pieces[0].provenance = 'fournisseur';
    bac.chargements = {};
    await bac.dropDeclarer('#D1', 2, 'depot', null, null); await attendre();
    bac.dropPieces['#D1'].pieces[1] = Object.assign({}, bac.dropPieces['#D1'].pieces[1], { provenance: 'depot' });
    test('dernière pièce de la ligne déclarée (Dépôt) : la ligne N\'EST PAS cochée d\'office', !bac._coches.some((c) => c[0] === '#D1' && c[2] === true), bac._coches);
    test('… et ne compte pas « chargée » tant que le livreur ne l\'a pas cochée', bac.dropLigneOk('#D1', 0) === false);
    bac.chargements['#D1'] = { 0: { charge: true } };
    test('… cochée par le livreur : chargée', bac.dropLigneOk('#D1', 0) === true);
    bac.chargements = {};
    const { bac: bR } = nouveauBac({ reponse: () => 'reseau' }); bR.dropActif = true; bR.dropPieces['#D1'] = { pieces: [PIECE(1)] };
    await bR.dropDeclarer('#D1', 1, 'depot', null, null);
    test('pas de réseau : message clair, rien de supposé', bR._toasts.some((t) => /Pas de réseau/.test(t[0])) && bR.dropPieces['#D1'].pieces[0].provenance === null);
    const { bac: bE } = nouveauBac({ reponse: () => ({ status: 200, json: { ok: false, erreur: 'dropshipping_inactif' } }) }); bE.dropActif = true; bE.dropPieces['#D1'] = { pieces: [PIECE(1)] };
    await bE.dropDeclarer('#D1', 1, 'fournisseur', 11, null);
    test('refus de la base : message en français', bE._toasts.some((t) => /pas activée en dropshipping/.test(t[0])));
    // progression du chargement (vrai calculerProgressionChargement)
    bac.commandes = [{ id: '#D1', client: 'Client fictif', livreur: 'LIVREUR-TEST', lignes: [{ produit: 'Ensemble fictif', qte: 1 }, { produit: 'Oreiller fictif', qte: 1 }] }]; // v7.5.211 : commande concernée = livreur attribué
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
    bF.dropActif = true; bF.commandes = [{ id: '#D1', statut: 'livré', livreur: 'LIVREUR-TEST' }];
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
  test('setLvSt : « Livré » bloqué par dropBloqueLivre AVANT la fenêtre de signature', setLv.indexOf('dropBloqueLivre(s.cmdId, true)') > -1 && setLv.indexOf('dropBloqueLivre') < setLv.indexOf("if(st==='livré'){"));
  test('setLvSt : reporté / absent (et annulé, v7.5.206) → dropApresNonLivre', /dropIssueSansLivraison\(st, s && s\.statut\)[^\n]*dropApresNonLivre\(s\.cmdId\)/.test(setLv));
  test('validerSig (v7.5.202) : pièces revérifiées ; pièces à confirmer : confirmation → « livré » (seulement si elle a réussi) → déduction (seulement si permise) ; rien à confirmer : « livré » immédiat comme avant',
    sig.indexOf('dropBloqueLivre(s.cmdId, true)') > -1 && sig.indexOf('dropApresLivre(_cmdLivre.id)') < sig.indexOf('stkDeductionPoser(_cmdLivre)')
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
    bac.commandes = [{ id: '#H1', transporteur: 'RANOU', livreur: 'LIVREUR-TEST' }, { id: '#H2', transporteur: 'GLS', livreur: 'LIVREUR-TEST' }];
    test('hors ligne au démarrage, module actif la dernière fois : considéré ACTIF', (await bac.dropVerifier()) === false && bac.dropActif === null && bac.dropModuleActif() === true);
    const h2a = bac.dropBloqueLivre('#H2', true); await attendre();
    test('hors ligne, pièces jamais lues : « Livré » BLOQUÉ, message clair ; commande GLS : en attente puis refus « à réessayer » (v7.5.211 : jamais permis sans lecture concluante)',
      /Pièces pas encore contrôlées/.test(bac.dropBloqueLivre('#H1')) && h2a === bac.DROP_MSG_VERIF && bac.dropBloqueLivre('#H2') === bac.DROP_MSG_VERIF_ECHEC, [h2a, bac.dropBloqueLivre('#H2')]);
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
    bX.dropActif = true; bX.commandes = [{ id: '#X1', statut: 'livré', livreur: 'LIVREUR-TEST' }]; // v7.5.211 : commande concernée
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

  {
    // avis chatgpt-review n° 3 sur 77441b6 : livraison partielle — vente reconnue = pièces livrées seulement (calcul par la base)
    const { bac } = nouveauBac({ role: 'admin' });
    const f = bac.dropPiecesAdminHtml({ ok: true, vente_ht_commande: 600, vente_ht: 487.5, vente_non_reconnue_ht: 112.5, livraison_partielle: true, pieces_livrees: 2, pieces_total: 3, cout_ht: 205, marge_ht: 282.5, pieces: [] });
    test('fiche : livraison partielle signalée, vente RECONNUE (487,50 sur 600) et marge sur les seules pièces livrées', /Livraison partielle : 2\/3 pièces livrées — vente reconnue 487,50 € HT sur 600 € HT/.test(f) && /marge 282,50 € HT/.test(f), f);
    const b = bac.dropBilanHtml({ ventes_ht: 2187.5, ventes_non_reconnues_ht: 112.5, livraisons_partielles: 1, cout_produits_ht: 765, gls_ht: 0, resultat_ht: 1422.5, commandes: 5, detail: [] });
    test('bilan : ventes non reconnues des livraisons partielles affichées', /1 livraison\(s\) partielle\(s\) : 112,50 € HT non reconnus/.test(b));
  }

  {
    // v7.5.206 (revue native P2 sur cfbf0fa) : annulation d'un arrêt / d'une commande pas encore livrée = issue sans livraison
    const { bac } = nouveauBac();
    test('issue sans livraison : reporté, absent ET annulé (pas encore livrée) ; jamais après « livré » (recrédit) ni pour « livré »',
      bac.dropIssueSansLivraison('annulé', 'en-route') && bac.dropIssueSansLivraison('reporté', 'arrivé') && bac.dropIssueSansLivraison('absent', 'en-attente')
      && !bac.dropIssueSansLivraison('annulé', 'livré') && !bac.dropIssueSansLivraison('livré', 'en-route') && !bac.dropIssueSansLivraison('en-route', 'en-attente'));
    const setLv = extraireFonction('function setLvSt(tid, idx, st, _annOk)');
    test('setLvSt : un arrêt ANNULÉ (après la fenêtre du motif) appelle dropApresNonLivre comme reporté / absent', /dropIssueSansLivraison\(st, s && s\.statut\)[^\n]*dropApresNonLivre\(s\.cmdId\)/.test(setLv)
      && setLv.indexOf('dropIssueSansLivraison') > setLv.indexOf('annDemanderMotif'));
    const chg = extraireFonction('function chgStatut(id, st, _annOk)');
    test('chgStatut (fiche commande, administrateur) : annulée / reportée avant livraison → dropApresNonLivre après l\'enregistrement du statut',
      /role === 'admin'[^\n]*dropIssueSansLivraison\(st, ancienStatut\)/.test(chg) && /Promise\.resolve\(_pSc\)[^\n]*dropApresNonLivre\(id\)/.test(chg));
  }

  {
    // v7.5.206 (avis chatgpt-review sur cfbf0fa, point 1) : stock du camion — identifiant UUID (la vraie table refuse « sc_… »)
    const CODE_SC = extraireBloc('// v7.5.206 (avis chatgpt-review sur cfbf0fa, point 1)', '// Enregistrer un mouvement dans la table audit');
    const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const entetes = [];
    const bacSc = (reponse, avecCrypto) => {
      const { bac } = nouveauBac({ role: 'admin', reponse: (url, opt, env) => { entetes.push(opt.headers || {}); return reponse(url, opt, env); } });
      bac.stockCamion = []; bac.logMouvementStock = async () => { bac._mvts = (bac._mvts || 0) + 1; };
      bac.crypto = avecCrypto === false ? undefined : require('crypto').webcrypto; bac.Uint8Array = Uint8Array;
      vm.runInContext(CODE_SC, bac);
      return bac;
    };
    let b = bacSc(() => ({ status: 200, json: [] }));
    const ids = [b.scUuid(), b.scUuid()];
    const bSans = bacSc(() => ({ status: 200, json: [] }), false);
    test('scUuid : uuid v4 valide (crypto.randomUUID), différent à chaque appel ; repli sans crypto valide aussi', UUID4.test(ids[0]) && ids[0] !== ids[1] && UUID4.test(bSans.scUuid()), ids);
    test('scEstUuid : refuse l\'ancien identifiant « sc_… »', b.scEstUuid(ids[0]) && !b.scEstUuid('sc_1700000000_abcdef') && !b.scEstUuid(''));
    entetes.length = 0;
    b = bacSc((url, opt, env) => (/stock_camion/.test(url) && env.method === 'POST') ? { status: 201, json: [Object.assign({ created_at: 'x' }, env.body)] } : { status: 201, json: [] });
    const id1 = await b.ajouterStockCamion('LIVREUR-TEST', 'Sommier fictif 90', 2, '#S1', 'T-S', 'admin');
    const post = b._envois.find((x) => /stock_camion/.test(x.url) && x.method === 'POST');
    test('enregistrement : identifiant uuid v4, colonnes réelles seulement (aucune marque locale envoyée), livreur et libellé renseignés', post && UUID4.test(post.body.id) && post.body.id === id1
      && !('a_envoyer' in post.body) && post.body.livreur === 'LIVREUR-TEST' && post.body.produit_libelle === 'Sommier fictif 90' && post.body.quantite === 2 && post.body.status === 'en_camion', post);
    test('… ligne RELUE (Prefer return=representation), marquée enregistrée, mouvement journalisé une fois', /return=representation/.test(entetes[0] && entetes[0].Prefer || '')
      && b.stockCamion.length === 1 && !b.stockCamion[0].a_envoyer && b._mvts === 1, entetes[0]);
    // échec : ligne gardée « à envoyer », renvoyée au chargement suivant avec le MÊME uuid, puis reprise depuis la base
    let refus = true; const base = [];
    b = bacSc((url, opt, env) => {
      if (/stock_camion/.test(url) && env.method === 'POST') { if (refus) return { status: 503, json: { message: 'indisponible' } }; base.push(env.body); return { status: 201, json: [env.body] }; }
      if (/stock_camion\?status=eq\.en_camion/.test(url)) return { status: 200, json: base.slice() };
      return { status: 204 };
    });
    const id2 = await b.ajouterStockCamion('LIVREUR-TEST', 'Matelas fictif 140', 1, '#S2', null, 'admin');
    test('base indisponible : ligne gardée « à envoyer » sur l\'appareil, aucun mouvement journalisé', b.stockCamion.length === 1 && b.stockCamion[0].a_envoyer === true && !b._mvts);
    refus = false;
    await b.sbLoadStockCamion();
    const posts = b._envois.filter((x) => /stock_camion/.test(x.url) && x.method === 'POST');
    test('reprise : renvoyée avec le MÊME uuid (on_conflict=id, ignore-duplicates : jamais de doublon), puis lue depuis la base', posts.length === 2 && posts[1].body.id === id2
      && /on_conflict=id/.test(posts[1].url) && b.stockCamion.length === 1 && b.stockCamion[0].id === id2 && !b.stockCamion[0].a_envoyer, posts.map((p) => p.body && p.body.id));
    refus = true;
    b.stockCamion.push(b.scEntreeCamion('LIVREUR-TEST', 'Oreiller fictif', 1, '#S3', null, 'admin')); b.stockCamion[1].a_envoyer = true;
    await b.sbLoadStockCamion();
    test('lecture alors que l\'envoi échoue encore : la ligne « à envoyer » reste sur l\'appareil (fusion avec la base)', b.stockCamion.length === 2 && b.stockCamion.some((s) => s.source_cmd_id === '#S3' && s.a_envoyer));
    b._envois.length = 0;
    await b.retirerStockCamion(id2, 'livre', 'admin');
    const patch = b._envois.find((x) => x.method === 'PATCH');
    test('retrait : PATCH sur l\'uuid (id=eq.<uuid>), statut « livre »', patch && patch.url.indexOf('stock_camion?id=eq.' + id2) > 0 && patch.body.status === 'livre', patch);
    b.stockCamion.push({ id: 'sc_1700000000_abcdef', livreur: 'LIVREUR-TEST', produit_libelle: 'Ancienne ligne', quantite: 1, status: 'en_camion' });
    b._envois.length = 0;
    const rLeg = await b.retirerStockCamion('sc_1700000000_abcdef', 'retour_depot', 'admin');
    test('ancienne ligne locale « sc_… » (jamais dans la base) : retirée de l\'appareil, AUCUN appel à la base', rLeg === true && b._envois.length === 0 && !b.stockCamion.some((s) => s.id === 'sc_1700000000_abcdef'));
    test('ancienne ligne « sc_… » jamais renvoyée telle quelle, mais GARDÉE sur l appareil à la fusion (v7.5.207 : reprise)', b.scFusionner([], [{ id: 'sc_1', a_envoyer: true, status: 'en_camion' }]).length === 1 && !b._envois.some((x) => x.body && x.body.id === 'sc_1'));
    test('plus aucun identifiant « sc_ » fabriqué dans l\'appli', !/'sc_' \+ Date\.now\(\)/.test(html));

    // v7.5.207 (avis chatgpt-review sur 6775bbc, point 1) : REPRISE des anciennes lignes locales « sc_… »
    const ANC = (id, cmd, lib, q) => ({ id, livreur: 'LIVREUR-TEST', produit_libelle: lib, quantite: q || 1, source_cmd_id: cmd, source_tournee_id: 'T-S', charge_at: '2026-11-20T08:00:00.000Z', charge_par: 'LIVREUR-TEST', status: 'en_camion' });
    let n = 0;
    const cv = b.scConvertirAnciennes([ANC('sc_1', '#R1', 'Matelas fictif 140'), ANC('sc_2', '#R2', 'Sommier fictif 90', 2), ANC('sc_3', '#R9', 'Oreiller fictif'),
      Object.assign(ANC('sc_4', '#R1', 'Vieux'), { status: 'livre' }), { id: ids[0], status: 'en_camion', a_envoyer: true }],
      (id) => ({ '#R1': 'en-route', '#R2': 'livré' })[id] || null, () => 'u-' + (++n));
    test('conversion : ancienne ligne « en_camion » d\'une commande en cours → NOUVEL uuid, « à envoyer », note de reprise, mêmes produit / quantité / date / tournée',
      cv.converties.length === 2 && cv.stock.some((s) => s.reprise_de === 'sc_1' && s.id === 'u-1' && s.a_envoyer && /Reprise v7\.5\.207/.test(s.notes) && s.produit_libelle === 'Matelas fictif 140'
        && s.charge_at === '2026-11-20T08:00:00.000Z' && s.source_tournee_id === 'T-S'), cv);
    test('conversion : commande déjà LIVRÉE → écartée (l\'article est chez le client), citée ; commande inconnue → reprise « à vérifier » ; historique local ignoré ; lignes uuid gardées telles quelles',
      cv.ecartees.length === 1 && cv.ecartees[0].ancien === 'sc_2' && cv.converties.some((c) => c.ancien === 'sc_3' && c.a_verifier)
      && !cv.stock.some((s) => s.reprise_de === 'sc_4' || s.id === 'sc_4') && cv.stock.some((s) => s.id === ids[0]) && !cv.stock.some((s) => !b.scEstUuid(s.id) && !/^u-/.test(s.id)), cv);
    // parcours complet : 1re ouverture, base indisponible puis disponible ; une seule ligne dans la base, jamais de doublon
    const baseR = []; let refusR = true;
    b = bacSc((url, opt, env) => {
      if (/stock_camion/.test(url) && env.method === 'POST') { if (refusR) return { status: 503, json: {} }; if (!baseR.some((x) => x.id === env.body.id)) baseR.push(env.body); return { status: 201, json: [env.body] }; }
      if (/stock_camion\?status=eq\.en_camion/.test(url)) return { status: 200, json: baseR.slice() };
      return { status: 204 };
    });
    b.stockCamion = [ANC('sc_10', '#R1', 'Matelas fictif 140'), ANC('sc_11', '#R2', 'Sommier fictif 90')];
    b.chargements = { '#R1': { 0: { charge: true, stockCamionId: 'sc_10' } } };
    await b.sbLoadStockCamion();
    test('statuts des commandes pas encore lus : rien n\'est converti ni envoyé (reprise remise au chargement suivant)', b.stockCamion.length === 2 && b.stockCamion[0].id === 'sc_10'
      && !b._envois.some((x) => x.method === 'POST'));
    b.commandes = [{ id: '#R1', statut: 'en-route' }, { id: '#R2', statut: 'livré' }];
    await b.sbLoadStockCamion();
    const uR = b.stockCamion.find((s) => s.reprise_de === 'sc_10');
    test('1re ouverture, base indisponible : ancienne ligne convertie (uuid v4), gardée « à envoyer » ; l\'ancienne retirée du stockage ; l\'écran de chargement pointe sur le nouvel uuid',
      uR && UUID4.test(uR.id) && uR.a_envoyer === true && !JSON.parse(b.localStorage.getItem('mx_stock_camion')).some((s) => /^sc_/.test(s.id)) && b.chargements['#R1'][0].stockCamionId === uR.id, b.stockCamion);
    test('récapitulatif pour l\'administrateur : 1 reprise, 1 écartée (commande livrée)', b._notifs.length === 1 && /1 ancienne\(s\) ligne\(s\) reprise\(s\), 1 écartée/.test(b._notifs[0][2]) && /Administrateur/.test(b._notifs[0][3]), b._notifs);
    refusR = false;
    await b.sbLoadStockCamion(); await b.sbLoadStockCamion();
    const postsR = b._envois.filter((x) => /stock_camion/.test(x.url) && x.method === 'POST');
    test('réseau revenu : envoyée avec le MÊME uuid (note de reprise transmise), une seule ligne dans la base ; plus aucun envoi ensuite ; aucune 2e notification',
      baseR.length === 1 && baseR[0].id === uR.id && /Reprise/.test(baseR[0].notes) && postsR.length === 2 && postsR.every((p) => p.body.id === uR.id)
      && b.stockCamion.length === 1 && !b.stockCamion[0].a_envoyer && b._notifs.length === 1, { baseR, n: postsR.length });

    // v7.5.207 (revue native P2 sur c22dacd) : lignes du chargement retirées à la livraison
    const L = (id, cmd, champs) => Object.assign({ id, livreur: 'LIVREUR-TEST', produit_libelle: 'Matelas fictif 140', quantite: 1, source_cmd_id: cmd, status: 'en_camion' }, champs || {});
    const [c1, c2, c3, c4] = [b.scUuid(), b.scUuid(), b.scUuid(), b.scUuid()];
    const lst = [L(c1, '#V1'), L(c2, '#V1', { achat_id: 7 }), L(c3, '#V1', { piece_id: 9 }), L(c4, '#V2')];
    test('scLignesChargement : seulement les lignes du chargement de la commande (ni achat, ni pièce, ni autre commande)', JSON.stringify(b.scLignesChargement(lst, '#V1').map((s) => s.id)) === JSON.stringify([c1]));
    b = bacSc(() => ({ status: 204 }));
    b.stockCamion = lst.map((x) => Object.assign({}, x));
    let rL = await b.scApresLivre('#V1', 'LIVREUR-TEST');
    const patches = b._envois.filter((x) => x.method === 'PATCH');
    test('« livré » d\'une commande sans pièces : la ligne du chargement sort du camion (PATCH « livre ») ; l\'article acheté et l\'unité d\'une pièce restent',
      rL === 1 && patches.length === 1 && patches[0].url.indexOf(c1) > 0 && patches[0].body.status === 'livre' && b.stockCamion.some((s) => s.id === c2) && b.stockCamion.some((s) => s.id === c3), patches);
    b = bacSc((url) => (/status=eq\.en_camion/.test(url) ? { status: 200, json: [L(c3, '#V1', { piece_id: 9 })] } : { status: 204 }));
    b.stockCamion = lst.map((x) => Object.assign({}, x));
    b.dropPiecesDe = () => [{ id: 1, livraison: null }];
    rL = await b.scApresLivre('#V1', 'LIVREUR-TEST');
    test('commande découpée, confirmation pas encore réussie : « attente », rien retiré (la base réconcilie à la confirmation)', rL === 'attente' && !b._envois.some((x) => x.method === 'PATCH'));
    b.dropPiecesDe = () => [{ id: 1, livraison: 'livree' }];
    rL = await b.scApresLivre('#V1', 'LIVREUR-TEST');
    test('après le succès de la confirmation : lignes du chargement retirées de l\'appareil SANS nouvel envoi, camion relu (l\'unité non livrée gardée par la base)',
      rL === 1 && !b._envois.some((x) => x.method === 'PATCH') && b.stockCamion.length === 1 && b.stockCamion[0].id === c3, b.stockCamion);
    const tri = b.scAEnvoyer([L(c1, '#V1', { a_envoyer: true }), L(c4, '#V2', { a_envoyer: true })], (id) => id === '#V1');
    test('ligne « à envoyer » d\'une commande déjà livrée : jamais envoyée, retirée de l\'appareil', tri.retirer.length === 1 && tri.retirer[0].id === c1 && tri.envoyer.length === 1 && tri.envoyer[0].id === c4);
    const vs = extraireFonction('function validerSig()');
    test('texte : la signature (validerSig) appelle scApresLivre ; le succès de la confirmation (dropEnvoyer) appelle scApresConfirmation ; setLvSt ne retire plus toutes les lignes de la commande',
      /scApresLivre\(_cmdLivre\.id/.test(vs) && /estConf && typeof scApresConfirmation === 'function'/.test(CODE_DROP)
      && !/sc\.status === 'en_camion' && sc\.source_cmd_id === cLv\.id/.test(html) && /scApresLivre\(cLv\.id/.test(html));

    // v7.5.208 (règle des 10 retours ; revue native P2 sur bac211e) : indice de la ligne chargée, règles de la base suivies
    const eI = b.scEntreeCamion('LIVREUR-TEST', 'Sommier fictif 90', 1, '#W1', null, 'admin', null, null, 1);
    const eX = b.scEntreeCamion('LIVREUR-TEST', 'Sommier fictif 90', 1, '#W1', null, 'admin', null, null, 'x');
    const eN = b.scEntreeCamion('LIVREUR-TEST', 'Sommier fictif 90', 1, '#W1', null, 'admin', null, null, -1);
    test('v7.5.208 : la ligne du camion garde l\'indice de la ligne chargée (ligne_idx) ; un indice invalide n\'est jamais inventé', eI.ligne_idx === 1 && !('ligne_idx' in eX) && !('ligne_idx' in eN), { eI, eX, eN });
    b.dropModuleActif = () => true;
    const cA = b.scCorpsEnvoi(Object.assign({ a_envoyer: true }, eI));
    b.dropModuleActif = () => false;
    const cI = b.scCorpsEnvoi(Object.assign({ a_envoyer: true }, eI));
    test('v7.5.208 : l\'indice est envoyé à la base seulement quand la migration 041 est présente (colonne ligne_idx), jamais de marque locale', cA.ligne_idx === 1 && !('ligne_idx' in cI) && !('a_envoyer' in cA), { cA, cI });
    const lst2 = [L(c1, '#V1'), L(c2, '#V1', { scinde_de: c4 }), L(c3, '#V1', { reservee_une_fois: true })];
    test('v7.5.208 : scLignesChargement exclut l\'unité découpée et l\'unité déjà réservée une fois (même règle que la base)', JSON.stringify(b.scLignesChargement(lst2, '#V1').map((x) => x.id)) === JSON.stringify([c1]));
    test('texte v7.5.208 : toggleChargement et l\'annulation de livraison passent l\'indice de la ligne ; la confirmation envoie d\'abord les lignes du chargement « à envoyer » de la commande',
      /ajouterStockCamion\(livreurCible, produitLib, qte, cmdId, t \? t\.id : null, parUser, ligneIdx\)/.test(html)
      && /ajouterStockCamion\(t\.livreur, produitLib, qte, cmd\.id, t\.id, 'admin', li\)/.test(html)
      && /data\.fn === 'drop_confirmer_livraison'[\s\S]{0,200}scEnvoyerChargement\(data\.cmdId\)[\s\S]{0,1200}var r = await dropRpc\(data\.fn/.test(html));

    // v7.5.209 (revue native P2 sur 3fefbc9) : une ligne du chargement « à envoyer » dont l'enregistrement ÉCHOUE retient la
    // confirmation (gardée en file), la ligne locale est gardée, le livreur est prévenu ; le réessai réussi confirme et retire
    let postOk = false;
    b = bacSc((url, opt, env) => {
      if (/stock_camion/.test(url) && env.method === 'POST') return postOk ? { status: 201, json: [Object.assign({}, env.body)] } : { status: 500, json: { message: 'refus fictif' } };
      if (/rpc\/drop_confirmer_livraison/.test(url)) return { status: 200, json: { ok: true } };
      if (/stock_camion\?status=eq\.en_camion/.test(url)) return { status: 200, json: [L(cV8, '#V8')] };   // la base : seule la ligne de #V8 reste au camion
      return { status: 200, json: [] };
    });
    const cP = b.scUuid(), cV8 = b.scUuid();
    b.stockCamion = [L(cP, '#V9', { a_envoyer: true }), L(cV8, '#V8', { a_envoyer: true })];
    let rC = await b.dropPoser('conf:#V9', 'drop_confirmer_livraison', { p_cmd_id: '#V9' }, '#V9');
    test('v7.5.209 : ligne du chargement pas enregistrée (POST refusé) : confirmation NON envoyée (« reessayer »), gardée en file, ligne locale gardée « à envoyer », livreur prévenu',
      rC === 'reessayer' && !b._envois.some((x) => /rpc\/drop_confirmer_livraison/.test(x.url)) && b.dropConfEnFile('#V9')
      && b.stockCamion.some((s) => s.id === cP && s.a_envoyer) && b._toasts.some((x) => /pas encore enregistré/.test(x[0]))
      && b._notifs.some((x) => /^Livraison en attente — #V9/.test(x[2])), { rC, envois: b._envois.map((x) => x.method + ' ' + x.url), toasts: b._toasts });
    const nAvis = b._notifs.length;
    rC = await b.dropEnvoyer({ id: 'conf:#V9', fn: 'drop_confirmer_livraison', params: { p_cmd_id: '#V9' }, cmdId: '#V9' });
    test('v7.5.209 : 2e échec : toujours « reessayer », pas de 2e alerte', rC === 'reessayer' && b._notifs.length === nAvis && !b._envois.some((x) => /rpc\/drop_confirmer_livraison/.test(x.url)));
    test('v7.5.209 : la ligne d\'une confirmation encore en file n\'est jamais retirée comme « commande livrée » au rechargement du camion',
      /dropConfEnFile\(id\)\) return false;[\s\S]{0,120}c\.statut === 'livré'/.test(html));
    postOk = true;
    rC = await b.dropEnvoyer({ id: 'conf:#V9', fn: 'drop_confirmer_livraison', params: { p_cmd_id: '#V9' }, cmdId: '#V9' });
    test('v7.5.209 : ligne enfin enregistrée : la confirmation part APRÈS elle, file vidée, ligne du chargement retirée de l\'appareil (réconciliée par la base) ; l\'autre commande intacte',
      rC === 'ok' && !b.dropConfEnFile('#V9') && !b.stockCamion.some((s) => s.id === cP) && b.stockCamion.some((s) => s.source_cmd_id === '#V8')
      && (() => { const iR = b._envois.findIndex((x) => /rpc\/drop_confirmer_livraison/.test(x.url)); let iP = -1; b._envois.forEach((x, k) => { if (x.method === 'POST' && /stock_camion/.test(x.url) && x.body && x.body.id === cP) iP = k; }); return iR > -1 && iP > -1 && iP < iR; })(),
      { rC, file: b.dropConfEnFile('#V9'), sc: b.stockCamion.map((s) => s.source_cmd_id + ':' + (s.id === cP)) });
  }

  {
    // v7.5.210 (revue native P2 sur a1d9e57) : unité du camion venue du stock tampon, confirmée livrée, lot épuisé APRÈS la
    // confirmation (déduction refusée « stock_tampon_epuise ») : bouton de dérogation motivée dans la fiche commande (admin)
    const PT = (champs) => Object.assign({ id: 71, libelle: 'Oreiller fictif', provenance: 'camion', origine: 'depot', fournisseur: 'Fournisseur fictif', livraison: 'livree', fige: false, cout_ht: 4 }, champs || {});
    const marge = (statut, pieces) => ({ ok: true, statut, vente_ht: 30, vente_ht_commande: 30, cout_ht: 4, marge_ht: 26, pieces });
    let rep = marge('livré', [PT(), PT({ id: 72, fournisseur: null }), PT({ id: 73, fige: true }), PT({ id: 74, provenance: 'tampon' })]);
    let repCorr = { ok: true, piece: 71, cout_ht: 6, derogation: 'tampon_camion_epuise', source: 'revient' };
    const { bac, els } = nouveauBac({ role: 'admin', reponse: (url) => ({ status: 200, json: /drop_marge_commande/.test(url) ? rep : /drop_tampon_corriger/.test(url) ? repCorr : { ok: true } }) });
    bac.dropActif = true; bac.currentCmdId = '#D7';
    test('pièce visée (pure) : seulement camion + origine dépôt + fournisseur du lot + livrée + coût pas figé',
      bac.dropPieceTamponCamionBloquee(PT()) === true && bac.dropPieceTamponCamionBloquee(PT({ fournisseur: null })) === false && bac.dropPieceTamponCamionBloquee(PT({ fige: true })) === false
      && bac.dropPieceTamponCamionBloquee(PT({ livraison: null })) === false && bac.dropPieceTamponCamionBloquee(PT({ provenance: 'tampon' })) === false && bac.dropPieceTamponCamionBloquee(PT({ origine: 'achat' })) === false);
    await bac.dropFicheCommande('#D7');
    const h = els['drop-fiche'].innerHTML;
    test('fiche commande « livré » : bouton de dérogation pour la SEULE pièce visée (71), pas pour les autres', /dropTamponCamionDeroger\('#D7',71\)/.test(h) && !/dropTamponCamionDeroger\('#D7',7[234]\)/.test(h) && /Lot épuisé : sortir du stock du dépôt au prix de revient \(motif\)/.test(h), h.slice(-600));
    rep = marge('en_cours', [PT()]); els['drop-fiche'].innerHTML = '';
    await bac.dropFicheCommande('#D7');
    test('… commande pas encore « livré » : aucun bouton (rien n\'a pu être refusé)', !/dropTamponCamionDeroger/.test(els['drop-fiche'].innerHTML));
    bac._prompt = 'abc';
    await bac.dropTamponCamionDeroger('#D7', 71);
    test('dérogation : motif de moins de 5 caractères refusé, rien envoyé', !bac._envois.some((e) => /drop_tampon_corriger/.test(e.url)) && bac._toasts.some((t) => /Motif obligatoire/.test(t[0])));
    bac._prompt = null;
    await bac.dropTamponCamionDeroger('#D7', 71);
    test('dérogation : annulée (prompt fermé), rien envoyé', !bac._envois.some((e) => /drop_tampon_corriger/.test(e.url)));
    bac._prompt = 'Lot vide après la livraison, vérifié au dépôt';
    await bac.dropTamponCamionDeroger('#D7', 71);
    const e = bac._envois.find((x) => /rpc\/drop_tampon_corriger/.test(x.url));
    test('dérogation : envoyée à drop_tampon_corriger avec la pièce et le motif ; coût figé annoncé (6 € HT, prix de revient)',
      e && e.body.p_piece_id === 71 && e.body.p_motif === 'Lot vide après la livraison, vérifié au dépôt'
      && bac._toasts.some((t) => /Dérogation enregistrée \(journalisée\) : coût figé 6.*HT \(prix de revient\)/.test(t[0])), bac._toasts.slice(-1));
    repCorr = { ok: false, erreur: 'lot_disponible' };
    await bac.dropTamponCamionDeroger('#D7', 71);
    test('refus « lot_disponible » de la base : message clair (aucune dérogation nécessaire)', bac._toasts.some((t) => /couvre encore cette pièce/.test(t[0])), bac._toasts.slice(-1));
    const { bac: bL } = nouveauBac({ role: 'livreur' });
    bL._prompt = 'motif suffisant';
    await bL.dropTamponCamionDeroger('#D7', 71);
    test('livreur : aucune dérogation possible (rien envoyé)', !bL._envois.some((x) => /drop_tampon_corriger/.test(x.url)));
  }

  {
    // v7.5.206 (avis chatgpt-review sur efe0409, point 2) : COHÉRENCE DES VERSIONS — CACHE_VERSION du service worker, version
    // annoncée en tête du service worker (1re ligne « // v7.5.X - ») et version documentée dans CLAUDE.md (ligne « Version de
    // l'appli à mettre en ligne », titre de la section Dropshipping, ordre de mise en ligne) doivent être la MÊME.
    const sw = fs.readFileSync(path.join(racine, 'service-worker.js'), 'utf8');
    const doc = fs.readFileSync(path.join(racine, 'CLAUDE.md'), 'utf8');
    const mCache = sw.match(/const CACHE_VERSION = 'maxiconfort-v(\d+)-(\d+)-(\d+)';/);
    const vCache = mCache ? mCache.slice(1).join('.') : null;
    const mEnTete = sw.match(/^\/\/ v(\d+\.\d+\.\d+) - /m);
    const vEnTete = mEnTete ? mEnTete[1] : null;
    const mDoc = doc.match(/Version de l'appli à mettre en ligne : v(\d+\.\d+\.\d+) \(CACHE_VERSION `maxiconfort-v(\d+)-(\d+)-(\d+)`\)/);
    const vDoc = mDoc ? mDoc[1] : null, vDocCache = mDoc ? mDoc.slice(2).join('.') : null;
    const mTitre = doc.match(/## Dropshipping et provenance \(v\d+\.\d+\.\d+ → v(\d+\.\d+\.\d+)/);
    const mOrdre = doc.match(/ORDRE DE MISE EN LIGNE \(obligatoire\)\*\* : [^\n]*PUIS l'appli \*\*v(\d+\.\d+\.\d+)\*\*/);
    const toutes = { cache: vCache, enTete: vEnTete, doc: vDoc, docCache: vDocCache, titre: mTitre && mTitre[1], ordre: mOrdre && mOrdre[1] };
    test('cohérence des versions : CACHE_VERSION = en-tête du service worker = CLAUDE.md (ligne de version, son CACHE_VERSION, titre Dropshipping, ordre de mise en ligne)',
      !!vCache && Object.values(toutes).every((v) => v === vCache), toutes);
    test('la version annoncée en tête du service worker est la plus récente de son historique', (() => {
      const vs = [...sw.matchAll(/^\/\/ v(\d+)\.(\d+)\.(\d+)[a-z]? - /gm)].map((m) => [+m[1], +m[2], +m[3]]);
      return vs.length > 0 && vs.every((v) => (v[0] * 1e6 + v[1] * 1e3 + v[2]) <= (vs[0][0] * 1e6 + vs[0][1] * 1e3 + vs[0][2]));
    })());
  }

  // ════════════════════════════════════════════════════════════════════════════════════
  console.log('\nDÉFAUTS OBSERVÉS EN PRODUCTION (v7.5.210, GO de Borhen) — v7.5.211');
  {
    // DÉFAUT 1 : une commande NON concernée (sans livreur, GLS) n'est jamais découpée par l'appli ni bloquée
    const { bac: bN } = nouveauBac({ role: 'admin', reponse: (url) => (/drop_pieces/.test(url) ? { status: 200, json: { ok: true, pieces: [PIECE(1, { cmd_id: '#N3' })] } } : { status: 200, json: { ok: true } }) });
    bN.dropActif = true;
    bN.commandes = [{ id: '#N1', transporteur: 'RANOU', livreur: '', statut: 'en-attente' }, { id: '#N2', transporteur: 'GLS', livreur: 'LIVREUR-TEST', statut: 'en-attente' },
      { id: '#N3', transporteur: 'RANOU', livreur: 'LIVREUR-TEST', statut: 'en-attente' }, { id: '#N4', transporteur: '', livreur: 'LIVREUR-TEST', statut: 'livré' }];
    test('dropCmdConcernee : sans livreur → non ; GLS → non ; RANOU (ou vide) avec livreur → oui ; inconnue → oui (prudence)',
      !bN.dropCmdConcernee(bN.commandes[0]) && !bN.dropCmdConcernee(bN.commandes[1]) && bN.dropCmdConcernee(bN.commandes[2]) && bN.dropCmdConcernee(bN.commandes[3]) && bN.dropCmdConcernee(null));
    const r1 = await bN.dropChargerPieces('#N1'), r2 = await bN.dropChargerPieces('#N2');
    const lireN = () => bN._envois.filter((e) => /\/rpc\/drop_pieces_lire$/.test(e.url)).map((e) => e.body && e.body.p_cmd_id).join();
    test('commande SANS livreur ou GLS : aucun appel drop_pieces (plus de découpage à l\'ouverture de la fiche) ; lue SANS création (avis sur df07c0d, point 3) ; pièces jamais déclarées : rien gardé', r1.nonConcernee && r2.nonConcernee
      && !bN._envois.some((e) => /\/rpc\/drop_pieces$/.test(e.url)) && lireN() === '#N1,#N2' && !bN.dropPieces['#N1'] && !bN.dropPieces['#N2'], bN._envois.map((e) => e.url));
    test('« Livré » jamais bloqué pour une commande sans livreur ou GLS (aucun découpage ; déjà lue sans création : pas relue)', bN.dropBloqueLivre('#N1') === '' && bN.dropBloqueLivre('#N2') === ''
      && !bN._envois.some((e) => /\/rpc\/drop_pieces$/.test(e.url)) && lireN() === '#N1,#N2', lireN());
    const r3 = await bN.dropChargerPieces('#N3');
    test('commande CONCERNÉE (livreur attribué) : découpage demandé comme avant', !!r3 && !r3.nonConcernee && bN._envois.filter((e) => /\/rpc\/drop_pieces$/.test(e.url)).length === 1 && bN.dropPieces['#N3'].pieces.length === 1);
    // avis chatgpt-review sur adf71bb, point 5 : commande DÉJÀ livrée → lecture SANS création (drop_pieces_lire, 042), jamais drop_pieces
    const lus = [];
    const { bac: bL } = nouveauBac({ role: 'admin', reponse: (url, opt) => {
      if (/\/rpc\/drop_pieces_lire$/.test(url)) { const id = JSON.parse(opt.body).p_cmd_id; lus.push(id);
        if (bL._lireEtat === 'absente') return { status: 404, json: { code: 'PGRST202' } };
        if (bL._lireEtat === 'panne') return { status: 503, json: {} };
        return { status: 200, json: { ok: true, lecture_seule: true, perime: false, tva_pct: 20, pieces: id === '#L1' ? [PIECE(7, { cmd_id: '#L1', provenance: 'depot', livraison: 'livree' })] : [] } }; }
      if (/\/rpc\/drop_pieces$/.test(url)) return { status: 200, json: { ok: true, pieces: [PIECE(8)] } };
      return { status: 200, json: { ok: true } }; } });
    bL.dropActif = true;
    bL.commandes = [{ id: '#L1', transporteur: 'RANOU', livreur: 'LIVREUR-TEST', statut: 'livré' }, { id: '#L2', transporteur: '', livreur: 'LIVREUR-TEST', statut: 'livre' },
      { id: '#L3', transporteur: 'RANOU', livreur: '', statut: 'livré' }];
    const rL1 = await bL.dropChargerPieces('#L1');
    test('commande DÉJÀ livrée, pièces déclarées sur un AUTRE appareil (appareil neuf, rien en cache) : lues sans création, gardées',
      rL1 && !rL1.nonConcernee && rL1.lectureSeule && rL1.pieces.length === 1 && rL1.pieces[0].livraison === 'livree' && bL.dropPieces['#L1'] && bL.dropPieces['#L1'].pieces.length === 1, rL1);
    const rL2 = await bL.dropChargerPieces('#L2');
    test('commande DÉJÀ livrée jamais découpée : lecture seule, aucune pièce, aucun drop_pieces (jamais de création)', rL2 && rL2.pieces.length === 0
      && !bL._envois.some((e) => /\/rpc\/drop_pieces$/.test(e.url)) && lus.join() === '#L1,#L2', [rL2, lus]);
    await bL.dropChargerPieces('#L1');
    test('commande livrée DONT les pièces sont déjà connues : relue sans création (plus de drop_pieces, ni découpage ni redécoupage)',
      lus.join() === '#L1,#L2,#L1' && !bL._envois.some((e) => /\/rpc\/drop_pieces$/.test(e.url)), lus);
    const rL3 = await bL.dropChargerPieces('#L3');
    test('commande livrée NON concernée (sans livreur) : lue SANS création, aucune pièce déclarée → rien gardé, jamais de création', rL3.nonConcernee && lus.join() === '#L1,#L2,#L1,#L3' && !bL.dropPieces['#L3'] && !bL._envois.some((e) => /\/rpc\/drop_pieces$/.test(e.url)), lus);
    bL._lireEtat = 'panne'; delete bL.dropPieces['#L2'];
    const rP = await bL.dropChargerPieces('#L2');
    test('lecture seule en 503 : rien gardé (nouvel essai plus tard), jamais de repli sur drop_pieces', rP === null && !bL.dropPieces['#L2'] && !bL._envois.some((e) => /\/rpc\/drop_pieces$/.test(e.url)));
    bL._lireEtat = 'absente';
    const rA = await bL.dropChargerPieces('#L2'), rA1 = await bL.dropChargerPieces('#L1');
    test('042 pas appliquée (drop_pieces_lire absente) : aucune pièce lue pour une commande inconnue, pièces déjà connues gardées, jamais drop_pieces',
      rA.nonConcernee && rA.pieces.length === 0 && rA1 && rA1.pieces.length === 1 && !bL._envois.some((e) => /\/rpc\/drop_pieces$/.test(e.url)));
    const r4 = await bN.dropChargerPieces('#N4');
    test('commande DÉJÀ livrée (bac précédent) : seule la lecture sans création est demandée', !!r4 && bN._envois.filter((e) => /\/rpc\/drop_pieces_lire$/.test(e.url) && e.body && e.body.p_cmd_id === '#N4').length === 1
      && bN._envois.filter((e) => /\/rpc\/drop_pieces$/.test(e.url)).map((e) => e.body && e.body.p_cmd_id).join() === '#N3', bN._envois.map((e) => e.url));
    test('… et « Livré » toujours bloqué tant que sa pièce n\'est pas indiquée', bN.dropBloqueLivre('#N3') !== '');
    // pièces déjà en cache (découpée par la v7.5.210 à l'ouverture de sa fiche) : ignorées pour une commande non concernée
    bN.dropPieces['#N1'] = { pieces: [PIECE(9, { cmd_id: '#N1' })] };
    test('pièces en cache d\'une commande non concernée : ignorées (aucun blocage, aucune confirmation envoyée, déduction permise)',
      bN.dropPiecesDe('#N1').length === 0 && bN.dropBloqueLivre('#N1') === '' && bN.dropDeductionPermise('#N1') === true && bN.dropAConfirmer('#N1') === false);
    test('dropApresLivre d\'une commande non concernée : rien à confirmer', (await bN.dropApresLivre('#N1')) === 'rien' && !bN._envois.some((e) => /drop_confirmer_livraison/.test(e.url)));
    const { bac: bT } = nouveauBac({ reponse: () => ({ status: 200, json: { ok: true, pieces: [] } }) });
    bT.dropActif = true; bT.commandes = [{ id: '#T1', transporteur: 'RANOU', livreur: '' }, { id: '#T2', transporteur: 'RANOU', livreur: 'LIVREUR-TEST' }];
    await bT.dropChargerTournee({ id: 'T-1', stops: [{ cmdId: '#T1' }, { cmdId: '#T2' }] }, null, true);
    test('pièces d\'une tournée : seule la commande concernée est lue', bT._envois.filter((e) => /drop_pieces/.test(e.url)).map((e) => e.body && e.body.p_cmd_id).join() === '#T2', bT._envois.map((e) => e.body));

    // AVIS chatgpt-review SUR df07c0d, point 3 : pièces DÉJÀ déclarées d'une commande devenue NON concernée (livreur retiré après la
    // déclaration, passage en GLS) : la base (042) les contrôle toujours → l'appli les lit (sans création), les montre et les contrôle
    {
      const etatD = { mode: 'ok' };
      const { bac: bD } = nouveauBac({ reponse: (url, opt) => {
        if (/\/rpc\/drop_pieces_lire$/.test(url)) { const id = JSON.parse(opt.body).p_cmd_id;
          if (etatD.mode === 'absente') return { status: 404, json: { code: 'PGRST202' } };
          if (etatD.mode === 'panne') return { status: 503, json: {} };
          if (id === '#D9') return { status: 200, json: { ok: true, lecture_seule: true, perime: false, tva_pct: 20, pieces: etatD.reinit ? [PIECE(91, { cmd_id: '#D9' })] : [PIECE(91, { cmd_id: '#D9', provenance: 'depot' })] } };
          if (id === '#D8') return { status: 200, json: { ok: true, lecture_seule: true, perime: false, tva_pct: 20, pieces: [PIECE(81, { cmd_id: '#D8', provenance: 'depot', livraison: 'livree' }), PIECE(82, { cmd_id: '#D8', provenance: 'depot' })] } };
          return { status: 200, json: { ok: true, lecture_seule: true, pieces: [PIECE(71, { cmd_id: id })] } }; }
        return { status: 200, json: { ok: true, pieces: [PIECE(99)] } }; } });
      const lireD = () => bD._envois.filter((e) => /\/rpc\/drop_pieces_lire$/.test(e.url)).map((e) => e.body && e.body.p_cmd_id).join();
      const creeD = () => bD._envois.some((e) => /\/rpc\/drop_pieces$/.test(e.url));
      const tic = () => new Promise((r) => setImmediate(r));
      bD.dropActif = true;
      bD.commandes = [{ id: '#D9', transporteur: 'RANOU', livreur: '', statut: 'en-attente' }, { id: '#D8', transporteur: 'GLS', livreur: 'LIVREUR-TEST', statut: 'en-attente' },
        { id: '#D7', transporteur: 'RANOU', livreur: '', statut: 'en-attente' }, { id: '#D6', transporteur: 'RANOU', livreur: '', statut: 'en-attente' }, { id: '#D5', transporteur: 'RANOU', livreur: '', statut: 'en-attente' }];
      test('dropPieceDeclaree : provenance, issue de livraison ou achat → déclarée ; pièce nue → non (même règle que la base)',
        bD.dropPieceDeclaree(PIECE(1, { provenance: 'depot' })) && bD.dropPieceDeclaree(PIECE(1, { livraison: 'non_livree' })) && bD.dropPieceDeclaree(PIECE(1, { achat: { id: 3, statut: 'paye' } }))
        && bD.dropPieceDeclaree(PIECE(1, { achat_id: 4 })) && !bD.dropPieceDeclaree(PIECE(1)) && !bD.dropPieceDeclaree(PIECE(1, { achat: null })) && !bD.dropPieceDeclaree(null));
      // appareil neuf : rien en cache → « Livré » EN ATTENTE pendant la lecture SANS création (avis sur 3aba95e, point 2), puis contrôlée comme la base
      const b0 = bD.dropBloqueLivre('#D9'); await tic(); await tic();
      test('livreur retiré APRÈS la déclaration, appareil neuf : « Livré » en attente pendant la lecture ; pièces lues SANS création (jamais drop_pieces), gardées',
        b0 === bD.DROP_MSG_VERIF && lireD() === '#D9' && !creeD() && bD.dropPieces['#D9'] && bD.dropPieces['#D9'].lectureSeule && bD.dropPieces['#D9'].pieces.length === 1, [b0, lireD()]);
      test('… commande CONTRÔLÉE : pièces montrées, « Livré » bloqué tant que la pièce n\'est pas indiquée, confirmation à envoyer, déduction en attente',
        bD.dropCmdControlee('#D9') && bD.dropPiecesDe('#D9').length === 1 && /Indiquez pièce par pièce/.test(bD.dropBloqueLivre('#D9')) && bD.dropAConfirmer('#D9') === true && bD.dropDeductionPermise('#D9') === false, bD.dropBloqueLivre('#D9'));
      bD.dropChoisirLivraison('#D9', 91, true);
      test('… pièce indiquée « livrée » : « Livré » permis, et la confirmation part à la base après le « livré »', bD.dropBloqueLivre('#D9') === ''
        && (await bD.dropApresLivre('#D9'), bD._envois.some((e) => /drop_confirmer_livraison/.test(e.url) && e.body && e.body.p_cmd_id === '#D9')));
      const luAvant = lireD(); bD.dropBloqueLivre('#D9'); await tic(); bD.dropBloqueLivre('#D9'); await tic();
      test('… aucune relecture à chaque affichage (seulement à la demande et après la confirmation)', lireD() === luAvant && !creeD(), [luAvant, lireD()]);
      // GLS dont les pièces ont déjà été déclarées (connues de l'appareil) : contrôlée aussi
      await bD.dropChargerPieces('#D8');
      test('passée en GLS APRÈS la déclaration : pièces gardées, « Livré » bloqué (1 pièce à indiquer), jamais de création',
        bD.dropPiecesDe('#D8').length === 2 && /Indiquez pièce par pièce[^(]*\(1 pièce\)/.test(bD.dropBloqueLivre('#D8')) && !creeD(), bD.dropBloqueLivre('#D8'));
      // tournée : la commande non concernée aux pièces déclarées est relue SANS création ; celle sans pièce déclarée n'est pas lue
      const nAv = bD._envois.length;
      await bD.dropChargerTournee({ id: 'T-D', stops: [{ cmdId: '#D9' }, { cmdId: '#D7' }] }, null, true);
      test('pièces d\'une tournée : commande non concernée aux pièces déclarées relue sans création ; sans pièce déclarée : pas lue',
        bD._envois.slice(nAv).map((e) => e.url.replace(/.*\/rpc\//, '') + ':' + (e.body && e.body.p_cmd_id)).join() === 'drop_pieces_lire:#D9', bD._envois.slice(nAv).map((e) => e.url));
      // la base fait foi : pièces réinitialisées (plus aucune déclaration) → oubliées, commande de nouveau libre
      etatD.reinit = true; await bD.dropChargerPieces('#D9');
      test('pièces réinitialisées dans la base (plus aucune déclaration) : oubliées par l\'appareil, « Livré » de nouveau libre',
        !bD.dropPieces['#D9'] && !bD.dropCmdControlee('#D9') && bD.dropBloqueLivre('#D9') === '' && bD.dropDeductionPermise('#D9') === true);
      // pièces jamais déclarées : en attente pendant la lecture, puis livrable (lecture concluante), rien gardé, une seule lecture
      const b7 = bD.dropBloqueLivre('#D7'); await tic(); await tic(); bD.dropBloqueLivre('#D7'); await tic();
      test('non concernée, pièces JAMAIS déclarées : en attente pendant la lecture, puis LIVRABLE (lecture concluante), rien gardé, une seule lecture sans création',
        b7 === bD.DROP_MSG_VERIF && !bD.dropPieces['#D7'] && bD.dropBloqueLivre('#D7') === '' && lireD().split(',').filter((x) => x === '#D7').length === 1 && !creeD(), [b7, lireD()]);
      // base surchargée : aucune lecture pendant la pause → « Livré » refusé, à réessayer ; lecture en 503 : rien gardé, refusé,
      // pas de nouvel essai avant 5 min à l'affichage
      bD.chargeEnPause = () => true; const b6p = bD.dropBloqueLivre('#D6'); await tic();
      const sansPause = !lireD().includes('#D6');
      bD.chargeEnPause = () => false; etatD.mode = 'panne'; const b6a = bD.dropBloqueLivre('#D6'); await tic(); await tic(); bD.dropBloqueLivre('#D6'); await tic();
      test('pause après erreur de la base : aucune lecture, « Livré » refusé (à réessayer) ; lecture en 503 : rien gardé, refusé, pas de nouvel essai avant 5 min à l\'affichage',
        sansPause && b6p === bD.DROP_MSG_VERIF_ECHEC && b6a === bD.DROP_MSG_VERIF && lireD().split(',').filter((x) => x === '#D6').length === 1 && !bD.dropPieces['#D6']
        && bD.dropBloqueLivre('#D6') === bD.DROP_MSG_VERIF_ECHEC, [b6p, b6a, lireD()]);
      // 042 pas appliquée : un seul essai pour toute la session ; pièces déclarées déjà connues de l'appareil toujours contrôlées
      etatD.mode = 'absente'; bD.dropBloqueLivre('#D5'); await tic(); await tic();
      const nAbs = bD._envois.length;
      bD._dropLuNonConcernee = {}; bD.dropBloqueLivre('#D7'); await tic(); const rAbs = await bD.dropChargerPieces('#D6');
      test('042 pas appliquée (drop_pieces_lire absente) : plus aucune lecture de la session, aucune création, rien bloqué par l\'appli',
        bD._dropLireAbsente === true && bD._envois.length === nAbs && rAbs.nonConcernee && !creeD() && bD.dropBloqueLivre('#D5') === '' && bD.dropBloqueLivre('#D7', true) === '');
      test('… et les pièces déclarées déjà connues de l\'appareil restent contrôlées', bD.dropPiecesDe('#D8').length === 2 && bD.dropBloqueLivre('#D8') !== '');
    }

    // AVIS chatgpt-review SUR 3aba95e, point 2 : « Livré » d'une commande NON concernée seulement après une lecture CONCLUANTE de
    // ses pièces. Réponses de la base tenues en main (clic AVANT la réponse, lecture en échec). Vrai code de setLvSt.
    {
      const rep = (status, json) => ({ ok: status >= 200 && status < 300, status, text: async () => (json === undefined ? '' : JSON.stringify(json)), json: async () => json });
      const bacV = (role) => {
        const { bac: b } = nouveauBac({ role });
        b._enVol = [];
        b.fetch = (url, opt = {}) => {
          const env = { url, method: opt.method || 'GET', body: opt.body && typeof opt.body === 'string' ? JSON.parse(opt.body) : null };
          b._envois.push(env);
          if (/\/rpc\/drop_pieces_lire$/.test(url)) return new Promise((ok, ko) => b._enVol.push({ id: env.body.p_cmd_id, repondre: (json, status) => ok(rep(status || 200, json)), couper: () => ko(new Error('Failed to fetch')) }));
          return Promise.resolve(rep(200, /drop_version/.test(url) ? '041' : { ok: true }));
        };
        b.dropActif = true;
        b.annDemanderMotif = () => {};
        vm.runInContext(extraireFonction('function setLvSt(tid, idx, st, _annOk)'), b);
        return b;
      };
      // clic « Livré » réel (setLvSt) : rend 'retenu' si l'arrêt n'a pas bougé, 'passe' si le contrôle des pièces l'a laissé passer
      const clic = (b, idx) => { const s = b.tournees[0].stops[idx]; delete s.heureStatut; try { b.setLvSt('T-V', idx, 'livré'); } catch (e) { /* la suite (fenêtre de signature) n'existe pas dans le bac */ } return s.heureStatut ? 'passe' : 'retenu'; };
      const lus = (b, id) => b._envois.filter((e) => /\/rpc\/drop_pieces_lire$/.test(e.url) && e.body && e.body.p_cmd_id === id).length;
      const ARR = (cmdId) => ({ cmdId, client: 'Client essai', statut: 'arrivé', produit: 'Matelas', prix: 100 });
      const bV = bacV('admin');
      bV.commandes = [{ id: '#V1', transporteur: 'RANOU', livreur: '', statut: 'en-route' }, { id: '#V2', transporteur: 'RANOU', livreur: '', statut: 'en-route' },
        { id: '#V3', transporteur: 'GLS', livreur: 'LIVREUR-TEST', statut: 'en-route' }, { id: '#V4', transporteur: 'RANOU', livreur: '', statut: 'en-route' },
        { id: '#V5', transporteur: 'RANOU', livreur: '', statut: 'en-route' }];
      bV.tournees = [{ id: 'T-V', livreur: 'LIVREUR-TEST', stops: ['#V1', '#V2', '#V3', '#V4', '#V5'].map(ARR) }];
      // #V1 : appareil neuf, livreur retiré APRÈS la déclaration d'une pièce (la base refuserait « livré » : PIECES_NON_CONFIRMEES)
      const c1 = clic(bV, 0); await attendre();
      test('CLIC AVANT LA RÉPONSE (appareil neuf, pièces déjà déclarées inconnues) : « Livré » RETENU, message d\'attente « vérification des pièces… », lecture SANS création partie',
        c1 === 'retenu' && lus(bV, '#V1') === 1 && bV._enVol.length === 1 && bV._toasts.length === 1 && bV._toasts[0][1] === 'info' && /⏳ Vérification des pièces…/.test(bV._toasts[0][0])
        && !bV._envois.some((e) => /\/rpc\/drop_pieces$/.test(e.url)), [c1, bV._toasts]);
      test('… bouton « Livré » en attente et encadré d\'attente sur l\'arrêt (pas un refus) ; un second clic ne relance aucune lecture',
        bV.dropLivreEnAttente('#V1') === true && /⏳ Vérification des pièces…/.test(bV.dropLivraisonHtml({}, bV.tournees[0].stops[0], 0)) && !/🔒/.test(bV.dropLivraisonHtml({}, bV.tournees[0].stops[0], 0))
        && clic(bV, 0) === 'retenu' && lus(bV, '#V1') === 1);
      bV._enVol.shift().repondre({ ok: true, lecture_seule: true, perime: false, tva_pct: 20, pieces: [PIECE(11, { cmd_id: '#V1', provenance: 'depot' })] }); await attendre();
      test('… réponse : une pièce DÉJÀ déclarée → commande contrôlée comme par la base, « Livré » toujours retenu (pièce à indiquer), plus d\'attente',
        bV.dropCmdControlee('#V1') && /Indiquez pièce par pièce/.test(bV.dropBloqueLivre('#V1', true)) && clic(bV, 0) === 'retenu' && bV.dropLivreEnAttente('#V1') === false
        && /🔒 Indiquez pièce par pièce/.test(bV._toasts[bV._toasts.length - 1][0]), bV._toasts);
      // #V2 : jamais découpée, sans livreur (le défaut d'origine) : reste livrable — « aucune pièce » est une réponse concluante
      const c2 = clic(bV, 1); await attendre();
      const att2 = bV.dropBloqueLivre('#V2', true);
      bV._enVol.shift().repondre({ ok: true, lecture_seule: true, pieces: [] }); await attendre();
      test('commande JAMAIS découpée, sans livreur (défaut d\'origine) : clic avant la réponse retenu ; réponse « aucune pièce » = CONCLUANTE → « Livré » permis, rien gardé, jamais de création',
        c2 === 'retenu' && att2 === bV.DROP_MSG_VERIF && bV.dropBloqueLivre('#V2', true) === '' && clic(bV, 1) === 'passe' && !bV.dropPieces['#V2'] && lus(bV, '#V2') === 1
        && !bV._envois.some((e) => /\/rpc\/drop_pieces$/.test(e.url)));
      // #V3 (GLS) : découpée par la v7.5.210 à l'ouverture de sa fiche, pièce jamais déclarée → concluante aussi
      clic(bV, 2); await attendre();
      bV._enVol.shift().repondre({ ok: true, lecture_seule: true, pieces: [PIECE(31, { cmd_id: '#V3' })] }); await attendre();
      test('commande GLS découpée à l\'ouverture de sa fiche (pièce JAMAIS déclarée) : lecture concluante → « Livré » permis, pièce ignorée', bV.dropBloqueLivre('#V3', true) === '' && clic(bV, 2) === 'passe' && !bV.dropPieces['#V3']);
      // #V4 : la lecture ÉCHOUE (coupure réseau) → refus clair, à réessayer
      const nT = bV._toasts.length;
      const c4 = clic(bV, 3); await attendre();
      bV._enVol.shift().couper(); await attendre();
      const c4b = clic(bV, 3);
      test('ÉCHEC DE LECTURE (coupure) : « Livré » REFUSÉ, message clair « réessayez » ; pas de nouvelle lecture avant 3 s (double clic)',
        c4 === 'retenu' && c4b === 'retenu' && bV.dropBloqueLivre('#V4', true) === bV.DROP_MSG_VERIF_ECHEC && /🔒 Pièces non vérifiées[^]*réessayez/.test(bV._toasts[bV._toasts.length - 1][0])
        && bV._toasts[bV._toasts.length - 1][1] === 'err' && lus(bV, '#V4') === 1 && bV._toasts.length > nT, bV._toasts.slice(nT));
      test('… encadré de REFUS sur l\'arrêt, et l\'affichage seul ne relance aucune lecture (jamais une lecture à chaque affichage)',
        /🔒 Pièces non vérifiées/.test(bV.dropLivraisonHtml({}, bV.tournees[0].stops[3], 3)) && bV.dropBloqueLivre('#V4') === bV.DROP_MSG_VERIF_ECHEC && lus(bV, '#V4') === 1 && bV.dropLivreEnAttente('#V4') === false);
      bV.DROP_LU_REESSAI_MS = 0; // 3 s écoulées
      const c4c = clic(bV, 3); await attendre();
      const relance = lus(bV, '#V4') === 2 && bV._enVol.length === 1;
      bV._enVol.shift().repondre({}, 503); await attendre();
      const apres503 = bV.dropBloqueLivre('#V4');
      clic(bV, 3); await attendre();
      bV._enVol.shift().repondre({ ok: true, lecture_seule: true, pieces: [] }); await attendre();
      test('… NOUVEL ESSAI au clic suivant : lecture relancée ; réponse 503 : toujours refusé ; puis lecture réussie (« aucune pièce ») : « Livré » permis',
        c4c === 'retenu' && relance && apres503 === bV.DROP_MSG_VERIF_ECHEC && lus(bV, '#V4') === 3 && bV.dropBloqueLivre('#V4', true) === '' && clic(bV, 3) === 'passe', [c4c, relance, apres503, lus(bV, '#V4')]);
      // une lecture concluante ne vaut que pour le livreur / transporteur lus, et pour une durée limitée
      bV.commandes[1].transporteur = 'GLS';
      const sig1 = bV.dropBloqueLivre('#V2', true); await attendre();
      bV._enVol.shift().repondre({ ok: true, lecture_seule: true, pieces: [] }); await attendre();
      const sig2 = bV.dropBloqueLivre('#V2', true);
      bV.DROP_LU_VALIDE_MS = 0;
      const ttl = bV.dropBloqueLivre('#V2', true); await attendre();
      bV._enVol.shift().repondre({ ok: true, lecture_seule: true, pieces: [] }); await attendre();
      bV.DROP_LU_VALIDE_MS = 300000;
      test('lecture concluante valable pour le livreur / transporteur LUS et pour 5 min : transporteur changé, ou durée dépassée → nouvelle lecture avant « Livré »',
        sig1 === bV.DROP_MSG_VERIF && sig2 === '' && ttl === bV.DROP_MSG_VERIF && bV.dropBloqueLivre('#V2', true) === '' && lus(bV, '#V2') === 3, [sig1, sig2, ttl, lus(bV, '#V2')]);
      // livreur / transporteur changés PENDANT la lecture : la réponse ne vaut pas pour la commande d'après
      const p5 = bV.dropBloqueLivre('#V5', true); await attendre();
      bV.commandes[4].transporteur = 'GLS';
      bV._enVol.shift().repondre({ ok: true, lecture_seule: true, pieces: [] }); await attendre();
      test('commande modifiée PENDANT la lecture (transporteur changé) : réponse non concluante, « Livré » encore retenu', p5 === bV.DROP_MSG_VERIF && bV.dropBloqueLivre('#V5') !== '' && !bV.dropLuConcluante('#V5'));
      // lecture qui ne répond JAMAIS : pas d'attente sans fin — tenue pour un échec après le délai, nouvel essai au clic suivant
      bV.commandes.push({ id: '#V8', transporteur: 'RANOU', livreur: '', statut: 'en-route' });
      const v8a = bV.dropBloqueLivre('#V8', true); await attendre();
      bV.DROP_LU_ATTENTE_MAX_MS = 0; // 20 s écoulées sans réponse
      const v8b = bV.dropBloqueLivre('#V8'), v8att = bV.dropLivreEnAttente('#V8'), v8lus = lus(bV, '#V8');
      const v8c = bV.dropBloqueLivre('#V8', true); await attendre();
      bV.DROP_LU_ATTENTE_MAX_MS = 20000;
      test('lecture SANS réponse (plus de 20 s) : tenue pour un échec (« Livré » refusé, plus d\'attente affichée, aucune lecture relancée par l\'affichage) ; nouvel essai lancé au clic suivant',
        v8a === bV.DROP_MSG_VERIF && v8b === bV.DROP_MSG_VERIF_ECHEC && v8att === false && v8lus === 1 && v8c === bV.DROP_MSG_VERIF && lus(bV, '#V8') === 2, [v8a, v8b, v8att, v8lus, v8c, lus(bV, '#V8')]);
      // commande inconnue de la base : concluant pour le bureau (elle n'a aucune pièce), pas pour un livreur (« pas à lui »)
      const bVa = bacV('admin'), bVl = bacV('livreur');
      for (const b of [bVa, bVl]) { b.commandes = [{ id: '#V6', transporteur: 'GLS', livreur: 'LIVREUR-TEST', statut: 'en-route' }]; b.dropBloqueLivre('#V6', true); }
      await attendre();
      const rendusL = bVl._rendus, attenteL = bVl.dropLivreEnAttente('#V6');
      bVa._enVol.shift().repondre({ ok: false, erreur: 'commande_introuvable' }); bVl._enVol.shift().repondre({ ok: false, erreur: 'commande_introuvable' }); await attendre();
      test('écran du livreur redessiné à la fin de la lecture, même en échec (le bouton quitte l\'attente)', attenteL === true && bVl._rendus > rendusL && bVl.dropLivreEnAttente('#V6') === false);
      test('commande inconnue de la base (« commande_introuvable ») : concluant pour l\'administrateur (aucune pièce possible), NON concluant pour un livreur (refus, à réessayer)',
        bVa.dropBloqueLivre('#V6', true) === '' && bVl.dropBloqueLivre('#V6') === bVl.DROP_MSG_VERIF_ECHEC);
      // commande CONCERNÉE (livreur attribué) : chemin d'avant, jamais cette attente
      bVa.commandes.push({ id: '#V7', transporteur: 'RANOU', livreur: 'LIVREUR-TEST', statut: 'en-route' });
      test('commande CONCERNÉE : contrôle d\'avant inchangé (jamais la lecture sans création, jamais ce message d\'attente)',
        /Pièces pas encore contrôlées/.test(bVa.dropBloqueLivre('#V7', true)) && lus(bVa, '#V7') === 0 && bVa.dropLivreEnAttente('#V7') === false);
      const rendu = extraireFonction('function renderLivreur()');
      test('vue livreur : bouton « Livré » affiché en attente (dropLivreEnAttente) ; setLvSt et validerSig DEMANDENT la lecture (2e argument) et distinguent l\'attente du refus',
        /dropLivreEnAttente\(s\.cmdId\)/.test(rendu) && /Vérification des pièces…/.test(rendu)
        && /dropBloqueLivre\(s\.cmdId, true\)[^\n]*_dropB === DROP_MSG_VERIF\) toast\('⏳ '/.test(extraireFonction('function setLvSt(tid, idx, st, _annOk)'))
        && /dropBloqueLivre\(s\.cmdId, true\)[^\n]*_dropB2 === DROP_MSG_VERIF\) toast\('⏳ '/.test(extraireFonction('function validerSig()')));
    }

    // DÉFAUT 2 : refus définitif de la base → ancien statut remis à l'écran (liste et fiche), raison dite clairement
    const toasts = [], rendus = [];
    const bS = { console: { log() {}, warn() {} }, JSON, Date, String, Array, Object, Math,
      commandes: [], offlineQueue: [], _dedSession: {}, currentCmdId: '#S1', role: 'admin', livNom: '',
      localStorage: { setItem() {}, getItem: () => null }, oqEcrire() { rendus.push('file'); }, reconcilierTournees() { rendus.push('tournees'); },
      renderCmds() { rendus.push('liste'); }, renderDash() {}, renderTournees() {}, renderLivreur() {}, suiviAppliquerFiltres() {},
      closePanel() { rendus.push('fermer'); }, ouvrirCmd(id) { rendus.push('fiche:' + id + ':' + bS.commandes[0].statut); },
      document: { getElementById: (id) => (id === 'cmd-panel' ? { classList: { contains: () => true } } : null) }, toast(m, t) { toasts.push([m, t]); } };
    vm.createContext(bS); vm.runInContext(extraireFonction('function cmdRemettreStatut(c, ancien, refuse, res, arr)'), bS);
    const cS = { id: '#S1', statut: 'livré', historique: [{ de: 'en-attente', vers: 'livré' }] };
    bS.commandes = [cS]; bS.offlineQueue = [{ type: 'deduction', data: { id: '#S1' } }, { type: 'deduction', data: { id: '#S2' } }]; bS._dedSession = { '#S1': true };
    const fait = bS.cmdRemettreStatut(cS, 'en-attente', 'livré', { message: 'PIECES_NON_CONFIRMEES : 1 pièce(s) de la commande #S1 sans confirmation' });
    test('refus définitif du « Livré » : statut remis à « en-attente », historique retiré, refus noté', fait && cS.statut === 'en-attente' && cS.historique.length === 0 && cS._statutRefuse && cS._statutRefuse.vers === 'livré');
    test('… demande de déduction de CETTE commande retirée de la file (les autres gardées)', bS.offlineQueue.length === 1 && bS.offlineQueue[0].data.id === '#S2' && !bS._dedSession['#S1']);
    test('… liste redessinée et fiche ouverte rouverte avec l\'ancien statut', rendus.includes('liste') && rendus.includes('fiche:#S1:en-attente'), rendus);
    test('… message clair : refusé, reste « En attente », rien enregistré, raison de la base', toasts.length === 1 && toasts[0][1] === 'err' && /REFUSÉ par la base/.test(toasts[0][0]) && /reste « En attente »/.test(toasts[0][0]) && /rien n’a été enregistré/.test(toasts[0][0]) && /PIECES_NON_CONFIRMEES/.test(toasts[0][0]), toasts);
    const cS2 = { id: '#S1', statut: 'reporté' };
    test('statut changé entre-temps (plus le statut refusé) : jamais écrasé', bS.cmdRemettreStatut(cS2, 'en-attente', 'livré', {}) === false && cS2.statut === 'reporté');
    // avis chatgpt-review sur 3aba95e, point 1 : journal de la base indisponible sur le chemin tracé → « livré » refusé, raison dite
    const cS3 = { id: '#S3', statut: 'livré', historique: [{ de: 'en-route', vers: 'livré' }] };
    bS.commandes = [cS3]; bS.currentCmdId = '#S3'; toasts.length = 0;
    bS.cmdRemettreStatut(cS3, 'en-route', 'livré', { message: 'TRACE_IMPOSSIBLE : journal indisponible, réessayez ; rien n\'a été enregistré' });
    test('refus « TRACE_IMPOSSIBLE » de la base (trace obligatoire du choix B) : statut remis, message de la base affiché tel quel (« journal indisponible, réessayez ; rien n\'a été enregistré »)',
      cS3.statut === 'en-route' && toasts.length === 1 && /TRACE_IMPOSSIBLE : journal indisponible, réessayez ; rien n'a été enregistré/.test(toasts[0][0]) && /reste « En route »/.test(toasts[0][0]), toasts);
    const chg = extraireFonction('function chgStatut(id, st, _annOk)');
    test('chgStatut : refus définitif → génération vérifiée (statutEssaiRegler) PUIS cmdRemettreStatut, AVANT la demande de déduction (même promesse)',
      /var _pSc = Promise\.resolve\(sbSaveCommande\(c\)\)\.then\(function\(res\) \{\n\s*var _refus = !!\(res && res\.ok === false && res\.definitif\);\n\s*var _rem = statutEssaiRegler\(id, _essai, _refus\);\n\s*if \(_refus && _rem\) \{ try \{ cmdRemettreStatut\(c, _rem\.de, st, res, _rem\.arr\);/.test(chg)
      && chg.indexOf('cmdRemettreStatut') < chg.indexOf('stkDemanderDeduction(c, _pSc)') && !/cmdRemettreStatut\(c, ancienStatut/.test(chg));
    test('stkDemanderDeduction : « livré » refusé et remis → aucune déduction demandée', /if \(cmd\._statutRefuse && !\(cmd\.statut === 'livré' \|\| cmd\.statut === 'livre'\)\) return 'abandon';/.test(extraireFonction('function stkDemanderDeduction(cmd, pAvant)')));
    test('fiche : refus affiché dans l\'en-tête ; succès suivant : refus effacé', /cmd-statut-refuse/.test(extraireFonction('function ouvrirCmd(id)')) && /delete cmd\._syncRefus; delete cmd\._statutRefuse;/.test(extraireFonction('async function sbSaveCommande(cmd, oqCtx)')));
    // revue native P2 sur df07c0d : « livré » refusé par la base → l'ARRÊT de tournée (marqué « livré » et enregistré par la
    // synchronisation AVANT la réponse) revient à son état d'avant et est RÉENREGISTRÉ. Vrai code de chgStatut,
    // reconcilierTournees, cmdRemettreStatut, arrets*, statutEssai* et de la FILE PAR TOURNÉE (sbSaveTournee, tourneeFilePartir) ;
    // seul l'envoi lui-même (sbEnvoyerTournee) et l'enregistrement de la commande (sbSaveCommande) sont remplacés par des faux.
    {
      const bacArret = (reponse) => {
        const b = { console: { log() {}, warn() {} }, JSON, Date, String, Array, Object, Math, Promise,
          commandes: [], tournees: [], offlineQueue: [], _dedSession: {}, currentCmdId: null, role: 'admin', livNom: '', _sauvT: [], _toasts: [],
          localStorage: { setItem() {}, getItem: () => null }, oqEcrire() {}, renderCmds() {}, renderDash() {}, renderTournees() {}, renderLivreur() {},
          suiviAppliquerFiltres() {}, closePanel() {}, ouvrirCmd() {}, toast(m, t) { b._toasts.push([m, t]); },
          document: { getElementById: () => null },
          stkDeductionPoser(c) { if (!b.offlineQueue.some((q) => q.type === 'deduction' && q.data.id === c.id)) b.offlineQueue.push({ type: 'deduction', data: { id: c.id } }); b._dedSession[c.id] = true; },
          stkDemanderDeduction() {}, stkReCrediterStock() {},
          annDemanderMotif(c, f) { f({ motif: 'essai', commentaire: '' }); },
          cmdEligibleTournee: (c) => !!(c && c.date && c.statut !== 'annulé' && c.statut !== 'livré'), nextTourneeId: () => 'T-NEUVE', paiModeStop: () => 'Espèces',
          _minuteurs: [], setTimeout(f, ms) { b._minuteurs.push({ f, ms }); return b._minuteurs.length; }, _retourT: null, _retourC: null, _enVol: 0, _maxEnVol: 0,
          // faux ENVOI d'une tournée : note ce qui part (copie), compte les envois en vol en même temps
          sbEnvoyerTournee(t) {
            const copie = JSON.parse(JSON.stringify(t)); b._sauvT.push(copie);
            b._enVol++; b._maxEnVol = Math.max(b._maxEnVol, b._enVol);
            const fin = () => { b._enVol--; };
            const r = Promise.resolve(b._retourT ? b._retourT(b._sauvT.length, copie) : undefined);
            r.then(fin, fin);
            return r;
          },
          sbSaveCommande: () => (b._retourC ? b._retourC() : Promise.resolve(reponse())) };
        vm.createContext(b);
        vm.runInContext(['var _tourneeFile = {};', extraireFonction('function sbSaveTournee(t, avant)'), extraireFonction('function tourneeFilePartir(tid, f, demandes)'),
          'var _arretsGen = {};', 'var _statutEssais = {};', extraireFonction('function arretsRelever(cmdId)'), extraireFonction('function statutEssaiPoser(id, de, vers, gen, arr)'),
          extraireFonction('function statutEssaiRegler(id, essai, refuse)'), extraireFonction('function arretsAppliquer(m, cmdId, seulementTid)'), extraireFonction('function arretsRemettre(cmdId, refuse, m)'),
          extraireFonction('function cmdRemettreStatut(c, ancien, refuse, res, arr)'), extraireFonction('function reconcilierTournees()'), extraireFonction('function chgStatut(id, st, _annOk)')].join('\n'), b);
        return b;
      };
      const ARRET = (o) => Object.assign({ num: 2, cmdId: '#A1', client: 'Client essai', tel: '', adresse: '', etage: '', asc: 'Non', code: '', produit: 'Matelas', prix: 100, paie: 'Espèces', instr: '', statut: 'en-route', heure: '10:15', heureStatut: '2026-11-27T09:15:00.000Z' }, o || {});
      const CMD = (o) => Object.assign({ id: '#A1', statut: 'en-attente', date: '2026-11-27', transporteur: 'RANOU', produit: 'Matelas', prix: 100 }, o || {});
      const attendre = () => new Promise((r) => setTimeout(r, 5));
      const REFUS = { ok: false, definitif: true, message: 'PIECES_NON_CONFIRMEES' };
      const TOURNEE = (stops) => ({ id: 'T-1', date: '2026-11-27', livreur: 'RANOU', statut: 'en-cours', stops });
      const statuts = (b) => b._sauvT.map((t) => t.stops[0].statut).join(',');
      // 1) « livré » refusé
      let bA = bacArret(() => REFUS);
      bA.commandes = [CMD(), CMD({ id: '#A0' })];
      bA.tournees = [TOURNEE([ARRET({ num: 1, cmdId: '#A0', statut: 'en-attente', heure: '' }), ARRET()])];
      const avantA = JSON.stringify(bA.tournees);
      bA.chgStatut('#A1', 'livré');
      test('arrêt : la synchronisation marque l\'arrêt « livré » et l\'enregistre AVANT la réponse de la base (le défaut signalé)',
        bA.tournees[0].stops[1].statut === 'livré' && bA._sauvT.length === 1 && bA._sauvT[0].stops[1].statut === 'livré', bA._sauvT);
      await attendre();
      test('arrêt : « livré » REFUSÉ par la base → commande remise « en-attente » ET arrêt revenu à son état d\'avant (statut, heure, heureStatut, tous les champs)',
        bA.commandes[0].statut === 'en-attente' && JSON.stringify(bA.tournees) === avantA, bA.tournees[0].stops[1]);
      test('arrêt : … et la tournée est RÉENREGISTRÉE avec l\'arrêt remis (dernier enregistrement = état d\'avant, plus aucun « livré »)',
        bA._sauvT.length === 2 && JSON.stringify([bA._sauvT[1]]) === avantA && !bA._sauvT[1].stops.some((s) => s.statut === 'livré'), bA._sauvT);
      bA.reconcilierTournees(); await attendre();
      test('arrêt : … essai oublié, file de la tournée vide, et une synchronisation normale ensuite ne change plus rien',
        !bA._statutEssais['#A1'] && !bA._tourneeFile['T-1'] && bA._sauvT.length === 2 && JSON.stringify(bA.tournees) === avantA);
      // 2) changement fait entre-temps sur l'arrêt : jamais écrasé ; seul le champ posé par la synchronisation est remis
      bA = bacArret(() => REFUS);
      bA.commandes = [CMD()]; bA.tournees = [TOURNEE([ARRET()])];
      bA.chgStatut('#A1', 'livré');
      bA.tournees[0].stops[0].paie = 'CB'; // ex. relève : mode de paiement changé pendant l'attente
      await attendre();
      test('arrêt : champ changé entre-temps gardé, statut remis', bA.tournees[0].stops[0].statut === 'en-route' && bA.tournees[0].stops[0].paie === 'CB' && bA._sauvT[bA._sauvT.length - 1].stops[0].paie === 'CB');
      // 3) tournées rechargées depuis la base pendant l'attente (autres objets, arrêt « livré » enregistré) : remis quand même
      bA = bacArret(() => REFUS);
      bA.commandes = [CMD()]; bA.tournees = [TOURNEE([ARRET()])];
      bA.chgStatut('#A1', 'livré');
      bA.tournees = JSON.parse(JSON.stringify([bA._sauvT[0]]));
      await attendre();
      test('arrêt : tournées rechargées pendant l\'attente → l\'arrêt « livré » relu est remis et réenregistré',
        bA.tournees[0].stops[0].statut === 'en-route' && bA._sauvT.length === 2 && bA._sauvT[1].stops[0].statut === 'en-route', bA._sauvT);
      // 4) « livré » ACCEPTÉ : l'arrêt reste « livré », rien n'est défait, essai oublié
      bA = bacArret(() => ({ ok: true }));
      bA.commandes = [CMD()]; bA.tournees = [TOURNEE([ARRET()])];
      bA.chgStatut('#A1', 'livré'); await attendre();
      test('arrêt : « livré » accepté → arrêt « livré » gardé, un seul enregistrement, essai oublié',
        bA.commandes[0].statut === 'livré' && bA.tournees[0].stops[0].statut === 'livré' && bA._sauvT.length === 1 && !bA._statutEssais['#A1']);
      // 5) échec NON définitif (coupure : la commande part en file) : rien n'est défait
      bA = bacArret(() => ({ ok: false, definitif: false }));
      bA.commandes = [CMD()]; bA.tournees = [TOURNEE([ARRET()])];
      bA.chgStatut('#A1', 'livré'); await attendre();
      test('arrêt : échec non définitif → commande et arrêt restent « livré »', bA.commandes[0].statut === 'livré' && bA.tournees[0].stops[0].statut === 'livré' && bA._sauvT.length === 1);
      // 6) « annulé » refusé : la synchronisation avait RETIRÉ l'arrêt → replacé à son rang, tel quel, et réenregistré
      bA = bacArret(() => REFUS);
      bA.commandes = [CMD({ id: '#A0' }), CMD(), CMD({ id: '#A2' })];
      bA.tournees = [TOURNEE([ARRET({ num: 1, cmdId: '#A0' }), ARRET(), ARRET({ num: 3, cmdId: '#A2' })])];
      const avantAnn = JSON.stringify(bA.tournees);
      bA.chgStatut('#A1', 'annulé');
      const retire = bA.tournees[0].stops.length === 2;
      await attendre();
      test('arrêt : « annulé » refusé → arrêt retiré puis replacé à son rang, identique, tournée réenregistrée, sans doublon',
        retire && bA.commandes[1].statut === 'en-attente' && JSON.stringify(bA.tournees) === avantAnn && JSON.stringify([bA._sauvT[bA._sauvT.length - 1]]) === avantAnn, bA.tournees);
      // 7) deux changements coup sur coup : le refus du premier ne touche pas l'arrêt du second
      const reps = [REFUS, { ok: true }];
      bA = bacArret(() => reps.shift());
      bA.commandes = [CMD()]; bA.tournees = [TOURNEE([ARRET()])];
      bA.chgStatut('#A1', 'arrivé'); bA.chgStatut('#A1', 'livré'); await attendre();
      test('arrêt : refus d\'un premier changement déjà remplacé → le « livré » suivant (accepté) garde son arrêt « livré »',
        bA.commandes[0].statut === 'livré' && bA.tournees[0].stops[0].statut === 'livré');
      // 8) avis chatgpt-review sur 3b46387, point 1 : ORDRE des enregistrements — la remise n'est réenregistrée qu'APRÈS la fin du
      //    premier enregistrement de la tournée (arrêt « livré »), jamais avant (la base pourrait les recevoir dans l'ordre inverse)
      for (const issue of ['réussi', 'en échec']) {
        let finir = null, rejeter = null;
        bA = bacArret(() => REFUS);
        bA._retourT = (n) => (n === 1 ? new Promise((ok, ko) => { finir = ok; rejeter = ko; }) : undefined);
        bA.commandes = [CMD()]; bA.tournees = [TOURNEE([ARRET()])];
        bA.chgStatut('#A1', 'livré'); await attendre();
        test('ordre (1er enregistrement ' + issue + ') : refus reçu AVANT la fin du 1er enregistrement → arrêt remis à l\'écran tout de suite, mais PAS encore réenregistré',
          bA.commandes[0].statut === 'en-attente' && bA.tournees[0].stops[0].statut === 'en-route' && bA._sauvT.length === 1 && bA._sauvT[0].stops[0].statut === 'livré', bA._sauvT.length);
        if (issue === 'réussi') finir(); else rejeter(new Error('503'));
        await attendre();
        test('ordre (1er enregistrement ' + issue + ') : une fois le 1er enregistrement terminé → tournée réenregistrée avec l\'arrêt remis (dernier envoi)',
          bA._sauvT.length === 2 && bA._sauvT[1].stops[0].statut === 'en-route', statuts(bA));
        test('ordre (1er enregistrement ' + issue + ') : jamais deux envois en vol, aucun délai de garde, rien renvoyé une 2e fois', bA._maxEnVol === 1 && bA._minuteurs.length === 0 && bA._sauvT.length === 2);
      }
      {
        // tournées relues depuis la base PENDANT l'attente (arrêt « livré » relu) : la remise est refaite juste avant l'envoi
        let finir = null;
        bA = bacArret(() => REFUS);
        bA._retourT = (n) => (n === 1 ? new Promise((ok) => { finir = ok; }) : undefined);
        bA.commandes = [CMD()]; bA.tournees = [TOURNEE([ARRET()])];
        bA.chgStatut('#A1', 'livré'); await attendre();
        bA.tournees = JSON.parse(JSON.stringify([bA._sauvT[0]])); // relève : la base rend encore l'arrêt « livré »
        finir(); await attendre();
        test('ordre : tournées relues pendant l\'attente (arrêt « livré ») → remise refaite, réenregistrée « en-route »',
          bA.tournees[0].stops[0].statut === 'en-route' && bA._sauvT.length === 2 && bA._sauvT[1].stops[0].statut === 'en-route', statuts(bA));
        // AVIS chatgpt-review SUR 3aba95e, point 3 : FILE PAR TOURNÉE — un seul enregistrement en vol, le dernier état gagne.
        // Avant : remise envoyée au délai de garde (30 s), puis RENVOYÉE à la fin du 1er envoi sans attendre la fin de la première
        // remise → deux remises en vol, reçues dans n'importe quel ordre. « Base » d'essai : elle garde le DERNIER envoi REÇU ;
        // les réponses sont rendues dans l'ordre INVERSE des départs (la plus récente d'abord) chaque fois que c'est possible.
        const baseInverse = (b) => {
          const o = { recu: null, enCours: [], recus: [] };
          b._retourT = (n, copie) => new Promise((ok) => { o.enCours.push({ n, copie, ok }); });
          o.repondre = async () => { // la réponse du départ le PLUS RÉCENT d'abord
            let tours = 0;
            while (o.enCours.length && tours++ < 20) { const e = o.enCours.pop(); o.recu = e.copie; o.recus.push(e.copie.stops[0].statut + (e.copie.stops[0].paie === 'CB' ? '+CB' : '')); e.ok(); await attendre(); }
          };
          return o;
        };
        bA = bacArret(() => REFUS);
        let base = baseInverse(bA);
        bA.commandes = [CMD()]; bA.tournees = [TOURNEE([ARRET()])];
        bA.chgStatut('#A1', 'livré'); await attendre();
        const enVolAuRefus = base.enCours.length, envoisAuRefus = bA._sauvT.length;
        bA._minuteurs.forEach((m) => m.f()); await attendre(); // (plus aucun délai de garde : rien ne part)
        const apresDelai = bA._sauvT.length;
        await base.repondre();
        test('FILE (point 3), « livré » refusé pendant le 1er envoi de la tournée : la remise ATTEND (1 seul envoi en vol, rien au « délai de garde »), puis part seule',
          enVolAuRefus === 1 && envoisAuRefus === 1 && apresDelai === 1 && bA._minuteurs.length === 0 && bA._maxEnVol === 1 && bA._sauvT.length === 2, [enVolAuRefus, apresDelai, statuts(bA)]);
        test('FILE (point 3), RÉPONSES RENDUES DANS L\'ORDRE INVERSE : impossible de croiser deux envois — la base reçoit « livré » puis « en-route », son dernier état est l\'arrêt REMIS',
          base.recus.join() === 'livré,en-route' && base.recu.stops[0].statut === 'en-route' && bA.tournees[0].stops[0].statut === 'en-route' && bA.commandes[0].statut === 'en-attente', base.recus);
        // plusieurs demandes pendant un envoi (remise + autres enregistrements de la même tournée) : UNE seule suite, dernier état
        bA = bacArret(() => REFUS);
        base = baseInverse(bA);
        bA.commandes = [CMD()]; bA.tournees = [TOURNEE([ARRET()])];
        bA.chgStatut('#A1', 'livré'); await attendre();            // 1er envoi en vol (« livré »), refus reçu, remise en attente
        bA.tournees[0].stops[0].instr = 'sonner 2 fois'; const pB = bA.sbSaveTournee(bA.tournees[0]);   // autre enregistrement (vue livreur, relève…)
        bA.tournees[0].stops[0].paie = 'CB'; const pC = bA.sbSaveTournee(bA.tournees[0]);               // et encore un
        await attendre();
        const pendantVol = bA._sauvT.length;
        await base.repondre();
        test('FILE (point 3), trois demandes pendant un envoi : regroupées en UN seul envoi, parti après la réponse du premier, qui porte le DERNIER état (arrêt remis + dernières modifications)',
          pendantVol === 1 && bA._sauvT.length === 2 && bA._maxEnVol === 1 && base.recus.join() === 'livré,en-route+CB' && base.recu.stops[0].instr === 'sonner 2 fois' && pB === pC, [pendantVol, base.recus]);
        // enchaînement : remise en vol, puis « Livré » accepté au 2e essai → son enregistrement attend la remise ; dernier état = « livré »
        const repsF = [REFUS, { ok: true }];
        bA = bacArret(() => repsF.shift());
        base = baseInverse(bA);
        bA.commandes = [CMD()]; bA.tournees = [TOURNEE([ARRET()])];
        bA.chgStatut('#A1', 'livré'); await attendre();            // envoi 1 (« livré ») en vol, refus, remise en attente
        base.enCours.pop().ok(); await attendre();                 // envoi 1 terminé → la remise part (envoi 2, en vol)
        const remiseEnVol = bA._sauvT.length === 2 && bA._sauvT[1].stops[0].statut === 'en-route' && bA._enVol === 1;
        bA.chgStatut('#A1', 'livré'); await attendre();            // 2e essai ACCEPTÉ pendant que la remise est en vol
        const attendLaRemise = bA._sauvT.length === 2;
        await base.repondre();
        test('FILE (point 3), « Livré » accepté pendant que la remise est en vol : son enregistrement ATTEND la réponse de la remise, puis part — dernier état reçu par la base : « livré »',
          remiseEnVol && attendLaRemise && bA._maxEnVol === 1 && statuts(bA) === 'livré,en-route,livré' && bA.commandes[0].statut === 'livré' && bA.tournees[0].stops[0].statut === 'livré', statuts(bA));
        // un envoi sans réponse retient les suivants (rien en parallèle) ; les AUTRES tournées ne sont pas retenues
        bA = bacArret(() => REFUS);
        bA._retourT = (n, copie) => (copie.id === 'T-1' && n === 1 ? new Promise(() => {}) : 'envoi ' + n);
        bA.commandes = [CMD()]; bA.tournees = [TOURNEE([ARRET()]), { id: 'T-2', date: '2026-11-27', livreur: 'RANOU', statut: 'en-cours', stops: [ARRET({ cmdId: '#B1' })] }];
        bA.chgStatut('#A1', 'livré'); await attendre();
        bA._minuteurs.forEach((m) => m.f());
        const rT2 = await bA.sbSaveTournee(bA.tournees[1]);
        test('FILE (point 3), 1er envoi SANS réponse : la remise est faite à l\'écran et attend (jamais d\'envoi en parallèle, plus de délai de garde) ; une AUTRE tournée s\'enregistre sans attendre',
          bA.tournees[0].stops[0].statut === 'en-route' && bA._sauvT.filter((t) => t.id === 'T-1').length === 1 && bA._minuteurs.length === 0 && rT2 === 'envoi 2' && bA._sauvT[1].id === 'T-2', bA._sauvT.map((t) => t.id));
        // résultat rendu aux appelants : celui de l'envoi qui a porté leur demande ; tournée sans identifiant : envoi direct
        bA = bacArret(() => ({ ok: true }));
        let finir1 = null;
        bA._retourT = (n) => (n === 1 ? new Promise((ok) => { finir1 = ok; }) : { refuse: n });
        const tF = TOURNEE([ARRET()]);
        const p1 = bA.sbSaveTournee(tF), p2 = bA.sbSaveTournee(tF), p3 = bA.sbSaveTournee(tF);
        finir1('premier'); const [r1, r2, r3] = await Promise.all([p1, p2, p3]); await attendre();
        test('FILE : chaque appelant reçoit le résultat de l\'envoi qui a porté sa demande ; la file se vide ; tournée sans identifiant envoyée telle quelle',
          r1 === 'premier' && r2 && r2.refuse === 2 && r3 === r2 && bA._sauvT.length === 2 && !bA._tourneeFile['T-1'] && (bA.sbSaveTournee({ stops: [] }), bA._sauvT.length === 3));
        const fSave = extraireFonction('function sbSaveTournee(t, avant)'), fEnv = extraireFonction('async function sbEnvoyerTournee(t)');
        test('code : sbSaveTournee ne fait plus AUCUN envoi lui-même (file), l\'envoi réel est sbEnvoyerTournee (hors ligne → file d\'attente, comme avant) ; plus aucun délai de garde dans la remise',
          !/fetch\(/.test(fSave) && /tourneeFilePartir\(tid, f, \[demande\]\)/.test(fSave) && /offlineQueueAdd\('tournee', t\)/.test(fEnv) && /\/rest\/v1\/tournees/.test(fEnv)
          && !/setTimeout|ARRETS_ATTENTE_MAX|arretsNoterEnvoi/.test(extraireFonction('function arretsRemettre(cmdId, refuse, m)')) && !/ARRETS_ATTENTE_MAX|arretsNoterEnvoi|_arretsEnvois/.test(html));

        // revue native P2 sur 358825d : refus, remise différée (1er enregistrement de la tournée encore en cours), puis « Livré »
        // RÉUSSI au 2e essai avant la fin de ce 1er enregistrement → la remise différée est abandonnée (génération)
        {
          let finir = null; const reps2 = [REFUS, { ok: true }];
          bA = bacArret(() => reps2.shift());
          bA._retourT = (n) => (n === 1 ? new Promise((ok) => { finir = ok; }) : undefined);
          bA.commandes = [CMD()]; bA.tournees = [TOURNEE([ARRET()])];
          bA.chgStatut('#A1', 'livré'); await attendre();
          const remisEcran = bA.commandes[0].statut === 'en-attente' && bA.tournees[0].stops[0].statut === 'en-route' && bA._sauvT.length === 1;
          bA.chgStatut('#A1', 'livré'); await attendre(); // l'utilisateur a corrigé : 2e essai ACCEPTÉ
          const apres2 = bA._sauvT.length;
          finir(); await attendre();
          test('génération : refus, puis « Livré » RÉUSSI pendant l\'attente → la remise en attente du 1er essai est ABANDONNÉE (commande « livré », arrêt « livré », aucun enregistrement « en-route »)',
            remisEcran && apres2 === 1 && bA.commandes[0].statut === 'livré' && bA.tournees[0].stops[0].statut === 'livré' && bA._sauvT.length === 2
            && bA._sauvT[1].stops[0].statut === 'livré' && !bA._sauvT.some((t, i) => i > 0 && t.stops[0].statut === 'en-route') && bA._maxEnVol === 1, statuts(bA));
          // même séquence, mais le 2e « Livré » passe par un AUTRE chemin que chgStatut (statut remis directement) : abandonnée aussi
          bA = bacArret(() => REFUS);
          bA._retourT = (n) => (n === 1 ? new Promise((ok) => { finir = ok; }) : undefined);
          bA.commandes = [CMD()]; bA.tournees = [TOURNEE([ARRET()])];
          bA.chgStatut('#A1', 'livré'); await attendre();
          bA.commandes[0].statut = 'livré'; bA.tournees[0].stops[0].statut = 'livré';
          finir(); await attendre();
          test('génération : commande de nouveau « livré » par un autre chemin pendant l\'attente → remise en attente abandonnée, arrêt « livré » gardé',
            bA.tournees[0].stops[0].statut === 'livré' && bA._sauvT.length === 1, statuts(bA));
          // 2e essai lui aussi REFUSÉ : sa propre remise est faite (arrêt « en-route », réenregistré une fois le 1er envoi terminé)
          const reps3 = [REFUS, REFUS];
          bA = bacArret(() => reps3.shift());
          bA._retourT = (n) => (n === 1 ? new Promise((ok) => { finir = ok; }) : undefined);
          bA.commandes = [CMD()]; bA.tournees = [TOURNEE([ARRET()])];
          bA.chgStatut('#A1', 'livré'); await attendre();
          bA.chgStatut('#A1', 'livré'); await attendre();
          finir(); await attendre();
          test('génération : 2e essai REFUSÉ lui aussi → commande « en-attente », arrêt « en-route » à l\'écran et dans le dernier enregistrement',
            bA.commandes[0].statut === 'en-attente' && bA.tournees[0].stops[0].statut === 'en-route' && bA._sauvT[bA._sauvT.length - 1].stops[0].statut === 'en-route', statuts(bA));
        }
        test('chgStatut : numéro de génération posé à chaque changement ; arretsRemettre le vérifie au départ de la remise en attente',
          /_arretsGen\[id\] = \(_arretsGen\[id\] \|\| 0\) \+ 1;\n\s*var _gen = _arretsGen\[id\];/.test(extraireFonction('function chgStatut(id, st, _annOk)'))
          && /var genRemise = _arretsGen\[cmdId\];/.test(extraireFonction('function arretsRemettre(cmdId, refuse, m)'))
          && /if \(_arretsGen\[cmdId\] !== genRemise\) return true;/.test(extraireFonction('function arretsRemettre(cmdId, refuse, m)'))
          && /if \(perimee\(\)\) return null;/.test(extraireFonction('function arretsRemettre(cmdId, refuse, m)')));
        test('reconcilierTournees : chaque enregistrement de tournée passe par la file (sbSaveTournee), sans envoi direct',
          /ids\.forEach\(function\(id\)\{ try \{ sbSaveTournee\(aSauver\[id\]\); \} catch\(_e\)\{\} \}\);/.test(extraireFonction('function reconcilierTournees()')) && !/sbEnvoyerTournee/.test(extraireFonction('function reconcilierTournees()')));
      }

      // REVUE NATIVE P2 SUR 3aba95e (maxiconfort-v7.html, rappel de l'enregistrement de la commande dans chgStatut) : deux essais
      // qui se CHEVAUCHENT, réponses dans n'importe quel ordre. Réponses de la base tenues en main (_retourC).
      {
        const essais = (b) => { const l = []; b._retourC = () => new Promise((ok) => l.push(ok)); return l; };
        const ded = (b) => b.offlineQueue.some((q) => q.type === 'deduction' && q.data.id === '#A1') && b._dedSession['#A1'] === true;
        // a) la séquence signalée : SUCCÈS de l'essai RÉCENT, puis REFUS de l'essai ANCIEN
        bA = bacArret(() => REFUS);
        let rs = essais(bA);
        bA.commandes = [CMD()]; bA.tournees = [TOURNEE([ARRET()])];
        bA.chgStatut('#A1', 'livré');            // essai 1 (ancien), sans réponse
        bA.chgStatut('#A1', 'livré');            // essai 2 (récent), sans réponse
        rs[1]({ ok: true }); await attendre();   // le plus récent RÉUSSIT
        const apresSucces = bA.commandes[0].statut;
        const nToasts = bA._toasts.length, nSauv = bA._sauvT.length;
        rs[0](REFUS); await attendre();          // puis le refus de l'ancien arrive
        test('P2 — SUCCÈS RÉCENT puis REFUS ANCIEN : rien n\'est remis — la commande reste « livré » (avant : remise à « en-attente »), l\'arrêt reste « livré »',
          apresSucces === 'livré' && bA.commandes[0].statut === 'livré' && bA.tournees[0].stops[0].statut === 'livré' && !bA.commandes[0]._statutRefuse, [bA.commandes[0].statut, bA.tournees[0].stops[0].statut]);
        test('P2 — … la demande de déduction du stock en attente est GARDÉE (avant : retirée), aucun message « REFUSÉ », la tournée n\'est pas réenregistrée ; historique : une seule ligne « … → livré », celle de l\'essai accepté (celle de l\'essai refusé est retirée)',
          ded(bA) && bA._toasts.length === nToasts && !bA._toasts.some((t) => /REFUSÉ par la base/.test(t[0])) && bA._sauvT.length === nSauv && !bA._sauvT.some((t) => t.stops[0].statut === 'en-route')
          && bA.commandes[0].historique.length === 1 && bA.commandes[0].historique[0].vers === 'livré' && !bA._statutEssais['#A1'], [bA.offlineQueue, bA._toasts, bA.commandes[0].historique]);
        // b) les deux essais REFUSÉS, l'ancien d'abord : la commande ne reste pas sur un statut refusé
        for (const ordre of [[0, 1], [1, 0]]) {
          bA = bacArret(() => REFUS);
          rs = essais(bA);
          bA.commandes = [CMD()]; bA.tournees = [TOURNEE([ARRET()])];
          bA.chgStatut('#A1', 'livré'); bA.chgStatut('#A1', 'livré');
          rs[ordre[0]](REFUS); await attendre();
          const entreDeux = bA.commandes[0].statut;
          rs[ordre[1]](REFUS); await attendre();
          test('P2 — deux essais « Livré » chevauchés, TOUS DEUX REFUSÉS (réponse de l\'essai ' + (ordre[0] + 1) + ' d\'abord) : commande remise « en-attente », arrêt remis « en-route » et réenregistré, déduction retirée',
            bA.commandes[0].statut === 'en-attente' && bA.tournees[0].stops[0].statut === 'en-route' && bA._sauvT[bA._sauvT.length - 1].stops[0].statut === 'en-route' && !ded(bA)
            && !bA.offlineQueue.length && !bA._statutEssais['#A1'] && bA.commandes[0].historique.length === 0, [entreDeux, bA.commandes[0].statut, statuts(bA), bA.commandes[0].historique]);
        }
        // c) essai récent REFUSÉ alors que l'ancien (autre statut) est encore sans réponse : retour au statut de l'ancien ; si
        //    l'ancien est refusé à son tour, retour au statut d'avant — jamais un statut que la base a refusé
        for (const fin of ['accepté', 'refusé']) {
          bA = bacArret(() => REFUS);
          rs = essais(bA);
          bA.commandes = [CMD()]; bA.tournees = [TOURNEE([ARRET({ statut: 'en-attente', heure: '' })])];
          bA.chgStatut('#A1', 'arrivé');           // essai 1, sans réponse
          bA.chgStatut('#A1', 'livré');            // essai 2, sans réponse
          rs[1](REFUS); await attendre();          // le récent est refusé d'abord
          const apresRecent = bA.commandes[0].statut;
          rs[0](fin === 'accepté' ? { ok: true } : REFUS); await attendre();
          test('P2 — récent REFUSÉ d\'abord, ancien (« arrivé ») ' + fin + ' ensuite : la commande revient à « arrivé », puis ' + (fin === 'accepté' ? 'y reste' : 'à « en-attente » (jamais un statut refusé)'),
            apresRecent === 'arrivé' && bA.commandes[0].statut === (fin === 'accepté' ? 'arrivé' : 'en-attente') && bA.tournees[0].stops[0].statut !== 'livré' && !ded(bA) && !bA._statutEssais['#A1'],
            [apresRecent, bA.commandes[0].statut, bA.tournees[0].stops[0].statut]);
        }
        // d) ancien REFUSÉ d'abord (pas la génération courante : rien n'est remis), récent refusé ensuite : retour au statut d'AVANT l'ancien
        bA = bacArret(() => REFUS);
        rs = essais(bA);
        bA.commandes = [CMD()]; bA.tournees = [TOURNEE([ARRET({ statut: 'en-attente', heure: '' })])];
        bA.chgStatut('#A1', 'arrivé'); bA.chgStatut('#A1', 'livré');
        rs[0](REFUS); await attendre();
        const apresAncien = bA.commandes[0].statut, toastsAncien = bA._toasts.filter((t) => /REFUSÉ par la base/.test(t[0])).length;
        rs[1](REFUS); await attendre();
        test('P2 — ancien (« arrivé ») REFUSÉ d\'abord : rien n\'est remis tant que le récent est sans réponse ; récent refusé ensuite : retour à « en-attente », pas à « arrivé » (refusé)',
          apresAncien === 'livré' && toastsAncien === 0 && bA.commandes[0].statut === 'en-attente' && bA.tournees[0].stops[0].statut === 'en-attente' && !ded(bA), [apresAncien, bA.commandes[0].statut, bA.tournees[0].stops[0]]);
        // e) fonctions pures : génération courante (tête), essai dépassé, remise en chaîne
        const pur = bacArret(() => REFUS);
        const e1 = pur.statutEssaiPoser('#P', 'en-attente', 'livré', 1, null), e2 = pur.statutEssaiPoser('#P', 'livré', 'livré', 2, null);
        const rOk2 = pur.statutEssaiRegler('#P', e2, false), rRef1 = pur.statutEssaiRegler('#P', e1, true);
        const e3 = pur.statutEssaiPoser('#P', 'en-attente', 'livré', 3, null);
        const rRef3 = pur.statutEssaiRegler('#P', e3, true), rDouble = pur.statutEssaiRegler('#P', e3, true);
        test('statutEssaiRegler : essai dépassé par un plus récent → null (rien à remettre) ; essai de la génération courante refusé → { de } ; une réponse ne compte qu\'une fois',
          rOk2 === null && rRef1 === null && rRef3 && rRef3.de === 'en-attente' && rDouble === null && !pur._statutEssais['#P'], [rOk2, rRef1, rRef3, rDouble]);
      }
      const fRem = extraireFonction('function cmdRemettreStatut(c, ancien, refuse, res, arr)');
      test('cmdRemettreStatut : l\'arrêt est remis AVANT la synchronisation normale, avec le relevé de l\'essai refusé',
        fRem.indexOf('arretsRemettre(c.id, refuse, arr)') > 0 && fRem.indexOf('arretsRemettre(c.id, refuse, arr)') < fRem.indexOf('reconcilierTournees()'));
    }
    // REVUE NATIVE P2 SUR 3aba95e, même famille : RÉPONSES DE L'ENREGISTREMENT D'UNE COMMANDE DANS LE DÉSORDRE (vrai code de
    // sbSaveCommande) — le refus d'un envoi plus ancien qu'un succès déjà reçu ne marque plus la commande « refusée »
    {
      const bacC = () => {
        const b = { console: { log() {}, warn() {} }, JSON, Date, String, Array, Object, Math, Number, parseInt, Promise,
          SUPABASE_URL: 'https://exemple.invalid', SUPABASE_KEY: 'cle-de-test', commandes: [], _toasts: [], _notifs: [], _file: [], _vol: [],
          localStorage: { setItem() {}, getItem: () => null }, paiVerrouBody() {}, showSync() {}, toast(m, t) { b._toasts.push([m, t]); }, notifAjout(...a) { b._notifs.push(a); },
          offlineQueueAdd(type, d) { b._file.push([type, d.id]); }, oqSucces() {},
          fetch: () => new Promise((ok) => b._vol.push((status, json) => ok({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json || {}) }))) };
        vm.createContext(b);
        vm.runInContext(extraireFonction('function syncRefusDefinitif(status)') + '\n' + extraireFonction('function syncMessageRefus(status, texte)') + '\n' + extraireFonction('async function sbSaveCommande(cmd, oqCtx)'), b);
        return b;
      };
      const MSG = 'TRACE_IMPOSSIBLE : journal indisponible, réessayez ; rien n\'a été enregistré';
      let bC = bacC(); let c = { id: '#C1', statut: 'livré' };
      let pA = bC.sbSaveCommande(c), pB = bC.sbSaveCommande(c); await attendre();
      bC._vol[1](201); const rB = await pB;
      bC._vol[0](400, { code: 'P0001', message: MSG }); const rA = await pA;
      test('sbSaveCommande — succès RÉCENT puis refus ANCIEN : le refus dépassé ne marque pas la commande (ni « refusée », ni message, ni notification) ; il reste signalé à l\'appelant (définitif, dépassé)',
        rB.ok === true && rA.ok === false && rA.definitif === true && rA.depasse === true && rA.message === MSG && !c._syncRefus && !bC._toasts.length && !bC._notifs.length && !bC._file.length, [rA, c, bC._toasts]);
      bC = bacC(); c = { id: '#C2', statut: 'livré' };
      pA = bC.sbSaveCommande(c); await attendre(); bC._vol[0](400, { code: 'P0001', message: MSG }); const rSeul = await pA;
      test('sbSaveCommande — refus « TRACE_IMPOSSIBLE » de la base (400, P0001), cas ordinaire : refus DÉFINITIF (jamais mis en file), message de la base rendu tel quel, commande marquée, utilisateur prévenu',
        rSeul.ok === false && rSeul.definitif === true && !rSeul.depasse && rSeul.message === MSG && c._syncRefus && c._syncRefus.message === MSG && bC._toasts.length === 1 && /NON enregistrée/.test(bC._toasts[0][0]) && bC._notifs.length === 1 && !bC._file.length, [rSeul, bC._toasts]);
      pA = bC.sbSaveCommande(c); await attendre(); bC._vol[1](201); await pA;
      test('sbSaveCommande — succès APRÈS ce refus (nouvel essai) : marque du refus effacée, comme avant', !c._syncRefus && !c._statutRefuse);
      bC = bacC(); c = { id: '#C3', statut: 'livré' };
      pA = bC.sbSaveCommande(c); pB = bC.sbSaveCommande(c); await attendre();
      bC._vol[1](400, { message: 'PIECES_NON_CONFIRMEES' }); await pB; c._statutRefuse = { de: 'en-route', vers: 'livré', at: Date.now() };
      bC._vol[0](201); const rAncienOk = await pA;
      test('sbSaveCommande — refus RÉCENT puis succès ANCIEN : la marque du refus récent n\'est pas effacée par le succès plus ancien', rAncienOk.ok === true && !!c._syncRefus && !!c._statutRefuse);
    }
    // carte de notification « undefined »
    const bNo = { console, JSON, Date, String, Array, Object, notifications: [], notifCurrentFilter: 'all', _html: '',
      generateId: () => 'n1', notifUpdateBadge() {}, toast() {},
      document: { getElementById: () => ({ set innerHTML(v) { bNo._html = v; } }), querySelectorAll: () => [] } };
    vm.createContext(bNo);
    vm.runInContext(extraireFonction('function notifTypeNorm(t)') + '\n' + extraireFonction('function notifAjout(type, cat, titre, msg, action, page)') + '\n' + extraireFonction('function notifRendreListe()'), bNo);
    bNo.notifAjout('err', 'commande', '⛔ Refusée par la base — #S1', 'rien n’a été enregistré', 'Voir', 'commandes');
    bNo.notifications.push({ id: 'n0', type: 'err', cat: 'commande', titre: 'ancienne carte', msg: 'x', time: '10:00' });
    bNo.notifRendreListe();
    test('notification « err » : type ramené à « urgent » (icône 🔴), jamais « undefined » (nouvelle carte et ancienne carte gardée)',
      bNo.notifications[0].type === 'urgent' && !/undefined/.test(bNo._html) && (bNo._html.match(/🔴/g) || []).length === 2, bNo._html.slice(0, 300));
    bNo.notifCurrentFilter = 'urgent'; bNo.notifRendreListe();
    test('filtre « urgent » : les deux cartes de refus y figurent', (bNo._html.match(/notif-card/g) || []).length === 2);
  }

  console.log('\n' + ok + ' OK, ' + ko + ' échec(s)');
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERREUR DU BANC :', e); process.exit(1); });
