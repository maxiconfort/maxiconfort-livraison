// ════════════════════════════════════════════════════════════════════
// Logique PURE de la porte « lbc-action » (JARVIS → planning de l'outil Leboncoin, 28/10/2026, lot LBC 2).
// Liste FERMÉE d'actions, toutes RÉVERSIBLES et INTERNES (rien n'est publié ni modifié sur Leboncoin) :
//   boost       { produit | produitId, pct ∈ {25,50,100}, jours ∈ {1,3,7} } → boost temporaire du produit (comme le bouton 🔥)
//   fin_boost   { produit | produitId }                                    → retire le boost
//   poids_zone  { produit | produitId, zone ∈ {idf,prov}, poids 0-100 }    → pression du produit dans la zone
//   bloquer     { filtre: { date, produit?, zone? } } puis { ids }          → annonces à venir NON publiées → « Bloqué »
//   debloquer   { filtre } puis { ids }                                    → annonces « Bloqué » à venir → « À publier »
//   decaler     { filtre, nouvelleDate } puis { ids }                      → annonces à venir non publiées → autre jour
// Hors liste : suppression, prix, titres, catalogue, publication, annonces passées ou déjà publiées.
// Le boost et la pression s'appliquent aux jours GÉNÉRÉS ensuite dans l'outil (le planning déjà généré ne change pas).
// ════════════════════════════════════════════════════════════════════

export type ZoneFiltre = 'idf' | 'pa' | 'pb' | 'prov';
export type FiltreLbc = { date?: string; produit?: string; zone?: ZoneFiltre };
export type DemandeLbc = {
  action: string; produit?: string; produitId?: string; pct?: number; jours?: number; zone?: string; poids?: number;
  filtre?: FiltreLbc; ids?: string[]; nouvelleDate?: string; confirme?: boolean; jeton?: string;
};
export type ProduitLbc = { id: string; nom?: string | null; dim?: string | null; actif?: boolean | null; boost_pct?: number | null; boost_until?: string | null; poids_idf?: number | null; poids_prov?: number | null };
export type AnnonceLbc = { id: string; date_pub?: string | null; heure?: string | null; ville?: string | null; dept?: string | null; collab_id?: string | null; produit?: string | null; dim?: string | null; validation?: string | null; statut?: string | null; lien?: string | null };

export const ACTIONS_PRODUIT = ['boost', 'fin_boost', 'poids_zone'];
export const ACTIONS_ANNONCE = ['bloquer', 'debloquer', 'decaler'];
export const MAX_ANNONCES = 100;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const JOUR = 86400000;

export function jourParis(t: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}
const plus = (d: string, n: number) => new Date(Date.parse(d + 'T12:00:00Z') + n * JOUR).toISOString().slice(0, 10);
function dateValide(d: unknown): d is string {
  if (typeof d !== 'string' || !DATE.test(d)) return false;
  const t = new Date(d + 'T12:00:00Z'); return !isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}
export const norm = (s: unknown) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
/** Mots de recherche (« lit coffre 160 » → [lit, coffre, 160]) ; « 160x200 » et « 160 x 200 » sont équivalents. */
const mots = (s: unknown) => norm(s).replace(/(\d)\s*[x×*]\s*(\d)/g, '$1x$2').split(/[^a-z0-9x]+/).filter((m) => m.length >= 2 || /\d/.test(m));
function correspond(texte: string, cible: string): boolean {
  const c = mots(cible);
  // Un nombre (« 160 ») doit être une dimension entière (« 160 », « 160x200 », « 140x160 ») : jamais « 1600 ».
  // Un mot doit être un mot de la cible ou son début (« coff » → « coffre »).
  return mots(texte).every((m) => c.some((t) => (/^\d+$/.test(m) ? t === m || t.split('x').includes(m) : t === m || (m.length >= 3 && t.startsWith(m)) || (m.includes('x') && t === m))));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const jetonValide = (j: unknown) => typeof j === 'string' && UUID.test(j);

/** Paramètres EXACTS enregistrés avec l'aperçu et comparés à la confirmation (migration 036) : tout ce qui change l'écriture,
 *  rien d'autre (les cibles sont figées à part, avec leur empreinte). Fonction pure, ordre des clés indifférent (jsonb). */
export function parametres(d: DemandeLbc): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (d.action === 'boost') { o.pct = Number(d.pct); o.jours = Number(d.jours); }
  if (d.action === 'poids_zone') { o.zone = d.zone; o.poids = d.poids; }
  if (ACTIONS_ANNONCE.includes(d.action)) {
    const f: Record<string, unknown> = { date: d.filtre?.date };
    if (d.filtre?.produit) f.produit = d.filtre.produit; if (d.filtre?.zone) f.zone = d.filtre.zone;
    o.filtre = f; if (d.action === 'decaler') o.nouvelleDate = d.nouvelleDate;
  }
  return o;
}

