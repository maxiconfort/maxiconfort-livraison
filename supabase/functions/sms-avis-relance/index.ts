// ════════════════════════════════════════════════════════════════════
// Edge Function : sms-avis-relance (v1.0 — 02/09/2026)
// ════════════════════════════════════════════════════════════════════
// RELANCE UNIQUE d'avis Google, ~7 jours apres la premiere demande.
//
// Pourquoi : constat du 02/09/2026 — 204 SMS "avis" envoyes depuis juin
// pour seulement ~12 avis Google (taux ~4%, la norme du SMS froid).
// Une relance unique double typiquement le taux de retour.
//
// Scan : commandes livrees il y a JOURS_RELANCE jours (defaut 7), statut
//        "livré", tel valide, hors #SAV, non exclues (note "PAS D'AVIS"),
//        AYANT DEJA recu la 1re demande (type "avis" dans sms_envoyes)
//        et PAS ENCORE relancees (type "avis-relance").
// Pour chaque : appelle send-cmd-sms { type:"avis-relance" }.
//
// ⚠️ UNE SEULE relance par client, jamais plus (dedupe sms_envoyes).
// ⚠️ Meme pause province/GLS que sms-avis (RANOU / Ile-de-France seulement).
// ⚠️ Demande HONNETE, sans condition ni recompense. 1 SMS = 1 credit OVH.
//
// Body : { dryRun?: boolean, dateCible?: "YYYY-MM-DD", jours?: number }
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SB_URL    = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

// Meme regle que sms-avis : province/GLS en pause, IDF/RANOU seulement.
const PAUSE_AVIS_GLS = true;
const JOURS_RELANCE_DEFAUT = 7;

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
  const jours  = Number(body.jours) > 0 ? Number(body.jours) : JOURS_RELANCE_DEFAUT;

  // Fenetre de 2 jours autour de J-7 (comme sms-avis, pour rattraper les
  // commandes passees en "livré" apres l'heure du cron).
  let dateMin: string, dateMax: string;
  if (body.dateCible) {
    dateMin = body.dateCible; dateMax = body.dateCible;
  } else {
    const d1 = new Date(); d1.setDate(d1.getDate() - jours);
    const d2 = new Date(); d2.setDate(d2.getDate() - (jours + 1));
    dateMax = toLocalDateStr(d1);
    dateMin = toLocalDateStr(d2);
  }
  const dateCible = dateMin === dateMax ? dateMin : `${dateMin}..${dateMax}`;

  const { data: cmds, error } = await sb.from('commandes')
    .select('id,client,tel,statut,transporteur,sms_envoyes,date_livraison,instr')
    .gte('date_livraison', dateMin)
    .lte('date_livraison', dateMax)
    .eq('statut', 'livré');

  if (error) {
    return new Response(JSON.stringify({ error: 'select commandes failed', details: error.message }),
      { status: 500, headers: CORS });
  }

  let scanned = 0, sent = 0, skipped = 0, failed = 0;
  const details: any[] = [];

  for (const c of cmds || []) {
    scanned++;
    if (/sav/i.test(String(c.id))) {
      skipped++; details.push({ id: c.id, action: 'skip_sav' }); continue;
    }
    if (PAUSE_AVIS_GLS && /gls/i.test(String(c.transporteur || ''))) {
      skipped++; details.push({ id: c.id, action: 'skip_pause_gls' }); continue;
    }
    if (noteExclut(c.instr)) {
      skipped++; details.push({ id: c.id, action: 'skip_exclu_note', client: c.client }); continue;
    }
    const tel = (c.tel || '').replace(/[^0-9+]/g, '');
    if (!tel || tel.length < 8) {
      skipped++; details.push({ id: c.id, action: 'skip_no_tel' }); continue;
    }

    const dejaEnvoyes: any[] = Array.isArray(c.sms_envoyes) ? c.sms_envoyes : [];
    // Il FAUT avoir recu la 1re demande (sinon c'est sms-avis qui doit agir).
    if (!dejaEnvoyes.some((e: any) => e.type === 'avis')) {
      skipped++; details.push({ id: c.id, action: 'skip_pas_de_1re_demande', client: c.client }); continue;
    }
    // Une seule relance, jamais deux.
    if (dejaEnvoyes.some((e: any) => e.type === 'avis-relance')) {
      skipped++; details.push({ id: c.id, action: 'skip_deja_relance' }); continue;
    }

    if (dryRun) {
      sent++;
      details.push({ id: c.id, action: 'would_send', client: c.client, to: tel });
      continue;
    }

    try {
      const resp = await fetch(`${SB_URL}/functions/v1/send-cmd-sms`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SB_SR_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmdId: c.id, type: 'avis-relance' }),
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
    ok: true, dryRun, dateCible, jours, scanned, sent, skipped, failed,
    duration_ms: Date.now() - t0, details,
  }), { headers: CORS });
});
