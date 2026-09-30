// ════════════════════════════════════════════════════════════════════
// Edge Function : stock-sync-shopify (v2 — 30/09/2026)
// ════════════════════════════════════════════════════════════════════
// Aligne la quantité « available » des variantes Shopify reliées de façon CERTAINE
// (table stock_correspondance, fiabilite = 'certaine') sur le DISPONIBLE calculé à partir
// d'un COMPTAGE horodaté (tables stock_comptage*). LECTURE SEULE PAR DÉFAUT. Pas de cron.
//
// ── Modèle par événements (recalculé entièrement à chaque passage -> idempotent) ─────
//  On n'utilise PLUS produits.stock : il est modifié par le navigateur à la livraison,
//  alors que gls-sync passe des commandes « livré » côté serveur sans déduction (dérive,
//  risque de double déduction).
//   disponible(simple)   = compté − Σ qte des commandes NON annulées qui consomment le stock
//                          compté (toutes sauf 'sortie_avant', y compris celles créées après
//                          le comptage et les commandes Shopify pas encore importées)
//                          + entrées après la fin du comptage (table stock_entrees)
//   disponible(ensemble) = min(disponible composant / qte) — TOUS les composants comptés et
//                          reliés 'certaine', sinon exclu
//   proposé Shopify « available » = max(0, disponible)
//  Instantané à la validation (stock_comptage_commandes) : sortie_avant / dans_stock /
//  a_verifier (mouvement entre debut et fin -> produits concernés exclus jusqu'à décision).
//
// ── Pourquoi il n'y a PAS de double comptage ──────────────────────────
//  1. Valeur ABSOLUE de « available » (inventorySetQuantities), jamais un +/− : relancer
//     donne le même résultat.
//  2. Shopify : on_hand = available + committed. Une commande du site non expédiée est dans
//     « committed » chez Shopify ET consommée dans notre calcul. On fixe available =
//     disponible (qui l'a déjà retirée) : elle n'est retirée qu'UNE fois de ce qui reste à
//     vendre ; Shopify garde committed à part. (available = disponible − committed la
//     retirerait deux fois.)
//  3. Les autres canaux (Leboncoin, TikTok, SAV…) n'existent que dans l'app : seule notre
//     somme les retire.
//  4. Étiquette GLS (« fulfilled » chez Shopify, qui n'est PAS une expédition) : committed et
//     on_hand baissent chez Shopify, available ne bouge pas ; notre somme est inchangée.
//  5. Une commande = une ligne (dédoublonnage par id, index unique 026 sur ref_marketplace).
//
// ── Modes (body JSON) ─────────────────────────────────────────────────
//   {}                                   lecture : dernier comptage validé (ou aucun)
//   { comptage_id }                      lecture sur ce comptage (brouillon = aperçu,
//                                        instantané calculé à la volée, non figé)
//   { simulation: { debut, fin } }       lecture : SIMULATION avec produits.stock en guise de
//                                        comptage (pour tester la chaîne, jamais d'écriture)
//   { apercu_comptage: id }              classement des commandes pour ce comptage, rien écrit
//   { valider_comptage: id, confirme: "valider" }
//                                        fige l'instantané et passe le comptage en 'valide'
//   { apply: true, confirme: "apres-comptage", comptage_id }
//                                        sauvegarde les valeurs Shopify (stock_sauvegarde_shopify)
//                                        puis écrit SEULEMENT les variantes 'certaine' non exclues
//   { restaurer: "<lot>", confirme: "restaurer" }
//                                        remet les valeurs sauvegardées d'un lot
//   { alertes: false }                   n'insère pas d'alerte (gls_alertes)
// Appel : serveur uniquement (x-cron-secret ou clé secrète sb_secret_).
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { appelInterne, refus } from '../_shared/controle-appelant.ts';
import { suivreColisGLS } from '../_shared/gls-suivi.ts';
import { analyserColis, colisErreur, numerosColis } from '../_shared/gls-analyse.ts';
import {
  calculerStock, classerCommande, correspondanceCertaine, evaluerProduit, jourParis, produitsCertains,
  type ColisSuivi, type CommandeCalc, type CommandeShopify, type InfoClassement, type LigneCorrespondance,
  type Produit, type Situation,
} from '../_shared/stock-logique.ts';

