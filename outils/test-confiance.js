// Banc de test « appareil de confiance » (v7.5.121 + migration 036, 05/11/2026).
// Usage : node outils/test-confiance.js
// Il EXTRAIT le vrai code de maxiconfort-v7.html (session de l'appareil + bloc CONF) et l'exécute dans un bac à sable :
// aucune connexion, aucune donnée réelle. Il relit aussi la migration 036 (contrôles de forme, sans base).
// Décision de Borhen (05/11/2026 16:02) : « 40 jours collab, garde les mêmes 4 chiffres ».
const fs = require('fs'), path = require('path'), vm = require('vm');
const racine = path.join(__dirname, '..');
const html = fs.readFileSync(process.env.MX_HTML || path.join(racine, 'maxiconfort-v7.html'), 'utf8');
const sql = fs.readFileSync(path.join(racine, 'supabase', 'migrations', '036_session_confiance_collab.sql'), 'utf8');
let ok = 0, ko = 0;
const test = (nom, cond, det) => { if (cond) { ok++; console.log('  OK    ' + nom); } else { ko++; console.log('  ÉCHEC ' + nom + (det ? ' — ' + String(det).slice(0, 200) : '')); } };
const entre = (a, b) => { const i = html.indexOf(a); if (i < 0) throw new Error('introuvable : ' + a); const j = html.indexOf(b, i); if (j < 0) throw new Error('introuvable : ' + b); return html.slice(i, j); };

const blocSession = entre('var MX_SESSION_CLE', '// Intercepteur fetch');
const blocReprise = entre('async function repriseSessionConfiance', "document.addEventListener('DOMContentLoaded', function(){ setTimeout(function(){ repriseSessionConfiance");
const blocEcrire = entre('function sessionEcrire(s)', 'function sessionEffacer()');

function bac(opts) {
  const stock = {};
  const b = {
    console, Math, Date, JSON, String, Number, Object, isFinite,
    localStorage: { getItem: k => (k in stock ? stock[k] : null), setItem: (k, v) => { stock[k] = String(v); }, removeItem: k => { delete stock[k]; } },
    navigator: { onLine: opts.enLigne !== false },
    role: null, _connecte: null, _efface: 0,
    loginOk(r) { b.role = r; b._connecte = r; },
    sessionEffacer() { b._efface++; b.MX_SESSION_MEM = null; delete stock.mx_session_app; },
    rpcPin: async (fn, body) => { b._appel = { fn, body }; if (opts.erreurReseau) throw new Error('HTTP 0'); return opts.reponse; },
  };
  vm.createContext(b);
  vm.runInContext(blocSession + '\nvar SESSION_CLE = MX_SESSION_CLE;\n' + blocEcrire + '\n' + blocReprise, b);
  return { b, stock };
}

