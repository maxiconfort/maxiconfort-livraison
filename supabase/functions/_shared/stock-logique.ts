// ════════════════════════════════════════════════════════════════════
// Logique PURE du stock (29/09/2026) — aucune dépendance Deno/réseau :
// importée par shopify-sync (v7) et stock-sync-shopify, et testable sous Node
// (node >= 22 exécute directement ce .ts).
// ════════════════════════════════════════════════════════════════════
// deno-lint-ignore-file no-explicit-any

export type Composant = { id: string; qte?: number };
export type Produit = { id: string; nom?: string; stock?: number | null; composants?: Composant[] | null };
export type LigneApp = { produitId?: string | null; produit?: string; nom?: string; qte?: number };
export type CommandeApp = {
  id: string; statut: string; stock_deduit?: boolean | null; ref_marketplace?: string | null;
  origine?: string | null; lignes?: LigneApp[] | null; instr?: string | null;
};
export type LigneShopify = {
  variant_id?: number | string | null; quantity?: number; fulfillable_quantity?: number;
  title?: string; variant_title?: string | null; price?: string | number;
};
export type CommandeShopify = {
  id: number | string; name?: string; cancelled_at?: string | null;
  fulfillment_status?: string | null; financial_status?: string; line_items?: LigneShopify[];
};

/** Correspondance variante Shopify -> produit app (clé = id de variante en texte). */
export type Correspondance = Map<string, string>;

export const STATUTS_TERMINES = ['livré', 'annulé'];

// ── shopify-sync v7 (a) : lignes de commande avec produitId ──────────
export function nomLigneShopify(li: LigneShopify): string {
  return (li.title || '') + (li.variant_title ? ' — ' + li.variant_title : '');
}

export function mapLignes(items: LigneShopify[], corr: Correspondance = new Map()): any[] {
  if (!items?.length) return [];
  return items.map((li) => {
    const pu = Number(li.price) || 0;
    const q = Number(li.quantity) || 1;
    return {
      // v7 : produit app d'après la variante (table stock_correspondance), sinon null comme avant
      produitId: li.variant_id != null ? (corr.get(String(li.variant_id)) || null) : null,
      produit: nomLigneShopify(li),
      qte: q,
      prixUnit: pu,
      prixBrut: pu * q,
      remiseLigne: 0,
      remiseVal: 0,
      remiseType: 'pct',
      sousTotal: pu * q,
    };
  });
}

// ── shopify-sync v7 (b) : propagation des annulations ────────────────
export type DecisionAnnulation =
  | { action: 'annuler'; instr: string }
  | { action: 'deja-livree' }          // ne rien changer, juste signaler
  | { action: 'deja-annulee' }
  | { action: 'stock-deja-deduit' }    // cas anormal (déduit sans être livré) : à traiter à la main
  | { action: 'rien' };                // commande Shopify non annulée

export function dateFr(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
}

export function decisionAnnulation(o: CommandeShopify, cmd: CommandeApp): DecisionAnnulation {
  if (!o.cancelled_at) return { action: 'rien' };
  if (cmd.statut === 'annulé') return { action: 'deja-annulee' };
  if (cmd.statut === 'livré') return { action: 'deja-livree' };
  // Normalement stock_deduit=false avant livraison : rien à recréditer. Si le stock a
  // quand même été déduit, on ne touche à rien côté serveur (le recrédit se fait dans l'app).
  if (cmd.stock_deduit) return { action: 'stock-deja-deduit' };
  const mention = 'Annulée sur Shopify le ' + dateFr(o.cancelled_at) + '. ';
  const instr = String(cmd.instr || '');
  return { action: 'annuler', instr: instr.includes('Annulée sur Shopify') ? instr : mention + instr };
}

