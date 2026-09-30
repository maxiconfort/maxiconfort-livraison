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
//
// v7 (29/09/2026, PAS ENCORE DÉPLOYÉE — à déployer après le comptage du stock) :
//   (a) lignes[].produitId renseigné d'après la variante Shopify (table
//       stock_correspondance, fiabilite = certaine uniquement) -> les ventes du site déduisent enfin le stock de l'app
//       à la livraison (un ensemble déduit ses composants). Variante non reliée -> null
//       (comportement d'avant).
//   (b) annulations propagées : commande déjà importée puis annulée sur Shopify ->
//       statut 'annulé' + « Annulée sur Shopify le … » dans instr, si elle n'est ni livrée
//       ni annulée. Déjà livrée -> rien n'est modifié, elle est listée (annuleesLivrees).
//       Aucun recrédit de stock côté serveur (stock_deduit=false avant livraison) ; si le
//       stock a déjà été déduit sans livraison -> rien n'est modifié, listée (aTraiter).
//       Une commande annulée n'est plus jamais importée.
//   (c) { dryRun: true, jours?: N } : liste ce qui serait importé / annulé, n'écrit RIEN
//       et ne bouge pas le curseur. { jours: N } élargit la fenêtre (rattrapage).
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { appelInterne, refus } from '../_shared/controle-appelant.ts';
import { mapLignes, decisionAnnulation, correspondanceCertaine, type Correspondance } from '../_shared/stock-logique.ts';

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

