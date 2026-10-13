// ════════════════════════════════════════════════════════════════════
// Rapprochement « avis Google ↔ client livré » — 13/10/2026 (décision Borhen)
// ════════════════════════════════════════════════════════════════════
// Module PUR (testé en Node : supabase/tests/avis-garde.test.mjs), utilisé par le
// script local qui lit les avis Google. But : arrêter les relances d'un client qui a
// DÉJÀ laissé son avis, quelle que soit sa note.
//
// RÈGLES :
//  - la NOTE n'entre JAMAIS dans le rapprochement ni dans le blocage (pas de tri des avis) ;
//  - CERTAIN  : un seul client porte ce nom (au moins 2 mots du nom concordent, tous les mots
//               du nom le plus court sont retrouvés) et les dates sont cohérentes ;
//  - PROBABLE : un seul client possible sur un seul mot distinctif, avis arrivé juste après
//               un de ses SMS de demande d'avis ;
//  - AMBIGU   : plusieurs clients possibles (homonymes), pseudo, prénom seul… ;
//  - seuls les CERTAINS sont marqués automatiquement ; PROBABLE et AMBIGU attendent une
//    validation humaine (nom du conjoint, pseudo : jamais de rapprochement forcé).
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any

const CIVILITES = new Set(['mr', 'mme', 'mlle', 'madame', 'monsieur', 'mademoiselle']);

/** Mots utiles d'un nom : sans accent, minuscules, lettres seules, au moins 3 lettres, sans civilité. */
export function motsDuNom(nom: string | null | undefined): string[] {
  return String(nom || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]+/g, ' ').split(' ').filter((m) => m.length >= 3 && !CIVILITES.has(m));
}

function distance1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, ecarts = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++ecarts > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return ecarts + (a.length - i) + (b.length - j) <= 1;
}

/** Deux mots désignent-ils le même nom ? (identiques, une lettre d'écart, ou l'un commence par l'autre) */
export function motsProches(a: string, b: string): 'exact' | 'proche' | null {
  if (a === b) return 'exact';
  if (a.length >= 5 && b.length >= 5 && distance1(a, b)) return 'proche';
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return 'proche';
  return null;
}

export type ClientLivre = { id: string; client: string; tel?: string | null; livree?: string | null; sms?: { type: string; date: string }[] };
export type AvisGoogle = { nom: string; date?: string | null; texte?: string | null };
export type Rapprochement = {
  niveau: 'certain' | 'probable' | 'ambigu' | 'aucun';
  raison: string;
  candidats: { id: string; client: string; force: 'forte' | 'faible' }[];
};

function jours(a: string, b: string): number {
  return Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 86400000);
}

/** Les dates sont-elles compatibles ? (avis après la livraison, au plus 60 jours après ; marge de 3 jours) */
function datesCoherentes(avis: AvisGoogle, c: ClientLivre): boolean {
  const d = String(avis.date || '').substring(0, 10), l = String(c.livree || '').substring(0, 10);
  if (!d || !l) return true;
  const ecart = jours(d, l);
  return ecart >= -3 && ecart <= 60;
}

export function rapprocherAvis(avis: AvisGoogle, clients: ClientLivre[]): Rapprochement {
  const mots = motsDuNom(avis.nom);
  if (!mots.length) return { niveau: 'aucun', raison: 'nom Google inexploitable', candidats: [] };
  const candidats: { c: ClientLivre; force: 'forte' | 'faible'; distinctif: boolean }[] = [];
  for (const c of clients || []) {
    const cm = motsDuNom(c.client);
    if (!cm.length || !datesCoherentes(avis, c)) continue;
    let exacts = 0, proches = 0, distinctif = false;
    const pris = new Set<number>();
    for (const m of mots) {
      let trouve: 'exact' | 'proche' | null = null, ou = -1;
      cm.forEach((x, i) => { if (pris.has(i)) return; const r = motsProches(m, x); if (r === 'exact' && trouve !== 'exact') { trouve = 'exact'; ou = i; } else if (r === 'proche' && !trouve) { trouve = 'proche'; ou = i; } });
      if (trouve) { pris.add(ou); if (trouve === 'exact') exacts++; else proches++; if (m.length >= 5) distinctif = true; }
    }
    const total = exacts + proches;
    if (!total) continue;
    const forte = total >= 2 && exacts >= 1 && total >= Math.min(mots.length, cm.length);
    candidats.push({ c, force: forte ? 'forte' : 'faible', distinctif });
  }
  // un même client peut avoir plusieurs fiches : on raisonne par numéro de téléphone quand il existe
  const cle = (c: ClientLivre) => { const d = String(c.tel || '').replace(/[^0-9]/g, ''); return d.length >= 9 ? d.slice(-9) : 'fiche:' + c.id; };
  const fortes = candidats.filter((x) => x.force === 'forte'), personnesFortes = new Set(fortes.map((x) => cle(x.c)));
  const liste = (l: typeof candidats) => l.map((x) => ({ id: x.c.id, client: x.c.client, force: x.force }));
  if (personnesFortes.size === 1) return { niveau: 'certain', raison: 'nom complet concordant, un seul client possible, dates cohérentes', candidats: liste(fortes) };
  if (personnesFortes.size > 1) return { niveau: 'ambigu', raison: personnesFortes.size + ' clients portent ce nom', candidats: liste(fortes) };
  const faibles = candidats, personnes = new Set(faibles.map((x) => cle(x.c)));
  if (!faibles.length) return { niveau: 'aucun', raison: 'aucun client livré ne porte ce nom (pseudo, conjoint ou autre personne)', candidats: [] };
  if (personnes.size === 1 && faibles[0].distinctif && avis.date) {
    const d = String(avis.date).substring(0, 10);
    const apresSms = (faibles[0].c.sms || []).some((s) => /^avis/.test(s.type) && jours(d, String(s.date).substring(0, 10)) >= 0 && jours(d, String(s.date).substring(0, 10)) <= 4);
    if (apresSms) return { niveau: 'probable', raison: 'un seul mot du nom concorde, un seul client possible, avis dans les 4 jours suivant un SMS de demande', candidats: liste(faibles) };
  }
  return { niveau: 'ambigu', raison: personnes.size > 1 ? personnes.size + ' clients possibles sur un seul mot du nom' : 'un seul mot du nom concorde (prénom, pseudo ou nom partiel)', candidats: liste(faibles) };
}
