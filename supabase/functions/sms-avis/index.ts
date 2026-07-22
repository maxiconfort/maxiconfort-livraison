// ════════════════════════════════════════════════════════════════════
// Edge Function : sms-avis (v1.2 — 17/07/2026)
// ════════════════════════════════════════════════════════════════════
// Tourne en CRON 1x/jour (~11h Paris) : demande d'avis Google le LENDEMAIN
// de la livraison.
//
// Scan : commandes livrees HIER (date_livraison = J-1 Paris), statut="livré",
//        tel valide, hors #SAV, NON exclues (note), pas deja sollicitee
//        (dedupe sms_envoyes type "avis").
// Pour chaque : appelle send-cmd-sms { type:"avis" }.
//
// EXCLUSION "client a risque" (v1.1) : si la note de commande (instr) contient
//   "PAS D'AVIS" / "SANS AVIS" / "NO AVIS" -> pas de demande d'avis.
//
// ⏸️ PAUSE PROVINCE/GLS (v1.2, demande Borhen 17/07/2026) : le temps de
//   rattraper le retard des livraisons GLS, la demande d'avis n'est envoyee
//   QU'AUX clients livres en region parisienne par notre equipe (RANOU).
//   Les clients GLS (province) sont sautes (action "skip_pause_gls").
//   POUR REACTIVER la province : passer PAUSE_AVIS_GLS a false + redeployer.
//
// ⚠️ Demande d'avis HONNETE, sans condition ni recompense. 1 SMS = 1 credit OVH.
//
// Body : { dryRun?: boolean, dateCible?: "YYYY-MM-DD" }
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SB_URL    = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

// ⏸️ true = demande d'avis UNIQUEMENT pour les livraisons RANOU (region
// parisienne). Les clients GLS (province, retard en cours de rattrapage)
// sont sautes. Repasser a false + redeployer pour reactiver la province.
const PAUSE_AVIS_GLS = true;

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
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const paris = new Date(utc + 3600000);
  return paris.toISOString().split('T')[0];
}

// Note contient un mot-cle d'exclusion ? (insensible casse/ponctuation)
function noteExclut(instr: string): boolean {
  const clean = String(instr || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  return /\b(noavis|no avis|sans avis|pas d avis|pas avis|pasdavis)\b/.test(clean);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const t0 = Date.now();
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }

  const dryRun = body.dryRun === true;

  let dateCible: string = body.dateCible;
  if (!dateCible) {
    const hier = new Date();
    hier.setDate(hier.getDate() - 1);
    dateCible = toLocalDateStr(hier);
  }

  const { data: cmds, error } = await sb.from('commandes')
    .select('id,client,tel,statut,transporteur,sms_envoyes,date_livraison,instr')
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
    // ⏸️ Pause province : on ne sollicite pas les clients livres par GLS
    if (PAUSE_AVIS_GLS && /gls/i.test(String(c.transporteur || ''))) {
      skipped++; details.push({ id: c.id, action: 'skip_pause_gls', client: c.client }); continue;
    }
    // Exclusion manuelle "client a risque" (mot-cle dans la note)
    if (noteExclut(c.instr)) {
      skipped++; details.push({ id: c.id, action: 'skip_exclu_note', client: c.client }); continue;
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
      sent++;
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
