// Tests du traitement de la porte lbc-action (_shared/lbc-action-traitement.ts) avec une base SIMULÉE : réserves Codex
// Livraison #6 (2e passage) — aperçu = lignes empreintes par la base, cibles imposées par le jeton, relecture vérifiée,
// incertitude = INDÉTERMINÉ. Lancer : node --test supabase/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traiter, erreurSqlCertaine } from '../functions/_shared/lbc-action-traitement.ts';
import { verifierProduit, normaliserChamp } from '../functions/_shared/lbc-action-logique.ts';

const T = Date.parse('2026-10-28T10:00:00Z');
const J = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ann = (o) => ({ id: 'a1', date_pub: '2026-10-30', heure: '10:15', ville: 'Créteil', dept: 'IDF', collab_id: null, produit: 'Lit coffre blanc', dim: '160x200', validation: 'OFF', statut: 'À publier', lien: '', ...o });
/** Base simulée : tables en mémoire, rpc fournie par le test, lectures et appels relevés. */
function base({ annonces = [], produits = [], rpc }) {
  const vus = { rpc: [], lectures: [] };
  const from = (table) => {
    const q = { table, filtres: [] };
    const b = {
      select() { return b; }, order() { return b; }, range(de, a) { q.range = [de, a]; return b; }, eq(k, v) { q.filtres.push((x) => String(x[k]) === String(v)); return b; }, in(k, l) { q.filtres.push((x) => l.includes(x[k])); q.in = l; return b; }, limit() { return b; },
      run() { vus.lectures.push(q); if (b.erreur) return { data: null, error: b.erreur }; const t = table === 'lbc_annonces' ? annonces : produits; let l = t.filter((x) => q.filtres.every((f) => f(x))).map((x) => ({ ...x })); if (q.range) l = l.slice(q.range[0], q.range[1] + 1); else l = l.slice(0, base.maxLignes || 1e9); return { data: l, error: null }; },
      maybeSingle() { const r = b.run(); return Promise.resolve({ data: r.data ? r.data[0] || null : null, error: r.error }); },
      then(ok, ko) { return Promise.resolve(b.run()).then(ok, ko); },
    };
    if (base.erreurLecture) b.erreur = base.erreurLecture;
    return b;
  };
  return { sb: { from, rpc: async (nom, args) => { vus.rpc.push({ nom, args }); return rpc(nom, args); } }, vus };
}
const BLOQUER = { action: 'bloquer', filtre: { date: '2026-10-30' } };

test('aperçu : les lignes affichées sont celles empreintes par la base ; une ligne changée entre les deux lectures = 409', async () => {
  // l'heure change entre la lecture et l'enregistrement : l'aperçu montre la NOUVELLE heure (celle qui est figée)
  let b = base({ annonces: [ann({})], rpc: () => ({ data: { jeton: J, lignes: [ann({ heure: '16:40' })] }, error: null }) });
  let r = await traiter(BLOQUER, b.sb, T);
  assert.equal(r.code, 200); assert.equal(r.corps.annonces[0].heure, '16:40'); assert.deepEqual(r.corps.ids, ['a1']); assert.equal(r.corps.jeton, J);
  // publiée entre-temps (lien) ou plus dans le filtre (jour changé) : refaire l'aperçu
  for (const change of [{ lien: 'https://www.leboncoin.fr/ad/1' }, { date_pub: '2026-10-31' }, { statut: 'Bloqué' }]) {
    b = base({ annonces: [ann({})], rpc: () => ({ data: { jeton: J, lignes: [ann(change)] }, error: null }) });
    r = await traiter(BLOQUER, b.sb, T); assert.equal(r.code, 409, JSON.stringify(change)); assert.equal(r.corps.code, 'CHANGE'); assert.equal(r.corps.jeton, undefined);
  }
  // la base renvoie un nombre de lignes différent : aperçu refusé
  b = base({ annonces: [ann({}), ann({ id: 'a2' })], rpc: () => ({ data: { jeton: J, lignes: [ann({})] }, error: null }) });
  assert.equal((await traiter(BLOQUER, b.sb, T)).code, 502);
  // produit : la vue montre la ligne figée ; devenu inactif entre-temps = 409
  b = base({ produits: [{ id: 'P1', nom: 'Matelas', dim: '140x190', actif: true, boost_pct: null }], rpc: () => ({ data: { jeton: J, lignes: [{ id: 'P1', nom: 'Matelas', dim: '140x190', actif: true, boost_pct: 25 }] }, error: null }) });
  r = await traiter({ action: 'boost', produitId: 'P1', pct: 50, jours: 3 }, b.sb, T); assert.equal(r.code, 200); assert.equal(r.corps.produit.boost_pct, 25);
  b = base({ produits: [{ id: 'P1', nom: 'Matelas', actif: true }], rpc: () => ({ data: { jeton: J, lignes: [{ id: 'P1', nom: 'Matelas', actif: false }] }, error: null }) });
  assert.equal((await traiter({ action: 'boost', produitId: 'P1', pct: 50, jours: 3 }, b.sb, T)).code, 409);
});

