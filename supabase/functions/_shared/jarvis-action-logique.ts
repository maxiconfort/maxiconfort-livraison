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
// v2.18 (25/11/2026, arrivage de matelas) : produit NON VENDABLE (prix de vente à définir, migration 039 : colonnes vendable /
//   prix_vente_defini, ou ensemble dont un composant l'est) — jamais rapproché d'un nom dicté, refusé dans une nouvelle commande.
//   LECTURE seulement (catalogueDepuisBase) ; la base refuse aussi ces lignes (déclencheur commandes_produit_vendable_garde).
// v2.12 (11/11/2026, vidéo 21:21 « tous ceux qui sont absents aujourd'hui, tu les mets pour demain ») : déplacer une commande au
//   statut « absent » (posé par le livreur sur l'arrêt de sa tournée) vers une AUTRE date la passe à « reporté » — sinon elle gardait
//   « absent » dans la liste des commandes alors qu'elle est replanifiée, et serait relue le lendemain comme une absente du jour.
// v2.4 (09/11/2026) : compter_commandes par origine et par jour de prise de commande, + montant hors annulées.
// v2.16 (17/11/2026, vidéo Borhen 15:47 « envoie-lui sa facture par SMS ») : envoyer_facture_sms { cmdId } (N3) — la facture de la commande
//   par SMS, pour les clients sans e-mail. JARVIS n'envoie QUE le numéro de commande : le SERVEUR construit le lien (même page que
//   lien_facture) et compose un texte FIXE (aucun texte libre, ni prix ni promesse), vers le portable de CETTE commande seulement.
//   L'aperçu montre le destinataire masqué et « [lien de la facture] » à la place du lien : le lien réel ne sort jamais vers JARVIS. factureSms.
// v2.14 (15/11/2026) : credits_sms (N1) — « combien de crédits SMS reste-t-il ? » : lecture seule du solde du compte OVH (GET /sms/{service}),
//   état ok / bas / zéro / indisponible, seuil SEUIL_CREDITS_SMS_BAS ; jamais de secret, jamais d'envoi ; OVH muet = « solde indisponible », jamais un faux « ok ». resumeCredits.
// v2.13 (14/11/2026) : sms_statut (N1) — « un SMS est-il parti pour la commande N ? » : journal de la commande (envois réussis, heure exacte) + journal
// général par numéro de téléphone (échecs, envois manuels, heure indicative). Lecture seule ; jamais le texte, le numéro ni le nom. resumeSms.
// v2.10 (10/11/2026, vidéo 17:01 « comment faire pour voir si GLS a pris son colis ? ») : suivi_gls (N1) — suivi GLS EN DIRECT d'une
//   commande (lecture seule, via gls-sync en mode audit) : prise en charge, dernier événement et son libellé, livraison, retour, par colis.
// v2.9 (10/11/2026, « go recherche nom ») : recherche approchée par nom — voyelles mal entendues tolérées (« Myriam Zeroual » ≈ « Meryem zaroual »).
// v2.8 (10/11/2026, « go produit catalogue ») : produit dit approximativement (« matelas Dodo 140x190 ») → produit du catalogue le plus
//   proche (dimensions obligatoires), dit dans l'aperçu ; plusieurs aussi proches → question avec la liste ; jamais 0 € en silence.
// v2.7 (10/11/2026, recette vidéo 14:19 « crée une commande pour Meryem… reprends les informations de la commande 2141 ») :
//   creer_commande { source: "commande", depuis: "#2141", lignes } = coordonnées du client RECOPIÉES par le serveur depuis une commande
//   existante (nom, téléphone, e-mail, adresse, étage, ascenseur, code) — JARVIS ne les voit jamais. N3 (confirmation à chaque fois).
// v2.6 (10/11/2026, GO Borhen 13:57 « go Claude livraison ») : sans_date (lister_commandes, compter_commandes) = commandes SANS date
//   de livraison (vide ou absente) — recette : la liste triée mettait ces commandes à la FIN, coupée à 30 lignes, et JARVIS les comptait mal.
// v2.5 (10/11/2026, GO Borhen 12:07 « go facture dans les mails ») : lien_facture (N1) — lien de la facture publique d'une commande,
//   donné SEULEMENT si l'e-mail de la commande est celui du client à qui JARVIS répond (jamais la facture d'un client à un autre).

export type Niveau = 'N1' | 'N2' | 'N3';
export const NIVEAUX: Record<string, Niveau> = {
  lire_commande: 'N1', lister_commandes: 'N1', compter_commandes: 'N1', lire_stock: 'N1', lien_facture: 'N1', suivi_gls: 'N1', sms_statut: 'N1', credits_sms: 'N1',
  creer_commande: 'N2', modifier_commande: 'N2', planifier: 'N2', deplacer: 'N2', changer_statut: 'N2',
  sav: 'N2', gls_etiquette: 'N2', gls_retour: 'N2', litige: 'N2',
  stock_entree: 'N2', stock_chargement: 'N2', stock_retour_depot: 'N2',
  annuler_commande: 'N3', supprimer_commande: 'N3', modifier_prix: 'N3', envoyer_sms: 'N3', envoyer_facture_sms: 'N3', marquer_livre: 'N3', stock_correction: 'N3',
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
/** v2.17 : statuts RÉELS d'une commande de l'appli (en-attente, en-route, arrivé, reporté, livré, annulé ; « en-cours » = statut de tournée,
 *  gardé par prudence s'il existe en base). Sert au COMPTAGE et aux FILTRES DE LECTURE seulement. `changer_statut` reste sur STATUTS_OUVERTS
 *  (jamais en-route ni arrivé depuis JARVIS). */
export const STATUTS_COMPTES_OUVERTS = ['en-attente', 'en-route', 'arrivé', 'reporté', 'en-cours'];
export const STATUTS_COMPTES = [...STATUTS_COMPTES_OUVERTS, ...STATUTS_TERMINES];
export const LIVREURS = ['RANOU', 'GLS', 'KUNHGE ET NAGEL'];
export const ORIGINES = ['Téléphone', 'Leboncoin', 'Mail', 'Boutique', 'Site Maxiconfort', 'Autre'];
/** v2.4 (relecture) : origines telles que l'APPLI les enregistre (menu f-origine de maxiconfort-v7.html + synchro TikTok Shop),
 *  avec les mots courants de Borhen / JARVIS. Le comptage filtre sur la valeur de l'appli (casse ignorée en base). */
export const ORIGINES_APPLI = ['Site Maxiconfort', 'Appel direct', 'Email direct', 'Boutique physique', 'Recommandation', 'LeBonCoin', 'TikTok Shop',
  'Amazon', 'Cdiscount', 'Fnac Darty', 'Rakuten', 'Rue du Commerce', 'Ubaldi', 'ManoMano', 'Conforama', 'But', 'La Redoute', 'Maison du Monde', 'Boulanger', 'Leroy Merlin', 'eBay', 'Wish'];
const SYNONYMES_ORIGINE: Record<string, string> = { leboncoin: 'LeBonCoin', lbc: 'LeBonCoin', site: 'Site Maxiconfort', sitemaxiconfort: 'Site Maxiconfort', maxiconfort: 'Site Maxiconfort',
  telephone: 'Appel direct', 'téléphone': 'Appel direct', appel: 'Appel direct', mail: 'Email direct', email: 'Email direct', boutique: 'Boutique physique', tiktok: 'TikTok Shop' };
/** v2.4 : origine de COMPTAGE → valeur de l'appli (casse et espaces ignorés), ou null si inconnue. */
export function origineCanonique(v: unknown): string | null {
  const t = String(v ?? '').toLowerCase().replace(/\s+/g, ''); if (!t) return null;
  return SYNONYMES_ORIGINE[t] || ORIGINES_APPLI.find((o) => o.toLowerCase().replace(/\s+/g, '') === t) || null;
}
export const ANN_MOTIFS = ['Rupture de stock', 'Délai trop long', 'Client injoignable', 'Client a changé d\'avis', 'Problème de livraison', 'Prix / désaccord commercial', 'Doublon / erreur de commande', 'Motif inconnu / non communiqué par le client', 'Autre'];
export const STOCK_MOTIFS = ['reassort', 'retour_gls', 'reprise_sav', 'correction']; // contrainte de la table stock_entrees
/** Champs modifiables par JARVIS (N2). Tout le reste est refusé : prix / remises / frais (→ modifier_prix, N3), paiement
 *  (hors liste), statut (→ changer_statut), date (→ planifier / deplacer), litige (→ litige), suivi transporteur. */
export const CHAMPS_MODIFIABLES = ['client', 'tel', 'email', 'adresse', 'etage', 'ascenseur', 'code', 'produit', 'qte', 'lignes', 'instr'];
export const DEPARTEMENTS_RANOU = ['75', '77', '78', '91', '92', '93', '94', '95']; // Île-de-France = RANOU, sinon GLS

const ID_CMD = /^#(?:SAV)?\d{1,9}$/;
const EMAIL_SIMPLE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,24}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TEL = /^(?:\+33\s?[1-9]|0[1-9])(?:[\s.-]?\d{2}){4}$/;
const PORTABLE = /^(?:\+33\s?[67]|0[67])(?:[\s.-]?\d{2}){4}$/; // v2.16 : seuls les 06 / 07 reçoivent un SMS (un fixe ou une ligne VoIP 09 ne le reçoit pas)

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
  lignes?: Ligne[]; origine?: string; source?: 'mail' | 'dictee' | 'commande'; depuis?: string; nom_annonce?: string; produit?: string; qte?: number; limite?: number;
  autorisation?: string; // v2.16 (6e série Codex #389) : autorisation à usage unique de l'aperçu de envoyer_facture_sms, renvoyée à la confirmation
};

