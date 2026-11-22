// Tests de supabase/functions/_shared/sms-prevenir.ts (22/11/2026) — « un client n'est prévenu qu'UNE fois par jour », tous canaux.
// La réservation atomique elle-même est dans la base (migration 037) : essayée sur Postgres 16 (40 sessions simultanées = 1 seule réservation).
// Lancer : node --test supabase/tests/   (aucune connexion, aucune donnée client)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classerReponseOvh, RESULTAT_EXCEPTION } from '../functions/_shared/ovh-resultat.ts';
import { jourParis, reserverPrevenir, libererPrevenir, peutEnvoyer, echecCertain, envoyerAvecReservation } from '../functions/_shared/sms-prevenir.ts';
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
  assert.deepEqual(await reserverPrevenir(sb, '#1001', 'veille', M), { etat: 'reserve', jour: '2026-11-22' });
  const r = await reserverPrevenir(sb, '#1001', 'jarvis', M); assert.deepEqual(r, { etat: 'deja', canal: 'veille' });
  const p = peutEnvoyer(r, 'jarvis'); assert.equal(p.ok, false); assert.equal(p.code, 409); assert.match(p.raison, /déjà prévenu aujourd’hui \(canal veille\)/);
  assert.deepEqual(await reserverPrevenir(sb, '#1001', 'jarvis', new Date('2026-11-23T12:00:00Z')), { etat: 'reserve', jour: '2026-11-23' });
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
  await libererPrevenir(sb, '#4001', 'veille', '2026-11-22'); assert.deepEqual(await reserverPrevenir(sb, '#4001', 'veille', M), { etat: 'deja', canal: 'jarvis' }, 'un autre canal ne libère jamais');
  await libererPrevenir(sb, '#4001', 'jarvis', '2026-11-22'); assert.deepEqual(await reserverPrevenir(sb, '#4001', 'veille', M), { etat: 'reserve', jour: '2026-11-22' });
});

test('base INJOIGNABLE : le SMS veille part comme avant (fail-open), JARVIS ne part PAS (fail-closed, 503) ; aucune exception ne remonte', async () => {
  for (const sb of [fausseBase({ panne: 'function reserver_prevenir does not exist' }), { rpc: async () => { throw new Error('réseau coupé'); } }, { rpc: async () => ({ data: { bizarre: 1 }, error: null }) }]) {
    const r = await reserverPrevenir(sb, '#5001', 'jarvis', M); assert.equal(r.etat, 'indisponible');
    assert.deepEqual(peutEnvoyer(r, 'veille'), { ok: true }, 'veille : comme avant');
    const j = peutEnvoyer(r, 'jarvis'); assert.equal(j.ok, false); assert.equal(j.code, 503); assert.match(j.raison, /impossible de vérifier/);
  }
  await libererPrevenir({ rpc: async () => { throw new Error('x'); } }, '#5001', 'jarvis', '2026-11-22');   // silencieux
});

test('jarvis-action : envoyer_sms accepte « prevenir » vrai/faux seulement ; le reste de la validation est inchangé', () => {
  const base = { action: 'envoyer_sms', cmdId: '#6001', texte: 'Bonjour, votre livraison est prévue demain.' };
  assert.equal(validerDemande({ ...base }), null); assert.equal(validerDemande({ ...base, prevenir: true }), null); assert.equal(validerDemande({ ...base, prevenir: false }), null);
  assert.match(String(validerDemande({ ...base, prevenir: 'oui' })), /prevenir : vrai ou faux/); assert.match(String(validerDemande({ ...base, prevenir: 1 })), /prevenir : vrai ou faux/);
  assert.match(String(validerDemande({ ...base, texte: 'court' })), /trop court/); assert.match(String(validerDemande({ ...base, texte: 'Voir https://x.fr pour la livraison' })), /pas de lien/);
});

