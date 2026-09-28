// ════════════════════════════════════════════════════════════════════
// Analyse des historiques de suivi GLS (ShipIT-FARM « parceldetails »)
// ════════════════════════════════════════════════════════════════════
// Module PUR (aucun appel réseau, aucune dépendance Deno) : utilisé par
// gls-sync et alerte-gls-sans-scan, et testé en Node
// (supabase/tests/gls-analyse.test.mjs).
//
// Format réel d'un événement (UnitDetail.History[]) :
//   { Date: "2026-08-27T11:45:21+02:00", StatusCode: "DELIVERED",
//     LocationCode: "FR0093", Location: "GARONOR GLS France FR0093",
//     Description: "The parcel has been delivered." }
// Codes vus (08-09/2026) : DATA_RECEIVED, HUB, DELIVERY_DEPOT,
//   IN_DELIVERY, DELIVERED.
//
// Règles (28/09/2026) :
//  - PRISE EN CHARGE = au moins un événement dont le StatusCode n'est pas
//    DATA_RECEIVED (DATA_RECEIVED = « données saisies, colis pas encore
//    remis à GLS »).
//  - RETOUR = un événement « returned to sender » / retour / ShopReturn.
//  - Un « DELIVERED » ne compte comme LIVRAISON CLIENT que s'il :
//      * n'est PAS postérieur à un retour à l'expéditeur ;
//      * n'est PAS un dépôt en ParcelShop (« available at ParcelShop »,
//        « delivered at the ParcelShop ») — le client doit encore le
//        retirer ; GLS ajoute un « delivered » simple au retrait ;
//      * n'est PAS l'état final au dépôt de l'expéditeur (Garonor FR0093 /
//        Noisy) alors que le destinataire est hors Île-de-France (= colis
//        revenu chez nous). Un « delivered » parasite à Garonor au moment de
//        l'enlèvement, suivi du vrai trajet, est ignoré (vu le 02/09/2026).
//  - Une COMMANDE n'est « livrée » que si TOUS ses colis sont livrés au
//    client ; X/N → « partiel » ; un seul colis revenu → « retour ».
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any

export type EtatColis =
  | 'erreur'           // API GLS en erreur (on ne conclut rien)
  | 'inconnu'          // aucun événement
  | 'donnees_seules'   // étiquette créée, jamais remise à GLS
  | 'transit'          // pris en charge, pas encore livré
  | 'point_relais'     // déposé en ParcelShop, pas encore retiré
  | 'livre'            // livré au client
  | 'retour';          // retourné à l'expéditeur (livré ou non chez lui)

export type AnalyseColis = {
  trackId: string;
  etat: EtatColis;
  nbEvenements: number;
  creationAt: string | null;        // 1er DATA_RECEIVED (création étiquette chez GLS)
  priseEnCharge: boolean;
  priseEnChargeAt: string | null;   // 1er événement != DATA_RECEIVED
  dernierEvenementAt: string | null;
  dernierCode: string | null;
  dernierLibelle: string | null;
  livreClient: boolean;
  livreClientAt: string | null;
  retour: boolean;
  retourAt: string | null;
  livreExpediteurAt: string | null; // « delivered » compté comme retour chez nous
  motif: string;                    // résumé lisible (français)
};

export type EtatCommande = 'erreur' | 'non_pris_en_charge' | 'transit' | 'partiel' | 'retour' | 'livre';

export type AnalyseCommande = {
  etat: EtatCommande;
  nbColis: number;
  nbLivres: number;
  nbRetours: number;
  nbErreurs: number;
  dateLivraison: string | null;     // YYYY-MM-DD (Paris) du dernier colis livré, si 'livre'
  detail: string;                   // ex. « livraison partielle 2/3 »
  colis: AnalyseColis[];
};

const IDF = new Set(['75', '77', '78', '91', '92', '93', '94', '95']);
const RE_RETOUR = /return(ed)?\s+to\s+(the\s+)?sender|retour(n[ée]e?)?\s+(a|à)\s+l.?exp[ée]diteur|renvoy[ée]e?\s+(a|à)\s+l.?exp|shop\s*return|shopreturn/i;
const RE_PARCELSHOP = /parcel\s*shop|point\s+relais|relais\s+colis/i;
const RE_DEPOT_EXPEDITEUR = /garonor|noisy/i;

function ms(d: any): number {
  const t = Date.parse(String(d || ''));
  return isNaN(t) ? NaN : t;
}

function iso(t: number | null): string | null {
  return t === null || isNaN(t) ? null : new Date(t).toISOString();
}

export function dateParis(isoStr: string | null): string | null {
  if (!isoStr) return null;
  const t = ms(isoStr);
  if (isNaN(t)) return null;
  return new Date(t).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
}

/** Extrait l'historique d'une réponse parceldetails (plusieurs formes tolérées). */
export function historiqueDe(data: any): any[] {
  const h = data?.UnitDetail?.History || data?.History || data?.history || [];
  return Array.isArray(h) ? h : [];
}

