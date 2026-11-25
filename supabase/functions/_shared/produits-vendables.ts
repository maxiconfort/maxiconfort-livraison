// Produits NON VENDABLES (migration 039, 25/11/2026) — règle commune aux fonctions serveur (jarvis-action, whatsapp-receive).
// Un produit est non vendable s'il est marqué vendable = false, s'il n'a pas de prix de vente défini (prix_vente_defini = false),
// ou si c'est un ENSEMBLE dont un composant l'est (un niveau, comme l'application et interne.produit_non_vendable).
// Avant la migration 039, ces colonnes n'existent pas : tout reste vendable. Lecture seule, pure.

type LigneProduit = Record<string, any>;

const marque = (r: LigneProduit | undefined) => !!r && (r.vendable === false || r.prix_vente_defini === false);

/** Identifiants des produits non vendables parmi les lignes lues dans la table produits (select *). */
export function idsNonVendables(rows: LigneProduit[]): Set<string> {
  const parId = new Map((rows || []).map((r) => [String(r.id), r]));
  const out = new Set<string>();
  for (const r of rows || []) {
    const compos = Array.isArray(r.composants) ? r.composants : [];
    if (marque(r) || compos.some((c: any) => marque(parId.get(String(c && c.id))))) out.add(String(r.id));
  }
  return out;
}

/** Lignes vendables seulement. ATTENTION : passer TOUT le catalogue lu (composants compris), avant tout autre filtrage. */
export function produitsVendables<T extends LigneProduit>(rows: T[]): T[] {
  const nv = idsNonVendables(rows);
  return (rows || []).filter((r) => !nv.has(String(r.id)));
}
