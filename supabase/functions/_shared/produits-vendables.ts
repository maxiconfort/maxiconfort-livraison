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

/** Lecture COMPLÈTE du catalogue pour la règle commune (revue Codex PR 26 sur 82a9b09) : les produits sont lus PAR PAGES (jamais une
 *  seule requête plafonnée à 1 000 lignes), puis TOUS les composants d'ensemble absents de cette lecture sont lus par une requête
 *  CIBLÉE par identifiants (ex. composant inactif quand seuls les produits actifs sont lus). Sans cela, un composant non lu passait
 *  pour vendable et son ensemble restait proposé. Toute erreur de lecture LÈVE une exception (l'appelant décide : jamais un
 *  catalogue partiel présenté comme complet). Les lecteurs sont injectés (testable sans base). */
export async function lireCatalogueComplet(
  lirePage: (debut: number, fin: number) => Promise<LigneProduit[]>,
  lireParIds: (ids: string[]) => Promise<LigneProduit[]>,
  taillePage = 1000,
): Promise<LigneProduit[]> {
  const rows: LigneProduit[] = [];
  for (let debut = 0; ; debut += taillePage) {
    const page = await lirePage(debut, debut + taillePage - 1);
    if (!Array.isArray(page)) throw new Error('lecture du catalogue impossible');
    rows.push(...page);
    if (page.length < taillePage) break;
    if (debut > 1_000_000) throw new Error('catalogue anormalement grand');
  }
  const connus = new Set(rows.map((r) => String(r.id)));
  const manquants = new Set<string>();
  for (const r of rows) for (const c of (Array.isArray(r.composants) ? r.composants : [])) {
    const id = c && c.id != null ? String(c.id) : '';
    if (id && !connus.has(id)) manquants.add(id);
  }
  const liste = [...manquants];
  for (let i = 0; i < liste.length; i += 100) {
    const lus = await lireParIds(liste.slice(i, i + 100));
    if (!Array.isArray(lus)) throw new Error('lecture des composants impossible');
    for (const r of lus) if (!connus.has(String(r.id))) { connus.add(String(r.id)); rows.push(r); }
  }
  return rows;
}
