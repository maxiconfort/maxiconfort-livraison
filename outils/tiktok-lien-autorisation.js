// Génère un lien d'autorisation TikTok Shop (usage unique, valable 30 min, avec « state »).
// Usage : node outils\tiktok-lien-autorisation.js
// Lit INTERNAL_CRON_SECRET et SUPABASE_URL dans ..\.env (jamais versionné). N'affiche aucun secret.
const fs = require('fs');
const path = require('path');
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)
  .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
(async () => {
  const r = await fetch(`${env.SUPABASE_URL}/functions/v1/tiktok-oauth-callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': env.INTERNAL_CRON_SECRET },
    body: JSON.stringify({ action: 'preparer' }),
  });
  const j = await r.json();
  if (!j.ok) { console.error('Echec :', r.status, j); process.exit(1); }
  console.log('Lien a ouvrir (connecte au compte vendeur TikTok Shop), valable jusqu\'a', new Date(j.expire_at).toLocaleString('fr-FR'), ':');
  console.log(j.url);
})();
