// ════════════════════════════════════════════════════════════════════
// Logique PURE de la porte d'entrée JARVIS (Edge Function jarvis-action) — v2, 30/10/2026
// ════════════════════════════════════════════════════════════════════
// v1 (27/10) : étiquette GLS, retour GLS, planifier, SAV, litige — après APERÇU et confirmation.
// v2 (30/10, décision de Borhen « autorisation totale sur commandes et stock », confirmation vocale en deux temps) :
//   liste FERMÉE étendue, chaque action portant un NIVEAU :
//     N1 lecture  : exécutée sans question ;
//     N2 réversible : aperçu → double accord vocal, mémorisable par « oui, toujours » (côté JARVIS) ;
//     N3 critique : aperçu → double accord vocal À CHAQUE FOIS, jamais mémorisable.
//   Hors liste, toujours : encaissement (marquer payé, montant encaissé, remboursement), Shopify, TikTok, tables secrètes.
// Ce module ne fait AUCUN appel réseau : il valide les demandes et construit les écritures. Testé en Node
// (supabase/tests/jarvis-action.test.mjs). Aucune valeur secrète, aucune donnée client ici (dépôt public).
// Cahier des charges : maxiconfort-brain/conception/JARVIS-LIVRAISON-AUTORISATION-TOTALE.md
// ════════════════════════════════════════════════════════════════════

export const VERSION = 'v2';

export type Niveau = 'N1' | 'N2' | 'N3';
export const NIVEAUX: Record<string, Niveau> = {
  lire_commande: 'N1', lister_commandes: 'N1', lire_stock: 'N1',
  creer_commande: 'N2', modifier_commande: 'N2', planifier: 'N2', deplacer: 'N2', changer_statut: 'N2',
  sav: 'N2', gls_etiquette: 'N2', gls_retour: 'N2', litige: 'N2',
  stock_entree: 'N2', stock_chargement: 'N2', stock_retour_depot: 'N2',
  annuler_commande: 'N3', supprimer_commande: 'N3', modifier_prix: 'N3', envoyer_sms: 'N3', marquer_livre: 'N3', stock_correction: 'N3',
};
export const ACTIONS = Object.keys(NIVEAUX);
/** Niveau effectif : créer une commande dont les coordonnées sont DICTÉES à la voix = N3 (décision Borhen 30/10 16:47). */
export function niveauDe(d: Demande): Niveau {
  if (d.action === 'creer_commande') return d.source === 'mail' ? 'N2' : 'N3';
  return NIVEAUX[d.action] || 'N3';
}

export const SAV_TYPES: Record<string, string> = { echange: 'Échange', reprise: 'Reprise', oubli: 'Livraison oubli' };
export const LITIGE_TYPES = ['perte', 'avarie', 'retour'];
export const LITIGE_STATUTS = ['a_declarer', 'reclamation_ouverte', 'dossier_envoye', 'indemnise', 'refuse'];
export const STATUTS_OUVERTS = ['en-attente', 'en-cours', 'reporté']; // changer_statut : seulement entre ceux-là
export const STATUTS_TERMINES = ['livré', 'annulé'];
export const LIVREURS = ['RANOU', 'GLS', 'KUNHGE ET NAGEL'];
export const ORIGINES = ['Téléphone', 'Leboncoin', 'Mail', 'Boutique', 'Site Maxiconfort', 'Autre'];
export const ANN_MOTIFS = ['Rupture de stock', 'Délai trop long', 'Client injoignable', 'Client a changé d\'avis', 'Problème de livraison', 'Prix / désaccord commercial', 'Doublon / erreur de commande', 'Motif inconnu / non communiqué par le client', 'Autre'];
export const STOCK_MOTIFS = ['reassort', 'retour_gls', 'reprise_sav', 'correction']; // contrainte de la table stock_entrees
/** Champs modifiables par JARVIS (N2). Tout le reste est refusé : prix / remises / frais (→ modifier_prix, N3), paiement
 *  (hors liste), statut (→ changer_statut), date (→ planifier / deplacer), litige (→ litige), suivi transporteur. */
export const CHAMPS_MODIFIABLES = ['client', 'tel', 'email', 'adresse', 'etage', 'ascenseur', 'code', 'produit', 'qte', 'lignes', 'instr'];
export const DEPARTEMENTS_RANOU = ['75', '77', '78', '91', '92', '93', '94', '95']; // Île-de-France = RANOU, sinon GLS

