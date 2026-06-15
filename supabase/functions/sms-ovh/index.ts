// ════════════════════════════════════════════════════════════════════
// Edge Function : sms-ovh (v1.2 — 12/06/2026)
// ════════════════════════════════════════════════════════════════════
// Envoi de SMS via l'API OVH (https://eu.api.ovh.com/1.0).
// Creee pour : campagnes marketing base clients + future migration des
// SMS transactionnels (Brevo bloque depuis le 12/06).
//
// Actions (POST { action: ... }) :
//   - "status"   : credits restants + expediteurs valides + nom du service
//   - "test"     : { tel, message } → envoie 1 SMS
//   - "campagne" : { tels: [...], message, confirm? } → envoi par lots de 50
//                  ⚠️ confirm:true OBLIGATOIRE au-dela de 50 numeros
//                  (garde-fou anti envoi de masse accidentel)
//   - "tick"     : (pg_cron 30 min) si une campagne est en statut
//                  "attente_expediteur" dans campagnes_sms ET que
//                  l'expediteur OVH_SMS_SENDER est valide ("enable") ET
//                  qu'on est dans la fenetre legale (10h-19h Paris,
//                  lun-sam) → envoie la campagne + SMS recap a Borhen.
//                  Si l'expediteur est refuse → campagne en "erreur" +
//                  SMS d'alerte. Anti double-envoi : statut passe a
//                  "en_cours" AVANT l'envoi.
//   - dryRun:true sur test/campagne → montre le message final sans envoyer
//
// STOP / desinscription : classe marketing OVH (noStopClause:false) →
// OVH ajoute automatiquement la mention "STOP au XXXXX" au message et
// gere la blacklist (les numeros ayant repondu STOP sont rejetes comme
// invalidReceivers — on ne peut plus leur ecrire, c'est voulu et legal).
//
// Secrets requis (npx supabase secrets set ...) :
//   - OVH_APP_KEY       (application key)
//   - OVH_APP_SECRET    (application secret)
//   - OVH_CONSUMER_KEY  (consumer key)
//   - OVH_SMS_SERVICE   (optionnel — ex "sms-ab12345-1" ; sinon auto-detecte)
//   - OVH_SMS_SENDER    (optionnel — ex "MAXICONFORT" ; doit etre valide
//                        cote OVH, sinon envoi avec numero court reponse)
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const OVH_AK      = Deno.env.get('OVH_APP_KEY') || '';
const OVH_AS      = Deno.env.get('OVH_APP_SECRET') || '';
const OVH_CK      = Deno.env.get('OVH_CONSUMER_KEY') || '';
const OVH_SERVICE = Deno.env.get('OVH_SMS_SERVICE') || '';
const OVH_SENDER  = Deno.env.get('OVH_SMS_SENDER') || '';
const SB_URL      = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const OVH_API = 'https://eu.api.ovh.com/1.0';
const LOT_TAILLE = 50; // numeros par appel OVH (l'API en accepte plus, on reste prudent)
const TEL_BORHEN = '+33744289321'; // SMS recap/alerte campagnes

const sb = createClient(SB_URL, SB_SR_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Max-Age': '86400',
};
const JSON_HEADERS = { 'Content-Type': 'application/json', ...CORS_HEADERS };

// ── Signature OVH : $1$ + SHA1(AS+CK+METHOD+URL+BODY+TS) ─────────────
async function sha1Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

