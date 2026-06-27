// ════════════════════════════════════════════════════════════════════
// Edge Function : shopify-fulfill (v1 — 27/06/2026)
// ════════════════════════════════════════════════════════════════════
// Marque les commandes du SITE (Shopify) comme « Traitée » (Fulfilled)
// quand elles sont LIVRÉES — y compris celles livrées par RANOU en
// Île-de-France (pas de GLS, donc pas couvertes par gls-create-shipment).
//
// Déclenché :
//   - par cmdId (traitement immédiat d'une commande précise)
//   - par pg_cron (scan des commandes site livrées récemment)
//
// Pour chaque commande site (ref_marketplace = ID Shopify numérique) :
//   - GET fulfillment_orders OUVERTS → si aucun, déjà traité → skip
//   - POST /fulfillments.json :
//       * GLS  : tracking_info {number: 1er trackGLS, company 'GLS', url} + notify_customer:true
//       * RANOU: pas de n° transporteur ; lien de suivi track.html ; notify_customer:false
//         (le client a déjà reçu le SMS de livraison de l'app — pas de doublon)
//
// Body : { cmdId?: string, dryRun?: boolean, fenetreHeures?: number }
// Secrets : SHOPIFY_STORE_DOMAIN / SHOPIFY_ACCESS_TOKEN / SHOPIFY_API_VERSION
//           + SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SB_URL    = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const SHOPIFY_DOMAIN  = Deno.env.get('SHOPIFY_STORE_DOMAIN') || '';
const SHOPIFY_TOKEN   = Deno.env.get('SHOPIFY_ACCESS_TOKEN') || '';
const SHOPIFY_VERSION = Deno.env.get('SHOPIFY_API_VERSION') || '2026-04';
const APP_BASE = 'https://livraison.maxiconfort.fr';

const sb = createClient(SB_URL, SB_SR_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function fulfillUne(cmd: any): Promise<any> {
  const shopId = String(cmd?.ref_marketplace || '').trim();
  if (!shopId || !/^\d+$/.test(shopId)) return { id: cmd?.id, skip: 'pas commande site' };
  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) return { id: cmd?.id, error: 'secrets Shopify absents' };
  const base = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_VERSION}`;
  const headers = { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json', 'Accept': 'application/json' };
  try {
    const foResp = await fetch(`${base}/orders/${shopId}/fulfillment_orders.json`, { headers });
    if (!foResp.ok) return { id: cmd.id, error: `GET fo HTTP ${foResp.status}`, detail: (await foResp.text()).slice(0, 200) };
    const foData = await foResp.json();
    const fos = (foData.fulfillment_orders || []).filter((f: any) =>
      f.status === 'open' || f.status === 'in_progress' || f.status === 'scheduled');
    if (!fos.length) return { id: cmd.id, shopId, skip: 'deja traitee' };

    const estGLS = (cmd.transporteur || 'RANOU') === 'GLS' && cmd.tracking_transporteur;
    let tracking_info: any;
    let notify = false;
    if (estGLS) {
      const n = String(cmd.tracking_transporteur).split(',')[0].trim();
      tracking_info = { number: n, company: 'GLS', url: `https://gls-group.eu/FR/fr/suivi-colis.html?match=${n}` };
      notify = true;
    } else {
      // RANOU : livraison interne, déjà livrée + client déjà notifié par SMS -> pas d'email
      tracking_info = cmd.tracking_token
        ? { company: 'Maxiconfort', url: `${APP_BASE}/track.html?t=${cmd.tracking_token}` }
        : { company: 'Maxiconfort' };
      notify = false;
    }
    const fResp = await fetch(`${base}/fulfillments.json`, {
      method: 'POST', headers,
      body: JSON.stringify({
        fulfillment: {
          line_items_by_fulfillment_order: fos.map((f: any) => ({ fulfillment_order_id: f.id })),
          tracking_info,
          notify_customer: notify,
        },
      }),
    });
    const fJson = await fResp.json().catch(() => ({}));
    if (!fResp.ok) return { id: cmd.id, shopId, error: `POST fulfillment HTTP ${fResp.status}`, detail: JSON.stringify(fJson).slice(0, 250) };
    return { id: cmd.id, shopId, ok: true, transporteur: cmd.transporteur || 'RANOU', notify, fulfillment_id: fJson?.fulfillment?.id || null };
  } catch (e: any) {
    return { id: cmd.id, error: e?.message || String(e) };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let body: any; try { body = await req.json(); } catch { body = {}; }
  const dryRun = !!body.dryRun;
  const cmdId = body.cmdId || null;
  const fenetreHeures = Number(body.fenetreHeures) > 0 ? Number(body.fenetreHeures) : 72;

  let cmds: any[] = [];
  if (cmdId) {
    const { data } = await sb.from('commandes')
      .select('id, client, statut, transporteur, ref_marketplace, tracking_token, tracking_transporteur')
      .eq('id', cmdId).maybeSingle();
    if (data) cmds = [data];
  } else {
    // Scan : commandes SITE livrées récemment (ref_marketplace numérique)
    const since = new Date(Date.now() - fenetreHeures * 3600 * 1000).toISOString();
    const { data } = await sb.from('commandes')
      .select('id, client, statut, transporteur, ref_marketplace, tracking_token, tracking_transporteur, updated_at')
      .eq('statut', 'livré')
      .not('ref_marketplace', 'is', null)
      .gte('updated_at', since);
    cmds = (data || []).filter((c: any) => /^\d+$/.test(String(c.ref_marketplace || '')));
  }

  const resultats: any[] = [];
  for (const c of cmds) {
    if (dryRun) { resultats.push({ id: c.id, client: c.client, ref: c.ref_marketplace, would_fulfill: true }); continue; }
    resultats.push(await fulfillUne(c));
  }
  const ok = resultats.filter(r => r.ok).length;
  return new Response(JSON.stringify({ ok: true, dryRun, scannees: cmds.length, traitees: ok, resultats }),
    { headers: { 'Content-Type': 'application/json' } });
});
