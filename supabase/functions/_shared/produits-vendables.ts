// Produits NON VENDABLES (migration 039, 25/11/2026) — règle commune aux fonctions serveur (jarvis-action, whatsapp-receive).
// Un produit est non vendable s'il est marqué vendable = false, s'il n'a pas de prix de vente défini (prix_vente_defini = false),
// ou si c'est un ENSEMBLE dont la composition contient un produit non vendable, À TOUT NIVEAU (revue Codex PR 26 sur ce01159, point 2 :
// avant, un seul niveau). Cycle = non vendable ; au-delà de PROFONDEUR_MAX niveaux = non vendable. Même règle que l'application
// (venEst / venCompositionBloquee) et la base (interne.produit_non_vendable / l039_composants_non_vendables).
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

/** Plafond de profondeur d'une composition : doit rester égal à interne.l039_profondeur_max() (migration 039) et VEN_PROFONDEUR_MAX. */
export const PROFONDEUR_MAX = 8;

/** Identifiants (non vides) des composants d'une ligne produit. */
const idsComposants = (r: LigneProduit | undefined): string[] =>
  (r && Array.isArray(r.composants) ? r.composants : []).map((c: any) => (c && c.id != null ? String(c.id) : '')).filter((id: string) => id !== '');

/** La composition de « r » contient-elle (à tout niveau) un composant introuvable, non vendable, un cycle, ou dépasse-t-elle
 *  PROFONDEUR_MAX niveaux ? Même parcours que interne.l039_composants_non_vendables. */
export function compositionBloquee(r: LigneProduit, parId: Map<string, LigneProduit>): boolean {
  const bloque = (prod: LigneProduit | undefined, chemin: string[], niveau: number): boolean => {
    for (const cid of idsComposants(prod)) {
      if (chemin.includes(cid)) return true;                       // cycle
      const cp = parId.get(cid);
      // revue Codex PR 26 sur fd751b8 : composant INTROUVABLE (identifiant renseigné absent des lignes lues) = NON vendable
      if (!cp || marque(cp)) return true;
      if (idsComposants(cp).length) {
        if (niveau >= PROFONDEUR_MAX) return true;                 // trop profond
        if (bloque(cp, [...chemin, cid], niveau + 1)) return true;
      }
    }
    return false;
  };
  const racine = r && r.id != null ? String(r.id) : '';
  return bloque(r, racine ? [racine] : [], 1);
}

/** Identifiants des produits non vendables parmi les lignes lues dans la table produits (select *). */
export function idsNonVendables(rows: LigneProduit[]): Set<string> {
  const parId = new Map<string, LigneProduit>();
  for (const r of rows || []) if (!parId.has(String(r.id))) parId.set(String(r.id), r);
  const out = new Set<string>();
  for (const r of rows || []) if (marque(r) || compositionBloquee(r, parId)) out.add(String(r.id));
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
  // Revue Codex PR 26 sur ce01159 (point 2) : les composants manquants sont lus NIVEAU PAR NIVEAU (un sous-ensemble lu par identifiant
  // peut lui-même contenir des composants non lus), au plus PROFONDEUR_MAX passes ; chaque identifiant n'est demandé qu'une fois.
  const demandes = new Set<string>();
  let aExaminer: LigneProduit[] = rows.slice();
  for (let passe = 0; aExaminer.length && passe <= PROFONDEUR_MAX; passe++) {
    const manquants = new Set<string>();
    for (const r of aExaminer) for (const id of idsComposants(r)) if (!connus.has(id) && !demandes.has(id)) manquants.add(id);
    const liste = [...manquants];
    for (const id of liste) demandes.add(id);
    const nouveaux: LigneProduit[] = [];
    for (let i = 0; i < liste.length; i += 100) {
      const lus = await lireParIds(liste.slice(i, i + 100));
      if (!Array.isArray(lus)) throw new Error('lecture des composants impossible');
      for (const r of lus) if (!connus.has(String(r.id))) { connus.add(String(r.id)); rows.push(r); nouveaux.push(r); }
    }
    aExaminer = nouveaux;
  }
  // Revue Codex PR 26 sur fd751b8 : un composant DEMANDÉ mais absent de la réponse (identifiant inconnu, lecture tronquée) n'est plus
  // tenu pour vendable par défaut : l'absence est SIGNALÉE et le catalogue REFUSÉ (exception : l'appelant ne présente jamais un
  // catalogue incomplet ; JARVIS répond « catalogue illisible », WhatsApp passe tout en « hors catalogue » à vérifier).
  // Au-delà de PROFONDEUR_MAX passes, les composants encore non lus ne sont pas demandés : l'ensemble est de toute façon trop
  // profond, donc NON vendable (compositionBloquee).
  const introuvables = [...demandes].filter((id) => !connus.has(id));
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