let driftOVH: number | null = null; // decalage horloge locale vs serveur OVH
async function tsOVH(): Promise<number> {
  if (driftOVH === null) {
    const r = await fetch(OVH_API + '/auth/time');
    const serverTs = parseInt(await r.text(), 10);
    driftOVH = serverTs - Math.floor(Date.now() / 1000);
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
  try { data = await resp.json(); } catch { /* reponse vide */ }
  return { status: resp.status, data };
}

// ── Service SMS : depuis le secret, sinon auto-detection ─────────────
let serviceCache: string | null = null;
async function serviceSMS(): Promise<string> {
  if (OVH_SERVICE) return OVH_SERVICE;
  if (serviceCache) return serviceCache;
  const r = await ovh('GET', '/sms');
  if (r.status !== 200 || !Array.isArray(r.data) || !r.data.length) {
    throw new Error('Aucun service SMS trouve sur ce compte OVH (HTTP ' + r.status + ' ' + JSON.stringify(r.data) + ')');
  }
  serviceCache = r.data[0];
  return serviceCache!;
}

// ── Normalisation telephone → +336/+337 ──────────────────────────────
function telIntl(tel: string): string {
  if (!tel) return '';
  let t = String(tel).replace(/[\s.()\-]/g, '');
  if (t.startsWith('0033')) t = '+33' + t.slice(4);
  else if (t.startsWith('33') && t.length === 11) t = '+' + t;
  else if (t.startsWith('0') && t.length === 10) t = '+33' + t.slice(1);
  if (!/^\+33[67]\d{8}$/.test(t)) return '';
  return t;
}

// ── GSM-7 : sans accents = 160 car/segment au lieu de 70 ─────────────
function sansAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[œŒ]/g, 'oe').replace(/[æÆ]/g, 'ae')
    .replace(/[«»"]/g, '"').replace(/[''`]/g, "'")
    .replace(/[—–]/g, '-').replace(/…/g, '...')
    .replace(/[^\x00-\x7F€]/g, '');
}

// ── Envoi d'un lot via POST /sms/{service}/jobs ──────────────────────
async function envoyerLot(service: string, receivers: string[], message: string, tag: string, noStop = false, forceNumeroCourt = false) {
  const payload: any = {
    message,
    receivers,
    charset: 'UTF-8',
    coding: '7bit',
    noStopClause: noStop,      // marketing (false) → OVH ajoute "STOP au XXXXX" + blacklist auto
    priority: 'medium',
    tag: tag.substring(0, 20),
    validityPeriod: 2880,
  };
  // forceNumeroCourt : SMS internes a Borhen (alerte/recap) — partent
  // toujours par numero court, meme si l'expediteur alpha est bloque.
  if (OVH_SENDER && !forceNumeroCourt) payload.sender = OVH_SENDER;
  else payload.senderForResponse = true;
  const r = await ovh('POST', `/sms/${service}/jobs`, payload);
  return r;
}

async function logHistorique(entries: any[]) {
  if (!entries.length) return;
  try {
    await sb.from('sms_historique').insert(entries);
  } catch (_e) { /* silent */ }
}

// ── Envoi complet d'une campagne (lots + logs) ───────────────────────
async function executerCampagne(service: string, tels: string[], message: string, tag: string) {
  let envoyes = 0, credits = 0;
  const invalides: string[] = [];
  const erreurs: any[] = [];
  const logs: any[] = [];
  for (let i = 0; i < tels.length; i += LOT_TAILLE) {
    const lot = tels.slice(i, i + LOT_TAILLE);
    const r = await envoyerLot(service, lot, message, tag);
    if (r.status === 200) {
      const inv: string[] = r.data?.invalidReceivers || [];
      invalides.push(...inv);
      const okLot = lot.filter(t => !inv.includes(t));
      envoyes += okLot.length;
      credits += r.data?.totalCreditsRemoved || 0;
      const dateSms = new Date().toISOString().split('T')[0];
      const heure = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
      for (const t of okLot) {
        logs.push({
          id: 'sms_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          client: '', tel: t, type_sms: 'campagne', msg: message,
          statut: 'envoyé', date_sms: dateSms, heure,
        });
      }
    } else {
      erreurs.push({ lot: i / LOT_TAILLE + 1, status: r.status, detail: r.data });
      // on continue les lots suivants : un lot en echec ne bloque pas la campagne
    }
  }
  await logHistorique(logs);
  return { envoyes, credits, invalides, erreurs };
}

// ── Fenetre legale marketing : 10h-19h59 Paris, lundi-samedi ─────────
function fenetreLegaleOK(): boolean {
  const paris = new Date().toLocaleString('en-GB', { timeZone: 'Europe/Paris', hour12: false, weekday: 'short', hour: '2-digit' });
  // ex "Fri, 14" — weekday + heure
  const jour = paris.slice(0, 3);
  const heure = parseInt(paris.match(/(\d{2})$/)?.[1] || '0', 10);
  if (jour === 'Sun') return false;
  return heure >= 10 && heure < 20;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  try {
    return await handleRequest(req);
  } catch (e: any) {
    console.error('sms-ovh exception:', e?.message || e, e?.stack || '');
    return new Response(JSON.stringify({ ok: false, error: 'Erreur interne: ' + (e?.message || String(e)) }),
      { status: 500, headers: JSON_HEADERS });
  }
});

