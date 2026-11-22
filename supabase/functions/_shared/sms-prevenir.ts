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
export async function libererPrevenir(sb: any, cmdId: string, canal: Canal, jour: string): Promise<boolean> {
  // revue Codex #20 : l'échec de libération est SIGNALÉ (false), jamais ignoré : un échec certain ne doit pas laisser le client bloqué sans que personne le sache
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(jour))) return false;
  // revue Codex #20 : la RPC renvoie TRUE seulement si une réservation de CE canal a bien été supprimée ; erreur OU false (rien supprimé) = libération non confirmée
  try { const { data, error } = await sb.rpc('liberer_prevenir', { p_cmd: String(cmdId), p_jour: jour, p_canal: canal }); return !error && data === true; } catch { return false; }
}

/** Échec CERTAIN d'un envoi = la fonction d'envoi a répondu elle-même « success: false » sans `indetermine` (refus explicite d'OVH : rien n'est parti) : la réservation est libérée.
 *  Tout le reste (exception réseau, passerelle sans réponse lisible, délai) est INDÉTERMINÉ : le SMS est peut-être parti, la réservation est GARDÉE
 *  (aucun doublon possible) et l'échec est dit à l'appelant. Pure. */
export function echecCertain(reponse: { http?: number; j?: any } | null | undefined): boolean {
  // revue Codex #20 : send-sms marque `indetermine: true` quand OVH n'a pas répondu clairement (exception réseau, 5xx) : le SMS est peut-être parti
  return !!reponse && !!reponse.j && typeof reponse.j === 'object' && reponse.j.success === false && reponse.j.indetermine !== true;
}

/** Politique par canal quand la base ne répond pas : le SMS « veille » automatique part comme avant (fail-open, aucune régression) ;
 *  JARVIS ne part PAS (fail-closed : on ne sait pas si le client est déjà prévenu). Pure. */
export function peutEnvoyer(r: Reservation, canal: Canal): { ok: true } | { ok: false; code: number; raison: string } {
  if (r.etat === 'reserve') return { ok: true };
  if (r.etat === 'deja') return { ok: false, code: 409, raison: 'client déjà prévenu aujourd’hui (canal ' + r.canal + ') : rien n’est envoyé' };
  return canal === 'veille' ? { ok: true } : { ok: false, code: 503, raison: 'impossible de vérifier si le client est déjà prévenu (' + r.raison + ') : rien n’est envoyé' };
}

/** Numéro de commande à inscrire dans l'historique SMS (revue Codex #20) : forme sûre « #1234 » / « SAV… » seulement, sinon null (rien n'est écrit). Pure. */
export function cmdIdHistorique(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return /^#?[A-Za-z0-9\-]{1,24}$/.test(s) ? s : null;
}

