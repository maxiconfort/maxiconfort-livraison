// ════════════════════════════════════════════════════════════════════
// Edge Function : gls-sync (v15 — 28/09/2026)
// ════════════════════════════════════════════════════════════════════
// v15 (28/09) : FIN DU FAUX « LIVRÉ ».
//   - Analyse de l'historique GLS par _shared/gls-analyse.ts (testé en Node) :
//     un « delivered » APRÈS un retour à l'expéditeur, au dépôt d'origine
//     (Garonor/Noisy) pour un client hors IDF, ou un simple dépôt ParcelShop
//     ne compte PAS comme livraison client.
//   - Une commande ne passe en « livré » que si TOUS ses colis sont livrés au
//     client (la règle v13 « 1 livré + reste silencieux 48 h » est supprimée).
//   - Livraison partielle (X/N) ou retour : la commande reste non livrée,
//     colonnes gls_livraison_etat / gls_livraison_detail renseignées
//     (ex. « livraison partielle 2/3 ») + SMS à Borhen à chaque changement
//     (anti-doublon table gls_alertes).
//   - Mode AUDIT lecture seule : { cmdIds:[...] } ou { auditLivres:true, jours? }.
//   Aucune commande déjà « livré » n'est modifiée (elles ne sont plus scannées).
//
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
import { appelInterne, appelApp, refus, EN_TETES_AUTORISES } from '../_shared/controle-appelant.ts';
import {
  analyserColis, analyserCommande, colisErreur, numerosColis, historiqueDe,
  type AnalyseColis, type AnalyseCommande,
} from '../_shared/gls-analyse.ts';

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

// v15 (28/09/2026) : l'ancienne fonction isParcelDelivered (tout "delivered"
// trouvé n'importe où dans le JSON) est remplacée par l'analyse d'historique
// de _shared/gls-analyse.ts (retour expéditeur, ParcelShop, dépôt d'origine).

