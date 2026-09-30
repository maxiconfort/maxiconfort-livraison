// ════════════════════════════════════════════════════════════════════
// Logique PURE du stock (29-30/09/2026) — aucune dépendance Deno/réseau :
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

// ════════════════════════════════════════════════════════════════════
// v2 (30/09/2026) : stock par ÉVÉNEMENTS à partir d'un comptage horodaté.
// On n'utilise PLUS produits.stock (modifié par le navigateur à la livraison, alors que
// gls-sync passe des commandes « livré » côté serveur sans déduction -> dérive).
// ════════════════════════════════════════════════════════════════════

// ── Fiabilité des correspondances ────────────────────────────────────
export type Fiabilite = 'certaine' | 'incertaine' | 'absente';
export type LigneCorrespondance = {
  shopify_variant_id: number | string; shopify_sku?: string | null; libelle?: string | null;
  app_produit_id?: string | null; actif?: boolean | null; fiabilite?: string | null; motif?: string | null;
};

/** Seules les correspondances 'certaine' servent (import des commandes et écriture Shopify). */
export function correspondanceCertaine(rows: LigneCorrespondance[]): Correspondance {
  return new Map(rows.filter((r) => r.fiabilite === 'certaine' && r.app_produit_id)
    .map((r) => [String(r.shopify_variant_id), String(r.app_produit_id)]));
}

/** Produits app reliés 'certaine' à au moins une variante Shopify. */
export function produitsCertains(rows: LigneCorrespondance[]): Set<string> {
  return new Set(rows.filter((r) => r.fiabilite === 'certaine' && r.app_produit_id).map((r) => String(r.app_produit_id)));
}

// ── Classement d'une commande par rapport au comptage ────────────────
export type Situation = 'sortie_avant' | 'dans_stock' | 'a_verifier';
export type ColisSuivi = {
  trackId: string; etat: string; priseEnChargeAt: string | null; livreClientAt: string | null;
  retourAt: string | null; livreExpediteurAt: string | null;
};
export type MouvementCamion = { type: string; date: string }; // mouvements_stock : 'chargement' | 'retour_depot'
export type InfoClassement = {
  id: string; statut: string; date_livraison?: string | null; updated_at?: string | null;
  gls?: { erreur?: string | null; colis: ColisSuivi[] } | null;   // null = suivi GLS non interrogé
  mouvements?: MouvementCamion[];
};
export type Classement = { situation: Situation | 'annulee'; motif: string };