async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'POST uniquement' }), { status: 405, headers: JSON_HEADERS });
  }
  if (!OVH_AK || !OVH_AS || !OVH_CK) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'Secrets OVH manquants (OVH_APP_KEY / OVH_APP_SECRET / OVH_CONSUMER_KEY)',
    }), { status: 503, headers: JSON_HEADERS });
  }

  let body: any = {};
  try { body = await req.json(); } catch {}
  const action: string = body.action || 'status';

  // ── STATUS : credits + senders ──────────────────────────────────────
  if (action === 'status') {
    const service = await serviceSMS();
    const [info, senders] = await Promise.all([
      ovh('GET', `/sms/${service}`),
      ovh('GET', `/sms/${service}/senders`),
    ]);
    return new Response(JSON.stringify({
      ok: info.status === 200,
      service,
      credits: info.data?.creditsLeft ?? null,
      senders: Array.isArray(senders.data) ? senders.data : [],
      senderConfigure: OVH_SENDER || '(aucun — numero court reponse)',
      detail: info.status !== 200 ? info.data : undefined,
    }), { headers: JSON_HEADERS });
  }

  // ── TEST : 1 SMS ────────────────────────────────────────────────────
  if (action === 'test') {
    const tel = telIntl(body.tel);
    if (!tel) {
      return new Response(JSON.stringify({ ok: false, error: 'tel invalide (mobile FR 06/07 attendu)' }),
        { status: 400, headers: JSON_HEADERS });
    }
    const message = sansAccents(String(body.message || '')).trim();
    if (!message) {
      return new Response(JSON.stringify({ ok: false, error: 'message requis' }), { status: 400, headers: JSON_HEADERS });
    }
    if (body.dryRun) {
      return new Response(JSON.stringify({ ok: true, dryRun: true, tel, message, longueur: message.length }),
        { headers: JSON_HEADERS });
    }
    const service = await serviceSMS();
    const r = await envoyerLot(service, [tel], message, 'test');
    const ok = r.status === 200;
    await logHistorique([{
      id: 'sms_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      client: body.client || 'TEST OVH',
      tel,
      type_sms: 'campagne-test',
      msg: message,
      statut: ok ? 'envoyé' : 'échec',
      date_sms: new Date().toISOString().split('T')[0],
      heure: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }),
    }]);
    return new Response(JSON.stringify({
      ok, status: r.status,
      credits: r.data?.totalCreditsRemoved,
      invalides: r.data?.invalidReceivers || [],
      detail: ok ? undefined : r.data,
    }), { status: ok ? 200 : 502, headers: JSON_HEADERS });
  }

  // ── CAMPAGNE : lots de 50 ───────────────────────────────────────────
  if (action === 'campagne') {
    const message = sansAccents(String(body.message || '')).trim();
    if (!message) {
      return new Response(JSON.stringify({ ok: false, error: 'message requis' }), { status: 400, headers: JSON_HEADERS });
    }
    const bruts: string[] = Array.isArray(body.tels) ? body.tels : [];
    const tels = [...new Set(bruts.map(telIntl).filter(Boolean))];
    if (!tels.length) {
      return new Response(JSON.stringify({ ok: false, error: 'aucun numero mobile FR valide dans tels[]' }),
        { status: 400, headers: JSON_HEADERS });
    }
    if (body.dryRun) {
      return new Response(JSON.stringify({
        ok: true, dryRun: true, nbValides: tels.length, nbRejetes: bruts.length - tels.length,
        message, longueur: message.length, apercu: tels.slice(0, 5),
      }), { headers: JSON_HEADERS });
    }
    if (tels.length > LOT_TAILLE && body.confirm !== true) {
      return new Response(JSON.stringify({
        ok: false,
        error: `${tels.length} numeros : envoi de masse — repassez avec confirm:true pour valider`,
      }), { status: 400, headers: JSON_HEADERS });
    }

    const service = await serviceSMS();
    const res = await executerCampagne(service, tels, message, String(body.tag || 'campagne'));

    return new Response(JSON.stringify({
      ok: res.erreurs.length === 0,
      envoyes: res.envoyes,
      credits: res.credits,
      blacklistOuInvalides: res.invalides,
      erreurs: res.erreurs.length ? res.erreurs : undefined,
    }), { headers: JSON_HEADERS });
  }

  // ── TICK (pg_cron) : envoie la campagne en attente des que possible ─
  if (action === 'tick') {
    const { data: camp } = await sb.from('campagnes_sms')
      .select('*').eq('statut', 'attente_expediteur')
      .order('cree_le', { ascending: true }).limit(1).maybeSingle();
    if (!camp) {
      return new Response(JSON.stringify({ ok: true, rien: true }), { headers: JSON_HEADERS });
    }
    if (!fenetreLegaleOK()) {
      return new Response(JSON.stringify({ ok: true, attente: 'hors fenetre legale (10h-20h lun-sam)' }),
        { headers: JSON_HEADERS });
    }
    const service = await serviceSMS();
    if (OVH_SENDER) {
      const s = await ovh('GET', `/sms/${service}/senders/${encodeURIComponent(OVH_SENDER)}`);
      const st = s.data?.status || 'inconnu';
      if (st === 'refused' || st === 'disable') {
        await sb.from('campagnes_sms').update({ statut: 'erreur', resultat: { raison: 'expediteur ' + st } }).eq('id', camp.id);
        await envoyerLot(service, [TEL_BORHEN], `MAXICONFORT app : expediteur ${OVH_SENDER} ${st} par OVH — campagne "${camp.nom}" annulee. Voir manager OVH.`, 'alerte', true, true).catch(() => {});
        return new Response(JSON.stringify({ ok: false, error: 'expediteur ' + st }), { headers: JSON_HEADERS });
      }
      if (st !== 'enable') {
        return new Response(JSON.stringify({ ok: true, attente: 'expediteur ' + st }), { headers: JSON_HEADERS });
      }
    }
    // Anti double-envoi : on verrouille AVANT d'envoyer
    const { data: lock } = await sb.from('campagnes_sms')
      .update({ statut: 'en_cours' }).eq('id', camp.id).eq('statut', 'attente_expediteur').select();
    if (!lock || !lock.length) {
      return new Response(JSON.stringify({ ok: true, attente: 'deja prise en charge' }), { headers: JSON_HEADERS });
    }
    const tels: string[] = (Array.isArray(camp.tels) ? camp.tels : []).map(telIntl).filter(Boolean);
    const res = await executerCampagne(service, tels, camp.message, camp.nom || 'campagne');
    await sb.from('campagnes_sms').update({
      statut: res.erreurs.length ? 'erreur' : 'envoyee',
      envoyee_le: new Date().toISOString(),
      resultat: { envoyes: res.envoyes, credits: res.credits, invalides: res.invalides, erreurs: res.erreurs },
    }).eq('id', camp.id);
    await envoyerLot(service, [TEL_BORHEN],
      `MAXICONFORT app : campagne "${camp.nom}" envoyee a ${res.envoyes} clients (${res.credits} credits, ${res.invalides.length} blacklist/invalides).`,
      'recap', true, true).catch(() => {});
    return new Response(JSON.stringify({ ok: true, campagne: camp.id, ...res }), { headers: JSON_HEADERS });
  }

  return new Response(JSON.stringify({ ok: false, error: 'action inconnue (status | test | campagne | tick)' }),
    { status: 400, headers: JSON_HEADERS });
}
