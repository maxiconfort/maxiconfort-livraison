// jarvis-action v2.16 — branche « envoyer_facture_sms » extraite de jarvis-action/index.ts (réserve Codex #389, 17/11/2026) pour être
// testée avec des dépendances simulées. Refus 422 si factureSms refuse ; aperçu si !confirme (aucun envoi) ; sinon UN SEUL appel interne
// send-sms { tel, message, type: 'jarvis', client } ; 502 si l'envoi échoue. Aucune réponse ne contient le texte réel ni le lien : seul
// l'aperçu (destinataire masqué, « [lien de la facture] ») est renvoyé.
// 2e série de réserves Codex #389 (17/11) : l'aperçu et la confirmation sont LIÉS. L'aperçu renvoie une EMPREINTE = HMAC-SHA256
// (clé JARVIS_ACTION_SECRET) de téléphone + lien + texte, 16 premiers caractères hexadécimaux ; JARVIS la renvoie à la confirmation ;
// elle est recalculée sur la commande RELUE et, si elle est absente ou différente (numéro ou jeton changés entre-temps), 409 sans
// aucun appel à send-sms. L'empreinte ne révèle ni le numéro ni le lien (HMAC à clé secrète).
// 6e série de réserves Codex #389 (18/11) : l'empreinte DÉTERMINISTE permettait de REJOUER une confirmation (même requête = même
// empreinte = plusieurs SMS sans nouvel accord de Borhen). Elle est remplacée par une AUTORISATION À USAGE UNIQUE :
//   « <nonce 32 hex aléatoire>.<expiration ms>.<HMAC-SHA256 64 hex> », signature (clé JARVIS_ACTION_SECRET) de nonce + expiration +
//   téléphone + lien + texte ; expiration = aperçu + 10 min (DUREE_AUTORISATION_MS). L'aperçu n'écrit RIEN.
//   Confirmation : forme → signature recalculée sur la commande RELUE (409 « la commande a changé » si différente) → expiration (409) →
//   CONSOMMATION ATOMIQUE côté serveur (deps.consommer : insertion de « jarvis-facture-sms:<nonce> » dans la table EXISTANTE
//   oauth_etats, clé primaire « etat » — une seule requête gagne, même en concurrence ; doublon = 409 « autorisation déjà utilisée ou
//   expirée ») → PUIS un seul send-sms. Verrou indisponible = 503, aucun envoi. Aucune migration de schéma.
// deno-lint-ignore-file no-explicit-any
import { egal, factureSms } from './jarvis-action-logique.ts';

export const ERREUR_EMPREINTE = 'la commande a changé depuis l’aperçu (numéro ou lien) : refais l’aperçu, rien n’est parti';
export const ERREUR_AUTORISATION = 'autorisation déjà utilisée ou expirée : refais l’aperçu, rien n’est parti';
export const ERREUR_VERROU = 'verrou d’usage unique indisponible : rien n’est parti, réessaie dans un instant';
export const DUREE_AUTORISATION_MS = 10 * 60 * 1000;
export const FOURNISSEUR_USAGE = 'jarvis-facture-sms';
export const AUTORISATION_RE = /^([0-9a-f]{32})\.(\d{13})\.([0-9a-f]{64})$/;

/** Signature de l'autorisation : HMAC-SHA256(cle, nonce + expiration + tel + lien + texte), 64 hex. Web Crypto (Deno et Node). */
export async function autorisationFacture(cle: string, nonce: string, expire: number, tel: string, lien: string, texte: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(cle), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, enc.encode(JSON.stringify(['facture-sms-v2.16-autorisation', nonce, expire, tel, lien, texte])));
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function nonceAleatoire(): string {
  const b = new Uint8Array(16); crypto.getRandomValues(b); return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** 3e série de réserves Codex #389 : la réponse de envoyer_facture_sms ne porte AUCUN champ libre de la commande (produit, nom du client,
 *  ville, transporteur — un texte libre peut contenir un jeton) : seulement le numéro, le statut, la date, le code postal et le nombre de colis. */