function servicesDe(data: any): string {
  const u = data?.UnitDetail || data || {};
  try { return JSON.stringify([u.Service || [], u.ShipmentService || []]); } catch { return ''; }
}

function cpDestinataire(data: any): string {
  const u = data?.UnitDetail || data || {};
  return String(u?.Consignee?.Address?.ZIPCode || '').trim();
}

function paysDestinataire(data: any): string {
  const u = data?.UnitDetail || data || {};
  return String(u?.Consignee?.Address?.CountryCode || 'FR').trim().toUpperCase();
}

function code(ev: any): string {
  return String(ev?.StatusCode || ev?.Code || ev?.EventCode || ev?.code || '').toUpperCase();
}
function libelle(ev: any): string {
  return String(ev?.Description || ev?.StatusDescription || ev?.text || ev?.Text || '');
}
function lieu(ev: any): string {
  return String(ev?.LocationCode || '') + ' ' + String(ev?.Location || '');
}
/** Dépôt GLS de l'expéditeur (Garonor FR0093 / Noisy-le-Grand). */
function estDepotExpediteur(ev: any): boolean {
  return String(ev?.LocationCode || '').toUpperCase() === 'FR0093' || RE_DEPOT_EXPEDITEUR.test(lieu(ev));
}

export function estEvenementLivraison(ev: any): boolean {
  const c = code(ev);
  return c === 'DELIVERED' || c === 'DELIVERY_COMPLETE' || c === 'LIVRE' || c === 'LIVREE';
}

export function estEvenementRetour(ev: any): boolean {
  const c = code(ev);
  if (c.includes('RETURN') || c.includes('RETOUR')) return true;
  return RE_RETOUR.test(libelle(ev));
}

/**
 * Analyse un colis à partir de la réponse GLS (data = corps parceldetails).
 * opts.cpDestinataire : code postal client si absent de la réponse.
 */
export function analyserColis(trackId: string, data: any, opts: { cpDestinataire?: string } = {}): AnalyseColis {
  const hist = historiqueDe(data)
    .map((ev: any, i: number) => ({ ev, t: ms(ev?.Date || ev?.date || ev?.DateTime), i }))
    .sort((a, b) => (isNaN(a.t) ? 0 : a.t) - (isNaN(b.t) ? 0 : b.t) || a.i - b.i);

  const res: AnalyseColis = {
    trackId, etat: 'inconnu', nbEvenements: hist.length,
    creationAt: null, priseEnCharge: false, priseEnChargeAt: null,
    dernierEvenementAt: null, dernierCode: null, dernierLibelle: null,
    livreClient: false, livreClientAt: null, retour: false, retourAt: null,
    livreExpediteurAt: null, motif: '',
  };
  if (!hist.length) { res.motif = 'aucun evenement GLS'; return res; }

  const cp = cpDestinataire(data) || String(opts.cpDestinataire || '');
  const pays = paysDestinataire(data);
  const clientIdf = pays === 'FR' && IDF.has(cp.substring(0, 2));
  const retourService = /shop_?return/i.test(servicesDe(data));

  let tRetour: number | null = null;
  let tLivreClient: number | null = null;
  let tLivreApresRetour: number | null = null;
  let tLivreDepotExp: number | null = null;
  let enRelais = false;

  for (const { ev, t } of hist) {
    const c = code(ev);
    if (c === 'DATA_RECEIVED') {
      if (res.creationAt === null && !isNaN(t)) res.creationAt = iso(t);
      continue;
    }
    if (!res.priseEnCharge) {
      res.priseEnCharge = true;
      res.priseEnChargeAt = iso(t);
    }
    if (estEvenementRetour(ev)) {
      if (tRetour === null) tRetour = t;
      continue;
    }
    if (estEvenementLivraison(ev)) {
      if (RE_PARCELSHOP.test(libelle(ev))) { enRelais = true; continue; }
      if (tRetour !== null) { tLivreApresRetour = t; continue; }          // livré APRÈS un retour → chez nous
      if (!clientIdf && estDepotExpediteur(ev)) { tLivreDepotExp = t; continue; } // Garonor/Noisy, client en province
      tLivreClient = t; enRelais = false;
    }
  }

  const last = hist[hist.length - 1];
  // Un « delivered » au dépôt Garonor/Noisy n'est un retour que s'il est l'état FINAL :
  // GLS émet parfois un « delivered » parasite à Garonor au moment de l'enlèvement
  // (ex. 02/09 16:21, même seconde que « handed over »), suivi du vrai trajet.
  const dernierAuDepotExp = estDepotExpediteur(last.ev);
  const tLivreExp = tLivreApresRetour ?? ((tLivreDepotExp !== null && dernierAuDepotExp && (tLivreClient === null || tLivreDepotExp > tLivreClient)) ? tLivreDepotExp : null);
  res.dernierEvenementAt = iso(last.t);
  res.dernierCode = code(last.ev) || null;
  res.dernierLibelle = libelle(last.ev) || null;
  res.retour = tRetour !== null || tLivreExp !== null || retourService;
  res.retourAt = iso(tRetour ?? tLivreExp);
  res.livreExpediteurAt = iso(tLivreExp);
  // Livré client seulement si AUCUN retour n'est intervenu avant cette livraison
  // (tLivreClient n'est renseigné que pour des « delivered » antérieurs au retour).
  res.livreClient = tLivreClient !== null && !res.retour;
  res.livreClientAt = res.livreClient ? iso(tLivreClient) : null;

  const fr = (s: string | null) => s ? new Date(ms(s)).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '?';
  if (!res.priseEnCharge) {
    res.etat = 'donnees_seules';
    res.motif = 'etiquette creee le ' + fr(res.creationAt) + ', jamais remise a GLS';
  } else if (res.retour) {
    res.etat = 'retour';
    res.motif = 'retour expediteur le ' + fr(res.retourAt) + (tLivreExp !== null ? ' puis "livre" chez l\'expediteur le ' + fr(res.livreExpediteurAt) : '');
  } else if (res.livreClient) {
    res.etat = 'livre';
    res.motif = 'livre au client le ' + fr(res.livreClientAt);
  } else if (enRelais) {
    res.etat = 'point_relais';
    res.motif = 'en point relais, pas encore retire';
  } else {
    res.etat = 'transit';
    res.motif = 'en transit (dernier scan ' + fr(res.dernierEvenementAt) + ')';
  }
  return res;
}