test('revue Codex #20 (P2) : la libération vise le JOUR RÉSERVÉ — un envoi qui échoue APRÈS minuit ne supprime jamais la réservation valide du jour suivant', async () => {
  const sb = fausseBase();
  const avantMinuit = new Date('2026-11-22T22:59:30Z'); const apresMinuit = new Date('2026-11-22T23:00:30Z');
  const r1 = await reserverPrevenir(sb, '#7001', 'jarvis', avantMinuit); assert.deepEqual(r1, { etat: 'reserve', jour: '2026-11-22' });
  const r2 = await reserverPrevenir(sb, '#7001', 'jarvis', apresMinuit); assert.deepEqual(r2, { etat: 'reserve', jour: '2026-11-23' }, 'une autre requête réserve le jour suivant');
  await libererPrevenir(sb, '#7001', 'jarvis', r1.jour);   // l'envoi du 22 échoue après minuit : libère le 22, PAS le 23
  assert.equal(sb.t.has('#7001|2026-11-22'), false); assert.equal(sb.t.has('#7001|2026-11-23'), true, 'la réservation valide du jour suivant est intacte');
  await libererPrevenir(sb, '#7001', 'jarvis', 'pas un jour'); assert.equal(sb.t.has('#7001|2026-11-23'), true, 'jour invalide : rien n\'est libéré');
});
test('revue Codex #20 (P2) : échec CERTAIN (send-sms répond success:false) = libération ; échec INDÉTERMINÉ (exception, passerelle, réponse illisible) = réservation GARDÉE', () => {
  assert.equal(echecCertain({ http: 502, j: { success: false, error: 'OVH' } }), true);
  for (const flou of [null, undefined, {}, { http: 502 }, { http: 504, j: null }, { http: 502, j: 'Bad Gateway' }, { http: 200, j: {} }, { http: 502, j: { error: 'x' } }, { http: 200, j: { success: true } }, { http: 502, j: { success: false, indetermine: true } }]) assert.equal(echecCertain(flou), false, JSON.stringify(flou));
});

// ---- parcours d'envoi COMPLETS (revue Codex #20, points 3 et 4) ----
const envoi = (sb, canal, envoyer, extra = {}) => envoyerAvecReservation({ sb, cmdId: '#8001', canal, maintenant: M, envoyer, ...extra });

test('parcours : succès = envoyé, réservation gardée ; un second canal le même jour n\'envoie RIEN (l\'envoi n\'est même pas tenté)', async () => {
  const sb = fausseBase(); let appels = 0;
  assert.deepEqual(await envoi(sb, 'veille', async () => { appels++; return { ok: true, certain: true }; }), { issue: 'envoye', jour: '2026-11-22' });
  const j = await envoi(sb, 'jarvis', async () => { appels++; return { ok: true, certain: true }; });
  assert.equal(j.issue, 'deja'); assert.equal(j.canal, 'veille'); assert.equal(appels, 1, 'JARVIS n\'a PAS envoyé');
});
test('parcours : base indisponible — la veille ENVOIE comme avant (fail-open, choix assumé), JARVIS ne tente PAS l\'envoi (503)', async () => {
  const sb = fausseBase({ panne: 'function does not exist' }); let appels = 0;
  assert.equal((await envoi(sb, 'veille', async () => { appels++; return { ok: true, certain: true }; })).issue, 'envoye'); assert.equal(appels, 1);
  const j = await envoi(sb, 'jarvis', async () => { appels++; return { ok: true, certain: true }; }); assert.equal(j.issue, 'bloque_indisponible'); assert.equal(j.code, 503); assert.equal(appels, 1, 'rien envoyé');
});
test('parcours : échec CERTAIN = réservation libérée AVANT la journalisation, même si la journalisation lève une erreur ; l\'autre canal peut alors envoyer', async () => {
  const sb = fausseBase(); const ordre = [];
  const r = await envoi(sb, 'veille', async () => ({ ok: false, certain: true }), { journaliser: async () => { ordre.push(sb.t.size === 0 ? 'libere' : 'encore-reserve'); throw new Error('journal HS'); } });
  assert.equal(r.issue, 'echec_certain'); assert.deepEqual(ordre, ['libere'], 'libérée avant la journalisation');
  assert.equal(sb.t.size, 0); assert.equal((await envoi(sb, 'jarvis', async () => ({ ok: true, certain: true }))).issue, 'envoye');
});
test('parcours : échec INDÉTERMINÉ (exception pendant l\'envoi, ou certain:false) = réservation GARDÉE, aucun second SMS possible', async () => {
  for (const envoyer of [async () => { throw new Error('connexion coupée'); }, async () => ({ ok: false, certain: false })]) {
    const sb = fausseBase(); const r = await envoi(sb, 'jarvis', envoyer); assert.equal(r.issue, 'echec_indetermine'); assert.equal(sb.t.size, 1, 'réservation gardée');
    assert.equal((await envoi(sb, 'veille', async () => ({ ok: true, certain: true }))).issue, 'deja');
  }
});
test('parcours : une erreur de journalisation après un envoi RÉUSSI ne change pas l\'issue', async () => {
  const sb = fausseBase(); assert.equal((await envoi(sb, 'jarvis', async () => ({ ok: true, certain: true }), { journaliser: async () => { throw new Error('journal HS'); } })).issue, 'envoye');
});
test('parcours PASSAGE DE MINUIT : envoi réservé à 22 h 59 UTC (23 h 59 Paris), échec certain après minuit, autre requête déjà réservée pour le lendemain : seule la réservation du 22 est libérée', async () => {
  const sb = fausseBase(); const avant = new Date('2026-11-22T22:59:30Z'); const apres = new Date('2026-11-22T23:00:30Z');
  const r = await envoyerAvecReservation({ sb, cmdId: '#8100', canal: 'jarvis', maintenant: avant, envoyer: async () => {
    await reserverPrevenir(sb, '#8100', 'jarvis', apres);   // pendant l'envoi, minuit passe et une autre requête réserve le 23
    return { ok: false, certain: true }; } });
  assert.equal(r.issue, 'echec_certain'); assert.equal(sb.t.has('#8100|2026-11-22'), false); assert.equal(sb.t.has('#8100|2026-11-23'), true, 'la réservation valide du 23 est intacte');
});