test('confirmation : les cibles demandées sont transmises à la base ; refus de la base = 409 ; relecture sur les cibles renvoyées', async () => {
  const etat = [ann({}), ann({ id: 'a2' }), ann({ id: 'a9' })];
  const b = base({ annonces: etat, rpc: (nom, a) => { etat.forEach((x) => { if (a.p_ids.includes(x.id)) { x.statut = 'Bloqué'; x.validation = 'OFF'; } }); return { data: { ok: true, modifiees: 2, cibles: [...a.p_ids].sort() }, error: null }; } });
  const r = await traiter({ ...BLOQUER, confirme: true, jeton: J, ids: ['a2', 'a1'] }, b.sb, T);
  assert.equal(r.code, 200); assert.equal(r.corps.verifie, true);
  assert.deepEqual(b.vus.rpc[0].args.p_ids, ['a2', 'a1'], 'cibles transmises à la base, qui les compare au jeton');
  assert.deepEqual(b.vus.lectures.at(-1).in, ['a1', 'a2'], 'relecture sur les cibles renvoyées par la transaction');
  // la base refuse une substitution
  const b2 = base({ annonces: etat, rpc: () => ({ data: { ok: false, code: 'APERCU', motif: 'les cibles ne sont pas celles de l’aperçu : rien n’a été modifié' }, error: null }) });
  const r2 = await traiter({ ...BLOQUER, confirme: true, jeton: J, ids: ['a9'] }, b2.sb, T); assert.equal(r2.code, 409); assert.equal(r2.corps.code, 'APERCU');
  // produit : produitId transmis comme cible
  const p = [{ id: 'P2', boost_pct: null, boost_until: null }];
  const b3 = base({ produits: p, rpc: (nom, a) => { p[0].boost_pct = 50; p[0].boost_until = '2026-10-31'; return { data: { ok: true, modifiees: 1, cibles: a.p_ids, apres: [{ ...p[0] }], jusqu: '2026-10-31' }, error: null }; } });
  const r3 = await traiter({ action: 'boost', produitId: 'P2', pct: 50, jours: 3, confirme: true, jeton: J }, b3.sb, T);
  assert.equal(r3.code, 200); assert.deepEqual(b3.vus.rpc[0].args.p_ids, ['P2']);
});

test('confirmation : toute incertitude = 502 INDÉTERMINÉ ; seule une erreur SQL certaine = 500 « rien n’a été modifié »', async () => {
  const C = { ...BLOQUER, confirme: true, jeton: J, ids: ['a1'] };
  const cas = async (rpc, annonces = [ann({ statut: 'Bloqué' })]) => traiter(C, base({ annonces, rpc }).sb, T);
  let r = await cas(() => { throw new TypeError('fetch failed'); }); assert.equal(r.code, 502); assert.equal(r.corps.code, 'INDETERMINE'); assert.doesNotMatch(r.corps.erreur, /rien n’a été modifié/);
  r = await cas(() => ({ data: null, error: { message: 'TypeError: fetch failed', code: '' } })); assert.equal(r.code, 502);
  r = await cas(() => ({ data: null, error: { message: 'nombre de lignes modifiées inattendu', code: 'P0001' } })); assert.equal(r.code, 500); assert.match(r.corps.erreur, /rien n’a été modifié/);
  r = await cas(() => ({ data: null, error: null })); assert.equal(r.code, 502, 'réponse vide');
  r = await cas(() => ({ data: { ok: true, modifiees: 1, cibles: ['a7'] }, error: null })); assert.equal(r.code, 502, 'cibles renvoyées ≠ demandées');
  r = await cas(() => ({ data: { ok: true, modifiees: 1 }, error: null })); assert.equal(r.code, 502, 'cibles absentes');
  r = await cas(() => ({ data: { ok: true, modifiees: 1, cibles: ['a1'] }, error: null }), [ann({ statut: 'À publier' })]); assert.equal(r.code, 502, 'relecture différente');
  r = await cas(() => ({ data: { ok: true, modifiees: 1, cibles: ['a1'] }, error: null }), []); assert.equal(r.code, 502, 'ligne disparue à la relecture');
  r = await cas(() => ({ data: { ok: true, modifiees: 1, cibles: ['a1'] }, error: null })); assert.equal(r.code, 200, 'relecture conforme');
  // produit : relecture différente
  const p = [{ id: 'P2', poids_idf: 10 }];
  r = await traiter({ action: 'poids_zone', produitId: 'P2', zone: 'idf', poids: 70, confirme: true, jeton: J }, base({ produits: p, rpc: (n, a) => ({ data: { ok: true, modifiees: 1, cibles: a.p_ids }, error: null }) }).sb, T);
  assert.equal(r.code, 502);
  assert.equal(erreurSqlCertaine({ code: '40001' }), true); assert.equal(erreurSqlCertaine({ code: '' }), false); assert.equal(erreurSqlCertaine(null), false);
});