/** Contrôle de forme (aucune lecture). Renvoie le motif du refus, ou null. */
export function controlerDemande(d: DemandeLbc, maintenant: number): string | null {
  if (!d || typeof d !== 'object') return 'demande illisible';
  const a = String(d.action || '');
  if (!ACTIONS_PRODUIT.includes(a) && !ACTIONS_ANNONCE.includes(a)) return 'action non autorisée';
  const auj = jourParis(maintenant), max = plus(auj, 30);
  if (ACTIONS_PRODUIT.includes(a)) {
    if (d.confirme === true && !(typeof d.produitId === 'string' && ID.test(d.produitId))) return 'confirmation sans produit précis : refais l’aperçu';
    if (d.confirme === true && !jetonValide(d.jeton)) return 'confirmation sans jeton d’aperçu : refais l’aperçu';
    if (d.produitId !== undefined && !(typeof d.produitId === 'string' && ID.test(d.produitId))) return 'identifiant de produit invalide';
    if (d.produitId === undefined && (typeof d.produit !== 'string' || norm(d.produit).length < 2 || d.produit.length > 80)) return 'précise le produit (2 à 80 caractères)';
    if (a === 'boost' && (![25, 50, 100].includes(Number(d.pct)) || ![1, 3, 7].includes(Number(d.jours)))) return 'boost : +25, +50 ou +100 %, pendant 1, 3 ou 7 jours';
    if (a === 'poids_zone' && (!['idf', 'prov'].includes(String(d.zone)) || !Number.isInteger(d.poids) || (d.poids as number) < 0 || (d.poids as number) > 100)) return 'pression : zone idf ou prov, poids de 0 à 100';
    return null;
  }
  const f = d.filtre;
  if (!f || typeof f !== 'object' || !dateValide(f.date)) return 'précise le jour du planning (AAAA-MM-JJ)';
  if (f.date < auj) return 'jour passé : le planning passé ne se modifie pas';
  if (f.date > max) return 'jour trop lointain (30 jours au plus)';
  if (f.produit !== undefined && (typeof f.produit !== 'string' || f.produit.length > 80)) return 'produit du filtre invalide';
  if (f.zone !== undefined && !['idf', 'pa', 'pb', 'prov'].includes(String(f.zone))) return 'zone du filtre invalide (idf, pa, pb, prov)';
  if (a === 'decaler') {
    if (!dateValide(d.nouvelleDate)) return 'précise le nouveau jour (AAAA-MM-JJ)';
    if (d.nouvelleDate < auj) return 'nouveau jour passé';
    if (d.nouvelleDate > max) return 'nouveau jour trop lointain (30 jours au plus)';
    if (d.nouvelleDate === f.date) return 'le nouveau jour est le même que l’ancien';
  }
  if (d.confirme === true) {
    if (!jetonValide(d.jeton)) return 'confirmation sans jeton d’aperçu : refais l’aperçu';
    if (!Array.isArray(d.ids) || !d.ids.length) return 'confirmation sans liste d’annonces : refais l’aperçu';
    if (d.ids.length > MAX_ANNONCES) return `${MAX_ANNONCES} annonces au plus par action`;
    if (d.ids.some((x) => typeof x !== 'string' || !ID.test(x))) return 'identifiant d’annonce invalide';
    if (new Set(d.ids).size !== d.ids.length) return 'annonce en double dans la liste';
  }
  return null;
}

export function zoneAnnonce(a: AnnonceLbc): 'idf' | 'pa' | 'pb' { return a.dept === 'PROV' ? (a.collab_id === 'B' ? 'pb' : 'pa') : 'idf'; }
const publiee = (a: AnnonceLbc) => a.validation === 'ON' || (typeof a.lien === 'string' && a.lien.trim() !== '');

/** L'annonce correspond-elle au filtre (jour, produit, zone) ? */
export function dansFiltre(a: AnnonceLbc, f: FiltreLbc): boolean {
  if (!a || String(a.date_pub || '').slice(0, 10) !== f.date) return false;
  if (f.zone) { const z = zoneAnnonce(a); if (f.zone === 'prov' ? z === 'idf' : z !== f.zone) return false; }
  if (f.produit && norm(f.produit)) return correspond(f.produit, `${a.produit || ''} ${a.dim || ''}`);
  return true;
}

