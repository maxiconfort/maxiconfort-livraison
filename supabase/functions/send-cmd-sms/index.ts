// ════════════════════════════════════════════════════════════════════
// Edge Function : send-cmd-sms (v3 — 10/06/2026)
// ════════════════════════════════════════════════════════════════════
// Envoie un SMS automatique au client pour une commande, selon le type :
//   - "veille"     : SMS la veille — confirme livraison demain (NOUVEAU v3)
//   - "depart"     : SMS départ tournée (RANOU) — accepte heureArrivee optionnelle
//   - "route"      : SMS livreur en route vers ce client (RANOU)
//   - "proche"     : SMS livreur à <1km
//   - "expedition" : SMS expédition + n° tracking (GLS)
//
// Dedupe via commandes.sms_envoyes (ne renvoie pas 2 fois le même type).
//
// Body attendu :
//   { cmdId: string,
//     type: "depart"|"route"|"proche"|"expedition",
//     heureArrivee?: string (HH:MM, optionnel pour depart) }
//
// Secrets requis :
//   - Secrets OVH (OVH_APP_KEY/SECRET, OVH_CONSUMER_KEY, OVH_SMS_SERVICE,
//     OVH_SMS_SENDER) — voir _shared/ovh-sms.ts
//   - SUPABASE_SERVICE_ROLE_KEY (auto)
//   - SUPABASE_URL (auto)
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { envoyerSMSOVH } from '../_shared/ovh-sms.ts';

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
  // v7.5.68 : raccourci sous 160 caracteres = 1 seul SMS = 1 credit OVH (avant : ~2
  // segments = 2 credits par SMS veille). Le lien confirmer.html?t=<uuid> fait deja
  // ~86 car -> le corps doit rester court. Le sender "MAXICONFORT" identifie deja
  // l'expediteur ; le nom du produit et la phrase "appel 1h avant" sont retires
  // (l'info "1h avant" est rappelee par le SMS depart du jour J). dateFr = JJ/MM.
  veille: (p: any) =>
    `Bonjour ${p.prenom}, livraison prevue demain ${p.dateFr}. Serez-vous la ? ${p.lienConfirm}`,
  depart: (p: any) =>
    p.heureArrivee
      ? `Bonjour ${p.prenom}, livreur en route ! Arrivee prevue vers ${p.heureArrivee}. Suivi : ${p.lienSuivi}`
      : `Bonjour ${p.prenom}, votre livreur vient de partir. Suivi : ${p.lienSuivi}`,
  route: (p: any) =>
    `Bonjour ${p.prenom}, votre livreur arrive dans ~15 min. Soyez joignable. Suivi : ${p.lienSuivi}`,
  proche: (p: any) =>
    `Bonjour ${p.prenom}, votre livreur arrive ! Soyez pret. Suivi : ${p.lienSuivi}`,
  expedition: (p: any) =>
    `Bonjour ${p.prenom}, commande ${p.id} expediee par GLS. Tracking ${p.tracking}. Suivi : https://gls-group.eu/FR/fr/suivi-colis.html?match=${p.tracking}`,
};

function prenomDe(client: string): string {
  return (client || '').replace(/^(M\.|Mme|Mr\.?)\s*/i, '').split(' ')[0] || 'Bonjour';
}

async function logHistorique(c: any, type: string, contenu: string, statut: string) {
  try {
    await sb.from('sms_historique').insert({
      id: 'sms_' + Date.now() + '_' + Math.random().toString(36).slice(2,8),
      client: c.client || '',
      tel: c.tel || '',
      type_sms: type,
      msg: contenu,
      statut: statut,
      date_sms: new Date().toISOString().split('T')[0],
      heure: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
    });
  } catch (_e) { /* silent */ }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: any;
  try { body = await req.json(); } catch { body = {}; }

  const { cmdId, type, heureArrivee } = body;
  if (!cmdId || !type) {
    return new Response(JSON.stringify({ error: 'cmdId et type requis' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  if (!['veille', 'depart', 'route', 'proche', 'expedition'].includes(type)) {
    return new Response(JSON.stringify({ error: 'type doit être : veille, depart, route, proche, expedition' }),
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
  // v3.1 : lien de confirmation de presence (SMS veille) -> confirmer.html
  const lienConfirm = cmd.tracking_token
    ? `${APP_BASE}/confirmer.html?t=${cmd.tracking_token}`
    : APP_BASE;
  const tracking = cmd.tracking_transporteur || '';
  // v3 : params veille (date livraison FR + creneau)
  const dateLiv = cmd.date_livraison ? new Date(cmd.date_livraison + 'T12:00:00') : null;
  // v7.5.68 : date courte JJ/MM (avant "lundi 18 juin" ~13 car) pour tenir le SMS
  // veille sous 160 car. Le mot "demain" du template donne deja le contexte.
  const dateFr = dateLiv
    ? String(dateLiv.getDate()).padStart(2, '0') + '/' + String(dateLiv.getMonth() + 1).padStart(2, '0')
    : '';
  const produit = (cmd.produit || 'votre commande').substring(0, 60);
  const creneauDeb = body.creneauDeb || '08:00';
  const creneauFin = body.creneauFin || '17:00';
  const contenu = TPL[type as keyof typeof TPL]({
    prenom, lienSuivi, lienConfirm, tracking, id: cmd.id, heureArrivee,
    dateFr, produit, creneauDeb, creneauFin,
  });

  // Envoi OVH (transactionnel — pas de clause STOP)
  const ok = await envoyerSMSOVH(cmd.tel, contenu);
  await logHistorique(cmd, type, contenu, ok ? 'envoyé' : 'échec');

  if (!ok) {
    return new Response(JSON.stringify({ error: 'envoi OVH échoué', contenu }),
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
