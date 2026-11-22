// « Un client n'est prévenu qu'UNE fois par jour » — réservation atomique côté base (migration 037), tous canaux (22/11/2026).
// Module à logique pure + deux appels RPC ; aucune donnée client (numéro de commande, jour, canal).
// deno-lint-ignore-file no-explicit-any

export type Canal = 'veille' | 'jarvis';
export type Reservation =
  | { etat: 'reserve'; jour: string }   // le JOUR réservé est conservé avec la réservation : la libération vise CE jour, jamais « aujourd'hui » recalculé (minuit)
  | { etat: 'deja'; canal: string }
  | { etat: 'indisponible'; raison: string };

/** Jour calendaire à Paris (AAAA-MM-JJ) : la réservation est par jour de Paris, comme le « aujourd'hui » de JARVIS. */
export function jourParis(maintenant: Date = new Date()): string {
  const p = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(maintenant);
  return p; // fr-CA => AAAA-MM-JJ
}

/** Réserve (commande, jour) pour un canal. Jamais d'exception : une base injoignable ou une fonction absente = « indisponible » (le canal décide : veille ouvre, JARVIS ferme). */
export async function reserverPrevenir(sb: any, cmdId: string, canal: Canal, maintenant: Date = new Date()): Promise<Reservation> {
  const jour = jourParis(maintenant);
  try {
    const { data, error } = await sb.rpc('reserver_prevenir', { p_cmd: String(cmdId), p_jour: jour, p_canal: canal });
    if (error) return { etat: 'indisponible', raison: String(error.message || error.code || 'erreur base').slice(0, 120) };
    if (data && data.reserve === true) return { etat: 'reserve', jour };
    if (data && data.reserve === false && typeof data.canal === 'string') return { etat: 'deja', canal: data.canal };
    return { etat: 'indisponible', raison: 'réponse inattendue de la base' };
  } catch (e) { return { etat: 'indisponible', raison: String((e as Error).message || e).slice(0, 120) }; }
}

/** Libère la réservation du même canal après un envoi ÉCHOUÉ AVEC CERTITUDE (le client reste atteignable). `jour` = celui de la réservation (revue Codex #20 :
 *  un envoi qui échoue après minuit ne doit ni viser le jour suivant ni supprimer la réservation valide d'une autre requête). Silencieux en cas d'erreur. */
export async function libererPrevenir(sb: any, cmdId: string, canal: Canal, jour: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(jour))) return;
  try { await sb.rpc('liberer_prevenir', { p_cmd: String(cmdId), p_jour: jour, p_canal: canal }); } catch { /* ignoré */ }
}

/** Échec CERTAIN d'un envoi = la fonction d'envoi a répondu elle-même « success: false » (rien n'est parti) : la réservation est libérée.
 *  Tout le reste (exception réseau, passerelle sans réponse lisible, délai) est INDÉTERMINÉ : le SMS est peut-être parti, la réservation est GARDÉE
 *  (aucun doublon possible) et l'échec est dit à l'appelant. Pure. */
export function echecCertain(reponse: { http?: number; j?: any } | null | undefined): boolean {
  return !!reponse && !!reponse.j && typeof reponse.j === 'object' && reponse.j.success === false;
}

/** Politique par canal quand la base ne répond pas : le SMS « veille » automatique part comme avant (fail-open, aucune régression) ;
 *  JARVIS ne part PAS (fail-closed : on ne sait pas si le client est déjà prévenu). Pure. */
export function peutEnvoyer(r: Reservation, canal: Canal): { ok: true } | { ok: false; code: number; raison: string } {
  if (r.etat === 'reserve') return { ok: true };
  if (r.etat === 'deja') return { ok: false, code: 409, raison: 'client déjà prévenu aujourd’hui (canal ' + r.canal + ') : rien n’est envoyé' };
  return canal === 'veille' ? { ok: true } : { ok: false, code: 503, raison: 'impossible de vérifier si le client est déjà prévenu (' + r.raison + ') : rien n’est envoyé' };
}

export type IssueEnvoi =
  | { issue: 'envoye'; jour: string | null }
  | { issue: 'deja'; canal: string; raison: string }
  | { issue: 'bloque_indisponible'; code: number; raison: string }
  | { issue: 'echec_certain'; jour: string | null }
  | { issue: 'echec_indetermine'; jour: string | null };

/** Parcours COMPLET d'un envoi avec réservation, testé de bout en bout (revue Codex #20, points 3 et 4) : réserver → envoyer → journaliser.
 *  - déjà réservé par un autre canal : rien n'est envoyé ;
 *  - base indisponible : veille = envoi comme avant (fail-open, choix assumé : la migration peut ne pas être appliquée), JARVIS = rien n'est envoyé (fail-closed) ;
 *  - échec CERTAIN : la réservation est libérée AVANT toute journalisation, sur le JOUR RÉSERVÉ, et une erreur de journalisation ou de libération n'empêche rien ;
 *  - échec INDÉTERMINÉ (exception pendant l'envoi) : réservation GARDÉE (le SMS est peut-être parti, aucun doublon possible).
 *  `envoyer` renvoie { ok, certain } : ok=false et certain=true = refus explicite (rien n'est parti) ; une exception = indéterminé. */
export async function envoyerAvecReservation(o: {
  sb: any; cmdId: string; canal: Canal; maintenant?: Date;
  envoyer: () => Promise<{ ok: boolean; certain?: boolean }>;
  journaliser?: (ok: boolean) => Promise<void>;
}): Promise<IssueEnvoi> {
  const r = await reserverPrevenir(o.sb, o.cmdId, o.canal, o.maintenant);
  const p = peutEnvoyer(r, o.canal);
  if (!p.ok) return r.etat === 'deja' ? { issue: 'deja', canal: r.canal, raison: p.raison } : { issue: 'bloque_indisponible', code: p.code, raison: p.raison };
  const jour = r.etat === 'reserve' ? r.jour : null;
  const noter = async (ok: boolean) => { try { if (o.journaliser) await o.journaliser(ok); } catch { /* une erreur de journalisation ne change jamais l'issue */ } };
  let res: { ok: boolean; certain?: boolean };
  try { res = await o.envoyer(); } catch { await noter(false); return { issue: 'echec_indetermine', jour }; }
  if (res.ok) { await noter(true); return { issue: 'envoye', jour }; }
  if (res.certain === false) { await noter(false); return { issue: 'echec_indetermine', jour }; }
  if (jour) await libererPrevenir(o.sb, o.cmdId, o.canal, jour);   // libération AVANT la journalisation
  await noter(false);
  return { issue: 'echec_certain', jour };
}