test('réserves Codex #6 (3e passage) : échéance du boost figée à l’aperçu ; nombres stockés en texte acceptés à la relecture', async () => {
  // Aperçu à 23 h 58 (Paris) : l'échéance montrée est transmise à la base avec le jeton
  const avantMinuit = Date.parse('2026-10-28T22:58:00Z'); // 23:58 à Paris (heure d'hiver)
  let vu = null;
  const b = base({ produits: [{ id: 'P1', nom: 'Matelas', actif: true }], rpc: (nom, a) => { vu = a; return { data: { jeton: J, lignes: [{ id: 'P1', nom: 'Matelas', actif: true }] }, error: null }; } });
  const ap = await traiter({ action: 'boost', produitId: 'P1', pct: 50, jours: 3 }, b.sb, avantMinuit);
  assert.equal(ap.corps.apres.boost_until, '2026-10-31'); assert.equal(vu.p_demande.jusqu, '2026-10-31', 'échéance montrée = échéance figée');
  // Confirmation APRÈS minuit : la relecture attend l'échéance FIGÉE renvoyée par la base, pas un recalcul (qui donnerait le 01/11)
  const apresMinuit = Date.parse('2026-10-28T23:03:00Z');
  const p = [{ id: 'P1', boost_pct: 50, boost_until: '2026-10-31' }];
  const conf = (data) => traiter({ action: 'boost', produitId: 'P1', pct: 50, jours: 3, confirme: true, jeton: J }, base({ produits: p, rpc: (n, a) => ({ data: { ok: true, modifiees: 1, cibles: a.p_ids, ...data }, error: null }) }).sb, apresMinuit);
  let r = await conf({ jusqu: '2026-10-31' }); assert.equal(r.code, 200, 'échéance figée relue : vérifié');
  r = await conf({}); assert.equal(r.code, 502, 'échéance non confirmée par la base : indéterminé');
  r = await conf({ jusqu: '2026-11-01' }); assert.equal(r.code, 502, 'base et relecture en désaccord : indéterminé');
  // Colonnes numériques renvoyées en TEXTE : boost et pression correctement écrits = vérifiés (pas 502)
  const t = [{ id: 'P2', boost_pct: '50', boost_until: '2026-10-31T00:00:00', poids_idf: '70' }];
  r = await traiter({ action: 'boost', produitId: 'P2', pct: 50, jours: 3, confirme: true, jeton: J }, base({ produits: t, rpc: (n, a) => ({ data: { ok: true, modifiees: 1, cibles: a.p_ids, jusqu: '2026-10-31' }, error: null }) }).sb, T);
  assert.equal(r.code, 200);
  r = await traiter({ action: 'poids_zone', produitId: 'P2', zone: 'idf', poids: 70, confirme: true, jeton: J }, base({ produits: t, rpc: (n, a) => ({ data: { ok: true, modifiees: 1, cibles: a.p_ids }, error: null }) }).sb, T);
  assert.equal(r.code, 200);
  assert.equal(verifierProduit({ id: 'x', poids_prov: '7' }, { poids_prov: 70 }), false, 'valeur différente toujours refusée');
  assert.equal(verifierProduit({ id: 'x', boost_pct: null, boost_until: '' }, { boost_pct: null, boost_until: null }), true, 'fin de boost : vide = null');
  assert.equal(normaliserChamp('boost_pct', '50'), 50); assert.equal(normaliserChamp('boost_until', '2026-10-31T00:00:00+00'), '2026-10-31');
});

