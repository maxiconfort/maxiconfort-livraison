// ════════════════════════════════════════════════════════════════════
// Edge Function : send-cmd-sms
// ════════════════════════════════════════════════════════════════════
// Envoie un SMS automatique au client pour une commande, selon le type :
//   - "depart"     : SMS départ tournée (RANOU)
//   - "route"      : SMS livreur en route vers ce client (RANOU)
//   - "expedition" : SMS expédition + n° tracking (GLS)
//
// Dedupe via commandes.sms_envoyes (ne renvoie pas 2 fois le même type).
//
// Body attendu : { cmdId: string, type: "depart"|"route"|"expedition" }
//
// Secrets requis :
//   - BREVO_API_KEY (déjà configuré pour send-sms / sms-veille)
//   - SUPABASE_SERVICE_ROLE_KEY (auto)
//   - SUPABASE_URL (auto)
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const BREVO_KEY = Deno.env.get('BREVO_API_KEY') || '';
const SB_URL    = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const APP_BASE  = 'https://livraison.maxiconfort.fr';

const sb = createClient(SB_URL, SB_SR_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Templates SMS (cibler ≤ 160 = 1 segment = 4,5 credits = 0,045 €) ────
// Le sender "Maxiconfort" identifie l'expediteur, donc pas besoin de le
// repeter dans le corps -> on gagne des caracteres.
const TPL = {
  depart: (p: any) =>
    `Bonjour ${p.prenom}, votre livreur vient de partir. Suivi : ${p.lienSuivi}`,
  route: (p: any) =>
    `Bonjour ${p.prenom}, votre livreur arrive dans ~15 min. Soyez joignable. Suivi : ${p.lienSuivi}`,
  expedition: (p: any) =>
    `Bonjour ${p.prenom}, commande ${p.id} expediee par GLS. Tracking ${p.tracking}. Suivi : https://gls-group.eu/FR/fr/suivi-colis.html?match=${p.tracking}`,
};

function prenomDe(client: string): string {
  return (client || '').replace(/^(M\.|Mme|Mr\.?)\s*/i, '').split(' ')[0] || 'Bonjour';
}

function nettoyerTel(tel: string): string {
  if (!tel) return '';
  let t = tel.replace(/[\s.()\-]/g, '');
  if (t.startsWith('0033')) t = '+33' + t.slice(4);
  else if (t.startsWith('33') && t.length === 11) t = '+' + t;
  else if (t.startsWith('0') && t.length === 10) t = '+33' + t.slice(1);
  if (!t.startsWith('+')) return '';
  return t;
}

async function envoyerSMSBrevo(tel: string, contenu: string): Promise<boolean> {
  if (!BREVO_KEY) { console.warn('BREVO_API_KEY manquant'); return false; }
  const num = nettoyerTel(tel);
  if (!num) { console.warn('Téléphone invalide:', tel); return false; }
  try {
    const resp = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
      method: 'POST',
      headers: {
        'api-key': BREVO_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        // 'Maxiconfort' = 11 caracteres (limite max Brevo). Plus visible que 'Maxiconfor'.
        sender: 'Maxiconfort',
        recipient: num,
        content: contenu,
        type: 'transactional',
      }),
    });
    if (!resp.ok) {
      console.warn('Brevo HTTP', resp.status, await resp.text());
      return false;
    }
    return true;
  } catch (e: any) {
    console.warn('Brevo exception:', e.message);
    return false;
  }
}

async function logHistorique(c: any, type: string, contenu: string, statut: string) {
  try {
    await sb.from('sms_historique').insert({
      client: c.client || '',
      tel: c.tel || '',
      type_sms: type,
      contenu: contenu,
      statut: statut,
      date_sms: new Date().toISOString().split('T')[0],
      heure: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
    });
  } catch (e) { /* silent */ }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: any;
  try { body = await req.json(); } catch { body = {}; }

  const { cmdId, type } = body;
  if (!cmdId || !type) {
    return new Response(JSON.stringify({ error: 'cmdId et type requis' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  if (!['depart', 'route', 'expedition'].includes(type)) {
    return new Response(JSON.stringify({ error: 'type doit être : depart, route, expedition' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  // Lire la commande
  const { data: cmd, error: errCmd } = await sb
    .from('commandes')
    .select('*')
    .eq('id', cmdId)
    .maybeSingle();
  if (errCmd || !cmd) {
    return new Response(JSON.stringify({ error: 'commande introuvable', cmdId }),
      { status: 404, headers: { 'Content-Type': 'application/json' } });
  }

  // Vérifier non déjà envoyé (dedupe par type)
  const dejaEnvoyes: any[] = Array.isArray(cmd.sms_envoyes) ? cmd.sms_envoyes : [];
  if (dejaEnvoyes.some((e: any) => e.type === type)) {
    return new Response(JSON.stringify({ skipped: true, reason: 'deja envoye', type }),
      { headers: { 'Content-Type': 'application/json' } });
  }

  // Vérifier tel client présent
  if (!cmd.tel || cmd.tel.length < 8) {
    return new Response(JSON.stringify({ error: 'tel client invalide ou absent' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  // Construire le contenu
  const prenom = prenomDe(cmd.client);
  const lienSuivi = cmd.tracking_token
    ? `${APP_BASE}/track.html?t=${cmd.tracking_token}`
    : APP_BASE;
  const tracking = cmd.tracking_transporteur || '';
  const contenu = TPL[type as keyof typeof TPL]({
    prenom, lienSuivi, tracking, id: cmd.id,
  });

  // Envoi Brevo
  const ok = await envoyerSMSBrevo(cmd.tel, contenu);
  await logHistorique(cmd, type, contenu, ok ? 'envoyé' : 'échec');

  if (!ok) {
    return new Response(JSON.stringify({ error: 'envoi Brevo échoué', contenu }),
      { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  // Marquer comme envoyé
  const nouveauHistorique = [
    ...dejaEnvoyes,
    { type, at: new Date().toISOString() },
  ];
  await sb.from('commandes')
    .update({ sms_envoyes: nouveauHistorique })
    .eq('id', cmdId);

  return new Response(JSON.stringify({
    sent: true, type, cmdId, to: cmd.tel, contenu,
  }), { headers: { 'Content-Type': 'application/json' } });
});
