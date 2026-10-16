// Banc de test du réseau de l'agent d'impression (16/10/2026).
// Usage : node print-agent/outils/test-reseau.js
// Il EXTRAIT le vrai code de agent-impression.js (estErreurReseau + rest) et l'exécute dans
// un bac à sable avec un faux `fetch` : aucune connexion, aucune donnée réelle.
//
// Ce qui est vérifié : une connexion morte (ECONNRESET / socket / délai dépassé) doit être
// rattrapée toute seule au nouvel essai, sans perdre le tour — c'était la cause des 22 à 45
// « tours interrompus » par jour et des trous de 16 à 33 min sans impression.
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'agent-impression.js'), 'utf8');
function extrait(debut, fin) {
  const i = src.indexOf(debut); if (i < 0) throw new Error('introuvable : ' + debut);
  const j = src.indexOf(fin, i); if (j < 0) throw new Error('fin introuvable : ' + fin);
  return src.slice(i, j);
}
const bloc = extrait('const DELAI_REQUETE_MS', '// Les id de commande contiennent');

function nouveauBac(reponses) {
  const appels = [];
  const bac = {
    console, Date, Error, String, Promise, setTimeout, clearTimeout, AbortController, Object, JSON,
    SUPABASE_URL: 'https://exemple.invalid', ENTETES: {},
    AbortSignal: { timeout: () => null },
    fetch: async (url, opt) => {
      appels.push({ url, methode: (opt && opt.method) || 'GET' });
      const r = reponses[appels.length - 1] !== undefined ? reponses[appels.length - 1] : reponses[reponses.length - 1];
      if (r instanceof Error) throw r;
      return r;
    },
    _appels: appels,
  };
  vm.createContext(bac);
  vm.runInContext(bloc, bac);
  return bac;
}
// les valeurs déclarées en `const` ne sont pas des propriétés du bac : on les lit dans son contexte
const lire = (bac, nom) => vm.runInContext(nom, bac);
const okRep = { ok: true, text: async () => '' };
const err = (message, code) => { const e = new Error(message); if (code) e.cause = { code }; return e; };

let ok = 0, ko = 0;
const test = (nom, cond, det) => { if (cond) { ok++; console.log('  OK    ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (det !== undefined ? ' — ' + JSON.stringify(det) : '')); } };

(async () => {
  console.log('\n1. RECONNAISSANCE DES INCIDENTS RÉSEAU');
  let bac = nouveauBac([okRep]);
  test('connexion coupée par le serveur (ECONNRESET)', lire(bac, "estErreurReseau")(err('fetch failed', 'ECONNRESET')) === true);
  test('connexion morte réutilisée (UND_ERR_SOCKET)', lire(bac, "estErreurReseau")(err('fetch failed', 'UND_ERR_SOCKET')) === true);
  test('délai dépassé', lire(bac, "estErreurReseau")(Object.assign(new Error('x'), { name: 'TimeoutError' })) === true);
  test('nom de domaine introuvable', lire(bac, "estErreurReseau")(err('fetch failed', 'ENOTFOUND')) === true);
  test('une erreur de la base n\'est PAS un incident réseau', lire(bac, "estErreurReseau")(new Error('Supabase 401 Unauthorized')) === false);

  console.log('\n2. REPRISE AUTOMATIQUE (le cœur du correctif)');
  bac = nouveauBac([err('fetch failed', 'ECONNRESET'), okRep]);
  let r = await lire(bac, "rest")('commandes?select=id');
  test('1 connexion morte puis réussite : le tour n\'est pas perdu', r === okRep);
  test('2 appels au total', bac._appels.length === 2, bac._appels.length);
  test('la reprise est comptée', lire(bac, "STATS_RESEAU").reprises === 1 && lire(bac, "STATS_RESEAU").echecs === 0, lire(bac, "STATS_RESEAU"));

  bac = nouveauBac([err('fetch failed', 'UND_ERR_SOCKET'), err('fetch failed', 'ECONNRESET'), okRep]);
  r = await lire(bac, "rest")('commandes?select=id');
  test('2 incidents d\'affilée : rattrapé au 3e essai', r === okRep && bac._appels.length === 3);

  console.log('\n3. CE QU\'ON NE RÉESSAIE PAS');
  bac = nouveauBac([err('fetch failed', 'ECONNRESET'), okRep]);
  let leve = false;
  try { await lire(bac, "rest")('chargements', { method: 'POST', body: '{}' }); } catch (e) { leve = true; }
  test('un envoi POST n\'est jamais rejoué (risque de doublon)', leve && bac._appels.length === 1, bac._appels.length);

  bac = nouveauBac([{ ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'clé refusée' }]);
  leve = false;
  try { await lire(bac, "rest")('commandes?select=id'); } catch (e) { leve = /401/.test(e.message); }
  test('une clé refusée remonte tout de suite (pas de nouvel essai)', leve && bac._appels.length === 1, bac._appels.length);

  console.log('\n4. VRAIE PANNE : ON ABANDONNE PROPREMENT');
  bac = nouveauBac([err('fetch failed', 'ECONNRESET')]);
  leve = false;
  try { await lire(bac, "rest")('commandes?select=id'); } catch (e) { leve = true; }
  test('3 essais puis abandon', leve && bac._appels.length === 3, bac._appels.length);
  test('l\'échec est compté', lire(bac, "STATS_RESEAU").echecs === 1 && lire(bac, "STATS_RESEAU").reprises === 0, lire(bac, "STATS_RESEAU"));

  console.log('\n5. RÉGLAGES');
  test('délai maximum ramené à 20 s', lire(bac, "DELAI_REQUETE_MS") === 20000, lire(bac, "DELAI_REQUETE_MS"));
  test('3 essais au maximum', lire(bac, "ESSAIS_RESEAU") === 3);

  console.log('\n' + ok + ' OK, ' + ko + ' échec(s)');
  process.exit(ko ? 1 : 0);
})();
