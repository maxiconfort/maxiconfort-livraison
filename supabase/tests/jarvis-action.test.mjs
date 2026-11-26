// Tests unitaires de supabase/functions/_shared/jarvis-action-logique.ts (porte d'entrée JARVIS, v1 27/10/2026, v2 30/10/2026)
// Lancer : node --test supabase/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { actionFactureSms } from '../functions/_shared/jarvis-facture-sms.ts';
import { controlerDemande, controlerCommande, apercuCommande, construireSav, champsLitige, avantLitige, egal, jourParis,
  VERSION, NIVEAUX, ACTIONS, niveauDe, ficheCommande, telMasque, transporteurPour, prochainNumero, lignesCommande, catalogueDepuisBase, catalogueJarvis, construireCommande, champsModification, champsPlanification, champsAnnulation, champsPrix, entreeStock, mouvementCamion, alerteCorrectionStock, estimerStock, lienFacture, coordonneesDepuis, nomConcorde, produitProche, resumeSuivi, resumeSms, variantesTel, resumeCredits, SEUIL_CREDITS_SMS_BAS, factureSms, MARQUE_LIEN_FACTURE, segmentsSms, critereClient, initiales, scoreNom, rechercheApprochee, SEUIL_APPROCHE, seuilPour, phonetique } from '../functions/_shared/jarvis-action-logique.ts';

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

test('v2.11 : la liste d’un jour lit aussi la colonne client (sinon client_nom vide, recette 10/11 22:01)', () => {
  const src = fs.readFileSync(new URL('../functions/jarvis-action/index.ts', import.meta.url), 'utf8');
  assert.match(src, /select\('id, produit, statut, transporteur, date_livraison, adresse, tracking_transporteur, livreur, created_at, client', \{ count: 'exact' \}\)\.limit/);
  assert.doesNotMatch(src, /crit \? ', client' : ''/);
});
test('aperçu sans coordonnées : nom du client (v2.11), code postal et ville seulement', () => {
  const a = apercuCommande(cmd());
  assert.equal(a.cp, '93160'); assert.equal(a.ville, 'Noisy-le-Grand');
  assert.equal(a.client_nom, 'Client Fictif', 'v2.11 (GO Borhen 10/11 18:50) : nom complet');
  assert.equal(apercuCommande(cmd({ client: 'X'.repeat(90) })).client_nom.length, 60, 'nom borné');
  assert.equal(apercuCommande(cmd({ client: null })).client_nom, '');
  const t = JSON.stringify(a); for (const x of ['0600000000', 'fictif@', 'rue Fictive']) assert.ok(!t.includes(x), x);
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
  assert.equal(ACTIONS.length, 27); for (const a of ACTIONS) assert.ok(['N1', 'N2', 'N3'].includes(NIVEAUX[a]), a);
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
  assert.equal(f.client_nom, 'Client Fictif');
  const t = JSON.stringify(f); for (const x of ['0600000000', 'fictif@', 'rue Fictive']) assert.ok(!t.includes(x), x);
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
  // v2.12 : une commande « absent » (client absent au passage du livreur) déplacée vers une autre date passe à « reporté ».
  assert.equal(champsPlanification({ action: 'deplacer', date: '2026-10-28' }, cmd({ statut: 'absent', date_livraison: '2026-10-27' }), T).statut, 'reporté', 'absent du jour → demain : reporté');
  assert.equal(champsPlanification({ action: 'deplacer', date: '2026-11-03' }, cmd({ statut: 'absent', date_livraison: '2026-10-30' }), T).statut, 'reporté', 'absent à une date à venir, déplacé : reporté');
  assert.ok(!('statut' in champsPlanification({ action: 'deplacer', date: '2026-10-27' }, cmd({ statut: 'absent', date_livraison: '2026-10-27' }), T)), 'même date : rien ne change');
  assert.ok(!('statut' in champsPlanification({ action: 'planifier', date: '2026-10-28' }, cmd({ statut: 'absent', date_livraison: '2026-10-27' }), T)), 'planifier ne touche pas au statut');
  assert.ok(!('statut' in champsPlanification({ action: 'deplacer', date: '2026-10-28' }, cmd({ statut: 'en-attente', date_livraison: '2026-10-27' }), T)), 'les autres statuts : inchangé');
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
  assert.match(src, /\{ count: 'exact' \}\)\.limit\(d\.limite \|\| 30\);\r?\n\s*q = q\.not\('id', 'like', '#TEST%'\)/, 'mêmes exclusions dans lister_commandes');
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
  for (const [q, n] of [['Hamid', 'Ami'], ['Mathis', 'Mati'], ['Laurence Rubigny', 'Laurent Rubio'], ['Jean', 'Joan'], ['Paul', 'Raul'], ['Myriam Zeroual', 'Mario Zerbib'], ['Karim Dupont', 'Kerem Dupuis'], ['Karim', 'Kerem'], ['Malik', 'Melek'], ['Salim', 'Selma'], ['Martin', 'Morton'], ['Salem', 'Slim'], ['Myriam', 'Meryem']])
    assert.ok(!ok(q, n), q + ' ≠ ' + n);
  const res = rechercheApprochee('Myriam Zeroual', [{ client: 'Jean Martin' }, { client: 'Meryem zaroual' }, { client: 'Myriam Durand' }]);
  assert.deepEqual(res.map((x) => x.client), ['Meryem zaroual']);
});

test('v2.10 suivi_gls : lecture seule, colis par colis, heure de Paris, aucune donnée client', () => {
  assert.equal(NIVEAUX.suivi_gls, 'N1');
  assert.equal(controlerDemande({ action: 'suivi_gls', cmdId: '#1897' }, T), null);
  assert.match(controlerDemande({ action: 'suivi_gls' }, T), /numéro de commande/);
  const x = { cmdId: '#1897', etat_gls: 'transit', detail: 'en transit', date_livraison_gls: null, colis: [
    { trackId: '00LDFKFH', etat: 'transit', motif: 'en transit (dernier scan 16/10)', priseEnCharge: '2026-10-16T08:12:00Z', livreClient: null, retour: null, dernier: '2026-10-16T08:12:00Z', dernierLibelle: 'The parcel has been handed over to GLS.' },
    { trackId: '00LDFKGF', etat: 'sans-scan', motif: 'aucun scan', priseEnCharge: null, livreClient: null, retour: null, dernier: '2026-10-15T10:30:00Z', dernierLibelle: 'DATA_RECEIVED', client: 'NE DOIT PAS SORTIR' } ] };
  const r = resumeSuivi(x);
  assert.equal(r.pris_en_charge, false, 'un colis sur deux seulement');
  assert.equal(r.colis[0].pris_en_charge, '16/10/2026 10:12'); assert.equal(r.colis[1].pris_en_charge, null);
  assert.equal(r.colis[0].dernier_libelle, 'The parcel has been handed over to GLS.');
  assert.equal(JSON.stringify(r).includes('NE DOIT PAS SORTIR'), false);
  assert.match(resumeSuivi(undefined).erreur, /introuvable/);
  // relecture (majeur) : panne GLS ≠ « pas pris en charge »
  assert.match(resumeSuivi({ etat_gls: 'erreur', colis: [{ trackId: 'A', etat: 'erreur' }, { trackId: 'B', etat: 'erreur' }] }).erreur, /GLS ne répond pas/);
  const part = resumeSuivi({ etat_gls: 'erreur', colis: [{ trackId: 'A', etat: 'transit', priseEnCharge: '2026-10-16T08:12:00Z' }, { trackId: 'B', etat: 'erreur' }] });
  assert.equal(part.pris_en_charge, null); assert.equal(part.lecture_partielle, true); assert.equal(part.colis[1].pris_en_charge, null); assert.match(part.colis[1].detail, /lecture GLS impossible/);
  const src = fs.readFileSync(new URL('../functions/jarvis-action/index.ts', import.meta.url), 'utf8');
  assert.match(src, /interne\('gls-sync', \{ cmdIds: \[String\(c!\.id\)\] \}\)/); assert.match(src, /r\.j\?\.lectureSeule !== true/);
});