(async () => {
  console.log('\n1. DURÉE DE LA SESSION SUR L\'APPAREIL');
  let { b, stock } = bac({});
  vm.runInContext("sessionEcrire({ jeton: 'a'.repeat(64), role: 'collab', expire: new Date(Date.now()+40*864e5).toISOString(), confiance: true })", b);
  let s = JSON.parse(stock.mx_session_app);
  const jours = (s.fin_locale - Date.now()) / 864e5;
  test('collab + case cochée : fin locale à 40 jours', jours > 39.9 && jours <= 40, jours);
  ({ b, stock } = bac({}));
  vm.runInContext("sessionEcrire({ jeton: 'a'.repeat(64), role: 'collab', expire: new Date(Date.now()+12*36e5).toISOString(), confiance: false })", b);
  s = JSON.parse(stock.mx_session_app);
  test('collab sans la case : 12 h comme avant', Math.abs((s.fin_locale - Date.now()) / 36e5 - 12) < 0.01);
  ({ b, stock } = bac({}));
  vm.runInContext("sessionEcrire({ jeton: 'a'.repeat(64), role: 'admin', expire: new Date(Date.now()+12*36e5).toISOString(), confiance: true })", b);
  s = JSON.parse(stock.mx_session_app);
  test('admin, même avec confiance=true : 12 h (jamais 40 jours)', Math.abs((s.fin_locale - Date.now()) / 36e5 - 12) < 0.01);

  console.log('\n2. RÉOUVERTURE DE LA PAGE');
  const posee = (role, confiance, finMs) => JSON.stringify({ jeton: 'b'.repeat(64), role, confiance, expire: new Date(Date.now() + finMs).toISOString(), fin_locale: Date.now() + finMs });
  ({ b, stock } = bac({ reponse: { ok: true, role: 'collab' } }));
  stock.mx_session_app = posee('collab', true, 20 * 864e5);
  test('session de confiance valide, serveur d\'accord : appli rouverte en collab sans code', (await b.repriseSessionConfiance()) === true && b._connecte === 'collab' && b._appel.fn === 'verifier_session');
  ({ b, stock } = bac({ reponse: { ok: false } }));
  stock.mx_session_app = posee('collab', true, 20 * 864e5);
  test('session révoquée côté serveur : écran du code et session effacée', (await b.repriseSessionConfiance()) === false && b._connecte === null && b._efface === 1);
  ({ b, stock } = bac({ reponse: { ok: true, role: 'admin' } }));
  stock.mx_session_app = posee('collab', true, 20 * 864e5);
  test('serveur répond un autre rôle : refus', (await b.repriseSessionConfiance()) === false && b._connecte === null);
  ({ b, stock } = bac({ reponse: { ok: true, role: 'collab' } }));
  stock.mx_session_app = posee('collab', false, 6 * 36e5);
  test('session collab ordinaire (12 h) : pas de reprise automatique (comportement inchangé)', (await b.repriseSessionConfiance()) === false && !b._appel);
  ({ b, stock } = bac({ reponse: { ok: true, role: 'admin' } }));
  stock.mx_session_app = posee('admin', true, 20 * 864e5);
  test('session admin marquée confiance : pas de reprise', (await b.repriseSessionConfiance()) === false && !b._appel);
  ({ b, stock } = bac({ reponse: { ok: true, role: 'collab' } }));
  stock.mx_session_app = posee('collab', true, -1000);
  test('session de confiance expirée : pas de reprise', (await b.repriseSessionConfiance()) === false && b._connecte === null);
  ({ b, stock } = bac({ erreurReseau: true }));
  stock.mx_session_app = posee('collab', true, 20 * 864e5);
  test('réseau en panne : reprise sur la session locale (le serveur reste juge de chaque requête)', (await b.repriseSessionConfiance()) === true && b._connecte === 'collab');

  console.log('\n3. ÉCRAN DU CODE');
  const pick = entre('function pickRole(r)', 'function pk(k)');
  test('la case n\'est montrée que pour la Collaboratrice', /_cw\.style\.display = r==='collab' \? 'block' : 'none'/.test(pick));
  test('la case est décochée à chaque choix de rôle', /_cc\.checked = false/.test(pick));
  const check = entre('async function checkPin()', 'function backLogin()');
  test('case cochée → connexion_pin_confiance (PIN seul, rôle imposé par le serveur)', /rpcPin\('connexion_pin_confiance', \{ p_pin: essai \}\)/.test(check));
  test('fonction absente du serveur (404) → connexion normale 12 h', /HTTP 404/.test(check) && /confiance = false/.test(check));
  test('la session n\'est marquée confiance que si le serveur le confirme', /confiance: !!\(confiance && res\.confiance === true\)/.test(check));
  test('libellé visible « Rester connecté sur cet ordinateur (40 jours) »', html.includes('Rester connecté sur cet ordinateur (40 jours)'));
  test('Déconnexion efface toujours la session (inchangé)', /function doLogout\(\)[\s\S]{0,400}rpcPin\('deconnexion'[\s\S]{0,120}sessionEffacer/.test(html));

  console.log('\n4. MIGRATION 036 (relue sans base)');
  test('réutilise connexion_pin pour le rôle collab (mêmes contrôles de PIN et d\'essais)', /public\.connexion_pin\('collab', p_pin, null\)/.test(sql));
  test('aucun autre rôle possible', !/connexion_pin\('admin'|connexion_pin\('livreur'|p_role/.test(sql));
  test('expiration 40 jours', /interval '40 days'/.test(sql));
  test('ne touche pas aux empreintes de PIN (le code reste le même)', !/secrets_serveur|crypt\(/.test(sql));
  test('au plus 3 appareils de confiance actifs', /limit 2/.test(sql) && /revoquee_at = now\(\)/.test(sql));
  test('droits : retirés à tous puis donnés au seul rôle anon (comme connexion_pin)', /revoke all on function public\.connexion_pin_confiance\(text\) from public, anon, authenticated/.test(sql) && /grant execute on function public\.connexion_pin_confiance\(text\) to anon/.test(sql));
  test('aucune valeur secrète dans la migration', !/sb_secret_|mc_[A-Za-z0-9_-]{20,}/.test(sql));

  console.log('\n5. MISE EN LIGNE');
  test('CACHE_VERSION augmentée (v7-5-121)', /CACHE_VERSION = 'maxiconfort-v7-5-121'/.test(fs.readFileSync(path.join(racine, 'service-worker.js'), 'utf8')));

  console.log('\n' + ok + ' OK, ' + ko + ' échec(s)');
  process.exit(ko ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
