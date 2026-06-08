// ════════════════════════════════════════════════════════════════════
// Edge Function : shopify-order-note (v1 — 06/06/2026)
// ════════════════════════════════════════════════════════════════════
// Recoit le webhook orders/create de Shopify.
// Parse les line items, detecte les bundles via SKU + prix matching.
// Genere une note de preparation structuree.
// PATCH la commande avec la note (visible dans Shopify admin).
//
// ALERTE en cas de bundle INCOMPLET (cas vecu : commande #1019 ou
// le matelas 160x200 est invisible dans la commande malgre que le
// client ait paye l'ensemble complet).
//
// Secrets requis :
// - SHOPIFY_STORE_DOMAIN (ex: maxiconfort-fr.myshopify.com)
// - SHOPIFY_ACCESS_TOKEN (shpat_...)
// - SHOPIFY_API_VERSION  (ex: 2026-04)
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any

const SHOP_DOMAIN  = Deno.env.get('SHOPIFY_STORE_DOMAIN') || '';
const SHOP_TOKEN   = Deno.env.get('SHOPIFY_ACCESS_TOKEN') || '';
const API_VERSION  = Deno.env.get('SHOPIFY_API_VERSION') || '2026-04';

// ── Catalogue des bundles (hardcode pour perfs + clarte) ────────────
// Format : { parent_title, parent_price, components: [{sku, qty, title_short}] }
// Mis a jour le 06/06/2026 - 7 ensembles + 3 packs identifies dans le catalogue Shopify
const BUNDLES = [
  {
    parent_title: 'Ensemble 140×190 - 15cm Mémoire',
    parent_price: 189.0,
    parent_id: '15501972799818',
    components: [
      { sku: 'MAT-DODO-140X190X15', qty: 1, title: 'Matelas 140×190 Mémoire 15cm Dodo OEKO-TEX' },
      { sku: 'SOM-BOIS-140X190-20', qty: 1, title: 'Sommier 140×190 Bois Lattes Cuir PU 20cm' },
    ],
  },
  {
    parent_title: 'Ensemble 160×200 Queen Size (20cm)',
    parent_price: 239.0,
    parent_id: '15502004158794',
    components: [
      { sku: 'MAT-DODO-160X200X20', qty: 1, title: 'Matelas 160×200 Mémoire 20cm Dodo Premium' },
      { sku: 'SOM-BOIS-160X200-20', qty: 1, title: 'Sommier 160×200 Bois Lattes Cuir PU 20cm' },
    ],
  },
  {
    parent_title: 'Ensemble 180×200 King Size (20cm)',
    parent_price: 299.0,
    parent_id: '15502817329482',
    components: [
      { sku: 'MAT-DODO-180X200X20', qty: 1, title: 'Matelas 180×200 Mémoire 20cm Dodo Premium' },
      { sku: 'SOM-BOIS-180X200-20', qty: 1, title: 'Sommier 180×200 Bois Lattes Cuir PU 20cm' },
    ],
  },
  {
    parent_title: 'Ensemble 90×200 - 15cm Mémoire (1 personne)',
    parent_price: 179.0,
    parent_id: '15502755529034',
    components: [
      { sku: 'MAT-DODO-90X200X15', qty: 1, title: 'Matelas 90×200 Mémoire 15cm Dodo' },
      // ATTENTION : bundle config Shopify a un sommier 90x190 ici (anomalie a verifier)
      { sku: 'SOM-BOIS-90X190-20', qty: 1, title: 'Sommier 90×190 Bois Lattes Cuir PU 20cm' },
    ],
  },
  {
    parent_title: 'Ensemble 90×200 - 20cm Mémoire (1 personne)',
    parent_price: 189.0,
    parent_id: '15502768374090',
    components: [
      { sku: 'MAT-DODO-90X200X20', qty: 1, title: 'Matelas 90×200 Mémoire 20cm Dodo' },
      { sku: 'SOM-BOIS-90X200-20', qty: 1, title: 'Sommier 90×200 Bois Lattes Cuir PU 20cm' },
    ],
  },
  {
    parent_title: 'Ensemble complet 140×190 - 20cm Mémoire',
    parent_price: 199.0,
    parent_id: '15447975592266',
    components: [
      { sku: 'MAT-DODO-140X190X20', qty: 1, title: 'Matelas 140×190 Mémoire 20cm Dodo Soutien Ferme' },
      { sku: 'SOM-BOIS-140X190-20', qty: 1, title: 'Sommier 140×190 Bois Lattes Cuir PU 20cm' },
    ],
  },
  {
    parent_title: 'Ensemble complet 90×190 - 20cm Mémoire',
    parent_price: 179.0,
    parent_id: '15502007304522',
    components: [
      { sku: 'MAT-DODO-90X190X20', qty: 1, title: 'Matelas 90×190 Mémoire 20cm Dodo Premium' },
      { sku: 'SOM-BOIS-90X190-20', qty: 1, title: 'Sommier 90×190 Bois Lattes Cuir PU 20cm' },
    ],
  },
];