test('v2.13 sms_statut : lecture seule, deux journaux, jamais texte / téléphone / nom, « aucune trace » ≠ « non envoyé »', () => {
  assert.equal(NIVEAUX.sms_statut, 'N1'); assert.equal(niveauDe({ action: 'sms_statut', cmdId: '#1897' }), 'N1');
  assert.equal(controlerDemande({ action: 'sms_statut', cmdId: '#1897' }, T), null);
  assert.match(controlerDemande({ action: 'sms_statut' }, T), /numéro de commande/);
  const c = cmd({ sms_envoyes: [{ type: 'confirmation', at: '2026-11-10T08:05:00Z' }, { type: 'veille', at: '2026-11-12T16:30:00Z' }, { type: '', at: 'x' }, { type: 'bidon', at: 'pas une date' }] });
  const lignes = [
    { type_sms: 'confirmation', statut: 'envoyé', date_sms: '2026-11-10', heure: '09:05', msg: 'TEXTE SECRET', tel: '0600000000', client: 'NOM SECRET' }, // doublon du journal de la commande
    { type_sms: 'relance', statut: 'échec', date_sms: '2026-11-13', heure: '10:02', msg: 'TEXTE SECRET' },
    { type_sms: 'manuel', statut: 'envoyé', date_sms: '2026-11-13', heure: '11:00:12' },
  ];
  const r = resumeSms(c, lignes);
  assert.equal(r.sms.length, 4);
  assert.deepEqual(r.sms[0], { type: 'veille', quand: '12/11/2026 17:30', statut: 'envoyé', source: 'journal de la commande' }, 'heure exacte convertie en Paris, plus récent d’abord');
  assert.equal(r.sms[1].quand, '10/11/2026 09:05');
  assert.deepEqual(r.sms[2], { type: 'relance', quand: '13/11/2026 10:02 (heure indicative)', statut: 'échec', source: 'journal par numéro de téléphone (peut mélanger plusieurs commandes du même client)' });
  assert.equal(r.sms[3].quand, '13/11/2026 11:00 (heure indicative)'); assert.equal(r.sms[3].statut, 'envoyé');
  const brut = JSON.stringify(r);
  for (const interdit of ['TEXTE SECRET', 'NOM SECRET', '0600000000', 'Client Fictif']) assert.equal(brut.includes(interdit), false, interdit);
  assert.equal(r.message, undefined); assert.equal(r.note_journal_general, undefined);
  // rien : message prudent, jamais « non envoyé »
  const v = resumeSms(cmd({}), []); assert.deepEqual(v.sms, []); assert.match(v.message, /aucune trace enregistrée/); assert.equal(/non envoy/i.test(v.message), false);
  // journal général illisible : on ne plante pas, journal de la commande seul + mention
  const p = resumeSms(c, null); assert.equal(p.sms.length, 2); assert.match(p.note_journal_general, /journal général indisponible/);
  const p0 = resumeSms(cmd({}), null); assert.match(p0.message, /aucune trace/); assert.match(p0.note_journal_general, /indisponible/);
  // entrées illisibles ignorées, statut inconnu conservé tel quel (court), pas de plantage sur null
  assert.doesNotThrow(() => resumeSms(null, [null, {}, { type_sms: 'x' }]));
  assert.equal(resumeSms(cmd({}), [{ type_sms: 'x', statut: 'Échec', date_sms: '2026-11-01' }]).sms[0].statut, 'échec');
  // sources : lecture seule, colonnes limitées (ni msg, ni tel, ni client), aucun envoi
  const src = fs.readFileSync(new URL('../functions/jarvis-action/index.ts', import.meta.url), 'utf8');
  const bloc = src.slice(src.indexOf("d.action === 'sms_statut'"), src.indexOf("d.action === 'lien_facture'"));
  assert.match(bloc, /lire\('type_sms, statut, date_sms, heure, cmd_id'\)/); assert.match(bloc, /lire\('type_sms, statut, date_sms, heure'\)/, 'repli sans la colonne cmd_id (migration 038 non appliquée)');   // jamais msg, tel ni client
  assert.equal(/\.(insert|update|upsert|delete)\(|interne\(|ovh|brevo|fetch\(/i.test(bloc), false, 'aucune écriture ni appel externe');
});

test('v2.14 credits_sms : N1, sans cmdId, état ok / bas / zéro / indisponible, jamais un faux « ok », rien de sensible, lecture seule', () => {
  assert.equal(NIVEAUX.credits_sms, 'N1'); assert.equal(niveauDe({ action: 'credits_sms' }), 'N1');
  assert.equal(controlerDemande({ action: 'credits_sms' }, T), null, 'cmdId non requis');
  assert.equal(controlerCommande({ action: 'credits_sms' }, null), null, 'pas de commande à trouver');
  assert.ok(ACTIONS.includes('credits_sms'));
  const ok = (data, http = 200) => ({ http, data, service: 'sms-rw88345-1' });
  const a = resumeCredits(ok({ creditsLeft: 540 })); assert.equal(a.etat, 'ok'); assert.equal(a.credits, 540); assert.equal(a.compte, 'sms-rw88345-1'); assert.equal(a.seuil, SEUIL_CREDITS_SMS_BAS);
  const b = resumeCredits(ok({ creditsLeft: 42 })); assert.equal(b.etat, 'bas'); assert.match(b.message, /sms-rw88345-1/); assert.match(b.message, /MAXICONFORT/); assert.match(b.message, /-2 ni -3/);
  assert.equal(resumeCredits(ok({ creditsLeft: SEUIL_CREDITS_SMS_BAS })).etat, 'ok', 'le seuil lui-même est encore ok');
  assert.equal(resumeCredits(ok({ creditsLeft: SEUIL_CREDITS_SMS_BAS - 1 })).etat, 'bas');
  const z = resumeCredits(ok({ creditsLeft: 0 })); assert.equal(z.etat, 'zero'); assert.equal(z.credits, 0); assert.match(z.message, /ne partent plus/);
  assert.equal(resumeCredits(ok({ creditsLeft: 7 }), 5).etat, 'ok', 'seuil paramétrable');
  assert.equal(resumeCredits(ok({ creditsLeft: 7 }), -3).seuil, SEUIL_CREDITS_SMS_BAS, 'seuil invalide : défaut');
  // indisponible : jamais « ok », jamais de crédits inventés
  for (const brut of [null, undefined, { http: null, data: null, service: 'sms-rw88345-1' }, ok({ creditsLeft: 540 }, 403), ok({ creditsLeft: 540 }, 500), ok(null), ok({}), ok('x'), ok({ creditsLeft: '540' }), ok({ creditsLeft: NaN }), ok({ creditsLeft: -4 }), ok({ creditsLeft: null })]) {
    const r = resumeCredits(brut); assert.equal(r.etat, 'indisponible', JSON.stringify(brut)); assert.equal(r.credits, undefined); assert.match(r.message, /solde indisponible/); assert.match(r.message, /ne pas en conclure/);
  }
  // nom de service douteux : omis ; rien de sensible ne ressort d'une réponse OVH riche
  assert.equal(resumeCredits({ http: 200, data: { creditsLeft: 300 }, service: 'x; secret' }).compte, undefined);
  const riche = resumeCredits(ok({ creditsLeft: 300, name: 'sms-rw88345-1', description: 'DESC SECRETE', senders: ['MAXICONFORT'], smsResponse: { cgiUrl: 'https://SECRET' }, userQuantityWithQuota: 9, creditThresholdForAutomaticRecredit: 5 }));
  const brut = JSON.stringify(riche);
  for (const interdit of ['DESC SECRETE', 'SECRET', 'senders', 'cgiUrl', 'creditThreshold']) assert.equal(brut.includes(interdit), false, interdit);
  assert.deepEqual(Object.keys(riche).sort(), ['compte', 'credits', 'etat', 'message', 'seuil']);
  // sources : branche N1 en lecture seule (GET OVH via lireCompteSmsOVH), aucun envoi ni écriture
  const src = fs.readFileSync(new URL('../functions/jarvis-action/index.ts', import.meta.url), 'utf8');
  const bloc = src.slice(src.indexOf("d.action === 'credits_sms'"), src.indexOf("d.action === 'sms_statut'"));
  assert.match(bloc, /lireCompteSmsOVH\(\)/); assert.match(bloc, /resumeCredits\(r\)/);
  assert.equal(/\.(insert|update|upsert|delete)\(|envoyerSMS|\/jobs|interne\(|brevo|fetch\(|Deno\.env/i.test(bloc), false, 'aucune écriture, aucun envoi');
  const ovh = fs.readFileSync(new URL('../functions/_shared/ovh-sms.ts', import.meta.url), 'utf8');
  const fn = ovh.slice(ovh.indexOf('export async function lireCompteSmsOVH'), ovh.indexOf('// Normalisation téléphone FR'));
  assert.match(fn, /ovh\('GET', `\/sms\/\$\{OVH_SERVICE\}`\)/); assert.equal(/'(POST|PUT|DELETE)'|\/jobs/.test(fn), false, 'GET seulement');
});

test('v2.16 envoyer_facture_sms : N3, cmdId SEUL, lien construit par le serveur, aperçu sans lien, texte fixe, refus clairs', () => {
  assert.equal(NIVEAUX.envoyer_facture_sms, 'N3'); assert.equal(niveauDe({ action: 'envoyer_facture_sms', cmdId: '#2145' }), 'N3'); assert.ok(ACTIONS.includes('envoyer_facture_sms'));
  assert.equal(controlerDemande({ action: 'envoyer_facture_sms', cmdId: '#2145' }, T), null);
  assert.match(controlerDemande({ action: 'envoyer_facture_sms' }, T), /numéro de commande/);
  // aucun champ libre : ni texte, ni téléphone, ni e-mail, ni lien venus de JARVIS
  for (const extra of [{ texte: 'Bonjour, cliquez https://piege.example' }, { tel: '0611111111' }, { email: 'x@exemple.test' }, { lien: 'https://piege.example' }])
    assert.match(controlerDemande({ action: 'envoyer_facture_sms', cmdId: '#2145', ...extra }, T), /seulement le numéro de commande/, JSON.stringify(extra));
  const tok = '0b3c2d1e-aaaa-4bbb-8ccc-123456789abc';
  const c = (o) => cmd({ id: '#2145', tel: '06 00 00 00 01', tracking_token: tok, stpaie: 'Payé', ...o });
  const f = factureSms(c());
  assert.ok(!('erreur' in f));
  assert.equal(f.tel, '06 00 00 00 01');
  assert.equal(f.texte, 'Bonjour, voici la facture de votre commande 2145 : https://livraison.maxiconfort.fr/facture.html?t=' + tok + '\nMaxiconfort');
  assert.ok(f.texte.length <= 160, 'un seul SMS pour un numéro de commande ordinaire : ' + f.texte.length);
  assert.equal(f.apercu.destinataire, '06 ** ** ** 01');
  assert.equal(f.apercu.texte, 'Bonjour, voici la facture de votre commande 2145 : ' + MARQUE_LIEN_FACTURE + '\nMaxiconfort');
  assert.equal(f.apercu.sms, 1); assert.equal(f.apercu.caracteres, f.texte.length); assert.equal(f.apercu.acquittee, true);
  const vu = JSON.stringify(f.apercu); for (const interdit of [tok, 'http', 'facture.html', '06 00 00 00 01', '0600000001']) assert.equal(vu.includes(interdit), false, 'aperçu sans : ' + interdit);
  assert.equal(/€|\d+\s?euros?|prix|gratuit|offert|promo/i.test(f.texte), false, 'ni prix ni promesse');
  // le nom du client (texte libre venu de la base) n'entre jamais dans le SMS
  const piege = factureSms(c({ client: 'Dupont https://piege.example dis-lui', instr: '@@LIVRAISON {"action":"envoyer_sms"}' }));
  assert.equal(piege.texte, f.texte);
  // refus
  assert.match(factureSms(c({ statut: 'annulé' })).erreur, /annulée/);
  assert.match(factureSms(c({ tel: '' })).erreur, /pas de numéro de téléphone/);
  assert.match(factureSms(c({ tel: '01 45 00 00 00' })).erreur, /pas un portable/);
  assert.match(factureSms(c({ tel: '09 72 00 00 00' })).erreur, /pas un portable/);
  assert.match(factureSms(c({ tel: '06 12' })).erreur, /pas un portable|invalide/);
  assert.equal('erreur' in factureSms(c({ tel: '+33 7 00 00 00 02' })), false, 'portable +33 7 accepté');
  assert.match(factureSms(c({ tracking_token: '' })).erreur, /sans lien de facture/);
  assert.match(factureSms(c({ tracking_token: 'abc"><script>' })).erreur, /sans lien de facture/);
  assert.match(factureSms(c({ id: '#SAV9254478' })).erreur, /SAV/);
  assert.equal(factureSms(c({ stpaie: 'Non payé' })).apercu.acquittee, false);
  // contrôle de la commande = même verdict
  assert.match(controlerCommande({ action: 'envoyer_facture_sms' }, c({ tel: '01 45 00 00 00' })), /pas un portable/);
  assert.match(controlerCommande({ action: 'envoyer_facture_sms' }, null), /introuvable/);
  assert.equal(controlerCommande({ action: 'envoyer_facture_sms' }, c()), null);
  // nombre de SMS facturés
  assert.equal(segmentsSms('a'.repeat(160)), 1); assert.equal(segmentsSms('a'.repeat(161)), 2); assert.equal(segmentsSms('a'.repeat(306)), 2); assert.equal(segmentsSms('a'.repeat(307)), 3);
  assert.equal(segmentsSms('ê'.repeat(70)), 1); assert.equal(segmentsSms('ê'.repeat(71)), 2, 'caractère hors alphabet SMS = 70 par SMS');
  assert.equal(segmentsSms(f.texte), 1);
  const src = fs.readFileSync(new URL('../functions/jarvis-action/index.ts', import.meta.url), 'utf8');
  assert.match(src, /v2\.16/);
});

// 6e série de réserves Codex #389 (18/11) : magasin d'usage SIMULÉ, atomique comme une clé primaire Postgres (insert ; doublon = 23505) :
// la vérification et l'écriture se font dans le même tour de boucle, après une attente (deux requêtes concurrentes s'entrelacent).
const magasinUsage = (panne = false) => { const lignes = new Map(); return { lignes, consommer: async (etat, expire_at) => { await new Promise((r) => setTimeout(r, 1)); if (panne) return 'erreur'; if (lignes.has(etat)) return 'deja'; lignes.set(etat, expire_at); return 'ok'; } }; };
const AUTORISATION_FORME = /^[0-9a-f]{32}\.\d{13}\.[0-9a-f]{64}$/;

// Réserve Codex #389 (17/11) : la branche d'envoi n'était testée que par recherche de texte. Elle est extraite dans
// _shared/jarvis-facture-sms.ts (actionFactureSms) et testée ici avec des dépendances simulées : aucun réseau, aucun SMS réel.
test('v2.16 actionFactureSms : aperçu = zéro envoi ; refus = zéro envoi ; confirmé = un seul send-sms ; échec = 502 ; jamais de lien', async () => {
  const tok = '0b3c2d1e-aaaa-4bbb-8ccc-123456789abc';
  const c = (o) => cmd({ id: '#2145', tel: '06 00 00 00 01', tracking_token: tok, stpaie: 'Payé', ...o });
  const deps = (succes = true) => { const appels = []; return { appels, cle: 'cle-de-test-fictive', ...magasinUsage(), interne: async (nom, corps) => { appels.push({ nom, corps }); return succes ? { http: 200, j: { success: true } } : { http: 500, j: { success: false } }; }, rep: (code, o) => ({ code, o: { version: VERSION, ...o } }) }; };
  const base = (cc, confirme) => ({ ok: true, action: 'envoyer_facture_sms', niveau: 'N3', confirme, commande: apercuCommande(cc) });
  const sansLien = (r) => { const t = JSON.stringify(r); assert.equal(/http|facture\.html/.test(t), false, t); assert.equal(t.includes(tok), false, t); assert.equal(t.includes('06 00 00 00 01'), false, t); };
  // aperçu : aucun envoi
  let d = deps(); let r = await actionFactureSms(c(), false, base(c(), false), d);
  assert.equal(r.code, 200); assert.equal(d.appels.length, 0); assert.equal(r.o.sms.destinataire, '06 ** ** ** 01'); assert.equal(r.o.fait, undefined); sansLien(r);
  assert.equal(r.o.empreinte, undefined, '6e série : plus d’empreinte déterministe');
  const autorisation = r.o.autorisation; assert.match(autorisation, AUTORISATION_FORME, 'l’aperçu porte l’autorisation à usage unique à renvoyer');
  // refus (commande sans téléphone, annulée, fixe) : 422, aucun envoi, même avec confirme:true
  for (const [o, motif] of [[{ tel: '' }, /pas de numéro de téléphone/], [{ statut: 'annulé' }, /annulée/], [{ tel: '01 45 00 00 00' }, /pas un portable/]]) {
    for (const conf of [false, true]) { d = deps(); r = await actionFactureSms(c(o), conf, base(c(o), conf), d); assert.equal(r.code, 422); assert.equal(r.o.ok, false); assert.match(r.o.erreur, motif); assert.equal(d.appels.length, 0, JSON.stringify(o)); sansLien(r); }
  }
  // confirmé : UN seul appel send-sms, destinataire et message issus de la commande
  d = deps(); r = await actionFactureSms(c(), true, base(c(), true), d, autorisation);
  assert.equal(r.code, 200); assert.equal(r.o.fait, true); assert.equal(d.appels.length, 1);
  assert.equal(d.appels[0].nom, 'send-sms');
  assert.deepEqual(Object.keys(d.appels[0].corps).sort(), ['client', 'cmdId', 'message', 'tel', 'type']);
  assert.equal(d.appels[0].corps.tel, '06 00 00 00 01'); assert.equal(d.appels[0].corps.type, 'jarvis'); assert.equal(d.appels[0].corps.client, 'Client Fictif');
  assert.ok(d.appels[0].corps.message.startsWith('Bonjour, voici la facture de votre commande 2145 : '), d.appels[0].corps.message);
  assert.ok(d.appels[0].corps.message.includes('facture.html?t=' + tok), 'le lien réel part seulement vers send-sms');
  sansLien(r);
  // send-sms en échec : 502, un seul appel, pas de « fait »
  d = deps(false); r = await actionFactureSms(c(), true, base(c(), true), d, autorisation);
  assert.equal(r.code, 502); assert.equal(r.o.ok, false); assert.match(r.o.erreur, /SMS non envoyé \(HTTP 500\)/); assert.equal(r.o.fait, undefined); assert.equal(d.appels.length, 1); sansLien(r);
  // revue Codex #21 (P2) : envoi INDÉTERMINÉ (success:false + indetermine:true, ou succès illisible marqué indetermine) : jamais « non envoyé » ni « fait »
  for (const j of [{ success: false, indetermine: true }, { success: true, indetermine: true }]) {
    d = deps(); d.interne = async (nom, corps) => { d.appels.push({ nom, corps }); return { http: 200, j }; };
    r = await actionFactureSms(c(), true, base(c(), true), d, autorisation);
    assert.equal(r.code, 502); assert.match(r.o.erreur, /INDÉTERMINÉ/); assert.doesNotMatch(r.o.erreur, /non envoyé/); assert.equal(r.o.fait, undefined); assert.equal(d.appels.length, 1); sansLien(r);
  }
  // historique non écrit : signalé, à l'échec comme au succès
  d = deps(); d.interne = async (nom, corps) => { d.appels.push({ nom, corps }); return { http: 200, j: { success: true, journal_echoue: true } }; };
  r = await actionFactureSms(c(), true, base(c(), true), d, autorisation);
  assert.equal(r.code, 200); assert.equal(r.o.fait, true); assert.equal(r.o.journal_echoue, true); assert.match(r.o.avertissement, /historique SMS/);
  // index.ts délègue bien à ce gestionnaire (même logique, rien d'autre dans la branche)
  const src = fs.readFileSync(new URL('../functions/jarvis-action/index.ts', import.meta.url), 'utf8');
  assert.match(src, /if \(d\.action === 'envoyer_facture_sms'\) return actionFactureSms\(c!, confirme, base, \{ interne, rep, cle: SECRET_JARVIS, consommer: consommerUsageFacture \}, d\.autorisation\);/);
});

// Réserve Codex #389 (2e série, 17/11) : l'aperçu et la confirmation sont LIÉS ; 6e série (18/11) : le lien est une AUTORISATION signée
// (HMAC-SHA256, clé JARVIS_ACTION_SECRET) de nonce aléatoire + expiration + téléphone + lien + texte. Commande changée = 409, zéro envoi.
test('v2.16 autorisation : aperçu ↔ confirmation liés ; téléphone ou jeton changé, autorisation absente, falsifiée ou d’une autre clé = 409 et zéro envoi', async () => {
  const { autorisationFacture, ERREUR_EMPREINTE, ERREUR_AUTORISATION } = await import('../functions/_shared/jarvis-facture-sms.ts');
  const CLE = 'cle-de-test-fictive'; const tok = '0b3c2d1e-aaaa-4bbb-8ccc-123456789abc';
  const c = (o) => cmd({ id: '#2145', tel: '06 00 00 00 01', tracking_token: tok, stpaie: 'Payé', ...o });
  const deps = () => { const appels = []; return { appels, cle: CLE, ...magasinUsage(), interne: async (nom, corps) => { appels.push({ nom, corps }); return { http: 200, j: { success: true } }; }, rep: (code, o) => ({ code, o: { version: VERSION, ...o } }) }; };
  const base = (cc, confirme) => ({ ok: true, action: 'envoyer_facture_sms', niveau: 'N3', confirme, commande: apercuCommande(cc) });
  const A = 'a'.repeat(32) + '.1795000000000.' + 'b'.repeat(64);
  // forme stricte dans controlerDemande ; l'ancien champ « empreinte » est refusé
  assert.equal(controlerDemande({ action: 'envoyer_facture_sms', cmdId: '#2145', autorisation: A }, T), null);
  for (const e of [A.toUpperCase(), A.slice(1), A + '0', A.replace('.', ''), 'a'.repeat(32) + '.179500000000.' + 'b'.repeat(64), 123, [A], ''])
    assert.match(controlerDemande({ action: 'envoyer_facture_sms', cmdId: '#2145', autorisation: e }, T), /autorisation/, JSON.stringify(e));
  assert.match(controlerDemande({ action: 'envoyer_facture_sms', cmdId: '#2145', empreinte: '0123456789abcdef' }, T), /autorisation/);
  // aperçu : l'autorisation est renvoyée, aucun envoi, AUCUNE écriture (rien n'est consommé à l'aperçu)
  let d = deps(); const ap = await actionFactureSms(c(), false, base(c(), false), d);
  assert.equal(ap.code, 200); assert.match(ap.o.autorisation, AUTORISATION_FORME); assert.equal(d.appels.length, 0); assert.equal(d.lignes.size, 0);
  // deux aperçus de la même commande : deux autorisations DIFFÉRENTES (nonce aléatoire)
  assert.notEqual((await actionFactureSms(c(), false, base(c(), false), deps())).o.autorisation, ap.o.autorisation);
  // signature dépendante de la clé
  const [n, x] = ap.o.autorisation.split('.'); const f = factureSms(c());
  assert.equal(ap.o.autorisation.split('.')[2], await autorisationFacture(CLE, n, Number(x), f.tel, f.lien, f.texte));
  assert.notEqual(ap.o.autorisation.split('.')[2], await autorisationFacture('autre-cle', n, Number(x), f.tel, f.lien, f.texte));
  // téléphone changé (06 → 07) entre l'aperçu et la confirmation : 409, zéro send-sms, rien consommé
  d = deps(); let r = await actionFactureSms(c({ tel: '07 00 00 00 01' }), true, base(c({ tel: '07 00 00 00 01' }), true), d, ap.o.autorisation);
  assert.equal(r.code, 409); assert.equal(r.o.ok, false); assert.equal(r.o.erreur, ERREUR_EMPREINTE); assert.equal(d.appels.length, 0); assert.equal(d.lignes.size, 0);
  assert.equal(ERREUR_EMPREINTE, 'la commande a changé depuis l’aperçu (numéro ou lien) : refais l’aperçu, rien n’est parti');
  // jeton changé : 409, zéro envoi
  d = deps(); r = await actionFactureSms(c({ tracking_token: 'ffffffff-aaaa-4bbb-8ccc-123456789abc' }), true, base(c(), true), d, ap.o.autorisation);
  assert.equal(r.code, 409); assert.equal(d.appels.length, 0);
  // absente / falsifiée (bonne forme) / signée d'une autre clé / expiration prolongée à la main : 409, zéro envoi, rien consommé
  const autreCle = n + '.' + x + '.' + await autorisationFacture('autre-cle', n, Number(x), f.tel, f.lien, f.texte);
  const prolongee = n + '.' + String(Number(x) + 3600000) + '.' + ap.o.autorisation.split('.')[2];
  for (const e of [undefined, null, '', A, autreCle, prolongee]) {
    d = deps(); r = await actionFactureSms(c(), true, base(c(), true), d, e); assert.equal(r.code, 409, String(e)); assert.ok([ERREUR_EMPREINTE, ERREUR_AUTORISATION].includes(r.o.erreur), String(e)); assert.equal(d.appels.length, 0, String(e)); assert.equal(d.lignes.size, 0, String(e));
  }
  // sans changement : UN seul send-sms, au bon numéro ; la réponse d'exécution ne renvoie pas l'autorisation
  d = deps(); r = await actionFactureSms(c(), true, base(c(), true), d, ap.o.autorisation);
  assert.equal(r.code, 200); assert.equal(r.o.fait, true); assert.equal(d.appels.length, 1); assert.equal(d.appels[0].corps.tel, '06 00 00 00 01'); assert.equal(r.o.autorisation, undefined);
  // index.ts : la clé est JARVIS_ACTION_SECRET et l'autorisation vient de la demande
  const src = fs.readFileSync(new URL('../functions/jarvis-action/index.ts', import.meta.url), 'utf8');
  assert.match(src, /if \(d\.action === 'envoyer_facture_sms'\) return actionFactureSms\(c!, confirme, base, \{ interne, rep, cle: SECRET_JARVIS, consommer: consommerUsageFacture \}, d\.autorisation\);/);
});

// 6e série de réserves Codex #389 (18/11) : une confirmation REJOUÉE (même autorisation) ne doit jamais renvoyer de SMS. L'autorisation
// expire 10 min après l'aperçu et elle est CONSOMMÉE atomiquement côté serveur (clé primaire de oauth_etats) AVANT send-sms.
test('v2.16 (6e série Codex) : autorisation à usage unique — rejeu = 409 et zéro send-sms ; expirée = 409 ; concurrence = un seul envoi ; verrou en panne = 503 sans envoi', async () => {
  const { ERREUR_AUTORISATION, ERREUR_VERROU, DUREE_AUTORISATION_MS, FOURNISSEUR_USAGE } = await import('../functions/_shared/jarvis-facture-sms.ts');
  assert.equal(DUREE_AUTORISATION_MS, 10 * 60 * 1000); assert.equal(FOURNISSEUR_USAGE, 'jarvis-facture-sms');
  assert.equal(ERREUR_AUTORISATION, 'autorisation déjà utilisée ou expirée : refais l’aperçu, rien n’est parti');
  const tok = '0b3c2d1e-aaaa-4bbb-8ccc-123456789abc'; const c = cmd({ id: '#2145', tel: '06 00 00 00 01', tracking_token: tok });
  const base = (confirme) => ({ ok: true, action: 'envoyer_facture_sms', niveau: 'N3', confirme, commande: apercuCommande(c) });
  let horloge = T;
  const mag = magasinUsage(); const appels = [];
  let compteurNonce = 0; const deps = { cle: 'cle-fictive', consommer: mag.consommer, maintenant: () => horloge, aleatoire: () => (++compteurNonce).toString(16).padStart(32, 'a'), rep: (code, o) => ({ code, o }),
    interne: async (nom, corps) => { appels.push({ nom, corps, deja: mag.lignes.size }); return { http: 200, j: { success: true } }; } };
  const ap = await actionFactureSms(c, false, base(false), deps); const A = ap.o.autorisation;
  assert.equal(Number(A.split('.')[1]), T + DUREE_AUTORISATION_MS, 'expiration = aperçu + 10 min');
  // 1re confirmation : un envoi, l'usage est enregistré AVANT send-sms
  let r = await actionFactureSms(c, true, base(true), deps, A);
  assert.equal(r.code, 200); assert.equal(appels.length, 1); assert.equal(appels[0].deja, 1, 'consommée avant l’envoi');
  assert.deepEqual([...mag.lignes.keys()], [FOURNISSEUR_USAGE + ':' + A.split('.')[0]], 'clé = fournisseur + nonce, jamais le lien ni le numéro');
  assert.equal(mag.lignes.get(FOURNISSEUR_USAGE + ':' + A.split('.')[0]), new Date(T + DUREE_AUTORISATION_MS).toISOString());
  // rejeu identique (même requête confirmée) : 409, ZÉRO nouveau send-sms — et encore après 1, 5 min
  for (const dt of [0, 60000, 5 * 60000]) { horloge = T + dt; r = await actionFactureSms(c, true, base(true), deps, A); assert.equal(r.code, 409, String(dt)); assert.equal(r.o.erreur, ERREUR_AUTORISATION); assert.equal(appels.length, 1, String(dt)); }
  // expirée (aperçu + 10 min + 1 ms), jamais utilisée : 409, zéro envoi, rien consommé
  horloge = T; const ap2 = await actionFactureSms(c, false, base(false), deps); const avant = mag.lignes.size;
  horloge = T + DUREE_AUTORISATION_MS + 1; r = await actionFactureSms(c, true, base(true), deps, ap2.o.autorisation);
  assert.equal(r.code, 409); assert.equal(r.o.erreur, ERREUR_AUTORISATION); assert.equal(appels.length, 1); assert.equal(mag.lignes.size, avant);
  // limite exacte : à aperçu + 10 min pile, encore valable
  horloge = T; const ap3 = await actionFactureSms(c, false, base(false), deps); horloge = T + DUREE_AUTORISATION_MS;
  r = await actionFactureSms(c, true, base(true), deps, ap3.o.autorisation); assert.equal(r.code, 200); assert.equal(appels.length, 2);
  // CONCURRENCE : 5 confirmations simultanées de la même autorisation → UN seul send-sms, 4 refus 409
  horloge = T; const ap4 = await actionFactureSms(c, false, base(false), deps); const n0 = appels.length;
  const rs = await Promise.all(Array.from({ length: 5 }, () => actionFactureSms(c, true, base(true), deps, ap4.o.autorisation)));
  assert.deepEqual(rs.map((x) => x.code).sort(), [200, 409, 409, 409, 409]); assert.equal(appels.length - n0, 1, 'un seul SMS en concurrence');
  // send-sms en échec APRÈS consommation : 502 ; la même autorisation ne peut pas être rejouée (refaire l'aperçu)
  const mag2 = magasinUsage(); let n = 0;
  const depsKo = { ...deps, consommer: mag2.consommer, interne: async () => { n++; return { http: 500, j: { success: false } }; } };
  const ap5 = await actionFactureSms(c, false, base(false), depsKo);
  assert.equal((await actionFactureSms(c, true, base(true), depsKo, ap5.o.autorisation)).code, 502); assert.equal(n, 1);
  r = await actionFactureSms(c, true, base(true), depsKo, ap5.o.autorisation); assert.equal(r.code, 409); assert.equal(n, 1);
  // verrou indisponible (base en panne) : 503, ZÉRO send-sms (jamais d'envoi sans usage enregistré)
  const mag3 = magasinUsage(true); let m = 0;
  const depsPanne = { ...deps, consommer: mag3.consommer, interne: async () => { m++; return { http: 200, j: { success: true } }; } };
  const ap6 = await actionFactureSms(c, false, base(false), depsPanne);
  r = await actionFactureSms(c, true, base(true), depsPanne, ap6.o.autorisation); assert.equal(r.code, 503); assert.equal(r.o.erreur, ERREUR_VERROU); assert.equal(m, 0);
  // consommer absent (mauvais câblage) : 503 sans envoi
  r = await actionFactureSms(c, true, base(true), { ...deps, consommer: undefined }, (await actionFactureSms(c, false, base(false), deps)).o.autorisation); assert.equal(r.code, 503); assert.equal(appels.length - n0, 1);
  // l'autorisation n'apparaît dans aucune réponse d'exécution ni de refus ; ni lien ni numéro dans l'autorisation
  assert.equal(JSON.stringify(rs).includes(ap4.o.autorisation), false); assert.match(A, AUTORISATION_FORME, 'forme stricte : 32 hex . 13 chiffres . 64 hex, donc aucun mot (http, facture) possible'); // seule la forme stricte est vérifiée : aucune assertion « ne contient pas <court> » sur du hasard (nonce injecté, 7e/8e séries Codex)
  // index.ts : consommation par INSERTION dans oauth_etats (clé primaire « etat », table existante, aucune migration), doublon 23505 = déjà utilisée
  const src = fs.readFileSync(new URL('../functions/jarvis-action/index.ts', import.meta.url), 'utf8');
  assert.match(src, /async function consommerUsageFacture\(etat: string, expire_at: string\)/);
  assert.match(src, /sb\.from\('oauth_etats'\)\.insert\(\{ etat, fournisseur: FOURNISSEUR_USAGE, expire_at, utilise_at: /);
  assert.match(src, /code === '23505' \? 'deja' : 'erreur'/);
});

// Réserve Codex #389 (3e série, 17/11) : le jeton accepté allait jusqu'à 128 caractères, l'aperçu annonçait « 147 caractères, 1 SMS »
// alors que le SMS pouvait en faire 2 ou 3. Le jeton est plafonné pour que le SMS tienne TOUJOURS en un seul SMS (160 caractères de
// l'alphabet SMS standard, numéro de commande de 9 chiffres compris) ; au-delà : refus 422, aucun envoi. Le comptage suit le vrai codage.
test('v2.16 (3e série Codex) : jeton plafonné — limite = 1 SMS, trop long = 422 et zéro envoi ; comptage de segments réel (GSM 7 bits / UCS-2)', async () => {
  const { JETON_FACTURE_MAX, mesureSms } = await import('../functions/_shared/jarvis-action-logique.ts');
  assert.equal(typeof JETON_FACTURE_MAX, 'number');
  // la limite se déduit du texte fixe : 9 chiffres de commande + jeton maximal = 160 caractères exactement
  const fixe = factureSms(cmd({ id: '#123456789', tel: '06 00 00 00 01', tracking_token: 'a'.repeat(8) }));
  assert.equal(JETON_FACTURE_MAX, 160 - (fixe.texte.length - 8), 'plafond calculé, pas choisi au hasard');
  assert.ok(JETON_FACTURE_MAX >= 36, 'un jeton UUID (36) passe toujours');
  for (const id of ['#1', '#2145', '#123456789']) {
    const lim = factureSms(cmd({ id, tel: '06 00 00 00 01', tracking_token: 'A1-_'.repeat(20).slice(0, JETON_FACTURE_MAX) }));
    assert.ok(!('erreur' in lim), id); assert.ok(lim.texte.length <= 160, id + ' : ' + lim.texte.length);
    assert.equal(lim.apercu.sms, 1, id); assert.equal(lim.apercu.caracteres, lim.texte.length, id);
  }
  const TROP = 'refus : lien de la facture trop long pour tenir dans un seul SMS : rien n’est parti, envoie la facture par e-mail';
  for (const n of [JETON_FACTURE_MAX + 1, 64, 128, 500]) {
    const r = factureSms(cmd({ id: '#2145', tel: '06 00 00 00 01', tracking_token: 'b'.repeat(n) }));
    assert.equal(r.erreur, TROP.replace(/^refus : /, ''), String(n));
    for (const conf of [false, true]) {
      const appels = []; const c = cmd({ id: '#2145', tel: '06 00 00 00 01', tracking_token: 'b'.repeat(n) });
      const x = await actionFactureSms(c, conf, { ok: true, action: 'envoyer_facture_sms', niveau: 'N3', confirme: conf, commande: apercuCommande(c) },
        { cle: 'cle-fictive', interne: async (nom, corps) => { appels.push({ nom, corps }); return { http: 200, j: { success: true } }; }, rep: (code, o) => ({ code, o }), ...magasinUsage() }, 'a'.repeat(32) + '.1795000000000.' + 'b'.repeat(64));
      assert.equal(x.code, 422, n + ' ' + conf); assert.equal(x.o.erreur, TROP.replace(/^refus : /, '')); assert.equal(appels.length, 0, 'aucun envoi : ' + n);
      assert.equal(JSON.stringify(x).includes('b'.repeat(20)), false, 'jeton jamais renvoyé');
    }
    assert.match(controlerCommande({ action: 'envoyer_facture_sms' }, cmd({ id: '#2145', tel: '06 00 00 00 01', tracking_token: 'b'.repeat(n) })), /trop long/);
  }
  assert.match(factureSms(cmd({ id: '#2145', tel: '06 00 00 00 01', tracking_token: 'b'.repeat(7) })).erreur, /sans lien de facture/, 'trop court : refus inchangé');
  // comptage réel : GSM 7 bits (160 puis 153), extension € ^ { } [ ] ~ | \ = 2 caractères ; hors alphabet = UCS-2 (70 puis 67), emoji = 2
  assert.deepEqual(mesureSms('a'.repeat(160)), { codage: 'GSM-7', caracteres: 160, sms: 1 });
  assert.deepEqual(mesureSms('a'.repeat(161)), { codage: 'GSM-7', caracteres: 161, sms: 2 });
  assert.deepEqual(mesureSms('é'.repeat(160)), { codage: 'GSM-7', caracteres: 160, sms: 1 }, 'é est dans l’alphabet SMS');
  assert.deepEqual(mesureSms('€'.repeat(80)), { codage: 'GSM-7', caracteres: 160, sms: 1 }, '€ compte double');
  assert.deepEqual(mesureSms('€'.repeat(81)), { codage: 'GSM-7', caracteres: 162, sms: 2 });
  assert.deepEqual(mesureSms('Bonjour, votre commande est prête'), { codage: 'UCS-2', caracteres: 33, sms: 1 }, 'ê force l’UCS-2');
  assert.deepEqual(mesureSms('ç'.repeat(70)), { codage: 'UCS-2', caracteres: 70, sms: 1 });
  assert.deepEqual(mesureSms('a'.repeat(70) + 'ê'), { codage: 'UCS-2', caracteres: 71, sms: 2 });
  assert.deepEqual(mesureSms('😀'.repeat(35)), { codage: 'UCS-2', caracteres: 70, sms: 1 }, 'emoji = 2 unités');
  assert.deepEqual(mesureSms('a'.repeat(134) + 'ê'), { codage: 'UCS-2', caracteres: 135, sms: 3 }, '135 > 134 = 2 × 67');
  assert.equal(segmentsSms('€'.repeat(81)), 2); assert.equal(segmentsSms('a'.repeat(70) + 'ê'), 2);
  // l'aperçu annonce le vrai compte du texte RÉEL envoyé (pas de l'aperçu masqué)
  const f = factureSms(cmd({ id: '#2145', tel: '06 00 00 00 01', tracking_token: '0b3c2d1e-aaaa-4bbb-8ccc-123456789abc' }));
  assert.deepEqual([f.apercu.caracteres, f.apercu.sms], [mesureSms(f.texte).caracteres, 1]); assert.equal(mesureSms(f.texte).codage, 'GSM-7');
  // 3e série Codex, point 1 : la réponse de envoyer_facture_sms ne porte AUCUN champ libre de la commande (produit, nom, ville, transporteur)
  const c = cmd({ id: '#2145', tel: '06 00 00 00 01', tracking_token: '0b3c2d1e-aaaa-4bbb-8ccc-123456789abc', client: 'Ab3dEf9h', produit: 'abcdefgh', adresse: '1 rue X 93160 Ab3dEf9hXyZ', transporteur: 'abcdefghijkl' });
  for (const conf of [false, true]) {
    const dd = { cle: 'cle-fictive', ...magasinUsage(), interne: async () => ({ http: 200, j: { success: true } }), rep: (code, o) => ({ code, o }) };
    const ap = await actionFactureSms(c, false, { ok: true, action: 'envoyer_facture_sms', niveau: 'N3', confirme: false, commande: apercuCommande(c) }, dd);
    const x = conf ? await actionFactureSms(c, true, { ok: true, action: 'envoyer_facture_sms', niveau: 'N3', confirme: true, commande: apercuCommande(c) }, dd, ap.o.autorisation) : ap;
    assert.equal(x.code, 200); assert.deepEqual(Object.keys(x.o.commande).sort(), ['cmd', 'colis_suivis', 'cp', 'date_livraison', 'statut'], String(conf));
    for (const libre of ['Ab3dEf9h', 'abcdefgh', 'abcdefghijkl']) assert.equal(JSON.stringify(x).includes(libre), false, libre);
  }
});

test('revue Codex #20 : deux commandes du même client, même type, même jour → aucune ligne ne disparaît', () => {
  const c = cmd({ id: '#100', sms_envoyes: [{ type: 'veille', at: '2026-11-12T16:30:00Z' }] });
  const lignes = [
    { type_sms: 'veille', statut: 'envoyé', date_sms: '2026-11-12', heure: '17:31', cmd_id: '#101' }, // AUTRE commande : à garder
    { type_sms: 'veille', statut: 'envoyé', date_sms: '2026-11-12', heure: '17:30', cmd_id: '#100' }, // doublon du journal de la commande : écarté
  ];
  const r = resumeSms(c, lignes);
  assert.equal(r.sms.length, 2);
  assert.equal(r.sms.filter((s) => s.autre_commande === true && s.commande === '#101').length, 1);
});

test('revue Codex #20 : sans prevenir, indetermine et journal_echoue ne sont pas ignorés (source)', () => {
  const src = fs.readFileSync(new URL('../functions/jarvis-action/index.ts', import.meta.url), 'utf8');
  assert.match(src, /r\.j\?\.indetermine === true \|\| \(r\.j\?\.success !== true && !echecCertain\(r\)\)\) return rep\(502/);
  assert.match(src, /jE2 \? \{ journal_echoue: true/);
});

test('revue Codex #20 (P2) : indetermine examiné AVANT le retour « non envoyé » (success:false + indetermine:true)', () => {
  const src = fs.readFileSync(new URL('../functions/jarvis-action/index.ts', import.meta.url), 'utf8');
  const iInd = src.indexOf("r.j?.indetermine === true || (r.j?.success !== true && !echecCertain(r))) return rep(502");
  const iEchec = src.indexOf("if (!r.j?.success) return rep(502, { ok: false, erreur: 'SMS non envoyé (HTTP ' + r.http + ')' + nJ2");
  assert.ok(iInd > 0 && iEchec > 0 && iInd < iEchec, 'indéterminé avant échec générique');
});

test('revue Codex #21 (P2) : variantesTel couvre national, +33, 33, 0033 ; facture par SMS transmet cmdId', () => {
  for (const t of ['0612345678', '06 12 34 56 78', '+33612345678', '+33 6 12 34 56 78', '0033612345678', '33612345678']) {
    const v = variantesTel(t);
    for (const attendu of ['0612345678', '06 12 34 56 78', '+33612345678', '33612345678', '0033612345678', '+33 6 12 34 56 78']) assert.ok(v.includes(attendu), t + ' → ' + attendu);
  }
  assert.deepEqual(variantesTel(''), []); assert.deepEqual(variantesTel('abc'), ['abc']);
  const etr = variantesTel('+44 7700 900123'); assert.ok(etr.includes('+44 7700 900123') && etr.includes('447700900123') && etr.length === 2, 'numéro étranger : saisie + chiffres seuls');
  const src = fs.readFileSync(new URL('../functions/jarvis-action/index.ts', import.meta.url), 'utf8');
  assert.match(src, /\.in\('tel', variantesTel\(tel\)\)/);
});

test('revue Codex #21 (P2) : facture par SMS — réponse absente (j:null, 504) ou exception = INDÉTERMINÉ ; seul success:false explicite = non envoyé', async () => {
  const tok = '0b3c2d1e-aaaa-4bbb-8ccc-123456789abc';
  const c = () => cmd({ id: '#2145', tel: '06 00 00 00 01', tracking_token: tok, stpaie: 'Payé' });
  const base = (cc, confirme) => ({ ok: true, action: 'envoyer_facture_sms', niveau: 'N3', confirme, commande: apercuCommande(cc) });
  const mk = (interne) => ({ cle: 'cle-de-test-fictive', ...magasinUsage(), interne, rep: (code, o) => ({ code, o: { version: VERSION, ...o } }) });
  const ap = await actionFactureSms(c(), false, base(c(), false), mk(async () => ({ http: 200, j: { success: true } })));
  const aut = ap.o.autorisation; assert.match(aut, AUTORISATION_FORME);
  const cas = [
    ['504 sans réponse lisible', async () => ({ http: 504, j: null }), true],
    ['exception réseau', async () => { throw new Error('réseau'); }, true],
    ['indetermine explicite', async () => ({ http: 200, j: { success: false, indetermine: true } }), true],
    ['refus explicite success:false', async () => ({ http: 200, j: { success: false } }), false],
  ];
  for (const [nom, rep, indet] of cas) {
    const r = await actionFactureSms(c(), true, base(c(), true), mk(rep), aut);
    assert.equal(r.code, 502, nom); assert.equal(r.o.fait, undefined, nom);
    if (indet) { assert.match(r.o.erreur, /INDÉTERMINÉ/, nom); assert.doesNotMatch(r.o.erreur, /non envoyé/, nom); }
    else assert.match(r.o.erreur, /SMS non envoyé/, nom);
  }
  const src = fs.readFileSync(new URL('../functions/_shared/jarvis-facture-sms.ts', import.meta.url), 'utf8');
  assert.match(src, /catch \{ r = \{ http: 0, j: null \}; \}/);
  const idx = fs.readFileSync(new URL('../functions/jarvis-action/index.ts', import.meta.url), 'utf8');
  assert.match(idx, /r\.j\?\.success !== true && !echecCertain\(r\)/); assert.match(idx, /catch \{ r = \{ http: 0, j: null \}; \}/);
});

test('v2.17 comptage : TOUS les statuts réels comptés (en-route et arrivé compris) ; changer_statut inchangé', async () => {
  const L = await import('../functions/_shared/jarvis-action-logique.ts');
  for (const st of ['en-attente', 'en-route', 'arrivé', 'reporté', 'livré', 'annulé']) assert.ok(L.STATUTS_COMPTES.includes(st), st + ' compté');
  assert.ok(L.STATUTS_COMPTES_OUVERTS.includes('en-route') && L.STATUTS_COMPTES_OUVERTS.includes('arrivé'));
  assert.ok(!L.STATUTS_COMPTES_OUVERTS.includes('livré') && !L.STATUTS_COMPTES_OUVERTS.includes('annulé'), 'terminées jamais « ouvertes »');
  assert.equal(new Set(L.STATUTS_COMPTES).size, L.STATUTS_COMPTES.length, 'aucun doublon (sinon double comptage)');
  assert.deepEqual(L.STATUTS_COMPTES, [...L.STATUTS_COMPTES_OUVERTS, ...L.STATUTS_TERMINES]);
  // changer_statut : liste d'origine INCHANGÉE et toujours stricte
  assert.deepEqual(L.STATUTS_OUVERTS, ['en-attente', 'en-cours', 'reporté']);
  for (const st of ['en-route', 'arrivé', 'livré', 'annulé', '', 'inconnu']) assert.match(controlerDemande({ action: 'changer_statut', cmdId: '#1588', statut: st }, T), /statut autorisé/, st + ' refusé');
  for (const st of ['en-attente', 'en-cours', 'reporté']) assert.equal(controlerDemande({ action: 'changer_statut', cmdId: '#1588', statut: st }, T), null, st + ' accepté');
  // lecture : on peut FILTRER la liste sur en-route / arrivé, mais un statut inventé reste refusé
  assert.equal(controlerDemande({ action: 'lister_commandes', statut: 'en-route' }, T), null);
  assert.equal(controlerDemande({ action: 'lister_commandes', statut: 'arrivé' }, T), null);
  assert.match(controlerDemande({ action: 'lister_commandes', statut: 'inconnu' }, T), /statut inconnu/);
  // le comptage de la fonction utilise bien les constantes de comptage, plus STATUTS_OUVERTS
  const fs = await import('node:fs'); const src = fs.readFileSync(new URL('../functions/jarvis-action/index.ts', import.meta.url), 'utf8');
  const bloc = src.slice(src.indexOf("d.action === 'compter_commandes'"), src.indexOf("d.action === 'lire_stock'"));
  assert.match(bloc, /const statuts = STATUTS_COMPTES;/); assert.match(bloc, /STATUTS_COMPTES_OUVERTS\.reduce/);
  assert.doesNotMatch(src, /STATUTS_OUVERTS/, 'index.ts n’utilise plus la liste de changer_statut');
});

test('v2.18 : produit NON VENDABLE (prix de vente à définir, migration 039) — jamais rapproché, refusé dans une commande, ensemble compris', () => {
  const rows = [
    { id: 'pr-15', nom: 'Matelas DODOCONFORT 140×190×15', prix: 100, actif: true },
    { id: 'pr-new', nom: 'Matelas Hybride Fictif 140×190 – 25 cm', prix: null, actif: true, vendable: false, prix_vente_defini: false },
    { id: 'pr-ens', nom: 'Ensemble 140x190 Matelas Hybride Fictif + Sommier', prix: 300, actif: true, composants: [{ id: 'pr-new', qte: 1 }] },
    { id: 'pr-ok', nom: 'Ensemble 140x190 Matelas DODOCONFORT 15 + Sommier', prix: 250, actif: true, composants: [{ id: 'pr-15', qte: 1 }] },
  ];
  const cat = catalogueDepuisBase(rows);
  assert.equal(cat.get('pr-new').non_vendable, true);
  assert.equal(cat.get('pr-ens').non_vendable, true, 'ensemble dont un composant est non vendable');
  assert.equal(cat.get('pr-15').non_vendable, undefined);
  assert.equal(cat.get('pr-ok').non_vendable, undefined);
  assert.match(lignesCommande([{ produitId: 'pr-new', produit: 'x', qte: 1 }], cat).erreur, /pas encore vendable/);
  assert.match(lignesCommande([{ produitId: 'pr-ens', produit: 'x', qte: 1 }], cat).erreur, /pas encore vendable/);
  assert.match(lignesCommande([{ produit: 'Matelas Hybride Fictif 140×190 – 25 cm', qte: 1 }], cat).erreur, /pas encore vendable/, 'nom exact refusé aussi');
  assert.equal(produitProche('matelas hybride fictif 140x190', cat), null, 'jamais proposé par rapprochement');
  const ok = lignesCommande([{ produitId: 'pr-15', produit: 'x', qte: 2 }], cat);
  assert.equal(ok.erreur, null); assert.equal(ok.lignes[0].prixUnit, 100);
  // avant la migration 039 (colonnes absentes) : tout reste vendable, comme avant
  const avant = catalogueDepuisBase([{ id: 'a', nom: 'Matelas A', prix: 99 }]);
  assert.equal(avant.get('a').non_vendable, undefined); assert.equal(avant.get('a').actif, true);
});

test('v2.19 (revue Codex PR 26 sur 66def07) : catalogue JARVIS COMPLET au-delà du plafond, composant non vendable hors 1re page', async () => {
  // 1 500 produits FICTIFS ; l'ensemble est en 1re page, son composant non vendable (« zz-… ») trié en DERNIÈRE page
  const base = [{ id: 'a0000-ens', nom: 'Ensemble Fictif Z + Sommier', prix: 300, actif: true, composants: [{ id: 'zz-composant', qte: 1 }, { id: 'p0001', qte: 1 }] }];
  for (let n = 1; n < 1499; n++) base.push({ id: 'p' + String(n).padStart(4, '0'), nom: 'Produit fictif ' + n, prix: 10, actif: true });
  base.push({ id: 'zz-composant', nom: 'Matelas Fictif Z 140×190', prix: null, actif: true, vendable: false, prix_vente_defini: false });
  base.sort((x, y) => (x.id < y.id ? -1 : 1));
  const plafond = 1000; const pages = [];
  const lirePage = async (d, f) => { pages.push([d, f]); return base.slice(d, Math.min(f + 1, d + plafond)); };
  const lireParIds = async (ids) => base.filter((r) => ids.includes(r.id));
  const cat = await catalogueJarvis(lirePage, lireParIds);
  assert.equal(cat.size, 1500, 'tout le catalogue est lu');
  assert.ok(pages.length >= 2, 'plusieurs pages');
  assert.equal(cat.get('zz-composant').non_vendable, true);
  assert.equal(cat.get('a0000-ens').non_vendable, true, 'ensemble dont le composant (2e page) est non vendable');
  assert.match(lignesCommande([{ produitId: 'a0000-ens', produit: 'x', qte: 1 }], cat).erreur, /pas encore vendable/);
  // l'ancienne lecture (une seule requête plafonnée) laissait l'ensemble vendable : preuve que le test couvre bien le cas
  assert.equal(catalogueDepuisBase(base.slice(0, plafond)).get('a0000-ens').non_vendable, undefined);
  // nom dicté à la casse / aux espaces / au « × » près : reconnu comme le produit non vendable (jamais une ligne hors catalogue)
  assert.match(lignesCommande([{ produit: 'matelas fictif z 140 x 190', qte: 1 }], cat).erreur || '', /pas encore vendable/);
  // v2.20 (revue Codex sur 4ec0313) : identifiant d'un produit vendable + nom d'un produit non vendable = contradiction refusée ;
  // identifiant + son propre nom (ou sans nom) = accepté
  assert.match(lignesCommande([{ produitId: 'p0001', produit: 'Matelas Fictif Z 140 x 190', qte: 1 }], cat).erreur || '', /pas encore vendable/);
  assert.equal(lignesCommande([{ produitId: 'p0001', produit: 'produit fictif 1', qte: 1 }], cat).erreur, null);
  assert.equal(lignesCommande([{ produitId: 'p0001', qte: 1 }], cat).erreur, null);
  // lecture impossible : exception (jamais un catalogue partiel)
  await assert.rejects(catalogueJarvis(async () => { throw new Error('panne'); }, lireParIds));
  const src = fs.readFileSync(new URL('../functions/jarvis-action/index.ts', import.meta.url), 'utf8');
  assert.match(src, /return await catalogueJarvis\(/);
  assert.match(src, /\.select\('\*'\)\.order\('id'\)\.range\(debut, fin\)/);
  assert.doesNotMatch(src, /sb\.from\('produits'\)\.select\('\*'\);/);
});
