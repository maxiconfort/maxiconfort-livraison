// ════════════════════════════════════════════════════════════════════
// Contrôle d'appelant des Edge Functions (incident clés Supabase, 27/09/2026)
// ════════════════════════════════════════════════════════════════════
// Les fonctions sont déployées avec --no-verify-jwt (les nouvelles clés
// sb_publishable_/sb_secret_ ne sont pas des JWT). Ce module décide qui
// a le droit de les appeler :
//
//  - appelInterne(req) : crons pg_cron (en-tête x-cron-secret = secret
//    INTERNAL_CRON_SECRET, stocké dans Vault) ou une autre Edge Function /
//    un script serveur qui présente une clé secrète du projet
//    (Authorization: Bearer sb_secret_… ou apikey: sb_secret_…).
//  - appelApp(req)     : l'app navigateur (en-tête x-app-secret = APP_SECRET).
//    ⚠️ APP_SECRET est présent dans la page publique : ce contrôle bloque
//    les robots et les curieux, pas un attaquant qui lit le code source.
//    Vraie solution = comptes Supabase Auth individuels (plan MAXI BRAIN).
//
// Aucune valeur de secret dans ce fichier (dépôt public).
// ════════════════════════════════════════════════════════════════════

const CRON_SECRET = Deno.env.get('INTERNAL_CRON_SECRET') || '';
const APP_SECRET = Deno.env.get('APP_SECRET') || '';

function clesSecretes(): string[] {
  const out: string[] = [];
  const sr = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (sr.startsWith('sb_secret_')) out.push(sr); // jamais la clé legacy (JWT)
  try {
    const j = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
    for (const v of Object.values(j)) if (typeof v === 'string' && v.startsWith('sb_secret_')) out.push(v);
  } catch { /* ignore */ }
  return out;
}
const CLES = clesSecretes();

function egal(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function appelInterne(req: Request): boolean {
  const x = req.headers.get('x-cron-secret') || '';
  if (CRON_SECRET && egal(x, CRON_SECRET)) return true;
  const auth = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const ak = (req.headers.get('apikey') || '').trim();
  for (const k of CLES) if (egal(auth, k) || egal(ak, k)) return true;
  return false;
}

export function appelApp(req: Request): boolean {
  const s = req.headers.get('x-app-secret') || '';
  return !!APP_SECRET && egal(s, APP_SECRET);
}

export const EN_TETES_AUTORISES = 'authorization, content-type, apikey, x-client-info, x-app-secret, x-cron-secret';

export function refus(extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: false, error: 'appel non autorise' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...extraHeaders },
  });
}