// ── Algo : extrait le maximum de bundles complets du pool ──────────
function extractCompleteBundles(pool: any[]): { complete: any[]; remaining: any[] } {
  const complete: any[] = [];
  const workPool = pool.map(p => ({ ...p }));

  for (const bundle of BUNDLES) {
    let canExtract = true;
    while (canExtract) {
      canExtract = true;
      for (const c of bundle.components) {
        const found = workPool.find(p => p.sku === c.sku && p.quantity >= c.qty);
        if (!found) { canExtract = false; break; }
      }
      if (canExtract) {
        for (const c of bundle.components) {
          const p = workPool.find(p => p.sku === c.sku && p.quantity >= c.qty)!;
          p.quantity -= c.qty;
        }
        complete.push({ ...bundle, instance: complete.length + 1 });
      }
    }
  }

  const remaining = workPool.filter(p => p.quantity > 0);
  return { complete, remaining };
}

// ── Detecte les bundles INCOMPLETS dans le pool restant ─────────────
function detectIncompleteBundles(remaining: any[]): { incomplete: any[]; standalone: any[] } {
  const incomplete: any[] = [];
  const standalone: any[] = [];
  const workPool = remaining.map(p => ({ ...p }));

  for (const item of workPool) {
    if (item.quantity <= 0) continue;
    let isIncompleteBundle = false;
    for (const bundle of BUNDLES) {
      const compMatch = bundle.components.find(c => c.sku === item.sku);
      if (!compMatch) continue;
      // Le SKU est dans un bundle. Verifier si son prix correspond au prix du bundle parent.
      if (Math.abs(parseFloat(item.price) - bundle.parent_price) < 0.5) {
        // Prix tres proche du prix du bundle parent -> probablement un bundle dont les autres composants sont absents
        const missing = bundle.components.filter(c => c.sku !== item.sku);
        incomplete.push({
          bundle_title: bundle.parent_title,
          bundle_price: bundle.parent_price,
          present_sku: item.sku,
          present_title: bundle.components.find(c => c.sku === item.sku)?.title || item.title,
          missing_components: missing,
          quantity: item.quantity,
        });
        item.quantity = 0;
        isIncompleteBundle = true;
        break;
      }
    }
    if (!isIncompleteBundle && item.quantity > 0) {
      standalone.push(item);
    }
  }

  return { incomplete, standalone };
}

