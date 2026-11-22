// Classement du résultat d'un envoi OVH (22/11/2026, revue Codex #20) — module pur, sans Deno ni réseau.
// ok       : OVH a accepté l'envoi.
// certain  : (si !ok) rien n'est parti AVEC CERTITUDE (refus explicite d'OVH, numéro invalide, secrets absents…) → on peut réessayer.
//            Faux = résultat INDÉTERMINÉ (exception réseau, réponse 5xx, réponse illisible) : le SMS est PEUT-ÊTRE parti → ne jamais réessayer à l'aveugle.

export type ResultatOvh = { ok: boolean; certain: boolean; raison?: string; http200Illisible?: boolean };

/** Réponse HTTP d'OVH → résultat. 200 = accepté (sauf destinataire invalide) ; 4xx = refus explicite ; tout le reste = indéterminé. Pure. */
export function classerReponseOvh(status: number, data: any, numero: string): ResultatOvh {
  if (status === 200) {
    const invalides: string[] = Array.isArray(data?.invalidReceivers) ? data.invalidReceivers : [];
    if (invalides.includes(numero)) return { ok: false, certain: true, raison: 'destinataire invalide ou refusé' };
    // revue Codex #20 : un HTTP 200 n'est un succès LISIBLE que si la réponse d'OVH porte la preuve de la prise en charge (identifiants de job ou destinataires valides) ;
    // un corps absent, vide ou mal formé = INDÉTERMINÉ (le SMS est peut-être parti). `http200Illisible` permet au booléen historique de rester identique pour les autres appelants.
    // revue Codex #20 : `validReceivers` n'est une preuve que s'il contient LE numéro demandé (un tableau non vide d'autres numéros, ou mal formé, n'en est pas une)
    const ids = Array.isArray(data?.ids) && data.ids.length > 0; const valides = Array.isArray(data?.validReceivers) && data.validReceivers.includes(numero);
    if (data && typeof data === 'object' && (ids || valides)) return { ok: true, certain: true };
    return { ok: false, certain: false, raison: 'réponse OVH 200 illisible', http200Illisible: true };
  }
  if (status >= 400 && status < 500) return { ok: false, certain: true, raison: 'refus OVH (HTTP ' + status + ')' };
  return { ok: false, certain: false, raison: 'réponse OVH indéterminée (HTTP ' + status + ')' };
}

/** Statut écrit dans l'historique SMS (colonne `statut`) — UN SEUL libellé par issue, partagé par send-sms et send-cmd-sms ; `resumeSms` (sms_statut) le relit.
 *  Le libellé indéterminé COMMENCE par « indéterminé » (jamais par « échec ») pour que la relecture de l'historique ne le prenne pas pour un échec. Pur. */
export const STATUT_ENVOYE = 'envoyé';
export const STATUT_ECHEC = 'échec';
export const STATUT_INDETERMINE = 'indéterminé (peut-être parti)';
export function statutSms(r: ResultatOvh): string { return r.ok ? STATUT_ENVOYE : r.certain ? STATUT_ECHEC : STATUT_INDETERMINE; }

/** Réponse de `send-sms` (revue Codex #20, point 4) : COMPATIBLE avec tous les appelants historiques — `success` garde son sens d'avant (HTTP 200 d'OVH = true, même si le corps est illisible ;
 *  refus, 5xx, exception = false) — et le drapeau `indetermine: true` s'ajoute SEULEMENT quand le SMS est peut-être parti (200 illisible, 5xx, exception) : les appelants qui l'ignorent
 *  se comportent exactement comme avant (aucune nouvelle tentative aveugle de plus) ; JARVIS et la veille, qui lisent le drapeau, gardent leur réservation. Pur. */
export function reponseSendSms(r: ResultatOvh, journalEchoue = false): { status: number; corps: { success: boolean; indetermine?: true; journal_echoue?: true } } {
  const success = r.ok || r.http200Illisible === true;
  const indetermine = !r.ok && !r.certain;
  return { status: success ? 200 : 502, corps: { success, ...(indetermine ? { indetermine: true as const } : {}), ...(journalEchoue ? { journal_echoue: true as const } : {}) } };
}

/** Exception pendant l'appel OVH (coupure, délai) : on ne sait pas si l'envoi a été pris en compte. */
export const RESULTAT_EXCEPTION: ResultatOvh = { ok: false, certain: false, raison: 'exception pendant l’appel OVH' };
