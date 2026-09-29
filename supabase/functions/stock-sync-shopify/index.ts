// ════════════════════════════════════════════════════════════════════
// Edge Function : stock-sync-shopify (v1 — 29/09/2026)
// ════════════════════════════════════════════════════════════════════
// Aligne la quantité « available » de chaque variante Shopify reliée
// (table stock_correspondance) sur le DISPONIBLE de l'app livraison.
//
// LECTURE SEULE PAR DÉFAUT : sans { apply: true, confirme: "apres-comptage" },
// rien n'est écrit (ni dans Shopify, ni dans la base). Pas de cron pour l'instant.
//
// Réponse : une ligne par variante — Shopify actuel (available / committed / on_hand),
// stock app, disponible app, cible, écart, action.
//
// ── Formule ─────────────────────────────────────────────────────────
//   réservé(produit simple) = somme des qte des lignes des commandes de l'app NI livrées
//       NI annulées (tous canaux : site, Leboncoin, TikTok, SAV…) dont le stock n'a pas
//       encore été déduit (stock_deduit=false), lignes reliées par produitId ; une ligne
//       « ensemble » réserve ses composants (× qte du composant) ;
//     + les commandes Shopify ouvertes PAS ENCORE importées dans l'app (délai de
//       shopify-sync ou commande non payée), via stock_correspondance.
//   disponible(simple)   = stock app − réservé
//   disponible(ensemble) = min( floor(disponible(composant) / qte requise) )
//   cible Shopify « available » = max(0, disponible(produit app relié))
//
// ── Pourquoi il n'y a PAS de double comptage ────────────────────────
//  1. On FIXE une valeur ABSOLUE de « available » (inventorySetQuantities name=available),
//     jamais un +/−. Relancer la fonction 1 fois ou 10 fois donne le même résultat
//     (idempotent) : aucune dérive possible par accumulation.
//  2. Chez Shopify, on_hand = available + committed. Une commande du site non expédiée
//     est comptée par Shopify dans « committed », PAS dans « available ».
//     Dans l'app, cette même commande est « réservée » -> déjà retirée du disponible.
//     On fixe available = disponible app : la commande n'est retirée qu'UNE fois de ce qui
//     reste à vendre (côté app). Shopify garde committed à part et n'enlève rien de plus
//     d'« available » (on_hand devient simplement disponible + committed).
//     La mauvaise formule serait available = disponible_app − committed (commande du site
//     retirée deux fois) ou available = stock_app (autres canaux jamais retirés).
//  3. Les autres canaux (Leboncoin, TikTok, SAV, WhatsApp…) n'existent pas dans Shopify :
//     seule la réservation de l'app les retire du disponible.
//  4. Étiquette GLS (Shopify « fulfilled ») : committed et on_hand baissent, available ne
//     bouge pas. Dans l'app la commande reste réservée jusqu'à « livré », puis le stock
//     est déduit et la réservation disparaît : disponible inchangé. Aucun écart.
//  5. Nouvelle commande du site : Shopify passe 1 unité de available à committed tout seul.
//     Tant qu'elle n'est pas importée, elle est réservée via la liste des commandes
//     Shopify ouvertes non importées (point ci-dessus) -> la synchro ne « rend » pas
//     l'unité à available.
//  6. Bundles Shopify (Pack …) : Shopify calcule leur disponibilité à partir des variantes
//     composants -> on n'écrit JAMAIS sur une variante bundle (seulement sur ses composants).
//
// ── Écriture ({ apply: true, confirme: "apres-comptage" }) ─────────
//  inventorySetQuantities (API 2026-04) : name "available", reason "correction",
//  @idempotent(key) obligatoire, changeFromQuantity = available lu juste avant
//  (compare-and-swap : si une vente arrive entre la lecture et l'écriture, Shopify refuse
//  l'écriture de cette variante -> elle sera corrigée au passage suivant).
//  Options : { variantes: [id, …] } limite aux variantes données.
//
// Appel : serveur uniquement (cron x-cron-secret ou clé secrète sb_secret_).
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { appelInterne, refus } from '../_shared/controle-appelant.ts';
import {
  calculerReservations, disponible, STATUTS_TERMINES,
  type CommandeShopify, type Correspondance, type Produit,
} from '../_shared/stock-logique.ts';

