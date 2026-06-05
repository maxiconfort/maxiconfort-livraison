// ════════════════════════════════════════════════════════════════════
// Edge Function : gls-sync (v8 — 05/06/2026)
// ════════════════════════════════════════════════════════════════════
// v6 : ShipIT-FARM URL prod fr01 trouvee, headers glsVersion1+json
//      MAIS 401 sur tous modes (besoin credentials specifiques Olivier)
// v7 : nettoyage
// v8 : NOUVEAU endpoint public decouvert : rstt002 sur gls-group.com
//      URL : GET /app/service/open/rest/GROUP/en/rstt002/{trackId}
//      On test 5 modes auth en cascade :
//        1. GET sans auth (au cas ou public)
//        2. GET avec X-API-Key header
//        3. GET avec apikey header
//        4. GET avec Basic Auth API_KEY:CLIENT_SECRET
//        5. GET avec Bearer OAuth2 token
//
// Body optionnel :
//   { trackId: "XXX" }      → test sur 1 tracking
//   { useRstt002: true }    → force test public rstt002
//   { useShipIT: true }     → force test ShipIT-FARM (besoin creds Olivier)
//   { dryRun: true }        → liste sans modifier
//
// Par defaut : essaye rstt002 en 1er, fallback ShipIT-FARM
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GLS_API_KEY       = Deno.env.get('GLS_API_KEY') || '';
const GLS_CLIENT_SECRET = Deno.env.get('GLS_CLIENT_SECRET') || '';
const GLS_APP_ID        = Deno.env.get('GLS_APP_ID') || '';
const GLS_CONTACT_ID    = Deno.env.get('GLS_CONTACT_ID') || '';
const SB_URL    = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const GLS_OAUTH_URL  = 'https://api.gls-group.net/oauth2/v2/token';
const GLS_TEST_BASE  = 'https://shipit-wbm-test01.gls-group.eu:443/backend/rs/tracking';
const GLS_PROD_BASE  = 'https://shipit-wbm-fr01.gls-group.eu/backend/rs/tracking';
const GLS_RSTT002    = 'https://gls-group.com/app/service/open/rest/GROUP/en/rstt002';

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

// v8 : Test endpoint public rstt002 avec 5 modes auth
async function tryRstt002(trackId: string): Promise<any> {
  const url = `${GLS_RSTT002}/${trackId}`;
  const attempts: any[] = [];

  // Helper : execute une requete GET avec headers donnes
  async function exec(headers: Record<string, string>, label: string): Promise<any> {
    try {
      const resp = await fetch(url, { method: 'GET', headers });
      const bodyText = await resp.text();
      const isJson = bodyText.trim().startsWith('{') || bodyText.trim().startsWith('[');
      const isHtmlGeneric = bodyText.includes('<title>Register API Access') || bodyText.includes('404 - Page Not Found');
      if (resp.ok && isJson) {
        let parsed: any = null;
        try { parsed = JSON.parse(bodyText); } catch { parsed = { raw: bodyText.substring(0, 500) }; }
        return { ok: true, mode: label, status: resp.status, data: parsed };
      }
      return {
        ok: false,
        mode: label,
        status: resp.status,
        is_html_generic: isHtmlGeneric,
        preview: isHtmlGeneric ? '<html register-api-access>' : bodyText.substring(0, 250),
      };
    } catch (e: any) {
      return { ok: false, mode: label, error: e.message };
    }
  }

  // 1. GET sans auth (public test)
  attempts.push(await exec({ 'Accept': 'application/json' }, 'no_auth'));
  if (attempts[attempts.length-1].ok) return { ok: true, url, attempts, winning: 'no_auth', data: attempts[attempts.length-1].data };

  // 2. GET avec X-API-Key
  if (GLS_API_KEY) {
    attempts.push(await exec({ 'Accept': 'application/json', 'X-API-Key': GLS_API_KEY }, 'x_api_key'));
    if (attempts[attempts.length-1].ok) return { ok: true, url, attempts, winning: 'x_api_key', data: attempts[attempts.length-1].data };
  }

  // 3. GET avec apikey header
  if (GLS_API_KEY) {
    attempts.push(await exec({ 'Accept': 'application/json', 'apikey': GLS_API_KEY }, 'apikey_header'));
    if (attempts[attempts.length-1].ok) return { ok: true, url, attempts, winning: 'apikey_header', data: attempts[attempts.length-1].data };
  }

  // 4. GET avec Basic Auth API_KEY:CLIENT_SECRET
  if (GLS_API_KEY && GLS_CLIENT_SECRET) {
    const basic = btoa(`${GLS_API_KEY}:${GLS_CLIENT_SECRET}`);
    attempts.push(await exec({ 'Accept': 'application/json', 'Authorization': `Basic ${basic}` }, 'basic_api'));
    if (attempts[attempts.length-1].ok) return { ok: true, url, attempts, winning: 'basic_api', data: attempts[attempts.length-1].data };
  }

  // 5. GET avec Bearer OAuth2
  try {
    const token = await getOAuth2Token();
    attempts.push(await exec({ 'Accept': 'application/json', 'Authorization': `Bearer ${token}` }, 'bearer_oauth'));
    if (attempts[attempts.length-1].ok) return { ok: true, url, attempts, winning: 'bearer_oauth', data: attempts[attempts.length-1].data };
  } catch (e: any) {
    attempts.push({ ok: false, mode: 'bearer_oauth', error: 'OAuth2 fail: ' + e.message });
  }

  return { ok: false, url, attempts };
}

