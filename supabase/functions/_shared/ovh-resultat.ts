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
    const ids = Array.isArray(data?.ids) && data.ids.length > 0; const valides = Array.isArray(data?.validReceivers) && data.validReceivers.length > 0;
    if (data && typeof data === 'object' && (ids || valides)) return { ok: true, certain: true };
    return { ok: false, certain: false, raison: 'réponse OVH 200 illisible', http200Illisible: true };
  }
  if (status >= 400 && status < 500) return { ok: false, certain: true, raison: 'refus OVH (HTTP ' + status + ')' };
  return { ok: false, certain: false, raison: 'réponse OVH indéterminée (HTTP ' + status + ')' };
}

/** Exception pendant l'appel OVH (coupure, délai) : on ne sait pas si l'envoi a été pris en compte. */
export const RESULTAT_EXCEPTION: ResultatOvh = { ok: false, certain: false, raison: 'exception pendant l’appel OVH' };
