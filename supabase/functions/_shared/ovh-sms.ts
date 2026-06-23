// ════════════════════════════════════════════════════════════════════
// Helper partagé : envoi SMS via OVH (remplace Brevo — 16/06/2026)
// ════════════════════════════════════════════════════════════════════
// Importé par send-cmd-sms, send-sms, sms-veille, gls-sync,
// confirmer-presence. Centralise la signature API OVH pour éviter de
// dupliquer le code dans chaque Edge Function.
//
// Secrets requis (partagés par toutes les fonctions du projet) :
//   OVH_APP_KEY / OVH_APP_SECRET / OVH_CONSUMER_KEY
//   OVH_SMS_SERVICE (ex "sms-rw88345-1")
//   OVH_SMS_SENDER  (ex "MAXICONFORT" — doit être validé côté OVH)
//
// SMS transactionnels (livraison, expédition, alertes) = noStop:true
// (pas de mention STOP, légal car liés à une commande/un service).
// Seules les campagnes marketing (sms-ovh) gardent la clause STOP.
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any

const OVH_AK      = Deno.env.get('OVH_APP_KEY') || '';
const OVH_AS      = Deno.env.get('OVH_APP_SECRET') || '';
const OVH_CK      = Deno.env.get('OVH_CONSUMER_KEY') || '';
const OVH_SERVICE = Deno.env.get('OVH_SMS_SERVICE') || 'sms-rw88345-1';
const OVH_SENDER  = Deno.env.get('OVH_SMS_SENDER') || '';
const OVH_API     = 'https://eu.api.ovh.com/1.0';

async function sha1Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

let driftOVH: number | null = null;
async function tsOVH(): Promise<number> {
  if (driftOVH === null) {
    const r = await fetch(OVH_API + '/auth/time');
    driftOVH = parseInt(await r.text(), 10) - Math.floor(Date.now() / 1000);
  }
  return Math.floor(Date.now() / 1000) + driftOVH;
}

async function ovh(method: string, path: string, body?: any): Promise<{ status: number; data: any }> {
  const url = OVH_API + path;
  const bodyStr = body ? JSON.stringify(body) : '';
  const ts = await tsOVH();
  const sig = '$1$' + await sha1Hex([OVH_AS, OVH_CK, method, url, bodyStr, ts].join('+'));
  const resp = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Ovh-Application': OVH_AK,
      'X-Ovh-Consumer': OVH_CK,
      'X-Ovh-Timestamp': String(ts),
      'X-Ovh-Signature': sig,
    },
    body: bodyStr || undefined,
  });
  let data: any = null;
  try { data = await resp.json(); } catch { /* vide */ }
  return { status: resp.status, data };
}

// Lit le solde de crédits SMS restant chez OVH (pour les alertes/rapports).
// Renvoie le nombre de crédits, ou null si indisponible.
export async function creditsOVH(): Promise<number | null> {
  if (!OVH_AK || !OVH_AS || !OVH_CK) return null;
  try {
    const r = await ovh('GET', `/sms/${OVH_SERVICE}`);
    if (r.status !== 200) return null;
    const c = r.data?.creditsLeft;
    return (typeof c === 'number') ? c : null;
  } catch { return null; }
}

// Normalisation téléphone FR → +336/+337 (mobiles uniquement)
export function telIntl(tel: string): string {
  if (!tel) return '';
  let t = String(tel).replace(/[\s.()\-]/g, '');
  if (t.startsWith('0033')) t = '+33' + t.slice(4);
  else if (t.startsWith('33') && t.length === 11) t = '+' + t;
  else if (t.startsWith('0') && t.length === 10) t = '+33' + t.slice(1);
  if (!/^\+33[67]\d{8}$/.test(t)) return '';
  return t;
}

// GSM-7 : retire accents/caractères spéciaux → 160 car/segment au lieu de 70
export function sansAccents(s: string): string {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[œŒ]/g, 'oe').replace(/[æÆ]/g, 'ae')
    .replace(/[«»""]/g, '"').replace(/[''`]/g, "'")
    .replace(/[—–]/g, '-').replace(/…/g, '...')
    .replace(/[^\x00-\x7F€]/g, '');
}

/**
 * Envoie un SMS via OVH. Renvoie true si OVH a accepté l'envoi.
 * @param tel     numéro destinataire (format souple, normalisé en interne)
 * @param message corps du SMS (accents retirés automatiquement)
 * @param opts.noStop  true (défaut) = transactionnel sans clause STOP
 * @param opts.sender  override d'expéditeur (défaut = OVH_SMS_SENDER)
 * @param opts.forceNumeroCourt  true = envoi par numéro court (ignore le sender alpha)
 */
export async function envoyerSMSOVH(
  tel: string,
  message: string,
  opts: { noStop?: boolean; sender?: string; forceNumeroCourt?: boolean } = {},
): Promise<boolean> {
  if (!OVH_AK || !OVH_AS || !OVH_CK) { console.warn('OVH: secrets manquants'); return false; }
  const num = telIntl(tel);
  if (!num) { console.warn('OVH: tel invalide', tel); return false; }
  const contenu = sansAccents(message).trim();
  if (!contenu) { console.warn('OVH: message vide'); return false; }

  const payload: any = {
    message: contenu,
    receivers: [num],
    charset: 'UTF-8',
    coding: '7bit',
    noStopClause: opts.noStop !== false, // transactionnel par défaut
    priority: 'high',
    validityPeriod: 2880,
  };
  const sender = opts.sender || OVH_SENDER;
  if (sender && !opts.forceNumeroCourt) payload.sender = sender;
  else payload.senderForResponse = true;

  try {
    const r = await ovh('POST', `/sms/${OVH_SERVICE}/jobs`, payload);
    if (r.status !== 200) { console.warn('OVH HTTP', r.status, JSON.stringify(r.data)); return false; }
    const invalides: string[] = r.data?.invalidReceivers || [];
    if (invalides.includes(num)) { console.warn('OVH: destinataire invalide/blacklist', num); return false; }
    return true;
  } catch (e: any) {
    console.warn('OVH exception:', e?.message || e);
    return false;
  }
}