/** Colis en erreur API (aucune conclusion possible). */
export function colisErreur(trackId: string, message = 'erreur API GLS'): AnalyseColis {
  return {
    trackId, etat: 'erreur', nbEvenements: 0, creationAt: null, priseEnCharge: false, priseEnChargeAt: null,
    dernierEvenementAt: null, dernierCode: null, dernierLibelle: null, livreClient: false, livreClientAt: null,
    retour: false, retourAt: null, livreExpediteurAt: null, motif: message,
  };
}

/** Agrège les colis d'une commande. */
export function analyserCommande(colis: AnalyseColis[]): AnalyseCommande {
  const nbColis = colis.length;
  const nbLivres = colis.filter((c) => c.etat === 'livre').length;
  const nbRetours = colis.filter((c) => c.etat === 'retour').length;
  const nbErreurs = colis.filter((c) => c.etat === 'erreur').length;
  let etat: EtatCommande;
  let detail: string;
  if (nbColis === 0) { etat = 'erreur'; detail = 'aucun numero de colis'; }
  else if (nbRetours > 0) { etat = 'retour'; detail = `retour expediteur ${nbRetours}/${nbColis} colis, livres ${nbLivres}/${nbColis}`; }
  else if (nbErreurs > 0) { etat = 'erreur'; detail = `${nbErreurs}/${nbColis} colis illisibles (API GLS)`; }
  else if (nbLivres === nbColis) { etat = 'livre'; detail = nbColis > 1 ? `livre ${nbColis}/${nbColis} colis` : 'livre'; }
  else if (nbLivres > 0) { etat = 'partiel'; detail = `livraison partielle ${nbLivres}/${nbColis}`; }
  else if (colis.every((c) => c.etat === 'donnees_seules' || c.etat === 'inconnu')) { etat = 'non_pris_en_charge'; detail = 'aucun colis remis a GLS'; }
  else { etat = 'transit'; detail = `en transit (0/${nbColis} livre)`; }

  let dateLivraison: string | null = null;
  if (etat === 'livre') {
    const ts = colis.map((c) => ms(c.livreClientAt)).filter((t) => !isNaN(t));
    if (ts.length) dateLivraison = dateParis(new Date(Math.max(...ts)).toISOString());
  }
  return { etat, nbColis, nbLivres, nbRetours, nbErreurs, dateLivraison, detail, colis };
}

/** Découpe « 00L1,00L2 » en liste de n° valides. */
export function numerosColis(tracking: string | null | undefined): string[] {
  return String(tracking || '').split(/[,;\s]+/).map((t) => t.trim().toUpperCase()).filter((t) => t.length >= 6);
}

/**
 * Mot-clé d'exclusion de l'alerte « sans premier scan » dans la note.
 * « SANS SCAN OK » seul → toute la commande ; suivi de n° → ces colis seulement.
 * Retourne null (pas d'exclusion), 'tout', ou la liste des n° exclus.
 */
export function exclusionSansScan(note: string | null | undefined): null | 'tout' | string[] {
  const txt = String(note || '').toUpperCase();
  const re = /SANS[\s_-]*SCAN[\s_-]*OK\b([^\n]*)/g;
  let m: RegExpExecArray | null;
  let trouve = false;
  const ids: string[] = [];
  while ((m = re.exec(txt))) {
    trouve = true;
    const suite = m[1] || '';
    const n = suite.match(/\b[0-9A-Z]{8,}\b/g) || [];
    for (const x of n) if (/\d/.test(x)) ids.push(x);
    if (!n.some((x) => /\d/.test(x))) return 'tout';
  }
  return trouve ? ids : null;
}
