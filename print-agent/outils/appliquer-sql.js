// Applique un fichier SQL sur le projet Supabase via l'API Management
// (meme methode que les migrations 011/012, sans afficher aucun secret).
// Usage : node print-agent\outils\appliquer-sql.js supabase\migrations\013_gls_etiquette_imprimee.sql
const fs = require('fs');
const path = require('path');

const RACINE = path.resolve(__dirname, '..', '..');
const PROJECT_REF = 'jmvfjtnmebstkzcfnlgp';

const env = {};
for (const l of fs.readFileSync(path.join(RACINE, '.env'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const PAT = env.SUPABASE_ACCESS_TOKEN;
if (!PAT) { console.error('SUPABASE_ACCESS_TOKEN manquant dans .env'); process.exit(1); }

const fichier = process.argv[2];
if (!fichier) { console.error('Usage : node appliquer-sql.js <fichier.sql>'); process.exit(1); }
const sql = fs.readFileSync(path.resolve(RACINE, fichier), 'utf8');

fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
}).then(async (r) => {
  const txt = await r.text();
  console.log(`HTTP ${r.status}`);
  console.log(txt.slice(0, 2000));
  process.exit(r.ok ? 0 : 2);
}).catch((e) => { console.error(e.message); process.exit(3); });