const SHOPIFY_DOMAIN = Deno.env.get('SHOPIFY_STORE_DOMAIN') || '';
const SHOPIFY_TOKEN = Deno.env.get('SHOPIFY_ACCESS_TOKEN') || '';
const SHOPIFY_VERSION = Deno.env.get('SHOPIFY_API_VERSION') || '2026-04';
const SB_URL = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const CONFIRMATION = 'apres-comptage';

const sb = createClient(SB_URL, SB_SR_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const json = (o: any, status = 200) =>
  new Response(JSON.stringify(o, null, 1), { status, headers: { 'Content-Type': 'application/json' } });

const API = () => `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_VERSION}`;

async function gql(query: string, variables: any = {}): Promise<any> {
  const r = await fetch(API() + '/graphql.json', {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (!r.ok || j.errors) throw new Error('Shopify GraphQL : ' + JSON.stringify(j.errors || r.status).slice(0, 400));
  return j.data;
}

async function restCommandes(url: string): Promise<CommandeShopify[]> {
  const out: CommandeShopify[] = [];
  let u: string | null = url;
  for (let page = 0; u && page < 20; page++) {
    const r: Response = await fetch(u, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } });
    if (!r.ok) throw new Error(`Shopify REST ${r.status} : ${(await r.text()).slice(0, 300)}`);
    out.push(...((await r.json()).orders || []));
    const m = (r.headers.get('link') || '').match(/<([^>]+)>;\s*rel="next"/);
    u = m ? m[1] : null;
  }
  return out;
}

type VarianteShopify = {
  id: string; sku: string | null; titre: string; statutProduit: string; bundle: boolean; suivie: boolean;
  inventoryItemId: string; locationId: string | null; nbLocations: number;
  available: number | null; committed: number | null; on_hand: number | null;
};

async function variantesShopify(): Promise<Map<string, VarianteShopify>> {
  const out = new Map<string, VarianteShopify>();
  let cur: string | null = null;
  for (let page = 0; page < 20; page++) {
    const d: any = await gql(`query($cur: String) { productVariants(first: 100, after: $cur) {
      pageInfo { hasNextPage endCursor }
      nodes { legacyResourceId sku title requiresComponents product { title status }
        inventoryItem { id tracked inventoryLevels(first: 5) { nodes { location { id }
          quantities(names: ["available", "committed", "on_hand"]) { name quantity } } } } } } }`, { cur });
    for (const v of d.productVariants.nodes) {
      const niveaux = v.inventoryItem?.inventoryLevels?.nodes || [];
      const q = (n: string) => {
        const x = (niveaux[0]?.quantities || []).find((y: any) => y.name === n);
        return x ? Number(x.quantity) : null;
      };
      out.set(String(v.legacyResourceId), {
        id: String(v.legacyResourceId), sku: v.sku || null,
        titre: v.product.title + (v.title && v.title !== 'Default Title' ? ' — ' + v.title : ''),
        statutProduit: v.product.status, bundle: !!v.requiresComponents, suivie: !!v.inventoryItem?.tracked,
        inventoryItemId: v.inventoryItem?.id, locationId: niveaux[0]?.location?.id || null, nbLocations: niveaux.length,
        available: q('available'), committed: q('committed'), on_hand: q('on_hand'),
      });
    }
    if (!d.productVariants.pageInfo.hasNextPage) break;
    cur = d.productVariants.pageInfo.endCursor;
  }
  return out;
}

async function ecrireAvailable(v: VarianteShopify, cible: number, ref: string): Promise<{ ok: boolean; detail?: string }> {
  const d = await gql(`mutation($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) @idempotent(key: "${crypto.randomUUID()}") {
      userErrors { field message code } } }`, {
    input: {
      name: 'available', reason: 'correction', referenceDocumentUri: ref,
      quantities: [{ inventoryItemId: v.inventoryItemId, locationId: v.locationId, quantity: cible, changeFromQuantity: v.available }],
    },
  });
  const errs = d.inventorySetQuantities?.userErrors || [];
  return errs.length ? { ok: false, detail: errs.map((e: any) => (e.code || '') + ' ' + e.message).join(' ; ') } : { ok: true };
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'OPTIONS' && !appelInterne(req)) return refus();
  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) return json({ ok: false, error: 'SHOPIFY_STORE_DOMAIN / SHOPIFY_ACCESS_TOKEN manquants' }, 500);

  const body: any = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const ecriture = body?.apply === true && body?.confirme === CONFIRMATION;
  const filtre: Set<string> | null = Array.isArray(body?.variantes) && body.variantes.length
    ? new Set(body.variantes.map((x: any) => String(x))) : null;

  try {
    // 1. App : produits, correspondance, commandes
    const [{ data: produits, error: e1 }, { data: corrRows, error: e2 }, { data: ouvertes, error: e3 }, { data: refs, error: e4 }] =
      await Promise.all([
        sb.from('produits').select('id, nom, stock, composants'),
        sb.from('stock_correspondance').select('shopify_variant_id, shopify_sku, libelle, app_produit_id, actif, note'),
        sb.from('commandes').select('id, statut, stock_deduit, ref_marketplace, origine, lignes')
          .not('statut', 'in', '(' + STATUTS_TERMINES.map((s) => `"${s}"`).join(',') + ')'),
        sb.from('commandes').select('ref_marketplace').not('ref_marketplace', 'is', null),
      ]);
    const err = e1 || e2 || e3 || e4;
    if (err) throw new Error('lecture base : ' + err.message);
    const corr: Correspondance = new Map((corrRows || []).filter((r: any) => r.app_produit_id)
      .map((r: any) => [String(r.shopify_variant_id), String(r.app_produit_id)]));
    const refsToutes = new Set<string>((refs || []).map((r: any) => String(r.ref_marketplace)));

    // 2. Shopify : commandes du site encore ouvertes dans l'app (pour relier leurs lignes
    //    importées sans produitId) + commandes Shopify ouvertes (non encore importées ?)
    const idsSite = [...new Set((ouvertes || []).map((c: any) => c.ref_marketplace)
      .filter((r: any) => r && /^\d+$/.test(String(r))).map(String))];
    const shopifyParId = new Map<string, CommandeShopify>();
    for (let i = 0; i < idsSite.length; i += 100) {
      const lot = await restCommandes(`${API()}/orders.json?status=any&limit=250&ids=${idsSite.slice(i, i + 100).join(',')}` +
        '&fields=id,name,cancelled_at,fulfillment_status,line_items');
      for (const o of lot) shopifyParId.set(String(o.id), o);
    }
    const shopifyOuvertes = (await restCommandes(`${API()}/orders.json?status=open&limit=250` +
      '&fields=id,name,cancelled_at,fulfillment_status,financial_status,line_items'))
      .filter((o) => !o.cancelled_at && o.fulfillment_status !== 'fulfilled');

    // 3. Calcul
    const res = calculerReservations(produits as Produit[], ouvertes || [], corr, shopifyParId, shopifyOuvertes, refsToutes);
    const prodMap = new Map((produits as Produit[]).map((p) => [p.id, p]));
    const variantes = await variantesShopify();

    const lignes: any[] = [];
    for (const r of corrRows || []) {
      const vid = String(r.shopify_variant_id);
      if (filtre && !filtre.has(vid)) continue;
      const v = variantes.get(vid);
      const pid = r.app_produit_id ? String(r.app_produit_id) : null;
      const p = pid ? prodMap.get(pid) : undefined;
      const ligne: any = {
        variante: vid, sku: r.shopify_sku, libelle: r.libelle, produit_app: pid,
        shopify: v ? { available: v.available, committed: v.committed, on_hand: v.on_hand } : null,
        stock_app: p ? (p.composants?.length ? 'ensemble' : Number(p.stock) || 0) : null,
        reserve_app: p && !p.composants?.length ? (res.reserve.get(p.id) || 0) : null,
        dispo_app: null, cible: null, ecart: null, action: '',
      };
      if (!r.actif) ligne.action = 'ignorée : produit Shopify inactif';
      else if (!pid || !p) ligne.action = 'ignorée : sans correspondance';
      else if (!v) ligne.action = 'ignorée : variante introuvable sur Shopify';
      else {
        const d = disponible(pid, prodMap, res.reserve);
        ligne.dispo_app = d;
        if (v.bundle) ligne.action = 'ignorée : bundle Shopify (calculé par Shopify depuis ses composants)';
        else if (!v.suivie || !v.locationId || v.available == null) ligne.action = 'ignorée : stock non suivi sur Shopify';
        else if (v.nbLocations > 1) ligne.action = 'ignorée : plusieurs emplacements Shopify';
        else {
          ligne.cible = Math.max(0, d);
          ligne.ecart = ligne.cible - v.available;
          ligne.action = ligne.ecart === 0 ? 'identique' : 'à écrire';
          if (d < 0) ligne.alerte = `SURVENTE : disponible app ${d} (réservé > stock)`;
        }
      }
      if (r.note) ligne.note = r.note;
      lignes.push(ligne);
    }

    // 4. Écriture (seulement sur confirmation explicite après le comptage)
    const ecritures: any[] = [];
    if (ecriture) {
      const ref = `gid://maxiconfort-livraison/StockSync/${new Date().toISOString().replace(/[:.]/g, '-')}`;
      for (const l of lignes.filter((x) => x.action === 'à écrire')) {
        const v = variantes.get(l.variante)!;
        try {
          const r = await ecrireAvailable(v, l.cible, ref);
          l.action = r.ok ? 'écrite' : 'échec écriture';
          ecritures.push({ variante: l.variante, de: v.available, a: l.cible, ok: r.ok, detail: r.detail });
        } catch (e: any) {
          l.action = 'échec écriture';
          ecritures.push({ variante: l.variante, ok: false, detail: e.message });
        }
      }
    }

    const compte = (a: string) => lignes.filter((l) => l.action === a).length;
    return json({
      ok: true,
      mode: ecriture ? 'ECRITURE' : 'lecture seule (rien écrit)',
      ...(body?.apply && !ecriture ? { avertissement: `écriture refusée : il faut { apply: true, confirme: "${CONFIRMATION}" }` } : {}),
      resume: {
        variantes: lignes.length, a_ecrire: compte('à écrire'), identiques: compte('identique'),
        ecrites: compte('écrite'), echecs: compte('échec écriture'),
        ignorees: lignes.filter((l) => l.action.startsWith('ignorée')).length,
        survente: lignes.filter((l) => l.alerte).length,
      },
      reservations: {
        lignes_reliees_par_produitId: res.lignesReliees,
        lignes_reliees_via_shopify: res.lignesResoluesViaShopify,
        lignes_non_reliees: res.lignesNonReliees,            // n'entrent PAS dans le réservé
        commandes_sans_lignes: res.commandesSansLignes,      // ex. SAV « REMBOURSEMENT » (texte libre)
        shopify_non_importees: res.shopifyNonImportees,
        site_expediees_non_livrees: res.siteExpedieesNonLivrees,
      },
      lignes,
      ...(ecriture ? { ecritures } : {}),
    });
  } catch (e: any) {
    return json({ ok: false, error: e.message }, 500);
  }
});
