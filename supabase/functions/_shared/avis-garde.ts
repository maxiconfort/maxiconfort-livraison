// ════════════════════════════════════════════════════════════════════
// Garde des demandes d'avis Google (sms-avis, sms-avis-relance) — 28/09/2026
// ════════════════════════════════════════════════════════════════════
// Module PUR (testé en Node : supabase/tests/avis-garde.test.mjs).
//
// RÈGLE DURABLE « pas d'avis pendant un litige ou un SAV » :
//  1. Jamais de demande (ni relance) si :
//     - note de commande « PAS D'AVIS » / « SANS AVIS » / « NO AVIS » (manuel, définitif) ;
//     - commande non livrée ou non payée (stpaie ≠ « Payé »), ou livraison GLS
//       partielle / retour / colis jamais scanné / en transit (gls_livraison_etat) ;
//     - litige ouvert (litige_statut non vide et pas indemnise/refuse/clos…) ;
//     - SAV ouvert lié (commande #SAV… non livrée/non annulée dont la note cite
//       la commande d'origine, ex. « cmd origine #1561 »).
//  2. À la clôture (litige clos ET tous les SAV liés livrés), la séquence reprend
//     avec UNE SEULE demande d'avis à J+2 après la dernière clôture (fenêtre de
//     3 jours J+2..J+4 pour rattraper un cron manqué), et AUCUNE relance.
//     Si une demande avait déjà été envoyée avant le litige : rien de plus.
//  3. Note « PAS D AVIS » sous TOUTES ses formes (y compris le marqueur automatique
//     « PAS D AVIS - litige/SAV ouvert (JJ/MM/AAAA). ») = exclusion DÉFINITIVE, même
//     après clôture (consigne du 28/09/2026 soir ; avant : marqueur provisoire).
//     La reprise J+2 ne concerne donc que les dossiers SANS cette note.
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any

export const LITIGE_FERMES = ['indemnise', 'refuse', 'clos', 'close', 'cloture', 'resolu', 'termine', 'ferme'];

// Marqueur de SUSPENSION PROVISOIRE posé automatiquement le 28/09/2026 sur les
// commandes ayant un litige/SAV ouvert : « PAS D AVIS - litige/SAV ouvert (JJ/MM/AAAA). »
// Il n'est PAS une exclusion définitive : il bloque tant qu'aucune clôture n'est
// prouvée (litige clos daté ou SAV liés livrés) ; après clôture, il est ignoré et
// la reprise J+2 s'applique. Tout autre « PAS D AVIS » (posé à la main par Borhen)
// reste une exclusion DÉFINITIVE.
const RE_MARQUEUR_SUSPENSION = /pas\s+d.?\s*avis\s*-\s*litige\s*\/\s*sav\s+ouvert\s*\(\d{1,2}\/\d{1,2}\/\d{2,4}\)\.?/gi;

export function marqueurSuspension(instr: string | null | undefined): boolean {
  return new RegExp(RE_MARQUEUR_SUSPENSION.source, 'i').test(String(instr || ''));
}

/**
 * Exclusion DÉFINITIVE : TOUTE note « PAS D'AVIS » (manuelle OU marqueur automatique du 28/09),
 * même après la clôture du litige/SAV. Consigne Borhen du 28/09/2026 : la note « PAS D AVIS »
 * reste définitive pour les demandes d'avis. Aucun traitement automatique ne l'efface.
 */
export function noteExclut(instr: string | null | undefined): boolean {
  const clean = String(instr || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  return /\b(noavis|no avis|sans avis|pas d avis|pas avis|pasdavis)\b/.test(clean);
}

// États gls_livraison_etat (gls-sync / _shared/gls-analyse.ts) qui interdisent une demande d'avis :
// un colis jamais scanné, encore en route ou revenu = livraison incomplète.
export const GLS_ETATS_BLOQUANTS = ['partiel', 'retour', 'non_pris_en_charge', 'transit'];

export function litigeOuvert(statut: string | null | undefined): boolean {
  const s = String(statut || '').trim().toLowerCase();
  return s !== '' && !LITIGE_FERMES.includes(s);
}

export function estSav(id: string | null | undefined): boolean {
  return /sav/i.test(String(id || ''));
}

/** Commandes citées par la note d'un SAV (hors n° « site #… » Shopify et hors le SAV lui-même). */
export function commandesCitees(instr: string | null | undefined, savId = ''): string[] {
  const txt = String(instr || '');
  const out = new Set<string>();
  const re = /#\s?(SAV\d+|\d{3,6})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(txt))) {
    const avant = txt.substring(Math.max(0, m.index - 12), m.index).toLowerCase();
    if (/(site|shopify|web)\s*$/.test(avant)) continue; // n° de commande Shopify, pas un id de l'app
    const id = '#' + m[1].toUpperCase();
    if (id !== String(savId).toUpperCase()) out.add(id);
  }
  return [...out];
}

