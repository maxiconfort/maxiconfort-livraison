// ════════════════════════════════════════════════════════════════════
// Edge Function : send-sms (v2 — 16/06/2026 — MIGRÉ Brevo → OVH)
// ════════════════════════════════════════════════════════════════════
// Point d'entrée des SMS envoyés depuis le front (maxiconfort-v7.html,
// fonction brevoSendSMS) : confirmation de livraison à la signature,
// test SMS, rappel entretien véhicule, envoi groupé tournée, veille legacy.
//
// Contrat (inchangé pour rester compatible avec le front) :
//   POST { tel: "+33...", message: "...", type?: "...", client?: "..." }
//   → { success: boolean }
//
// Envoi via OVH (expéditeur MAXICONFORT). Transactionnel = sans clause STOP.
// Secrets OVH : voir _shared/ovh-sms.ts
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { envoyerSMSOVH } from '../_shared/ovh-sms.ts';

const SB_URL    = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const sb = createClient(SB_URL, SB_SR_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Max-Age': '86400',
};
const JSON_HEADERS = { 'Content-Type': 'application/json', ...CORS_HEADERS };

async function logHistorique(tel: string, type: string, message: string, statut: string, client: string) {
  try {
    await sb.from('sms_historique').insert({
      id: 'sms_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      client: client || '',
      tel: tel || '',
      type_sms: type || 'manuel',
      msg: message,
      statut,
      date_sms: new Date().toISOString().split('T')[0],
      heure: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }),
    });
  } catch (_e) { /* silent */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ success: false, error: 'POST uniquement' }), { status: 405, headers: JSON_HEADERS });
  }

  let body: any = {};
  try { body = await req.json(); } catch {}
  const { tel, message, type, client } = body;
  if (!tel || !message) {
    return new Response(JSON.stringify({ success: false, error: 'tel et message requis' }), { status: 400, headers: JSON_HEADERS });
  }

  const ok = await envoyerSMSOVH(tel, message);
  await logHistorique(tel, type || 'manuel', message, ok ? 'envoyé' : 'échec', client || '');

  return new Response(JSON.stringify({ success: ok }), { status: ok ? 200 : 502, headers: JSON_HEADERS });
});
