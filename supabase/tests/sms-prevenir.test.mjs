// Tests de supabase/functions/_shared/sms-prevenir.ts (22/11/2026) — « un client n'est prévenu qu'UNE fois par jour », tous canaux.
// La réservation atomique elle-même est dans la base (migration 037) : essayée sur Postgres 16 (40 sessions simultanées = 1 seule réservation).
// Lancer : node --test supabase/tests/   (aucune connexion, aucune donnée client)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jourParis, reserverPrevenir, libererPrevenir, peutEnvoyer } from '../functions/_shared/sms-prevenir.ts';
import { controlerDemande as validerDemande } from '../functions/_shared/jarvis-action-logique.ts';

// Fausse base : même contrat que les fonctions SQL (clé primaire (commande, jour), libération par le même canal seulement).
function fausseBase({ panne } = {}) {
  const t = new Map();
  return {
    t,
    async rpc(nom, p) {
      if (panne) return { data: null, error: { message: panne } };
      const k = p.p_cmd + '|' + p.p_jour;
      await new Promise((r) => setTimeout(r, Math.random() * 5));   // les appels se croisent
      if (nom === 'reserver_prevenir') { if (t.has(k)) return { data: { reserve: false, canal: t.get(k) }, error: null }; t.set(k, p.p_canal); return { data: { reserve: true }, error: null }; }
      if (nom === 'liberer_prevenir') { const ok = t.get(k) === p.p_canal; if (ok) t.delete(k); return { data: ok, error: null }; }
      return { data: null, error: { message: 'inconnue' } };
    },
  };
}
const M = new Date('2026-11-22T12:00:00Z');

test('jour de Paris : bascule à minuit HEURE DE PARIS (hiver UTC+1, été UTC+2), pas à minuit UTC', () => {
  assert.equal(jourParis(new Date('2026-11-22T22:59:59Z')), '2026-11-22'); assert.equal(jourParis(new Date('2026-11-22T23:00:00Z')), '2026-11-23');
  assert.equal(jourParis(new Date('2026-07-14T21:59:59Z')), '2026-07-14'); assert.equal(jourParis(new Date('2026-07-14T22:00:00Z')), '2026-07-15');
});

test('veille puis JARVIS le même jour : JARVIS est refusé (409) et nomme le canal ; un autre jour : accepté', async () => {
  const sb = fausseBase();
  assert.deepEqual(await reserverPrevenir(sb, '#1001', 'veille', M), { etat: 'reserve' });
  const r = await reserverPrevenir(sb, '#1001', 'jarvis', M); assert.deepEqual(r, { etat: 'deja', canal: 'veille' });
  const p = peutEnvoyer(r, 'jarvis'); assert.equal(p.ok, false); assert.equal(p.code, 409); assert.match(p.raison, /déjà prévenu aujourd’hui \(canal veille\)/);
  assert.deepEqual(await reserverPrevenir(sb, '#1001', 'jarvis', new Date('2026-11-23T12:00:00Z')), { etat: 'reserve' });
});

test('CONCURRENCE : 30 envois simultanés (veille et JARVIS mélangés) sur la même commande et le même jour : UN seul est autorisé', async () => {
  const sb = fausseBase();
  const res = await Promise.all(Array.from({ length: 30 }, (_, i) => reserverPrevenir(sb, '#2002', i % 2 ? 'veille' : 'jarvis', M)));
  assert.equal(res.filter((r) => r.etat === 'reserve').length, 1); assert.equal(res.filter((r) => r.etat === 'deja').length, 29);
  // commandes différentes : aucune interférence
  const autres = await Promise.all(['#3001', '#3002', '#3003'].map((c) => reserverPrevenir(sb, c, 'jarvis', M))); assert.ok(autres.every((r) => r.etat === 'reserve'));
});

test('envoi ÉCHOUÉ : la réservation est libérée par le MÊME canal seulement ; l\'autre canal peut alors envoyer', async () => {
  const sb = fausseBase();
  await reserverPrevenir(sb, '#4001', 'jarvis', M);
  await libererPrevenir(sb, '#4001', 'veille', M); assert.deepEqual(await reserverPrevenir(sb, '#4001', 'veille', M), { etat: 'deja', canal: 'jarvis' }, 'un autre canal ne libère jamais');
  await libererPrevenir(sb, '#4001', 'jarvis', M); assert.deepEqual(await reserverPrevenir(sb, '#4001', 'veille', M), { etat: 'reserve' });
});

test('base INJOIGNABLE : le SMS veille part comme avant (fail-open), JARVIS ne part PAS (fail-closed, 503) ; aucune exception ne remonte', async () => {
  for (const sb of [fausseBase({ panne: 'function reserver_prevenir does not exist' }), { rpc: async () => { throw new Error('réseau coupé'); } }, { rpc: async () => ({ data: { bizarre: 1 }, error: null }) }]) {
    const r = await reserverPrevenir(sb, '#5001', 'jarvis', M); assert.equal(r.etat, 'indisponible');
    assert.deepEqual(peutEnvoyer(r, 'veille'), { ok: true }, 'veille : comme avant');
    const j = peutEnvoyer(r, 'jarvis'); assert.equal(j.ok, false); assert.equal(j.code, 503); assert.match(j.raison, /impossible de vérifier/);
  }
  await libererPrevenir({ rpc: async () => { throw new Error('x'); } }, '#5001', 'jarvis', M);   // silencieux
});

test('jarvis-action : envoyer_sms accepte « prevenir » vrai/faux seulement ; le reste de la validation est inchangé', () => {
  const base = { action: 'envoyer_sms', cmdId: '#6001', texte: 'Bonjour, votre livraison est prévue demain.' };
  assert.equal(validerDemande({ ...base }), null); assert.equal(validerDemande({ ...base, prevenir: true }), null); assert.equal(validerDemande({ ...base, prevenir: false }), null);
  assert.match(String(validerDemande({ ...base, prevenir: 'oui' })), /prevenir : vrai ou faux/); assert.match(String(validerDemande({ ...base, prevenir: 1 })), /prevenir : vrai ou faux/);
  assert.match(String(validerDemande({ ...base, texte: 'court' })), /trop court/); assert.match(String(validerDemande({ ...base, texte: 'Voir https://x.fr pour la livraison' })), /pas de lien/);
});
