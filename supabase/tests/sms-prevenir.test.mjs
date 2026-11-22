// Tests de supabase/functions/_shared/sms-prevenir.ts (22/11/2026) — « un client n'est prévenu qu'UNE fois par jour », tous canaux.
// La réservation atomique elle-même est dans la base (migration 037) : essayée sur Postgres 16 (40 sessions simultanées = 1 seule réservation).
// Lancer : node --test supabase/tests/   (aucune connexion, aucune donnée client)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classerReponseOvh, RESULTAT_EXCEPTION, statutSms, STATUT_INDETERMINE, reponseSendSms } from '../functions/_shared/ovh-resultat.ts';
import { jourParis, reserverPrevenir, libererPrevenir, peutEnvoyer, echecCertain, envoyerAvecReservation } from '../functions/_shared/sms-prevenir.ts';
import { resumeSms, controlerDemande as validerDemande } from '../functions/_shared/jarvis-action-logique.ts';

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
  const r = await envoi(sb, 'veille', async () => ({ ok: false, certain: true }), { journaliser: async (i) => { ordre.push(sb.t.size === 0 ? 'libere' : 'encore-reserve'); assert.equal(i, 'echec_certain'); throw new Error('journal HS'); } });
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
  assert.deepEqual(classerReponseOvh(200, { ids: [1], invalidReceivers: [] }, '+33600000000'), { ok: true, certain: true });
  assert.equal(classerReponseOvh(200, { ids: [1], invalidReceivers: ['+33600000000'] }, '+33600000000').certain, true, 'destinataire invalide : refus explicite');
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

test('revue Codex #20 (points 2, 3, 4) : HTTP 200 illisible = INDÉTERMINÉ ; l\'indéterminé est distingué dans le journal ; un échec de libération est SIGNALÉ', async () => {
  const num = '+33600000000';
  // 2 : 200 sans preuve lisible
  for (const corps of [null, undefined, '', 'OK', 42, [], {}, { ids: [] }, { validReceivers: [] }, { totalCreditsRemoved: 1 }, { ids: 'x' }]) { const r = classerReponseOvh(200, corps, num); assert.equal(r.ok, false, JSON.stringify(corps)); assert.equal(r.certain, false); assert.equal(r.http200Illisible, true, 'le booléen historique reste vrai pour les autres appelants'); }
  for (const corps of [{ ids: [123], validReceivers: [num] }, { ids: [123] }, { validReceivers: [num], invalidReceivers: [] }]) assert.deepEqual(classerReponseOvh(200, corps, num), { ok: true, certain: true }, JSON.stringify(corps));
  assert.equal(classerReponseOvh(200, { ids: [1], invalidReceivers: [num] }, num).certain, true, 'destinataire invalide = refus explicite, même avec des ids');
  // 3 : le journal reçoit l'issue exacte
  const vus = []; const sb = fausseBase();
  await envoyerAvecReservation({ sb, cmdId: '#9501', canal: 'veille', maintenant: M, envoyer: async () => ({ ok: false, certain: false }), journaliser: async (i) => { vus.push(i); } });
  await envoyerAvecReservation({ sb, cmdId: '#9502', canal: 'veille', maintenant: M, envoyer: async () => ({ ok: false, certain: true }), journaliser: async (i) => { vus.push(i); } });
  await envoyerAvecReservation({ sb, cmdId: '#9503', canal: 'veille', maintenant: M, envoyer: async () => ({ ok: true, certain: true }), journaliser: async (i) => { vus.push(i); } });
  assert.deepEqual(vus, ['echec_indetermine', 'echec_certain', 'envoye']);
  // 4 : échec de libération signalé (RPC en erreur, exception, jour invalide) ; succès = pas de drapeau
  const sbErreur = { t: new Map(), async rpc(nom, p) { if (nom === 'reserver_prevenir') return { data: { reserve: true }, error: null }; return { data: null, error: { message: 'base HS' } }; } };
  const r4 = await envoyerAvecReservation({ sb: sbErreur, cmdId: '#9601', canal: 'jarvis', maintenant: M, envoyer: async () => ({ ok: false, certain: true }) });
  assert.equal(r4.issue, 'echec_certain'); assert.equal(r4.liberation_echouee, true, 'libération impossible : signalée');
  assert.equal(await libererPrevenir(sbErreur, '#9601', 'jarvis', '2026-11-22'), false); assert.equal(await libererPrevenir({ rpc: async () => { throw new Error('x'); } }, '#9601', 'jarvis', '2026-11-22'), false); assert.equal(await libererPrevenir(fausseBase(), '#9601', 'jarvis', 'pas un jour'), false);
  const r5 = await envoyerAvecReservation({ sb: fausseBase(), cmdId: '#9602', canal: 'jarvis', maintenant: M, envoyer: async () => ({ ok: false, certain: true }) }); assert.equal(r5.issue, 'echec_certain'); assert.equal('liberation_echouee' in r5, false);
});