/** Motif pour lequel l'annonce ne peut pas recevoir l'action, ou null. */
export function refusAnnonce(a: AnnonceLbc, action: string, maintenant: number): string | null {
  const auj = jourParis(maintenant), d = String(a.date_pub || '').slice(0, 10);
  if (!DATE.test(d) || d < auj) return 'jour passé';
  if (publiee(a)) return 'déjà publiée';
  if (action === 'debloquer') return a.statut === 'Bloqué' ? null : 'pas bloquée';
  if (a.statut === 'Bloqué') return 'déjà bloquée';
  return null;
}

export function patchAnnonce(d: DemandeLbc, quand: string): Record<string, unknown> {
  if (d.action === 'bloquer') return { statut: 'Bloqué', validation: 'OFF', updated_at: quand };
  if (d.action === 'debloquer') return { statut: 'À publier', updated_at: quand };
  if (d.action === 'decaler') return { date_pub: d.nouvelleDate, updated_at: quand };
  throw new Error('action non autorisée');
}

/** Produits dont le nom + dimension contient tous les mots demandés (actifs seulement). */
export function trouverProduits(produits: ProduitLbc[], texte: string): ProduitLbc[] {
  return (produits || []).filter((p) => p && p.actif !== false && correspond(texte, `${p.nom || ''} ${p.dim || ''}`));
}

export function patchProduit(d: DemandeLbc, maintenant: number, quand: string): Record<string, unknown> {
  if (d.action === 'boost') return { boost_pct: Number(d.pct), boost_until: plus(jourParis(maintenant), Number(d.jours)), updated_at: quand };
  if (d.action === 'fin_boost') return { boost_pct: null, boost_until: null, updated_at: quand };
  if (d.action === 'poids_zone') return { [d.zone === 'idf' ? 'poids_idf' : 'poids_prov']: d.poids, updated_at: quand };
  throw new Error('action non autorisée');
}

/** Ce que Borhen voit (et rien d'autre) : aucune donnée client n'existe dans ces tables, mais on ne renvoie que l'utile. */
export const vueProduit = (p: ProduitLbc) => ({ id: p.id, nom: String(p.nom || '').slice(0, 120), dim: String(p.dim || '').slice(0, 20), boost_pct: p.boost_pct ?? null, boost_until: p.boost_until ?? null, poids_idf: p.poids_idf ?? null, poids_prov: p.poids_prov ?? null });
export const vueAnnonce = (a: AnnonceLbc) => ({ id: a.id, date_pub: String(a.date_pub || '').slice(0, 10), heure: String(a.heure || '').slice(0, 5), ville: String(a.ville || '').slice(0, 60), produit: String(a.produit || '').slice(0, 120), dim: String(a.dim || '').slice(0, 20), zone: zoneAnnonce(a), statut: String(a.statut || '').slice(0, 20) });

/** Le résultat relu après écriture est-il celui attendu ? (Auditor) */
/** Valeur comparable d'un champ produit, quel que soit son type en base (nombre ou texte) — réserve Codex #6 : « 50 » lu en
 *  texte vaut 50 ; une date est comparée sur AAAA-MM-JJ ; vide = null. */
export function normaliserChamp(k: string, v: unknown): string | number | null {
  if (v === null || v === undefined || v === '') return null;
  if (k === 'boost_pct' || k === 'poids_idf' || k === 'poids_prov') { const n = Number(v); return Number.isFinite(n) ? n : String(v); }
  if (k === 'boost_until') return String(v).slice(0, 10);
  return String(v);
}
export function verifierProduit(p: ProduitLbc | null, patch: Record<string, unknown>): boolean {
  if (!p) return false;
  return Object.entries(patch).every(([k, v]) => k === 'updated_at' || normaliserChamp(k, (p as Record<string, unknown>)[k]) === normaliserChamp(k, v));
}
export function verifierAnnonces(lues: AnnonceLbc[], ids: string[], patch: Record<string, unknown>): boolean {
  if (!Array.isArray(lues) || lues.length !== ids.length) return false;
  return lues.every((a) => ids.includes(a.id) && Object.entries(patch).every(([k, v]) => k === 'updated_at' || String((a as Record<string, unknown>)[k] ?? '').slice(0, k === 'date_pub' ? 10 : 99) === String(v)));
}

export function egal(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
