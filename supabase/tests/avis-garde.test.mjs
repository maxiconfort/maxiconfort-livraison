// Tests unitaires de supabase/functions/_shared/avis-garde.ts (suspension des avis pendant litige/SAV)
// Lancer : node --test supabase/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commandesCitees, indexerSav, evaluerAvis, demandeDueAujourdhui, litigeOuvert, noteExclut,
  gardeHistorique, motifGls, telCle,
} from '../functions/_shared/avis-garde.ts';

const cmd = (o) => ({ id: '#2000', statut: 'livré', stpaie: 'Payé', date_livraison: '2026-09-20', instr: '', litige_statut: null, litige_clos_at: null, gls_livraison_etat: null, ...o });

test('références de commande dans une note de SAV (hors n° site Shopify)', () => {
  assert.deepEqual(commandesCitees('SAV LIVRAISON MANQUANTE (cmd origine #1587 / site #1077, payee)', '#SAV1'), ['#1587']);
  assert.deepEqual(commandesCitees('SAV ECHANGE (cmd origine #SAV8819383)', '#SAV6879301'), ['#SAV8819383']);
  assert.deepEqual(commandesCitees('Commande site #1071', '#SAV1'), []);
});

test('statuts de litige', () => {
  assert.equal(litigeOuvert('reclamation_ouverte'), true);
  assert.equal(litigeOuvert('en cours'), true);
  assert.equal(litigeOuvert('a_declarer'), true);
  assert.equal(litigeOuvert('indemnise'), false);
  assert.equal(litigeOuvert('refuse'), false);
  assert.equal(litigeOuvert(''), false);
});

test('commande normale livrée : pas bloquée, demande à J+1', () => {
  const ev = evaluerAvis(cmd({}), new Map());
  assert.equal(ev.bloque, null);
  assert.equal(ev.historique, false);
  assert.equal(demandeDueAujourdhui('2026-09-20', ev, '2026-09-21'), 'oui');
  assert.equal(demandeDueAujourdhui('2026-09-20', ev, '2026-09-24'), 'expiree');
});

test('litige ouvert → bloquée', () => {
  assert.match(evaluerAvis(cmd({ litige_statut: 'reclamation_ouverte' }), new Map()).bloque, /litige ouvert/);
});

test('note PAS D AVIS → bloquée', () => {
  assert.equal(noteExclut("PAS D'AVIS - dossier en cours"), true);
  assert.match(evaluerAvis(cmd({ instr: 'PAS D AVIS - retrofacturation' }), new Map()).bloque, /PAS D AVIS/);
});

test('livraison GLS partielle ou retour → bloquée', () => {
  assert.match(evaluerAvis(cmd({ gls_livraison_etat: 'partiel', gls_livraison_detail: 'livraison partielle 2/3' }), new Map()).bloque, /partiel/);
  assert.match(evaluerAvis(cmd({ gls_livraison_etat: 'retour' }), new Map()).bloque, /retour/);
});

test('non livrée → bloquée ; commande SAV → bloquée', () => {
  assert.match(evaluerAvis(cmd({ statut: 'en-attente' }), new Map()).bloque, /non livree/);
  assert.match(evaluerAvis(cmd({ id: '#SAV123' }), new Map()).bloque, /SAV/);
});