export type SavInfo = { id: string; statut: string; ouvert: boolean; cloture: string | null };

/** Index « commande d'origine → SAV liés » (SAV annulés ignorés). */
export function indexerSav(savs: any[]): Map<string, SavInfo[]> {
  const idx = new Map<string, SavInfo[]>();
  for (const s of savs || []) {
    if (!estSav(s.id)) continue;
    const statut = String(s.statut || '');
    if (statut === 'annulé') continue;
    const ouvert = statut !== 'livré';
    const cloture = ouvert ? null : (String(s.date_livraison || '').match(/^\d{4}-\d{2}-\d{2}/)?.[0] || String(s.updated_at || '').substring(0, 10) || null);
    for (const cible of commandesCitees(s.instr, s.id)) {
      const l = idx.get(cible) || [];
      l.push({ id: s.id, statut, ouvert, cloture });
      idx.set(cible, l);
    }
  }
  return idx;
}

export function ajouterJours(ymd: string, j: number): string {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + j);
  return d.toISOString().substring(0, 10);
}

export function ymdParis(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(String(iso));
  if (isNaN(t)) return null;
  return new Date(t).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
}

export type EvalAvis = {
  bloque: string | null;          // motif de blocage (null = pas bloqué)
  historique: boolean;            // a eu un litige ou un SAV (même clos)
  cloture: string | null;         // date (YYYY-MM-DD) de la dernière clôture litige/SAV
  savOuverts: string[];
  savLies: string[];
};

/** Évalue une commande (ligne de la table commandes) pour les demandes d'avis. */
export function evaluerAvis(c: any, savIdx: Map<string, SavInfo[]>): EvalAvis {
  const savs = savIdx.get(String(c.id || '').toUpperCase()) || savIdx.get(String(c.id || '')) || [];
  const savOuverts = savs.filter((s) => s.ouvert).map((s) => s.id);
  const litigeHist = String(c.litige_statut || '').trim() !== '' || !!c.litige_clos_at;
  const historique = litigeHist || savs.length > 0;
  const dates: string[] = [];
  if (c.litige_clos_at && !litigeOuvert(c.litige_statut)) { const d = ymdParis(c.litige_clos_at); if (d) dates.push(d); }
  for (const s of savs) if (!s.ouvert && s.cloture) dates.push(s.cloture);
  const cloture = dates.length ? dates.sort()[dates.length - 1] : null;
  const r: EvalAvis = { bloque: null, historique, cloture, savOuverts, savLies: savs.map((s) => s.id) };

  if (estSav(c.id)) r.bloque = 'commande SAV';
  else if (noteExclut(c.instr)) r.bloque = 'note PAS D AVIS';
  else if (c.statut !== 'livré') r.bloque = 'non livree (' + (c.statut || '?') + ')';
  else if (c.stpaie !== 'Payé') r.bloque = 'paiement non confirme (' + (c.stpaie || '?') + ')';
  else if (GLS_ETATS_BLOQUANTS.includes(c.gls_livraison_etat)) r.bloque = 'livraison GLS ' + c.gls_livraison_etat + (c.gls_livraison_detail ? ' (' + c.gls_livraison_detail + ')' : '');
  else if (litigeOuvert(c.litige_statut)) r.bloque = 'litige ouvert (' + c.litige_statut + ')';
  else if (savOuverts.length) r.bloque = 'SAV ouvert ' + savOuverts.join(',');
  else if (litigeHist && !c.litige_clos_at && !litigeOuvert(c.litige_statut)) {
    // litige clos avant la migration 021 (date de clôture inconnue) : on ne relance pas la séquence
    r.bloque = 'litige clos sans date de cloture';
  } else if (marqueurSuspension(c.instr) && !cloture) {
    // marqueur provisoire présent mais aucune clôture prouvée (dossier non rattaché, ex. SAV
    // sans « cmd origine ») : on reste suspendu
    r.bloque = 'marqueur litige/SAV ouvert (aucune cloture prouvee)';
  }
  if (marqueurSuspension(c.instr)) r.historique = true; // jamais de relance après un dossier
  return r;
}

/**
 * Date (YYYY-MM-DD) à laquelle la 1re demande d'avis devient due :
 *  - cas normal : lendemain de la livraison ;
 *  - après un litige/SAV clos : max(lendemain de la livraison, clôture + 2 jours).
 */
