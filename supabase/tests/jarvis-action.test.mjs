// Tests unitaires de supabase/functions/_shared/jarvis-action-logique.ts (porte d'entrée JARVIS, 27/10/2026)
// Lancer : node --test supabase/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlerDemande, controlerCommande, apercuCommande, construireSav, champsLitige, avantLitige, egal, jourParis } from '../functions/_shared/jarvis-action-logique.ts';

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