// ── stock-sync-shopify : réservations et disponible ──────────────────
function norm(s: any): string {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

/** produitId utilisable : non vide, pas un article libre (« _custom_… »), existant dans l'app. */
export function produitIdValide(pid: any, produits: Map<string, Produit>): string | null {
  if (!pid || typeof pid !== 'string' || pid.startsWith('_custom_')) return null;
  return produits.has(pid) ? pid : null;
}

/** Retrouve la variante Shopify d'une ligne d'une commande du site importée sans produitId. */
export function varianteDeLigne(ligne: LigneApp, idx: number, nbLignes: number, o: CommandeShopify): string | null {
  const items = o.line_items || [];
  const n = norm(ligne.produit || ligne.nom);
  const parNom = items.find((li) => norm(nomLigneShopify(li)) === n);
  if (parNom?.variant_id != null) return String(parNom.variant_id);
  if (items.length === nbLignes && items[idx]?.variant_id != null) return String(items[idx].variant_id); // même ordre qu'à l'import
  return null;
}

export type ResultatReservations = {
  reserve: Map<string, number>;                // produit SIMPLE (ou ensemble sans composants) -> quantité réservée
  lignesReliees: number;
  lignesResoluesViaShopify: number;
  lignesNonReliees: { cmd: string; statut: string; produit: string; qte: number }[];
  commandesSansLignes: string[];
  shopifyNonImportees: { shopify: string; lignes: { variante: string; qte: number; produit: string | null }[] }[];
  siteExpedieesNonLivrees: string[];            // info : étiquette faite (Shopify « fulfilled ») mais pas « livré » dans l'app
};

/**
 * Réservé = somme des quantités des commandes de l'app NI livrées NI annulées (tous canaux,
 * SAV compris) dont le stock n'a pas encore été déduit, lignes reliées par produitId ;
 * un ensemble réserve ses composants. Lignes du site importées sans produitId : résolues
 * via la commande Shopify (variante -> stock_correspondance).
 * + commandes Shopify ouvertes pas (encore) importées dans l'app (délai de 10 min de
 * shopify-sync, ou non payées) : leurs quantités non expédiées sont réservées aussi.
 */
export function calculerReservations(
  produitsListe: Produit[], commandes: CommandeApp[], corr: Correspondance,
  shopifyParId: Map<string, CommandeShopify>, shopifyOuvertes: CommandeShopify[],
  refsToutes: Set<string> = new Set(), // ref_marketplace de TOUTES les commandes de l'app (livrées comprises)
): ResultatReservations {
  const produits = new Map(produitsListe.map((p) => [p.id, p]));
  const reserve = new Map<string, number>();
  const res: ResultatReservations = {
    reserve, lignesReliees: 0, lignesResoluesViaShopify: 0, lignesNonReliees: [],
    commandesSansLignes: [], shopifyNonImportees: [], siteExpedieesNonLivrees: [],
  };
  const ajouter = (pid: string, q: number) => {
    const p = produits.get(pid);
    if (!p) return;
    if (p.composants && p.composants.length) {
      for (const c of p.composants) if (produits.has(c.id)) reserve.set(c.id, (reserve.get(c.id) || 0) + (c.qte || 1) * q);
    } else reserve.set(pid, (reserve.get(pid) || 0) + q);
  };

  const refsApp = new Set<string>(refsToutes);
  for (const c of commandes) {
    if (c.ref_marketplace) refsApp.add(String(c.ref_marketplace));
    if (STATUTS_TERMINES.includes(c.statut) || c.stock_deduit) continue;
    const lignes = c.lignes || [];
    if (!lignes.length) { res.commandesSansLignes.push(c.id); continue; }
    const oShop = c.ref_marketplace ? shopifyParId.get(String(c.ref_marketplace)) : undefined;
    if (oShop && oShop.fulfillment_status === 'fulfilled') res.siteExpedieesNonLivrees.push(c.id + ' (site ' + (oShop.name || oShop.id) + ')');
    lignes.forEach((l, i) => {
      const q = Math.max(1, parseInt(String(l.qte)) || 1);
      let pid = produitIdValide(l.produitId, produits);
      if (pid) res.lignesReliees++;
      else if (oShop) {
        const v = varianteDeLigne(l, i, lignes.length, oShop);
        const p2 = v ? produitIdValide(corr.get(v), produits) : null;
        if (p2) { pid = p2; res.lignesResoluesViaShopify++; }
      }
      if (pid) ajouter(pid, q);
      else res.lignesNonReliees.push({ cmd: c.id, statut: c.statut, produit: String(l.produit || l.nom || ''), qte: q });
    });
  }

  for (const o of shopifyOuvertes) {
    if (o.cancelled_at || refsApp.has(String(o.id))) continue;
    const lignes: { variante: string; qte: number; produit: string | null }[] = [];
    for (const li of o.line_items || []) {
      const q = Number(li.fulfillable_quantity ?? li.quantity) || 0;
      if (q <= 0 || li.variant_id == null) continue;
      const pid = produitIdValide(corr.get(String(li.variant_id)), produits);
      if (pid) ajouter(pid, q);
      lignes.push({ variante: String(li.variant_id), qte: q, produit: pid });
    }
    if (lignes.length) res.shopifyNonImportees.push({ shopify: String(o.name || o.id), lignes });
  }
  return res;
}

/**
 * Disponible d'un produit :
 *  - simple (ou ensemble sans composants) : stock − réservé ;
 *  - ensemble : min( floor(disponible composant / qte requise) ) ; composant absent = 0.
 * Peut être négatif (survente) : l'appelant borne à 0 pour Shopify et le signale.
 */
export function disponible(pid: string, produitsListe: Produit[] | Map<string, Produit>, reserve: Map<string, number>): number {
  const produits = produitsListe instanceof Map ? produitsListe : new Map(produitsListe.map((p) => [p.id, p]));
  const p = produits.get(pid);
  if (!p) return 0;
  const simple = (x: Produit) => (Number(x.stock) || 0) - (reserve.get(x.id) || 0);
  if (!p.composants || !p.composants.length) return simple(p);
  let d = Infinity;
  for (const c of p.composants) {
    const comp = produits.get(c.id);
    if (!comp) return 0;
    d = Math.min(d, Math.floor(simple(comp) / (c.qte || 1)));
  }
  return d === Infinity ? 0 : d;
}