test('réserves Codex #6 (4e passage) : recherche sans mot exploitable refusée ; panne de lecture ≠ absence de résultat', async () => {
  const { controlerDemande, trouverProduits, dansFiltre } = await import('../functions/_shared/lbc-action-logique.ts');
  // 1. « !! » ne sélectionne JAMAIS tout
  assert.match(controlerDemande({ action: 'bloquer', filtre: { date: '2026-10-30', produit: '!!' } }, T), /aucun mot exploitable|sans mot exploitable/);
  assert.match(controlerDemande({ action: 'boost', produit: '!! ??', pct: 50, jours: 3 }, T), /aucun mot exploitable/);
  assert.equal(controlerDemande({ action: 'bloquer', filtre: { date: '2026-10-30', produit: 'lit coffre' } }, T), null);
  assert.equal(controlerDemande({ action: 'bloquer', filtre: { date: '2026-10-30' } }, T), null, 'sans produit : tout le jour, voulu');
  assert.deepEqual(trouverProduits([{ id: '1', nom: 'Matelas' }, { id: '2', nom: 'Lit' }], '!!'), []);
  assert.equal(dansFiltre(ann({}), { date: '2026-10-30', produit: '!!' }), false);
  // 2. Pannes de lecture à l'aperçu : 502 explicite, jamais « ok, aucune annonce »
  const panne = { message: 'timeout', code: '' };
  const enPanne = (table) => { const b = base({ annonces: [ann({})], produits: [{ id: 'P1', nom: 'Matelas', actif: true }], rpc: () => ({ data: { jeton: J, lignes: [] }, error: null }) }); const from0 = b.sb.from; b.sb.from = (t) => { const q = from0(t); if (t === table) q.erreur = panne; return q; }; return b.sb; };
  let r = await traiter(BLOQUER, enPanne('lbc_annonces'), T); assert.equal(r.code, 502); assert.equal(r.corps.code, 'LECTURE'); assert.notEqual(r.corps.ok, true);
  r = await traiter({ action: 'boost', produit: 'matelas', pct: 50, jours: 3 }, enPanne('lbc_produits'), T); assert.equal(r.code, 502); assert.match(r.corps.erreur, /illisible/);
  r = await traiter({ action: 'boost', produitId: 'P1', pct: 50, jours: 3 }, enPanne('lbc_produits'), T); assert.equal(r.code, 502); assert.doesNotMatch(r.corps.erreur, /introuvable/);
});

test('réserves Codex #6 (5e passage) : seules les annulations établies sont « certaines » ; catalogue lu en entier', async () => {
  for (const code of ['08007', '08006', '08003', '40003', '57P01', 'XX000', 'ZZ999']) assert.equal(erreurSqlCertaine({ code }), false, code);
  for (const code of ['P0001', '23505', '22P02', '40001', '40P01', '57014', '42501']) assert.equal(erreurSqlCertaine({ code }), true, code);
  for (const code of ['08007', '40003']) {
    const r = await traiter({ ...BLOQUER, confirme: true, jeton: J, ids: ['a1'] }, base({ annonces: [ann({})], rpc: () => ({ data: null, error: { code, message: 'x' } }) }).sb, T);
    assert.equal(r.code, 502, code); assert.equal(r.corps.code, 'INDETERMINE'); assert.doesNotMatch(r.corps.erreur, /rien n’a été modifié/);
  }
  // 1 500 produits : la 2e correspondance est au-delà des 1 000 premiers → la recherche voit l'ambiguïté
  const produits = Array.from({ length: 1500 }, (_, i) => ({ id: 'P' + String(i).padStart(4, '0'), nom: 'Article ' + i, dim: '', actif: true }));
  produits[10] = { id: 'P0010', nom: 'Matelas Confort', dim: '140x190', actif: true }; produits[1400] = { id: 'P1400', nom: 'Matelas Confort', dim: '140x190', actif: true };
  const b = base({ produits, rpc: () => ({ data: { jeton: J, lignes: [] }, error: null }) });
  const r = await traiter({ action: 'boost', produit: 'matelas confort', pct: 50, jours: 3 }, b.sb, T);
  assert.equal(r.corps.ambigu, true, 'les deux matelas sont trouvés'); assert.deepEqual(r.corps.candidats.map((c) => c.id), ['P0010', 'P1400']);
  assert.ok(b.vus.lectures.filter((q) => q.table === 'lbc_produits').length >= 2, 'lecture par pages');
  const g = base({ produits: Array.from({ length: 21000 }, (_, i) => ({ id: 'X' + i, nom: 'Article', actif: true })), rpc: () => ({}) });
  assert.equal((await traiter({ action: 'boost', produit: 'matelas', pct: 50, jours: 3 }, g.sb, T)).corps.code, 'CATALOGUE');
});
