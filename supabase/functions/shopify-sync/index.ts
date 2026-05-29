// ════════════════════════════════════════════════════════════════════
// Edge Function : shopify-sync
// ════════════════════════════════════════════════════════════════════
// Importe les nouvelles commandes Shopify dans la table `commandes` de
// Supabase. Conçue pour être déclenchée toutes les 10 minutes via
// pg_cron (ou manuellement via curl pour tester).
//
// Secrets requis (à configurer dans Supabase Edge Functions Secrets) :
//   - SHOPIFY_STORE_DOMAIN     ex: maxiconfort-fr.myshopify.com
//   - SHOPIFY_ACCESS_TOKEN     ex: shpat_xxx
//   - SHOPIFY_API_VERSION      ex: 2026-04
//   - SUPABASE_SERVICE_ROLE_KEY (auto-injecté par Supabase)
//   - SUPABASE_URL             (auto-injecté par Supabase)
//
// Logique :
//   1. Lit `last_shopify_sync` depuis la table `parametres`
//   2. Appelle Shopify /admin/api/.../orders.json?created_at_min=...
//   3. Pour chaque commande non encore en BD (filtre par ref_marketplace) :
//      - Map les champs Shopify → Maxiconfort Livraison Pro
//      - Insère via upsert (resolution=merge-duplicates)
//   4. Met à jour `last_shopify_sync` à now()
//   5. Retourne { imported, skipped, errors }
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SHOPIFY_DOMAIN  = Deno.env.get('SHOPIFY_STORE_DOMAIN') || '';
const SHOPIFY_TOKEN   = Deno.env.get('SHOPIFY_ACCESS_TOKEN') || '';
const SHOPIFY_VERSION = Deno.env.get('SHOPIFY_API_VERSION') || '2026-04';
const SB_URL          = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY       = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const sb = createClient(SB_URL, SB_SR_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Helpers ────────────────────────────────────────────────────────
async function getLastSync(): Promise<string> {
  const { data } = await sb
    .from('parametres')
    .select('valeur')
    .eq('cle', 'last_shopify_sync')
    .maybeSingle();
  // Si jamais sync : on prend "il y a 1h" pour la 1ere fois (evite de tout reimporter)
  if (!data?.valeur) {
    const h1 = new Date(Date.now() - 3600 * 1000).toISOString();
    return h1;
  }
  return data.valeur;
}

async function setLastSync(iso: string): Promise<void> {
  await sb
    .from('parametres')
    .upsert({ cle: 'last_shopify_sync', valeur: iso }, { onConflict: 'cle' });
}

function fmtAdresse(addr: any): string {
  if (!addr) return '';
  const parts = [
    addr.address1, addr.address2, addr.zip, addr.city, addr.country
  ].filter(Boolean).map((s: string) => String(s).trim()).filter(Boolean);
  return parts.join(', ');
}

function fmtClient(o: any): string {
  // Priorité : shipping_address puis customer
  const ship = o.shipping_address;
  const cust = o.customer;
  if (ship?.first_name || ship?.last_name) {
    return [ship.first_name, ship.last_name].filter(Boolean).join(' ').trim();
  }
  if (cust?.first_name || cust?.last_name) {
    return [cust.first_name, cust.last_name].filter(Boolean).join(' ').trim();
  }
  return o.email || '—';
}

function fmtTel(o: any): string {
  return (o.shipping_address?.phone || o.customer?.phone || o.phone || '').toString();
}

function mapStatutPaie(financial: string): string {
  // Shopify : pending | authorized | partially_paid | paid | partially_refunded | refunded | voided
  if (financial === 'paid') return 'Payé';
  if (financial === 'partially_paid') return 'Partiel';
  if (financial === 'pending' || financial === 'authorized') return 'Non payé';
  if (financial === 'refunded' || financial === 'voided') return 'Annulé';
  return 'Non payé';
}

function mapLignes(items: any[]): any[] {
  if (!items?.length) return [];
  return items.map((li: any) => ({
    produitId: null,
    produit: li.title + (li.variant_title ? ' — ' + li.variant_title : ''),
    qte: Number(li.quantity) || 1,
    prixUnit: Number(li.price) || 0,
    prixBrut: (Number(li.price) || 0) * (Number(li.quantity) || 1),
    remiseLigne: 0,
    remiseVal: 0,
    remiseType: 'pct',
    sousTotal: (Number(li.price) || 0) * (Number(li.quantity) || 1),
  }));
}

function mapShopifyToCmd(o: any) {
  const lignes = mapLignes(o.line_items || []);
  const produitConcat = lignes.map(l => l.qte + '× ' + l.produit).join(' | ');
  const totalPrix = Number(o.current_total_price || o.total_price || 0);
  return {
    id: o.name || ('#' + o.order_number),    // ex: "#1018"
    client: fmtClient(o),
    tel: fmtTel(o),
    email: o.email || o.contact_email || '',
    adresse: fmtAdresse(o.shipping_address),
    etage: '',
    ascenseur: 'Non',
    code: '',
    produit: produitConcat,
    lignes: lignes,
    qte: lignes.reduce((s, l) => s + (l.qte || 1), 0) || 1,
    prix: totalPrix,
    prix_brut: totalPrix,
    remise_globale: 0,
    remise_globale_val: 0,
    remise_globale_type: 'pct',
    remise_motif: '',
    paie: 'Site Maxiconfort',
    stpaie: mapStatutPaie(o.financial_status),
    montant_enc: o.financial_status === 'paid' ? totalPrix : 0,
    livreur: '',
    statut: 'en-attente',
    date_livraison: '',  // a planifier par Borhen ensuite
    date_commande: (o.created_at || '').substring(0, 10), // YYYY-MM-DD
    instr: (o.note || '').toString(),
    origine: 'Site Maxiconfort',
    ref_marketplace: String(o.id), // ID Shopify pour deduper
    updated_at: new Date().toISOString(),
    created_at: o.created_at || new Date().toISOString(),
  };
}

async function commandeDejaImportee(shopifyId: string): Promise<boolean> {
  const { data } = await sb
    .from('commandes')
    .select('id')
    .eq('ref_marketplace', shopifyId)
    .limit(1);
  return !!(data && data.length);
}

// ── Handler ────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) {
    return new Response(JSON.stringify({
      error: 'Configuration manquante : SHOPIFY_STORE_DOMAIN / SHOPIFY_ACCESS_TOKEN'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  const startTime = Date.now();
  const result = { imported: 0, skipped: 0, errors: 0, errorDetails: [] as string[] };

  try {
    // 1. Date de derniere sync
    const sinceIso = await getLastSync();

    // 2. Appeler Shopify
    // Filtres :
    //   - updated_at_min : on prend aussi les commandes dont le statut a change
    //     (ex: pending devenu paid plus tard)
    //   - financial_status=paid : uniquement les commandes payees (regle metier Borhen)
    //   - status=any : ne pas filtrer par statut de fulfillment
    const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_VERSION}/orders.json` +
      `?updated_at_min=${encodeURIComponent(sinceIso)}` +
      `&financial_status=paid` +
      `&status=any&limit=250`;

    const resp = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Accept': 'application/json' }
    });
    if (!resp.ok) {
      return new Response(JSON.stringify({
        error: 'Shopify API error',
        status: resp.status,
        body: await resp.text()
      }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
    const json = await resp.json();
    const orders: any[] = json.orders || [];

    // 3. Pour chaque commande, mapper + upsert si pas deja en BD
    for (const o of orders) {
      try {
        const shopifyId = String(o.id);
        if (await commandeDejaImportee(shopifyId)) {
          result.skipped++;
          continue;
        }
        const cmd = mapShopifyToCmd(o);
        const { error } = await sb.from('commandes').upsert(cmd, { onConflict: 'id' });
        if (error) {
          result.errors++;
          result.errorDetails.push(`${o.name}: ${error.message}`);
        } else {
          result.imported++;
        }
      } catch (e: any) {
        result.errors++;
        result.errorDetails.push(`${o.name || o.id}: ${e.message}`);
      }
    }

    // 4. Mettre a jour le timestamp de derniere sync
    await setLastSync(new Date().toISOString());

    return new Response(JSON.stringify({
      ...result,
      since: sinceIso,
      total_shopify: orders.length,
      duration_ms: Date.now() - startTime,
    }), { headers: { 'Content-Type': 'application/json' } });

  } catch (e: any) {
    return new Response(JSON.stringify({
      error: e.message,
      stack: e.stack,
      ...result
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