test('revue Codex #20 (P2) : le résultat OVH INDÉTERMINÉ (exception réseau, 5xx) n\'est JAMAIS pris pour un échec certain, de OVH jusqu\'aux deux appelants', async () => {
  // classement pur de la réponse OVH
  assert.deepEqual(classerReponseOvh(200, { invalidReceivers: [] }, '+33600000000'), { ok: true, certain: true });
  assert.equal(classerReponseOvh(200, { invalidReceivers: ['+33600000000'] }, '+33600000000').certain, true, 'destinataire invalide : refus explicite');
  for (const s of [400, 401, 403, 404, 409, 422, 429]) { const r = classerReponseOvh(s, {}, '+33'); assert.equal(r.ok, false); assert.equal(r.certain, true, 'HTTP ' + s + ' = refus explicite'); }
  for (const s of [500, 502, 503, 504, 0, 302]) { const r = classerReponseOvh(s, null, '+33'); assert.equal(r.ok, false); assert.equal(r.certain, false, 'HTTP ' + s + ' = INDÉTERMINÉ'); }
  assert.equal(RESULTAT_EXCEPTION.ok, false); assert.equal(RESULTAT_EXCEPTION.certain, false, 'exception réseau = INDÉTERMINÉ (le helper réel l\'absorbe : c\'est ce cas que Codex a relevé)');
  // JARVIS : send-sms répond { success:false, indetermine:true } → l'appelant garde la réservation ; { success:false } seul → libérée
  const sb = fausseBase();
  const indet = await envoyerAvecReservation({ sb, cmdId: '#9001', canal: 'jarvis', maintenant: M, envoyer: async () => { const r = { http: 502, j: { success: false, indetermine: true } }; return { ok: !!r.j.success, certain: echecCertain(r) }; } });
  assert.equal(indet.issue, 'echec_indetermine'); assert.equal(sb.t.size, 1, 'réservation gardée : aucun second SMS possible');
  assert.equal((await envoyerAvecReservation({ sb, cmdId: '#9001', canal: 'veille', maintenant: M, envoyer: async () => ({ ok: true, certain: true }) })).issue, 'deja');
  const sb2 = fausseBase();
  const cert = await envoyerAvecReservation({ sb: sb2, cmdId: '#9002', canal: 'jarvis', maintenant: M, envoyer: async () => { const r = { http: 502, j: { success: false } }; return { ok: !!r.j.success, certain: echecCertain(r) }; } });
  assert.equal(cert.issue, 'echec_certain'); assert.equal(sb2.t.size, 0, 'refus explicite : réservation libérée');
  // veille : même chaîne, résultat du helper OVH → {ok, certain}
  const sb3 = fausseBase(); const exc = await envoyerAvecReservation({ sb: sb3, cmdId: '#9003', canal: 'veille', maintenant: M, envoyer: async () => ({ ok: RESULTAT_EXCEPTION.ok, certain: RESULTAT_EXCEPTION.certain }) });
  assert.equal(exc.issue, 'echec_indetermine'); assert.equal(sb3.t.size, 1);
});
