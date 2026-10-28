// Tests unitaires de supabase/functions/_shared/lbc-action-logique.ts (porte JARVIS → planning Leboncoin, 28/10/2026)
// Lancer : node --test supabase/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parametres, jetonValide, controlerDemande, dansFiltre, refusAnnonce, patchAnnonce, patchProduit, trouverProduits, verifierProduit, verifierAnnonces, vueAnnonce, zoneAnnonce, egal, MAX_ANNONCES } from '../functions/_shared/lbc-action-logique.ts';

const T = Date.parse('2026-10-28T10:00:00Z');
const J = '0f8fad5b-d9cb-469f-a165-70867728950e'; // 28/10 à Paris
const ann = (o) => ({ id: 'a1', date_pub: '2026-10-30', heure: '10:15', ville: 'Créteil', dept: 'IDF', collab_id: null, produit: 'Lit coffre blanc', dim: '160x200', validation: 'OFF', statut: 'À publier', lien: '', ...o });

test('liste fermée : suppression, prix, publication refusés', () => {
  for (const a of ['supprimer', 'prix', 'publier', 'titre', 'delete', '']) assert.match(controlerDemande({ action: a }, T), /non autorisée/);
  assert.equal(controlerDemande({ action: 'bloquer', filtre: { date: '2026-10-30' } }, T), null);
});

test('produits : forme du boost et de la pression, confirmation exige un identifiant précis', () => {
  assert.equal(controlerDemande({ action: 'boost', produit: 'matelas 140', pct: 50, jours: 3 }, T), null);
  assert.match(controlerDemande({ action: 'boost', produit: 'matelas 140', pct: 300, jours: 3 }, T), /\+25, \+50 ou \+100/);
  assert.match(controlerDemande({ action: 'boost', produit: 'matelas 140', pct: 50, jours: 30 }, T), /1, 3 ou 7 jours/);
  assert.match(controlerDemande({ action: 'boost', produit: 'matelas 140', pct: 50, jours: 3, confirme: true }, T), /refais l’aperçu/);
  assert.match(controlerDemande({ action: 'boost', produitId: 'P-12', pct: 50, jours: 3, confirme: true }, T), /jeton/);
  assert.equal(controlerDemande({ action: 'boost', produitId: 'P-12', pct: 50, jours: 3, confirme: true, jeton: J }, T), null);
  assert.match(controlerDemande({ action: 'boost', produitId: "x'; drop", pct: 50, jours: 3 }, T), /invalide/);
  assert.match(controlerDemande({ action: 'poids_zone', produit: 'lit', zone: 'nord', poids: 50 }, T), /zone idf ou prov/);
  assert.match(controlerDemande({ action: 'poids_zone', produit: 'lit', zone: 'idf', poids: 120 }, T), /0 à 100/);
  assert.equal(controlerDemande({ action: 'poids_zone', produit: 'lit', zone: 'prov', poids: 0 }, T), null);
  assert.match(controlerDemande({ action: 'fin_boost' }, T), /précise le produit/);
});

test('annonces : jour passé, trop lointain, nouvelle date, liste confirmée', () => {
  assert.match(controlerDemande({ action: 'bloquer', filtre: { date: '2026-10-27' } }, T), /passé/);
  assert.match(controlerDemande({ action: 'bloquer', filtre: { date: '2026-12-31' } }, T), /trop lointain/);
  assert.match(controlerDemande({ action: 'bloquer', filtre: { date: '2026-02-30' } }, T), /AAAA-MM-JJ/);
  assert.match(controlerDemande({ action: 'bloquer', filtre: { date: '2026-10-30', zone: 'nord' } }, T), /zone du filtre/);
  assert.match(controlerDemande({ action: 'decaler', filtre: { date: '2026-10-30' } }, T), /nouveau jour/);
  assert.match(controlerDemande({ action: 'decaler', filtre: { date: '2026-10-30' }, nouvelleDate: '2026-10-30' }, T), /même/);
  assert.match(controlerDemande({ action: 'decaler', filtre: { date: '2026-10-30' }, nouvelleDate: '2026-10-20' }, T), /passé/);
  assert.equal(controlerDemande({ action: 'decaler', filtre: { date: '2026-10-30' }, nouvelleDate: '2026-10-31' }, T), null);
  assert.match(controlerDemande({ action: 'bloquer', filtre: { date: '2026-10-30' }, confirme: true, ids: ['a1'] }, T), /jeton/);
  assert.match(controlerDemande({ action: 'bloquer', filtre: { date: '2026-10-30' }, confirme: true, jeton: J }, T), /refais l’aperçu/);
  assert.match(controlerDemande({ action: 'bloquer', filtre: { date: '2026-10-30' }, confirme: true, ids: Array.from({ length: MAX_ANNONCES + 1 }, (_, i) => 'a' + i), jeton: J }, T), /100 annonces au plus/);
  assert.match(controlerDemande({ action: 'bloquer', filtre: { date: '2026-10-30' }, confirme: true, ids: ['a1', 'a1'], jeton: J }, T), /double/);
  assert.equal(controlerDemande({ action: 'bloquer', filtre: { date: '2026-10-30' }, confirme: true, ids: ['a1', 'a2'], jeton: J }, T), null);
});

