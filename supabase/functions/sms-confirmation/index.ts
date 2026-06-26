// ════════════════════════════════════════════════════════════════════
// Edge Function : sms-confirmation (v1 — 26/06/2026)
// ════════════════════════════════════════════════════════════════════
// Envoie AUTOMATIQUEMENT (côté serveur) le SMS de confirmation de prise
// de commande au client — SANS dépendre de l'app/navigateur (qui était
// fragile : cache, app fermée, etc.). Déclenché par pg_cron toutes les
// ~10 min : scanne les commandes créées récemment et délègue l'envoi à
// `send-cmd-sms` (type 'confirmation'), qui gère la dédup (sms_envoyes)
// et le tél invalide.
//
// Critères (miroir de la règle front v7.5.73) :
//   - créée dans les `fenetreMin` dernières minutes (défaut 30) → exclut
//     de fait les saisies RÉTROACTIVES (created_at = date passée)
//   - id NE commence PAS par #SAV
//   - PAS (GLS avec tracking déjà saisi) → le SMS expédition suffit alors
//   - tél valide + pas déjà confirmé → géré par send-cmd-sms
//
// Body : { dryRun?: boolean, fenetreMin?: number }
// Secrets : SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto)
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SB_URL    = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const sb = createClient(SB_URL, SB_SR_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let body: any; try { body = await req.json(); } catch { body = {}; }
  const dryRun = !!body.dryRun;
  const fenetreMin = Number(body.fenetreMin) > 0 ? Number(body.fenetreMin) : 30;

  const since = new Date(Date.now() - fenetreMin * 60 * 1000).toISOString();

  // Commandes créées récemment
  const { data: cmds, error } = await sb
    .from('commandes')
    .select('id, client, tel, transporteur, tracking_transporteur, sms_envoyes, created_at, date_livraison')
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  const resultats: any[] = [];
  for (const c of (cmds || [])) {
    const id = String(c.id || '');
    // SAV exclus
    if (id.indexOf('#SAV') === 0) { resultats.push({ id, skip: 'sav' }); continue; }
    // GLS avec tracking déjà saisi → l'expédition gère (évite doublon)
    if ((c.transporteur || 'RANOU') === 'GLS' && c.tracking_transporteur) {
      resultats.push({ id, skip: 'gls_tracking' }); continue;
    }
    // déjà confirmé ? (dédup locale rapide — send-cmd-sms revérifie aussi)
    const dejaConf = Array.isArray(c.sms_envoyes) && c.sms_envoyes.some((e: any) => e && e.type === 'confirmation');
    if (dejaConf) { resultats.push({ id, skip: 'deja_confirme' }); continue; }

    if (dryRun) { resultats.push({ id, client: c.client, would_send: true }); continue; }

    // Déléguer l'envoi à send-cmd-sms (gère tél invalide + dédup serveur)
    try {
      const r = await fetch(`${SB_URL}/functions/v1/send-cmd-sms`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SB_SR_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmdId: id, type: 'confirmation' }),
      });
      const d = await r.json().catch(() => ({}));
      resultats.push({ id, http: r.status, sent: !!d.sent, skipped: d.skipped || null, reason: d.reason || d.error || null });
    } catch (e: any) {
      resultats.push({ id, error: e?.message || String(e) });
    }
  }

  const envoyes = resultats.filter(r => r.sent).length;
  return new Response(JSON.stringify({
    ok: true, dryRun, fenetreMin, scannees: (cmds || []).length, envoyes, resultats,
  }), { headers: { 'Content-Type': 'application/json' } });
});
