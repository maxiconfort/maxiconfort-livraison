// Règles pures des SMS « confirmation » et « expedition » (19/10/2026), testées en Node :
//   node --test supabase/tests/
// 1) Confirmation à la prise de commande : jamais de date (non confirmée à ce stade), texte GLS / livreur distinct.
// 2) Expédition GLS : seulement après PREUVE de prise en charge par GLS (1er événement autre que DATA_RECEIVED),
//    jamais à la création de l'étiquette ni à la saisie d'un numéro de suivi.
// 3) Rattrapage automatique de la confirmation : laisse 3 min à l'envoi immédiat de l'application (pas de doublon).

export const PREUVE_PRISE_EN_CHARGE = 'prise_en_charge_gls';
export const DELAI_RATTRAPAGE_MIN = 3;

export function texteConfirmation(prenom: string, transporteur: string | null | undefined): string {
  return (transporteur || 'RANOU') === 'GLS'
    ? `Bonjour ${prenom}, votre commande est bien enregistree. Nous vous enverrons votre numero de suivi GLS par SMS. Merci de votre confiance.`
    : `Bonjour ${prenom}, votre commande est bien enregistree. Nous vous informerons de la date de livraison et du passage de notre livreur. Merci.`;
}

export function dejaEnvoye(smsEnvoyes: unknown, type: string): boolean {
  return Array.isArray(smsEnvoyes) && smsEnvoyes.some((e: any) => e && e.type === type);
}

// Garde de send-cmd-sms pour le type « expedition » : seule la synchro GLS, avec la preuve, peut le déclencher.
export function expeditionAutorisee(body: any, cmd: any): { ok: boolean; raison?: string } {
  if (cmd && (cmd.statut === 'annulé' || cmd.statut === 'livré')) return { ok: false, raison: 'commande ' + cmd.statut };
  if (!body || body.preuve !== PREUVE_PRISE_EN_CHARGE) return { ok: false, raison: 'attente_prise_en_charge_gls' };
  return { ok: true };
}

// Décision de gls-sync : faut-il demander le SMS d'expédition pour cette commande ?
//   colis = analyses gls-analyse (priseEnCharge vrai dès le 1er scan GLS réel).
export function doitEnvoyerExpedition(cmd: any, colis: Array<{ priseEnCharge: boolean }>): boolean {
  if (!cmd || cmd.statut === 'annulé' || cmd.statut === 'livré') return false;
  if (dejaEnvoye(cmd.sms_envoyes, 'expedition')) return false;
  return Array.isArray(colis) && colis.some((c) => c && c.priseEnCharge);
}

// Rattrapage (cron sms-confirmation) : commande créée depuis plus de DELAI_RATTRAPAGE_MIN minutes,
// pas SAV, pas GLS déjà munie d'un suivi, pas déjà confirmée.
export function confirmationRattrapageEligible(c: any, maintenantMs: number): { ok: boolean; raison?: string } {
  const id = String(c && c.id || '');
  if (id.indexOf('#SAV') === 0) return { ok: false, raison: 'sav' };
  if ((c.transporteur || 'RANOU') === 'GLS' && c.tracking_transporteur) return { ok: false, raison: 'gls_tracking' };
  if (dejaEnvoye(c.sms_envoyes, 'confirmation')) return { ok: false, raison: 'deja_confirme' };
  const age = maintenantMs - new Date(c.created_at).getTime();
  if (!(age >= DELAI_RATTRAPAGE_MIN * 60 * 1000)) return { ok: false, raison: 'trop_recente' };
  return { ok: true };
}
