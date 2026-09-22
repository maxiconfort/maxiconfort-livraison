// ════════════════════════════════════════════════════════════════════
// Edge Function : tiktok-sync
// ════════════════════════════════════════════════════════════════════
// Importe les commandes TikTok Shop « en attente d'expédition » dans la
// table `commandes` de Maxiconfort Livraison (même logique que
// shopify-sync). Prévue pour pg_cron toutes les 10 minutes.
//
// Règles métier (Borhen, 22/09/2026) :
//   - Une commande TikTok est TOUJOURS expédiée par GLS (jamais RANOU,
//     même en Île-de-France : leçon #1721 Emerance, colis livré nous-mêmes
//     = commande annulée par TikTok et jamais payée).
//   - Paiement = « TikTok Shop » / Payé (le client a déjà payé TikTok).
//   - ref_marketplace = 'TT' + id commande TikTok (dédoublonnage, même
//     format que les saisies manuelles #1720/#1741/#1777/#1778).
//
// Pré-requis dans `parametres` (posés par tiktok-oauth-callback) :
//   tiktok_access_token, tiktok_access_token_expire_at,
//   tiktok_refresh_token, tiktok_shop_cipher (obligatoire pour l'API
//   commandes ; récupéré automatiquement si le scope « Shop Authorized
//   Information » a été accordé).
//
// Body optionnel : { dryRun: true }  -> liste ce qui serait importé, n'écrit rien
//                  { diag: true }    -> liste les commandes TikTok (tous statuts récents)
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getAuthorizedShops, refreshAccessToken, signedRequest } from '../_shared/tiktok.ts';

