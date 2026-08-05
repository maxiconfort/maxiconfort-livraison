// ════════════════════════════════════════════════════════════════════
// Edge Function : garde-tournee-min (v1 — 20/07/2026)
// ════════════════════════════════════════════════════════════════════
// GARDE-FOU RENTABILITÉ (règle Borhen) : si la tournée RANOU de DEMAIN
// compte moins de `seuilMin` commandes (défaut 10), on la DÉCALE AU
// LENDEMAIN : chaque commande est reportée (+1 jour), ses drapeaux SMS
// de tournée (veille/depart/route/proche) sont réinitialisés, et le
// client reçoit un SMS d'excuse annonçant la nouvelle date. Borhen
// reçoit un SMS récap.
//
// Déclenché par pg_cron chaque soir à 18h Paris (AVANT le SMS veille de
// 19h — les clients reportés ne reçoivent donc PAS la veille à tort).
// Si le lendemain n'atteint toujours pas le seuil, le prochain passage
// du cron re-décale (accumulation jusqu'à rentabilité).
//
// Exclusions : GLS (expédiés), #SAV (gérés à la main), annulé/livré.
//
// Body : { dryRun?, seuilMin? (déf 10), dateCible? (déf demain Paris),
//          nouvelleDate? (déf dateCible+1), force? (ignore le seuil) }
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { envoyerSMSOVH, telIntl } from '../_shared/ovh-sms.ts';

const SB_URL    = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const TEL_BORHEN = '+33744289321';
const JOURS = ['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'];

const sb = createClient(SB_URL, SB_SR_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

function dateParis(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function plusJours(ymd: string, n: number): string {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}
function jjmm(ymd: string): string { const p = ymd.split('-'); return p[2] + '/' + p[1]; }
function jourNom(ymd: string): string { return JOURS[new Date(ymd + 'T12:00:00Z').getUTCDay()]; }
function prenomDe(client: string): string {
  return (client || '').replace(/^(M\.|Mme|Mr\.?|Monsieur|Madame|Mlle)\s*/i, '').split(' ')[0] || 'client';
}

async function logHistorique(client: string, tel: string, type: string, msg: string, statut: string) {
  try {
    await sb.from('sms_historique').insert({
      id: 'sms_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      client, tel, type_sms: type, msg, statut,
      date_sms: dateParis(0),
      heure: new Date().toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }),
    });
  } catch (_e) { /* silent */ }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let body: any; try { body = await req.json(); } catch { body = {}; }
  const dryRun = !!body.dryRun;
  const force = !!body.force;
  // v1.2 (28/07) : seuil 10 -> 8 ; v1.3 (05/08) : 8 -> 7 (demandes Borhen)
  const seuilMin = (typeof body.seuilMin === 'number' && body.seuilMin > 0) ? body.seuilMin : 7;
  const dateCible = (typeof body.dateCible === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.dateCible)) ? body.dateCible : dateParis(1);
  const nouvelleDate = (typeof body.nouvelleDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.nouvelleDate)) ? body.nouvelleDate : plusJours(dateCible, 1);

  // v1.1 : EXCEPTIONS — dates verrouillées par Borhen (la tournée part même < seuil).
  // Table parametres, cle 'gardefou_skip_dates', valeur = JSON array ["2026-07-22", ...].
  if (!force) {
    try {
      const { data: prm } = await sb.from('parametres').select('valeur').eq('cle', 'gardefou_skip_dates').maybeSingle();
      if (prm && prm.valeur) {
        const skips = JSON.parse(prm.valeur);
        if (Array.isArray(skips) && skips.indexOf(dateCible) !== -1) {
          return new Response(JSON.stringify({ ok: true, action: 'rien', raison: 'date verrouillee par Borhen (exception)', dateCible }),
            { headers: { 'Content-Type': 'application/json' } });
        }
      }
    } catch (_e) { /* pas d'exception configurée */ }
  }

  // Commandes RANOU en attente pour la date cible (hors SAV)
  const { data: cmds, error } = await sb.from('commandes')
    .select('id, client, tel, date_livraison, sms_envoyes')
    .eq('date_livraison', dateCible)
    .eq('transporteur', 'RANOU')
    .eq('statut', 'en-attente');
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });

  const eligibles = (cmds || []).filter((c: any) => String(c.id).indexOf('#SAV') !== 0);
  const nb = eligibles.length;

  if (nb === 0) {
    return new Response(JSON.stringify({ ok: true, action: 'rien', raison: 'aucune commande', dateCible }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (nb >= seuilMin && !force) {
    return new Response(JSON.stringify({ ok: true, action: 'rien', raison: `seuil atteint (${nb} >= ${seuilMin})`, dateCible, nb }), { headers: { 'Content-Type': 'application/json' } });
  }

  const nomJour = jourNom(nouvelleDate);
  const resultats: any[] = [];
  for (const c of eligibles) {
    const msg = `Bonjour ${prenomDe(c.client)}, votre livraison Maxiconfort prevue le ${jjmm(dateCible)} est reportee a ${nomJour} ${jjmm(nouvelleDate)}. Toutes nos excuses pour ce contretemps.`;
    if (dryRun) { resultats.push({ id: c.id, client: c.client, would_move: nouvelleDate, sms: msg }); continue; }
    // 1) Reporter la commande + réinitialiser les drapeaux SMS de tournée
    const flags = (Array.isArray(c.sms_envoyes) ? c.sms_envoyes : []).filter((e: any) =>
      e && ['veille', 'depart', 'route', 'proche'].indexOf(e.type) === -1);
    const { error: eUp } = await sb.from('commandes')
      .update({ date_livraison: nouvelleDate, sms_envoyes: flags })
      .eq('id', c.id);
    if (eUp) { resultats.push({ id: c.id, error: eUp.message }); continue; }
    // 2) SMS d'excuse au client (si tél valide)
    let smsOk = false;
    if (telIntl(c.tel || '')) {
      smsOk = await envoyerSMSOVH(c.tel, msg);
      await logHistorique(c.client, c.tel, 'report', msg, smsOk ? 'envoyé' : 'échec');
    }
    resultats.push({ id: c.id, client: c.client, moved: nouvelleDate, sms: smsOk });
  }

  // SMS récap à Borhen
  if (!dryRun) {
    const recap = `Maxiconfort GARDE-FOU: tournee du ${jjmm(dateCible)} = ${nb} cmd (< ${seuilMin}) -> reportee a ${nomJour} ${jjmm(nouvelleDate)}. ${resultats.filter(r => r.sms).length}/${nb} clients prevenus par SMS.`;
    await envoyerSMSOVH(TEL_BORHEN, recap);
    await logHistorique('BORHEN (garde-fou)', TEL_BORHEN, 'report-gardefou', recap, 'envoyé');
  }

  return new Response(JSON.stringify({ ok: true, action: dryRun ? 'dryRun' : 'reporte', dateCible, nouvelleDate, nb, seuilMin, resultats }),
    { headers: { 'Content-Type': 'application/json' } });
});
