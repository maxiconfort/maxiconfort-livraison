// ════════════════════════════════════════════════════════════════════
// Edge Function : sms-auto (v1 — 10/06/2026)
// ════════════════════════════════════════════════════════════════════
// Tourne en CRON :
//   - phase=veille : 19h00 chaque jour -> scan commandes J+1, envoie SMS veille
//   - phase=depart : 08h00 chaque jour -> scan commandes J, envoie SMS depart
//
// Filtres communs :
//   - statut NOT IN (livré, annulé)
//   - transporteur = RANOU (les GLS recoivent SMS expedition lors creation etiquette)
//   - tel renseigne
//   - SMS pas deja envoye (dedupe via sms_envoyes)
//
// Appelle send-cmd-sms pour chaque cmd, qui gere :
//   - Envoi Brevo
//   - Log sms_historique
//   - Mise a jour sms_envoyes
//
// Body : { phase: "veille" | "depart" }  (defaut = decide selon heure UTC)
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
  // Paris timezone via offset manuel (UTC+1/+2)
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const paris = new Date(utc + 3600000); // UTC+1 simplifie
  return paris.toISOString().split('T')[0];
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const t0 = Date.now();
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }

  // Choix phase : explicite via body, sinon auto selon heure
  let phase = body.phase;
  if (!phase) {
    // Heure UTC : Paris = UTC+1 (hiver) ou +2 (ete). Approx : 17h UTC = 18h/19h Paris
    const heureUtc = new Date().getUTCHours();
    phase = (heureUtc >= 16 && heureUtc <= 22) ? 'veille' : 'depart';
  }
  if (!['veille', 'depart'].includes(phase)) {
    return new Response(JSON.stringify({ error: 'phase doit etre veille ou depart' }),
      { status: 400, headers: CORS });
  }

  // Date cible
  const now = new Date();
  let dateCible: string;
  if (phase === 'veille') {
    const demain = new Date(now);
    demain.setDate(demain.getDate() + 1);
    dateCible = toLocalDateStr(demain);
  } else {
    dateCible = toLocalDateStr(now);
  }

  // Recup commandes a notifier (RANOU uniquement — GLS recoit son SMS expedition)
  // statut NOT IN (livré, annulé)
  const { data: cmds, error } = await sb.from('commandes')
    .select('id,client,tel,statut,transporteur,sms_envoyes,produit,date_livraison')
    .eq('date_livraison', dateCible)
    .not('statut', 'in', '(livré,annulé)');

  if (error) {
    return new Response(JSON.stringify({ error: 'select commandes failed', details: error.message }),
      { status: 500, headers: CORS });
  }

  let scanned = 0, sent = 0, skipped = 0, failed = 0;
  const details: any[] = [];

  for (const c of cmds || []) {
    scanned++;
    // Filtre : RANOU uniquement
    const trsp = (c.transporteur || '').toUpperCase();
    if (trsp && trsp !== 'RANOU') {
      skipped++;
      details.push({ id: c.id, action: 'skip_transporteur', trsp });
      continue;
    }
    // Filtre : tel renseigne
    const tel = (c.tel || '').replace(/[^0-9+]/g, '');
    if (!tel || tel.length < 8) {
      skipped++;
      details.push({ id: c.id, action: 'skip_no_tel' });
      continue;
    }
    // Dedupe : SMS de ce type deja envoye ?
    const dejaEnvoyes: any[] = Array.isArray(c.sms_envoyes) ? c.sms_envoyes : [];
    if (dejaEnvoyes.some((e: any) => e.type === phase)) {
      skipped++;
      details.push({ id: c.id, action: 'skip_already_sent' });
      continue;
    }
    // Appel send-cmd-sms
    try {
      const resp = await fetch(`${SB_URL}/functions/v1/send-cmd-sms`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SB_SR_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cmdId: c.id, type: phase }),
      });
      const data = await resp.json().catch(() => ({}));
      if (data.sent) {
        sent++;
        details.push({ id: c.id, action: 'sent', to: data.to });
      } else if (data.skipped) {
        skipped++;
        details.push({ id: c.id, action: 'skip_send', reason: data.reason });
      } else {
        failed++;
        details.push({ id: c.id, action: 'failed', error: data.error });
      }
    } catch (e: any) {
      failed++;
      details.push({ id: c.id, action: 'exception', error: e.message });
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    phase,
    dateCible,
    scanned,
    sent,
    skipped,
    failed,
    duration_ms: Date.now() - t0,
    details,
  }), { headers: CORS });
});
