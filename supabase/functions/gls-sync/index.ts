// ════════════════════════════════════════════════════════════════════
// Edge Function : gls-sync (v1 — 05/06/2026)
// ════════════════════════════════════════════════════════════════════
// Synchronise le statut des colis GLS en interrogeant l'API Track & Trace.
// Pour chaque commande GLS non livrée avec un tracking saisi, va voir si
// GLS dit "Delivered" et update Supabase si c'est le cas.
//
// Déclenchement :
//   - Manuel : POST sans body → exécute la sync
//   - pg_cron : toutes les 2h via SELECT cron.schedule(...)
//
// Body optionnel :
//   { dryRun: true }   → liste ce qui serait fait sans rien modifier
//   { trackId: "XXX" } → teste sur un seul tracking ID
//
// Secrets requis :
//   - GLS_API_KEY (Consumer Key OAuth2)
//   - GLS_CLIENT_SECRET (Consumer Secret OAuth2)
//   - GLS_APP_ID (App ID GLS, juste pour info)
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto)
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GLS_API_KEY       = Deno.env.get('GLS_API_KEY') || '';
const GLS_CLIENT_SECRET = Deno.env.get('GLS_CLIENT_SECRET') || '';
const GLS_APP_ID        = Deno.env.get('GLS_APP_ID') || '';
const GLS_CONTACT_ID    = Deno.env.get('GLS_CONTACT_ID') || '';
const SB_URL    = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

// URLs GLS (prod par défaut, sandbox commenté en dessous)
const GLS_OAUTH_URL = 'https://api.gls-group.net/oauth2/v2/token';
// const GLS_OAUTH_URL = 'https://api-sandbox.gls-group.net/oauth2/v2/token'; // sandbox
const GLS_API_BASE  = 'https://api.gls-group.net';

const sb = createClient(SB_URL, SB_SR_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Cache du token OAuth2 entre les invocations (durée 4h en général)
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getOAuth2Token(): Promise<string> {
  // Re-use du token cache si encore valide (avec 60s de marge)
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  if (!GLS_API_KEY || !GLS_CLIENT_SECRET) {
    throw new Error('GLS_API_KEY ou GLS_CLIENT_SECRET manquant dans les secrets');
  }
  // Basic Auth = base64(key:secret)
  const credentials = btoa(`${GLS_API_KEY}:${GLS_CLIENT_SECRET}`);
  const resp = await fetch(GLS_OAUTH_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: 'grant_type=client_credentials',
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OAuth2 ${resp.status}: ${text.substring(0, 300)}`);
  }
  const data = await resp.json();
  if (!data.access_token) {
    throw new Error('OAuth2 OK mais access_token manquant: ' + JSON.stringify(data).substring(0, 200));
  }
  // expires_in est en secondes
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + ((data.expires_in || 3600) * 1000),
  };
  return cachedToken.token;
}

// Appel à l'API Track & Trace pour un tracking ID
// L'URL exacte peut varier selon la doc — adapté si erreur 404.
// v1.1 : ajoute ContactId dans header + query au cas où GLS l'exige.
async function trackParcel(trackId: string, token: string): Promise<any> {
  const t = encodeURIComponent(trackId);
  const ctParam = GLS_CONTACT_ID ? `?contactId=${encodeURIComponent(GLS_CONTACT_ID)}` : '';
  // v2 : ajout domaine api.gls-france.com (indice : public utilise moncolis.gls-france.com)
  const candidates = [
    // api.gls-france.com (variante FR)
    `https://api.gls-france.com/track-and-trace/v1/parcels/${t}`,
    `https://api.gls-france.com/shipit-farm/v1/parcels/${t}/tracking`,
    `https://api.gls-france.com/tracking/v1/parcels/${t}`,
    `https://api.gls-france.com/v1/parcels/${t}`,
    `https://api.gls-france.com/parcels/${t}/track`,
    // moncolis.gls-france.com (frontend public mais peut etre API derriere)
    `https://moncolis.gls-france.com/api/parcels/${t}`,
    `https://moncolis.gls-france.com/api/v1/track/${t}`,
    // api.gls-group.net (selon doc PDF)
    `${GLS_API_BASE}/track-and-trace/v1/parcels/${t}`,
    `${GLS_API_BASE}/track-and-trace/v1/parcels/${t}${ctParam}`,
    `${GLS_API_BASE}/shipit-farm/v1/parcels/${t}/tracking`,
    `${GLS_API_BASE}/shipit-farm/v1/parcels/${t}`,
    `${GLS_API_BASE}/tracking/v1/parcels/${t}`,
    `${GLS_API_BASE}/v1/parcels/${t}/tracking`,
  ];
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
  };
  if (GLS_CONTACT_ID) {
    headers['X-Contact-ID']   = GLS_CONTACT_ID;
    headers['ContactId']      = GLS_CONTACT_ID;
    headers['Gls-Contact-Id'] = GLS_CONTACT_ID;
  }
  const attempts: any[] = [];
  for (const url of candidates) {
    try {
      const resp = await fetch(url, { headers });
      const bodyText = (await resp.text()).substring(0, 200);
      attempts.push({ url, status: resp.status, bodySnippet: bodyText });
      if (resp.ok) {
        let data: any = null;
        try { data = JSON.parse(bodyText); } catch { data = { raw: bodyText }; }
        return { ok: true, url, data, attempts };
      }
      if (resp.status === 401 || resp.status === 403) break;
    } catch (e: any) {
      attempts.push({ url, error: e.message });
    }
  }
  return { ok: false, attempts };
}

