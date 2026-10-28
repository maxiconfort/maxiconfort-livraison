// ════════════════════════════════════════════════════════════════════
// Edge Function : lbc-action (v1 — 28/10/2026, lot LBC 2)
// ════════════════════════════════════════════════════════════════════
// Porte RÉSERVÉE À JARVIS pour piloter le PLANNING de l'outil Leboncoin (tables lbc_produits / lbc_annonces), en 2 temps :
//   1. { ..., confirme: false } → APERÇU : contrôle, lecture, liste exacte de ce qui changera ; l'aperçu est ENREGISTRÉ par la
//      base (migration 036 : cibles + empreinte de chaque ligne + paramètres) et un JETON à usage unique (10 min) est renvoyé ;
//   2. { ..., confirme: true, jeton } → la base vérifie le jeton, les paramètres, l'empreinte de chaque ligne, et écrit TOUT LE
//      LOT OU RIEN dans une seule transaction (public.lbc_action_appliquer), avec journal (lbc_actions_journal).
// La validation humaine a lieu dans JARVIS (« Appliquer » + « Confirmer » de Borhen) ; le jeton prouve que la confirmation
// porte exactement sur l'aperçu montré. Liste fermée : _shared/lbc-action-logique.ts. Rien n'est publié sur Leboncoin.
// Appelant : en-tête x-lbc-secret = secret LBC_ACTION_SECRET (dédié, révocable en le changeant). Aucun autre accès.
// Mise en service : migration 036 puis
//   npx supabase functions deploy lbc-action --project-ref jmvfjtnmebstkzcfnlgp --no-verify-jwt --use-api
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { egal, type DemandeLbc } from '../_shared/lbc-action-logique.ts';
import { traiter } from '../_shared/lbc-action-traitement.ts';

const SB_URL = Deno.env.get('SUPABASE_URL') || '';
const SECRET = Deno.env.get('LBC_ACTION_SECRET') || '';
function cleServeur(): string {
  const sr = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (sr.startsWith('sb_secret_')) return sr;
  try { for (const v of Object.values(JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'))) if (typeof v === 'string' && v.startsWith('sb_secret_')) return v; } catch { /* */ }
  return '';
}
const CLE = cleServeur();
const sb = createClient(SB_URL, CLE, { auth: { autoRefreshToken: false, persistSession: false } });
const rep = (code: number, o: unknown) => new Response(JSON.stringify(o), { status: code, headers: { 'Content-Type': 'application/json' } });

// Toute la logique (aperçu, confirmation, relecture vérifiée) : _shared/lbc-action-traitement.ts (testée sous Node).
Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return rep(405, { ok: false, erreur: 'POST seulement' });
  if (!SECRET || !egal(req.headers.get('x-lbc-secret') || '', SECRET)) return rep(401, { ok: false, erreur: 'refusé' });
  if (!CLE) return rep(503, { ok: false, erreur: 'clé serveur absente' });
  let d: DemandeLbc; try { d = await req.json(); } catch { return rep(400, { ok: false, erreur: 'JSON invalide' }); }
  try { const r = await traiter(d, sb, Date.now()); return rep(r.code, r.corps); }
  catch (_e) {
    // Exception imprévue : sur une confirmation, le résultat n'est pas connu → INDÉTERMINÉ ; sur un aperçu, rien n'est écrit.
    return d && (d as any).confirme === true ? rep(502, { ok: false, code: 'INDETERMINE', erreur: 'résultat non vérifié : regarde le planning dans l’outil LBC avant de recommencer' }) : rep(500, { ok: false, erreur: 'erreur interne' });
  }
});