export const CLES_COMMANDE_FACTURE = ['cmd', 'statut', 'date_livraison', 'cp', 'colis_suivis', 'litige_ouvert'];
function baseFacture(base: Record<string, unknown>): Record<string, unknown> {
  const c = base.commande as Record<string, unknown> | undefined; if (!c || typeof c !== 'object') return base;
  const m: Record<string, unknown> = {}; for (const k of CLES_COMMANDE_FACTURE) if (Object.prototype.hasOwnProperty.call(c, k)) m[k] = c[k];
  return { ...base, commande: m };
}

/** Consommation atomique de l'usage (côté serveur) : 'ok' = cette requête a gagné ; 'deja' = déjà consommée ; 'erreur' = verrou indisponible. */
export type ConsommerUsage = (etat: string, expire_at: string) => Promise<'ok' | 'deja' | 'erreur'>;
export type DepsFactureSms<R> = {
  interne: (nom: string, corps: Record<string, unknown>) => Promise<{ http: number; j: any }>;
  rep: (code: number, o: unknown) => R;
  cle: string;
  consommer?: ConsommerUsage;
  maintenant?: () => number;
  aleatoire?: () => string;
};

export async function actionFactureSms<R>(c: Record<string, unknown>, confirme: boolean, baseBrute: Record<string, unknown>, { interne, rep, cle, consommer, maintenant = Date.now, aleatoire = nonceAleatoire }: DepsFactureSms<R>, autorisation?: unknown): Promise<R> {
  const base = baseFacture(baseBrute);
  const f = factureSms(c); if ('erreur' in f) return rep(422, { ok: false, erreur: f.erreur });
  if (!cle) return rep(503, { ok: false, erreur: 'clé serveur absente' });
  if (!confirme) { // aperçu : autorisation neuve (nonce aléatoire, 10 min), rien n'est écrit
    const nonce = aleatoire(); const expire = maintenant() + DUREE_AUTORISATION_MS;
    return rep(200, { ...base, sms: f.apercu, autorisation: nonce + '.' + expire + '.' + await autorisationFacture(cle, nonce, expire, f.tel, f.lien, f.texte) });
  }
  const m = typeof autorisation === 'string' ? AUTORISATION_RE.exec(autorisation) : null;
  if (!m) return rep(409, { ok: false, erreur: ERREUR_AUTORISATION }); // absente ou illisible : rien n'est parti
  const [, nonce, exp, sig] = m; const expire = Number(exp);
  if (!egal(sig, await autorisationFacture(cle, nonce, expire, f.tel, f.lien, f.texte))) return rep(409, { ok: false, erreur: ERREUR_EMPREINTE }); // commande changée, fausse, autre clé
  if (maintenant() > expire) return rep(409, { ok: false, erreur: ERREUR_AUTORISATION }); // expirée
  if (typeof consommer !== 'function') return rep(503, { ok: false, erreur: ERREUR_VERROU });
  let u: 'ok' | 'deja' | 'erreur'; try { u = await consommer(FOURNISSEUR_USAGE + ':' + nonce, new Date(expire).toISOString()); } catch { u = 'erreur'; }
  if (u === 'deja') return rep(409, { ok: false, erreur: ERREUR_AUTORISATION }); // rejeu : une seule requête gagne
  if (u !== 'ok') return rep(503, { ok: false, erreur: ERREUR_VERROU }); // jamais d'envoi sans usage enregistré
  const r = await interne('send-sms', { tel: f.tel, message: f.texte, type: 'jarvis', client: String(c.client || '') });
  // revue Codex #21 (P2) : `indetermine` examiné AVANT `success` (200 OVH illisible, 5xx ou coupure après acceptation = le SMS est peut-être parti : jamais « non envoyé », sinon un nouvel aperçu enverrait la facture en double) ; `journal_echoue` dit aussi
  const nJ = r.j?.journal_echoue === true ? ' ATTENTION : l’historique SMS n’a pas pu être écrit, il ne contient aucune trace de cet envoi.' : '';
  if (r.j?.indetermine === true) return rep(502, { ok: false, erreur: 'résultat de l’envoi INDÉTERMINÉ : le SMS est peut-être parti, vérifie l’historique SMS (commande ' + String(c.id) + ') avant de recommencer' + nJ });
  if (!r.j?.success) return rep(502, { ok: false, erreur: 'SMS non envoyé (HTTP ' + r.http + ')' + nJ });
  return rep(200, { ...base, sms: f.apercu, fait: true, ...(nJ ? { journal_echoue: true, avertissement: nJ.trim() } : {}) });
}
