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
//  - appelApp(req, roles) : l'app navigateur. Exige x-app-secret ET une
//    SESSION serveur valide (en-tête x-session-token obtenu par le PIN,
//    table sessions_app, 12 h, révocable) dont le rôle est autorisé.
//    (v2 du 27/09 soir : x-app-secret seul ne suffit plus — il est public.)
//
// Aucune valeur de secret dans ce fichier (dépôt public).
// ════════════════════════════════════════════════════════════════════

const CRON_SECRET = Deno.env.get('INTERNAL_CRON_SECRET') || '';
const APP_SECRET = Deno.env.get('APP_SECRET') || '';
const SB_URL = Deno.env.get('SUPABASE_URL') || '';

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
const CLE_SERVEUR = CLES[0] || '';

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

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type SessionApp = { role: string; livreur: string | null };

export async function sessionApp(req: Request): Promise<SessionApp | null> {
  const s = req.headers.get('x-app-secret') || '';
  if (!APP_SECRET || !egal(s, APP_SECRET)) return null;
  const tok = (req.headers.get('x-session-token') || '').trim();
  if (!/^[0-9a-f]{64}$/.test(tok) || !CLE_SERVEUR) return null;
  const h = await sha256Hex(tok);
  const u = `${SB_URL}/rest/v1/sessions_app?select=role,livreur,expire_at,revoquee_at&jeton_hash=eq.${h}&limit=1`;
  const r = await fetch(u, { headers: { apikey: CLE_SERVEUR, Authorization: `Bearer ${CLE_SERVEUR}` } });
  if (!r.ok) return null;
  const rows = await r.json();
  const x = rows?.[0];
  if (!x || x.revoquee_at || Date.parse(x.expire_at) <= Date.now()) return null;
  return { role: x.role, livreur: x.livreur ?? null };
}

// roles : liste des rôles autorisés ('admin' | 'collab' | 'livreur')
export async function appelApp(req: Request, roles: string[] = ['admin', 'collab', 'livreur']): Promise<boolean> {
  const s = await sessionApp(req);
  return !!s && roles.includes(s.role);
}

export const EN_TETES_AUTORISES = 'authorization, content-type, apikey, x-client-info, x-app-secret, x-cron-secret, x-session-token';

export function refus(extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: false, error: 'appel non autorise' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': EN_TETES_AUTORISES, ...extraHeaders },
  });
}
