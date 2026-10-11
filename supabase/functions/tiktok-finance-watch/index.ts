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
//   (12/10) ⚠️ une commande livrée dont la date de règlement estimée (livraison + 31 j) est dépassée de 2 j
//   (12/10) 🚚 une commande payée non remise à GLS à moins de 36 h de la limite TikTok, ❌ si dépassée
//   Cron : 07:30 UTC (jobid 22) + 15:30 UTC (migration 032) pour les limites de remise.
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
import { getParamsTiktok, setParamTiktok } from '../_shared/tiktok-params.ts';
import { appelInterne, appelApp, refus, EN_TETES_AUTORISES } from '../_shared/controle-appelant.ts';

const RETARD_JOURS = Number(Deno.env.get('TIKTOK_FINANCE_RETARD_JOURS') || '3');
const RAPPEL_HEURES = 48;

const sb = createClient(Deno.env.get('SUPABASE_URL') || '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '', {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function getParams(): Promise<Record<string, string>> {
  return await getParamsTiktok(sb); // 27/09 : jetons dans secrets_serveur
}
async function setParam(cle: string, valeur: string) {
  await setParamTiktok(sb, cle, valeur); // jetons -> secrets_serveur, reste -> parametres
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
  // 27/09/2026 : controle d'appelant (crons = x-cron-secret ; fonctions/scripts serveur = cle secrete sb_secret_)
  if (req.method !== 'OPTIONS' && !appelInterne(req)) return refus();
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

    // 12/10/2026 — (2) versements attendus par commande : TikTok annonce une date estimée (livraison + 31 j).
    // Si la date est dépassée de plus de 2 jours et que la commande n'est toujours pas réglée → alerte (rappel 48 h).
    try {
      const un = await signedRequest('/finance/202507/orders/unsettled', token, { shop_cipher: cipher, page_size: '50', sort_field: 'order_create_time', sort_order: 'DESC' });
      if (un.code === 0) {
        (rapport as any).en_attente = { commandes: un.data?.total_count, net: un.data?.sum_est_settlement_amount };
        for (const t of un.data?.transactions || []) {
          const est = /^\d+$/.test(String(t.estimated_settlement)) ? Number(t.estimated_settlement) : 0;
          if (!est) continue;
          const retardJ = Math.floor((Date.now() / 1000 - est) / 86400);
          if (retardJ >= 2) {
            const k = 'cmd:' + t.order_id, der = Date.parse(alertes[k] || '') || 0;
            if (Date.now() - der > RAPPEL_HEURES * 3600 * 1000) {
              rapport.messages.push(`⚠️ <b>Versement TikTok attendu non reçu</b> : commande ${t.order_id}, ${fmtEur(t.est_settlement_amount)} nets, règlement estimé le ${fmtDate(est)} (${retardJ} j de retard), toujours « non réglée ». Vérifier Finance → En attente, puis ticket Finance › Retard de règlement si rien sous 48 h.`);
              if (!dryRun) alertes[k] = now;
            }
          }
        }
      } else (rapport as any).en_attente = { erreur: String(un.message || '').slice(0, 120) };
    } catch (e: any) { (rapport as any).en_attente = { erreur: String(e.message || e).slice(0, 120) }; }

    // (3) commandes payées pas encore remises à GLS : limite de remise au transporteur (rts_sla_time) et de collecte.
    // Alerte à moins de 36 h de la limite, puis chaque jour tant que le colis n'est pas collecté (leçon #1721 : annulation TikTok = client remboursé).
    try {
      const o = await signedRequest('/order/202309/orders/search', token, { shop_cipher: cipher, page_size: '50', sort_field: 'create_time', sort_order: 'DESC' }, 'POST', { create_time_ge: Math.floor(Date.now() / 1000) - 30 * 86400 });
      if (o.code === 0) {
        const ouvertes = (o.data?.orders || []).filter((x: any) => x.paid_time && ['AWAITING_SHIPMENT', 'AWAITING_COLLECTION', 'ON_HOLD'].includes(String(x.status)) && !x.collection_time);
        (rapport as any).a_remettre = ouvertes.map((x: any) => ({ id: x.id, statut: x.status, limite_remise: x.rts_sla_time ? fmtDate(x.rts_sla_time) : null, limite_collecte: x.collection_due_time ? fmtDate(x.collection_due_time) : null }));
        for (const x of ouvertes) {
          const lim = Number(x.rts_sla_time || x.collection_due_time || 0); if (!lim) continue;
          const resteH = Math.round((lim - Date.now() / 1000) / 3600);
          if (resteH > 36) continue;
          const k = 'remise:' + x.id, der = Date.parse(alertes[k] || '') || 0;
          if (Date.now() - der > 20 * 3600 * 1000) {
            const prod = (x.line_items || []).map((l: any) => l.seller_sku || l.product_name).join(' + ');
            rapport.messages.push(resteH > 0
              ? `🚚 <b>Colis TikTok à remettre à GLS</b> : commande ${x.id} (${prod}, ${fmtEur(x.payment?.total_amount)}) — limite de remise ${fmtDate(lim)} 23:59, reste ${resteH} h, aucun scan GLS. Au-delà : annulation TikTok et client remboursé.`
              : `❌ <b>Limite de remise GLS DÉPASSÉE</b> : commande TikTok ${x.id} (${prod}) devait être remise le ${fmtDate(lim)}, toujours pas collectée. Remettre le colis aujourd'hui et surveiller l'annulation automatique (limite de collecte ${x.collection_due_time ? fmtDate(x.collection_due_time) : '?'}).`);
            if (!dryRun) alertes[k] = now;
          }
        }
      }
    } catch (e: any) { (rapport as any).a_remettre = { erreur: String(e.message || e).slice(0, 120) }; }

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