test('SAV ouvert lié → bloquée ; SAV livré → reprise J+2 après clôture, une seule fois', () => {
  const ouvert = indexerSav([{ id: '#SAV9', statut: 'en-attente', instr: 'SAV ECHANGE (cmd origine #2000)', date_livraison: '' }]);
  assert.match(evaluerAvis(cmd({}), ouvert).bloque, /SAV ouvert #SAV9/);

  const clos = indexerSav([{ id: '#SAV9', statut: 'livré', instr: 'SAV ECHANGE (cmd origine #2000)', date_livraison: '2026-09-25' }]);
  const ev = evaluerAvis(cmd({}), clos);
  assert.equal(ev.bloque, null);
  assert.equal(ev.historique, true);
  assert.equal(ev.cloture, '2026-09-25');
  assert.equal(demandeDueAujourdhui('2026-09-20', ev, '2026-09-26'), 'trop_tot');
  assert.equal(demandeDueAujourdhui('2026-09-20', ev, '2026-09-27'), 'oui');
  assert.equal(demandeDueAujourdhui('2026-09-20', ev, '2026-09-30'), 'expiree');
});

test('SAV annulé ignoré', () => {
  const idx = indexerSav([{ id: '#SAV9', statut: 'annulé', instr: 'cmd origine #2000' }]);
  const ev = evaluerAvis(cmd({}), idx);
  assert.equal(ev.bloque, null);
  assert.equal(ev.historique, false);
});

test('litige clos (date connue) → reprise J+2 ; un SAV encore ouvert garde le blocage', () => {
  const ev = evaluerAvis(cmd({ litige_statut: 'indemnise', litige_clos_at: '2026-09-26T09:00:00Z' }), new Map());
  assert.equal(ev.bloque, null);
  assert.equal(ev.cloture, '2026-09-26');
  assert.equal(demandeDueAujourdhui('2026-09-01', ev, '2026-09-28'), 'oui');
  const idx = indexerSav([{ id: '#SAV9', statut: 'en-route', instr: 'cmd origine #2000' }]);
  assert.match(evaluerAvis(cmd({ litige_statut: 'indemnise', litige_clos_at: '2026-09-26T09:00:00Z' }), idx).bloque, /SAV ouvert/);
});

test('litige clos sans date de clôture → reste bloquée (pas de reprise hasardeuse)', () => {
  assert.match(evaluerAvis(cmd({ litige_statut: 'refuse' }), new Map()).bloque, /sans date/);
});

test('marqueur automatique « PAS D AVIS - litige/SAV ouvert (28/09/2026). » : exclusion DÉFINITIVE, même après clôture (consigne 28/09 soir)', async () => {
  const { marqueurSuspension } = await import('../functions/_shared/avis-garde.ts');
  const note = 'PAS D AVIS - litige/SAV ouvert (28/09/2026). Commande site #1124.';
  assert.equal(marqueurSuspension(note), true);
  assert.equal(noteExclut(note), true);
  assert.match(evaluerAvis(cmd({ instr: note }), new Map()).bloque, /PAS D AVIS/);
  // SAV lié livré (clôture prouvée) -> reste bloquée
  const idx = indexerSav([{ id: '#SAV9', statut: 'livré', instr: 'cmd origine #2000', date_livraison: '2026-09-29' }]);
  assert.match(evaluerAvis(cmd({ instr: note }), idx).bloque, /PAS D AVIS/);
  // litige clos daté -> reste bloquée
  assert.match(evaluerAvis(cmd({ instr: note, litige_statut: 'clos', litige_clos_at: '2026-09-30T10:00:00Z' }), new Map()).bloque, /PAS D AVIS/);
});

test('dossier SANS note PAS D AVIS : reprise J+2 après clôture (inchangé)', () => {
  const idx = indexerSav([{ id: '#SAV9', statut: 'livré', instr: 'cmd origine #2000', date_livraison: '2026-09-29' }]);
  const ev = evaluerAvis(cmd({}), idx);
  assert.equal(ev.bloque, null);
  assert.equal(demandeDueAujourdhui('2026-09-19', ev, '2026-10-01'), 'oui');
});

test('« PAS D AVIS » manuel (autre libellé) : exclusion définitive, même après clôture', () => {
  for (const note of ['PAS D AVIS', 'PAS D AVIS - dossier client en cours (28/09/2026).', "pas d'avis - ERREUR EXPEDITION",
    'PAS D AVIS - litige/SAV ouvert (28/09/2026). PAS D AVIS client tres mecontent']) {
    assert.equal(noteExclut(note), true, note);
    const idx = indexerSav([{ id: '#SAV9', statut: 'livré', instr: 'cmd origine #2000', date_livraison: '2026-09-25' }]);
    assert.match(evaluerAvis(cmd({ instr: note }), idx).bloque, /PAS D AVIS/);
  }
});

// ── v2.1 (02/10/2026) : anti-doublon durable (sms_historique), paiement, GLS ──
const H = (type_sms, date_sms, statut = 'envoyé', tel = '06 12 34 56 78') => ({ tel, type_sms, statut, date_sms });

test('clé de numéro : 06…, +33 6…, 0033 6… → même clé', () => {
  assert.equal(telCle('06 12 34 56 78'), telCle('+33612345678'));
  assert.equal(telCle('0033 6 12 34 56 78'), '612345678');
  assert.equal(telCle('123'), '');
});

test("doublon d'étape : relance déjà partie vers ce numéro → bloquée ; autre étape → autorisée", () => {
  const histo = [H('avis', '2026-09-24'), H('avis-relance', '2026-09-26')];
  assert.match(gardeHistorique('avis-relance', '+33612345678', histo, '2026-09-27'), /avis-relance deja envoye a ce numero le 2026-09-26/);
  assert.equal(gardeHistorique('avis-relance2', '0612345678', histo, '2026-10-02'), null);
});

test('doublon de numéro < 60 j (autre commande du même client) → 1re demande bloquée ; > 60 j → autorisée', () => {
  const histo = [H('avis', '2026-09-17')];
  assert.match(gardeHistorique('avis', '06.12.34.56.78', histo, '2026-09-25'), /deja envoye a ce numero le 2026-09-17/);
  assert.equal(gardeHistorique('avis', '0612345678', histo, '2026-11-20'), null);
  assert.equal(gardeHistorique('avis', '0699999999', histo, '2026-09-25'), null); // autre numéro
});

test('échec OVH : réessai autorisé ; 3 échecs en 7 j → arrêt', () => {
  assert.equal(gardeHistorique('avis', '0612345678', [H('avis', '2026-09-29', 'échec')], '2026-09-30'), null);
  const e3 = ['2026-09-29', '2026-09-30', '2026-10-01'].map((d) => H('avis', d, 'échec'));
  assert.match(gardeHistorique('avis', '0612345678', e3, '2026-10-02'), /3 echecs OVH/);
});

test('commande non payée → bloquée', () => {
  assert.match(evaluerAvis(cmd({ stpaie: 'Non payé' }), new Map()).bloque, /paiement non confirme .Non payé/);
  assert.match(evaluerAvis(cmd({ stpaie: null }), new Map()).bloque, /paiement non confirme/);
  assert.equal(evaluerAvis(cmd({}), new Map()).bloque, null);
});

test('colis GLS jamais scanné / non pris en charge / en transit → bloquée', () => {
  for (const etat of ['non_pris_en_charge', 'transit', 'partiel']) {
    assert.match(evaluerAvis(cmd({ transporteur: 'GLS', gls_livraison_etat: etat }), new Map()).bloque, /livraison GLS/);
  }
  const gls = { transporteur: 'GLS', gls_livraison_etat: null };
  // 1 colis livré, 1 colis resté « données seules » (jamais scanné) → partiel
  const partiel = { etat: 'partiel', detail: 'livraison partielle 1/2', colis: [{ etat: 'livre' }, { etat: 'donnees_seules' }] };
  assert.match(motifGls(partiel, gls), /partiel.*1 colis jamais scanne/);
  assert.match(motifGls({ etat: 'non_pris_en_charge', detail: 'aucun colis remis a GLS', colis: [{ etat: 'inconnu' }] }, gls), /jamais scanne/);
  assert.equal(motifGls({ etat: 'livre', detail: 'livre 2/2', colis: [{ etat: 'livre' }, { etat: 'livre' }] }, gls), null);
  // GLS illisible : bloque sauf si la base dit déjà « livre »
  assert.match(motifGls({ etat: 'erreur', detail: 'API', colis: [] }, gls), /illisible/);
  assert.equal(motifGls({ etat: 'erreur', detail: 'API', colis: [] }, { ...gls, gls_livraison_etat: 'livre' }), null);
  // GLS sans numéro de colis ; transporteur non GLS ignoré
  assert.match(motifGls(null, gls), /sans numero de colis/);
  assert.equal(motifGls(null, { transporteur: 'RANOU' }), null);
});
