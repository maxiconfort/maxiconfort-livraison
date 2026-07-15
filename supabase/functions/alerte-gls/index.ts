// ════════════════════════════════════════════════════════════════════
// Edge Function : alerte-gls (v1 — 15/07/2026)
// ════════════════════════════════════════════════════════════════════
// GARDIEN : alerte Borhen par SMS si des commandes GLS payees attendent
// leur etiquette depuis plus de 48h (trou detecte le 08/07/2026 : ~11
// commandes non expediees, dont une cliente qui a reclame par e-mail —
// cause : expeditions faites en direct sur YourGLS sans passer par l'app,
// ou commandes oubliees).
//
// Scan : commandes transporteur='GLS', statut='en-attente',
//        tracking_transporteur vide, date_commande <= J-2.
// Si au moins 1 : SMS a Borhen avec la liste des numeros.
// Dedupe : 1 alerte par jour via sms_historique (type 'alerte-gls'),
//          sauf force:true. Re-alerte chaque jour tant que non traite
//          (rappel voulu).
//
// Body (optionnel) :
//   { dryRun?: true }   → liste sans envoyer
//   { force?: true }    → ignore la dedupe du jour
//   { seuilJours?: 2 }  → anciennete minimum (defaut 2 jours)
//
// Secrets requis : OVH_* (voir _shared/ovh-sms.ts) + SUPABASE_* (auto)
// Cron : alerte-gls-daily (pg_cron) — 06:30 UTC = 8h30 Paris ete.
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { envoyerSMSOVH } from '../_shared/ovh-sms.ts';

const SB_URL    = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const BORHEN_TEL = Deno.env.get('RAPPORT_TEL') || '+33744289321';

const sb = createClient(SB_URL, SB_SR_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function dateParisMoinsJours(j: number): string {
  const now = new Date();
  const paris = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  paris.setDate(paris.getDate() - j);
  return paris.toISOString().split('T')[0];
}

function todayParis(): string {
  return new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
}

Deno.serve(async (req: Request) => {
  let body: any = {};
  try { body = await req.json(); } catch { /* GET ou body vide */ }
  const dryRun = !!body.dryRun;
  const force = !!body.force;
  const seuilJours = Math.max(1, Number(body.seuilJours) || 2);

  // 1. Dedupe : deja alerte aujourd'hui ?
  if (!force && !dryRun) {
    const { data: deja } = await sb.from('sms_historique')
      .select('id').eq('type_sms', 'alerte-gls')
      .eq('date_sms', todayParis()).limit(1);
    if (deja && deja.length) {
      return new Response(JSON.stringify({ skipped: true, reason: 'deja alerte aujourd\'hui' }),
        { headers: { 'Content-Type': 'application/json' } });
    }
  }

  // 2. Scan des commandes GLS en attente sans etiquette depuis +48h
  const limite = dateParisMoinsJours(seuilJours);
  const { data: cmds, error } = await sb.from('commandes')
    .select('id, client, date_commande, tracking_transporteur')
    .eq('transporteur', 'GLS')
    .eq('statut', 'en-attente')
    .lte('date_commande', limite)
    .order('date_commande', { ascending: true });
  if (error) {
    return new Response(JSON.stringify({ error: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
  const retard = (cmds || []).filter((c: any) =>
    !c.tracking_transporteur || !String(c.tracking_transporteur).trim());

  if (retard.length === 0) {
    return new Response(JSON.stringify({ ok: true, retard: 0, message: 'rien a signaler' }),
      { headers: { 'Content-Type': 'application/json' } });
  }

  // 3. Construire le SMS (viser 1-2 segments, sans accents — helper OVH gere)
  const liste = retard.slice(0, 6).map((c: any) =>
    `${c.id}(${(c.date_commande || '').substring(5)})`).join(' ');
  const plus = retard.length > 6 ? ` +${retard.length - 6} autres` : '';
  const msg = `ALERTE GLS: ${retard.length} commande(s) payee(s) SANS etiquette depuis +${seuilJours}j: ${liste}${plus}. Creer les etiquettes dans l'app.`;

  if (dryRun) {
    return new Response(JSON.stringify({ dryRun: true, retard: retard.length, cmds: retard, sms: msg }),
      { headers: { 'Content-Type': 'application/json' } });
  }

  // 4. Envoi + log
  const ok = await envoyerSMSOVH(BORHEN_TEL, msg);
  try {
    await sb.from('sms_historique').insert({
      id: 'sms_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      client: 'Borhen (gardien)',
      tel: BORHEN_TEL,
      type_sms: 'alerte-gls',
      msg: msg,
      statut: ok ? 'envoyé' : 'échec',
      date_sms: todayParis(),
      heure: new Date().toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }),
    });
  } catch (_e) { /* log non bloquant */ }

  return new Response(JSON.stringify({ ok, retard: retard.length, sms: msg }),
    { headers: { 'Content-Type': 'application/json' } });
});