const ID_CMD = /^#(?:SAV)?\d{1,9}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TEL = /^(?:\+33\s?[1-9]|0[1-9])(?:[\s.-]?\d{2}){4}$/;

export function jourParis(t: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}
function dateValide(d: string): boolean {
  if (!DATE.test(d)) return false;
  const [a, m, j] = d.split('-').map(Number); const x = new Date(Date.UTC(a, m - 1, j));
  return x.getUTCFullYear() === a && x.getUTCMonth() === m - 1 && x.getUTCDate() === j;
}
function dateFuture(date: string, maintenant: number, jours = 60): string | null {
  if (!dateValide(date)) return 'date invalide (AAAA-MM-JJ)';
  const auj = jourParis(maintenant); const max = jourParis(maintenant + jours * 86400000);
  if (date < auj) return 'date passée';
  if (date > max) return `date trop lointaine (${jours} jours au plus)`;
  return null;
}
const texte = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const entier = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

export type Ligne = { produitId?: string | null; produit: string; qte: number; prixUnit?: number };
export type Demande = {
  action: string; cmdId?: string; date?: string; poids?: number; type?: string; produit_a_livrer?: string; produit_a_reprendre?: string; motif?: string;
  litige_type?: string; litige_statut?: string; litige_num?: string; litige_description?: string;
  // v2
  statut?: string; livreur?: string; champs?: Record<string, unknown>; prix?: number; texte?: string; commentaire?: string;
  client?: string; tel?: string; email?: string; adresse?: string; cp?: string; ville?: string; etage?: string; code?: string; instr?: string;
  lignes?: Ligne[]; origine?: string; source?: 'mail' | 'dictee'; produit?: string; qte?: number; limite?: number;
};