export function dateDemandeAvis(dateLivraison: string, ev: EvalAvis): string {
  const normale = ajouterJours(dateLivraison, 1);
  if (!ev.historique || !ev.cloture) return normale;
  const reprise = ajouterJours(ev.cloture, 2);
  return reprise > normale ? reprise : normale;
}

/** La demande est-elle à envoyer aujourd'hui ? (fenêtre de 3 jours : due..due+2) */
export function demandeDueAujourdhui(dateLivraison: string, ev: EvalAvis, aujourdhui: string): 'oui' | 'trop_tot' | 'expiree' {
  const due = dateDemandeAvis(dateLivraison, ev);
  if (aujourdhui < due) return 'trop_tot';
  if (aujourdhui > ajouterJours(due, 2)) return 'expiree';
  return 'oui';
}

// ════════════════════════════════════════════════════════════════════
// v2.1 (02/10/2026) — ANTI-DOUBLON DURABLE (sms_historique) + GLS en direct
// ════════════════════════════════════════════════════════════════════
// Constat du 02/10 : sms_envoyes est PAR COMMANDE. Un client avec 2-3
// commandes recevait une demande par commande (même jour ou à quelques jours),
// et un numéro mal saisi sur une commande faisait partir le SMS chez un autre
// client. sms_historique (journal de tous les SMS, sans n° de commande) est la
// source durable : on y vérifie le NUMÉRO.
//  - même étape (avis / avis-relance / avis-relance2) déjà « envoyé » à ce
//    numéro depuis DELAI_ANTI_DOUBLON_JOURS (60 j) → pas d'envoi ;
//  - MAX_ECHECS échecs OVH de cette étape vers ce numéro en 7 jours → on
//    arrête de réessayer (numéro invalide) ; un échec isolé est réessayé.
// ════════════════════════════════════════════════════════════════════

export const DELAI_ANTI_DOUBLON_JOURS = 60;
export const MAX_ECHECS = 3;

/** Clé de numéro : 9 derniers chiffres (06…, +33 6…, 0033 6… → même clé). */
export function telCle(tel: string | null | undefined): string {
  const d = String(tel || '').replace(/[^0-9]/g, '');
  return d.length >= 9 ? d.slice(-9) : '';
}

export type LigneHisto = { tel: string; type_sms: string; statut: string; date_sms: string };

/** Motif de blocage d'après sms_historique (null = envoi autorisé). */
export function gardeHistorique(type: string, tel: string, histo: LigneHisto[], aujourdhui: string): string | null {
  const cle = telCle(tel);
  if (!cle) return null;
  const depuis = ajouterJours(aujourdhui, -DELAI_ANTI_DOUBLON_JOURS);
  const memes = (histo || []).filter((h) => h && h.type_sms === type && telCle(h.tel) === cle);
  const envoye = memes.filter((h) => h.statut === 'envoyé' && String(h.date_sms || '') >= depuis)
    .map((h) => String(h.date_sms)).sort().pop();
  if (envoye) return `${type} deja envoye a ce numero le ${envoye} (< ${DELAI_ANTI_DOUBLON_JOURS} j)`;
  const d7 = ajouterJours(aujourdhui, -7);
  const echecs = memes.filter((h) => h.statut === 'échec' && String(h.date_sms || '') >= d7).length;
  if (echecs >= MAX_ECHECS) return `${echecs} echecs OVH en 7 j vers ce numero (numero a verifier)`;
  return null;
}

/**
 * Verdict sur la relecture GLS en direct (résultat de analyserCommande, ou null si aucun n° de colis).
 * Bloque : partiel, retour, non pris en charge, transit, colis jamais scanné, et GLS illisible
 * sauf si la base confirme déjà « livre » (gls_livraison_etat). Null = autorisé.
 */
export function motifGls(a: { etat: string; detail?: string; colis?: { etat: string }[] } | null, c: any): string | null {
  if (!/gls/i.test(String(c?.transporteur || ''))) return null;
  if (!a) return c?.gls_livraison_etat === 'livre' ? null : 'GLS sans numero de colis (livraison non verifiable)';
  if (a.etat === 'livre') return null;
  if (a.etat === 'erreur') return c?.gls_livraison_etat === 'livre' ? null : `GLS illisible (${a.detail || 'erreur'}), verification impossible`;
  const jamais = (a.colis || []).filter((x) => x.etat === 'donnees_seules' || x.etat === 'inconnu').length;
  return `GLS ${a.etat} (${a.detail || ''})` + (jamais ? ` ; ${jamais} colis jamais scanne(s)` : '');
}
