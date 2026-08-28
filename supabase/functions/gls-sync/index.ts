// ════════════════════════════════════════════════════════════════════
// Edge Function : gls-sync (v12 — 11/06/2026)
// ════════════════════════════════════════════════════════════════════
// v12 (11/06) : DETECTION COLIS BLOQUES + alerte SMS Borhen.
//   Pour chaque colis non livre, on extrait la date du dernier evenement
//   de tracking (UnitDetail.History[].Date). Si AUCUN scan depuis
//   STUCK_DAYS jours (defaut 4) sur au moins un colis non livre :
//     - commandes.gls_bloque = true + gls_dernier_scan = date dernier scan
//     - SMS d'alerte a Borhen (1 seule fois : dedupe via l'ancien gls_bloque)
//   Le flag retombe a false des que le colis bouge ou est livre.
//   Body optionnel : { stuckDays: 6 } pour changer le seuil.
//
// v10 (08/06) : MULTI-TRACKINGS support pour les multi-colis.
//   commandes.tracking_transporteur peut contenir N trackIDs separes par
//   virgule (cas des sommiers/lits/ensembles depuis gls-create-shipment v5).
//   On split, on track CHAQUE colis individuellement, on agrege le statut :
//     - Tous livres + 0 erreur -> cmd statut = "livré"
//     - Au moins 1 erreur API -> log partial_error, on reessaye au prochain run
//     - Sinon -> still_in_transit (X/N livrés)
//
// v9 (05/06) : credentials Olivier prod ShipIT-FARM
// v8 : endpoint public rstt002 + fallback ShipIT
//
// Body optionnel :
//   { trackId: "XXX" }      → test sur 1 tracking
//   { useRstt002: true }    → force test public rstt002
//   { useShipIT: true }     → force test ShipIT-FARM
//   { dryRun: true }        → liste sans modifier
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { envoyerSMSOVH } from '../_shared/ovh-sms.ts';

const GLS_API_KEY       = Deno.env.get('GLS_API_KEY') || '';
const GLS_CLIENT_SECRET = Deno.env.get('GLS_CLIENT_SECRET') || '';
const GLS_APP_ID        = Deno.env.get('GLS_APP_ID') || '';
const GLS_CONTACT_ID    = Deno.env.get('GLS_CONTACT_ID') || '';
// v11 : creds ShipIT-FARM Olivier (memes que gls-create-shipment)
const GLS_SHIPIT_USER       = Deno.env.get('GLS_SHIPIT_USER') || '';
const GLS_SHIPIT_PASSWORD   = Deno.env.get('GLS_SHIPIT_PASSWORD') || '';
const GLS_SHIPIT_CONTACT_ID = Deno.env.get('GLS_SHIPIT_CONTACT_ID') || '';
const SB_URL    = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
// v12 : alerte colis bloque (v13 : via OVH)
const ALERT_SMS_TO = '+33744289321'; // Borhen
const STUCK_DAYS_DEFAULT = 4;

const GLS_OAUTH_URL  = 'https://api.gls-group.net/oauth2/v2/token';
const GLS_TEST_BASE  = 'https://shipit-wbm-test01.gls-group.eu:443/backend/rs/tracking';
const GLS_PROD_BASE  = 'https://shipit-wbm-fr01.gls-group.eu/backend/rs/tracking';
const GLS_RSTT002    = 'https://gls-group.com/app/service/open/rest/GROUP/en/rstt002';
// v11 : URL ShipIT-FARM (meme base que create-shipment qui marche)
const GLS_SHIPIT_FARM_BASE = 'https://wbm-fr02.shipit.gls-group.com:443/backend/rs/tracking';

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

