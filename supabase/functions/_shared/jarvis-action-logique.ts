// ════════════════════════════════════════════════════════════════════
// Logique PURE de la porte d'entrée JARVIS (Edge Function jarvis-action) — 27/10/2026
// ════════════════════════════════════════════════════════════════════
// Demande de Borhen : depuis JARVIS (MAXI BRAIN), créer une étiquette GLS, un retour GLS, mettre une commande en planning,
// créer un SAV, mettre à jour un litige — toujours après un APERÇU et sa confirmation.
// Ce module ne fait AUCUN appel réseau : il valide les demandes et construit les écritures. Testé en Node
// (supabase/tests/jarvis-action.test.mjs). Aucune valeur secrète, aucune donnée client ici (dépôt public).
// Hors liste : aucune suppression, aucun paiement / remboursement, aucun changement de prix, aucun SMS.
// ════════════════════════════════════════════════════════════════════

export const ACTIONS = ['gls_etiquette', 'gls_retour', 'planifier', 'sav', 'litige'] as const;
export const SAV_TYPES: Record<string, string> = { echange: 'Échange', reprise: 'Reprise', oubli: 'Livraison oubli' };
export const LITIGE_TYPES = ['perte', 'avarie', 'retour'];
export const LITIGE_STATUTS = ['a_declarer', 'reclamation_ouverte', 'dossier_envoye', 'indemnise', 'refuse'];

const ID_CMD = /^#(?:SAV)?\d{1,9}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function jourParis(t: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}
function dateValide(d: string): boolean {
  if (!DATE.test(d)) return false;
  const [a, m, j] = d.split('-').map(Number); const x = new Date(Date.UTC(a, m - 1, j));
  return x.getUTCFullYear() === a && x.getUTCMonth() === m - 1 && x.getUTCDate() === j;
}
const texte = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

export type Demande = { action: string; cmdId?: string; date?: string; poids?: number; type?: string; produit_a_livrer?: string; produit_a_reprendre?: string; motif?: string;
  litige_type?: string; litige_statut?: string; litige_num?: string; litige_description?: string };

/** Contrôle de forme d'une demande (avant toute lecture). Renvoie un message d'erreur ou null. */
export function controlerDemande(d: Demande, maintenant = Date.now()): string | null {
  if (!ACTIONS.includes(d.action as typeof ACTIONS[number])) return 'action non autorisée pour JARVIS';
  if (!ID_CMD.test(String(d.cmdId || ''))) return 'numéro de commande invalide (ex. #1588)';
  if (d.action === 'gls_retour' && d.poids !== undefined && !(typeof d.poids === 'number' && d.poids > 0 && d.poids <= 40)) return 'poids du retour invalide (1 à 40 kg)';
  if (d.action === 'planifier' || d.action === 'sav') {
    const date = String(d.date || '');
    if (!dateValide(date)) return 'date invalide (AAAA-MM-JJ)';
    const auj = jourParis(maintenant); const max = jourParis(maintenant + 60 * 86400000);
    if (date < auj) return 'date passée';
    if (date > max) return 'date trop lointaine (60 jours au plus)';
  }
  if (d.action === 'sav') {
    if (!SAV_TYPES[String(d.type || '')]) return 'type de SAV : échange, reprise ou livraison oubli (pas de remboursement depuis JARVIS)';
    if (texte(d.motif, 300).length < 3) return 'motif du SAV obligatoire';
    if (d.type !== 'reprise' && texte(d.produit_a_livrer, 120).length < 2) return 'produit à livrer obligatoire';
    if (d.type !== 'oubli' && texte(d.produit_a_reprendre, 120).length < 2) return 'produit à reprendre obligatoire';
  }
  if (d.action === 'litige') {
    if (d.litige_type && !LITIGE_TYPES.includes(d.litige_type)) return 'type de litige : perte, avarie ou retour';
    if (d.litige_statut && !LITIGE_STATUTS.includes(d.litige_statut)) return 'statut de litige inconnu';
    if (d.litige_num && !/^\d{13}$/.test(d.litige_num)) return 'n° de réclamation GLS : 13 chiffres';
    if (!d.litige_type && !d.litige_statut && !d.litige_num && !d.litige_description) return 'rien à mettre à jour';
  }
  return null;
}