/** Contrôle de forme d'une demande (avant toute lecture). Renvoie un message d'erreur ou null. */
export function controlerDemande(d: Demande, maintenant = Date.now()): string | null {
  if (!ACTIONS.includes(d.action)) return 'action non autorisée pour JARVIS';
  const aCmd = !['lister_commandes', 'compter_commandes', 'lire_stock', 'credits_sms', 'creer_commande', 'stock_entree', 'stock_chargement', 'stock_retour_depot', 'stock_correction'].includes(d.action);
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
    case 'lien_facture': // v2.5 : l'adresse du client à qui on répond est obligatoire (contrôle d'appartenance)
      if (typeof d.email !== 'string' || !EMAIL_SIMPLE.test(d.email.trim())) return 'e-mail du destinataire obligatoire pour joindre une facture';
      break;
    case 'lister_commandes':
      if (d.date !== undefined && !dateValide(String(d.date))) return 'date invalide (AAAA-MM-JJ)';
      if (d.statut !== undefined && !STATUTS_COMPTES.includes(String(d.statut))) return 'statut inconnu';
      if (d.livreur !== undefined && !LIVREURS.includes(String(d.livreur))) return 'livreur inconnu';
      if (d.limite !== undefined && !entier(d.limite, 1, 100)) return 'limite : 1 à 100';
      if (d.client !== undefined && (typeof d.client !== 'string' || !critereClient(d.client))) return 'client : nom (2 lettres au moins), téléphone (6 chiffres au moins) ou e-mail';
      if ((d as any).sans_date !== undefined && (d as any).sans_date !== true) return 'sans_date : true seulement';
      if ((d as any).sans_date && d.date !== undefined) return 'sans_date OU date, pas les deux';
      break;
    case 'compter_commandes': // v2.3 (06/11) : comptage EXACT par statut, fait par la base (jamais une liste coupée)
      for (const k of ['date', 'date_debut', 'date_fin']) if ((d as any)[k] !== undefined && !dateValide(String((d as any)[k]))) return k + ' invalide (AAAA-MM-JJ)';
      if (d.date !== undefined && ((d as any).date_debut !== undefined || (d as any).date_fin !== undefined)) return 'date OU période (date_debut / date_fin), pas les deux';
      if ((d as any).sans_date !== undefined && (d as any).sans_date !== true) return 'sans_date : true seulement';
      if ((d as any).sans_date && (d.date !== undefined || (d as any).date_debut !== undefined || (d as any).date_fin !== undefined)) return 'sans_date OU date / période, pas les deux';
      if ((d as any).date_debut && (d as any).date_fin && String((d as any).date_debut) > String((d as any).date_fin)) return 'période inversée';
      if (d.livreur !== undefined && !LIVREURS.includes(String(d.livreur))) return 'livreur inconnu';
      // v2.4 (09/11) : par ORIGINE (valeurs de l'appli, synonymes admis) et par date de PRISE de commande (cree_debut / cree_fin =
      // colonne date_commande, comme les statistiques de l'appli) — ex. « combien de commandes Leboncoin aujourd'hui ? ».
      if (d.origine !== undefined && origineCanonique(d.origine) === null) return 'origine inconnue (ex. Leboncoin, Site Maxiconfort, Appel direct, Email direct, Boutique physique, TikTok Shop)';
      for (const k of ['cree_debut', 'cree_fin']) if ((d as any)[k] !== undefined && !dateValide(String((d as any)[k]))) return k + ' invalide (AAAA-MM-JJ)';
      if ((d as any).cree_debut && (d as any).cree_fin && String((d as any).cree_debut) > String((d as any).cree_fin)) return 'période de prise de commande inversée';
      break;
    case 'lire_stock':
      if (d.produit !== undefined && texte(d.produit, 80).length < 2) return 'produit invalide';
      break;
    case 'creer_commande': {
      if (d.source !== 'mail' && d.source !== 'dictee' && d.source !== 'commande') return 'source obligatoire : mail (coordonnées lues), dictee (coordonnées dictées) ou commande (coordonnées reprises d’une commande existante)';
      if (d.source === 'commande') { // v2.7 : les coordonnées viennent de la commande « depuis », lues par le serveur
        if (!ID_CMD.test(String(d.depuis || ''))) return 'numéro de la commande dont reprendre les coordonnées obligatoire (ex. #2141)';
        if (d.nom_annonce !== undefined && (typeof d.nom_annonce !== 'string' || d.nom_annonce.length > 80)) return 'nom annoncé invalide';
        for (const k of ['client', 'tel', 'email', 'adresse', 'cp', 'ville']) if ((d as any)[k] !== undefined) return 'source commande : les coordonnées sont reprises de ' + d.depuis + ', ne pas les fournir (' + k + ')';
        if (!Array.isArray(d.lignes) || !d.lignes.length || d.lignes.length > 10) return 'au moins un produit (10 lignes au plus)';
        for (const l of d.lignes) { if (texte(l?.produit, 120).length < 2) return 'produit de la ligne obligatoire'; if (!entier(l?.qte, 1, 20)) return 'quantité : 1 à 20'; }
        if (d.date !== undefined) { const e = dateFuture(String(d.date), maintenant); if (e) return e; }
        if (d.origine !== undefined && !ORIGINES.includes(String(d.origine))) return 'origine inconnue (Téléphone, Leboncoin, Mail, Boutique, Site Maxiconfort, Autre)';
        break;
      }
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
    case 'envoyer_facture_sms': // v2.16 : aucun champ libre — le texte, le lien et le destinataire viennent de la commande, côté serveur
      for (const k of ['texte', 'tel', 'email', 'lien', 'message', 'client', 'adresse']) if ((d as any)[k] !== undefined) return 'envoyer_facture_sms prend seulement le numéro de commande (texte, lien et téléphone sont construits par l’appli)';
      // 6e série de réserves Codex #389 : autorisation à usage unique de l'aperçu — forme stricte « nonce.expiration.signature » ; l'ancienne
      // « empreinte » déterministe est refusée ; absente à la confirmation = 409 ; signature, expiration et usage vérifiés dans jarvis-facture-sms.ts
      if ((d as any).empreinte !== undefined || ((d as any).autorisation !== undefined && !(typeof (d as any).autorisation === 'string' && /^[0-9a-f]{32}\.\d{13}\.[0-9a-f]{64}$/.test((d as any).autorisation)))) return 'autorisation d’aperçu invalide : refais l’aperçu, rien n’est parti';
      break;
    case 'envoyer_sms': {
      const t = texte(d.texte, 320); if (t.length < 10) return 'texte du SMS trop court (10 caractères au moins)'; if (t.length > 300) return 'texte du SMS trop long (300 caractères au plus)';
      if (/https?:\/\//i.test(t)) return 'pas de lien dans un SMS envoyé par JARVIS';
      if ((d as any).prevenir !== undefined && typeof (d as any).prevenir !== 'boolean') return 'prevenir : vrai ou faux'; // 22/11 : SMS « prévenir les clients de demain » = réservation atomique (une fois par jour, tous canaux)
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
  if (!['lister_commandes', 'compter_commandes', 'lire_stock', 'credits_sms', 'creer_commande', 'stock_entree', 'stock_chargement', 'stock_retour_depot', 'stock_correction'].includes(d.action) && !c) return 'commande introuvable';
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
    case 'envoyer_facture_sms': { const f = factureSms(c); if ('erreur' in f) return f.erreur; break; }
  }
  return null;
}

/** Recherche d'un client (v2.1, 04/11/2026 — « du mail à la commande ») : nom, téléphone ou e-mail, en lecture N1.
 *  Renvoie les filtres PostgREST à appliquer (tous ET), ou null si le texte est inutilisable. Sans accent ni casse : chaque mot
 *  du nom devient une expression régulière où une lettre accentuable accepte ses variantes (« lea » trouve « Léa ») ;
 *  un téléphone est comparé chiffre à chiffre quel que soit son format (« 0612345678 » trouve « 06 12 34 56 78 »). */
export type FiltreClient = { colonne: 'client' | 'tel' | 'email'; operateur: 'imatch' | 'ilike'; valeur: string };
const ACCENTS: Record<string, string> = { a: 'aàáâäãÀÁÂÄÃ', e: 'eéèêëÉÈÊË', i: 'iíìîïÍÌÎÏ', o: 'oóòôöõÓÒÔÖÕ', u: 'uúùûüÚÙÛÜ', c: 'cçÇ', n: 'nñÑ', y: 'yÿŸ' }; // majuscules : sûr quel que soit lc_ctype (relecture 04/11)
const SANS_ACCENT = (s: string) => s.replace(/œ/g, 'oe').replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/ß/g, 'ss').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
export function critereClient(brut: unknown): { genre: 'email' | 'tel' | 'nom'; filtres: FiltreClient[] } | null {
  const q = texte(brut, 80).toLowerCase();
  if (q.includes('@')) {
    const e = (q.split(/[\s,;]+/).find((x) => x.includes('@')) || '').replace(/[^a-z0-9@._+-]/g, ''); // le seul jeton @ ; pas de % ni de _ interprétés : _ est échappé pour ILIKE
    return e.length >= 5 ? { genre: 'email', filtres: [{ colonne: 'email', operateur: 'ilike', valeur: '%' + e.replace(/[%_\\]/g, '\\$&') + '%' }] } : null;
  }
  let chiffres = q.replace(/\D/g, '');
  if (chiffres.length >= 6 && SANS_ACCENT(q).replace(/[^a-z]/g, '').length <= 3) { // texte sans lettre (ou « tél » devant) = téléphone
    // +33 6 12 34 56 78 et 06 12 34 56 78 désignent le même numéro : on compare les 9 chiffres significatifs
    if (/^33\d{9}$/.test(chiffres)) chiffres = '0' + chiffres.slice(2);
    if (/^0\d{9}$/.test(chiffres)) chiffres = chiffres.slice(1);
    return { genre: 'tel', filtres: [{ colonne: 'tel', operateur: 'imatch', valeur: chiffres.split('').join('\\D*') }] };
  }
  const mots = SANS_ACCENT(q).replace(/[^a-z0-9' -]/g, ' ').split(/[\s'-]+/).filter((m) => m.length >= 2).slice(0, 4);
  if (!mots.length) return null;
  const motif = (m: string) => m.split('').map((l) => (ACCENTS[l] ? '[' + ACCENTS[l] + ']' : l)).join('');
  return { genre: 'nom', filtres: mots.map((m) => ({ colonne: 'client', operateur: 'imatch', valeur: motif(m) })) };
}

/** v2.2 (04/11/2026, demande de Borhen : « la recherche approximative, on ne peut pas l'intégrer tout de suite ? ») : quand la
 *  recherche exacte par NOM ne trouve rien, on compare le nom cherché à ceux des commandes récentes en tolérant fautes de frappe,
 *  accents et ordre des mots (« Rubigny » ≈ « Rubini », « Lorence » ≈ « Laurence »). Fonctions pures, testées. */
const motsNom = (s: string) => SANS_ACCENT(String(s || '').slice(0, 200).toLowerCase()).replace(/[^a-z0-9' -]/g, ' ').split(/[\s'-]+/).filter((m) => m.length >= 2);
/** Simplification phonétique française légère (relecture v2.2) : « Rubigny » et « Rubini » s'écrivent pareil. */
export function phonetique(m: string): string {
  let p = m.replace(/ph/g, 'f').replace(/au/g, 'o').replace(/gn/g, 'n').replace(/y/g, 'i').replace(/ou/g, 'u').replace(/qu/g, 'k').replace(/h/g, '').replace(/(.)\1+/g, '$1');
  if (p.length > 3) p = p.replace(/[estxd]$/, '');
  return p;
}
/** v2.9 — consonnes seules (après la simplification phonétique). */
export const squelette = (p: string) => p.replace(/[aeiouy]/g, '');
function distance(a: string, b: string): number { // Levenshtein avec transposition (Damerau restreint), mots bornés à 40 caractères
  a = a.slice(0, 40); b = b.slice(0, 40); const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1; d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
const ratio = (a: string, b: string) => (Math.abs(a.length - b.length) / Math.max(a.length, b.length) > 0.4 ? 0 : 1 - distance(a, b) / Math.max(a.length, b.length));
function ressemblance(a: string, b: string): number {
  if (a === b) return 1;
  let r = a.length >= 4 && b.startsWith(a) ? 0.9 : ratio(a, b); // début de nom (« Rubin » → « Rubini »)
  // Phonétique (contre-relecture v2.2) : seulement si l'orthographe est déjà proche (≥ 0,7) — « Hamid » ne doit pas trouver « Ami », « Mathis »
  // pas « Mati » — et plafonnée à 0,9 (jamais devant un vrai début de nom ou une seule faute).
  const pa = phonetique(a), pb = phonetique(b);
  if (pa && pb && r >= 0.7) r = Math.max(r, pa === pb ? 0.9 : Math.min(0.9, ratio(pa, pb)));
  // v2.9 (10/11/2026, « go recherche nom » — vidéo 14:19 : « Myriam Zeroual » ne trouvait pas « Meryem zaroual ») : mêmes CONSONNES dans
  // le même ordre, même première lettre, au moins 3 consonnes et longueurs proches → voyelles mal entendues (« Myriam » ≈ « Meryem »,
  // « Mohamed » ≈ « Mouhamad »). Plafond 0,79 (relecture) : un mot SEUL ne passe jamais le seuil (Karim ≠ Kerem, Malik ≠ Melek) ;
  // il ne compte qu'avec un 2e mot proche (« Myriam Zeroual » ≈ « Meryem zaroual »).
  const sa = squelette(pa), sb = squelette(pb);
  if (sa.length >= 3 && sa === sb && a[0] === b[0] && Math.abs(a.length - b.length) <= 2) r = Math.max(r, 0.79);
  return r;
}
/** Mots du nom en base + mots voisins collés et nom entier collé (« Le Goff » ≈ « Legoff », « Ben Ali » ≈ « Benali »). */
function formesNom(n: string[]): string[] { const f = [...n]; for (let i = 0; i + 1 < n.length; i++) f.push(n[i] + n[i + 1]); if (n.length > 2) f.push(n.join('')); return f; }
/** Score 0..1 : chaque mot cherché (4 au plus) contre la forme la plus proche du nom de la commande (8 mots au plus) ; moyenne, aucun mot sous 0,6. */
export function scoreNom(cherche: string, nom: string): number {
  const q = motsNom(cherche).slice(0, 4), n = formesNom(motsNom(nom).slice(0, 8)); if (!q.length || !n.length) return 0;
  let somme = 0, mini = 1;
  for (const m of q) { let best = 0; for (const x of n) { const r = ressemblance(m, x); if (r > best) best = r; if (best === 1) break; } somme += best; if (best < mini) mini = best; }
  return mini < 0.6 ? 0 : somme / q.length;
}
export const SEUIL_APPROCHE = 0.8; // relecture v2.2 : « Laurent Rubio » (0,76) ne doit pas sortir pour « Laurence Rubigny »
/** Seuil plus strict pour un seul mot court (« Jean » ne doit pas trouver « Joan », « Paul » pas « Raul »). */
export function seuilPour(cherche: string): number { const q = motsNom(cherche).slice(0, 4); return q.length === 1 && q[0].length <= 4 ? 0.85 : SEUIL_APPROCHE; }
/** Commandes dont le nom ressemble au nom cherché, les plus proches puis les plus récentes d'abord ; `plus` = d'autres existent. */
export function rechercheApprochee<T extends { client?: unknown }>(cherche0: string, lignes: T[], max = 10): (T & { score: number })[] & { plus?: boolean } {
  const cherche = texte(cherche0, 80); const seuil = seuilPour(cherche);
  const tous = lignes.map((l, i) => ({ l, i, s: scoreNom(cherche, String(l.client || '')) })).filter((x) => x.s >= seuil).sort((a, b) => b.s - a.s || a.i - b.i);
  const r = tous.slice(0, max).map((x) => ({ ...x.l, score: Math.round(x.s * 100) / 100 })) as (T & { score: number })[] & { plus?: boolean };
  if (tous.length > max) r.plus = true; return r;
}

/** Aperçu SANS coordonnées complètes : commande, produit, statut, code postal et ville seulement. */
export function apercuCommande(c: Record<string, unknown>) {
  const adr = String(c.adresse || ''); const m = adr.match(/\b(\d{5})\s+([^,\n]{2,40})/);
  return { cmd: String(c.id || ''), produit: texte(c.produit, 120), statut: String(c.statut || ''), transporteur: String(c.transporteur || ''), date_livraison: String(c.date_livraison || ''),
    // v2.11 (GO Borhen 10/11/2026 18:50 « go noms complets ») : NOM COMPLET du client (jamais téléphone, e-mail ni adresse complète).
    client_nom: texte(c.client, 60),
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
export function initiales(nom: string): string { return nom.split(/\s+/).filter(Boolean).slice(0, 4).map((m) => m[0].toUpperCase() + '.').join(' '); }
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

export type CatalogueProduit = { id: string; nom: string; prix: number; actif?: boolean; ancienne_offre?: boolean; non_vendable?: boolean };
export type Catalogue = Map<string, CatalogueProduit>;
/** v2.18 — catalogue lu dans la table produits (select *). Avant la migration 039 les colonnes vendable / prix_vente_defini n'existent pas :
 *  tout reste vendable. Un ensemble dont un composant est non vendable l'est aussi (un niveau, comme l'appli). Pure. */
export function catalogueDepuisBase(rows: Record<string, any>[]): Catalogue {
  const brut = new Map((rows || []).map((r) => [String(r.id), r]));
  const nonVendable = (r: Record<string, any> | undefined) => !!r && (r.vendable === false || r.prix_vente_defini === false);
  const m: Catalogue = new Map();
  for (const r of rows || []) {
    const compos = Array.isArray(r.composants) ? r.composants : [];
    const nv = nonVendable(r) || compos.some((c: any) => nonVendable(brut.get(String(c && c.id))));
    m.set(String(r.id), { id: String(r.id), nom: String(r.nom || ''), prix: Number(r.prix) || 0, actif: r.actif !== false, ancienne_offre: !!r.ancienne_offre, ...(nv ? { non_vendable: true } : {}) });
  }
  return m;
}
/** Lignes de commande prêtes à enregistrer : prix du catalogue quand le produit est connu (par identifiant ou nom exact), 0 sinon (à régler par
 *  modifier_prix). Une ancienne offre est refusée (règle du 09/10). Renvoie { lignes, erreur }. */
/** v2.8 (10/11/2026, « go produit catalogue ») — mots d'un nom de produit : sans accent ni casse ; dimensions « 140 x 190 », « 140×190 »,
 *  « 140/190 » → « 140x190 » (épaisseur « ×15 », « /15 », « 20cm » → « 15 », « 20 ») ; « Dodo Confort » / « Dodo » → « dodoconfort »
 *  (nom du catalogue) ; mots vides et pluriels retirés. Pure. */
const MOTS_VIDES_PRODUIT = new Set(['de', 'du', 'des', 'le', 'la', 'les', 'un', 'une', 'et', 'avec', 'en', 'a', 'cm', 'x', 'pour', 'site', 'place', 'personne']);
export function motsProduit(nom: string): string[] {
  const t = String(nom || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/(\d{2,3})\s*[x*/×]\s*(\d{2,3})(?:\s*[x*/×]\s*(\d{1,2})\b)?/g, (_m, a, b, c) => a + 'x' + b + (c ? ' ' + c : ''))
    .replace(/(\d)\s*cm\b/g, '$1').replace(/\bdodo\s*confort\b/g, 'dodoconfort').replace(/\bdodo\b/g, 'dodoconfort');
  return t.split(/[^a-z0-9]+/).filter((m) => m && !MOTS_VIDES_PRODUIT.has(m)).map((m) => (m.length > 3 && m.endsWith('s') && !/\d/.test(m) ? m.slice(0, -1) : m));
}
/** Famille d'un nom : le PREMIER mot de famille qui y figure (« Ensemble 140×190 Matelas… » = ensemble, pas matelas). */
const FAMILLES = ['ensemble', 'pack', 'lit', 'matela', 'sommier', 'canape', 'coussin', 'oreiller'];
const familleDe = (mots: string[]) => mots.find((m) => FAMILLES.includes(m)) || '';
/** v2.8 — Produit du catalogue qui correspond à ce que Borhen a dit (« matelas Dodo 140x190 »). Règles PRUDENTES (essai sur le catalogue
 *  réel du 10/11) : produits actifs et non retirés ; même FAMILLE (un « matelas » n'est jamais un ensemble matelas + sommier) ; TOUS les mots
 *  dits présents (« 140 » seul = une largeur 140×…, « 20 » = épaisseur) ; choisi seulement s'il n'en reste qu'UN (ou des doublons de même
 *  nom et même prix) ; sinon la liste (3 au plus, les plus proches d'abord) est renvoyée pour que Borhen choisisse. Rien → null (0 € signalé). Pure. */
export function produitProche(dit: string, catalogue: Catalogue, sansEpaisseur = false): { produit: CatalogueProduit } | { ambigus: CatalogueProduit[]; epaisseur?: boolean } | null {
  let q = motsProduit(dit); if (!q.length) return null;
  if (sansEpaisseur) q = q.filter((m) => !/^\d{1,2}$/.test(m));
  const fam = familleDe(q);
  const present = (m: string, n: Set<string>) => n.has(m) || (/^\d{2,3}$/.test(m) && Number(m) >= 80 && [...n].some((x) => x.startsWith(m + 'x')));
  const cands: { p: CatalogueProduit; mots: string[]; surplus: number }[] = [];
  for (const p of catalogue.values()) {
    if (p.actif === false || p.ancienne_offre || p.non_vendable) continue; // v2.18 : non vendable jamais proposé
    const mots = motsProduit(p.nom); const n = new Set(mots);
    // relecture (majeur) : un « lit » peut aussi être un pack lit ou un ensemble lit → ils entrent dans la liste au lieu d'un choix
    const f2 = familleDe(mots); if (fam && f2 !== fam && !(fam === 'lit' && (f2 === 'pack' || f2 === 'ensemble') && n.has('lit'))) continue;
    if (!q.every((m) => present(m, n))) continue;
    cands.push({ p, mots, surplus: n.size - q.length });
  }
  if (!cands.length) { // relecture (mineur) : épaisseur inexistante → la liste des tailles voisines, jamais un choix
    if (sansEpaisseur || !q.some((m) => /^\d{1,2}$/.test(m))) return null;
    const r = produitProche(dit, catalogue, true); if (!r) return null;
    return { ambigus: 'produit' in r ? [r.produit] : r.ambigus, epaisseur: true };
  }
  cands.sort((a, b) => a.surplus - b.surplus || a.p.nom.localeCompare(b.p.nom, 'fr'));
  const cle = (c: { mots: string[]; p: CatalogueProduit }) => [...new Set(c.mots)].sort().join(' ') + '|' + c.p.prix;
  if (cands.every((c) => cle(c) === cle(cands[0]))) return { produit: cands[0].p };
  return { ambigus: cands.slice(0, 3).map((c) => c.p) };
}

export function lignesCommande(lignes: Ligne[], catalogue: Catalogue): { lignes: Record<string, unknown>[]; erreur: string | null; rapproches?: { dit: string; produit: string }[] } {
  const out: Record<string, unknown>[] = []; const rapproches: { dit: string; produit: string }[] = [];
  for (const l of lignes) {
    const nom = texte(l.produit, 120);
    let p = l.produitId ? catalogue.get(String(l.produitId)) : undefined;
    if (!p) for (const x of catalogue.values()) if (x.nom.toLowerCase() === nom.toLowerCase()) { p = x; break; }
    let rapproche = false;
    if (!p) { // v2.8 : nom pas exact → produit le plus proche, ou question si plusieurs le sont autant
      const r = produitProche(nom, catalogue);
      if (r && 'ambigus' in r) return { lignes: [], erreur: `« ${nom} » : ` + (r.epaisseur ? 'cette épaisseur n’existe pas au catalogue — voulez-vous plutôt ' : 'plusieurs produits possibles — lequel ? ') + r.ambigus.map((c) => `« ${c.nom} » (${c.prix} €)`).join(', ') };
      if (r) { p = r.produit; rapproche = true; }
    }
    if (p && p.ancienne_offre) return { lignes: [], erreur: `« ${p.nom} » est une ancienne offre : plus vendue` };
    if (p && p.actif === false) return { lignes: [], erreur: `« ${p.nom} » n'est plus au catalogue` };
    if (p && p.non_vendable) return { lignes: [], erreur: `« ${p.nom} » n'est pas encore vendable (prix de vente à définir)` }; // v2.18
    const pu = p ? Number(p.prix) || 0 : (typeof l.prixUnit === 'number' && l.prixUnit >= 0 ? l.prixUnit : 0);
    const q = Number(l.qte) || 1;
    out.push({ produitId: p ? p.id : null, produit: p ? p.nom : nom, qte: q, prixUnit: pu, prixBrut: pu * q, remiseLigne: 0, remiseVal: 0, remiseType: 'pct', sousTotal: pu * q });
    if (rapproche && p) rapproches.push({ dit: nom, produit: p.nom }); // dit dans l'aperçu, jamais enregistré dans la commande
  }
  return { lignes: out, erreur: null, ...(rapproches.length ? { rapproches } : {}) };
}

/** Nouvelle commande (mêmes colonnes que sbSaveCommande de l'appli). Paiement à la livraison par défaut : Espèces / Non payé. */
export function construireCommande(d: Demande, id: string, lignes: Record<string, unknown>[], maintenant = Date.now()): Record<string, unknown> {
  const total = lignes.reduce((s, l) => s + (Number(l.sousTotal) || 0), 0);
  const adresse = d.source === 'commande' ? texte(d.adresse, 240) : [texte(d.adresse, 160), texte(d.cp, 5) + ' ' + texte(d.ville, 60)].join(', '); // v2.7 : adresse reprise telle quelle
  const origine = d.origine ? String(d.origine) : (d.source === 'mail' ? 'Mail' : 'Téléphone');
  return {
    id, client: texte(d.client, 80), tel: texte(d.tel, 20), email: texte(d.email, 120), adresse, etage: texte(d.etage, 10), ascenseur: d.source === 'commande' && (d as any).ascenseur === 'Oui' ? 'Oui' : 'Non', code: texte(d.code, 40),
    produit: lignes.map((l) => (Number(l.qte) > 1 ? l.qte + '× ' : '') + l.produit).join(' + ').slice(0, 300), lignes, qte: lignes.reduce((s, l) => s + (Number(l.qte) || 1), 0),
    prix: total, prix_brut: total, frais_port: 0, stock_deduit: false, remise_globale: 0, remise_globale_val: 0, remise_globale_type: 'pct', remise_motif: '',
    paie: 'Espèces', stpaie: 'Non payé', montant_enc: 0, livreur: '', statut: 'en-attente', date_livraison: d.date || '', date_commande: jourParis(maintenant),
    instr: [texte(d.instr, 300), 'Créée depuis JARVIS (' + (d.source === 'mail' ? 'mail client' : d.source === 'commande' ? 'coordonnées reprises de ' + texte(d.depuis, 12) : 'dictée') + ')'].filter(Boolean).join('\n'),
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
  if (d.action === 'deplacer' && String(c.statut) === 'absent' && d.date && String(d.date) !== String(c.date_livraison || '')) p.statut = 'reporté'; // v2.12 : client absent replanifié
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

/** v2.5 — Lien de la facture publique (facture.html, lecture par jeton comme track.html) pour une réponse par mail.
 *  Donné seulement si l'e-mail de la commande est EXACTEMENT celui du destinataire (casse et espaces ignorés) ; jamais pour une
 *  commande annulée ou sans jeton. Rien d'autre n'est renvoyé (ni nom, ni e-mail, ni adresse). */
export function lienFacture(d: Demande, c: Record<string, unknown>): { erreur: string } | { lien: string; acquittee: boolean; commande: string } {
  const norme = (v: unknown) => String(v || '').trim().toLowerCase();
  if (String(c.statut || '') === 'annulé') return { erreur: 'commande annulée : pas de facture' };
  if (!norme(c.email)) return { erreur: 'pas d’e-mail sur cette commande : impossible de vérifier que c’est bien ce client' };
  if (norme(c.email) !== norme(d.email)) return { erreur: 'l’e-mail de cette commande n’est pas celui du client à qui tu réponds' };
  const jeton = String(c.tracking_token || '').trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(jeton)) return { erreur: 'commande sans lien de facture (pas de jeton de suivi)' };
  return { lien: 'https://livraison.maxiconfort.fr/facture.html?t=' + encodeURIComponent(jeton), acquittee: c.stpaie === 'Payé', commande: String(c.id || '') };
}

/** v2.16 — Mesure d'un SMS selon son VRAI codage (3e série de réserves Codex #389) : alphabet SMS standard (GSM 7 bits) = 160 caractères,
 *  puis 153 par morceau, les caractères d'extension (€ ^ { } [ ] ~ | \\) comptant double ; un seul caractère hors alphabet (ê, ç, emoji…)
 *  fait passer tout le message en UCS-2 = 70 unités, puis 67 par morceau (un emoji = 2 unités). `caracteres` = unités facturées. Pure. */
const GSM7 = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€';
export function mesureSms(t: string): { codage: 'GSM-7' | 'UCS-2'; caracteres: number; sms: number } {
  const s = String(t || ''); let n = 0; let gsm = true;
  for (const ch of s) { if (GSM7.includes(ch)) n += 1; else if (GSM7_EXT.includes(ch)) n += 2; else { gsm = false; break; } }
  if (!gsm) { const u = s.length; /* unités UTF-16 = unités UCS-2 facturées (emoji = 2) */ return { codage: 'UCS-2', caracteres: u, sms: u <= 70 ? 1 : Math.ceil(u / 67) }; }
  return { codage: 'GSM-7', caracteres: n, sms: n <= 160 ? 1 : Math.ceil(n / 153) };
}
export function segmentsSms(t: string): number { return mesureSms(t).sms; }
export const MARQUE_LIEN_FACTURE = '[lien de la facture]';
const FACTURE_DEBUT = 'Bonjour, voici la facture de votre commande '; const FACTURE_SEP = ' : '; const FACTURE_FIN = '\nMaxiconfort';
const FACTURE_LIEN = 'https://livraison.maxiconfort.fr/facture.html?t=';
/** 3e série de réserves Codex #389 : longueur maximale du jeton pour que le SMS tienne TOUJOURS en UN seul SMS (160 caractères GSM 7 bits),
 *  numéro de commande de 9 chiffres compris : 160 − (texte fixe + 9 chiffres + adresse de la page) = 44. Un jeton de l'appli est un UUID (36). */
export const JETON_FACTURE_MAX = 160 - (FACTURE_DEBUT.length + 9 + FACTURE_SEP.length + FACTURE_LIEN.length + FACTURE_FIN.length);
export const ERREUR_FACTURE_TROP_LONGUE = 'lien de la facture trop long pour tenir dans un seul SMS : rien n’est parti, envoie la facture par e-mail';
/** v2.16 — SMS « facture » d'une commande, entièrement composé ICI (pure) : texte FIXE + lien facture.html de CETTE commande, vers SON
 *  portable. Rien ne vient de JARVIS ni d'un champ libre de la base (le nom du client n'entre pas dans le texte). L'aperçu remplace le lien
 *  par MARQUE_LIEN_FACTURE et masque le numéro : le lien réel ne sort jamais dans une réponse. Refus : annulée, SAV, sans jeton, jeton trop
 *  long pour un seul SMS (3e série Codex), sans portable (fixe, VoIP 09, numéro incomplet : un SMS partirait dans le vide).
 *  `caracteres` et `sms` de l'aperçu = mesure RÉELLE du texte envoyé (mesureSms), toujours 1 SMS. */
export function factureSms(c: Record<string, unknown> | null): { erreur: string } | { tel: string; lien: string; texte: string; apercu: { destinataire: string; texte: string; caracteres: number; sms: number; acquittee: boolean } } {
  if (!c) return { erreur: 'commande introuvable' };
  const id = String(c.id || '');
  if (String(c.statut || '') === 'annulé') return { erreur: 'commande annulée : pas de facture à envoyer' };
  if (!/^#\d{1,9}$/.test(id)) return { erreur: /^#SAV/i.test(id) ? 'un SAV n’a pas de facture propre : envoyer celle de la commande d’origine' : 'numéro de commande invalide' };
  const jeton = String(c.tracking_token || '').trim();
  if (!/^[A-Za-z0-9_-]{8,}$/.test(jeton)) return { erreur: 'commande sans lien de facture (pas de jeton de suivi)' };
  if (jeton.length > JETON_FACTURE_MAX) return { erreur: ERREUR_FACTURE_TROP_LONGUE };
  const tel = String(c.tel || '').trim();
  if (!tel) return { erreur: 'pas de numéro de téléphone sur cette commande : impossible d’envoyer la facture par SMS' };
  if (!PORTABLE.test(tel)) return { erreur: 'le numéro de cette commande n’est pas un portable (06 / 07) ou il est invalide : un fixe ne reçoit pas les SMS, la facture ne partirait pas' };
  const debut = FACTURE_DEBUT + id.slice(1) + FACTURE_SEP;
  const lien = FACTURE_LIEN + encodeURIComponent(jeton);
  const t = debut + lien + FACTURE_FIN;
  const m = mesureSms(t); if (m.sms !== 1) return { erreur: ERREUR_FACTURE_TROP_LONGUE }; // second verrou : jamais plus d'un SMS
  return { tel, lien, texte: t, apercu: { destinataire: telMasque(tel), texte: debut + MARQUE_LIEN_FACTURE + FACTURE_FIN, caracteres: m.caracteres, sms: m.sms, acquittee: c.stpaie === 'Payé' } };
}

/** v2.7 — Coordonnées reprises d'une commande existante (pure) : nom, téléphone, e-mail, adresse complète, étage, ascenseur, code,
 *  + code postal et ville relus dans l'adresse (pour le transporteur). Refus si la source n'a ni téléphone ni code postal. */
export function coordonneesDepuis(src: Record<string, unknown> | null): { erreur: string } | { champs: Record<string, string> } {
  if (!src) return { erreur: 'commande source introuvable' };
  const adresse = String(src.adresse || '').trim(); const tel = String(src.tel || '').trim(); const client = String(src.client || '').trim();
  // « 94140 Alfortville » ou « 94140, Alfortville » (format de l'appli) ; relecture : « …, 93160, Noisy-le-Grand, 93160, France » → la
  // dernière correspondance dont la ville n'est pas « France » ; « CEDEX » retiré.
  const m = [...adresse.matchAll(/\b(\d{5})\s*,?\s*([^,\d\s][^,]*)/g)].filter((x) => !/^france$/i.test(x[2].trim())).pop();
  if (client.length < 2) return { erreur: 'la commande source n’a pas de nom de client' };
  if (!tel) return { erreur: 'la commande source n’a pas de téléphone' };
  if (!m) return { erreur: 'code postal introuvable dans l’adresse de la commande source' };
  return { champs: { client, tel, email: String(src.email || '').trim(), adresse, etage: String(src.etage || '').trim(), ascenseur: String(src.ascenseur || '') === 'Oui' ? 'Oui' : 'Non',
    code: String(src.code || '').trim(), cp: m[1], ville: m[2].replace(/\s+France$/i, '').replace(/\s+cedex(\s+\d+)?$/i, '').trim() } };
}

/** v2.7 (relecture) — Le nom que Borhen a dit correspond-il au client de la commande source ? Nom proche (scoreNom ≥ seuil) OU mêmes
 *  initiales dans n'importe quel ordre (« Myriam Zeroual » ≈ « Meryem zaroual »). Seul un oui / non est renvoyé, jamais le nom. */
export function nomConcorde(annonce: string, client: string): boolean {
  const ini = (s: string) => motsNom(s).map((m) => m[0]).sort().join('');
  if (!motsNom(annonce).length) return true;
  if (scoreNom(annonce, client) >= seuilPour(annonce)) return true;
  const a = ini(annonce), c = ini(client); return a.length > 0 && (a === c || (motsNom(annonce).length === 1 && c.includes(a)));
}

/** v2.10 — Résumé du suivi GLS en direct d'une commande (réponse de gls-sync en mode audit {cmdIds}). Aucune donnée client : numéros de
 *  colis, états et libellés GLS seulement ; dates en heure de Paris. Pure. */
const enParis = (iso: unknown) => { if (!iso) return null; const t = Date.parse(String(iso)); return Number.isNaN(t) ? null : new Date(t).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
export function resumeSuivi(x: any): { erreur: string } | Record<string, unknown> {
  if (!x || typeof x !== 'object') return { erreur: 'suivi GLS introuvable pour cette commande' };
  const colis = (Array.isArray(x.colis) ? x.colis : []).slice(0, 10).map((c: any) => ({
    colis: texte(c?.trackId, 20), etat: texte(c?.etat, 30), detail: texte(c?.motif, 160),
    pris_en_charge: c?.priseEnCharge ? enParis(c.priseEnCharge) : null, livre_client: c?.livreClient ? enParis(c.livreClient) : null,
    retour: c?.retour ? enParis(c.retour) : null, dernier_evenement: enParis(c?.dernier), dernier_libelle: texte(c?.dernierLibelle, 120) || null,
  }));
  // Relecture 10/11 (majeur) : GLS injoignable ou colis illisible ≠ « pas pris en charge ». Tout en erreur → erreur nette ; une partie →
  // pris_en_charge inconnu (null) et colis marqués « lecture GLS impossible ».
  const enErreur = (c: any) => c.etat === 'erreur';
  if (texte(x.etat_gls, 30) === 'erreur' && (!colis.length || colis.every(enErreur))) return { erreur: 'GLS ne répond pas pour l’instant : impossible de dire si le colis est pris en charge' };
  for (const c of colis) if (enErreur(c)) Object.assign(c, { pris_en_charge: null, detail: 'lecture GLS impossible pour ce colis (GLS ne répond pas)' });
  const inconnu = colis.some(enErreur);
  return { etat_gls: texte(x.etat_gls, 30), detail: texte(x.detail, 200), date_livraison_gls: x.date_livraison_gls || null,
    pris_en_charge: inconnu ? null : colis.length ? colis.every((c: any) => !!c.pris_en_charge) : false, ...(inconnu ? { lecture_partielle: true } : {}), colis };
}

/** revue Codex #21 (P2) : variantes d'écriture d'un même numéro dans `sms_historique.tel` (l'appli convertit en +33 avant send-sms, qui garde le numéro tel quel).
 *  Numéro français (10 chiffres en 0X…, ou 33X… / 0033X… à 11-13 chiffres) → national, national espacé, +33, 33, 0033, +33 espacé ; autre format → saisie + chiffres seuls. Fonction pure. */
export function variantesTel(tel: unknown): string[] {
  const brut = String(tel ?? '').trim(); const ch = brut.replace(/\D/g, '');
  const sortie = new Set<string>(); if (brut) sortie.add(brut); if (ch) sortie.add(ch);
  const m = /^(?:0033|33|0)([1-9]\d{8})$/.exec(ch);
  if (m) {
    const n9 = m[1]; const nat = '0' + n9;
    const paires = (x: string) => x.replace(/(\d{2})(?=\d)/g, '$1 ');
    sortie.add(nat); sortie.add(paires(nat)); sortie.add('+33' + n9); sortie.add('33' + n9); sortie.add('0033' + n9);
    sortie.add('+33 ' + n9[0] + ' ' + paires(n9.slice(1)));
  }
  return [...sortie];
}

/** v2.13 — « Un SMS est-il parti pour cette commande ? » (N1, lecture seule). Deux sources, jamais le texte du message, le numéro ni le nom :
 *  (i) `commandes.sms_envoyes` [{type, at ISO UTC}] = envois RÉUSSIS, heure exacte (convertie en heure de Paris) ;
 *  (ii) lignes de `sms_historique` (filtrées par téléphone côté appelant) : échecs et envois manuels. Leur heure est AMBIGUË (UTC ou Paris selon
 *  l'écrivain) : donnée telle qu'enregistrée, « heure indicative », jamais convertie. `lignes === null` = journal général illisible.
 *  Une ligne « envoyé » de l'historique qui double une entrée du journal de la commande (même type, même jour UTC ou Paris) est écartée.
 *  Rien trouvé ≠ « non envoyé » : un SMS peut être parti hors de ces journaux. Pure. */
export const SOURCE_SMS_COMMANDE = 'journal de la commande';
export const SOURCE_SMS_TEL = 'journal par numéro de téléphone (peut mélanger plusieurs commandes du même client)';
export function resumeSms(commande: Record<string, unknown> | null, lignes: unknown[] | null): Record<string, unknown> {
  const jourFr = (iso: string) => { const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
  const parisJour = (t: number) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  const journal = (Array.isArray(commande?.sms_envoyes) ? commande!.sms_envoyes as any[] : []).map((e) => ({ type: texte(e?.type, 40), t: Date.parse(String(e?.at ?? '')) }))
    .filter((e) => e.type && !Number.isNaN(e.t)).sort((a, b) => b.t - a.t).slice(0, 20);
  const sms: Record<string, unknown>[] = journal.map((e) => ({ type: e.type, quand: enParis(new Date(e.t).toISOString()), statut: 'envoyé', source: SOURCE_SMS_COMMANDE }));
  // revue Codex #20 (2e point) : le journal de la commande ne concerne QUE cette commande ; une ligne du journal général d'une AUTRE commande du même client n'est jamais confondue avec lui
  const doublon = (type: string, jour: string, cmdLigne: string, monId: string) => (!cmdLigne || cmdLigne === monId) && journal.some((e) => e.type === type && (new Date(e.t).toISOString().slice(0, 10) === jour || parisJour(e.t) === jour));
  let generalIndisponible = false;
  if (lignes === null) generalIndisponible = true;
  else for (const l of (Array.isArray(lignes) ? lignes : []).slice(0, 20) as any[]) {
    const type = texte(l?.type_sms, 40); if (!type) continue;
    const brut = texte(l?.statut, 20).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    // revue Codex #20 (P2) : un envoi INDÉTERMINÉ (« indéterminé (peut-être parti) ») reste « indéterminé » à la relecture : jamais présenté comme un échec (le SMS est peut-être parti)
    const statut = /^indetermin/.test(brut) ? 'indéterminé (peut-être parti)' : /^(echec|erreur|fail)/.test(brut) ? 'échec' : /^envoy/.test(brut) ? 'envoyé' : (brut || 'inconnu');
    const jour = /^\d{4}-\d{2}-\d{2}/.test(String(l?.date_sms ?? '')) ? String(l.date_sms).slice(0, 10) : '';
    const cmdLigne = /^#?[A-Za-z0-9\-]{1,24}$/.test(String(l?.cmd_id ?? '').trim()) ? String(l.cmd_id).trim() : '';
    const monId = String((commande as any)?.id ?? '');
    if (statut === 'envoyé' && jour && doublon(type, jour, cmdLigne, monId)) continue;
    const h = String(l?.heure ?? '').match(/^\d{1,2}:\d{2}/);
    // revue Codex #20 : la commande de l'envoi (colonne cmd_id, migration 038) ; « autre_commande » = envoi d'une AUTRE commande du même client (même téléphone)
    sms.push({ type, quand: (jour ? jourFr(jour) : 'date inconnue') + (h ? ' ' + h[0] : '') + ' (heure indicative)', statut, source: SOURCE_SMS_TEL, ...(cmdLigne ? { commande: cmdLigne, ...(monId && cmdLigne !== monId ? { autre_commande: true } : {}) } : {}) });
  }
  const sortie: Record<string, unknown> = { sms };
  if (generalIndisponible) sortie.note_journal_general = 'journal général indisponible (seul le journal de la commande est lu)';
  if (!sms.length) sortie.message = 'aucune trace enregistrée' + (generalIndisponible ? ' dans le journal de la commande' : ' dans les journaux') + ' — cela ne prouve pas qu’aucun SMS n’est parti (un envoi hors de ces journaux n’y laisse pas de trace)';
  return sortie;
}

/** v2.14 : seuil sous lequel le solde de crédits SMS est jugé « bas » (à confirmer par Borhen ; une seule constante à changer). */
export const SEUIL_CREDITS_SMS_BAS = 100;
/** Compte OVH qui porte l'expéditeur MAXICONFORT : c'est LUI qu'il faut recharger (les comptes -2 et -3 n'ont pas d'expéditeur). */
export const COMPTE_SMS_PRINCIPAL = 'sms-rw88345-1';

/**
 * v2.14 : résumé du solde de crédits SMS à partir de la réponse brute d'OVH (GET /sms/{service}). Fonction pure, lecture seule.
 * `brut` = { http, data, service } ou null (appel impossible / exception). Ne garde que le nombre de crédits, le nom du service
 * (jamais l'expéditeur, jamais un secret) et l'état. Tout doute (statut ≠ 200, creditsLeft absent / non numérique / négatif)
 * = « indisponible » : jamais un faux « ok ».
 */
export function resumeCredits(brut: { http?: number | null; data?: unknown; service?: string } | null | undefined, seuil: number = SEUIL_CREDITS_SMS_BAS): Record<string, unknown> {
  const s = Number.isFinite(seuil) && seuil > 0 ? seuil : SEUIL_CREDITS_SMS_BAS;
  const service = typeof brut?.service === 'string' && /^sms-[a-z0-9]+-\d{1,3}$/i.test(brut.service) ? brut.service : null;
  const compte = service ? { compte: service } : {};
  const indispo = (raison: string) => ({ etat: 'indisponible', ...compte, seuil: s, message: 'solde indisponible (' + raison + ') — ne pas en conclure que le compte est suffisant ; à vérifier sur le compte OVH' });
  if (!brut || brut.http !== 200) return indispo(brut && typeof brut.http === 'number' ? 'OVH a répondu en erreur' : 'OVH ne répond pas');
  const data = brut.data as { creditsLeft?: unknown } | null;
  const c = data && typeof data === 'object' ? data.creditsLeft : undefined;
  if (typeof c !== 'number' || !Number.isFinite(c) || c < 0) return indispo('réponse OVH illisible');
  const credits = Math.floor(c);
  const recharge = 'recharger le compte portant l’expéditeur MAXICONFORT (' + COMPTE_SMS_PRINCIPAL + '), pas les comptes -2 ni -3';
  if (credits === 0) return { etat: 'zero', credits, ...compte, seuil: s, message: 'plus aucun crédit SMS : les SMS clients ne partent plus — ' + recharge };
  if (credits < s) return { etat: 'bas', credits, ...compte, seuil: s, message: 'crédits SMS bas (' + credits + ', seuil ' + s + ') — ' + recharge };
  return { etat: 'ok', credits, ...compte, seuil: s, message: credits + ' crédits SMS restants (seuil d’alerte ' + s + ')' };
}