test('revue Codex #20 (P2) : le statut INDÉTERMINÉ écrit par send-sms / send-cmd-sms est relu comme « indéterminé » par sms_statut, jamais comme « échec »', () => {
  const ecrit = statutSms(RESULTAT_EXCEPTION); assert.equal(ecrit, STATUT_INDETERMINE); assert.equal(statutSms({ ok: true, certain: true }), 'envoyé'); assert.equal(statutSms({ ok: false, certain: true }), 'échec');
  assert.equal(statutSms(classerReponseOvh(200, null, '+33')), STATUT_INDETERMINE, '200 illisible = indéterminé aussi');
  assert.match(ecrit, /^indéterminé/, 'le libellé ne commence jamais par « échec »');
  const lignes = [{ type_sms: 'jarvis', statut: ecrit, date_sms: '2026-11-22', heure: '10:30' }, { type_sms: 'veille', statut: 'échec', date_sms: '2026-11-22', heure: '10:31' }, { type_sms: 'jarvis', statut: 'envoyé', date_sms: '2026-11-22', heure: '10:32' }];
  const r = resumeSms({ sms_envoyes: [] }, lignes); const st = r.sms.map((s) => s.statut);
  assert.deepEqual(st, ['indéterminé (peut-être parti)', 'échec', 'envoyé']);
});

test('revue Codex #20 (points 2, 3, 4) : libération confirmée seulement par TRUE ; échec de journalisation SIGNALÉ ; send-sms compatible avec les appelants manuels', async () => {
  // 2 : la RPC renvoie false (rien supprimé) ou null = libération NON confirmée
  const rpc = (data, error = null) => ({ rpc: async () => ({ data, error }) });
  assert.equal(await libererPrevenir(rpc(true), '#9701', 'jarvis', '2026-11-22'), true);
  for (const d of [false, null, undefined, 'true', 1]) assert.equal(await libererPrevenir(rpc(d), '#9701', 'jarvis', '2026-11-22'), false, 'data=' + JSON.stringify(d));
  const sbFaux = { t: new Map(), async rpc(nom) { return nom === 'reserver_prevenir' ? { data: { reserve: true }, error: null } : { data: false, error: null }; } };
  const r2 = await envoyerAvecReservation({ sb: sbFaux, cmdId: '#9702', canal: 'jarvis', maintenant: M, envoyer: async () => ({ ok: false, certain: true }) }); assert.equal(r2.liberation_echouee, true, 'RPC = false : signalé');
  // 3 : journal en panne signalé pour les trois issues
  for (const [res, issue] of [[{ ok: true, certain: true }, 'envoye'], [{ ok: false, certain: false }, 'echec_indetermine'], [{ ok: false, certain: true }, 'echec_certain']]) {
    const r = await envoyerAvecReservation({ sb: fausseBase(), cmdId: '#9703', canal: 'veille', maintenant: M, envoyer: async () => res, journaliser: async () => { throw new Error('journal HS'); } });
    assert.equal(r.issue, issue); assert.equal(r.journal_echoue, true, issue + ' : journal en panne signalé');
  }
  assert.equal('journal_echoue' in await envoyerAvecReservation({ sb: fausseBase(), cmdId: '#9704', canal: 'veille', maintenant: M, envoyer: async () => ({ ok: true, certain: true }), journaliser: async () => {} }), false);
  // 4 : compatibilité des appelants manuels / historiques de send-sms
  assert.deepEqual(reponseSendSms({ ok: true, certain: true }), { status: 200, corps: { success: true } });
  const illisible = reponseSendSms(classerReponseOvh(200, null, '+33')); assert.equal(illisible.status, 200); assert.equal(illisible.corps.success, true, 'HTTP 200 illisible : success reste TRUE pour les appelants historiques (aucune nouvelle tentative aveugle)'); assert.equal(illisible.corps.indetermine, true, 'le drapeau est ajouté pour JARVIS et la veille');
  assert.deepEqual(reponseSendSms(classerReponseOvh(422, {}, '+33')), { status: 502, corps: { success: false } });
  assert.deepEqual(reponseSendSms(classerReponseOvh(503, {}, '+33')), { status: 502, corps: { success: false, indetermine: true } });
  assert.deepEqual(reponseSendSms(RESULTAT_EXCEPTION), { status: 502, corps: { success: false, indetermine: true } });
  // JARVIS lit le drapeau : un « succès » indéterminé n'est PAS un succès (réservation gardée)
  const sb = fausseBase(); const lire = (corps) => ({ ok: !!corps.success && corps.indetermine !== true, certain: echecCertain({ http: 200, j: corps }) });
  const i1 = await envoyerAvecReservation({ sb, cmdId: '#9705', canal: 'jarvis', maintenant: M, envoyer: async () => lire(illisible.corps) });
  assert.equal(i1.issue, 'echec_indetermine'); assert.equal(sb.t.size, 1);
  assert.equal((await envoyerAvecReservation({ sb: fausseBase(), cmdId: '#9706', canal: 'jarvis', maintenant: M, envoyer: async () => lire({ success: true }) })).issue, 'envoye');
});