async function tryAuthShipIT(url: string, body: string, authHeader: string, label: string): Promise<any> {
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

async function trackShipIT(trackId: string, useProd: boolean): Promise<any> {
  const baseUrl = useProd ? GLS_PROD_BASE : GLS_TEST_BASE;
  const url = `${baseUrl}/parceldetails`;
  const body = JSON.stringify({ TrackID: trackId, ShipmentReference: '' });
  const attempts: any[] = [];

  if (GLS_API_KEY && GLS_CLIENT_SECRET) {
    const r = await tryAuthShipIT(url, body, `Basic ${btoa(`${GLS_API_KEY}:${GLS_CLIENT_SECRET}`)}`, 'basic_api');
    attempts.push(r);
    if (r.ok) return { ok: true, url, status: r.status, data: r.data, attempts, winning: 'basic_api' };
  }
  if (GLS_CONTACT_ID && GLS_CLIENT_SECRET) {
    const r = await tryAuthShipIT(url, body, `Basic ${btoa(`${GLS_CONTACT_ID}:${GLS_CLIENT_SECRET}`)}`, 'basic_contact');
    attempts.push(r);
    if (r.ok) return { ok: true, url, status: r.status, data: r.data, attempts, winning: 'basic_contact' };
  }
  try {
    const token = await getOAuth2Token();
    const r = await tryAuthShipIT(url, body, `Bearer ${token}`, 'bearer');
    attempts.push(r);
    if (r.ok) return { ok: true, url, status: r.status, data: r.data, attempts, winning: 'bearer' };
  } catch (_) {}
  return { ok: false, url, attempts };
}

async function trackParcel(trackId: string, opts: { useRstt002?: boolean; useShipIT?: boolean; useProd?: boolean }): Promise<any> {
  const tried: any[] = [];

  // Mode force rstt002 uniquement
  if (opts.useRstt002 && !opts.useShipIT) {
    const r = await tryRstt002(trackId);
    return { ...r, endpoint: 'rstt002' };
  }
  // Mode force ShipIT uniquement
  if (opts.useShipIT && !opts.useRstt002) {
    const r = await trackShipIT(trackId, !!opts.useProd);
    return { ...r, endpoint: 'shipit' };
  }
  // Auto : essaye rstt002 d'abord (public), fallback ShipIT si echec
  const r1 = await tryRstt002(trackId);
  tried.push({ endpoint: 'rstt002', ...r1 });
  if (r1.ok) return { ok: true, endpoint: 'rstt002', url: r1.url, data: r1.data, winning: r1.winning, tried };

  const r2 = await trackShipIT(trackId, !!opts.useProd);
  tried.push({ endpoint: 'shipit', ...r2 });
  if (r2.ok) return { ok: true, endpoint: 'shipit', url: r2.url, data: r2.data, winning: r2.winning, tried };

  return { ok: false, tried };
}

function isParcelDelivered(trackData: any): boolean {
  if (!trackData) return false;
  // Format ShipIT-FARM : History node
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
  // Format rstt002 : peut etre different, on cherche n'importe quel "delivered" dans le JSON
  const topStatus = (trackData.Status || trackData.status || trackData.deliveryStatus || '').toString().toUpperCase();
  if (topStatus.includes('DELIVERED') || topStatus.includes('LIVRE')) return true;
  // Fallback : sérialise tout et cherche
  try {
    const json = JSON.stringify(trackData).toLowerCase();
    if (json.includes('"delivered"') || json.includes('"livré"') || json.includes('"livre"')) return true;
  } catch (_) {}
  return false;
}

Deno.serve(async (req: Request) => {
  const startTime = Date.now();
  let body: any = {};
  if (req.method === 'POST') { try { body = await req.json(); } catch { /* silent */ } }
  const dryRun: boolean = !!body.dryRun;
  const testTrackId: string | null = body.trackId || null;
  const useProd: boolean = !!body.useProd;
  const useRstt002: boolean = !!body.useRstt002;
  const useShipIT: boolean = !!body.useShipIT;
  const summary = {
    started_at: new Date().toISOString(),
    dryRun, useProd, useRstt002, useShipIT,
    cmds_a_checker: 0, cmds_livre: 0, cmds_erreur: 0,
    duration_ms: 0,
    details: [] as any[],
  };

  if (testTrackId) {
    const result = await trackParcel(testTrackId, { useRstt002, useShipIT, useProd });
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
    const result = await trackParcel(tracking, { useRstt002, useShipIT, useProd });
    if (!result.ok) {
      summary.cmds_erreur++;
      summary.details.push({ cmdId: cmd.id, client: cmd.client, tracking, status: 'api_error', tried: result.tried });
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
