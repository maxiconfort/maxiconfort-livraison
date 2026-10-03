// ════════════════════════════════════════════════════════════════════
// paiement-suivi (03/10/2026) — suite du correctif paiement
// ════════════════════════════════════════════════════════════════════
// Deux actions, appelées par la base (déclencheur / cron) ou par un script serveur :
//
//  { action: 'alerte_non_encaisse', cmdId, dryRun? }
//     Une commande « paiement à la livraison » (payment_source = DELIVERY) vient d'être
//     livrée SANS encaissement : alerte Telegram au gérant. Rien n'est modifié.
//
//  { action: 'transactions', jours?: 30, max?: 40, dryRun? }
//     Pour les commandes du site payées en ligne dont les identifiants de transaction
//     Shopify ne sont pas encore enregistrés, lit Shopify (lecture seule) et remplit la
//     colonne payment_transactions. N'écrit JAMAIS paie / stpaie / montant_enc.
//     Si Shopify ne montre aucune transaction réussie pour une commande classée « payée en
//     ligne », la commande est listée dans `anomalies` (et signalée sur Telegram une fois).
//
// Appelant : interne uniquement (x-cron-secret ou clé secrète du projet).
// Aucune valeur de secret dans ce fichier (dépôt public).
// ════════════════════════════════════════════════════════════════════
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { appelInterne, refus } from '../_shared/controle-appelant.ts';

const SB_URL = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const SHOPIFY_DOMAIN = Deno.env.get('SHOPIFY_STORE_DOMAIN') || '';
const SHOPIFY_TOKEN = Deno.env.get('SHOPIFY_ACCESS_TOKEN') || '';
const SHOPIFY_VERSION = Deno.env.get('SHOPIFY_API_VERSION') || '2026-04';
const sb = createClient(SB_URL, SB_SR_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const eur = (n: number) => (Math.round(n * 100) / 100).toLocaleString('fr-FR') + ' €';

async function envoyerTelegram(texte: string): Promise<boolean> {
  const token = Deno.env.get('TELEGRAM_TOKEN') || '', chat = Deno.env.get('TELEGRAM_CHAT_ID') || '';
  if (!token || !chat) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: texte.slice(0, 4000), disable_web_page_preview: true }),
    });
    return r.ok;
  } catch { return false; }
}

async function alerteNonEncaisse(cmdId: string, dryRun: boolean) {
  const { data: c, error } = await sb.from('commandes')
    .select('id, client, prix, montant_enc, stpaie, statut, livreur, date_livraison, payment_source').eq('id', cmdId).maybeSingle();
  if (error || !c) return { ok: false, erreur: 'commande_introuvable' };
  if (c.payment_source !== 'DELIVERY' || c.statut !== 'livré' || c.stpaie === 'Payé') {
    return { ok: true, envoye: false, raison: 'la commande n\'est pas (ou plus) livrée non encaissée' };
  }
  const du = Math.max(0, Number(c.prix || 0) - Number(c.montant_enc || 0));
  const jour = c.date_livraison ? String(c.date_livraison).split('-').reverse().join('/') : new Date().toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
  const texte = '🚨 NON ENCAISSÉ — paiement à la livraison\n' +
    `Commande ${c.id} — ${c.client || 'client'}\n` +
    `Livrée par ${c.livreur || 'livreur non renseigné'} le ${jour}\n` +
    `RESTE DÛ : ${eur(du)}\n` +
    'La commande reste « Non payé » dans l\'application. À régulariser avec le client.';
  if (dryRun) return { ok: true, envoye: false, dryRun: true, texte };
  const envoye = await envoyerTelegram(texte);
  return { ok: true, envoye, texte };
}

async function releverTransactions(jours: number, max: number, dryRun: boolean) {
  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) return { ok: false, erreur: 'configuration_shopify_absente' };
  const depuis = new Date(Date.now() - jours * 86400000).toISOString();
  const { data, error } = await sb.from('commandes')
    .select('id, ref_marketplace, prix, created_at').eq('payment_source', 'SHOPIFY_ONLINE').is('payment_transactions', null)
    .gte('created_at', depuis).order('created_at', { ascending: false }).limit(max);
  if (error) return { ok: false, erreur: error.message };
  const res: any = { ok: true, dryRun, examinees: (data || []).length, renseignees: [] as string[], anomalies: [] as string[], erreurs: [] as string[] };
  for (const c of data || []) {
    if (!/^[0-9]{6,}$/.test(String(c.ref_marketplace || ''))) continue;
    if (/^#TEST/i.test(String(c.id))) continue; // lignes techniques de test : jamais d'appel Shopify ni d'alerte
    try {
      await new Promise((ok) => setTimeout(ok, 550)); // Shopify : 2 appels par seconde au plus
      const appel = () => fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_VERSION}/orders/${c.ref_marketplace}/transactions.json`, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } });
      let r = await appel();
      if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 2200)); r = await appel(); }
      if (r.status === 404) { res.erreurs.push(`${c.id} : commande Shopify introuvable`); continue; }
      if (!r.ok) { res.erreurs.push(`${c.id} : Shopify HTTP ${r.status}`); continue; }
      const tr = ((await r.json()).transactions || []).filter((t: any) => ['sale', 'capture'].includes(t.kind) && t.status === 'success');
      if (!tr.length) {
        // signalée UNE fois : le marqueur évite de la réexaminer (et de ré-alerter) à chaque passage
        res.anomalies.push(`${c.id} : classée payée en ligne, aucune transaction réussie dans Shopify`);
        if (!dryRun) await sb.from('commandes').update({ payment_transactions: 'A_VERIFIER' }).eq('id', c.id).is('payment_transactions', null);
        continue;
      }
      const ids = tr.map((t: any) => String(t.id)).join(',');
      if (!dryRun) {
        const { error: e2 } = await sb.from('commandes').update({ payment_transactions: ids }).eq('id', c.id).is('payment_transactions', null);
        if (e2) { res.erreurs.push(`${c.id} : ${e2.message}`); continue; }
      }
      res.renseignees.push(`${c.id} : ${ids}`);
    } catch (e: any) { res.erreurs.push(`${c.id} : ${e.message}`); }
  }
  if (!dryRun && res.anomalies.length) {
    res.telegram = await envoyerTelegram('⚠️ Paiement à vérifier\n' + res.anomalies.slice(0, 15).join('\n') + '\nAucune donnée n\'a été modifiée.');
  }
  return res;
}

Deno.serve(async (req: Request) => {
  if (!appelInterne(req)) return refus();
  let body: any = {};
  try { body = await req.json(); } catch { /* corps vide */ }
  try {
    if (body.action === 'alerte_non_encaisse' && body.cmdId) return json(await alerteNonEncaisse(String(body.cmdId), !!body.dryRun));
    if (body.action === 'transactions') return json(await releverTransactions(Math.min(Number(body.jours) || 30, 60), Math.min(Number(body.max) || 40, 100), !!body.dryRun));
    return json({ ok: false, erreur: 'action_inconnue' }, 400);
  } catch (e: any) {
    return json({ ok: false, erreur: e.message }, 500);
  }
});