// v11 : ShipIT-FARM (memes creds que create-shipment qui marche)
async function trackShipITFarm(trackId: string): Promise<any> {
  if (!GLS_SHIPIT_USER || !GLS_SHIPIT_PASSWORD) {
    return { ok: false, url: GLS_SHIPIT_FARM_BASE, attempts: [{ ok: false, error: 'GLS_SHIPIT_USER/PASSWORD manquant' }] };
  }
  const basic = btoa(`${GLS_SHIPIT_USER}:${GLS_SHIPIT_PASSWORD}`);
  const attempts: any[] = [];
  // Endpoint parceldetails : POST avec body
  const url1 = `${GLS_SHIPIT_FARM_BASE}/parceldetails`;
  const r1 = await tryAuthShipIT(url1, JSON.stringify({ TrackID: trackId, ShipmentReference: '' }), `Basic ${basic}`, 'shipit_farm_basic');
  attempts.push(r1);
  if (r1.ok) return { ok: true, url: url1, status: r1.status, data: r1.data, attempts, winning: 'shipit_farm_basic' };
  // Endpoint parcels (alternative) : GET avec id en path
  try {
    const url2 = `${GLS_SHIPIT_FARM_BASE}/parcels/${trackId}`;
    const headers: Record<string, string> = {
      'Authorization': `Basic ${basic}`,
      'Accept': 'application/glsVersion1+json, application/json',
    };
    if (GLS_SHIPIT_CONTACT_ID) headers['Contact-Id'] = GLS_SHIPIT_CONTACT_ID;
    const resp = await fetch(url2, { method: 'GET', headers });
    const bodyText = await resp.text();
    if (resp.ok) {
      let data: any = null;
      try { data = JSON.parse(bodyText); } catch { data = { raw: bodyText.substring(0, 500) }; }
      attempts.push({ ok: true, authMode: 'shipit_farm_get', status: resp.status, data });
      return { ok: true, url: url2, status: resp.status, data, attempts, winning: 'shipit_farm_get' };
    }
    attempts.push({ ok: false, authMode: 'shipit_farm_get', status: resp.status, body: bodyText.substring(0, 300) });
  } catch (e: any) {
    attempts.push({ ok: false, authMode: 'shipit_farm_get', error: e.message });
  }
  return { ok: false, url: url1, attempts };
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
  // v11 : Auto - essaye d'abord ShipIT-FARM (creds Olivier qui marchent pour create-shipment)
  const r0 = await trackShipITFarm(trackId);
  tried.push({ endpoint: 'shipit_farm', ...r0 });
  if (r0.ok) return { ok: true, endpoint: 'shipit_farm', url: r0.url, data: r0.data, winning: r0.winning, tried };

  // Fallback : rstt002 (public)
  const r1 = await tryRstt002(trackId);
  tried.push({ endpoint: 'rstt002', ...r1 });
  if (r1.ok) return { ok: true, endpoint: 'rstt002', url: r1.url, data: r1.data, winning: r1.winning, tried };

  // Fallback : ShipIT classique
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

// v12 : date (ms epoch) du dernier evenement de tracking d'un colis, ou null.
// Format reel ShipIT-FARM : data.UnitDetail.History[] avec Date ISO "2026-06-10T15:33:54+02:00"
function getLastEventMs(trackData: any): number | null {
  const history = trackData?.UnitDetail?.History || trackData?.History || trackData?.history || [];
  if (!Array.isArray(history)) return null;
  let max: number | null = null;
  for (const ev of history) {
    const raw = ev?.Date || ev?.date || ev?.Timestamp || ev?.DateTime || null;
    if (!raw) continue;
    const ms = Date.parse(String(raw));
    if (!isNaN(ms) && (max === null || ms > max)) max = ms;
  }
  return max;
}

// v13 : SMS d'alerte a Borhen via OVH (migre depuis Brevo)
async function envoyerAlerteSMS(contenu: string): Promise<boolean> {
  return await envoyerSMSOVH(ALERT_SMS_TO, contenu);
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
  // v12 : seuil de detection colis bloque (jours sans scan)
  const stuckDays: number = (typeof body.stuckDays === 'number' && body.stuckDays > 0) ? body.stuckDays : STUCK_DAYS_DEFAULT;
  const summary = {
    started_at: new Date().toISOString(),
    dryRun, useProd, useRstt002, useShipIT, stuckDays,
    cmds_a_checker: 0, cmds_livre: 0, cmds_erreur: 0, cmds_bloquees: 0, alertes_sms: 0,
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
    .select('id, client, tracking_transporteur, statut, gls_bloque, date_livraison')
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
    const trackingFull: string = cmd.tracking_transporteur;
    // v10 : SPLIT multi-trackings (1 cmd peut avoir N colis depuis create-shipment v5)
    const trackIds = trackingFull.split(',').map((t: string) => t.trim()).filter((t: string) => t.length >= 6);
    if (trackIds.length === 0) {
      summary.cmds_erreur++;
      summary.details.push({ cmdId: cmd.id, client: cmd.client, tracking: trackingFull, status: 'no_valid_trackid' });
      continue;
    }

    // Track CHAQUE colis individuellement
    const parcelResults: any[] = [];
    let nbErreurs = 0;
    let nbLivre = 0;
    // v12 : dernier scan des colis NON livres (pour la detection bloque)
    let dernierScanNonLivre: number | null = null;
    let auMoinsUnNonLivreSansScanRecent = false;
    const seuilMs = stuckDays * 24 * 3600 * 1000;
    for (const trackId of trackIds) {
      const result = await trackParcel(trackId, { useRstt002, useShipIT, useProd });
      if (!result.ok) {
        nbErreurs++;
        parcelResults.push({ trackId, status: 'api_error', tried: result.tried });
        continue;
      }
      const livre = isParcelDelivered(result.data);
      const lastMs = getLastEventMs(result.data);
      parcelResults.push({ trackId, livre, status: livre ? 'livre' : 'transit', dernier_scan: lastMs ? new Date(lastMs).toISOString() : null });
      if (livre) nbLivre++;
      else if (lastMs !== null) {
        if (dernierScanNonLivre === null || lastMs > dernierScanNonLivre) dernierScanNonLivre = lastMs;
        if (Date.now() - lastMs > seuilMs) auMoinsUnNonLivreSansScanRecent = true;
      }
    }

    const nbColis = trackIds.length;
    // v13 (27/07) : GLS ne scanne pas toujours TOUS les colis a la livraison (constat :
    // #1438 Xavier 2/3 livres, #1463 Julie 1/2 — le colis restant sans scan depuis des
    // jours) -> la commande restait "en-attente" pour TOUJOURS (aucun statut remonte).
    // Regle assouplie : livre si TOUS les colis le sont, OU si AU MOINS UN colis est
    // livre ET qu'aucun colis restant n'a eu de scan depuis 48h (les colis d'un meme
    // envoi voyagent ensemble ; un colis silencieux apres la livraison des autres =
    // simplement pas scanne par le livreur GLS).
    const SILENCE_LIVRE_MS = 48 * 3600 * 1000;
    const resteSilencieux = (dernierScanNonLivre === null) || (Date.now() - dernierScanNonLivre > SILENCE_LIVRE_MS);
    const tousLivre = (nbErreurs === 0) && (nbLivre === nbColis || (nbLivre >= 1 && resteSilencieux));

    if (tousLivre) {
      // Tous les colis livres -> cmd = livré
      if (dryRun) {
        summary.cmds_livre++;
        summary.details.push({ cmdId: cmd.id, client: cmd.client, tracking: trackingFull, nbColis, parcels: parcelResults, status: 'would_update_livre' });
      } else {
        // v14 (28/08) : renseigner AUSSI la date de livraison si elle est vide. AVANT, une
        // commande GLS passait en "livré" SANS date_livraison -> elle n'apparaissait dans
        // AUCUN CA mensuel (le CA se calcule sur date_livraison) : 2 343 € manquants sur
        // le seul mois d'août. On prend la date du dernier scan "livré" (date reelle de
        // remise au client), sinon aujourd'hui. On n'ECRASE JAMAIS une date deja saisie.
        const scansLivres = parcelResults
          .filter((p: any) => p.livre && p.dernier_scan)
          .map((p: any) => new Date(p.dernier_scan).getTime());
        const dateLivree = scansLivres.length
          ? new Date(Math.max(...scansLivres)).toISOString().split('T')[0]
          : new Date().toISOString().split('T')[0];
        const majLivre: any = { statut: 'livré', gls_bloque: false };
        if (!cmd.date_livraison) majLivre.date_livraison = dateLivree;
        const { error: errUpd } = await sb.from('commandes').update(majLivre).eq('id', cmd.id);
        if (errUpd) {
          summary.cmds_erreur++;
          summary.details.push({ cmdId: cmd.id, client: cmd.client, tracking: trackingFull, status: 'update_failed', error: errUpd.message });
        } else {
          summary.cmds_livre++;
          summary.details.push({ cmdId: cmd.id, client: cmd.client, tracking: trackingFull, nbColis, parcels: parcelResults, status: 'updated_to_livre' });
        }
      }
    } else if (nbErreurs === nbColis) {
      // Tous les colis en erreur API -> erreur globale
      summary.cmds_erreur++;
      summary.details.push({ cmdId: cmd.id, client: cmd.client, tracking: trackingFull, nbColis, parcels: parcelResults, status: 'all_api_error' });
    } else {
      // En cours (au moins 1 colis pas encore livre ou 1 colis en erreur partielle)
      // v12 : detection colis bloque (aucun scan depuis stuckDays jours sur un colis non livre)
      const bloque = auMoinsUnNonLivreSansScanRecent;
      const etaitBloque = !!cmd.gls_bloque;
      let alerteSms = false;
      if (!dryRun) {
        try {
          await sb.from('commandes').update({
            gls_bloque: bloque,
            gls_dernier_scan: dernierScanNonLivre ? new Date(dernierScanNonLivre).toISOString() : null,
          }).eq('id', cmd.id);
        } catch (_e) { /* non bloquant */ }
        // Alerte SMS uniquement au PASSAGE a bloque (pas de re-alerte toutes les 2h)
        if (bloque && !etaitBloque) {
          const dernierFr = dernierScanNonLivre ? new Date(dernierScanNonLivre).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }) : '?';
          alerteSms = await envoyerAlerteSMS(
            '🚨 GLS : colis bloqué !\nCmd ' + cmd.id + ' — ' + (cmd.client || '') +
            '\nAucun scan depuis le ' + dernierFr + ' (' + stuckDays + 'j+)' +
            '\nColis : ' + trackingFull +
            '\nSi ça persiste : déclare un litige dans l\'app (bouton ⚠️ sur la commande).'
          );
          if (alerteSms) summary.alertes_sms++;
        }
      }
      if (bloque) summary.cmds_bloquees++;
      summary.details.push({
        cmdId: cmd.id, client: cmd.client, tracking: trackingFull, nbColis,
        livreCount: nbLivre, errorCount: nbErreurs,
        parcels: parcelResults,
        bloque, etaitBloque, alerteSms,
        dernier_scan: dernierScanNonLivre ? new Date(dernierScanNonLivre).toISOString() : null,
        status: `still_in_transit (${nbLivre}/${nbColis} livré${nbLivre > 1 ? 's' : ''}${nbErreurs > 0 ? ', ' + nbErreurs + ' err' : ''})`,
      });
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
