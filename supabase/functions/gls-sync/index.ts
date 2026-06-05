// ════════════════════════════════════════════════════════════════════
// Edge Function : gls-sync (v4 — 05/06/2026)
// ════════════════════════════════════════════════════════════════════
// Endpoint enfin trouve via page 33 PDF doc GLS ShipIT-FARM :
//   POST /backend/rs/tracking/parceldetails
//   Body: { "TrackID": "...", "ShipmentReference": "" }
//
// IMPORTANT (note doc) : tracking marche SEULEMENT pour les colis crees
// via la webservice ShipIT. Si Borhen cree ses colis via un autre outil
// (portail GLS classique), le tracking via cette API echouera.
//
// Body optionnel :
//   { dryRun: true }   → liste ce qui serait fait sans rien modifier
//   { trackId: "XXX" } → teste sur un seul tracking ID
//   { useProd: true }  → utilise l'URL prod (defaut = test sandbox)
//
// Secrets requis :
//   - GLS_API_KEY (Consumer Key OAuth2)
//   - GLS_CLIENT_SECRET (Consumer Secret OAuth2)
//   - GLS_APP_ID (App ID, info uniquement)
//   - GLS_CONTACT_ID (Contact ID Olivier)
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GLS_API_KEY       = Deno.env.get('GLS_API_KEY') || '';
const GLS_CLIENT_SECRET = Deno.env.get('GLS_CLIENT_SECRET') || '';
const GLS_APP_ID        = Deno.env.get('GLS_APP_ID') || '';
const GLS_CONTACT_ID    = Deno.env.get('GLS_CONTACT_ID') || '';
const SB_URL    = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const GLS_OAUTH_URL = 'https://api.gls-group.net/oauth2/v2/token';
// URLs Track & Trace (PDF page 33)
const GLS_TEST_BASE = 'https://shipit-wbm-test01.gls-group.eu:443/backend/rs/tracking';
const GLS_PROD_BASE = 'https://shipit-wbm.gls-group.eu/backend/rs/tracking'; // a confirmer

const sb = createClient(SB_URL, SB_SR_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getOAuth2Token(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  if (!GLS_API_KEY || !GLS_CLIENT_SECRET) throw new Error('GLS_API_KEY ou GLS_CLIENT_SECRET manquant');
  const credentials = btoa(`${GLS_API_KEY}:${GLS_CLIENT_SECRET}`);
  const resp = await fetch(GLS_OAUTH_URL, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: 'grant_type=client_credentials',
  });
  if (!resp.ok) { const text = await resp.text(); throw new Error(`OAuth2 ${resp.status}: ${text.substring(0, 300)}`); }
  const data = await resp.json();
  if (!data.access_token) throw new Error('OAuth2 OK mais access_token manquant');
  cachedToken = { token: data.access_token, expiresAt: Date.now() + ((data.expires_in || 3600) * 1000) };
  return cachedToken.token;
}

async function trackParcel(trackId: string, token: string, useProd: boolean): Promise<any> {
  const baseUrl = useProd ? GLS_PROD_BASE : GLS_TEST_BASE;
  const url = `${baseUrl}/parceldetails`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (GLS_CONTACT_ID) headers['Contact-Id'] = GLS_CONTACT_ID;
  const body = JSON.stringify({ TrackID: trackId, ShipmentReference: '' });
  try {
    const resp = await fetch(url, { method: 'POST', headers, body });
    const bodyText = await resp.text();
    if (resp.ok) {
      let data: any = null;
      try { data = JSON.parse(bodyText); } catch { data = { raw: bodyText.substring(0, 500) }; }
      return { ok: true, url, status: resp.status, data };
    }
    return { ok: false, url, status: resp.status, body: bodyText.substring(0, 500) };
  } catch (e: any) {
    return { ok: false, url, error: e.message };
  }
}

function isParcelDelivered(trackData: any): boolean {
  if (!trackData) return false;
  // Selon la doc PDF, response a un node "History" avec events.
  // Chaque event = { Date, LocationCode, Location, Country, ... } et probablement un Status/Description.
  const history = trackData.History || trackData.history || [];
  if (Array.isArray(history)) {
    for (const ev of history) {
      const code = (ev.StatusCode || ev.Code || ev.EventCode || ev.code || '').toString().toUpperCase();
      const desc = (ev.Description || ev.StatusDescription || ev.text || ev.Text || ev.label || '').toString().toLowerCase();
      const status = (ev.Status || ev.status || '').toString().toUpperCase();
      if (['DELIVERED','LIVRE','LIVREE','DELIVERY_COMPLETE'].includes(code)) return true;
      if (['DELIVERED','LIVRE','LIVREE','DELIVERY_COMPLETE'].includes(status)) return true;
      if (code.includes('LIVR') || code.includes('DELIVER')) return true;
      if (status.includes('LIVR') || status.includes('DELIVER')) return true;
      if (desc.includes('delivered') || desc.includes('livré') || desc.includes('livre') || desc.includes('remise au destinataire')) return true;
    }
  }
  // Fallback : top level status
  const topStatus = (trackData.Status || trackData.status || '').toString().toUpperCase();
  if (topStatus.includes('DELIVERED') || topStatus.includes('LIVRE')) return true;
  return false;
}

Deno.serve(async (req: Request) => {
  const startTime = Date.now();
  let body: any = {};
  if (req.method === 'POST') { try { body = await req.json(); } catch { /* silent */ } }
  const dryRun: boolean = !!body.dryRun;
  const testTrackId: string | null = body.trackId || null;
  const useProd: boolean = !!body.useProd;
  const summary = {
    started_at: new Date().toISOString(),
    dryRun, useProd,
    cmds_a_checker: 0,
    cmds_livre: 0,
    cmds_erreur: 0,
    duration_ms: 0,
    details: [] as any[],
    oauth: { ok: false, message: '' as string | null },
  };

  let token = '';
  try { token = await getOAuth2Token(); summary.oauth.ok = true; }
  catch (e: any) {
    summary.oauth.message = e.message;
    summary.duration_ms = Date.now() - startTime;
    return new Response(JSON.stringify({ ok: false, summary }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  if (testTrackId) {
    const result = await trackParcel(testTrackId, token, useProd);
    summary.details.push({ trackId: testTrackId, ...result });
    if (result.ok) {
      const livre = isParcelDelivered(result.data);
      summary.details[0].interprete_livre = livre;
    }
    summary.duration_ms = Date.now() - startTime;
    return new Response(JSON.stringify({ ok: result.ok, summary }), { headers: { 'Content-Type': 'application/json' } });
  }

  const { data: cmds, error: errCmds } = await sb
    .from('commandes')
    .select('id, client, tracking_transporteur, statut')
    .eq('transporteur', 'GLS')
    .not('tracking_transporteur', 'is', null)
    .not('statut', 'in', '(livré,annulé)');

  if (errCmds) {
    summary.oauth.message = 'Erreur SQL: ' + errCmds.message;
    summary.duration_ms = Date.now() - startTime;
    return new Response(JSON.stringify({ ok: false, summary }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  const cmdsValid = (cmds || []).filter((c: any) => c.tracking_transporteur && c.tracking_transporteur.length >= 6);
  summary.cmds_a_checker = cmdsValid.length;

  for (const cmd of cmdsValid) {
    const tracking: string = cmd.tracking_transporteur;
    const result = await trackParcel(tracking, token, useProd);
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
