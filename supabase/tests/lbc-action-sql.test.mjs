// Test RÉEL de la migration 036 (lbc-action) sur un Postgres en mémoire (PGlite) : aperçu enregistré, jeton à usage unique,
// paramètres altérés, ligne modifiée entre l'aperçu et la confirmation (RIEN n'est écrit), publication concurrente, produit,
// expiration, journal en ajout seul, droits. Colonnes en date ET en texte (types réels non supposés).
// Lancer : npm i --no-save @electric-sql/pglite@0.2.17 puis node --test supabase/tests/lbc-action-sql.test.mjs
// (sans PGlite, le test est sauté). Variable PGLITE = chemin du module si installé ailleurs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
let PGlite = null;
try { ({ PGlite } = await import(process.env.PGLITE || '@electric-sql/pglite')); } catch { /* absent */ }
const MIG = fs.readFileSync(new URL('../migrations/036_lbc_action.sql', import.meta.url), 'utf8');
async function essai(typeDate) {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table public.lbc_annonces (id text primary key, date_pub ${typeDate}, heure text, ville text, dept text, collab_id text, produit text, dim text, validation text, statut text, lien text, texte text, updated_at ${typeDate === 'date' ? 'timestamptz' : 'text'});
    create table public.lbc_produits (id text primary key, nom text, dim text, actif boolean, boost_pct ${typeDate === 'date' ? 'int' : 'text'}, boost_until ${typeDate}, poids_idf ${typeDate === 'date' ? 'int' : 'text'}, poids_prov int, updated_at ${typeDate === 'date' ? 'timestamptz' : 'text'});`);
  await db.exec(MIG);
  const auj = (await db.query(`select interne.lbc_jour_paris() j`)).rows[0].j;
  const plus = (n) => new Date(Date.parse(auj + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  await db.query(`insert into lbc_annonces values ('a1',$1,'10:00','Créteil','IDF',null,'Lit coffre','160x200','OFF','À publier','', 'x', null),('a2',$1,'11:00','Vitry','IDF',null,'Lit coffre','160x200','OFF','À publier','', 'x', null),('a3',$1,'12:00','Lyon','PROV','A','Matelas','140x190','OFF','À publier','', 'x', null)`, [plus(1)]);
  await db.query(`insert into lbc_produits values ('P1','Matelas','140x190',true,null,null,null,null,null)`);
  const q = async (s, p) => (await db.query(s, p)).rows[0];
  const res = {};
  const CIBLES = new Map(); // jeton → cibles de l'aperçu (ce que l'Edge Function renvoie à la confirmation)
  const apLignes = async (action, demande, ids) => (await q(`select public.lbc_action_enregistrer_apercu($1,$2::jsonb,$3::text[]) r`, [action, JSON.stringify(demande), ids])).r;
  const ap = async (action, demande, ids) => { const x = await apLignes(action, demande, ids); CIBLES.set(x.jeton, ids); return x.jeton; };
  const app = async (jeton, action, demande, ids = CIBLES.get(jeton)) => (await q(`select public.lbc_action_appliquer($1::uuid,$2,$3::jsonb,$4::text[]) r`, [jeton, action, JSON.stringify(demande), ids])).r;
  const D = { filtre: { date: plus(1) } };
  // 1. cas normal : tout le lot
  let j = await ap('bloquer', D, ['a1', 'a2']); res.normal = await app(j, 'bloquer', D);
  res.apres = (await db.query(`select id, statut, validation from lbc_annonces order by id`)).rows.map((r) => r.id + ':' + r.statut).join(' ');
  res.reutilise = (await app(j, 'bloquer', D)).motif;
  // 2. paramètres altérés
  j = await ap('debloquer', D, ['a1']); res.altere = (await app(j, 'debloquer', { filtre: { date: plus(2) } })).code;
  // 3. état modifié entre aperçu et confirmation (ville) + une autre ligne propre : RIEN n'est écrit
  j = await ap('decaler', { ...D, nouvelleDate: plus(3) }, ['a3', 'a1']);
  await db.query(`update lbc_annonces set heure='13:00' where id='a3'`);
  const avant = (await db.query(`select id, date_pub::text d from lbc_annonces order by id`)).rows.map((r) => r.d).join(',');
  res.change = await app(j, 'decaler', { ...D, nouvelleDate: plus(3) });
  res.rienEcrit = avant === (await db.query(`select id, date_pub::text d from lbc_annonces order by id`)).rows.map((r) => r.d).join(',');
  // 4. publication concurrente (lien ajouté) après aperçu
  j = await ap('decaler', { ...D, nouvelleDate: plus(3) }, ['a3']);
  await db.query(`update lbc_annonces set lien='https://www.leboncoin.fr/ad/1' where id='a3'`);
  res.publiee = (await app(j, 'decaler', { ...D, nouvelleDate: plus(3) })).code;
  // 5. débloquer a1, a2 puis décaler a2
  j = await ap('debloquer', D, ['a1', 'a2']); res.debloque = (await app(j, 'debloquer', D)).modifiees;
  j = await ap('decaler', { ...D, nouvelleDate: plus(4) }, ['a2']); res.decale = (await app(j, 'decaler', { ...D, nouvelleDate: plus(4) })).modifiees;
  res.dateA2 = (await q(`select date_pub::text d from lbc_annonces where id='a2'`)).d.slice(0, 10) === plus(4);
  // 6. produit : boost, puis produit modifié entre aperçu et confirmation
  j = await ap('boost', { pct: 50, jours: 3, jusqu: plus(3) }, ['P1']); res.boost = (await app(j, 'boost', { pct: 50, jours: 3 })).ok;
  res.boostVal = await q(`select boost_pct::text b, boost_until::text u from lbc_produits`);
  j = await ap('poids_zone', { zone: 'idf', poids: 70 }, ['P1']); await db.query(`update lbc_produits set boost_pct=25`);
  res.produitChange = (await app(j, 'poids_zone', { zone: 'idf', poids: 70 })).code;
  // 7. expiré
  j = await ap('fin_boost', {}, ['P1']); await db.query(`update lbc_action_apercus set cree_le = now() - interval '11 minutes' where jeton=$1`, [j]);
  res.expire = (await app(j, 'fin_boost', {})).motif;
  // 9. (2e passage) l'aperçu renvoie les lignes empreintes ; cibles substituées / ajoutées / retirées à la confirmation : refus, rien écrit
  const x = await apLignes('bloquer', D, ['a3', 'a1']); res.lignes = x.lignes.map((l) => l.id + ':' + l.ville + ':' + String(l.lien ?? '')).join(' ');
  CIBLES.set(x.jeton, ['a3', 'a1']);
  const st0 = (await db.query(`select string_agg(id || statut, ',' order by id) s from lbc_annonces`)).rows[0].s;
  res.substitue = (await app(x.jeton, 'bloquer', D, ['a2', 'a1'])).code;
  res.brule = (await app(x.jeton, 'bloquer', D)).motif; // jeton brûlé par la tentative
  j = await ap('bloquer', D, ['a1']); res.ajout = (await app(j, 'bloquer', D, ['a1', 'a2'])).code;
  j = await ap('bloquer', D, ['a1', 'a2']); res.retrait = (await app(j, 'bloquer', D, ['a1'])).code;
  res.rienEcrit2 = st0 === (await db.query(`select string_agg(id || statut, ',' order by id) s from lbc_annonces`)).rows[0].s;
  j = await ap('bloquer', D, ['a1', 'a2']); const ok2 = await app(j, 'bloquer', D, ['a2', 'a1']); res.ordreLibre = ok2.ok; res.ciblesRenvoyees = ok2.cibles;
  // 10. (3e passage) échéance du boost FIGÉE dans le jeton : c'est elle qui est écrite (même si la confirmation la recalculerait
  //     autrement, ex. après minuit) ; absente ou hors bornes : aperçu refusé
  j = await ap('boost', { pct: 25, jours: 1, jusqu: plus(1) }, ['P1']);
  await db.query(`update lbc_action_apercus set demande = jsonb_set(demande, '{jusqu}', to_jsonb($2::text)) where jeton = $1`, [j, plus(2)]); // simule « montré : J+2 »
  const fige = await app(j, 'boost', { pct: 25, jours: 1 }); res.figeOk = fige.ok; res.figeRenvoye = fige.jusqu; res.figeAttendu = plus(2);
  res.figeEcrit = String((await q(`select boost_until::text u from lbc_produits`)).u).slice(0, 10) === plus(2);
  for (const [nom, dem] of [['sansEcheance', { pct: 50, jours: 3 }], ['echeancePassee', { pct: 50, jours: 3, jusqu: plus(0) }], ['echeanceLointaine', { pct: 50, jours: 3, jusqu: plus(9) }]]) {
    try { await apLignes('boost', dem, ['P1']); res[nom] = 'ACCEPTÉ'; } catch { res[nom] = 'refusé'; }
  }
  // 11. (3e passage) empreinte structurée : nom=NULL/dim='160' et nom='160'/dim=NULL ne se confondent plus
  await db.query(`insert into lbc_produits values ('P9', null, '160', true, null, null, null, null, null)`);
  j = await ap('poids_zone', { zone: 'prov', poids: 40 }, ['P9']);
  await db.query(`update lbc_produits set nom = '160', dim = null where id = 'P9'`);
  res.collision = (await app(j, 'poids_zone', { zone: 'prov', poids: 40 })).code;
  // 8. journal : ajout seul ; anon n'exécute pas
  res.journal = (await q(`select count(*) n, sum((resultat='OK')::int) ok from lbc_actions_journal`));
  try { await db.query(`delete from lbc_actions_journal`); res.suppr = 'POSSIBLE'; } catch (e) { res.suppr = 'refusée'; }
  res.droitsAnon = (await q(`select has_function_privilege('anon','public.lbc_action_appliquer(uuid,text,jsonb,text[])','execute') a, has_function_privilege('service_role','public.lbc_action_appliquer(uuid,text,jsonb,text[])','execute') s`));
  return res;
}

for (const t of ['date', 'text']) test('migration 036 sur Postgres réel — colonnes ' + t, { skip: !PGlite && 'PGlite absent' }, async () => {
  const r = await essai(t);
  assert.equal(r.normal.ok, true); assert.equal(r.normal.modifiees, 2); assert.deepEqual(r.normal.cibles, ['a1', 'a2']); assert.equal(r.apres, 'a1:Bloqué a2:Bloqué a3:À publier');
  assert.equal(r.reutilise, 'aperçu déjà utilisé'); assert.equal(r.altere, 'APERCU');
  assert.equal(r.change.code, 'CHANGE'); assert.equal(r.rienEcrit, true, 'tout le lot ou rien');
  assert.equal(r.publiee, 'CHANGE', 'lien ajouté après l’aperçu : refus');
  assert.equal(r.debloque, 2); assert.equal(r.decale, 1); assert.equal(r.dateA2, true);
  assert.equal(r.boost, true); assert.equal(r.boostVal.b, '50'); assert.equal(r.produitChange, 'CHANGE');
  assert.match(r.expire, /expiré/); assert.equal(r.suppr, 'refusée'); assert.deepEqual(r.droitsAnon, { a: false, s: true });
  assert.equal(r.lignes, 'a1:Créteil: a3:Lyon:https://www.leboncoin.fr/ad/1', 'lignes empreintes renvoyées, triées');
  assert.equal(r.substitue, 'APERCU'); assert.equal(r.brule, 'aperçu déjà utilisé'); assert.equal(r.ajout, 'APERCU'); assert.equal(r.retrait, 'APERCU');
  assert.equal(r.rienEcrit2, true); assert.equal(r.ordreLibre, true); assert.deepEqual(r.ciblesRenvoyees, ['a1', 'a2']);
  assert.equal(r.figeOk, true); assert.equal(r.figeRenvoye, r.figeAttendu, 'la base renvoie l’échéance figée'); assert.equal(r.figeEcrit, true, 'l’échéance figée de l’aperçu est écrite telle quelle');
  assert.equal(r.sansEcheance, 'refusé'); assert.equal(r.echeancePassee, 'refusé'); assert.equal(r.echeanceLointaine, 'refusé');
  assert.equal(r.collision, 'CHANGE', 'NULL et valeurs déplacées : empreintes différentes');
  assert.equal(Number(r.journal.n), 14); assert.equal(Number(r.journal.ok), 6);
});
