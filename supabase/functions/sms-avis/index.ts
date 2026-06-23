// ════════════════════════════════════════════════════════════════════
// Edge Function : sms-avis (v1 — 23/06/2026)
// ════════════════════════════════════════════════════════════════════
// Tourne en CRON 1x/jour (~11h Paris) : demande d'avis Google le LENDEMAIN
// de la livraison.
//
// Scan : commandes livrees HIER (date_livraison = J-1 Paris), statut="livré",
//        tel valide, hors #SAV, pas deja sollicitee (dedupe sms_envoyes type "avis").
// Pour chaque : appelle send-cmd-sms { type:"avis" } (qui gere envoi OVH + log +
// dedupe + marquage sms_envoyes).
//
// ⚠️ Demande d'avis HONNETE, sans condition ni recompense (un cadeau lie a un avis
//    = interdit Google + illegal FR). 1 SMS = 1 credit OVH.
//
// Body : { dryRun?: boolean, dateCible?: "YYYY-MM-DD" }
//   - dryRun=true  -> n'ENVOIE RIEN, liste juste les clients qui seraient contactes.
//   - dateCible    -> force la date livraison ciblee (defaut = hier, heure Paris).
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SB_URL    = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const sb = createClient(SB_URL, SB_SR_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Content-Type': 'application/json',
};

function toLocalDateStr(d: Date): string {
  // Paris ~ UTC+1/+2 (offset manuel, simplifie comme sms-auto)
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const paris = new Date(utc + 3600000);
  return paris.toISOString().split('T')[0];
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const t0 = Date.now();
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }

  const dryRun = body.dryRun === true;

  // Date cible = hier (Paris) par defaut
  let dateCible: string = body.dateCible;
  if (!dateCible) {
    const hier = new Date();
    hier.setDate(hier.getDate() - 1);
    dateCible = toLocalDateStr(hier);
  }

  // Commandes livrees ce jour-la
  const { data: cmds, error } = await sb.from('commandes')
    .select('id,client,tel,statut,transporteur,sms_envoyes,date_livraison')
    .eq('date_livraison', dateCible)
    .eq('statut', 'livré');

  if (error) {
    return new Response(JSON.stringify({ error: 'select commandes failed', details: error.message }),
      { status: 500, headers: CORS });
  }

  let scanned = 0, sent = 0, skipped = 0, failed = 0;
  const details: any[] = [];

  for (const c of cmds || []) {
    scanned++;
    // Hors SAV
    if (/sav/i.test(String(c.id))) {
      skipped++; details.push({ id: c.id, action: 'skip_sav' }); continue;
    }
    // Tel valide
    const tel = (c.tel || '').replace(/[^0-9+]/g, '');
    if (!tel || tel.length < 8) {
      skipped++; details.push({ id: c.id, action: 'skip_no_tel' }); continue;
    }
    // Dedupe : avis deja demande ?
    const dejaEnvoyes: any[] = Array.isArray(c.sms_envoyes) ? c.sms_envoyes : [];
    if (dejaEnvoyes.some((e: any) => e.type === 'avis')) {
      skipped++; details.push({ id: c.id, action: 'skip_already_sent' }); continue;
    }
    // Mode test : on liste sans envoyer
    if (dryRun) {
      sent++; // compte comme "serait envoye"
      details.push({ id: c.id, action: 'would_send', client: c.client, to: tel });
      continue;
    }
    // Envoi reel via send-cmd-sms
    try {
      const resp = await fetch(`${SB_URL}/functions/v1/send-cmd-sms`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SB_SR_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmdId: c.id, type: 'avis' }),
      });
      const data = await resp.json().catch(() => ({}));
      if (data.sent) { sent++; details.push({ id: c.id, action: 'sent', to: data.to }); }
      else if (data.skipped) { skipped++; details.push({ id: c.id, action: 'skip_send', reason: data.reason }); }
      else { failed++; details.push({ id: c.id, action: 'failed', error: data.error }); }
    } catch (e: any) {
      failed++; details.push({ id: c.id, action: 'exception', error: e.message });
    }
  }

  return new Response(JSON.stringify({
    ok: true, dryRun, dateCible, scanned, sent, skipped, failed,
    duration_ms: Date.now() - t0, details,
  }), { headers: CORS });
});
