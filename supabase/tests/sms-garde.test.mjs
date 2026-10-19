// Tests unitaires de supabase/functions/_shared/sms-garde.ts (19/10/2026)
// Lancer : node --test supabase/tests/   (aucune connexion, aucune donnée client)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  texteConfirmation, dejaEnvoye, expeditionAutorisee, doitEnvoyerExpedition,
  confirmationRattrapageEligible, PREUVE_PRISE_EN_CHARGE,
} from '../functions/_shared/sms-garde.ts';

const GSM = /^[A-Za-z0-9 @£$¥èéùìòÇØøÅå_!"#%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà\n]*$/;

test('confirmation : 1 SMS (<=160, alphabet GSM), aucune date, pas de « expediee »', () => {
  for (const prenom of ['Sixtine', 'Jean-Christophe', 'Mme RABET', 'Marie-Antoinette']) {
    for (const tr of ['GLS', 'RANOU', null, undefined, '']) {
      const t = texteConfirmation(prenom, tr);
      assert.ok(t.length <= 160, `${t.length} car : ${t}`);
      assert.match(t, GSM);
      assert.doesNotMatch(t, /expedi|achemin|\d{2}\/\d{2}/i);
    }
  }
});

test('confirmation : texte GLS et texte livreur distincts', () => {
  assert.match(texteConfirmation('Ana', 'GLS'), /suivi GLS/);
  assert.match(texteConfirmation('Ana', 'RANOU'), /notre livreur/);
  assert.match(texteConfirmation('Ana', null), /notre livreur/); // transporteur vide = livraison interne
});

test('expedition : refusée sans preuve (création étiquette, saisie suivi, application)', () => {
  assert.deepEqual(expeditionAutorisee({ cmdId: '#1', type: 'expedition' }, { statut: 'en-attente' }), { ok: false, raison: 'attente_prise_en_charge_gls' });
  assert.equal(expeditionAutorisee({}, { statut: 'en-attente' }).ok, false);
  assert.equal(expeditionAutorisee(null, { statut: 'en-attente' }).ok, false);
});

test('expedition : acceptée avec la preuve, sauf commande annulée ou livrée', () => {
  const b = { preuve: PREUVE_PRISE_EN_CHARGE };
  assert.equal(expeditionAutorisee(b, { statut: 'en-attente' }).ok, true);
  assert.equal(expeditionAutorisee(b, { statut: 'annulé' }).ok, false);
  assert.equal(expeditionAutorisee(b, { statut: 'livré' }).ok, false);
});

test('gls-sync : étiquette créée, colis non remis → pas de SMS', () => {
  assert.equal(doitEnvoyerExpedition({ statut: 'en-attente', sms_envoyes: [] }, [{ priseEnCharge: false }, { priseEnCharge: false }]), false);
});

test('gls-sync : premier scan (même sur 1 colis sur 2), ou scan tardif → SMS', () => {
  assert.equal(doitEnvoyerExpedition({ statut: 'en-attente', sms_envoyes: [{ type: 'confirmation' }] }, [{ priseEnCharge: false }, { priseEnCharge: true }]), true);
});

test('gls-sync : doublon d\'événement / passage suivant → pas de 2e SMS', () => {
  assert.equal(doitEnvoyerExpedition({ statut: 'en-attente', sms_envoyes: [{ type: 'expedition' }] }, [{ priseEnCharge: true }]), false);
});

test('gls-sync : commande annulée ou déjà livrée → pas de SMS ; colis bloqué sans scan → pas de SMS', () => {
  assert.equal(doitEnvoyerExpedition({ statut: 'annulé', sms_envoyes: [] }, [{ priseEnCharge: true }]), false);
  assert.equal(doitEnvoyerExpedition({ statut: 'livré', sms_envoyes: [] }, [{ priseEnCharge: true }]), false);
  assert.equal(doitEnvoyerExpedition({ statut: 'en-attente', sms_envoyes: null }, []), false);
});

test('rattrapage confirmation : SAV, GLS suivie, déjà confirmée, < 3 min exclues', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const il = m => new Date(now - m * 60000).toISOString();
  assert.equal(confirmationRattrapageEligible({ id: '#SAV123', created_at: il(10) }, now).raison, 'sav');
  assert.equal(confirmationRattrapageEligible({ id: '#2010', transporteur: 'GLS', tracking_transporteur: '00LABC', created_at: il(10) }, now).raison, 'gls_tracking');
  assert.equal(confirmationRattrapageEligible({ id: '#2010', sms_envoyes: [{ type: 'confirmation' }], created_at: il(10) }, now).raison, 'deja_confirme');
  assert.equal(confirmationRattrapageEligible({ id: '#2010', created_at: il(1) }, now).raison, 'trop_recente');
  assert.equal(confirmationRattrapageEligible({ id: '#2010', created_at: il(4) }, now).ok, true);
  assert.equal(confirmationRattrapageEligible({ id: '#2010', transporteur: 'GLS', tracking_transporteur: '', created_at: il(4) }, now).ok, true);
});

test('dejaEnvoye : robuste aux valeurs vides', () => {
  assert.equal(dejaEnvoye(null, 'x'), false);
  assert.equal(dejaEnvoye([null, { type: 'x' }], 'x'), true);
});