/** Contrôle de forme d'une demande (avant toute lecture). Renvoie un message d'erreur ou null. */
export function controlerDemande(d: Demande, maintenant = Date.now()): string | null {
  if (!ACTIONS.includes(d.action)) return 'action non autorisée pour JARVIS';
  const aCmd = !['lister_commandes', 'lire_stock', 'creer_commande', 'stock_entree', 'stock_chargement', 'stock_retour_depot', 'stock_correction'].includes(d.action);
  if (aCmd && !ID_CMD.test(String(d.cmdId || ''))) return 'numéro de commande invalide (ex. #1588)';
  switch (d.action) {
    case 'gls_retour':
      if (d.poids !== undefined && !(typeof d.poids === 'number' && d.poids > 0 && d.poids <= 40)) return 'poids du retour invalide (1 à 40 kg)';
      break;
    case 'planifier': case 'deplacer': {
      const e = dateFuture(String(d.date || ''), maintenant); if (e) return e;
      if (d.livreur !== undefined && !LIVREURS.includes(String(d.livreur))) return 'livreur inconnu (RANOU, GLS, KUNHGE ET NAGEL)';
      break;
    }
    case 'sav': {
      const e = dateFuture(String(d.date || ''), maintenant); if (e) return e;
      if (!SAV_TYPES[String(d.type || '')]) return 'type de SAV : échange, reprise ou livraison oubli (pas de remboursement depuis JARVIS)';
      if (texte(d.motif, 300).length < 3) return 'motif du SAV obligatoire';
      if (d.type !== 'reprise' && texte(d.produit_a_livrer, 120).length < 2) return 'produit à livrer obligatoire';
      if (d.type !== 'oubli' && texte(d.produit_a_reprendre, 120).length < 2) return 'produit à reprendre obligatoire';
      break;
    }
    case 'litige':
      if (d.litige_type && !LITIGE_TYPES.includes(d.litige_type)) return 'type de litige : perte, avarie ou retour';
      if (d.litige_statut && !LITIGE_STATUTS.includes(d.litige_statut)) return 'statut de litige inconnu';
      if (d.litige_num && !/^\d{13}$/.test(d.litige_num)) return 'n° de réclamation GLS : 13 chiffres';
      if (!d.litige_type && !d.litige_statut && !d.litige_num && !d.litige_description) return 'rien à mettre à jour';
      break;
    case 'lister_commandes':
      if (d.date !== undefined && !dateValide(String(d.date))) return 'date invalide (AAAA-MM-JJ)';
      if (d.statut !== undefined && ![...STATUTS_OUVERTS, ...STATUTS_TERMINES].includes(String(d.statut))) return 'statut inconnu';
      if (d.livreur !== undefined && !LIVREURS.includes(String(d.livreur))) return 'livreur inconnu';
      if (d.limite !== undefined && !entier(d.limite, 1, 100)) return 'limite : 1 à 100';
      break;
    case 'lire_stock':
      if (d.produit !== undefined && texte(d.produit, 80).length < 2) return 'produit invalide';
      break;
    case 'creer_commande': {
      if (d.source !== 'mail' && d.source !== 'dictee') return 'source obligatoire : mail (coordonnées lues) ou dictee (coordonnées dictées)';
      if (texte(d.client, 80).length < 2) return 'nom du client obligatoire';
      if (!TEL.test(texte(d.tel, 20))) return 'téléphone invalide (10 chiffres, ex. 06 12 34 56 78)';
      if (texte(d.adresse, 160).length < 5) return 'adresse obligatoire';
      if (!/^\d{5}$/.test(texte(d.cp, 5))) return 'code postal à 5 chiffres obligatoire';
      if (texte(d.ville, 60).length < 2) return 'ville obligatoire';
      if (!Array.isArray(d.lignes) || !d.lignes.length || d.lignes.length > 10) return 'au moins un produit (10 lignes au plus)';
      for (const l of d.lignes) { if (texte(l?.produit, 120).length < 2) return 'produit de la ligne obligatoire'; if (!entier(l?.qte, 1, 20)) return 'quantité : 1 à 20'; }
      if (d.date !== undefined) { const e = dateFuture(String(d.date), maintenant); if (e) return e; }
      if (d.origine !== undefined && !ORIGINES.includes(String(d.origine))) return 'origine inconnue (Téléphone, Leboncoin, Mail, Boutique, Site Maxiconfort, Autre)';
      break;
    }
    case 'modifier_commande': {
      const ch = d.champs; if (!ch || typeof ch !== 'object' || !Object.keys(ch).length) return 'rien à modifier';
      const interdits = Object.keys(ch).filter((k) => !CHAMPS_MODIFIABLES.includes(k));
      if (interdits.length) return 'champ non modifiable par JARVIS : ' + interdits.join(', ') + ' (prix → modifier_prix ; statut → changer_statut ; date → planifier)';
      if (ch.tel !== undefined && !TEL.test(texte(ch.tel, 20))) return 'téléphone invalide';
      if (ch.qte !== undefined && !entier(ch.qte, 1, 20)) return 'quantité : 1 à 20';
      if (ch.lignes !== undefined && (!Array.isArray(ch.lignes) || !ch.lignes.length)) return 'lignes invalides';
      break;
    }
    case 'changer_statut':
      if (!STATUTS_OUVERTS.includes(String(d.statut || ''))) return 'statut autorisé : en-attente, en-cours ou reporté (livré → marquer_livre ; annulé → annuler_commande)';
      break;
    case 'annuler_commande':
      if (texte(d.motif, 120).length < 3) return 'motif d\'annulation obligatoire';
      break;
    case 'supprimer_commande':
      if (texte(d.motif, 120).length < 3) return 'motif de suppression obligatoire';
      break;
    case 'modifier_prix':
      if (!(typeof d.prix === 'number' && Number.isFinite(d.prix) && d.prix >= 0 && d.prix <= 20000)) return 'prix invalide (0 à 20 000 €)';
      if (texte(d.motif, 200).length < 3) return 'motif du changement de prix obligatoire';
      break;
    case 'envoyer_sms': {
      const t = texte(d.texte, 320); if (t.length < 10) return 'texte du SMS trop court (10 caractères au moins)'; if (t.length > 300) return 'texte du SMS trop long (300 caractères au plus)';
      if (/https?:\/\//i.test(t)) return 'pas de lien dans un SMS envoyé par JARVIS';
      break;
    }
    case 'stock_entree':
      if (texte(d.produit, 80).length < 1) return 'produit obligatoire (identifiant de l\'appli)';
      if (!entier(d.qte, 1, 500)) return 'quantité : 1 à 500';
      if (d.motif !== undefined && !STOCK_MOTIFS.includes(String(d.motif))) return 'motif : reassort, retour_gls, reprise_sav ou correction';
      break;
    case 'stock_chargement': case 'stock_retour_depot':
      if (!LIVREURS.includes(String(d.livreur || ''))) return 'livreur obligatoire (RANOU, GLS, KUNHGE ET NAGEL)';
      if (texte(d.produit, 120).length < 2) return 'produit obligatoire';
      if (!entier(d.qte, 1, 100)) return 'quantité : 1 à 100';
      break;
    case 'stock_correction':
      if (texte(d.produit, 80).length < 1) return 'produit obligatoire (identifiant de l\'appli)';
      if (!entier(d.qte, 1, 500)) return 'quantité retirée : 1 à 500';
      if (texte(d.motif, 200).length < 3) return 'motif de la correction obligatoire';
      break;
  }
  return null;
}

/** Contrôle de la commande trouvée en base, selon l'action. */
export function controlerCommande(d: Demande, c: Record<string, unknown> | null): string | null {
  if (!['lister_commandes', 'lire_stock', 'creer_commande', 'stock_entree', 'stock_chargement', 'stock_retour_depot', 'stock_correction'].includes(d.action) && !c) return 'commande introuvable';
  if (!c) return null;
  const statut = String(c.statut || ''); const suivi = String(c.tracking_transporteur || '').trim(); const termine = STATUTS_TERMINES.includes(statut);
  const cp5 = /\b\d{5}\b/.test(String(c.adresse || ''));
  switch (d.action) {
    case 'gls_etiquette':
      if (termine) return `commande ${statut} : pas d'étiquette`;
      if (suivi) return 'cette commande a déjà une étiquette GLS (vérifier YourGLS avant d’en refaire une)';
      if (!cp5) return 'adresse sans code postal à 5 chiffres';
      break;
    case 'gls_retour': if (!cp5) return 'adresse sans code postal à 5 chiffres'; break;
    case 'planifier': case 'deplacer': case 'changer_statut': case 'modifier_commande':
      if (termine) return `commande ${statut} : plus modifiable (SAV pour une commande livrée)`;
      break;
    case 'sav': if (String(c.id || '').startsWith('#SAV')) return 'partir de la commande d’origine, pas d’un SAV'; break;
    case 'annuler_commande':
      if (statut === 'annulé') return 'commande déjà annulée';
      if (statut === 'livré') return 'commande livrée : pas d\'annulation (SAV ou retour)';
      break;
    case 'supprimer_commande':
      if (statut === 'livré') return 'commande livrée : suppression interdite (l\'historique doit rester)';
      if (String(c.stpaie || '') === 'Payé' || Number(c.montant_enc || 0) > 0) return 'commande avec un encaissement : suppression interdite, annuler à la place';
      if (suivi) return 'commande avec une étiquette GLS : suppression interdite, annuler à la place';
      break;
    case 'modifier_prix':
      if (String(c.payment_source || '') === 'SHOPIFY_ONLINE') return 'commande payée en ligne : le prix est verrouillé par la base (appli, administrateur)';
      if (statut === 'livré' && String(c.stpaie || '') === 'Payé') return 'commande livrée et payée : prix verrouillé';
      break;
    case 'marquer_livre':
      if (statut === 'livré') return 'commande déjà livrée';
      if (statut === 'annulé') return 'commande annulée : rien à livrer';
      if (String(c.transporteur || '') === 'GLS') return 'commande GLS : c\'est le suivi GLS qui marque la livraison';
      break;
    case 'envoyer_sms':
      if (!TEL.test(String(c.tel || '').trim())) return 'téléphone du client absent ou invalide sur la commande';
      break;
  }
  return null;
}

/** Aperçu SANS coordonnées complètes : commande, produit, statut, code postal et ville seulement. */
export function apercuCommande(c: Record<string, unknown>) {
  const adr = String(c.adresse || ''); const m = adr.match(/\b(\d{5})\s+([^,\n]{2,40})/);
  return { cmd: String(c.id || ''), produit: texte(c.produit, 120), statut: String(c.statut || ''), transporteur: String(c.transporteur || ''), date_livraison: String(c.date_livraison || ''),
    cp: m ? m[1] : null, ville: m ? texte(m[2], 40) : null, colis_suivis: String(c.tracking_transporteur || '').split(',').map((x) => x.trim()).filter(Boolean).length };
}
/** Fiche détaillée pour JARVIS (N1) : toujours sans téléphone, e-mail ni adresse complète ; les montants ne sont pas des données personnelles. */
export function ficheCommande(c: Record<string, unknown>) {
  const a = apercuCommande(c);
  const lignes = Array.isArray(c.lignes) ? (c.lignes as Ligne[]).slice(0, 10).map((l) => ({ produit: texte(l?.produit, 80), qte: Number(l?.qte) || 1 })) : null;
  return { ...a, client_initiales: initiales(String(c.client || '')), lignes, qte: Number(c.qte) || 1, prix: Number(c.prix) || 0, paie: String(c.paie || ''), stpaie: String(c.stpaie || ''),
    livreur: String(c.livreur || ''), etage: texte(c.etage, 10), ascenseur: String(c.ascenseur || ''), instr: texte(c.instr, 300), origine: String(c.origine || ''), date_commande: String(c.date_commande || ''),
    litige: c.litige_type || c.litige_statut ? { type: c.litige_type || null, statut: c.litige_statut || null } : null };
}
function initiales(nom: string): string { return nom.split(/\s+/).filter(Boolean).map((m) => m[0].toUpperCase() + '.').join(' ').slice(0, 12); }
/** Téléphone masqué pour un aperçu de SMS : 06 ** ** ** 78. */
export function telMasque(tel: string): string { const d = tel.replace(/\D/g, ''); return d.length >= 4 ? d.slice(0, 2) + ' ** ** ** ' + d.slice(-2) : '**'; }

/** Nouvelle commande SAV (même construction que l'appli : bloc SAV de maxiconfort-v7.html, sans remboursement). */
export function construireSav(d: Demande, o: Record<string, unknown>, maintenant = Date.now()): Record<string, unknown> {
  const libelle = SAV_TYPES[String(d.type)];
  const livrer = texte(d.produit_a_livrer, 120), reprendre = texte(d.produit_a_reprendre, 120);
  const instr = ['🔧 SAV ' + libelle.toUpperCase() + ' (cmd origine ' + String(o.id) + ')', livrer ? 'À LIVRER : ' + livrer : '', reprendre ? 'À REPRENDRE : ' + reprendre : '', 'Motif : ' + texte(d.motif, 300), 'Créé depuis JARVIS'].filter(Boolean).join('\n');
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

// ── v2 : constructions d'écriture ───────────────────────────────────────────────────────────────────────────────────────

/** Transporteur par défaut selon le code postal (règle de l'appli : Île-de-France = RANOU, province = GLS). */
export function transporteurPour(cp: string): string { return DEPARTEMENTS_RANOU.includes(String(cp).slice(0, 2)) ? 'RANOU' : 'GLS'; }

/** Prochain numéro de commande à partir des identifiants existants (même règle que l'appli v7.5.68 : max + 1). */
export function prochainNumero(ids: string[]): string {
  let max = 0; for (const id of ids) { const m = /^#(\d{1,9})$/.exec(String(id || '')); if (m) max = Math.max(max, Number(m[1])); }
  return '#' + (max + 1);
}

export type Catalogue = Map<string, { id: string; nom: string; prix: number; actif?: boolean; ancienne_offre?: boolean }>;
/** Lignes de commande prêtes à enregistrer : prix du catalogue quand le produit est connu (par identifiant ou nom exact), 0 sinon (à régler par
 *  modifier_prix). Une ancienne offre est refusée (règle du 09/10). Renvoie { lignes, erreur }. */
export function lignesCommande(lignes: Ligne[], catalogue: Catalogue): { lignes: Record<string, unknown>[]; erreur: string | null } {
  const out: Record<string, unknown>[] = [];
  for (const l of lignes) {
    const nom = texte(l.produit, 120);
    let p = l.produitId ? catalogue.get(String(l.produitId)) : undefined;
    if (!p) for (const x of catalogue.values()) if (x.nom.toLowerCase() === nom.toLowerCase()) { p = x; break; }
    if (p && p.ancienne_offre) return { lignes: [], erreur: `« ${p.nom} » est une ancienne offre : plus vendue` };
    if (p && p.actif === false) return { lignes: [], erreur: `« ${p.nom} » n'est plus au catalogue` };
    const pu = p ? Number(p.prix) || 0 : (typeof l.prixUnit === 'number' && l.prixUnit >= 0 ? l.prixUnit : 0);
    const q = Number(l.qte) || 1;
    out.push({ produitId: p ? p.id : null, produit: p ? p.nom : nom, qte: q, prixUnit: pu, prixBrut: pu * q, remiseLigne: 0, remiseVal: 0, remiseType: 'pct', sousTotal: pu * q });
  }
  return { lignes: out, erreur: null };
}

/** Nouvelle commande (mêmes colonnes que sbSaveCommande de l'appli). Paiement à la livraison par défaut : Espèces / Non payé. */
export function construireCommande(d: Demande, id: string, lignes: Record<string, unknown>[], maintenant = Date.now()): Record<string, unknown> {
  const total = lignes.reduce((s, l) => s + (Number(l.sousTotal) || 0), 0);
  const adresse = [texte(d.adresse, 160), texte(d.cp, 5) + ' ' + texte(d.ville, 60)].join(', ');
  const origine = d.origine ? String(d.origine) : (d.source === 'mail' ? 'Mail' : 'Téléphone');
  return {
    id, client: texte(d.client, 80), tel: texte(d.tel, 20), email: texte(d.email, 120), adresse, etage: texte(d.etage, 10), ascenseur: 'Non', code: texte(d.code, 40),
    produit: lignes.map((l) => (Number(l.qte) > 1 ? l.qte + '× ' : '') + l.produit).join(' + ').slice(0, 300), lignes, qte: lignes.reduce((s, l) => s + (Number(l.qte) || 1), 0),
    prix: total, prix_brut: total, frais_port: 0, stock_deduit: false, remise_globale: 0, remise_globale_val: 0, remise_globale_type: 'pct', remise_motif: '',
    paie: 'Espèces', stpaie: 'Non payé', montant_enc: 0, livreur: '', statut: 'en-attente', date_livraison: d.date || '', date_commande: jourParis(maintenant),
    instr: [texte(d.instr, 300), 'Créée depuis JARVIS (' + (d.source === 'mail' ? 'mail client' : 'dictée') + ')'].filter(Boolean).join('\n'),
    origine, ref_marketplace: '', transporteur: transporteurPour(texte(d.cp, 5)), tracking_transporteur: null, updated_at: new Date(maintenant).toISOString(),
  };
}

/** Modification (N2) : seulement les champs autorisés, nettoyés. L'adresse ou le produit changent → transporteur / étiquette à revoir : signalé dans l'aperçu. */
export function champsModification(d: Demande, c: Record<string, unknown>, maintenant = Date.now()): { apres: Record<string, unknown>; avant: Record<string, unknown>; avertissements: string[] } {
  const ch = d.champs || {}; const apres: Record<string, unknown> = { updated_at: new Date(maintenant).toISOString() }; const avant: Record<string, unknown> = {}; const av: string[] = [];
  for (const k of CHAMPS_MODIFIABLES) {
    if (ch[k] === undefined) continue;
    avant[k] = k === 'lignes' ? c[k] : (c[k] ?? '');
    apres[k] = k === 'qte' ? Number(ch[k]) : k === 'lignes' ? ch[k] : texte(ch[k], k === 'instr' ? 500 : k === 'adresse' ? 200 : 120);
  }
  if (apres.adresse !== undefined && String(c.tracking_transporteur || '').trim()) av.push('une étiquette GLS existe déjà avec l\'ancienne adresse');
  if (apres.adresse !== undefined && !/\b\d{5}\b/.test(String(apres.adresse))) av.push('nouvelle adresse sans code postal à 5 chiffres');
  if (apres.produit !== undefined || apres.lignes !== undefined) av.push('le prix n\'est pas recalculé (modifier_prix si besoin)');
  return { apres, avant, avertissements: av };
}

/** Planifier / déplacer : date, livreur-transporteur éventuel ; déplacer une commande dont la date est passée la met « reporté ». */
export function champsPlanification(d: Demande, c: Record<string, unknown>, maintenant = Date.now()): Record<string, unknown> {
  const p: Record<string, unknown> = { date_livraison: d.date, updated_at: new Date(maintenant).toISOString() };
  if (d.livreur) { p.transporteur = d.livreur; p.livreur = d.livreur === 'RANOU' ? 'RANOU' : ''; }
  if (d.action === 'deplacer') { const anc = String(c.date_livraison || ''); if (anc && anc < jourParis(maintenant) && String(c.statut) !== 'en-cours') p.statut = 'reporté'; }
  return p;
}

/** Annulation : statut + motif de la liste de l'appli (texte libre → « Autre » + commentaire) ; le déclencheur de la base pose annulation_par / _at. */
export function champsAnnulation(d: Demande, maintenant = Date.now()): Record<string, unknown> {
  const m = texte(d.motif, 120); const bas = m.toLowerCase();
  const connu = ANN_MOTIFS.find((x) => x !== 'Autre' && (x.toLowerCase() === bas || bas.includes(x.toLowerCase()))); // libellé exact ou contenu, jamais un mot isolé
  return { statut: 'annulé', annulation_motif: connu || 'Autre', annulation_commentaire: (connu ? texte(d.commentaire, 300) : m) || null, updated_at: new Date(maintenant).toISOString() };
}

/** Prix (N3) : nouveau prix total, remise effacée ; le motif part dans les instructions (la base n'a pas de colonne dédiée). */
export function champsPrix(d: Demande, c: Record<string, unknown>, maintenant = Date.now()): Record<string, unknown> {
  const instr = [String(c.instr || '').trim(), `💶 Prix ${Number(c.prix) || 0} € → ${d.prix} € (JARVIS, ${jourParis(maintenant)}) : ${texte(d.motif, 200)}`].filter(Boolean).join('\n').slice(0, 2000);
  return { prix: d.prix, prix_brut: d.prix, remise_globale: 0, remise_globale_val: 0, remise_motif: '', instr, updated_at: new Date(maintenant).toISOString() };
}

/** Entrée de stock constatée au dépôt (table stock_entrees). */
export function entreeStock(d: Demande, maintenant = Date.now()): Record<string, unknown> {
  return { app_produit_id: texte(d.produit, 80), quantite: d.qte, motif: d.motif || 'reassort', cmd_id: d.cmdId || null, saisi_par: 'JARVIS', remarque: texte(d.commentaire, 200) || null, date_entree: new Date(maintenant).toISOString() };
}
/** Mouvement camion (table mouvements_stock, même forme que logMouvementStock de l'appli). */
export function mouvementCamion(d: Demande): Record<string, unknown> {
  const charge = d.action === 'stock_chargement';
  return { type: charge ? 'chargement' : 'retour_depot', produit_libelle: texte(d.produit, 120), quantite: d.qte, source: charge ? 'depot' : 'camion:' + d.livreur, destination: charge ? 'camion:' + d.livreur : 'depot',
    commande_id: d.cmdId || null, tournee_id: null, livreur: d.livreur, par_user: 'JARVIS' };
}
/** Correction de stock en moins (N3) : la formule du stock ne connaît pas de sortie hors commande → alerte « stock-correction » à traiter au
 *  prochain comptage (table gls_alertes, déjà utilisée pour les alertes de stock), jamais une écriture silencieuse. */
export function alerteCorrectionStock(d: Demande, maintenant = Date.now()): Record<string, unknown> {
  return { type: 'stock-correction', cle: 'jarvis-' + maintenant, jour: jourParis(maintenant), cmd_id: d.cmdId || null,
    message: `JARVIS : −${d.qte} × ${texte(d.produit, 80)} — ${texte(d.motif, 200)} (à reporter au prochain comptage)`, envoye: false };
}

/** Estimation de stock disponible (N1) : dernier comptage validé − commandes non terminées créées depuis + entrées depuis. Étiquetée « estimation » :
 *  la formule exacte (classement des commandes, ensembles) est celle de stock-logique.ts / stock-sync-shopify. */
export function estimerStock(produitId: string, compte: number | null, finComptage: string | null, commandes: { statut: string; created_at?: string; lignes?: Ligne[] | null }[], entrees: { app_produit_id: string; quantite: number; date_entree: string }[]) {
  let consommees = 0;
  for (const c of commandes) {
    if (STATUTS_TERMINES.includes(String(c.statut))) continue;
    if (finComptage && c.created_at && c.created_at < finComptage) continue;
    for (const l of c.lignes || []) if (String(l?.produitId || '') === produitId) consommees += Number(l.qte) || 1;
  }
  const entr = entrees.filter((e) => e.app_produit_id === produitId && (!finComptage || e.date_entree >= finComptage)).reduce((s, e) => s + (Number(e.quantite) || 0), 0);
  return { produit: produitId, compte, fin_comptage: finComptage, commandes_en_cours: consommees, entrees: entr, disponible_estime: compte === null ? null : compte - consommees + entr };
}

/** Comparaison à temps constant (secret de la porte JARVIS). */
export function egal(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