// v12 : date (ms epoch) du dernier evenement de tracking d'un colis, ou null.
function getLastEventMs(trackData: any): number | null {
  const history = historiqueDe(trackData);
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

function jourParis(): string {
  return new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
}

// Suit tous les colis d'une commande (séquentiel, comme avant).
async function suivreCommande(tracking: string, opts: any): Promise<{ analyse: AnalyseCommande; bruts: Record<string, any> }> {
  const ids = numerosColis(tracking);
  const colis: AnalyseColis[] = [];
  const bruts: Record<string, any> = {};
  for (const trackId of ids) {
    const r = await trackParcel(trackId, opts);
    if (!r.ok) { colis.push(colisErreur(trackId)); continue; }
    bruts[trackId] = r.data;
    colis.push(analyserColis(trackId, r.data));
  }
  return { analyse: analyserCommande(colis), bruts };
}

// Résumé lisible d'un colis (sans données client) pour les rapports.
function resumeColis(c: AnalyseColis): any {
  return { trackId: c.trackId, etat: c.etat, motif: c.motif, priseEnCharge: c.priseEnChargeAt, livreClient: c.livreClientAt, retour: c.retourAt, dernier: c.dernierEvenementAt, dernierLibelle: c.dernierLibelle };
}

// Enregistre une alerte (anti-doublon) ; renvoie false si déjà présente.
async function reserverAlerte(type: string, cle: string, cmdId: string, message: string): Promise<boolean> {
  const { error } = await sb.from('gls_alertes').insert({ type, cle, jour: jourParis(), cmd_id: cmdId, message });
  return !error; // conflit de clé primaire = déjà alerté aujourd'hui
}

Deno.serve(async (req: Request) => {
  // 27/09/2026 : controle d'appelant (crons = x-cron-secret ; fonctions/scripts serveur = cle secrete sb_secret_)
  if (req.method !== 'OPTIONS' && !appelInterne(req)) return refus();
  const startTime = Date.now();
  let body: any = {};
  if (req.method === 'POST') { try { body = await req.json(); } catch { /* silent */ } }
  const dryRun: boolean = !!body.dryRun;
  const testTrackId: string | null = body.trackId || null;
  const useProd: boolean = !!body.useProd;
  const useRstt002: boolean = !!body.useRstt002;
  const useShipIT: boolean = !!body.useShipIT;
  const opts = { useRstt002, useShipIT, useProd };
  // v12 : seuil de detection colis bloque (jours sans scan)
  const stuckDays: number = (typeof body.stuckDays === 'number' && body.stuckDays > 0) ? body.stuckDays : STUCK_DAYS_DEFAULT;
  const summary = {
    version: 'v15',
    started_at: new Date().toISOString(),
    dryRun, useProd, useRstt002, useShipIT, stuckDays,
    cmds_a_checker: 0, cmds_livre: 0, cmds_partiel: 0, cmds_retour: 0, cmds_erreur: 0, cmds_bloquees: 0, alertes_sms: 0,
    duration_ms: 0,
    details: [] as any[],
  };
  const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

  // ── Mode test 1 colis ─────────────────────────────────────────────
  if (testTrackId) {
    const result = await trackParcel(testTrackId, opts);
    summary.details.push({ trackId: testTrackId, ...result });
    if (result.ok) {
      const a = analyserColis(testTrackId, result.data);
      summary.details[0].analyse = resumeColis(a);
      summary.details[0].interprete_livre = a.livreClient;
    }
    summary.duration_ms = Date.now() - startTime;
    return json({ ok: result.ok, summary });
  }

  // ── Mode AUDIT (lecture seule, JAMAIS d'écriture) ─────────────────
  // { cmdIds: ["#1561", ...] } : analyse ces commandes quel que soit leur statut
  // { auditLivres: true, jours?: 45 } : commandes déjà « livré » (étiquette de
  //   moins de N jours) dont la preuve GLS est contestée (pas « livre »).
  if (Array.isArray(body.cmdIds) || body.auditLivres) {
    let q = sb.from('commandes').select('id, statut, tracking_transporteur, gls_date_etiquette, date_livraison, litige_statut')
      .eq('transporteur', 'GLS').not('tracking_transporteur', 'is', null);
    if (Array.isArray(body.cmdIds)) q = q.in('id', body.cmdIds.map(String));
    else {
      const jours = Math.max(1, Math.min(120, Number(body.jours) || 45));
      const lim = new Date(Date.now() - jours * 86400000).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
      q = q.eq('statut', 'livré').gte('gls_date_etiquette', lim);
    }
    const { data: rows, error } = await q;
    if (error) return json({ ok: false, error: error.message }, 500);
    const liste: any[] = [];
    const file = [...(rows || [])];
    const worker = async () => {
      while (file.length) {
        const c: any = file.shift();
        const { analyse } = await suivreCommande(c.tracking_transporteur, opts);
        liste.push({
          cmdId: c.id, statut_base: c.statut, date_livraison_base: c.date_livraison || null, litige: c.litige_statut || null,
          etat_gls: analyse.etat, detail: analyse.detail, date_livraison_gls: analyse.dateLivraison,
          conteste: c.statut === 'livré' && analyse.etat !== 'livre' && analyse.etat !== 'erreur',
          colis: analyse.colis.map(resumeColis),
        });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    liste.sort((a, b) => String(a.cmdId).localeCompare(String(b.cmdId)));
    return json({
      ok: true, mode: Array.isArray(body.cmdIds) ? 'cmdIds' : 'auditLivres', lectureSeule: true,
      nb: liste.length, nbContestes: liste.filter((x) => x.conteste).length,
      commandes: body.auditLivres ? liste.filter((x) => x.conteste || x.etat_gls === 'erreur') : liste,
      duration_ms: Date.now() - startTime,
    });
  }

  // ── Synchro normale : commandes GLS non livrées / non annulées ────
  const { data: cmds, error: errCmds } = await sb
    .from('commandes')
    .select('id, client, tracking_transporteur, statut, gls_bloque, date_livraison, gls_livraison_etat, gls_livraison_detail')
    .eq('transporteur', 'GLS')
    .not('tracking_transporteur', 'is', null)
    .not('statut', 'in', '(livré,annulé)');

  if (errCmds) {
    summary.duration_ms = Date.now() - startTime;
    return json({ ok: false, error: 'Erreur SQL: ' + errCmds.message, summary }, 500);
  }

  const cmdsValid = (cmds || []).filter((c: any) => numerosColis(c.tracking_transporteur).length > 0);
  summary.cmds_a_checker = cmdsValid.length;
  const seuilMs = stuckDays * 24 * 3600 * 1000;

  for (const cmd of cmdsValid) {
    const trackingFull: string = cmd.tracking_transporteur;
    const { analyse, bruts } = await suivreCommande(trackingFull, opts);
    const parcels = analyse.colis.map(resumeColis);
    const base = { cmdId: cmd.id, client: cmd.client, tracking: trackingFull, nbColis: analyse.nbColis, etat_gls: analyse.etat, detail: analyse.detail, parcels };

    // Détection « bloqué » (v12, inchangée) : colis non livré sans scan depuis stuckDays
    let dernierScanNonLivre: number | null = null;
    let bloque = false;
    for (const c of analyse.colis) {
      if (c.etat === 'livre' || c.etat === 'erreur') continue;
      const lastMs = getLastEventMs(bruts[c.trackId]);
      if (lastMs === null) continue;
      if (dernierScanNonLivre === null || lastMs > dernierScanNonLivre) dernierScanNonLivre = lastMs;
      if (Date.now() - lastMs > seuilMs) bloque = true;
    }

    const majEtat: any = { gls_livraison_etat: analyse.etat, gls_livraison_detail: analyse.detail, gls_livraison_verif_at: new Date().toISOString() };

    if (analyse.etat === 'livre') {
      // v15 : TOUS les colis livrés au client (plus de règle « 1 livré + reste silencieux 48 h »)
      if (dryRun) {
        summary.cmds_livre++;
        summary.details.push({ ...base, status: 'would_update_livre', date_livraison_gls: analyse.dateLivraison });
        continue;
      }
      // v14 : date_livraison renseignée si vide (date réelle du dernier colis livré)
      const majLivre: any = { ...majEtat, statut: 'livré', gls_bloque: false };
      if (!cmd.date_livraison) majLivre.date_livraison = analyse.dateLivraison || jourParis();
      const { error: errUpd } = await sb.from('commandes').update(majLivre).eq('id', cmd.id);
      if (errUpd) { summary.cmds_erreur++; summary.details.push({ ...base, status: 'update_failed', error: errUpd.message }); }
      else { summary.cmds_livre++; summary.details.push({ ...base, status: 'updated_to_livre' }); }
      continue;
    }

    if (analyse.etat === 'erreur' && analyse.nbErreurs === analyse.nbColis) {
      summary.cmds_erreur++;
      summary.details.push({ ...base, status: 'all_api_error' });
      continue; // rien n'est écrit : on réessaie au prochain passage
    }

    // Pas livré (transit / partiel / retour / non pris en charge / erreur partielle)
    const etaitBloque = !!cmd.gls_bloque;
    const nouveauProbleme = (analyse.etat === 'partiel' || analyse.etat === 'retour')
      && (cmd.gls_livraison_detail !== analyse.detail);
    let alerteSms = false;
    let alerteLivraison = false;
    if (analyse.etat === 'partiel') summary.cmds_partiel++;
    if (analyse.etat === 'retour') summary.cmds_retour++;
    if (!dryRun) {
      try {
        await sb.from('commandes').update({
          ...majEtat,
          gls_bloque: bloque,
          gls_dernier_scan: dernierScanNonLivre ? new Date(dernierScanNonLivre).toISOString() : null,
        }).eq('id', cmd.id);
      } catch (_e) { /* non bloquant */ }
      // v15 : alerte livraison PARTIELLE ou RETOUR (1 fois par changement d'état, max 1/jour/commande)
      if (nouveauProbleme && await reserverAlerte('livraison-' + analyse.etat, cmd.id, cmd.id, analyse.detail)) {
        const lignes = analyse.colis.filter((c) => c.etat !== 'livre').map((c) => c.trackId + ' ' + c.etat).join(', ');
        alerteLivraison = await envoyerAlerteSMS(
          'GLS ' + (analyse.etat === 'retour' ? 'RETOUR' : 'LIVRAISON PARTIELLE') + ' ' + cmd.id + ' : ' + analyse.detail +
          '. Non livres : ' + lignes + '. Commande laissee NON livree (a verifier).'
        );
        if (alerteLivraison) summary.alertes_sms++;
      }
      // Alerte « bloqué » uniquement au PASSAGE a bloque (pas de re-alerte chaque heure)
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
    if (analyse.etat === 'erreur') summary.cmds_erreur++;
    summary.details.push({
      ...base, livreCount: analyse.nbLivres, errorCount: analyse.nbErreurs,
      bloque, etaitBloque, alerteSms, alerteLivraison, nouveauProbleme,
      dernier_scan: dernierScanNonLivre ? new Date(dernierScanNonLivre).toISOString() : null,
      status: `${analyse.etat} (${analyse.nbLivres}/${analyse.nbColis} livré${analyse.nbLivres > 1 ? 's' : ''}${analyse.nbErreurs > 0 ? ', ' + analyse.nbErreurs + ' err' : ''})`,
    });
  }

  summary.duration_ms = Date.now() - startTime;

  if (!dryRun) {
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
  }

  return json({ ok: true, summary });
});