const SHOPIFY_DOMAIN = Deno.env.get('SHOPIFY_STORE_DOMAIN') || '';
const SHOPIFY_TOKEN = Deno.env.get('SHOPIFY_ACCESS_TOKEN') || '';
const SHOPIFY_VERSION = Deno.env.get('SHOPIFY_API_VERSION') || '2026-04';
const SB_URL = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const sb = createClient(SB_URL, SB_SR_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const json = (o: any, status = 200) =>
  new Response(JSON.stringify(o, null, 1), { status, headers: { 'Content-Type': 'application/json' } });
const API = () => `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_VERSION}`;

// ── Accès données ─────────────────────────────────────────────────────
async function tout(table: string, select: string, filtre?: (q: any) => any): Promise<any[]> {
  const out: any[] = [];
  for (let de = 0; ; de += 1000) {
    let q = sb.from(table).select(select).order(select.split(',')[0].trim()).range(de, de + 999);
    if (filtre) q = filtre(q);
    const { data, error } = await q;
    if (error) throw new Error(`lecture ${table} : ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

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
  id: string; bundle: boolean; suivie: boolean; inventoryItemId: string; locationId: string | null; nbLocations: number;
  available: number | null; committed: number | null; on_hand: number | null;
};

async function variantesShopify(): Promise<Map<string, VarianteShopify>> {
  const out = new Map<string, VarianteShopify>();
  let cur: string | null = null;
  for (let page = 0; page < 20; page++) {
    const d: any = await gql(`query($cur: String) { productVariants(first: 100, after: $cur) {
      pageInfo { hasNextPage endCursor }
      nodes { legacyResourceId requiresComponents
        inventoryItem { id tracked inventoryLevels(first: 5) { nodes { location { id }
          quantities(names: ["available", "committed", "on_hand"]) { name quantity } } } } } } }`, { cur });
    for (const v of d.productVariants.nodes) {
      const niveaux = v.inventoryItem?.inventoryLevels?.nodes || [];
      const q = (n: string) => {
        const x = (niveaux[0]?.quantities || []).find((y: any) => y.name === n);
        return x ? Number(x.quantity) : null;
      };
      out.set(String(v.legacyResourceId), {
        id: String(v.legacyResourceId), bundle: !!v.requiresComponents, suivie: !!v.inventoryItem?.tracked,
        inventoryItemId: v.inventoryItem?.id, locationId: niveaux[0]?.location?.id || null, nbLocations: niveaux.length,
        available: q('available'), committed: q('committed'), on_hand: q('on_hand'),
      });
    }
    if (!d.productVariants.pageInfo.hasNextPage) break;
    cur = d.productVariants.pageInfo.endCursor;
  }
  return out;
}

async function setAvailable(inventoryItemId: string, locationId: string, quantite: number, depuis: number | null, ref: string) {
  const d = await gql(`mutation($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) @idempotent(key: "${crypto.randomUUID()}") {
      userErrors { field message code } } }`, {
    input: {
      name: 'available', reason: 'correction', referenceDocumentUri: ref,
      // compare-and-swap : si une vente arrive entre la lecture et l'écriture, Shopify refuse
      quantities: [{ inventoryItemId, locationId, quantity: quantite, changeFromQuantity: depuis }],
    },
  });
  const errs = d.inventorySetQuantities?.userErrors || [];
  return errs.length ? { ok: false, detail: errs.map((e: any) => (e.code || '') + ' ' + e.message).join(' ; ') } : { ok: true };
}

// ── Alertes (table gls_alertes, anti-doublon par (type, cle) quel que soit le jour) ───
type Alerte = { type: string; cle: string; cmd_id?: string | null; message: string };
async function enregistrerAlertes(alertes: Alerte[], actif: boolean) {
  const uniques = [...new Map(alertes.map((a) => [a.type + '|' + a.cle, a])).values()];
  if (!actif || !uniques.length) return { nouvelles: 0, existantes: 0, liste: uniques, inserees: [] as string[] };
  const existantes = await tout('gls_alertes', 'cle, type', (q) => q.like('type', 'stock-%'));
  const deja = new Set(existantes.map((r: any) => r.type + '|' + r.cle));
  const nouv = uniques.filter((a) => !deja.has(a.type + '|' + a.cle));
  const jour = jourParis(new Date().toISOString());
  if (nouv.length) {
    const { error } = await sb.from('gls_alertes').insert(nouv.map((a) => ({
      type: a.type, cle: a.cle, jour, cmd_id: a.cmd_id || null, message: a.message.slice(0, 900), envoye: false,
    })));
    if (error) throw new Error('alertes : ' + error.message);
  }
  return { nouvelles: nouv.length, existantes: uniques.length - nouv.length, liste: uniques, inserees: nouv.map((a) => a.type + ' ' + a.cle) };
}
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);

// ── Instantané : classement de toutes les commandes pour un comptage ──
async function suiviGLS(tracking: string): Promise<{ erreur?: string | null; colis: ColisSuivi[] }> {
  const ids = numerosColis(tracking);
  if (!ids.length) return { erreur: 'aucun numéro de colis', colis: [] };
  const colis: ColisSuivi[] = [];
  for (const id of ids) {
    const r = await suivreColisGLS(id);
    const a = r.ok ? analyserColis(id, r.data) : colisErreur(id, r.erreur || 'erreur API GLS');
    colis.push({ trackId: id, etat: a.etat, priseEnChargeAt: a.priseEnChargeAt, livreClientAt: a.livreClientAt, retourAt: a.retourAt, livreExpediteurAt: a.livreExpediteurAt });
  }
  return { erreur: colis.some((k) => k.etat === 'erreur') ? 'erreur API GLS' : null, colis };
}

async function construireInstantane(debut: string, fin: string) {
  const commandes = await tout('commandes', 'id, statut, transporteur, tracking_transporteur, date_livraison, updated_at, created_at');
  const mvts = await tout('mouvements_stock', 'id, commande_id, type, date_mouvement', (q) => q.in('type', ['chargement', 'retour_depot']));
  const parCmd = new Map<string, { type: string; date: string }[]>();
  for (const m of mvts) {
    if (!m.commande_id) continue;
    parCmd.set(m.commande_id, [...(parCmd.get(m.commande_id) || []), { type: m.type, date: m.date_mouvement }]);
  }
  const jD = jourParis(debut);
  const F = Date.parse(fin);
  // Suivi GLS seulement quand il peut changer la conclusion (pas pour une livraison
  // antérieure au jour du comptage, ni pour une commande créée après la fin).
  const aSuivre = commandes.filter((c: any) => c.transporteur === 'GLS' && c.tracking_transporteur && c.statut !== 'annulé'
    && !(c.statut === 'livré' && String(c.date_livraison || '').slice(0, 10) < jD && /^\d{4}-/.test(String(c.date_livraison || '')))
    && !(Date.parse(c.created_at) > F));
  const gls = new Map<string, any>();
  const file = [...aSuivre];
  await Promise.all([1, 2, 3, 4].map(async () => {
    while (file.length) { const c: any = file.shift(); gls.set(c.id, await suiviGLS(c.tracking_transporteur)); }
  }));
  const lignes: { cmd_id: string; situation: Situation; motif: string }[] = [];
  for (const c of commandes) {
    const info: InfoClassement = {
      id: c.id, statut: c.statut, date_livraison: c.date_livraison, updated_at: c.updated_at,
      gls: gls.get(c.id) || null, mouvements: parCmd.get(c.id) || [],
    };
    const k = classerCommande(info, debut, fin);
    if (k.situation !== 'annulee') lignes.push({ cmd_id: c.id, situation: k.situation, motif: k.motif });
  }
  return { lignes, nbSuivisGLS: aSuivre.length, mouvements: mvts };
}

// ── Handler ───────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method !== 'OPTIONS' && !appelInterne(req)) return refus();
  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) return json({ ok: false, error: 'SHOPIFY_STORE_DOMAIN / SHOPIFY_ACCESS_TOKEN manquants' }, 500);
  const body: any = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const alertesActives = body?.alertes !== false;

  try {
    // ── Restauration d'un lot sauvegardé ──
    if (body?.restaurer) {
      if (body.confirme !== 'restaurer') return json({ ok: false, error: 'restauration refusée : il faut { restaurer: "<lot>", confirme: "restaurer" }' }, 400);
      const { data: sauv, error } = await sb.from('stock_sauvegarde_shopify').select('*').eq('lot', String(body.restaurer));
      if (error) throw new Error(error.message);
      if (!sauv?.length) return json({ ok: false, error: 'lot inconnu' }, 404);
      const actuelles = await variantesShopify();
      const ref = `gid://maxiconfort-livraison/StockRestauration/${String(body.restaurer).replace(/[^A-Za-z0-9-]/g, '-')}`;
      const res: any[] = [];
      for (const s of sauv) {
        const v = actuelles.get(String(s.shopify_variant_id));
        if (!v || v.available == null || s.available == null) { res.push({ variante: s.shopify_variant_id, ok: false, detail: 'variante ou valeur absente' }); continue; }
        const r = await setAvailable(s.inventory_item_id, s.location_id, s.available, v.available, ref);
        res.push({ variante: s.shopify_variant_id, de: v.available, a: s.available, ...r });
      }
      return json({ ok: true, mode: 'RESTAURATION', lot: body.restaurer, resultats: res });
    }

    // ── Aperçu / validation d'un comptage ──
    const idC = body?.valider_comptage ?? body?.apercu_comptage;
    if (idC != null) {
      const { data: comp, error } = await sb.from('stock_comptage').select('*').eq('id', Number(idC)).maybeSingle();
      if (error || !comp) return json({ ok: false, error: 'comptage introuvable' }, 404);
      const valider = body.valider_comptage != null;
      if (valider) {
        if (body.confirme !== 'valider') return json({ ok: false, error: 'validation refusée : il faut { valider_comptage: id, confirme: "valider" }' }, 400);
        if (comp.statut !== 'brouillon') return json({ ok: false, error: 'comptage déjà validé' }, 400);
        if (Date.parse(comp.fin) > Date.now()) return json({ ok: false, error: 'la fin du comptage est dans le futur' }, 400);
        const { count } = await sb.from('stock_comptage_lignes').select('*', { count: 'exact', head: true }).eq('comptage_id', comp.id);
        if (!count) return json({ ok: false, error: 'aucune ligne de comptage saisie' }, 400);
      }
      const inst = await construireInstantane(comp.debut, comp.fin);
      const aVerif = inst.lignes.filter((l) => l.situation === 'a_verifier');
      if (valider) {
        const { error: eDel } = await sb.from('stock_comptage_commandes').delete().eq('comptage_id', comp.id);
        if (eDel) throw new Error(eDel.message);
        for (let i = 0; i < inst.lignes.length; i += 500) {
          const { error: eIns } = await sb.from('stock_comptage_commandes')
            .insert(inst.lignes.slice(i, i + 500).map((l) => ({ comptage_id: comp.id, ...l })));
          if (eIns) throw new Error('instantané : ' + eIns.message);
        }
        const { error: eUp } = await sb.from('stock_comptage').update({ statut: 'valide', valide_at: new Date().toISOString() }).eq('id', comp.id);
        if (eUp) throw new Error(eUp.message);
        await enregistrerAlertes(aVerif.map((l) => ({
          type: 'stock-comptage', cle: `c${comp.id}-${l.cmd_id}`, cmd_id: l.cmd_id,
          message: `Comptage ${comp.id} : commande ${l.cmd_id} à vérifier (${l.motif}). Produits exclus de l'écriture jusqu'à décision.`,
        })), alertesActives);
      }
      const nb = (s: string) => inst.lignes.filter((l) => l.situation === s).length;
      return json({
        ok: true, mode: valider ? 'VALIDATION (instantané figé)' : 'aperçu (rien écrit)', comptage: comp.id,
        debut: comp.debut, fin: comp.fin, suivis_gls: inst.nbSuivisGLS,
        resume: { sortie_avant: nb('sortie_avant'), dans_stock: nb('dans_stock'), a_verifier: nb('a_verifier') },
        a_verifier: aVerif,
        dans_stock: inst.lignes.filter((l) => l.situation === 'dans_stock'),
      });
    }

    // ── Calcul (lecture), puis écriture éventuelle ──
    const [produits, corrRows, commandes, entrees] = await Promise.all([
      tout('produits', 'id, nom, stock, composants'),
      tout('stock_correspondance', 'shopify_variant_id, shopify_sku, libelle, app_produit_id, actif, fiabilite, motif'),
      tout('commandes', 'id, statut, ref_marketplace, origine, lignes, gls_livraison_etat, created_at'),
      tout('stock_entrees', 'id, app_produit_id, quantite, date_entree, motif'),
    ]);
    const prodMap = new Map((produits as Produit[]).map((p) => [p.id, p]));
    const corr = correspondanceCertaine(corrRows);
    const corrToutes = new Map<string, LigneCorrespondance>(corrRows.map((r: any) => [String(r.shopify_variant_id), r]));
    const certains = produitsCertains(corrRows);

    // Comptage de référence
    let comptage: any = null;
    let source = 'aucun comptage';
    let comptees = new Map<string, number>();
    let instantane = new Map<string, Situation>();
    let mouvements: any[] = [];
    let instResume: any = null; // simulation / brouillon : classement calculé à la volée
    const resumer = (l: any[]) => ({ sortie_avant: l.filter((x) => x.situation === 'sortie_avant').length, dans_stock: l.filter((x) => x.situation === 'dans_stock').length, a_verifier: l.filter((x) => x.situation === 'a_verifier') });
    if (body?.simulation?.debut && body?.simulation?.fin) {
      comptage = { id: null, debut: body.simulation.debut, fin: body.simulation.fin, statut: 'simulation' };
      source = 'SIMULATION : quantités = produits.stock actuel (PAS un comptage), instantané calculé à la volée';
      for (const p of produits as Produit[]) if (!p.composants?.length) comptees.set(p.id, Number(p.stock) || 0);
      const inst = await construireInstantane(comptage.debut, comptage.fin);
      instantane = new Map(inst.lignes.map((l) => [l.cmd_id, l.situation]));
      mouvements = inst.mouvements;
      instResume = resumer(inst.lignes);
    } else {
      const q = body?.comptage_id != null
        ? sb.from('stock_comptage').select('*').eq('id', Number(body.comptage_id)).maybeSingle()
        : sb.from('stock_comptage').select('*').eq('statut', 'valide').order('fin', { ascending: false }).limit(1).maybeSingle();
      const { data: c } = await q;
      if (c) {
        comptage = c;
        const lignes = await tout('stock_comptage_lignes', 'app_produit_id, quantite', (x) => x.eq('comptage_id', c.id));
        comptees = new Map(lignes.map((l: any) => [l.app_produit_id, Number(l.quantite)]));
        if (c.statut === 'valide') {
          source = `comptage ${c.id} validé`;
          const inst = await tout('stock_comptage_commandes', 'cmd_id, situation', (x) => x.eq('comptage_id', c.id));
          instantane = new Map(inst.map((l: any) => [l.cmd_id, l.situation]));
        } else {
          source = `comptage ${c.id} BROUILLON : instantané calculé à la volée (non figé)`;
          const inst = await construireInstantane(c.debut, c.fin);
          instantane = new Map(inst.lignes.map((l) => [l.cmd_id, l.situation]));
          instResume = resumer(inst.lignes);
        }
        mouvements = await tout('mouvements_stock', 'id, commande_id, type, date_mouvement', (x) => x.eq('type', 'retour_depot'));
      } else {
        // Aucun comptage : seules les commandes ni livrées ni annulées consomment (information)
        for (const c of commandes) if (c.statut === 'livré') instantane.set(c.id, 'sortie_avant');
      }
    }

    // Commandes du site encore consommatrices : relier leurs lignes via Shopify
    const idsSite = [...new Set(commandes.filter((c: any) => c.statut !== 'annulé' && instantane.get(c.id) !== 'sortie_avant'
      && /^\d+$/.test(String(c.ref_marketplace || ''))).map((c: any) => String(c.ref_marketplace)))];
    const shopifyParId = new Map<string, CommandeShopify>();
    for (let i = 0; i < idsSite.length; i += 100) {
      for (const o of await restCommandes(`${API()}/orders.json?status=any&limit=250&ids=${idsSite.slice(i, i + 100).join(',')}` +
        '&fields=id,name,cancelled_at,fulfillment_status,line_items')) shopifyParId.set(String(o.id), o);
    }
    // Commandes Shopify ouvertes pas encore importées (délai d'import, non payées) : elles
    // consomment aussi (Shopify les a déjà en « committed »).
    const refsApp = new Set(commandes.map((c: any) => String(c.ref_marketplace || '')));
    const nonImportees = (await restCommandes(`${API()}/orders.json?status=open&limit=250&fields=id,name,cancelled_at,fulfillment_status,line_items`))
      .filter((o) => !o.cancelled_at && o.fulfillment_status !== 'fulfilled' && !refsApp.has(String(o.id)));
    const pseudo: CommandeCalc[] = nonImportees.map((o) => ({
      id: 'shopify ' + (o.name || o.id), statut: 'en-attente', ref_marketplace: null,
      lignes: (o.line_items || []).filter((li) => (Number(li.fulfillable_quantity ?? li.quantity) || 0) > 0).map((li) => ({
        produitId: li.variant_id != null ? (corr.get(String(li.variant_id)) || null) : null,
        produit: (li.title || '') + (li.variant_title ? ' — ' + li.variant_title : ''),
        qte: Number(li.fulfillable_quantity ?? li.quantity) || 1,
      })),
    }));

    const F = comptage ? Date.parse(comptage.fin) : NaN;
    const retoursCamionApresFin = new Set<string>(mouvements.filter((m: any) => m.type === 'retour_depot' && Date.parse(m.date_mouvement) > F)
      .map((m: any) => m.commande_id).filter(Boolean));
    const r = calculerStock({
      produits: produits as Produit[], comptageFin: comptage ? comptage.fin : new Date(0).toISOString(),
      instantane, commandes: [...commandes, ...pseudo], corr, corrToutes, shopifyParId,
      entrees: comptage ? entrees : [], retoursCamionApresFin,
    });

    // Évaluation par variante
    const variantes = await variantesShopify();
    const alertes: Alerte[] = [];
    const lignes: any[] = [];
    for (const row of corrRows) {
      const vid = String(row.shopify_variant_id);
      const v = variantes.get(vid);
      const pid = row.app_produit_id ? String(row.app_produit_id) : null;
      const out: any = {
        variante: vid, sku: row.shopify_sku, libelle: row.libelle, actif: row.actif,
        fiabilite: row.fiabilite, motif: row.motif, produit_app: pid,
        shopify: v ? { available: v.available, committed: v.committed, on_hand: v.on_hand } : null,
        type: v?.bundle ? 'bundle Shopify' : null, compte: null, reservations_restantes: null, entrees: null,
        disponible: null, propose: null, ecart: null, ecriture: 'non', exclusions: [] as string[],
      };
      if (!row.actif) { out.exclusions.push('produit Shopify inactif'); lignes.push(out); continue; }
      if (row.fiabilite !== 'certaine') {
        out.exclusions.push(`correspondance ${row.fiabilite}${row.motif ? ' : ' + row.motif : ''}`);
        alertes.push({ type: 'stock-correspondance', cle: `variante-${vid}`,
          message: `Variante Shopify « ${row.libelle} »${row.shopify_sku ? ' (' + row.shopify_sku + ')' : ''} : correspondance ${row.fiabilite}${row.motif ? ' — ' + row.motif : ''}. Exclue de l'écriture automatique du stock.` });
      }
      if (pid && prodMap.has(pid)) {
        const e = evaluerProduit(pid, prodMap, comptees, r, certains);
        if (!out.type) out.type = e.type;
        out.compte = e.compte; out.reservations_restantes = e.type === 'simple' ? e.consomme : null;
        out.entrees = e.type === 'simple' ? e.entrees : null; out.disponible = e.disponible;
        if (e.composants) out.composants = e.composants;
        if (comptage) out.exclusions.push(...e.exclusions);
        if (row.fiabilite === 'certaine' && e.type === 'ensemble' && e.composants?.some((k) => !k.certain || k.exclusions.some((x) => x.includes('absent')))) {
          alertes.push({ type: 'stock-correspondance', cle: `composants-${pid}`,
            message: `Ensemble app ${pid} (variante « ${row.libelle} ») : composant(s) sans correspondance certaine ou absent(s) — ${e.composants.filter((k) => !k.certain).map((k) => k.id).join(', ')}. Exclu de l'écriture automatique.` });
        }
      } else if (pid) out.exclusions.push('produit app introuvable');
      if (!comptage) out.exclusions.push('aucun comptage : disponible non calculé');
      if (!v) out.exclusions.push('variante introuvable sur Shopify');
      else if (v.bundle) out.exclusions.push('bundle Shopify : calculé par Shopify depuis ses composants (jamais écrit)');
      else if (!v.suivie || !v.locationId || v.available == null) out.exclusions.push('stock non suivi sur Shopify');
      else if (v.nbLocations > 1) out.exclusions.push('plusieurs emplacements Shopify');
      if (out.disponible !== null && comptage) {
        out.propose = Math.max(0, out.disponible);
        if (v?.available != null) out.ecart = out.propose - v.available;
        if (out.disponible < 0) {
          out.alerte = `SURVENTE : disponible ${out.disponible}`;
          if (comptage.id) alertes.push({ type: 'stock-survente', cle: `c${comptage.id}-${vid}`, message: `Comptage ${comptage.id} : « ${row.libelle} » disponible ${out.disponible} (plus de commandes que de stock compté).` });
        }
      }
      if (!out.exclusions.length && out.propose !== null) out.ecriture = out.ecart === 0 ? 'identique' : 'oui';
      lignes.push(out);
    }
    for (const l of r.lignesNonReconnues) {
      alertes.push({ type: 'stock-ligne', cle: `ligne-${l.cmd}-${slug(l.produit)}`, cmd_id: l.cmd.startsWith('shopify ') ? null : l.cmd,
        message: `Commande ${l.cmd} : ligne « ${l.produit} » ×${l.qte} non reconnue (${l.raison}). Non déduite du stock.` });
    }
    if (comptage?.id) {
      for (const x of r.retoursAVerifier) alertes.push({ type: 'stock-retour', cle: `c${comptage.id}-${x.cmd}`, cmd_id: x.cmd,
        message: `Comptage ${comptage.id} : commande ${x.cmd} — ${x.motif}. Non réintégré automatiquement : constater au dépôt puis saisir dans stock_entrees.` });
    }

    // ── Écriture ──
    const demande = body?.apply === true;
    let refusEcriture: string | null = null;
    if (!demande) refusEcriture = 'lecture seule (pas de apply)';
    else if (body.confirme !== 'apres-comptage') refusEcriture = 'il faut confirme: "apres-comptage"';
    else if (!comptage || comptage.statut !== 'valide') refusEcriture = 'aucun comptage validé : écriture impossible';
    else if (Number(body.comptage_id) !== Number(comptage.id)) refusEcriture = `comptage_id obligatoire et égal au comptage validé utilisé (${comptage.id})`;
    else if (r.lignesNonReconnues.length && body.accepter_lignes_non_reconnues !== true) {
      refusEcriture = `${r.lignesNonReconnues.length} ligne(s) de commande non reconnue(s) : les relier d'abord (ou accepter_lignes_non_reconnues: true)`;
    }
    const aEcrire = lignes.filter((l) => l.ecriture === 'oui');
    let ecritures: any[] = [];
    let lot: string | null = null;
    if (!refusEcriture && aEcrire.length) {
      lot = `c${comptage.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const sauvegarde = aEcrire.map((l) => {
        const v = variantes.get(l.variante)!;
        return { lot, comptage_id: comptage.id, shopify_variant_id: Number(l.variante), inventory_item_id: v.inventoryItemId,
          location_id: v.locationId, available: v.available, committed: v.committed, on_hand: v.on_hand, cible: l.propose };
      });
      const { error: eS } = await sb.from('stock_sauvegarde_shopify').insert(sauvegarde);
      if (eS) throw new Error('sauvegarde impossible, RIEN écrit : ' + eS.message);
      const ref = `gid://maxiconfort-livraison/StockSync/${lot}`;
      for (const l of aEcrire) {
        const v = variantes.get(l.variante)!;
        try {
          const w = await setAvailable(v.inventoryItemId, v.locationId!, l.propose, v.available, ref);
          l.ecriture = w.ok ? 'écrite' : 'échec';
          ecritures.push({ variante: l.variante, de: v.available, a: l.propose, ...w });
        } catch (e: any) {
          l.ecriture = 'échec';
          ecritures.push({ variante: l.variante, ok: false, detail: e.message });
        }
      }
    }

    const al = await enregistrerAlertes(alertes, alertesActives);
    const nbEcr = (x: string) => lignes.filter((l) => l.ecriture === x).length;
    return json({
      ok: true,
      mode: lot ? 'ECRITURE' : 'lecture seule (rien écrit dans Shopify)',
      ecriture_possible: comptage?.statut === 'valide',
      ...(comptage?.statut === 'valide' ? {} : { ecriture_refusee: 'aucun comptage validé : toute écriture est refusée' }),
      raison_refus: demande ? refusEcriture : undefined,
      source, comptage: comptage ? { id: comptage.id, debut: comptage.debut, fin: comptage.fin, statut: comptage.statut } : null,
      resume: {
        variantes: lignes.length, a_ecrire: nbEcr('oui'), identiques: nbEcr('identique'), ecrites: nbEcr('écrite'), echecs: nbEcr('échec'),
        exclues: lignes.filter((l) => l.exclusions.length).length, survente: lignes.filter((l) => l.alerte).length,
      },
      consommation: {
        commandes_consommatrices: r.nbCommandesConsommatrices,
        lignes_non_reconnues: r.lignesNonReconnues,
        commandes_sans_lignes: r.commandesSansLignes,
        shopify_non_importees: nonImportees.map((o) => o.name),
        retours_a_verifier: r.retoursAVerifier,
        entrees_apres_comptage: Object.fromEntries(r.entrees),
      },
      ...(instResume ? { instantane_calcule: instResume } : {}),
      alertes: { nouvelles: al.nouvelles, deja_connues: al.existantes, total: al.liste.length },
      lignes,
      ...(lot ? { lot_sauvegarde: lot, ecritures } : {}),
    });
  } catch (e: any) {
    return json({ ok: false, error: e.message }, 500);
  }
});