/** Erreur « colonne absente » AVÉRÉE (Postgres 42703 « undefined_column », ou PostgREST qui nomme la colonne cmd_id) — le SEUL cas où le repli sans cmd_id est permis (revue Codex #20). Pure. */
export function colonneCmdIdAbsente(erreur: { message?: string; code?: string } | null | undefined): boolean {
  if (!erreur) return false;
  const code = String(erreur.code || ''); const m = String(erreur.message || '').toLowerCase();
  // revue native Codex #20 : un CODE d'une autre nature (42501 permission refusée, 23xxx contrainte, 08xxx connexion…) exclut TOUJOURS le repli, même si le message cite « column cmd_id »
  if (code) return code === '42703' || code === 'PGRST204';
  // sans code : le message doit DÉCRIRE une colonne inexistante, pas seulement la mentionner
  return /column\s+"?[\w.]*cmd_id"?\s+(of relation\s+"?\w+"?\s+)?does not exist/.test(m) || /could not find the 'cmd_id' column/.test(m) || /cmd_id.*(n'existe pas|introuvable)/.test(m);
}

/** Insère une ligne dans sms_historique en y inscrivant la COMMANDE (colonne cmd_id, migration 038).
 *  - succès : { erreur: null, sansCommande: false } ;
 *  - colonne cmd_id ABSENTE (migration 038 non appliquée, erreur avérée) : réécrit SANS elle et SIGNALE la perte d'information (`sansCommande: true`) ;
 *  - toute autre erreur (base HS, droits, réseau) : PAS de repli (il masquerait la panne), l'erreur est renvoyée.
 *  Partagé par send-sms et send-cmd-sms (revue Codex #20), testé avec une fausse base. */
export async function insererHistorique(sb: any, ligne: Record<string, unknown>, cmdId: string | null): Promise<{ erreur: { message: string } | null; sansCommande: boolean }> {
  const essai = async (l: Record<string, unknown>): Promise<{ message: string; code?: string } | null> => { try { const { error } = await sb.from('sms_historique').insert(l); return error ? { message: String(error.message || error.code || 'insertion refusée'), code: error.code ? String(error.code) : undefined } : null; } catch (e) { return { message: String((e as Error).message || e) }; } };
  if (!cmdId) return { erreur: await essai(ligne), sansCommande: false };
  const avecCmd = await essai({ ...ligne, cmd_id: cmdId });
  if (!avecCmd) return { erreur: null, sansCommande: false };
  if (!colonneCmdIdAbsente(avecCmd)) return { erreur: { message: avecCmd.message }, sansCommande: false };   // pas de repli : l'erreur n'est pas « colonne absente »
  const sans = await essai(ligne);
  return { erreur: sans ? { message: sans.message } : null, sansCommande: !sans };
}

/** Phrase d'avertissement après un envoi INDÉTERMINÉ — HONNÊTE sur la réservation : gardée (aucun doublon possible) ou ABSENTE (base indisponible : un doublon reste possible). Pure. */
export function phraseIndetermine(jour: string | null): string {
  return jour ? 'la réservation du jour est gardée (aucun doublon)' : 'aucune réservation n’a pu être posée (base indisponible) : un doublon reste possible, ne renvoie rien sans avoir vérifié l’historique SMS';
}

export type IssueEnvoi =
  | { issue: 'envoye'; jour: string | null; journal_echoue?: boolean }
  | { issue: 'deja'; canal: string; raison: string }
  | { issue: 'bloque_indisponible'; code: number; raison: string }
  | { issue: 'echec_certain'; jour: string | null; liberation_echouee?: boolean; journal_echoue?: boolean }
  | { issue: 'echec_indetermine'; jour: string | null; journal_echoue?: boolean };

/** Parcours COMPLET d'un envoi avec réservation, testé de bout en bout (revue Codex #20, points 3 et 4) : réserver → envoyer → journaliser.
 *  - déjà réservé par un autre canal : rien n'est envoyé ;
 *  - base indisponible : veille = envoi comme avant (fail-open, choix assumé : la migration peut ne pas être appliquée), JARVIS = rien n'est envoyé (fail-closed) ;
 *  - échec CERTAIN : la réservation est libérée AVANT toute journalisation, sur le JOUR RÉSERVÉ, et une erreur de journalisation ou de libération n'empêche rien ;
 *  - échec INDÉTERMINÉ (exception pendant l'envoi) : réservation GARDÉE (le SMS est peut-être parti, aucun doublon possible).
 *  `envoyer` renvoie { ok, certain } : ok=false et certain=true = refus explicite (rien n'est parti) ; une exception = indéterminé. */
export async function envoyerAvecReservation(o: {
  sb: any; cmdId: string; canal: Canal; maintenant?: Date;
  envoyer: () => Promise<{ ok: boolean; certain?: boolean }>;
  journaliser?: (issue: 'envoye' | 'echec_certain' | 'echec_indetermine') => Promise<void>;   // revue Codex #20 : l'issue INDÉTERMINÉE est distinguée dans le journal
}): Promise<IssueEnvoi> {
  const r = await reserverPrevenir(o.sb, o.cmdId, o.canal, o.maintenant);
  const p = peutEnvoyer(r, o.canal);
  if (!p.ok) return r.etat === 'deja' ? { issue: 'deja', canal: r.canal, raison: p.raison } : { issue: 'bloque_indisponible', code: p.code, raison: p.raison };
  const jour = r.etat === 'reserve' ? r.jour : null;
  // revue Codex #20 : une erreur de journalisation ne change jamais l'issue, mais elle est SIGNALÉE (journal_echoue) : l'appelant le dit et garde une trace exploitable ailleurs
  let journalEchoue = false; const drapeau = () => (journalEchoue ? { journal_echoue: true as const } : {});
  const noter = async (i: 'envoye' | 'echec_certain' | 'echec_indetermine') => { try { if (o.journaliser) await o.journaliser(i); } catch { journalEchoue = true; } };
  let res: { ok: boolean; certain?: boolean };
  try { res = await o.envoyer(); } catch { await noter('echec_indetermine'); return { issue: 'echec_indetermine', jour, ...drapeau() }; }
  if (res.ok) { await noter('envoye'); return { issue: 'envoye', jour, ...drapeau() }; }
  // revue Codex #20 : on ne libère QUE sur un échec explicitement certain (`certain === true`) ; un résultat sans champ `certain` est INDÉTERMINÉ (réservation gardée)
  if (res.certain !== true) { await noter('echec_indetermine'); return { issue: 'echec_indetermine', jour, ...drapeau() }; }
  const liberee = jour ? await libererPrevenir(o.sb, o.cmdId, o.canal, jour) : true;   // libération AVANT la journalisation ; son échec est signalé
  await noter('echec_certain');
  return { issue: 'echec_certain', jour, ...(liberee ? {} : { liberation_echouee: true }), ...drapeau() };
}
