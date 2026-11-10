// Tests unitaires de supabase/functions/_shared/jarvis-action-logique.ts (porte d'entrée JARVIS, v1 27/10/2026, v2 30/10/2026)
// Lancer : node --test supabase/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { controlerDemande, controlerCommande, apercuCommande, construireSav, champsLitige, avantLitige, egal, jourParis,
  VERSION, NIVEAUX, ACTIONS, niveauDe, ficheCommande, telMasque, transporteurPour, prochainNumero, lignesCommande, construireCommande, champsModification, champsPlanification, champsAnnulation, champsPrix, entreeStock, mouvementCamion, alerteCorrectionStock, estimerStock, lienFacture, coordonneesDepuis, nomConcorde, produitProche, critereClient, initiales, scoreNom, rechercheApprochee, SEUIL_APPROCHE, seuilPour, phonetique } from '../functions/_shared/jarvis-action-logique.ts';

const T = Date.parse('2026-10-27T10:00:00Z');
const cmd = (o) => ({ id: '#1588', statut: 'en-attente', client: 'Client Fictif', tel: '0600000000', email: 'fictif@exemple.test', adresse: '1 rue Fictive 93160 Noisy-le-Grand', produit: 'Matelas 140x190', transporteur: 'GLS', tracking_transporteur: '', date_livraison: '2026-10-28', ...o });

test('liste fermée et forme des demandes', () => {
  assert.match(controlerDemande({ action: 'supprimer', cmdId: '#1588' }, T), /non autorisée/);
  assert.match(controlerDemande({ action: 'gls_etiquette', cmdId: '1588; drop' }, T), /numéro de commande/);
  assert.equal(controlerDemande({ action: 'gls_etiquette', cmdId: '#1588' }, T), null);
  assert.match(controlerDemande({ action: 'gls_retour', cmdId: '#1588', poids: 80 }, T), /poids/);
  assert.match(controlerDemande({ action: 'planifier', cmdId: '#1588', date: '2026-10-26' }, T), /passée/);
  assert.match(controlerDemande({ action: 'planifier', cmdId: '#1588', date: '2027-02-01' }, T), /lointaine/);
  assert.match(controlerDemande({ action: 'planifier', cmdId: '#1588', date: '2026-02-30' }, T), /invalide/);
  assert.equal(controlerDemande({ action: 'planifier', cmdId: '#1588', date: '2026-10-29' }, T), null);
  assert.match(controlerDemande({ action: 'sav', cmdId: '#1588', type: 'remboursement', date: '2026-10-29', motif: 'xx' }, T), /pas de remboursement/);
  assert.match(controlerDemande({ action: 'sav', cmdId: '#1588', type: 'echange', date: '2026-10-29', motif: 'abîmé', produit_a_reprendre: 'Matelas' }, T), /produit à livrer/);
  assert.equal(controlerDemande({ action: 'sav', cmdId: '#1588', type: 'echange', date: '2026-10-29', motif: 'abîmé', produit_a_livrer: 'Matelas 140', produit_a_reprendre: 'Matelas 140' }, T), null);
  assert.match(controlerDemande({ action: 'litige', cmdId: '#1588', litige_num: '123' }, T), /13 chiffres/);
  assert.match(controlerDemande({ action: 'litige', cmdId: '#1588' }, T), /rien à mettre à jour/);
});

test('contrôles sur la commande : déjà étiquetée, livrée, adresse sans code postal, SAV d’un SAV', () => {
  assert.match(controlerCommande({ action: 'gls_etiquette' }, cmd({ tracking_transporteur: '111' })), /déjà une étiquette/);
  assert.match(controlerCommande({ action: 'gls_etiquette' }, cmd({ statut: 'livré' })), /livré/);
  assert.match(controlerCommande({ action: 'gls_etiquette' }, cmd({ adresse: 'rue sans code' })), /code postal/);
  assert.equal(controlerCommande({ action: 'gls_etiquette' }, cmd()), null);
  assert.match(controlerCommande({ action: 'sav' }, cmd({ id: '#SAV1234567' })), /commande d’origine/);
  assert.match(controlerCommande({ action: 'planifier' }, null), /introuvable/);
});

test('aperçu sans coordonnées : code postal et ville seulement', () => {
  const a = apercuCommande(cmd());
  assert.equal(a.cp, '93160'); assert.equal(a.ville, 'Noisy-le-Grand');
  const t = JSON.stringify(a); for (const x of ['Client Fictif', '0600000000', 'fictif@', 'rue Fictive']) assert.ok(!t.includes(x), x);
});