// Détecte si un colis est "livré" depuis la réponse GLS
// Format de réponse variable selon l'API ; tente plusieurs heuristiques.
function isParcelDelivered(trackData: any): boolean {
  if (!trackData) return false;
  // Cas 1 : champ status au niveau racine
  const topStatus = (trackData.status || trackData.parcelStatus || '').toString().toUpperCase();
  if (topStatus.includes('DELIVERED') || topStatus === 'DELIVERY_COMPLETE') return true;
  // Cas 2 : tableau events avec code
  const events = trackData.events || trackData.trackingEvents || trackData.history || [];
  if (Array.isArray(events)) {
    for (const ev of events) {
      const code = (ev.code || ev.eventCode || ev.statusCode || '').toString().toUpperCase();
      const desc = (ev.description || ev.eventDescription || ev.text || '').toString().toLowerCase();
      if (['DELIVERED','LIVRE','DELIVERY_COMPLETE','OK','CHECKED_IN'].includes(code)) return true;
      if (desc.includes('delivered') || desc.includes('livré') || desc.includes('livre')) return true;
    }
  }
  return false;
}

Deno.serve(async (req: Request) => {
  const startTime = Date.now();
  let body: any = {};
  if (req.method === 'POST') {
    try { body = await req.json(); } catch { /* silent */ }
  }
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
    oauth: { ok: false, message: '' as string | null },
  };

  // 1) Obtenir token OAuth2
  let token = '';
  try {
    token = await getOAuth2Token();
    summary.oauth.ok = true;
  } catch (e: any) {
    summary.oauth.message = e.message;
    summary.duration_ms = Date.now() - startTime;
    return new Response(JSON.stringify({ ok: false, summary }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Mode test : un seul tracking ID
  if (testTrackId) {
    const result = await trackParcel(testTrackId, token);
    summary.details.push({ trackId: testTrackId, ...result });
    summary.duration_ms = Date.now() - startTime;
    return new Response(JSON.stringify({ ok: result.ok, summary }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 2) Lister les commandes GLS non livrées avec tracking
  const { data: cmds, error: errCmds } = await sb
    .from('commandes')
    .select('id, client, tracking_transporteur, statut')
    .eq('transporteur', 'GLS')
    .not('tracking_transporteur', 'is', null)
    .not('statut', 'in', '(livré,annulé)');

  if (errCmds) {
    summary.oauth.message = 'Erreur SQL: ' + errCmds.message;
    summary.duration_ms = Date.now() - startTime;
    return new Response(JSON.stringify({ ok: false, summary }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  const cmdsValid = (cmds || []).filter((c: any) => c.tracking_transporteur && c.tracking_transporteur.length >= 6);
  summary.cmds_a_checker = cmdsValid.length;

  // 3) Pour chaque tracking, appeler GLS + update si livré
  for (const cmd of cmdsValid) {
    const tracking: string = cmd.tracking_transporteur;
    const result = await trackParcel(tracking, token);
    if (!result.ok) {
      summary.cmds_erreur++;
      summary.details.push({
        cmdId: cmd.id, client: cmd.client, tracking,
        status: 'api_error',
        error: result.error,
      });
      continue;
    }
    const livre = isParcelDelivered(result.data);
    if (livre) {
      if (dryRun) {
        summary.cmds_livre++;
        summary.details.push({
          cmdId: cmd.id, client: cmd.client, tracking,
          status: 'would_update_livre',
        });
      } else {
        const { error: errUpd } = await sb
          .from('commandes')
          .update({ statut: 'livré' })
          .eq('id', cmd.id);
        if (errUpd) {
          summary.cmds_erreur++;
          summary.details.push({
            cmdId: cmd.id, client: cmd.client, tracking,
            status: 'update_failed',
            error: errUpd.message,
          });
        } else {
          summary.cmds_livre++;
          summary.details.push({
            cmdId: cmd.id, client: cmd.client, tracking,
            status: 'updated_to_livre',
          });
        }
      }
    } else {
      // En cours, pas encore livré
      summary.details.push({
        cmdId: cmd.id, client: cmd.client, tracking,
        status: 'still_in_transit',
      });
    }
  }

  summary.duration_ms = Date.now() - startTime;

  // 4) Logger dans la table de suivi (best-effort)
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
  } catch (_e) { /* table peut ne pas exister, on s'en fiche */ }

  return new Response(JSON.stringify({ ok: true, summary }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
