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

async function alerteNonEncaisse(cmdId: string, dryRun: boolean, forcer = false) {
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
  if (/^#TEST/i.test(String(c.id)) && !forcer) return { ok: true, envoye: false, test: true, texte }; // lignes de test : pas de message (sauf demande explicite)
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

// Encaissement par carte refusé par la base (migration 028) : il manque une preuve.
async function alerteCbRefuse(cmdId: string, manque: string, dryRun: boolean, forcer = false) {
  const { data: c } = await sb.from('commandes').select('id, client, prix, stpaie, statut, livreur').eq('id', cmdId).maybeSingle();
  if (!c) return { ok: false, erreur: 'commande_introuvable' };
  const texte = '🚨 ENCAISSEMENT CB REFUSÉ PAR LA BASE\n' +
    `Commande ${c.id} — ${c.client || 'client'} — ${eur(Number(c.prix || 0))}\n` +
    `Il manque : ${manque || 'une preuve'}.\n` +
    `Le paiement n'a PAS été enregistré (statut : ${c.stpaie || 'Non payé'}). Livreur : ${c.livreur || 'non renseigné'}.\n` +
    'Cause probable : appareil resté sur une ancienne version de l\'application. À régulariser par « Modifier un encaissement » (motif + ticket).';
  if (dryRun) return { ok: true, envoye: false, dryRun: true, texte };
  if (/^#TEST/i.test(String(c.id)) && !forcer) return { ok: true, envoye: false, test: true, texte };
  return { ok: true, envoye: await envoyerTelegram(texte), texte };
}

// ── Répercussion dans Shopify d'un paiement encaissé à la livraison ─────────────────
// PRÉPARÉ, NON ACTIVÉ (03/10/2026). N'est relié à aucun déclencheur ni à aucun cron.
// S'exécute réellement seulement si : le paramètre `paiement_sync_shopify_actif` vaut
// « oui » dans la table parametres (absent aujourd'hui = inactif), OU la commande est une
// ligne technique de test (identifiant commençant par #TEST). dryRun est VRAI par défaut.
// Conditions : commande DELIVERY, « Payé », montant encaissé = total, preuve présente
// (ticket pour une carte ; livreur + date et heure dans tous les cas) ; commande Shopify
// encore « pending », moyen « paiement à la livraison », reste dû = montant encaissé.
async function shopifyGraphql(query: string, variables: any) {
  const r = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_VERSION}/graphql.json`, {
    method: 'POST', headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }),
  });
  return await r.json();
}
async function shopifyMarquerPayee(cmdId: string, dryRun: boolean) {
  const { data: c } = await sb.from('commandes')
    .select('id, ref_marketplace, prix, montant_enc, paie, stpaie, statut, payment_source, ticket_cb, encaisse_par, encaisse_at, encaisse_tournee').eq('id', cmdId).maybeSingle();
  if (!c) return { ok: false, erreur: 'commande_introuvable' };
  const estTest = /^#TEST/i.test(String(c.id));
  const { data: p } = await sb.from('parametres').select('valeur').eq('cle', 'paiement_sync_shopify_actif').maybeSingle();
  const actif = String(p?.valeur || '').toLowerCase() === 'oui';
  const refus: string[] = [];
  if (c.payment_source !== 'DELIVERY') refus.push('la commande n\'est pas un paiement à la livraison');
  if (c.stpaie !== 'Payé') refus.push('la commande n\'est pas « Payé » dans l\'application');
  if (Math.abs(Number(c.montant_enc || 0) - Number(c.prix || 0)) > 0.01) refus.push('le montant encaissé n\'est pas égal au total');
  if (!c.encaisse_par || !c.encaisse_at) refus.push('preuve incomplète : livreur ou date et heure manquants');
  if (c.paie === 'CB' && !String(c.ticket_cb || '').trim()) refus.push('preuve incomplète : ticket CB manquant');
  if (!/^[0-9]{6,}$/.test(String(c.ref_marketplace || ''))) refus.push('identifiant Shopify absent');
  if (refus.length) return { ok: false, erreur: 'conditions_non_remplies', refus };
  const ro = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_VERSION}/orders/${c.ref_marketplace}.json?fields=id,name,financial_status,cancelled_at,total_outstanding,current_total_price,payment_gateway_names`, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } });
  if (!ro.ok) return { ok: false, erreur: 'shopify_http_' + ro.status };
  const o = (await ro.json()).order;
  const avant = { commande: o.name, statut: o.financial_status, reste_du: o.total_outstanding, moyen: o.payment_gateway_names };
  if (o.cancelled_at) refus.push('commande Shopify annulée');
  if (o.financial_status !== 'pending') refus.push(`commande Shopify déjà « ${o.financial_status} »`);
  if (!(o.payment_gateway_names || []).some((g: string) => /livraison/i.test(g))) refus.push('le moyen de paiement Shopify n\'est pas « paiement à la livraison »');
  if (Math.abs(Number(o.total_outstanding || 0) - Number(c.montant_enc || 0)) > 0.01) refus.push('le reste dû Shopify n\'est pas égal au montant encaissé');
  if (refus.length) return { ok: false, erreur: 'conditions_shopify_non_remplies', refus, avant };
  const preuve = { mode: c.paie, montant: Number(c.montant_enc), ticket_cb: c.ticket_cb || null, livreur: c.encaisse_par, date_heure: c.encaisse_at, tournee: c.encaisse_tournee || null };
  if (dryRun) return { ok: true, dryRun: true, ferait: 'marquer la commande Shopify payée', avant, preuve, mecanisme_actif: actif };
  if (!actif && !estTest) return { ok: false, erreur: 'mecanisme_non_active', avant, preuve };
  const g = await shopifyGraphql(
    'mutation($input: OrderMarkAsPaidInput!) { orderMarkAsPaid(input: $input) { order { id name displayFinancialStatus totalOutstandingSet { shopMoney { amount } } } userErrors { field message } } }',
    { input: { id: `gid://shopify/Order/${c.ref_marketplace}` } });
  const res = g?.data?.orderMarkAsPaid;
  if (!res || (res.userErrors || []).length || g.errors) return { ok: false, erreur: 'shopify_refus', detail: res?.userErrors || g.errors, avant };
  return { ok: true, avant, apres: { statut: res.order.displayFinancialStatus, reste_du: res.order.totalOutstandingSet?.shopMoney?.amount }, preuve, test: estTest };
}

Deno.serve(async (req: Request) => {
  if (!appelInterne(req)) return refus();
  let body: any = {};
  try { body = await req.json(); } catch { /* corps vide */ }
  try {
    if (body.action === 'alerte_cb_refuse' && body.cmdId) return json(await alerteCbRefuse(String(body.cmdId), String(body.manque || ''), !!body.dryRun, !!body.forcerTest));
    if (body.action === 'shopify_marquer_payee' && body.cmdId) return json(await shopifyMarquerPayee(String(body.cmdId), body.dryRun !== false));
    if (body.action === 'alerte_non_encaisse' && body.cmdId) return json(await alerteNonEncaisse(String(body.cmdId), !!body.dryRun, !!body.forcerTest));
    if (body.action === 'transactions') return json(await releverTransactions(Math.min(Number(body.jours) || 30, 60), Math.min(Number(body.max) || 40, 100), !!body.dryRun));
    return json({ ok: false, erreur: 'action_inconnue' }, 400);
  } catch (e: any) {
    return json({ ok: false, erreur: e.message }, 500);
  }
});
