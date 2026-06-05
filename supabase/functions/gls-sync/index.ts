// ════════════════════════════════════════════════════════════════════
// Edge Function : gls-sync (v3 — 05/06/2026)
// ════════════════════════════════════════════════════════════════════
// Track & Trace via l'API publique GLS-France (trouvee via DevTools sur
// moncolis.gls-france.com). Pas besoin d'OAuth2 pour cet endpoint.
// On garde quand meme l'OAuth2 setup au cas ou on en aurait besoin
// pour d'autres endpoints (ShipIT-Farm reels) plus tard.
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GLS_API_KEY       = Deno.env.get('GLS_API_KEY') || '';
const GLS_CLIENT_SECRET = Deno.env.get('GLS_CLIENT_SECRET') || '';
const GLS_APP_ID        = Deno.env.get('GLS_APP_ID') || '';
const GLS_CONTACT_ID    = Deno.env.get('GLS_CONTACT_ID') || '';
const SB_URL    = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const sb = createClient(SB_URL, SB_SR_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function trackParcel(trackId: string): Promise<any> {
  const t = encodeURIComponent(trackId);
  const url = `https://public.infra-prod.cloud.fr.gls-group.com/consignee-ws/api/v1/command/public/codes/${t}`;
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 Maxiconfort-Livraison-Sync',
  };
  try {
    const resp = await fetch(url, { headers });
    const bodyText = await resp.text();
    if (resp.ok) {
      let data: any = null;
      try { data = JSON.parse(bodyText); } catch { data = { raw: bodyText.substring(0, 500) }; }
      return { ok: true, url, status: resp.status, data };
    }
    return { ok: false, url, status: resp.status, body: bodyText.substring(0, 300) };
  } catch (e: any) {
    return { ok: false, url, error: e.message };
  }
}

function isParcelDelivered(trackData: any): boolean {
  if (!trackData) return false;
  // GLS-France retourne typiquement un objet avec "events" ou "history"
  // Status possibles : LIVRE, DELIVERED, EN_LIVRAISON, EN_COURS, etc.
  const topStatus = (trackData.status || trackData.parcelStatus || trackData.state || trackData.code || '').toString().toUpperCase();
  if (topStatus.includes('DELIVERED') || topStatus.includes('LIVRE') || topStatus === 'DELIVERY_COMPLETE') return true;
  const events = trackData.events || trackData.trackingEvents || trackData.history || trackData.commandHistory || trackData.statusHistory || [];
  if (Array.isArray(events)) {
    for (const ev of events) {
      const code = (ev.code || ev.eventCode || ev.statusCode || ev.status || ev.state || '').toString().toUpperCase();
      const desc = (ev.description || ev.eventDescription || ev.text || ev.label || ev.message || '').toString().toLowerCase();
      if (['DELIVERED','LIVRE','LIVREE','DELIVERY_COMPLETE','OK','CHECKED_IN'].includes(code)) return true;
      if (code.includes('LIVR') || code.includes('DELIVER')) return true;
      if (desc.includes('delivered') || desc.includes('livré') || desc.includes('livre') || desc.includes('remise au destinataire')) return true;
    }
  }
  return false;
}

Deno.serve(async (req: Request) => {
  const startTime = Date.now();
  let body: any = {};
  if (req.method === 'POST') { try { body = await req.json(); } catch { /* silent */ } }
  const dryRun: boolean = !!body.dryRun;
  const testTrackId: string | null = body.trackId || null;
  const summary = {
    started_at: new Date().toISOString(),
    dryRun,
    cmds_a_checker: 0,
    cmds_livre: 0,
    cmds_erreur: 0,
    duration_ms: 0,
    details: [] as any[],
  };

  // Mode test : un seul tracking
  if (testTrackId) {
    const result = await trackParcel(testTrackId);
    summary.details.push({ trackId: testTrackId, ...result });
    if (result.ok) {
      const livre = isParcelDelivered(result.data);
      summary.details[0].interprete_livre = livre;
    }
    summary.duration_ms = Date.now() - startTime;
    return new Response(JSON.stringify({ ok: result.ok, summary }), { headers: { 'Content-Type': 'application/json' } });
  }

  // Mode normal : check toutes les commandes GLS non livrees avec tracking
  const { data: cmds, error: errCmds } = await sb
    .from('commandes')
    .select('id, client, tracking_transporteur, statut')
    .eq('transporteur', 'GLS')
    .not('tracking_transporteur', 'is', null)
    .not('statut', 'in', '(livré,annulé)');

  if (errCmds) {
    summary.duration_ms = Date.now() - startTime;
    return new Response(JSON.stringify({ ok: false, error: 'sql_error', message: errCmds.message, summary }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  const cmdsValid = (cmds || []).filter((c: any) => c.tracking_transporteur && c.tracking_transporteur.length >= 6);
  summary.cmds_a_checker = cmdsValid.length;

  for (const cmd of cmdsValid) {
    const tracking: string = cmd.tracking_transporteur;
    const result = await trackParcel(tracking);
    if (!result.ok) {
      summary.cmds_erreur++;
      summary.details.push({ cmdId: cmd.id, client: cmd.client, tracking, status: 'api_error', http: result.status, body: result.body, error: result.error });
      continue;
    }
    const livre = isParcelDelivered(result.data);
    if (livre) {
      if (dryRun) {
        summary.cmds_livre++;
        summary.details.push({ cmdId: cmd.id, client: cmd.client, tracking, status: 'would_update_livre' });
      } else {
        const { error: errUpd } = await sb.from('commandes').update({ statut: 'livré' }).eq('id', cmd.id);
        if (errUpd) {
          summary.cmds_erreur++;
          summary.details.push({ cmdId: cmd.id, client: cmd.client, tracking, status: 'update_failed', error: errUpd.message });
        } else {
          summary.cmds_livre++;
          summary.details.push({ cmdId: cmd.id, client: cmd.client, tracking, status: 'updated_to_livre' });
        }
      }
    } else {
      summary.details.push({ cmdId: cmd.id, client: cmd.client, tracking, status: 'still_in_transit' });
    }
  }

  summary.duration_ms = Date.now() - startTime;

  // Log dans la table de suivi (best-effort)
  try {
    await sb.from('gls_sync_logs').insert({
      id: 'glssync_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      run_at: summary.started_at,
      cmds_a_checker: summary.cmds_a_checker,
      cmds_livre: summary.cmds_livre,
      cmds_erreur: summary.cmds_erreur,
      duration_ms: summary.duration_ms,
      details: summary.details,
    });
  } catch (_e) { /* silent */ }

  return new Response(JSON.stringify({ ok: true, summary }), { headers: { 'Content-Type': 'application/json' } });
});
