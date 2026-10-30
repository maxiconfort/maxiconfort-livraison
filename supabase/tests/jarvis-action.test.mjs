// Tests unitaires de supabase/functions/_shared/jarvis-action-logique.ts (porte d'entrée JARVIS, v1 27/10/2026, v2 30/10/2026)
// Lancer : node --test supabase/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlerDemande, controlerCommande, apercuCommande, construireSav, champsLitige, avantLitige, egal, jourParis,
  VERSION, NIVEAUX, ACTIONS, niveauDe, ficheCommande, telMasque, transporteurPour, prochainNumero, lignesCommande, construireCommande, champsModification, champsPlanification, champsAnnulation, champsPrix, entreeStock, mouvementCamion, alerteCorrectionStock, estimerStock } from '../functions/_shared/jarvis-action-logique.ts';

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
  assert.equal(ACTIONS.length, 21); for (const a of ACTIONS) assert.ok(['N1', 'N2', 'N3'].includes(NIVEAUX[a]), a);
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
