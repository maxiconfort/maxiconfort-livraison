// Produits NON VENDABLES (migration 039, 25/11/2026) — règle commune aux fonctions serveur (jarvis-action, whatsapp-receive).
// Un produit est non vendable s'il est marqué vendable = false, s'il n'a pas de prix de vente défini (prix_vente_defini = false),
// ou si c'est un ENSEMBLE dont un composant l'est (un niveau, comme l'application et interne.produit_non_vendable).
// Avant la migration 039, ces colonnes n'existent pas : tout reste vendable. Lecture seule, pure.

type LigneProduit = Record<string, any>;

// Revue Codex PR 26 sur fd751b8 : prix NULL = non vendable (même règle que l'application et interne.produit_non_vendable ; la base
// interdit désormais « prix défini » sans prix). Un prix non lu (colonne absente de la lecture) n'est pas NULL : inchangé.
const marque = (r: LigneProduit | undefined) => !!r && (r.vendable === false || r.prix_vente_defini === false || r.prix === null);

/** Nom (ou référence) NORMALISÉ pour reconnaître un produit sans identifiant (revue Codex PR 26 sur 66def07) : minuscules, sans
 *  accents, « × » lu « x », espaces regroupés, « 140 x 190 » = « 140x190 ». MÊME règle que interne.l039_norm (migration 039) et
 *  venNorm (application). Vide = rien à comparer. */
export function nomNormalise(s: unknown): string {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/×/g, 'x')
    .replace(/\s+/g, ' ').trim().replace(/(\d) ?x ?(\d)/g, '$1x$2');
}

/** Identifiants des produits non vendables parmi les lignes lues dans la table produits (select *). */
export function idsNonVendables(rows: LigneProduit[]): Set<string> {
  const parId = new Map((rows || []).map((r) => [String(r.id), r]));
  const out = new Set<string>();
  for (const r of rows || []) {
    const compos = Array.isArray(r.composants) ? r.composants : [];
    // revue Codex PR 26 sur fd751b8 : composant INTROUVABLE (identifiant renseigné absent des lignes lues) = ensemble NON vendable,
    // jamais vendable par défaut (même règle que interne.produit_non_vendable)
    const idDe = (c: any) => (c && c.id != null ? String(c.id) : '');
    if (marque(r) || compos.some((c: any) => idDe(c) !== '' && (!parId.has(idDe(c)) || marque(parId.get(idDe(c)))))) out.add(String(r.id));
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
  // Revue Codex PR 26 sur 4ec0313 : la base peut renvoyer MOINS de lignes que demandé alors qu'il en reste (plafond du serveur
  // inférieur à la page demandée, ex. 300 pour 1 000). On avance donc du nombre de lignes RÉELLEMENT reçues et on ne s'arrête que sur
  // une page VIDE (même logique que arrLireTout dans l'application), jamais sur une page « incomplète ».
  const rows: LigneProduit[] = [];
  for (let n = 0; ; n++) {
    if (n > 10_000 || rows.length > 1_000_000) throw new Error('catalogue anormalement grand');
    const debut = rows.length;
    const page = await lirePage(debut, debut + taillePage - 1);
    if (!Array.isArray(page)) throw new Error('lecture du catalogue impossible');
    if (!page.length) break;
    rows.push(...page);
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
  // Revue Codex PR 26 sur fd751b8 : un composant DEMANDÉ mais absent de la réponse (identifiant inconnu, lecture tronquée) n'est plus
  // tenu pour vendable par défaut : l'absence est SIGNALÉE et le catalogue REFUSÉ (exception : l'appelant ne présente jamais un
  // catalogue incomplet ; JARVIS répond « catalogue illisible », WhatsApp passe tout en « hors catalogue » à vérifier).
  const introuvables = liste.filter((id) => !connus.has(id));
  if (introuvables.length) throw new Error('composants introuvables : ' + introuvables.join(', '));
  return rows;
}

/** Catalogue proposé au rapprochement WhatsApp (revue Codex PR 26 sur fd751b8) : TOUS les produits actifs et vendables, SANS
 *  plafond (avant : 200 premiers seulement, un produit au-delà n'était jamais reconnu). Le rapprochement (chercherProduit) parcourt
 *  toute la liste et n'envoie à l'IA que les meilleurs candidats. Pure. */
export function catalogueWhatsapp(rows: LigneProduit[]): { id: any; nom: any; cat: any; dim: any; prix: any }[] {
  return produitsVendables(rows).filter((p: any) => p.actif === true)
    .map((p: any) => ({ id: p.id, nom: p.nom, cat: p.cat, dim: p.dim, prix: p.prix }));
}