const ts = (s: any): number => { const x = Date.parse(String(s || '')); return isNaN(x) ? NaN : x; };
export function jourParis(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
}
const frDate = (x: number) => new Date(x).toLocaleString('fr-FR',
  { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * sortie_avant : les marchandises avaient quitté le dépôt avant `debut` (tous les colis GLS
 *   pris en charge avant debut ; chargée dans le camion avant debut sans retour depuis ;
 *   livrée un jour antérieur au comptage) -> elles ne sont PAS dans le stock compté.
 * dans_stock : encore au dépôt à `fin` -> la commande consomme le stock compté.
 * a_verifier : un mouvement (prise en charge GLS, livraison, chargement, retour, annulation)
 *   tombe ENTRE debut et fin, ou la donnée est illisible -> décision humaine.
 */
export function classerCommande(c: InfoClassement, debut: string, fin: string): Classement {
  const D = ts(debut), F = ts(fin);
  const dansFenetre = (x: number) => !isNaN(x) && x >= D && x <= F;
  const evs: { t: number; lib: string }[] = [];
  const colis = c.gls?.colis || [];
  for (const k of colis) {
    if (k.priseEnChargeAt) evs.push({ t: ts(k.priseEnChargeAt), lib: 'prise en charge GLS' });
    if (k.livreClientAt) evs.push({ t: ts(k.livreClientAt), lib: 'livraison GLS' });
    if (k.retourAt) evs.push({ t: ts(k.retourAt), lib: 'retour GLS' });
    if (k.livreExpediteurAt) evs.push({ t: ts(k.livreExpediteurAt), lib: "colis revenu à l'expéditeur" });
  }
  for (const m of c.mouvements || []) {
    evs.push({ t: ts(m.date), lib: m.type === 'chargement' ? 'chargement camion' : 'retour camion au dépôt' });
  }
  const pendant = evs.filter((e) => dansFenetre(e.t)).sort((a, b) => a.t - b.t);
  const listePendant = () => pendant.map((e) => e.lib + ' le ' + frDate(e.t)).join(', ');

  if (c.statut === 'annulé') {
    if (dansFenetre(ts(c.updated_at))) return { situation: 'a_verifier', motif: 'annulée (dernière modification) pendant le comptage' };
    if (pendant.length) return { situation: 'a_verifier', motif: 'annulée ; mouvement pendant le comptage : ' + listePendant() };
    return { situation: 'annulee', motif: 'annulée' };
  }
  // Livrée un jour ANTÉRIEUR au comptage : sortie avant, quels que soient les mouvements camion.
  // (Contrôle du 30/09 : mouvements_stock est « bruité » — cocher/décocher au chargement crée
  // des paires chargement/retour_depot, et beaucoup de commandes livrées finissent par un
  // « retour_depot » parasite. Il ne sert donc que pour les commandes non livrées ou livrées
  // le jour même.)
  const dlv = String(c.date_livraison || '').slice(0, 10);
  if (c.statut === 'livré' && /^\d{4}-\d{2}-\d{2}$/.test(dlv) && dlv < jourParis(debut)) {
    return { situation: 'sortie_avant', motif: 'livrée le ' + dlv };
  }
  if (pendant.length) return { situation: 'a_verifier', motif: 'mouvement pendant le comptage : ' + listePendant() };

  if (colis.length) {
    if (c.gls?.erreur || colis.some((k) => k.etat === 'erreur')) {
      return { situation: 'a_verifier', motif: 'suivi GLS illisible (' + (c.gls?.erreur || 'erreur API') + ')' };
    }
    const prisAvant = colis.filter((k) => k.priseEnChargeAt && ts(k.priseEnChargeAt) < D);
    if (prisAvant.length && prisAvant.length < colis.length) {
      return { situation: 'a_verifier', motif: `partiel : ${prisAvant.length}/${colis.length} colis pris en charge par GLS avant le comptage` };
    }
    if (prisAvant.length === colis.length) {
      const revenus = colis.filter((k) => k.livreExpediteurAt && ts(k.livreExpediteurAt) < D);
      if (revenus.length === colis.length) return { situation: 'dans_stock', motif: 'colis GLS revenus au dépôt avant le comptage' };
      if (revenus.length) return { situation: 'a_verifier', motif: `retour partiel : ${revenus.length}/${colis.length} colis revenus avant le comptage` };
      const premier = Math.min(...colis.map((k) => ts(k.priseEnChargeAt)));
      return { situation: 'sortie_avant', motif: 'prise en charge GLS le ' + frDate(premier) };
    }
    // aucun colis pris en charge avant le comptage : on regarde le camion ci-dessous
  }

  const mv = (c.mouvements || []).filter((m) => ts(m.date) < D).sort((a, b) => ts(a.date) - ts(b.date));
  if (mv.length) {
    const dernier = mv[mv.length - 1];
    if (dernier.type === 'chargement') return { situation: 'sortie_avant', motif: 'chargée dans le camion le ' + frDate(ts(dernier.date)) };
    if (c.statut === 'livré' && !(c.mouvements || []).some((m) => ts(m.date) > F)) {
      return { situation: 'a_verifier', motif: 'livrée mais dernier mouvement connu = retour au dépôt le ' + frDate(ts(dernier.date)) };
    }
    return { situation: 'dans_stock', motif: 'revenue au dépôt le ' + frDate(ts(dernier.date)) };
  }

  if (c.statut === 'livré' && !colis.length && !(c.mouvements || []).length) {
    const jD = jourParis(debut), jF = jourParis(fin);
    const dl = String(c.date_livraison || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dl)) {
      if (dl < jD) return { situation: 'sortie_avant', motif: 'livrée le ' + dl };
      if (dl > jF) return { situation: 'dans_stock', motif: 'livrée le ' + dl + ' (après le comptage)' };
      return { situation: 'a_verifier', motif: 'livrée le jour du comptage (' + dl + '), heure inconnue' };
    }
    const u = ts(c.updated_at);
    if (!isNaN(u) && u < D) return { situation: 'sortie_avant', motif: 'livrée (date inconnue, dernière modification avant le comptage)' };
    return { situation: 'a_verifier', motif: 'livrée, date de livraison inconnue' };
  }
  return {
    situation: 'dans_stock',
    motif: colis.length ? 'aucun colis GLS pris en charge avant la fin du comptage' : 'aucun départ du dépôt avant la fin du comptage',
  };
}

// ── Calcul du stock à partir du comptage ─────────────────────────────
export type EntreeStock = { app_produit_id: string; quantite: number; date_entree: string; motif?: string | null };
export type CommandeCalc = {
  id: string; statut: string; ref_marketplace?: string | null; lignes?: LigneApp[] | null;
  gls_livraison_etat?: string | null;
};
export type ParamsCalcul = {
  produits: Produit[];
  comptageFin: string;
  instantane: Map<string, Situation>;          // cmd_id -> situation (absente = commande créée après la validation)
  commandes: CommandeCalc[];                   // toutes les commandes (les annulées sont ignorées)
  corr: Correspondance;                        // 'certaine' uniquement
  corrToutes?: Map<string, LigneCorrespondance>;
  shopifyParId: Map<string, CommandeShopify>;
  entrees: EntreeStock[];
  retoursCamionApresFin?: Set<string>;         // cmd_id avec un « retour_depot » après fin
};
export type LigneNonReconnue = { cmd: string; situation: string; produit: string; qte: number; raison: string; variante?: string };
export type ResultatStock = {
  consomme: Map<string, number>;               // produit SIMPLE -> quantité consommée sur le stock compté
  entrees: Map<string, number>;                // produit -> entrées après fin
  bloques: Map<string, string[]>;              // produit -> commandes 'a_verifier' qui le concernent
  lignesNonReconnues: LigneNonReconnue[];
  commandesSansLignes: string[];
  retoursAVerifier: { cmd: string; motif: string }[];
  nbCommandesConsommatrices: number;
};

/**
 * Σ des quantités des commandes NON annulées qui consomment le stock compté
 * (toutes sauf 'sortie_avant', y compris celles créées après le comptage et celles livrées
 * depuis). Une annulation retire simplement la commande de la somme. Recalculé entièrement
 * à chaque passage : aucun état intermédiaire, donc idempotent. Une même commande n'est
 * comptée qu'une fois (dédoublonnage par id ; l'unicité de ref_marketplace est garantie
 * par l'index 026).
 */
export function calculerStock(p: ParamsCalcul): ResultatStock {
  const produits = new Map(p.produits.map((x) => [x.id, x]));
  const res: ResultatStock = {
    consomme: new Map(), entrees: new Map(), bloques: new Map(), lignesNonReconnues: [],
    commandesSansLignes: [], retoursAVerifier: [], nbCommandesConsommatrices: 0,
  };
  const F = ts(p.comptageFin);
  for (const e of p.entrees) {
    if (ts(e.date_entree) > F && produits.has(e.app_produit_id)) {
      res.entrees.set(e.app_produit_id, (res.entrees.get(e.app_produit_id) || 0) + (Number(e.quantite) || 0));
    }
  }
  const vus = new Set<string>();
  for (const c of p.commandes) {
    if (c.statut === 'annulé' || vus.has(c.id)) continue;
    vus.add(c.id);
    const sit = p.instantane.get(c.id) || 'dans_stock';
    if (sit === 'sortie_avant') {
      // partie avant le comptage : si elle revient au dépôt, ce n'est PAS ajouté
      // automatiquement (donnée non fiable par produit) -> à vérifier puis stock_entrees
      if (p.retoursCamionApresFin?.has(c.id)) res.retoursAVerifier.push({ cmd: c.id, motif: 'retour camion au dépôt après le comptage' });
      if (c.gls_livraison_etat === 'retour') res.retoursAVerifier.push({ cmd: c.id, motif: 'colis GLS en retour expéditeur' });
      continue;
    }
    const lignes = c.lignes || [];
    if (!lignes.length) { res.commandesSansLignes.push(c.id); continue; }
    res.nbCommandesConsommatrices++;
    const oShop = c.ref_marketplace ? p.shopifyParId.get(String(c.ref_marketplace)) : undefined;
    lignes.forEach((l, i) => {
      const q = Math.max(1, parseInt(String(l.qte)) || 1);
      let pid = produitIdValide(l.produitId, produits);
      let raison = '';
      let variante: string | undefined;
      if (!pid && oShop) {
        const v = varianteDeLigne(l, i, lignes.length, oShop);
        if (v) {
          variante = v;
          pid = produitIdValide(p.corr.get(v), produits);
          if (!pid) {
            const cr = p.corrToutes?.get(v);
            raison = 'variante Shopify ' + v + ' : correspondance ' + (cr?.fiabilite || 'absente') + (cr?.motif ? ' (' + cr.motif + ')' : '');
          }
        } else raison = 'ligne introuvable dans la commande Shopify';
      }
      if (!pid) {
        if (!raison) raison = String(l.produitId || '').startsWith('_custom_') ? "article libre saisi dans l'app (pas de produit)" : 'aucun produit app';
        res.lignesNonReconnues.push({ cmd: c.id, situation: sit, produit: String(l.produit || l.nom || ''), qte: q, raison, variante });
        return;
      }
      const prod = produits.get(pid)!;
      const cibles: [string, number][] = prod.composants && prod.composants.length
        ? prod.composants.map((k) => [k.id, (k.qte || 1) * q] as [string, number])
        : [[pid, q]];
      for (const [id, n] of cibles) {
        res.consomme.set(id, (res.consomme.get(id) || 0) + n);
        if (sit === 'a_verifier') res.bloques.set(id, [...(res.bloques.get(id) || []), c.id]);
      }
    });
  }
  return res;
}

export type EvalComposant = {
  id: string; nom: string | null; qte_requise: number; compte: number | null; consomme: number; entrees: number;
  disponible: number | null; certain: boolean; exclusions: string[];
};
export type EvalProduit = {
  type: 'simple' | 'ensemble'; compte: number | null; consomme: number; entrees: number;
  disponible: number | null; exclusions: string[]; composants?: EvalComposant[];
};

/** Disponible d'un produit app + raisons d'exclusion de l'écriture automatique. */
export function evaluerProduit(
  pid: string, produits: Map<string, Produit>, comptees: Map<string, number>, r: ResultatStock, certains: Set<string>,
): EvalProduit {
  const simple = (id: string) => {
    const ex: string[] = [];
    const compte = comptees.has(id) ? comptees.get(id)! : null;
    if (compte === null) ex.push('non compté');
    const bl = r.bloques.get(id);
    if (bl?.length) ex.push('commande(s) à vérifier : ' + [...new Set(bl)].join(', '));
    const consomme = r.consomme.get(id) || 0, entrees = r.entrees.get(id) || 0;
    return { compte, consomme, entrees, disponible: compte === null ? null : compte - consomme + entrees, exclusions: ex };
  };
  const p = produits.get(pid);
  if (!p) return { type: 'simple', compte: null, consomme: 0, entrees: 0, disponible: null, exclusions: ["produit absent de l'app"] };
  if (!p.composants || !p.composants.length) return { type: 'simple', ...simple(pid) };
  const composants: EvalComposant[] = [];
  const ex: string[] = [];
  let dispo: number | null = Infinity;
  for (const k of p.composants) {
    const q = k.qte || 1;
    const comp = produits.get(k.id);
    const s = comp ? simple(k.id) : { compte: null, consomme: 0, entrees: 0, disponible: null, exclusions: ["absent de l'app"] };
    const exk = [...s.exclusions];
    if (comp?.composants?.length) exk.push('composant lui-même ensemble');
    const certain = certains.has(k.id);
    if (!certain) exk.push('composant sans correspondance certaine');
    composants.push({ id: k.id, nom: comp?.nom || null, qte_requise: q, ...s, certain, exclusions: exk });
    for (const e of exk) ex.push(k.id + ' : ' + e);
    dispo = s.disponible === null || dispo === null ? null : Math.min(dispo, Math.floor(s.disponible / q));
  }
  return {
    type: 'ensemble', compte: null, consomme: 0, entrees: 0,
    disponible: dispo === Infinity ? null : dispo, exclusions: ex, composants,
  };
}
