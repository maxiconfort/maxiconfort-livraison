// ════════════════════════════════════════════════════════════════════
// Edge Function : track-livreur
// ════════════════════════════════════════════════════════════════════
// Renvoie la dernière position GPS du livreur d'une commande, à partir
// du tracking_token. Sécurité : seulement si le statut de la commande
// est 'en-route' ou 'arrivé' (pas de leak de position en permanence).
//
// Body attendu : { token: "uuid-tracking-token" }
// Réponse OK   : { ok: true, livreur, lat, lng, updated_at, statut }
// Réponse NOK  : { ok: false, reason: "..." }
//
// Secrets requis : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto)
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SB_URL    = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const sb = createClient(SB_URL, SB_SR_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// CORS : autoriser tout (page publique)
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  // Preflight CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ ok: false, reason: 'method_not_allowed' }, 405);
  }

  let body: any;
  try { body = await req.json(); } catch { body = {}; }

  const token = (body.token || '').trim();
  if (!token) return json({ ok: false, reason: 'token_required' }, 400);

  // 1) Trouver la commande par tracking_token
  const { data: cmd, error: errCmd } = await sb
    .from('commandes')
    .select('id, livreur, statut, transporteur')
    .eq('tracking_token', token)
    .maybeSingle();

  if (errCmd || !cmd) return json({ ok: false, reason: 'commande_introuvable' }, 404);

  // 2) Vérifier statut autorisé (seulement quand livraison en cours)
  const statutsAutorises = ['en-route', 'arrivé', 'arrive'];
  if (!statutsAutorises.includes(cmd.statut)) {
    return json({ ok: false, reason: 'pas_en_cours', statut: cmd.statut });
  }

  // 3) Vérifier que le transporteur est RANOU (GLS = tracking GLS séparé)
  if ((cmd.transporteur || 'RANOU') !== 'RANOU') {
    return json({ ok: false, reason: 'transporteur_non_ranou' });
  }

  // 4) Récupérer la dernière position GPS du livreur
  const lvNom = (cmd.livreur || '').toUpperCase();
  if (!lvNom) return json({ ok: false, reason: 'pas_de_livreur_assigne' });

  const { data: pos, error: errPos } = await sb
    .from('gps_positions')
    .select('lat, lng, updated_at, livreur')
    .ilike('livreur', lvNom)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (errPos || !pos) return json({ ok: false, reason: 'position_indispo' });

  // 5) Vérifier que la position n'est pas trop vieille (>15 min = livreur probablement off)
  const ageMs = Date.now() - new Date(pos.updated_at).getTime();
  if (ageMs > 15 * 60 * 1000) {
    return json({ ok: false, reason: 'position_trop_ancienne', age_min: Math.round(ageMs / 60000) });
  }

  return json({
    ok: true,
    livreur: pos.livreur,
    lat: pos.lat,
    lng: pos.lng,
    updated_at: pos.updated_at,
    age_seconds: Math.round(ageMs / 1000),
    statut: cmd.statut,
  });
});
