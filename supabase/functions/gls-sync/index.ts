// ════════════════════════════════════════════════════════════════════
// Edge Function : gls-sync (v6 — 05/06/2026)
// ════════════════════════════════════════════════════════════════════
// v4 : Bearer OAuth2 → 401 Authorization failed
// v5 : 5 modes auth tentes sur sandbox test01 → tous 401
// v6 : URL prod trouvee = shipit-wbm-fr01.gls-group.eu (test01 = sandbox FR)
//
// On essaye plusieurs combinaisons d'auth pour identifier la bonne :
//   1. Basic Auth : GLS_API_KEY:GLS_CLIENT_SECRET
//   2. Basic Auth : GLS_CONTACT_ID:GLS_CLIENT_SECRET
//   3. Bearer OAuth2 (fallback)
//
// Body optionnel :
//   { dryRun: true }        → liste sans modifier
//   { trackId: "XXX" }      → test sur 1 tracking ID
//   { useProd: true }       → URL prod (defaut = sandbox test01)
//   { authMode: "auto"|"basic_api"|"basic_contact"|"bearer" }
//     defaut = "auto" (essaye les 3)
//
// Secrets requis :
//   - GLS_API_KEY
//   - GLS_CLIENT_SECRET
//   - GLS_APP_ID (info)
//   - GLS_CONTACT_ID
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
const GLS_TEST_BASE = 'https://shipit-wbm-test01.gls-group.eu:443/backend/rs/tracking';
const GLS_PROD_BASE = 'https://shipit-wbm-fr01.gls-group.eu/backend/rs/tracking';

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

async function tryAuth(url: string, body: string, authHeader: string, label: string): Promise<any> {
  try {
    const headers: Record<string, string> = {
      'Authorization': authHeader,
      'Content-Type': 'application/glsVersion1+json',
      'Accept': 'application/glsVersion1+json, application/json',
    };
    if (GLS_CONTACT_ID) headers['Contact-Id'] = GLS_CONTACT_ID;
    const resp = await fetch(url, { method: 'POST', headers, body });
    const bodyText = await resp.text();
    if (resp.ok) {
      let data: any = null;
      try { data = JSON.parse(bodyText); } catch { data = { raw: bodyText.substring(0, 500) }; }
      return { ok: true, authMode: label, status: resp.status, data };
    }
    return { ok: false, authMode: label, status: resp.status, body: bodyText.substring(0, 300) };
  } catch (e: any) {
    return { ok: false, authMode: label, error: e.message };
  }
}

async function trackParcel(trackId: string, useProd: boolean, authMode: string): Promise<any> {
  const baseUrl = useProd ? GLS_PROD_BASE : GLS_TEST_BASE;
  const url = `${baseUrl}/parceldetails`;
  const body = JSON.stringify({ TrackID: trackId, ShipmentReference: '' });
  const attempts: any[] = [];

  // 1. Basic Auth : API_KEY:CLIENT_SECRET
  if (authMode === 'auto' || authMode === 'basic_api') {
    if (GLS_API_KEY && GLS_CLIENT_SECRET) {
      const r = await tryAuth(url, body, `Basic ${btoa(`${GLS_API_KEY}:${GLS_CLIENT_SECRET}`)}`, 'basic_api');
      attempts.push(r);
      if (r.ok) return { ok: true, url, status: r.status, data: r.data, attempts, winning: 'basic_api' };
    }
  }

  // 2. Basic Auth : CONTACT_ID:CLIENT_SECRET
  if (authMode === 'auto' || authMode === 'basic_contact') {
    if (GLS_CONTACT_ID && GLS_CLIENT_SECRET) {
      const r = await tryAuth(url, body, `Basic ${btoa(`${GLS_CONTACT_ID}:${GLS_CLIENT_SECRET}`)}`, 'basic_contact');
      attempts.push(r);
      if (r.ok) return { ok: true, url, status: r.status, data: r.data, attempts, winning: 'basic_contact' };
    }
  }

  // 3. Basic Auth : CONTACT_ID:API_KEY
  if (authMode === 'auto' || authMode === 'basic_contact_apikey') {
    if (GLS_CONTACT_ID && GLS_API_KEY) {
      const r = await tryAuth(url, body, `Basic ${btoa(`${GLS_CONTACT_ID}:${GLS_API_KEY}`)}`, 'basic_contact_apikey');
      attempts.push(r);
      if (r.ok) return { ok: true, url, status: r.status, data: r.data, attempts, winning: 'basic_contact_apikey' };
    }
  }

  // 4. Basic Auth : APP_ID:CLIENT_SECRET
  if (authMode === 'auto' || authMode === 'basic_app') {
    if (GLS_APP_ID && GLS_CLIENT_SECRET) {
      const r = await tryAuth(url, body, `Basic ${btoa(`${GLS_APP_ID}:${GLS_CLIENT_SECRET}`)}`, 'basic_app');
      attempts.push(r);
      if (r.ok) return { ok: true, url, status: r.status, data: r.data, attempts, winning: 'basic_app' };
    }
  }

  // 5. Bearer OAuth2 (fallback)
  if (authMode === 'auto' || authMode === 'bearer') {
    try {
      const token = await getOAuth2Token();
      const r = await tryAuth(url, body, `Bearer ${token}`, 'bearer');
      attempts.push(r);
      if (r.ok) return { ok: true, url, status: r.status, data: r.data, attempts, winning: 'bearer' };
    } catch (e: any) {
      attempts.push({ ok: false, authMode: 'bearer', error: 'OAuth2 fail: ' + e.message });
    }
  }

  return { ok: false, url, attempts };
}

function isParcelDelivered(trackData: any): boolean {
  if (!trackData) return false;
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
  const authMode: string = body.authMode || 'auto';
  const summary = {
    started_at: new Date().toISOString(),
    dryRun, useProd, authMode,
    cmds_a_checker: 0,
    cmds_livre: 0,
    cmds_erreur: 0,
    duration_ms: 0,
    details: [] as any[],
  };

  if (testTrackId) {
    const result = await trackParcel(testTrackId, useProd, authMode);
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
    summary.duration_ms = Date.now() - startTime;
    return new Response(JSON.stringify({ ok: false, error: 'Erreur SQL: ' + errCmds.message, summary }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  const cmdsValid = (cmds || []).filter((c: any) => c.tracking_transporteur && c.tracking_transporteur.length >= 6);
  summary.cmds_a_checker = cmdsValid.length;

  for (const cmd of cmdsValid) {
    const tracking: string = cmd.tracking_transporteur;
    const result = await trackParcel(tracking, useProd, authMode);
    if (!result.ok) {
      summary.cmds_erreur++;
      summary.details.push({ cmdId: cmd.id, client: cmd.client, tracking, status: 'api_error', attempts: result.attempts });
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