/** Contrôle de la commande trouvée en base, selon l'action. */
export function controlerCommande(d: Demande, c: Record<string, unknown> | null): string | null {
  if (!c) return 'commande introuvable';
  const statut = String(c.statut || ''); const suivi = String(c.tracking_transporteur || '').trim();
  if (d.action === 'gls_etiquette') {
    if (['livré', 'annulé'].includes(statut)) return `commande ${statut} : pas d'étiquette`;
    if (suivi) return 'cette commande a déjà une étiquette GLS (vérifier YourGLS avant d’en refaire une)';
    if (!/\b\d{5}\b/.test(String(c.adresse || ''))) return 'adresse sans code postal à 5 chiffres';
  }
  if (d.action === 'gls_retour' && !/\b\d{5}\b/.test(String(c.adresse || ''))) return 'adresse sans code postal à 5 chiffres';
  if (d.action === 'planifier' && ['livré', 'annulé'].includes(statut)) return `commande ${statut} : rien à planifier`;
  if (d.action === 'sav' && String(c.id || '').startsWith('#SAV')) return 'partir de la commande d’origine, pas d’un SAV';
  return null;
}

/** Aperçu SANS coordonnées complètes : commande, produit, statut, code postal et ville seulement. */
export function apercuCommande(c: Record<string, unknown>) {
  const adr = String(c.adresse || ''); const m = adr.match(/\b(\d{5})\s+([^,\n]{2,40})/);
  return { cmd: String(c.id || ''), produit: texte(c.produit, 120), statut: String(c.statut || ''), transporteur: String(c.transporteur || ''), date_livraison: String(c.date_livraison || ''),
    cp: m ? m[1] : null, ville: m ? texte(m[2], 40) : null, colis_suivis: String(c.tracking_transporteur || '').split(',').map((x) => x.trim()).filter(Boolean).length };
}

/** Nouvelle commande SAV (même construction que l'appli : bloc SAV de maxiconfort-v7.html, sans remboursement). */
export function construireSav(d: Demande, o: Record<string, unknown>, maintenant = Date.now()): Record<string, unknown> {
  const libelle = SAV_TYPES[String(d.type)];
  const livrer = texte(d.produit_a_livrer, 120), reprendre = texte(d.produit_a_reprendre, 120);
  const instr = ['🔧 SAV ' + libelle.toUpperCase() + ' (cmd origine ' + String(o.id) + ')', livrer ? 'À LIVRER : ' + livrer : '', reprendre ? 'À REPRENDRE : ' + reprendre : '', 'Motif : ' + texte(d.motif, 300), 'Créé depuis JARVIS (validé par Borhen)'].filter(Boolean).join('\n');
  return {
    id: '#SAV' + String(maintenant).slice(-7),
    client: o.client || '', tel: o.tel || '', email: o.email || '', adresse: o.adresse || '', etage: o.etage || '', ascenseur: o.ascenseur || 'Non', code: o.code || '',
    produit: livrer || (libelle + ' — ' + reprendre), lignes: null, qte: 1, prix: 0, prix_brut: 0, frais_port: 0,
    paie: 'Déjà payé', stpaie: 'Payé', montant_enc: 0, livreur: '', statut: 'en-attente', date_livraison: d.date, date_commande: jourParis(maintenant),
    instr, origine: 'SAV - ' + libelle, transporteur: o.transporteur || 'RANOU', updated_at: new Date(maintenant).toISOString(),
  };
}

/** Champs de litige à écrire (seulement ceux fournis). */
export function champsLitige(d: Demande, maintenant = Date.now()): Record<string, unknown> {
  const p: Record<string, unknown> = { updated_at: new Date(maintenant).toISOString() };
  if (d.litige_type) p.litige_type = d.litige_type;
  if (d.litige_statut) p.litige_statut = d.litige_statut;
  if (d.litige_num) { p.litige_num_reclamation = d.litige_num; if (!d.litige_statut) p.litige_statut = 'reclamation_ouverte'; }
  if (d.litige_description) p.litige_description = texte(d.litige_description, 500);
  return p;
}

/** État actuel du dossier litige montré dans l'aperçu (avant → après), description comprise, bornée à 500 caractères. */
export function avantLitige(c: Record<string, unknown>) {
  const v = (x: unknown) => (x === null || x === undefined || String(x).trim() === '' ? null : String(x));
  const d = v(c.litige_description);
  return { type: v(c.litige_type), statut: v(c.litige_statut), num: v(c.litige_num_reclamation), description: d === null ? null : d.slice(0, 500) };
}

/** Comparaison à temps constant (secret de la porte JARVIS). */
export function egal(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
