// ════════════════════════════════════════════════════════════════════
// Edge Function : tiktok-finance-watch
// ════════════════════════════════════════════════════════════════════
// Surveille les versements TikTok Shop (API Finance, scope seller.finance.info
// ajouté le 26/09/2026) et prévient Borhen sur Telegram :
//   ✅ un versement passe à « Payé » (avec la date reconnue par la banque)
//   🆕 un nouveau versement est initié par TikTok
//   ⚠️ un versement reste « en traitement » plus de RETARD_JOURS jours
//      (rappel au plus toutes les 48 h tant que ce n'est pas payé)
//   ❌ un versement échoue ou est retourné
//
// État mémorisé dans `parametres` (clé tiktok_finance_etat, JSON) :
//   { versements: { [id]: { statut, montant, cree, paye } }, alertes: { [id]: iso } }
// Premier passage (aucun état) = point de départ : pas d'alerte « nouveau »/« payé »,
// seulement les retards déjà constatés.
//
// Body : { dryRun: true } -> calcule sans envoyer ni mémoriser ; { test: true } -> envoie un message test.
// Secrets attendus : TELEGRAM_TOKEN, TELEGRAM_CHAT_ID (+ TIKTOK_APP_KEY / TIKTOK_APP_SECRET).
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { refreshAccessToken, signedRequest } from '../_shared/tiktok.ts';

const RETARD_JOURS = Number(Deno.env.get('TIKTOK_FINANCE_RETARD_JOURS') || '3');
const RAPPEL_HEURES = 48;

const sb = createClient(Deno.env.get('SUPABASE_URL') || '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '', {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function getParams(): Promise<Record<string, string>> {
  const { data } = await sb.from('parametres').select('cle,valeur').like('cle', 'tiktok_%');
  const out: Record<string, string> = {};
  for (const r of (data || [])) out[(r as any).cle] = (r as any).valeur;
  return out;
}
async function setParam(cle: string, valeur: string) {
  await sb.from('parametres').upsert({ cle, valeur }, { onConflict: 'cle' });
}
async function ensureAccessToken(p: Record<string, string>): Promise<string> {
  const exp = Date.parse(p.tiktok_access_token_expire_at || '') || 0;
  if (p.tiktok_access_token && exp - Date.now() > 24 * 3600 * 1000) return p.tiktok_access_token;
  if (!p.tiktok_refresh_token) throw new Error('Aucun jeton TikTok : refaire l\'autorisation de la boutique');
  const t = await refreshAccessToken(p.tiktok_refresh_token);
  await setParam('tiktok_access_token', t.access_token);
  await setParam('tiktok_access_token_expire_at', new Date(t.access_token_expire_in * 1000).toISOString());
  if (t.refresh_token) await setParam('tiktok_refresh_token', t.refresh_token);
  return t.access_token;
}

const fmtDate = (sec: number) => new Date(sec * 1000).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
const fmtEur = (v: unknown) => Number(v || 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const jours = (sec: number) => Math.floor((Date.now() / 1000 - sec) / 86400);

async function telegram(texte: string) {
  const token = Deno.env.get('TELEGRAM_TOKEN') || '', chat = Deno.env.get('TELEGRAM_CHAT_ID') || '';
  if (!token || !chat) throw new Error('TELEGRAM_TOKEN / TELEGRAM_CHAT_ID manquants');
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: texte, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error('telegram: ' + JSON.stringify(j).slice(0, 200));
}

Deno.serve(async (req: Request) => {
  const start = Date.now();
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const dryRun = !!body?.dryRun;
  const rapport = { messages: [] as string[], versements: [] as any[], dryRun, premierPassage: false };
  try {
    if (body?.test) {
      await telegram('🧪 Test : la surveillance des versements TikTok Shop est en place.');
      return json({ ok: true, test: true });
    }
    const p = await getParams();
    if (!p.tiktok_shop_cipher) throw new Error('tiktok_shop_cipher manquant : refaire l\'autorisation TikTok');
    const token = await ensureAccessToken(p);
    const cipher = p.tiktok_shop_cipher;

    const depuis = String(Math.floor(Date.now() / 1000) - 120 * 86400);
    const j = await signedRequest('/finance/202309/payments', token, { shop_cipher: cipher, page_size: '50', sort_field: 'create_time', sort_order: 'DESC', create_time_ge: depuis });
    if (j.code !== 0) throw new Error('finance/payments: ' + JSON.stringify(j).slice(0, 250));
    const paiements: any[] = j.data?.payments || [];

    let etat: any = {};
    try { etat = JSON.parse(p.tiktok_finance_etat || '{}'); } catch { etat = {}; }
    const premier = !etat.versements;
    rapport.premierPassage = premier;
    const versements: Record<string, any> = etat.versements || {};
    const alertes: Record<string, string> = etat.alertes || {};
    const now = new Date().toISOString();

    for (const x of paiements) {
      const id = String(x.id), statut = String(x.status || ''), montant = x.amount?.value, banque = String(x.bank_account || '').slice(-4);
      const avant = versements[id];
      const ligne = { id, statut, montant, cree: fmtDate(x.create_time), paye: x.paid_time ? fmtDate(x.paid_time) : null, jours: jours(x.create_time) };
      rapport.versements.push(ligne);

      if (!premier) {
        if (!avant) {
          rapport.messages.push(`🆕 <b>Nouveau versement TikTok Shop initié</b> : ${fmtEur(montant)} le ${ligne.cree} (statut ${statut}). Arrivée prévue sous 1 à 3 jours ouvrés sur le compte …${banque}.`);
        } else if (avant.statut !== statut) {
          if (statut === 'PAID') rapport.messages.push(`✅ <b>Versement TikTok Shop payé</b> : ${fmtEur(montant)} (initié le ${ligne.cree}), reconnu par la banque le ${ligne.paye || '?'}, compte …${banque}.`);
          else if (statut === 'FAILED' || statut === 'RETURNED') rapport.messages.push(`❌ <b>Versement TikTok Shop ${statut === 'FAILED' ? 'échoué' : 'retourné'}</b> : ${fmtEur(montant)} (initié le ${ligne.cree}, ID ${id}). Vérifier Finance → Paiements et ouvrir un ticket.`);
          else rapport.messages.push(`ℹ️ Versement TikTok Shop ${fmtEur(montant)} : statut ${avant.statut} → ${statut}.`);
        }
      }
      if (statut === 'PROCESSING' && ligne.jours >= RETARD_JOURS) {
        const der = Date.parse(alertes[id] || '') || 0;
        if (Date.now() - der > RAPPEL_HEURES * 3600 * 1000) {
          rapport.messages.push(`⚠️ <b>Versement TikTok Shop en retard</b> : ${fmtEur(montant)} en « traitement en cours » depuis ${ligne.jours} jours (initié le ${ligne.cree}, ID ${id}). Délai normal : 1 à 3 jours ouvrés. Si rien sous 48 h → ticket Finance › Retard de règlement.`);
          if (!dryRun) alertes[id] = now;
        }
      }
      versements[id] = { statut, montant, cree: ligne.cree, paye: ligne.paye };
    }

    if (!dryRun) {
      for (const m of rapport.messages) await telegram(m);
      await setParam('tiktok_finance_etat', JSON.stringify({ versements, alertes, maj: now }));
    }
    return json({ ...rapport, envoyes: dryRun ? 0 : rapport.messages.length, duration_ms: Date.now() - start });
  } catch (e: any) {
    return json({ error: e.message, ...rapport, duration_ms: Date.now() - start }, 500);
  }
});

function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}