test('filtre : jour, zone, produit (dimensions écrites de plusieurs façons)', () => {
  const f = { date: '2026-10-30', produit: 'lit coffre 160', zone: 'idf' };
  assert.equal(dansFiltre(ann({}), f), true);
  assert.equal(dansFiltre(ann({ dim: '160 x 200' }), { date: '2026-10-30', produit: 'coffre 160x200' }), true);
  assert.equal(dansFiltre(ann({ dim: '140x190' }), f), false, 'autre dimension');
  assert.equal(dansFiltre(ann({ produit: 'Matelas mémoire' }), f), false);
  assert.equal(dansFiltre(ann({ dim: '1600x200' }), { date: '2026-10-30', produit: '160' }), false, '160 ne correspond pas à 1600');
  assert.equal(dansFiltre(ann({ date_pub: '2026-10-31' }), f), false);
  assert.equal(zoneAnnonce(ann({ dept: 'PROV', collab_id: 'B' })), 'pb'); assert.equal(zoneAnnonce(ann({ dept: 'PROV', collab_id: 'A' })), 'pa');
  assert.equal(dansFiltre(ann({ dept: 'PROV', collab_id: 'A' }), { date: '2026-10-30', zone: 'prov' }), true);
  assert.equal(dansFiltre(ann({ dept: 'PROV', collab_id: 'A' }), { date: '2026-10-30', zone: 'pb' }), false);
  assert.equal(dansFiltre(ann({}), { date: '2026-10-30', produit: 'lit coffre Créteil' }), false, 'la ville n’entre pas dans la recherche produit');
});

test('annonces protégées : passées, publiées (validées ou avec lien), déjà bloquées', () => {
  assert.equal(refusAnnonce(ann({}), 'bloquer', T), null);
  assert.equal(refusAnnonce(ann({ date_pub: '2026-10-27' }), 'bloquer', T), 'jour passé');
  assert.equal(refusAnnonce(ann({ validation: 'ON' }), 'decaler', T), 'déjà publiée');
  assert.equal(refusAnnonce(ann({ lien: 'https://www.leboncoin.fr/ad/x/1' }), 'bloquer', T), 'déjà publiée');
  assert.equal(refusAnnonce(ann({ statut: 'Bloqué' }), 'bloquer', T), 'déjà bloquée');
  assert.equal(refusAnnonce(ann({ statut: 'Bloqué' }), 'debloquer', T), null);
  assert.equal(refusAnnonce(ann({}), 'debloquer', T), 'pas bloquée');
  assert.equal(refusAnnonce(ann({ date_pub: '2026-10-28' }), 'bloquer', T), null, 'aujourd’hui reste modifiable si non publiée');
});