// v6.2 (18/06/2026) : choix automatique du transporteur selon la zone de livraison.
// Île-de-France (dép. 75/77/78/91/92/93/94/95) -> livraison RANOU (livreur interne).
// Tout le reste (province, hors France) -> expédition GLS. Règle métier Borhen.
const DEP_IDF = ['75', '77', '78', '91', '92', '93', '94', '95'];
function transporteurPour(addr: any): string {
  const pays = String(addr?.country_code || addr?.country || '').trim().toUpperCase();
  // Hors France métropolitaine -> GLS (jamais RANOU)
  if (pays && pays !== 'FR' && pays !== 'FRANCE') return 'GLS';
  const zip = String(addr?.zip || '').replace(/\s+/g, '');
  const dep = zip.substring(0, 2);
  return DEP_IDF.includes(dep) ? 'RANOU' : 'GLS';
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

// v7 : mapLignes est dans ../_shared/stock-logique.ts (produitId via stock_correspondance)

// v6.5 (19/09/2026) : moyen de paiement manuel « Paiement à la livraison (Île-de-France
// uniquement) » activé sur le site. Ces commandes restent « pending » dans Shopify : il
// faut quand même les importer (sinon jamais livrées), en Espèces / Non payé pour que le
// livreur encaisse (espèces ou CB) à la livraison.
function estPaiementLivraison(o: any): boolean {
  if (o.cancelled_at) return false;
  if (o.financial_status !== 'pending') return false;
  return (o.payment_gateway_names || []).some((g: string) => /livraison/i.test(String(g)));
}

function mapShopifyToCmd(o: any, appId: string, corr: Correspondance) {
  const cod = estPaiementLivraison(o);
  const lignes = mapLignes(o.line_items || [], corr); // v7 : produitId via stock_correspondance
  const produitConcat = lignes.map(l => l.qte + '× ' + l.produit).join(' | ');
  // v6 (18/06/2026) : MONTANT = produits seuls (subtotal_price, APRES remise, HORS frais
  // de port et HORS TVA séparée). AVANT : current_total_price incluait les frais de
  // livraison -> montant gonflé (ex #1030 : 168,90 € total au lieu de 139 € de produits ;
  // #1029 : 541 € port inclus au lieu de 511,10 €). La remise éventuelle est modélisée
  // dans le système de remise globale de l'app (type 'eur') pour rester cohérent si la
  // commande est rouverte/éditée : prix = prix_brut - remise.
  const sousTotal = Number(o.subtotal_price ?? o.current_subtotal_price ?? 0); // produits après remise
  const remiseVal = Number(o.total_discounts ?? 0);                            // remise niveau commande
  const brut = +(sousTotal + remiseVal).toFixed(2);                            // produits avant remise (edit-safe)
  // v6.1 (18/06) : Borhen veut le port COMPTÉ dans le CA. On le stocke dans frais_port
  // (champ dédié, edit-safe côté app) et prix = produits(net) + port. Le port n'est PAS
  // mis dans les lignes produit (sinon il polluerait chargement/stock/facture).
  const port = +Number(o.total_shipping_price_set?.shop_money?.amount ?? o.shipping_lines?.reduce((s: number, l: any) => s + Number(l.price || 0), 0) ?? 0).toFixed(2);
  const prixTotal = +(sousTotal + port).toFixed(2);                            // produits net + frais de port
  return {
    id: appId,                               // v6 : numéro APP (max+1), plus le numéro Shopify
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
    prix: prixTotal,
    prix_brut: brut,
    frais_port: port,
    remise_globale: remiseVal,
    remise_globale_val: remiseVal,
    remise_globale_type: 'eur',
    remise_motif: remiseVal > 0 ? 'Remise site' : '',
    paie: cod ? 'Espèces' : 'Site Maxiconfort',
    stpaie: mapStatutPaie(o.financial_status),
    montant_enc: o.financial_status === 'paid' ? prixTotal : 0,
    // v6.4 (28/08) : pour une expedition province, le champ "Livreur assigne" affiche
    // aussi GLS (avant : vide -> "Non assigne" dans la fiche et "—" dans la liste).
    // IDF : laisse vide, Borhen assigne son livreur interne (RANOU).
    livreur: transporteurPour(o.shipping_address) === 'GLS' ? 'GLS' : '',
    statut: 'en-attente',
    date_livraison: '',  // a planifier par Borhen ensuite
    date_commande: (o.created_at || '').substring(0, 10), // YYYY-MM-DD
    // v6 : on garde le n° Shopify (o.name, ex "#1030") dans l'instruction pour pouvoir
    // recroiser avec l'admin Shopify, puisque l'id app est désormais différent.
    instr: (o.name ? 'Commande site ' + o.name + '. ' : '') +
      (cod ? '💵 PAIEMENT À LA LIVRAISON : ' + prixTotal + ' € à encaisser (espèces ou CB). ' +
        (transporteurPour(o.shipping_address) === 'GLS' ? '⚠️ HORS ÎLE-DE-FRANCE : appeler le client pour un paiement en ligne avant expédition. ' : '') : '') +
      (o.note || '').toString(),
    origine: 'Site Maxiconfort',
    // v6.2 : transporteur auto — IDF -> RANOU, province/étranger -> GLS
    transporteur: transporteurPour(o.shipping_address),
    ref_marketplace: String(o.id), // ID Shopify pour deduper
    updated_at: new Date().toISOString(),
    created_at: o.created_at || new Date().toISOString(),
  };
}

// v7 : renvoie la commande de l'app (ou null) — sert au dédoublonnage ET aux annulations
async function commandeImportee(shopifyId: string): Promise<any | null> {
  const { data, error } = await sb
    .from('commandes')
    .select('id, statut, stock_deduit, instr')
    .eq('ref_marketplace', shopifyId)
    .limit(1);
  if (error) throw new Error('lecture commandes : ' + error.message); // jamais d'import en double sur erreur
  return data && data.length ? data[0] : null;
}

// v7 : correspondance variante Shopify -> produit app (lue une fois par exécution).
// SEULES les correspondances fiabilite='certaine' sont utilisées (30/09) : une correspondance
// incertaine ou absente laisse produitId à null (jamais de déduction sur un produit supposé).
// En cas d'erreur de lecture : Map vide -> produitId null (comportement v6), import non bloqué.
async function chargerCorrespondance(): Promise<{ corr: Correspondance; erreur?: string }> {
  const { data, error } = await sb.from('stock_correspondance')
    .select('shopify_variant_id, app_produit_id, fiabilite').eq('fiabilite', 'certaine');
  if (error) return { corr: new Map(), erreur: error.message };
  return { corr: correspondanceCertaine(data || []) };
}

// v7 : toutes les pages (en-tête Link rel="next") — la v6 s'arrêtait à 250 commandes
async function commandesShopify(url: string): Promise<any[]> {
  const out: any[] = [];
  let u: string | null = url;
  for (let page = 0; u && page < 20; page++) {
    const r: Response = await fetch(u, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`Shopify HTTP ${r.status} : ${(await r.text()).slice(0, 300)}`);
    out.push(...(((await r.json()).orders) || []));
    const m = (r.headers.get('link') || '').match(/<([^>]+)>;\s*rel="next"/);
    u = m ? m[1] : null;
  }
  return out;
}

// v6 (18/06/2026) : prochain numéro de commande APP = max(numéros existants) + 1.
// AVANT : la commande importée reprenait le numéro Shopify (o.name, ex "#1030") comme id
// -> ce numéro tombe dans la plage des commandes de l'app (saisies LeBonCoin) et
// l'upsert onConflict:'id' ÉCRASAIT la commande existante portant ce numéro (collision
// imminente : Shopify ~#1030 approchait des saisies manuelles qui démarrent à #1047).
// Désormais l'import prend le prochain numéro libre de l'app (comme une saisie manuelle).
// Les #SAV... (parseInt -> NaN) sont ignorés. ref_marketplace=ID Shopify reste la clé de
// déduplication (donc pas de ré-import en double malgré le changement d'id).
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

// ── Handler ────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  // 27/09/2026 : controle d'appelant (crons = x-cron-secret ; fonctions/scripts serveur = cle secrete sb_secret_)
  if (req.method !== 'OPTIONS' && !appelInterne(req)) return refus();
  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) {
    return new Response(JSON.stringify({
      error: 'Configuration manquante : SHOPIFY_STORE_DOMAIN / SHOPIFY_ACCESS_TOKEN'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  const startTime = Date.now();
  const result = {
    imported: 0, skipped: 0, errors: 0, errorDetails: [] as string[],
    // v7
    lignesImportees: 0, lignesAvecProduitId: 0,
    lignesSansCorrespondance: [] as string[],           // « #1164 : Ensemble … — Blanc »
    annulees: [] as string[],                           // commandes app passées en 'annulé'
    annuleesLivrees: [] as string[],                    // annulées sur Shopify mais déjà livrées : rien modifié
    aTraiter: [] as string[],                           // stock déjà déduit sans livraison : rien modifié
    correspondanceErreur: undefined as string | undefined,
  };
  const body: any = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const dryRun = body?.dryRun === true;
  const jours = Number(body?.jours) > 0 ? Math.min(Number(body.jours), 90) : 0;

  // v6.3 : mode DIAGNOSTIC — { diag: true, heures?: 72 } liste TOUTES les commandes
  // Shopify de la periode (sans filtre financial_status) avec leur statut de paiement et
  // leur presence en base. N'importe RIEN, ne touche pas au curseur. Sert a repondre a
  // « telle commande du site n'est pas remontee » : on voit si elle est juste non payee.
  try {
    if (body?.diag) {
      const heures = Number(body.heures) > 0 ? Number(body.heures) : 72;
      const depuis = new Date(Date.now() - heures * 3600 * 1000).toISOString();
      const urlD = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_VERSION}/orders.json` +
        `?created_at_min=${encodeURIComponent(depuis)}&status=any&limit=250`;
      const rD = await fetch(urlD, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Accept': 'application/json' } });
      if (!rD.ok) {
        return new Response(JSON.stringify({ diag: true, error: `Shopify HTTP ${rD.status}`, detail: (await rD.text()).slice(0, 300) }),
          { headers: { 'Content-Type': 'application/json' } });
      }
      const ordersD = (await rD.json()).orders || [];
      const lignes: any[] = [];
      for (const o of ordersD) {
        const { data: enBase } = await sb.from('commandes').select('id').eq('ref_marketplace', String(o.id)).maybeSingle();
        lignes.push({
          shopify: o.name, client: `${o.customer?.first_name || ''} ${o.customer?.last_name || ''}`.trim(),
          total: o.current_total_price, paiement: o.financial_status, cree: o.created_at,
          en_base: enBase ? enBase.id : 'NON IMPORTEE',
        });
      }
      return new Response(JSON.stringify({ diag: true, heures, total: ordersD.length, commandes: lignes }, null, 2),
        { headers: { 'Content-Type': 'application/json' } });
    }
  } catch (_e) { /* mode normal */ }

  try {
    // 1. Date de derniere sync (v7 : { jours: N } -> fenêtre élargie, rattrapage / test)
    const sinceIso = jours ? new Date(Date.now() - jours * 86400000).toISOString() : await getLastSync();
    const { corr, erreur: errCorr } = await chargerCorrespondance();
    if (errCorr) result.correspondanceErreur = errCorr;

    // 2. Appeler Shopify
    // Filtres :
    //   - updated_at_min : on prend aussi les commandes dont le statut a change
    //     (ex: pending devenu paid plus tard)
    //   - uniquement les commandes payees (regle metier Borhen) + les commandes en
    //     paiement a la livraison (v6.5, filtre dans la boucle)
    //   - status=any : ne pas filtrer par statut de fulfillment
    const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_VERSION}/orders.json` +
      `?updated_at_min=${encodeURIComponent(sinceIso)}` +
      `&financial_status=any` +
      `&status=any&limit=250`;

    let orders: any[];
    try {
      orders = await commandesShopify(url);
    } catch (e: any) {
      return new Response(JSON.stringify({ error: 'Shopify API error', detail: e.message }),
        { status: 502, headers: { 'Content-Type': 'application/json' } });
    }

    // v6 : numérotation APP (max+1) pour les imports -> plus de collision/écrasement.
    // On lit le max UNE fois, puis on incrémente localement pour chaque NOUVELLE commande.
    let prochainNum = (await maxNumeroCommande()) + 1;
    const aImporter: string[] = []; // dryRun : ce qui serait importé

    // 3. Pour chaque commande, mapper + upsert si pas deja en BD
    for (const o of orders) {
      try {
        const shopifyId = String(o.id);
        const enBase = await commandeImportee(shopifyId);

        // v7 (b) : propagation des annulations (AVANT le filtre de paiement : une commande
        // annulée passe en « refunded/voided » et était ignorée par la v6).
        if (o.cancelled_at) {
          result.skipped++;
          if (!enBase) continue; // annulée avant import : on ne l'importe jamais
          const d = decisionAnnulation(o, enBase);
          const lib = `${enBase.id} (site ${o.name})`;
          if (d.action === 'deja-livree') result.annuleesLivrees.push(lib);
          else if (d.action === 'stock-deja-deduit') result.aTraiter.push(lib + ' : stock déjà déduit, à recréditer dans l\'app');
          else if (d.action === 'annuler') {
            if (!dryRun) {
              const { error } = await sb.from('commandes')
                .update({ statut: 'annulé', instr: d.instr, updated_at: new Date().toISOString() })
                .eq('id', enBase.id).not('statut', 'in', '("livré","annulé")'); // garde : jamais une livrée
              if (error) { result.errors++; result.errorDetails.push(`${o.name}: annulation : ${error.message}`); continue; }
            }
            result.annulees.push(lib + ' — annulée sur Shopify le ' + String(o.cancelled_at).slice(0, 10));
          }
          continue;
        }

        if (o.financial_status !== 'paid' && !estPaiementLivraison(o)) {
          result.skipped++;
          continue;
        }
        if (enBase) {
          result.skipped++;
          continue;
        }
        const cmd = mapShopifyToCmd(o, '#' + (prochainNum++), corr);
        for (const l of cmd.lignes) {
          result.lignesImportees++;
          if (l.produitId) result.lignesAvecProduitId++;
          else result.lignesSansCorrespondance.push(`${o.name} : ${l.produit}`);
        }
        if (dryRun) {
          aImporter.push(`${o.name} -> ${cmd.id} : ` + cmd.lignes.map((l: any) => `${l.qte}× ${l.produit} [${l.produitId || 'sans produitId'}]`).join(' | '));
          result.imported++;
          continue;
        }
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

    // 4. Mettre a jour le timestamp de derniere sync (jamais en dryRun ni en rattrapage)
    //    v7 : heure de DÉBUT d'exécution -> une commande modifiée pendant l'exécution
    //    sera revue au passage suivant (la v6 prenait l'heure de fin).
    if (!dryRun && !jours) await setLastSync(new Date(startTime).toISOString());

    return new Response(JSON.stringify({
      ...result,
      ...(dryRun ? { dryRun: true, aImporter } : {}),
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