const sb = createClient(Deno.env.get('SUPABASE_URL') || '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '', {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Paramètres ──────────────────────────────────────────────────────
async function getParams(): Promise<Record<string, string>> {
  const { data } = await sb.from('parametres').select('cle,valeur').like('cle', 'tiktok_%');
  const out: Record<string, string> = {};
  for (const r of (data || [])) out[(r as any).cle] = (r as any).valeur;
  return out;
}
async function setParam(cle: string, valeur: string) {
  const { error } = await sb.from('parametres').upsert({ cle, valeur }, { onConflict: 'cle' });
  if (error) throw new Error('parametres ' + cle + ': ' + error.message);
}

// Jeton : rafraîchi s'il expire dans moins de 24 h.
async function ensureAccessToken(p: Record<string, string>): Promise<string> {
  const exp = Date.parse(p.tiktok_access_token_expire_at || '') || 0;
  if (p.tiktok_access_token && exp - Date.now() > 24 * 3600 * 1000) return p.tiktok_access_token;
  if (!p.tiktok_refresh_token) throw new Error('Aucun jeton TikTok : refaire l\'autorisation de la boutique');
  const t = await refreshAccessToken(p.tiktok_refresh_token);
  await setParam('tiktok_access_token', t.access_token);
  await setParam('tiktok_access_token_expire_at', new Date(t.access_token_expire_in * 1000).toISOString());
  if (t.refresh_token) await setParam('tiktok_refresh_token', t.refresh_token);
  if (t.refresh_token_expire_in) await setParam('tiktok_refresh_token_expire_at', new Date(t.refresh_token_expire_in * 1000).toISOString());
  return t.access_token;
}

async function ensureShopCipher(p: Record<string, string>, token: string): Promise<string> {
  if (p.tiktok_shop_cipher) return p.tiktok_shop_cipher;
  const shops = await getAuthorizedShops(token); // nécessite le scope seller.authorization.info
  const shop = shops.find((s) => s.region === 'FR') || shops[0];
  if (!shop?.cipher) throw new Error('Aucune boutique autorisée renvoyée par TikTok');
  await setParam('tiktok_shop_id', shop.id);
  await setParam('tiktok_shop_cipher', shop.cipher);
  await setParam('tiktok_shop_name', shop.name);
  return shop.cipher;
}

// ── API commandes ───────────────────────────────────────────────────
async function searchOrders(token: string, cipher: string, status: string | undefined, sinceUnix?: number): Promise<any[]> {
  const orders: any[] = [];
  let pageToken = '';
  for (let i = 0; i < 10; i++) {
    const q: Record<string, string> = { shop_cipher: cipher, page_size: '50', sort_field: 'create_time', sort_order: 'DESC' };
    if (pageToken) q.page_token = pageToken;
    const body: any = {};
    if (status) body.order_status = status;
    if (sinceUnix) body.update_time_ge = sinceUnix;
    const j = await signedRequest('/order/202309/orders/search', token, q, 'POST', body);
    if (j.code !== 0) throw new Error('orders/search: ' + JSON.stringify(j).slice(0, 300));
    orders.push(...(j.data?.orders || []));
    pageToken = j.data?.next_page_token || '';
    if (!pageToken) break;
  }
  return orders;
}

// ── Mapping TikTok -> commande app ──────────────────────────────────
function fmtTel(raw: string): string {
  let t = String(raw || '').replace(/[\s().-]/g, '');
  if (t.startsWith('+33')) t = '0' + t.slice(3);
  else if (t.startsWith('0033')) t = '0' + t.slice(4);
  return t;
}

function cityFrom(addr: any): string {
  const infos: any[] = addr?.district_info || [];
  // TikTok FR : L1 = pays, L2 = région/département, L3 = ville (le plus fin en dernier)
  const byLevel = infos.find((d) => /L3|city|ville/i.test(String(d.address_level_name || d.address_level || '')));
  if (byLevel?.address_name) return String(byLevel.address_name);
  const last = infos[infos.length - 1];
  return last?.address_name && !/france/i.test(last.address_name) ? String(last.address_name) : '';
}

function fmtAdresse(addr: any): string {
  if (!addr) return '';
  const rue = [addr.address_detail || addr.address_line1, addr.address_line2, addr.address_line3, addr.address_line4]
    .map((s) => String(s || '').trim()).filter(Boolean);
  const cp = String(addr.postal_code || '').trim();
  const ville = cityFrom(addr);
  const pays = String(addr.region_code || 'FR').toUpperCase() === 'FR' ? 'France' : String(addr.region_code || '');
  const parts = [...rue, cp, ville, pays].filter(Boolean);
  // Si on n'a ni rue ni CP, on retombe sur l'adresse complète TikTok
  if (!rue.length && !cp) return String(addr.full_address || '');
  return parts.join(', ');
}

function mapLignes(items: any[]) {
  const map = new Map<string, any>();
  for (const li of (items || [])) {
    const key = String(li.sku_id || li.product_id || li.product_name);
    const nomSku = li.sku_name && !/^default$/i.test(String(li.sku_name)) ? ' — ' + li.sku_name : '';
    const prixUnit = Number(li.sale_price ?? li.original_price ?? 0);
    const prixOrig = Number(li.original_price ?? li.sale_price ?? 0);
    const cur = map.get(key);
    if (cur) { cur.qte += 1; }
    else map.set(key, { produitId: null, produit: String(li.product_name || '') + nomSku, qte: 1, prixUnit, _orig: prixOrig, _ugs: li.seller_sku || '' });
  }
  return [...map.values()].map((l) => ({
    produitId: l.produitId,
    produit: l.produit,
    qte: l.qte,
    prixUnit: l.prixUnit,
    prixBrut: +(l.prixUnit * l.qte).toFixed(2),
    remiseLigne: 0,
    remiseVal: 0,
    remiseType: 'pct',
    sousTotal: +(l.prixUnit * l.qte).toFixed(2),
    _orig: +(l._orig * l.qte).toFixed(2),
    _ugs: l._ugs,
  }));
}

function fmtDateFr(unix: number): string {
  if (!unix) return '';
  return new Date(unix * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Paris' });
}

export function mapTiktokToCmd(o: any, appId: string) {
  const lignesFull = mapLignes(o.line_items || []);
  const sousTotal = +lignesFull.reduce((s, l) => s + l.sousTotal, 0).toFixed(2);
  const brut = +lignesFull.reduce((s, l) => s + l._orig, 0).toFixed(2);
  const remise = +Math.max(0, brut - sousTotal).toFixed(2);
  const port = +Number(o.payment?.shipping_fee ?? 0).toFixed(2);
  const prixTotal = +(sousTotal + port).toFixed(2);
  const ugs = lignesFull.map((l) => l._ugs).filter(Boolean).join(', ');
  const lignes = lignesFull.map(({ _orig: _o, _ugs: _u, ...l }) => l);
  const addr = o.recipient_address || {};
  const created = o.create_time ? new Date(o.create_time * 1000) : new Date();
  const instr = [
    `Commande TikTok Shop ${o.id}` + (o.buyer_username ? ` (client ${o.buyer_username})` : '') + '.',
    o.shipping_due_time ? `A expedier avant le ${fmtDateFr(o.shipping_due_time)}.` : '',
    o.payment_method_name ? `Payé ${o.payment_method_name}.` : '',
    ugs ? `UGS ${ugs}.` : '',
    o.buyer_message ? `Message client : ${String(o.buyer_message).trim()}` : '',
  ].filter(Boolean).join(' ');
  return {
    id: appId,
    client: String(addr.name || o.buyer_username || '—').trim(),
    tel: fmtTel(addr.phone_number || ''),
    email: String(o.buyer_email || ''),
    adresse: fmtAdresse(addr),
    etage: '',
    ascenseur: 'Non',
    code: '',
    produit: lignes.map((l) => l.qte + '× ' + l.produit).join(' | '),
    lignes,
    qte: lignes.reduce((s, l) => s + (l.qte || 1), 0) || 1,
    prix: prixTotal,
    prix_brut: brut || sousTotal,
    frais_port: port,
    remise_globale: remise,
    remise_globale_val: remise,
    remise_globale_type: 'eur',
    remise_motif: remise > 0 ? 'Remise TikTok' : '',
    paie: 'TikTok Shop',
    stpaie: 'Payé',
    montant_enc: prixTotal,
    livreur: 'GLS',
    statut: 'en-attente',
    date_livraison: '',
    date_commande: created.toISOString().substring(0, 10),
    instr,
    origine: 'TikTok Shop',
    transporteur: 'GLS',            // TOUJOURS GLS pour TikTok (jamais RANOU)
    ref_marketplace: 'TT' + String(o.id),
    updated_at: new Date().toISOString(),
    created_at: created.toISOString(),
  };
}

async function dejaImportee(tiktokId: string): Promise<string | null> {
  // 1) clé normale TT<id>  2) saisie manuelle ancienne : id dans l'instruction
  const { data } = await sb.from('commandes').select('id')
    .or(`ref_marketplace.eq.TT${tiktokId},ref_marketplace.eq.${tiktokId},instr.ilike.%${tiktokId}%`)
    .limit(1);
  return data && data.length ? String((data[0] as any).id) : null;
}

async function maxNumeroCommande(): Promise<number> {
  const { data } = await sb.from('commandes').select('id');
  let maxN = 0;
  for (const r of (data || [])) {
    const idStr = String((r as any)?.id || '');
    if (/SAV/i.test(idStr)) continue;
    const n = parseInt(idStr.replace(/[^0-9]/g, '')) || 0;
    if (n > maxN) maxN = n;
  }
  return maxN;
}

// ── Handler ─────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  const start = Date.now();
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const dryRun = !!body?.dryRun;
  const result = { imported: 0, skipped: 0, errors: 0, errorDetails: [] as string[], details: [] as any[] };
  try {
    const p = await getParams();
    const token = await ensureAccessToken(p);
    const cipher = await ensureShopCipher(p, token);

    if (body?.diag) {
      const heures = Number(body.heures) > 0 ? Number(body.heures) : 72;
      const since = Math.floor((Date.now() - heures * 3600 * 1000) / 1000);
      const all = await searchOrders(token, cipher, undefined, since);
      const lignes = [];
      for (const o of all) {
        lignes.push({
          tiktok: o.id, statut: o.status, client: o.recipient_address?.name, total: o.payment?.total_amount,
          cree: new Date(o.create_time * 1000).toISOString(), en_base: (await dejaImportee(String(o.id))) || 'NON IMPORTEE',
        });
      }
      return json({ diag: true, heures, total: all.length, commandes: lignes });
    }

    // Commandes payées, prêtes à expédier.
    // Test : { dryRun:true, status:'AWAITING_COLLECTION', mapOnly:true } montre le mapping
    // de commandes déjà en base sans rien écrire (contrôle du format adresse/lignes).
    const statut = dryRun && typeof body?.status === 'string' ? body.status : 'AWAITING_SHIPMENT';
    const orders = await searchOrders(token, cipher, statut);
    let prochainNum = (await maxNumeroCommande()) + 1;
    for (const o of orders) {
      try {
        const existante = await dejaImportee(String(o.id));
        if (existante && !(dryRun && body?.mapOnly)) { result.skipped++; result.details.push({ tiktok: o.id, deja: existante }); continue; }
        const cmd = mapTiktokToCmd(o, '#' + prochainNum);
        if (dryRun) { result.details.push(cmd); result.imported++; prochainNum++; continue; }
        const { error } = await sb.from('commandes').upsert(cmd, { onConflict: 'id' });
        if (error) { result.errors++; result.errorDetails.push(`${o.id}: ${error.message}`); }
        else { result.imported++; result.details.push({ tiktok: o.id, app: cmd.id, client: cmd.client, prix: cmd.prix }); prochainNum++; }
      } catch (e: any) {
        result.errors++; result.errorDetails.push(`${o.id}: ${e.message}`);
      }
    }
    if (!dryRun) await setParam('last_tiktok_sync', new Date().toISOString());
    return json({ ...result, dryRun, total_tiktok: orders.length, duration_ms: Date.now() - start });
  } catch (e: any) {
    return json({ error: e.message, ...result, duration_ms: Date.now() - start }, 500);
  }
});

function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}