test('changements écrits : seulement les colonnes prévues ; relecture vérifiée', () => {
  const q = '2026-10-28T10:00:00.000Z';
  assert.deepEqual(patchAnnonce({ action: 'bloquer' }, q), { statut: 'Bloqué', validation: 'OFF', updated_at: q });
  assert.deepEqual(patchAnnonce({ action: 'debloquer' }, q), { statut: 'À publier', updated_at: q });
  assert.deepEqual(patchAnnonce({ action: 'decaler', nouvelleDate: '2026-11-02' }, q), { date_pub: '2026-11-02', updated_at: q });
  assert.throws(() => patchAnnonce({ action: 'supprimer' }, q));
  assert.deepEqual(patchProduit({ action: 'boost', pct: 50, jours: 3 }, T, q), { boost_pct: 50, boost_until: '2026-10-31', updated_at: q });
  assert.deepEqual(patchProduit({ action: 'fin_boost' }, T, q), { boost_pct: null, boost_until: null, updated_at: q });
  assert.deepEqual(patchProduit({ action: 'poids_zone', zone: 'prov', poids: 70 }, T, q), { poids_prov: 70, updated_at: q });
  assert.equal(verifierProduit({ id: 'p', boost_pct: 50, boost_until: '2026-10-31' }, { boost_pct: 50, boost_until: '2026-10-31', updated_at: q }), true);
  assert.equal(verifierProduit({ id: 'p', boost_pct: 25, boost_until: '2026-10-31' }, { boost_pct: 50, boost_until: '2026-10-31' }), false);
  assert.equal(verifierProduit(null, { boost_pct: 50 }), false);
  assert.equal(verifierAnnonces([ann({ statut: 'Bloqué' }), ann({ id: 'a2', statut: 'Bloqué' })], ['a1', 'a2'], { statut: 'Bloqué', validation: 'OFF' }), true);
  assert.equal(verifierAnnonces([ann({ statut: 'Bloqué' }), ann({ id: 'a2' })], ['a1', 'a2'], { statut: 'Bloqué', validation: 'OFF' }), false, 'une annonce non modifiée');
  assert.equal(verifierAnnonces([ann({ statut: 'Bloqué' })], ['a1', 'a2'], { statut: 'Bloqué' }), false, 'une annonce manquante');
  assert.equal(verifierAnnonces([ann({ date_pub: '2026-11-02T00:00:00' })], ['a1'], { date_pub: '2026-11-02' }), true);
});

test('produits : recherche par mots, inactifs exclus ; vue sans champ superflu ; secret comparé en temps constant', () => {
  const P = [{ id: '1', nom: 'Matelas Confort', dim: '140x190' }, { id: '2', nom: 'Matelas Confort', dim: '160x200' }, { id: '3', nom: 'Lit coffre noir', dim: '140x190', actif: false }];
  assert.deepEqual(trouverProduits(P, 'matelas 140').map((p) => p.id), ['1']);
  assert.deepEqual(trouverProduits(P, 'matelas').map((p) => p.id), ['1', '2']);
  assert.deepEqual(trouverProduits(P, 'lit coffre'), []);
  assert.deepEqual(Object.keys(vueAnnonce(ann({ texte: 'description', photo: 'x.jpg', commentaire: 'note' }))).sort(), ['date_pub', 'dim', 'heure', 'id', 'produit', 'statut', 'ville', 'zone']);
  assert.equal(egal('abc', 'abc'), true); assert.equal(egal('abc', 'abd'), false); assert.equal(egal('', ''), false);
});

test('paramètres figés avec l’aperçu : seulement ce qui change l’écriture ; jeton au format UUID', () => {
  assert.deepEqual(parametres({ action: 'boost', produit: 'matelas', produitId: 'P1', pct: '50', jours: 3, confirme: true, jeton: J }), { pct: 50, jours: 3 });
  assert.deepEqual(parametres({ action: 'decaler', filtre: { date: '2026-10-30', produit: 'lit', zone: 'pb' }, nouvelleDate: '2026-10-31', ids: ['a'] }), { filtre: { date: '2026-10-30', produit: 'lit', zone: 'pb' }, nouvelleDate: '2026-10-31' });
  assert.deepEqual(parametres({ action: 'bloquer', filtre: { date: '2026-10-30' } }), { filtre: { date: '2026-10-30' } });
  assert.deepEqual(parametres({ action: 'fin_boost', produit: 'x' }), {});
  assert.equal(jetonValide(J), true); assert.equal(jetonValide('abc'), false); assert.equal(jetonValide("'; drop"), false);
});
