// ════════════════════════════════════════════════════════════════════
// Edge Function : confirmer-presence (v1 — 15/06/2026)
// ════════════════════════════════════════════════════════════════════
// Le client confirme (ou non) sa présence pour la livraison du lendemain,
// depuis la page publique confirmer.html (lien envoyé dans le SMS veille).
// Écriture sécurisée par tracking_token (UUID non devinable), service role.
//
// Body : { token: "uuid", choix: "confirme" | "reporter" }
// OK   : { ok: true, client, choix }
// NOK  : { ok: false, reason }
//
// Effet : commandes.confirmation_presence = choix, confirmation_at = now.
//   + si choix=reporter -> SMS d'alerte à Borhen (best-effort, Brevo).
// Secrets : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), BREVO_API_KEY.
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SB_URL    = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const BREVO_KEY = Deno.env.get('BREVO_API_KEY') || '';
const BORHEN_TEL = '+33744289321'; // SMS alertes internes

const sb = createClient(SB_URL, SB_SR_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};
function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// SMS alerte à Borhen (best-effort, n'échoue jamais le flux)
async function alerteBorhen(contenu: string): Promise<void> {
  if (!BREVO_KEY) return;
  try {
    await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
      method: 'POST',
      headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ sender: 'Maxiconfort', recipient: BORHEN_TEL, content: contenu, type: 'transactional' }),
    });
  } catch (_e) { /* silencieux */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, reason: 'method_not_allowed' }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { /* vide */ }
  const token = (body.token || '').toString().trim();
  const choix = (body.choix || '').toString().trim();

  if (!token) return json({ ok: false, reason: 'token_manquant' }, 400);
  if (choix !== 'confirme' && choix !== 'reporter') {
    return json({ ok: false, reason: 'choix_invalide' }, 400);
  }

  // Retrouver la commande par token
  const { data: cmd, error } = await sb
    .from('commandes')
    .select('id, client, date_livraison, confirmation_presence')
    .eq('tracking_token', token)
    .maybeSingle();
  if (error || !cmd) return json({ ok: false, reason: 'commande_introuvable' }, 404);

  // Enregistrer la réponse
  const { error: upErr } = await sb
    .from('commandes')
    .update({ confirmation_presence: choix, confirmation_at: new Date().toISOString() })
    .eq('tracking_token', token);
  if (upErr) return json({ ok: false, reason: 'maj_impossible' }, 500);

  // Alerte Borhen uniquement si le client ne sera PAS là (cas actionnable)
  if (choix === 'reporter') {
    const dateTxt = (cmd.date_livraison || '').toString().substring(0, 10);
    await alerteBorhen('ANNULATION livraison ' + (cmd.id || '') + ' - ' + (cmd.client || '') +
      (dateTxt ? ' (prevu ' + dateTxt + ')' : '') + ' : le client ne sera PAS la. A reprogrammer.');
  }

  return json({ ok: true, client: cmd.client || '', choix });
});
