// ════════════════════════════════════════════════════════════════════
// Edge Function : send-sms (v2 — 16/06/2026 — MIGRÉ Brevo → OVH)
// ════════════════════════════════════════════════════════════════════
// Point d'entrée des SMS envoyés depuis le front (maxiconfort-v7.html,
// fonction brevoSendSMS) : confirmation de livraison à la signature,
// test SMS, rappel entretien véhicule, envoi groupé tournée, veille legacy.
//
// Contrat (inchangé pour rester compatible avec le front) :
//   POST { tel: "+33...", message: "...", type?: "...", client?: "..." }
//   → { success: boolean }
//
// Envoi via OVH (expéditeur MAXICONFORT). Transactionnel = sans clause STOP.
// Secrets OVH : voir _shared/ovh-sms.ts
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { envoyerSMSOVHDetail } from '../_shared/ovh-sms.ts';
import { statutSms, reponseSendSms } from '../_shared/ovh-resultat.ts';
import { appelInterne, appelApp, refus, EN_TETES_AUTORISES } from '../_shared/controle-appelant.ts';

const SB_URL    = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const sb = createClient(SB_URL, SB_SR_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': EN_TETES_AUTORISES,
  'Access-Control-Max-Age': '86400',
};
const JSON_HEADERS = { 'Content-Type': 'application/json', ...CORS_HEADERS };

/** Renvoie TRUE si l'historique a été écrit, FALSE sinon (revue Codex #20 : l'échec est SIGNALÉ à l'appelant via `journal_echoue`, jamais ignoré ; le SMS part quand même, comme avant). */
async function logHistorique(tel: string, type: string, message: string, statut: string, client: string): Promise<boolean> {
  try {
    const { error } = await sb.from('sms_historique').insert({
      id: 'sms_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      client: client || '',
      tel: tel || '',
      type_sms: type || 'manuel',
      msg: message,
      statut,
      date_sms: new Date().toISOString().split('T')[0],
      heure: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }),
    });
    if (error) { console.warn('send-sms: historique NON écrit (' + (error.message || error.code || '?') + ')'); return false; }
    return true;
  } catch (_e) { console.warn('send-sms: historique NON écrit (exception)'); return false; }
}

Deno.serve(async (req: Request) => {
  // 27/09/2026 : controle d'appelant (crons/fonctions = x-cron-secret ou cle secrete ; app = x-app-secret + session PIN valide)
  if (req.method !== 'OPTIONS' && !appelInterne(req) && !(await appelApp(req, ['admin', 'collab', 'livreur']))) return refus();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ success: false, error: 'POST uniquement' }), { status: 405, headers: JSON_HEADERS });
  }

  let body: any = {};
  try { body = await req.json(); } catch {}
  const { tel, message, type, client } = body;
  if (!tel || !message) {
    return new Response(JSON.stringify({ success: false, error: 'tel et message requis' }), { status: 400, headers: JSON_HEADERS });
  }

  // revue Codex #20 : le résultat INDÉTERMINÉ d'OVH (exception réseau, réponse 5xx) est transmis tel quel (`indetermine: true`) : le SMS est peut-être parti
  const res = await envoyerSMSOVHDetail(tel, message);
  const journalOk = await logHistorique(tel, type || 'manuel', message, statutSms(res), client || '');
  const rep = reponseSendSms(res, !journalOk);   // revue Codex #20 : libellé partagé, « indéterminé » jamais confondu avec « échec »

  return new Response(JSON.stringify(rep.corps), { status: rep.status, headers: JSON_HEADERS });
});