// ── Genere la note de preparation structuree ────────────────────────
function generateNote(orderName: string, groups: { complete: any[]; incomplete: any[]; standalone: any[] }): string {
  const lines: string[] = [];
  lines.push('═══════════════════════════════════════════');
  lines.push(`📦 BON DE PRÉPARATION ${orderName} (auto)`);
  lines.push('═══════════════════════════════════════════');
  lines.push('');

  // Recap au top
  const nbComplete = groups.complete.length;
  const nbIncomplete = groups.incomplete.length;
  const nbStandalone = groups.standalone.reduce((s, i) => s + i.quantity, 0);
  const totalItems = nbComplete * 2 + nbIncomplete + nbStandalone; // approximatif

  lines.push(`📊 RÉCAP : ${nbComplete} ensemble(s) complet(s) · ${nbIncomplete} ensemble(s) à VÉRIFIER · ${nbStandalone} produit(s) seul(s)`);
  lines.push('');

  // Bundles complets
  for (let i = 0; i < groups.complete.length; i++) {
    const b = groups.complete[i];
    lines.push(`✅ ENSEMBLE ${i + 1}/${nbComplete + nbIncomplete} — ${b.parent_title} (${b.parent_price}€)`);
    for (const c of b.components) {
      lines.push(`   ☐ ${c.qty}× ${c.title}`);
      lines.push(`        SKU : ${c.sku}`);
    }
    lines.push('');
  }

  // Bundles incomplets - ALERTE
  if (groups.incomplete.length > 0) {
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('⚠️  ATTENTION — ENSEMBLE(S) INCOMPLET(S) DÉTECTÉ(S)');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    for (const inc of groups.incomplete) {
      lines.push(`⚠️ ${inc.bundle_title} (${inc.bundle_price}€)`);
      lines.push(`   PRÉSENT(S) DANS LA COMMANDE :`);
      lines.push(`     ☐ ${inc.present_title}`);
      lines.push(`         SKU : ${inc.present_sku}`);
      lines.push(`   ⚠️ MANQUANT(S) — À AJOUTER MANUELLEMENT :`);
      for (const m of inc.missing_components) {
        lines.push(`     ⚠️ ${m.qty}× ${m.title}`);
        lines.push(`         SKU : ${m.sku}`);
      }
      lines.push(`   ➜ Cause probable : bug Shopify Bundles (stock 0 ou config)`);
      lines.push(`   ➜ Le client a PAYÉ l'ensemble complet - À EXPÉDIER quand même`);
      lines.push('');
    }
  }

  // Standalone
  if (groups.standalone.length > 0) {
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('📦 PRODUITS HORS ENSEMBLE');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    for (const item of groups.standalone) {
      lines.push(`   ☐ ${item.quantity}× ${item.title}`);
      lines.push(`        SKU : ${item.sku} | Prix : ${item.price}€`);
    }
    lines.push('');
  }

  lines.push('═══════════════════════════════════════════');
  lines.push(`Note générée auto le ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`);
  lines.push('═══════════════════════════════════════════');

  return lines.join('\n');
}

// ── PATCH la note de la commande Shopify ────────────────────────────
async function updateOrderNote(orderId: number | string, note: string): Promise<any> {
  if (!SHOP_DOMAIN || !SHOP_TOKEN) throw new Error('SHOPIFY_STORE_DOMAIN ou SHOPIFY_ACCESS_TOKEN manquant');
  const url = `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/orders/${orderId}.json`;
  const body = JSON.stringify({ order: { id: orderId, note: note } });
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { 'X-Shopify-Access-Token': SHOP_TOKEN, 'Content-Type': 'application/json' },
    body,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Shopify PUT failed ${resp.status}: ${text.substring(0, 300)}`);
  return JSON.parse(text);
}

// ── Webhook handler ─────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  // GET pour healthcheck
  if (req.method === 'GET') {
    return new Response(JSON.stringify({ ok: true, version: 'shopify-order-note v1.0', bundles_loaded: BUNDLES.length }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  try {
    const payload = await req.json();
    const orderId = payload.id;
    const orderName = payload.name || `#${orderId}`;
    const lineItems = payload.line_items || [];

    if (!orderId || !Array.isArray(lineItems) || lineItems.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: 'payload invalide (orderId ou line_items manquants)' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Construire le pool de produits (deduplication par SKU + quantite)
    const pool = lineItems.map((li: any) => ({
      sku: li.sku || '',
      title: li.title || '',
      price: li.price || '0',
      quantity: li.quantity || 1,
      product_id: li.product_id || null,
    }));

    // Etape 1 : Extraire les bundles complets
    const { complete, remaining } = extractCompleteBundles(pool);
    // Etape 2 : Detecter les bundles incomplets dans le reste
    const { incomplete, standalone } = detectIncompleteBundles(remaining);

    // Generer la note
    const note = generateNote(orderName, { complete, incomplete, standalone });

    // PATCH la commande Shopify
    let updateResult: any = null;
    try {
      updateResult = await updateOrderNote(orderId, note);
    } catch (e: any) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'Update Shopify failed: ' + e.message,
        note_preview: note.substring(0, 500),
        orderId, orderName,
      }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({
      ok: true,
      orderId, orderName,
      note_length: note.length,
      bundles_complete: complete.length,
      bundles_incomplete: incomplete.length,
      standalone: standalone.length,
      note_preview: note.substring(0, 800),
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: 'Uncaught: ' + e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