test('SAV : construit comme dans l’appli, sans argent (Déjà payé, 0 €), note lisible par le livreur', () => {
  const s = construireSav({ action: 'sav', type: 'echange', date: '2026-10-29', motif: 'Matelas abîmé', produit_a_livrer: 'Matelas 140x190', produit_a_reprendre: 'Matelas 140x190 abîmé' }, cmd(), T);
  assert.match(s.id, /^#SAV\d{7}$/); assert.equal(s.prix, 0); assert.equal(s.paie, 'Déjà payé'); assert.equal(s.stpaie, 'Payé'); assert.equal(s.montant_enc, 0);
  assert.equal(s.origine, 'SAV - Échange'); assert.equal(s.date_livraison, '2026-10-29'); assert.equal(s.statut, 'en-attente');
  assert.match(s.instr, /cmd origine #1588/); assert.match(s.instr, /À LIVRER : Matelas 140x190/); assert.match(s.instr, /Créé depuis JARVIS/);
  assert.equal(s.client, 'Client Fictif', 'coordonnées recopiées de la commande d’origine (côté serveur seulement)');
  assert.equal(s.date_commande, jourParis(T));
});

test('litige : seulement les champs fournis ; un n° de réclamation ouvre la réclamation ; comparaison de secret', () => {
  const p = champsLitige({ action: 'litige', litige_num: '1234567890123' }, T);
  assert.equal(p.litige_num_reclamation, '1234567890123'); assert.equal(p.litige_statut, 'reclamation_ouverte'); assert.ok(!('litige_type' in p));
  assert.equal(champsLitige({ action: 'litige', litige_statut: 'dossier_envoye', litige_num: '1234567890123' }, T).litige_statut, 'dossier_envoye');
  assert.equal(egal('abc', 'abc'), true); assert.equal(egal('abc', 'abd'), false); assert.equal(egal('', ''), false);
});

test('aperçu litige (réserve Codex #5) : description existante, absente, vide, et tronquée à 500 caractères', () => {
  assert.deepEqual(avantLitige({ litige_type: 'perte', litige_statut: 'a_declarer', litige_num_reclamation: '1234567890123', litige_description: 'Colis 2/3 non livré' }),
    { type: 'perte', statut: 'a_declarer', num: '1234567890123', description: 'Colis 2/3 non livré' });
  assert.deepEqual(avantLitige({}), { type: null, statut: null, num: null, description: null });
  assert.equal(avantLitige({ litige_description: '   ' }).description, null);
  const longue = 'x'.repeat(499) + 'YZ' + 'w'.repeat(100);
  const d = avantLitige({ litige_description: longue }).description;
  assert.equal(d.length, 500); assert.ok(d.endsWith('xY'), 'coupée exactement à 500 caractères');
});

// ── v2 (30/10/2026) : autorisation totale sur commandes et stock, niveaux N1 / N2 / N3 ────────────────────────────────────

test('v2 : liste fermée avec niveau ; créer une commande dictée = N3, depuis un mail = N2', () => {
  assert.equal(VERSION, 'v2');
  assert.equal(ACTIONS.length, 23); for (const a of ACTIONS) assert.ok(['N1', 'N2', 'N3'].includes(NIVEAUX[a]), a);
  assert.equal(niveauDe({ action: 'lire_stock' }), 'N1'); assert.equal(niveauDe({ action: 'planifier' }), 'N2'); assert.equal(niveauDe({ action: 'annuler_commande' }), 'N3');
  assert.equal(niveauDe({ action: 'creer_commande', source: 'mail' }), 'N2'); assert.equal(niveauDe({ action: 'creer_commande', source: 'dictee' }), 'N3');
  for (const a of ['marquer_paye', 'rembourser', 'encaisser', 'shopify', 'tiktok']) assert.match(controlerDemande({ action: a, cmdId: '#1588' }, T), /non autorisée/, a);
});

test('v2 : forme des nouvelles demandes (lecture, statut, annulation, prix, SMS, stock)', () => {
  assert.equal(controlerDemande({ action: 'lire_commande', cmdId: '#1588' }, T), null);
  assert.equal(controlerDemande({ action: 'lister_commandes' }, T), null);
  assert.match(controlerDemande({ action: 'lister_commandes', statut: 'perdu' }, T), /statut inconnu/);
  assert.match(controlerDemande({ action: 'lister_commandes', limite: 1000 }, T), /limite/);
  assert.match(controlerDemande({ action: 'changer_statut', cmdId: '#1588', statut: 'livré' }, T), /marquer_livre/);
  assert.equal(controlerDemande({ action: 'changer_statut', cmdId: '#1588', statut: 'reporté' }, T), null);
  assert.match(controlerDemande({ action: 'annuler_commande', cmdId: '#1588' }, T), /motif/);
  assert.match(controlerDemande({ action: 'modifier_prix', cmdId: '#1588', prix: -5, motif: 'geste' }, T), /prix invalide/);
  assert.match(controlerDemande({ action: 'modifier_prix', cmdId: '#1588', prix: 399 }, T), /motif/);
  assert.equal(controlerDemande({ action: 'modifier_prix', cmdId: '#1588', prix: 399, motif: 'geste commercial rayure' }, T), null);
  assert.match(controlerDemande({ action: 'envoyer_sms', cmdId: '#1588', texte: 'court' }, T), /trop court/);
  assert.match(controlerDemande({ action: 'envoyer_sms', cmdId: '#1588', texte: 'Bonjour, votre livraison : https://x.y' }, T), /pas de lien/);
  assert.equal(controlerDemande({ action: 'envoyer_sms', cmdId: '#1588', texte: 'Bonjour, votre livraison est confirmée demain matin.' }, T), null);
  assert.match(controlerDemande({ action: 'modifier_commande', cmdId: '#1588', champs: { prix: 10 } }, T), /modifier_prix/);
  assert.match(controlerDemande({ action: 'modifier_commande', cmdId: '#1588', champs: { paie: 'Payé' } }, T), /non modifiable/);
  assert.match(controlerDemande({ action: 'modifier_commande', cmdId: '#1588', champs: {} }, T), /rien à modifier/);
  assert.equal(controlerDemande({ action: 'modifier_commande', cmdId: '#1588', champs: { etage: '3', code: 'B12' } }, T), null);
  assert.match(controlerDemande({ action: 'planifier', cmdId: '#1588', date: '2026-10-29', livreur: 'DHL' }, T), /livreur inconnu/);
  assert.equal(controlerDemande({ action: 'deplacer', cmdId: '#1588', date: '2026-11-03' }, T), null);
  assert.match(controlerDemande({ action: 'stock_entree', produit: 'matelas-140', qte: 0 }, T), /quantité/);
  assert.match(controlerDemande({ action: 'stock_entree', produit: 'matelas-140', qte: 3, motif: 'vol' }, T), /motif/);
  assert.equal(controlerDemande({ action: 'stock_entree', produit: 'matelas-140', qte: 3 }, T), null);
  assert.match(controlerDemande({ action: 'stock_chargement', produit: 'Matelas 140', qte: 2 }, T), /livreur/);
  assert.equal(controlerDemande({ action: 'stock_chargement', livreur: 'RANOU', produit: 'Matelas 140', qte: 2 }, T), null);
  assert.match(controlerDemande({ action: 'stock_correction', produit: 'matelas-140', qte: 2 }, T), /motif/);
});

test('v2 : créer une commande — source obligatoire, téléphone, code postal, lignes bornées', () => {
  const ok = { action: 'creer_commande', source: 'mail', client: 'Client Fictif', tel: '06 12 34 56 78', adresse: '1 rue Fictive', cp: '93160', ville: 'Noisy-le-Grand', lignes: [{ produit: 'Matelas 140x190', qte: 1 }] };
  assert.equal(controlerDemande(ok, T), null);
  assert.match(controlerDemande({ ...ok, source: undefined }, T), /source obligatoire/);
  assert.match(controlerDemande({ ...ok, tel: '12' }, T), /téléphone/);
  assert.match(controlerDemande({ ...ok, cp: '9316' }, T), /code postal/);
  assert.match(controlerDemande({ ...ok, lignes: [] }, T), /au moins un produit/);
  assert.match(controlerDemande({ ...ok, lignes: [{ produit: 'Matelas', qte: 50 }] }, T), /quantité/);
  assert.match(controlerDemande({ ...ok, origine: 'Amazon' }, T), /origine inconnue/);
});

test('v2 : contrôles sur la commande — modifiable, annulable, supprimable, prix verrouillé, livraison GLS, SMS sans téléphone', () => {
  assert.match(controlerCommande({ action: 'modifier_commande' }, cmd({ statut: 'livré' })), /plus modifiable/);
  assert.match(controlerCommande({ action: 'annuler_commande' }, cmd({ statut: 'annulé' })), /déjà annulée/);
  assert.match(controlerCommande({ action: 'annuler_commande' }, cmd({ statut: 'livré' })), /SAV ou retour/);
  assert.equal(controlerCommande({ action: 'annuler_commande' }, cmd()), null);
  assert.match(controlerCommande({ action: 'supprimer_commande' }, cmd({ stpaie: 'Payé' })), /encaissement/);
  assert.match(controlerCommande({ action: 'supprimer_commande' }, cmd({ tracking_transporteur: '111' })), /étiquette GLS/);
  assert.match(controlerCommande({ action: 'supprimer_commande' }, cmd({ statut: 'livré' })), /historique/);
  assert.equal(controlerCommande({ action: 'supprimer_commande' }, cmd({ stpaie: 'Non payé', montant_enc: 0 })), null);
  assert.match(controlerCommande({ action: 'modifier_prix' }, cmd({ payment_source: 'SHOPIFY_ONLINE' })), /payée en ligne/);
  assert.equal(controlerCommande({ action: 'modifier_prix' }, cmd({ payment_source: 'LEBONCOIN' })), null);
  assert.match(controlerCommande({ action: 'marquer_livre' }, cmd({ transporteur: 'GLS' })), /suivi GLS/);
  assert.match(controlerCommande({ action: 'marquer_livre' }, cmd({ statut: 'livré' })), /déjà livrée/);
  assert.match(controlerCommande({ action: 'envoyer_sms' }, cmd({ tel: '' })), /téléphone/);
  assert.equal(controlerCommande({ action: 'lister_commandes' }, null), null, 'les lectures sans commande passent');
  assert.match(controlerCommande({ action: 'lire_commande', cmdId: '#9' }, null), /introuvable/);
});

test('v2 : fiche et aperçus ne laissent passer ni nom, ni téléphone, ni e-mail, ni adresse', () => {
  const f = ficheCommande(cmd({ lignes: [{ produit: 'Matelas 140x190', qte: 1, prixUnit: 299 }], prix: 299, instr: 'Sonner fort' }));
  assert.equal(f.client_initiales, 'C. F.'); assert.equal(f.prix, 299); assert.equal(f.lignes[0].produit, 'Matelas 140x190');
  const t = JSON.stringify(f); for (const x of ['Client Fictif', '0600000000', 'fictif@', 'rue Fictive']) assert.ok(!t.includes(x), x);
  assert.equal(telMasque('06 12 34 56 78'), '06 ** ** ** 78');
});

test('v2 : nouvelle commande — numéro suivant, transporteur par code postal, prix du catalogue, ancienne offre refusée, paiement à la livraison', () => {
  assert.equal(prochainNumero(['#1588', '#SAV1234567', '#1590', 'x', '#2']), '#1591');
  assert.equal(prochainNumero([]), '#1');
  assert.equal(transporteurPour('93160'), 'RANOU'); assert.equal(transporteurPour('69001'), 'GLS'); assert.equal(transporteurPour('75011'), 'RANOU');
  const cat = new Map([['matelas-140', { id: 'matelas-140', nom: 'Matelas 140x190', prix: 299, actif: true }], ['vieux', { id: 'vieux', nom: 'Lit coffre 140 + matelas 20', prix: 349, actif: true, ancienne_offre: true }]]);
  const l = lignesCommande([{ produit: 'matelas 140X190', qte: 2 }, { produit: 'Oreiller inconnu', qte: 1 }], cat);
  assert.equal(l.erreur, null); assert.equal(l.lignes[0].produitId, 'matelas-140'); assert.equal(l.lignes[0].prixUnit, 299); assert.equal(l.lignes[0].sousTotal, 598);
  assert.equal(l.lignes[1].produitId, null); assert.equal(l.lignes[1].prixUnit, 0);
  assert.match(lignesCommande([{ produitId: 'vieux', produit: 'x', qte: 1 }], cat).erreur, /ancienne offre/);
  const c = construireCommande({ action: 'creer_commande', source: 'mail', client: 'Client Fictif', tel: '06 12 34 56 78', adresse: '1 rue Fictive', cp: '93160', ville: 'Noisy-le-Grand', date: '2026-11-03', lignes: [] }, '#1591', l.lignes, T);
  assert.equal(c.id, '#1591'); assert.equal(c.prix, 598); assert.equal(c.paie, 'Espèces'); assert.equal(c.stpaie, 'Non payé'); assert.equal(c.montant_enc, 0);
  assert.equal(c.statut, 'en-attente'); assert.equal(c.transporteur, 'RANOU'); assert.equal(c.origine, 'Mail'); assert.equal(c.adresse, '1 rue Fictive, 93160 Noisy-le-Grand');
  assert.match(c.produit, /2× Matelas 140x190 \+ Oreiller inconnu/); assert.match(c.instr, /mail client/); assert.equal(c.date_commande, jourParis(T));
});

test('v2 : modification — champs autorisés seulement, avertissements adresse / étiquette / prix', () => {
  const m = champsModification({ action: 'modifier_commande', champs: { adresse: '2 rue Neuve 93160 Noisy', etage: '4', produit: 'Sommier 160' } }, cmd({ tracking_transporteur: '111', etage: '1' }), T);
  assert.equal(m.apres.etage, '4'); assert.equal(m.avant.etage, '1'); assert.ok(!('prix' in m.apres)); assert.ok(m.apres.updated_at);
  assert.ok(m.avertissements.some((a) => /étiquette GLS/.test(a))); assert.ok(m.avertissements.some((a) => /prix n'est pas recalculé/.test(a)));
  assert.ok(champsModification({ action: 'modifier_commande', champs: { adresse: 'rue sans code' } }, cmd(), T).avertissements.some((a) => /code postal/.test(a)));
});

test('v2 : planifier / déplacer / annuler / prix', () => {
  const p = champsPlanification({ action: 'planifier', date: '2026-11-03', livreur: 'GLS' }, cmd(), T);
  assert.equal(p.date_livraison, '2026-11-03'); assert.equal(p.transporteur, 'GLS'); assert.equal(p.livreur, ''); assert.ok(!('statut' in p));
  const d = champsPlanification({ action: 'deplacer', date: '2026-11-03' }, cmd({ date_livraison: '2026-10-20' }), T);
  assert.equal(d.statut, 'reporté', 'date passée → reporté');
  assert.ok(!('statut' in champsPlanification({ action: 'deplacer', date: '2026-11-03' }, cmd({ date_livraison: '2026-10-30' }), T)), 'date à venir : statut inchangé');
  const a = champsAnnulation({ action: 'annuler_commande', motif: 'Client injoignable' }, T);
  assert.equal(a.statut, 'annulé'); assert.equal(a.annulation_motif, 'Client injoignable'); assert.equal(a.annulation_commentaire, null);
  const b = champsAnnulation({ action: 'annuler_commande', motif: 'le client est parti au Maroc' }, T);
  assert.equal(b.annulation_motif, 'Autre'); assert.equal(b.annulation_commentaire, 'le client est parti au Maroc');
  const x = champsPrix({ action: 'modifier_prix', prix: 349, motif: 'geste commercial' }, cmd({ prix: 399, instr: 'Sonner' }), T);
  assert.equal(x.prix, 349); assert.equal(x.prix_brut, 349); assert.equal(x.remise_globale, 0); assert.match(x.instr, /^Sonner\n💶 Prix 399 € → 349 €/);
});

test('v2 : stock — entrée, mouvement camion, correction en alerte, estimation', () => {
  const e = entreeStock({ action: 'stock_entree', produit: 'matelas-140', qte: 5 }, T);
  assert.equal(e.app_produit_id, 'matelas-140'); assert.equal(e.quantite, 5); assert.equal(e.motif, 'reassort'); assert.equal(e.saisi_par, 'JARVIS');
  const m = mouvementCamion({ action: 'stock_chargement', livreur: 'RANOU', produit: 'Matelas 140', qte: 2 });
  assert.equal(m.type, 'chargement'); assert.equal(m.source, 'depot'); assert.equal(m.destination, 'camion:RANOU'); assert.equal(m.par_user, 'JARVIS');
  assert.equal(mouvementCamion({ action: 'stock_retour_depot', livreur: 'RANOU', produit: 'x', qte: 1 }).type, 'retour_depot');
  const a = alerteCorrectionStock({ action: 'stock_correction', produit: 'matelas-140', qte: 2, motif: 'casse au dépôt' }, T);
  assert.equal(a.type, 'stock-correction'); assert.match(a.message, /−2 × matelas-140/); assert.equal(a.jour, jourParis(T));
  const s = estimerStock('matelas-140', 10, '2026-10-20T18:00:00Z',
    [{ statut: 'en-attente', created_at: '2026-10-25T10:00:00Z', lignes: [{ produitId: 'matelas-140', qte: 2 }] }, { statut: 'livré', created_at: '2026-10-25T10:00:00Z', lignes: [{ produitId: 'matelas-140', qte: 9 }] }, { statut: 'en-attente', created_at: '2026-10-10T10:00:00Z', lignes: [{ produitId: 'matelas-140', qte: 9 }] }],
    [{ app_produit_id: 'matelas-140', quantite: 3, date_entree: '2026-10-22T09:00:00Z' }, { app_produit_id: 'matelas-140', quantite: 9, date_entree: '2026-10-01T09:00:00Z' }]);
  assert.deepEqual([s.commandes_en_cours, s.entrees, s.disponible_estime], [2, 3, 11]);
  assert.equal(estimerStock('x', null, null, [], []).disponible_estime, null, 'sans comptage : pas de chiffre inventé');
});

// ── v2.1 (04/11/2026) : recherche par client dans lister_commandes ──────────────────────────────────────────────
test('v2.1 — critère client : nom sans accent ni casse, téléphone chiffre à chiffre, e-mail ; refus du vide', () => {
  const nom = critereClient('Léa Dupont-Martin');
  assert.equal(nom.genre, 'nom');
  assert.deepEqual(nom.filtres.map((f) => f.operateur + ':' + f.colonne), ['imatch:client', 'imatch:client', 'imatch:client']);
  assert.equal(nom.filtres[0].valeur, 'l[eéèêëÉÈÊË][aàáâäãÀÁÂÄÃ]');
  assert.ok(new RegExp(nom.filtres[0].valeur, 'i').test('LÉA'), 'la majuscule accentuée est trouvée');
  assert.ok(new RegExp(nom.filtres[1].valeur, 'i').test('dupont'));
  assert.equal(critereClient('  rubini ').filtres.length, 1);
  const on = critereClient("M. O'Neil (client)"); assert.equal(on.filtres.length, 2, 'initiale « M. » et lettre isolée « O » écartées, parenthèses retirées');
  assert.ok(new RegExp(on.filtres[0].valeur, 'i').test("O'NEIL"));
  assert.equal(critereClient('a'), null); assert.equal(critereClient(''), null); assert.equal(critereClient('%%%'), null);
  assert.equal(critereClient('x'.repeat(200)).filtres.length, 1);
  const tel = critereClient('06.12.34.56.78');
  assert.equal(tel.genre, 'tel'); assert.equal(tel.filtres[0].colonne, 'tel');
  assert.equal(tel.filtres[0].valeur, '6\\D*1\\D*2\\D*3\\D*4\\D*5\\D*6\\D*7\\D*8', '9 chiffres significatifs');
  for (const cherche of ['06.12.34.56.78', '+33 6 12 34 56 78', '0612345678', 'tél 06 12 34 56 78']) for (const base of ['06 12 34 56 78', '+33612345678', '06.12.34.56.78']) assert.ok(new RegExp(critereClient(cherche).filtres[0].valeur).test(base), cherche + ' doit trouver ' + base);
  assert.equal(critereClient('06-12').genre, 'nom', 'moins de 6 chiffres = texte (mots « 06 » et « 12 »)');
  assert.equal(critereClient('12 34 56').genre, 'tel', '6 chiffres suffisent');
  assert.equal(critereClient('12 34').genre, 'nom', 'moins de 6 chiffres = texte');
  assert.equal(critereClient('Rue 12345').genre, 'nom', 'moins de 6 chiffres = nom'); assert.equal(critereClient('Résidence 123456 Dupont').genre, 'nom', 'plus de 3 lettres = nom');
  assert.equal(critereClient('x Dupont').filtres.length, 1, 'lettre isolée écartée'); assert.ok(new RegExp(critereClient('Lea').filtres[0].valeur, 'i').test('LÉA'), '~* replie la casse ; la classe porte aussi les majuscules accentuées (ctype C)'); assert.equal(critereClient('Lea').filtres[0].valeur, 'l[eéèêëÉÈÊË][aàáâäãÀÁÂÄÃ]'); assert.equal(critereClient('Œuvre').filtres[0].valeur.startsWith('[oóòôöõÓÒÔÖÕ][eéèêëÉÈÊË]'), true, 'ligature translittérée');
  const mail = critereClient('Jean.Dupont@Exemple.fr');
  assert.equal(mail.genre, 'email'); assert.equal(mail.filtres[0].operateur, 'ilike'); assert.equal(mail.filtres[0].valeur, '%jean.dupont@exemple.fr%');
  assert.equal(critereClient('a%b_@x').filtres[0].valeur, '%ab\\_@x%', 'le % est retiré, le _ est échappé pour ILIKE');
  assert.equal(critereClient('@x'), null); assert.equal(critereClient('jean@exemple.fr, Dupont').filtres[0].valeur, '%jean@exemple.fr%', 'seul le jeton @ est gardé');
  assert.equal(initiales('Laurence Rubini'), 'L. R.'); assert.equal(initiales('jean-pierre de la fontaine du bois'), 'J. D. L. F.');
});

test('v2.1 — forme de lister_commandes avec client', () => {
  assert.equal(controlerDemande({ action: 'lister_commandes', client: 'Rubini' }, T), null);
  assert.equal(controlerDemande({ action: 'lister_commandes', client: '06 12 34 56 78', limite: 5 }, T), null);
  assert.match(controlerDemande({ action: 'lister_commandes', client: 'a' }, T), /client/);
  assert.match(controlerDemande({ action: 'lister_commandes', client: '' }, T), /client/);
  assert.match(controlerDemande({ action: 'lister_commandes', client: {} }, T), /client/, 'objet refusé'); assert.match(controlerDemande({ action: 'lister_commandes', client: ['Rubini'] }, T), /client/, 'tableau refusé');
  assert.match(controlerDemande({ action: 'lister_commandes', client: 'Rubini', limite: 1000 }, T), /limite/);
});

// ── v2.2 (04/11/2026) : recherche approchée par nom ──────────────────────────────────────────────────────────────
test('v2.2 — recherche approchée : fautes de frappe, accents, ordre des mots ; refuse les noms éloignés', () => {
  const base = [{ id: '#2041', client: 'Laurence Rubini' }, { id: '#2050', client: 'Laurent Rubio' }, { id: '#1900', client: 'Jean Dupont' }, { id: '#1588', client: 'Léa Martin' }, { id: '#1601', client: null }];
  assert.deepStrictEqual(rechercheApprochee('Laurence Rubigny', base).map((x) => x.id), ['#2041'], 'Rubigny ≈ Rubini ; Laurent Rubio écarté');
  assert.deepStrictEqual(rechercheApprochee('Lorence Rubini', base).map((x) => x.id), ['#2041']);
  assert.deepStrictEqual(rechercheApprochee('rubini laurence', base).map((x) => x.id), ['#2041'], 'ordre des mots indifférent');
  assert.deepStrictEqual(rechercheApprochee('Lea Martn', base).map((x) => x.id), ['#1588'], 'accent et lettre manquante');
  assert.deepStrictEqual(rechercheApprochee('Dupnot', base).map((x) => x.id), ['#1900'], 'transposition');
  assert.deepStrictEqual(rechercheApprochee('Rubin', base).map((x) => x.id), ['#2041', '#2050'], 'début de nom d’abord (0,9), puis Rubio (0,8) : plusieurs proches = JARVIS les liste');
  assert.deepStrictEqual(rechercheApprochee('Michel Durand', base), [], 'nom sans rapport : rien');
  assert.deepStrictEqual(rechercheApprochee('Jean Rubini', base), [], 'un mot ne correspond à rien : rien (jamais un mélange de deux clients)');
  assert.strictEqual(scoreNom('', 'Jean'), 0); assert.ok(SEUIL_APPROCHE >= 0.8);
  const r = rechercheApprochee('Laurence Rubigny', base)[0]; assert.ok(r.score >= 0.75 && r.score < 1, 'score renvoyé (approché, pas exact)');
  const beaucoup = Array.from({ length: 3000 }, (_, i) => ({ id: '#' + i, client: 'Client Numero' + i })); const t0 = Date.now(); rechercheApprochee('Laurence Rubigny', beaucoup); assert.ok(Date.now() - t0 < 1500, '3 000 noms en moins de 1,5 s');
  assert.strictEqual(rechercheApprochee('Dupont', Array.from({ length: 20 }, () => ({ client: 'Jean Dupont' }))).length, 10, '10 au plus');
});

test('v2.2 — relecture : phonétique, noms collés, prénom court strict, bornes, lecture par tranches de 1 000', async () => {
  const base = [{ id: '#2041', client: 'Laurence Rubini' }, { id: '#3', client: 'Ben Ali' }, { id: '#4', client: 'Le Goff' }, { id: '#5', client: 'Abdel Kader' }, { id: '#6', client: 'Joan Martin' }, { id: '#7', client: 'Raul Diaz' }];
  assert.deepStrictEqual(rechercheApprochee('Rubigny', base).map((x) => x.id), ['#2041'], 'nom seul, dicté phonétiquement (gn, y)');
  assert.deepStrictEqual(rechercheApprochee('Benali', base).map((x) => x.id), ['#3'], 'nom collé');
  assert.deepStrictEqual(rechercheApprochee('Legoff', base).map((x) => x.id), ['#4']);
  assert.deepStrictEqual(rechercheApprochee('Abdelkader', base).map((x) => x.id), ['#5']);
  assert.deepStrictEqual(rechercheApprochee('Jean', base), [], 'prénom court : Jean ne trouve pas Joan');
  assert.deepStrictEqual(rechercheApprochee('Paul', base), [], 'Paul ne trouve pas Raul');
  assert.strictEqual(seuilPour('Jean'), 0.85); assert.strictEqual(seuilPour('Laurence Rubigny'), SEUIL_APPROCHE);
  assert.strictEqual(phonetique('rubigny'), phonetique('rubini'));
  assert.ok(scoreNom('Rubigny', 'Laurence Rubini') < 1, 'phonétique plafonnée : reste « approché »');
  const t0 = Date.now(); rechercheApprochee('mot '.repeat(2000), Array.from({ length: 3000 }, () => ({ client: 'Abcdefghijklmno Pqrstuvwxyzabcd Efghijklmnopqrs Tuvwxyzabcdefg Hijklmnopqrstu Vwxyzabcdefghi' })));
  assert.ok(Date.now() - t0 < 2000, 'requête de 2 000 mots bornée (80 caractères, 4 mots)');
  const plein = rechercheApprochee('Dupont', Array.from({ length: 15 }, () => ({ client: 'Jean Dupont' }))); assert.strictEqual(plein.length, 10); assert.strictEqual(plein.plus, true, 'd’autres homonymes existent');
  const fs = await import('node:fs'); const src = fs.readFileSync(new URL('../functions/jarvis-action/index.ts', import.meta.url), 'utf8');
  assert.match(src, /for \(let de = 0; de < 3000; de \+= 1000\)/); assert.match(src, /\.range\(de, de \+ 999\)/, 'Supabase rend 1 000 lignes au plus : lecture par tranches');
});

test('v2.2 — contre-relecture : phonétique seulement si l’orthographe est proche, « Lorence », ordre stable et dédoublonnage', async () => {
  const b = [{ id: '#1', client: 'Ami Diop' }, { id: '#2', client: 'Karim Hamidi' }, { id: '#3', client: 'Ian Smith' }, { id: '#4', client: 'Yanna Lee' }, { id: '#5', client: 'Mati Sow' }, { id: '#6', client: 'Mathias Roy' }, { id: '#7', client: 'Laurence Rubini' }];
  assert.deepStrictEqual(rechercheApprochee('Hamid', b).map((x) => x.id), ['#2'], 'Hamid ne trouve pas Ami');
  assert.ok(!rechercheApprochee('Yann', b).some((x) => x.id === '#3'), 'Yann ne trouve pas Ian');
  assert.ok(!rechercheApprochee('Mathis', b).some((x) => x.id === '#5'), 'Mathis ne trouve pas Mati');
  assert.deepStrictEqual(rechercheApprochee('Lorence', b).map((x) => x.id), ['#7'], 'Lorence seul ≈ Laurence');
  assert.deepStrictEqual(rechercheApprochee('Rubigny', b).map((x) => x.id), ['#7']);
  assert.ok(scoreNom('Rubigny', 'Laurence Rubini') <= 0.9, 'phonétique plafonnée à 0,9');
  const fs = await import('node:fs'); const src = fs.readFileSync(new URL('../functions/jarvis-action/index.ts', import.meta.url), 'utf8');
  assert.match(src, /\.order\('id', \{ ascending: true \}\)\.range\(de, de \+ 999\)/); assert.match(src, /const uniques = tous\.filter/);
});

// ── v2.3 (06/11/2026) : comptage exact (recette Borhen : JARVIS se contredisait sur les nombres) ─────────────────────
test('v2.3 compter_commandes : N1, lecture sans commande, contrôles de forme', () => {
  assert.equal(NIVEAUX.compter_commandes, 'N1'); assert.ok(ACTIONS.includes('compter_commandes'));
  assert.equal(controlerDemande({ action: 'compter_commandes' }, T), null);
  assert.equal(controlerDemande({ action: 'compter_commandes', livreur: 'RANOU', date_debut: '2026-11-01', date_fin: '2026-11-30' }, T), null);
  assert.match(controlerDemande({ action: 'compter_commandes', livreur: 'BIDULE' }, T), /livreur inconnu/);
  assert.match(controlerDemande({ action: 'compter_commandes', date: '07/11' }, T), /date invalide/);
  assert.match(controlerDemande({ action: 'compter_commandes', date: '2026-11-07', date_debut: '2026-11-01' }, T), /pas les deux/);
  assert.match(controlerDemande({ action: 'compter_commandes', date_debut: '2026-11-30', date_fin: '2026-11-01' }, T), /inversée/);
  assert.equal(controlerCommande({ action: 'compter_commandes' }, null), null);
});

test('v2.3 : « total » = nombre exact de la base, plus la longueur de la liste coupée ; comptage sans aucune ligne lue', async () => {
  const fs = await import('node:fs'); const src = fs.readFileSync(new URL('../functions/jarvis-action/index.ts', import.meta.url), 'utf8');
  assert.match(src, /, \{ count: 'exact' \}\)\.limit\(d\.limite \|\| 30\)/);
  assert.match(src, /total: totalExact, affichees: n, tronquee: totalExact > n/);
  assert.doesNotMatch(src, /total: \(data \|\| \[\]\)\.length/, 'plus jamais la longueur de la liste comme total');
  const bloc = src.slice(src.indexOf("d.action === 'compter_commandes'"), src.indexOf("d.action === 'lire_stock'"));
  assert.match(bloc, /select\('id', \{ count: 'exact', head: true \}\)/, 'requêtes « head » : aucune ligne, aucune donnée client');
  assert.match(bloc, /not\('id', 'like', '#TEST%'\)/, 'lignes de test exclues');
  assert.match(src, /\{ count: 'exact' \}\)\.limit\(d\.limite \|\| 30\);\n\s*q = q\.not\('id', 'like', '#TEST%'\)/, 'mêmes exclusions dans lister_commandes');
  assert.match(bloc, /Promise\.all/); assert.match(bloc, /autre \(statut vide ou ancien\)/); assert.match(bloc, /total: toutes/);
  assert.doesNotMatch(bloc.replace(/\/\/.*/g, ''), /'(client|tel|email|adresse)'|select\('\*'/);
});

test('v2.4 compter_commandes : par origine (valeurs de l’appli) et date de prise de commande, montant hors annulées et SAV', async () => {
  const { origineCanonique } = await import('../functions/_shared/jarvis-action-logique.ts');
  assert.equal(origineCanonique('LeBonCoin'), 'LeBonCoin'); assert.equal(origineCanonique('leboncoin'), 'LeBonCoin'); assert.equal(origineCanonique('Leboncoin'), 'LeBonCoin');
  assert.equal(origineCanonique('site maxiconfort'), 'Site Maxiconfort'); assert.equal(origineCanonique('Boutique'), 'Boutique physique');
  assert.equal(origineCanonique('téléphone'), 'Appel direct'); assert.equal(origineCanonique('tiktok'), 'TikTok Shop'); assert.equal(origineCanonique('Vinted'), null); assert.equal(origineCanonique(''), null);
  assert.equal(controlerDemande({ action: 'compter_commandes', origine: 'LeBonCoin', cree_debut: '2026-11-09', cree_fin: '2026-11-09' }, T), null);
  assert.match(controlerDemande({ action: 'compter_commandes', origine: 'Vinted' }, T), /origine inconnue/);
  assert.match(controlerDemande({ action: 'compter_commandes', cree_debut: '09/11' }, T), /cree_debut invalide/);
  assert.match(controlerDemande({ action: 'compter_commandes', cree_debut: '2026-11-10', cree_fin: '2026-11-01' }, T), /inversée/);
  const fs = await import('node:fs'); const src = fs.readFileSync(new URL('../functions/jarvis-action/index.ts', import.meta.url), 'utf8');
  const bloc = src.slice(src.indexOf("d.action === 'compter_commandes'"), src.indexOf("d.action === 'lire_stock'"));
  assert.match(bloc, /q\.ilike\('origine', origine/); assert.match(bloc, /gte\('date_commande'/); assert.match(bloc, /lte\('date_commande'/);
  assert.doesNotMatch(bloc.replace(/\/\/.*/g, ''), /created_at/, 'date de prise = date_commande, comme l’appli'); assert.match(bloc, /not\('origine', 'ilike', 'SAV%'\)/);
  assert.match(bloc, /select\('prix'\)/, 'montant : colonne prix seule'); assert.match(bloc, /statut\.is\.null,statut\.neq\.annulé/);
  assert.doesNotMatch(bloc.replace(/\/\/.*/g, ''), /'(client|tel|email|adresse)'|select\('\*'/, 'aucune donnée client');
});

test('v2.5 lien_facture : seulement au bon client, jamais d’autre donnée', () => {
  const tok = '3f2b8c1e-0d4a-4b7e-9c11-5a6f7e8d9c0b';
  assert.equal(NIVEAUX.lien_facture, 'N1');
  assert.match(controlerDemande({ action: 'lien_facture', cmdId: '#1588' }, T), /e-mail du destinataire/);
  assert.match(controlerDemande({ action: 'lien_facture', cmdId: '#1588', email: 'pas un mail' }, T), /e-mail du destinataire/);
  assert.equal(controlerDemande({ action: 'lien_facture', cmdId: '#1588', email: 'fictif@exemple.test' }, T), null);
  const ok = lienFacture({ action: 'lien_facture', email: '  FICTIF@exemple.TEST ' }, cmd({ tracking_token: tok, stpaie: 'Payé' }));
  assert.deepEqual(ok, { lien: 'https://livraison.maxiconfort.fr/facture.html?t=' + tok, acquittee: true, commande: '#1588' });
  assert.match(lienFacture({ email: 'autre@exemple.test' }, cmd({ tracking_token: tok })).erreur, /pas celui du client/);
  assert.match(lienFacture({ email: 'fictif@exemple.test' }, cmd({ tracking_token: tok, email: '' })).erreur, /pas d’e-mail/);
  assert.match(lienFacture({ email: 'fictif@exemple.test' }, cmd({ tracking_token: tok, statut: 'annulé' })).erreur, /annulée/);
  assert.match(lienFacture({ email: 'fictif@exemple.test' }, cmd({ tracking_token: '' })).erreur, /sans lien/);
  assert.equal(lienFacture({ email: 'fictif@exemple.test' }, cmd({ tracking_token: tok })).acquittee, false);
});

test('v2.6 sans_date : commandes sans date de livraison (liste et comptage)', () => {
  assert.equal(controlerDemande({ action: 'lister_commandes', sans_date: true }, T), null);
  assert.equal(controlerDemande({ action: 'compter_commandes', sans_date: true, livreur: 'GLS' }, T), null);
  assert.match(controlerDemande({ action: 'lister_commandes', sans_date: 'oui' }, T), /true seulement/);
  assert.match(controlerDemande({ action: 'lister_commandes', sans_date: true, date: '2026-11-12' }, T), /pas les deux/);
  assert.match(controlerDemande({ action: 'compter_commandes', sans_date: true, date_debut: '2026-11-01' }, T), /pas les deux/);
  const src = fs.readFileSync(new URL('../functions/jarvis-action/index.ts', import.meta.url), 'utf8');
  assert.equal(src.split("or('date_livraison.is.null,date_livraison.eq.')").length - 1, 4, 'liste, recherche approchée, comptage et montant');
  assert.match(src, /sans_date: !!\(d as any\)\.sans_date,/, 'comptage : filtre renvoyé (garde de version côté JARVIS)');
  assert.equal(src.split("...((d as any).sans_date ? { sans_date: true } : {})").length - 1, 2, 'liste : filtre renvoyé');
});

test('v2.7 creer_commande depuis une commande existante : coordonnées recopiées par le serveur, jamais fournies', () => {
  const ok = { action: 'creer_commande', source: 'commande', depuis: '#2141', lignes: [{ produit: 'Matelas 140x190', qte: 1 }] };
  assert.equal(controlerDemande(ok, T), null);
  assert.equal(niveauDe(ok), 'N3');
  assert.match(controlerDemande({ ...ok, depuis: '2141' }, T), /numéro de la commande/);
  assert.match(controlerDemande({ ...ok, tel: '0612345678' }, T), /ne pas les fournir \(tel\)/);
  assert.match(controlerDemande({ ...ok, lignes: [] }, T), /au moins un produit/);
  assert.match(controlerDemande({ ...ok, source: 'autre' }, T), /source obligatoire/);
  const src = { client: 'Fictive Exemple', tel: '0600000000', email: 'f@exemple.test', adresse: '7 rue Fictive, entrée 7, 94140, Alfortville, France', etage: '3', ascenseur: 'Oui', code: 'A12' };
  const co = coordonneesDepuis(src);
  assert.deepEqual(co, { champs: { client: 'Fictive Exemple', tel: '0600000000', email: 'f@exemple.test', adresse: src.adresse, etage: '3', ascenseur: 'Oui', code: 'A12', cp: '94140', ville: 'Alfortville' } });
  const co2 = coordonneesDepuis({ ...src, adresse: '12 avenue Test, 75017 Paris 17e Arrondissement, France' });
  assert.equal(co2.champs.cp, '75017'); assert.equal(co2.champs.ville, 'Paris 17e Arrondissement');
  assert.match(coordonneesDepuis(null).erreur, /introuvable/);
  assert.match(coordonneesDepuis({ ...src, tel: '' }).erreur, /pas de téléphone/);
  assert.match(coordonneesDepuis({ ...src, adresse: 'sans code postal' }).erreur, /code postal introuvable/);
  const cmd = construireCommande({ ...ok, ...co.champs }, '#2200', [{ produit: 'Matelas 140x190', qte: 1, sousTotal: 199 }], Date.parse('2026-11-10T13:00:00Z'));
  assert.equal(cmd.adresse, src.adresse, 'adresse reprise telle quelle (pas de code postal en double)');
  assert.equal(cmd.ascenseur, 'Oui'); assert.equal(cmd.transporteur, 'RANOU');
  assert.match(cmd.instr, /coordonnées reprises de #2141/);
});

test('v2.7 relecture : ville lue sur les adresses réelles, nom annoncé comparé (oui / non seulement)', () => {
  const v = (a) => coordonneesDepuis({ client: 'A B', tel: '0600000000', adresse: a }).champs;
  assert.deepEqual([v('1 rue X, 93160, Noisy-le-Grand, 93160, France').cp, v('1 rue X, 93160, Noisy-le-Grand, 93160, France').ville], ['93160', 'Noisy-le-Grand']);
  assert.equal(v('1 rue X, 95000 Cergy CEDEX, France').ville, 'Cergy');
  assert.equal(v('21 route de vizille, 38560, CHAMP-SUR-DRAC, France').ville, 'CHAMP-SUR-DRAC');
  assert.ok(nomConcorde('Myriam Zeroual', 'Meryem zaroual'), 'mêmes initiales');
  assert.ok(nomConcorde('Meryem', 'Meryem zaroual'));
  assert.ok(!nomConcorde('Jean Dupont', 'Meryem zaroual'));
  assert.equal(controlerDemande({ action: 'creer_commande', source: 'commande', depuis: '#2141', nom_annonce: 'Meryem', lignes: [{ produit: 'Matelas', qte: 1 }] }, T), null);
  const src = fs.readFileSync(new URL('../functions/jarvis-action/index.ts', import.meta.url), 'utf8');
  assert.match(src, /statut_source: String\(\(src as any\)\.statut \|\| ''\)/);
});

test('v2.8 produit dit approximativement → produit du catalogue (noms réels), ou question ; jamais un autre produit en silence', () => {
  const noms = ['Matelas DODOCONFORT 140×190×15', 'Matelas DODOCONFORT 140×200×20', 'Matelas DODOCONFORT / OEKO-TEX 160×200×20 Mémoire de Forme',
    'Sommier Tapissier 140×190 Blanc', 'Sommier à lattes contour cuir PU 140×190 Noir', 'Sommier à lattes contour cuir PU 140×190 Blanc',
    'Lit Coffre 140×190 Cuir PU Noir + Sommier À Lattes', 'Lit Coffre 140×190 Cuir PU Blanc + Sommier À Lattes', 'PACK LIT COFFRE NOIR 140/190/15',
    'Ensemble 140×190 Matelas DODOCONFORT 20cm + Sommier À Lattes', 'Ensemble site 140×190 matelas 20 cm + sommier à lattes cuir PU Noir',
    'Sommier Tapissier 160×200 Blanc', 'Sommier Tapissier 160x200 Blanc', 'Matelas DODOCONFORT 90×190 ancien'];
  const cat = new Map(noms.map((n, i) => [String(i), { id: String(i), nom: n, prix: /Tapissier 160/.test(n) ? 250 : 100 + i, ancienne_offre: /ancien/.test(n) }]));
  const nom = (q) => { const r = produitProche(q, cat); return r ? (r.produit ? r.produit.nom : r.ambigus.map((p) => p.nom)) : null; };
  assert.equal(nom('matelas Dodo 140x190'), 'Matelas DODOCONFORT 140×190×15');
  assert.equal(nom('Matelas Dodo Confort 140 x 190'), 'Matelas DODOCONFORT 140×190×15');
  assert.equal(nom('matelas dodo 160x200'), 'Matelas DODOCONFORT / OEKO-TEX 160×200×20 Mémoire de Forme');
  assert.deepEqual(nom('matelas 140x190 20 cm'), ['Matelas DODOCONFORT 140×190×15'], 'pas de 20 cm : on propose le 15 cm, jamais un ensemble, jamais choisi d’office');
  assert.match(lignesCommande([{ produit: 'matelas 140x190 20 cm', qte: 1 }], cat).erreur, /cette épaisseur n’existe pas au catalogue — voulez-vous plutôt « Matelas DODOCONFORT 140×190×15 »/);
  assert.equal(nom('matelas dodo 90x190'), null, 'ancienne offre jamais proposée');
  assert.equal(nom('sommier à lattes 140x190 noir'), 'Sommier à lattes contour cuir PU 140×190 Noir');
  assert.equal(nom('sommier 140x190').length, 3, 'tapissier ou lattes, noir ou blanc : on demande');
  assert.deepEqual(nom('lit coffre 140x190').sort(), ['Lit Coffre 140×190 Cuir PU Blanc + Sommier À Lattes', 'Lit Coffre 140×190 Cuir PU Noir + Sommier À Lattes', 'PACK LIT COFFRE NOIR 140/190/15'], 'noir, blanc ou pack : on demande');
  assert.deepEqual(nom('lit coffre noir 140').sort(), ['Lit Coffre 140×190 Cuir PU Noir + Sommier À Lattes', 'PACK LIT COFFRE NOIR 140/190/15'], 'lit seul ou pack lit : on demande (relecture)');
  assert.equal(nom('pack lit coffre noir 140x190'), 'PACK LIT COFFRE NOIR 140/190/15');
  assert.equal(nom('sommier tapissier 160x200'), 'Sommier Tapissier 160×200 Blanc', 'doublons de même nom et même prix');
  assert.equal(nom('ensemble 140x190').length, 2);
  const l = lignesCommande([{ produit: 'matelas Dodo 140x190', qte: 2 }], cat);
  assert.equal(l.erreur, null); assert.equal(l.lignes[0].produit, 'Matelas DODOCONFORT 140×190×15'); assert.equal(l.lignes[0].sousTotal, 200);
  assert.deepEqual(l.rapproches, [{ dit: 'matelas Dodo 140x190', produit: 'Matelas DODOCONFORT 140×190×15' }]);
  assert.equal('dit' in l.lignes[0], false, 'rien d’ajouté à la ligne enregistrée');
  assert.match(lignesCommande([{ produit: 'lit coffre 140x190', qte: 1 }], cat).erreur, /plusieurs produits possibles — lequel \? .*« Lit Coffre 140×190 Cuir PU Blanc/);
  assert.equal(lignesCommande([{ produit: 'Sommier Tapissier 140×190 Blanc', qte: 1 }], cat).rapproches, undefined, 'nom exact : rien à dire');
});

test('v2.9 recherche par nom : voyelles mal entendues tolérées, sans ouvrir la porte aux faux amis', () => {
  const ok = (q, n) => scoreNom(q, n) >= seuilPour(q);
  assert.ok(ok('Myriam Zeroual', 'Meryem zaroual'), 'vidéo 14:19');
  assert.ok(ok('Meryem Zeroual', 'Myriam Zaroual'));
  assert.ok(ok('Mohamed Benali', 'Mouhamad Ben Ali'));
  for (const [q, n] of [['Hamid', 'Ami'], ['Mathis', 'Mati'], ['Laurence Rubigny', 'Laurent Rubio'], ['Jean', 'Joan'], ['Paul', 'Raul'], ['Myriam Zeroual', 'Mario Zerbib'], ['Karim Dupont', 'Kerem Dupuis']])
    assert.ok(!ok(q, n), q + ' ≠ ' + n);
  const res = rechercheApprochee('Myriam Zeroual', [{ client: 'Jean Martin' }, { client: 'Meryem zaroual' }, { client: 'Myriam Durand' }]);
  assert.deepEqual(res.map((x) => x.client), ['Meryem zaroual']);
});
