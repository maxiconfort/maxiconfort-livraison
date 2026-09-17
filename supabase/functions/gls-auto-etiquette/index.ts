// ════════════════════════════════════════════════════════════════════
// Edge Function : gls-auto-etiquette (v1 — 17/09/2026)
// ════════════════════════════════════════════════════════════════════
// Demande Borhen : « quand une commande GLS tombe, ça doit imprimer tout seul ».
// L'agent du bureau (print-agent) imprime dès qu'une étiquette existe ; cette
// fonction crée donc l'étiquette AUTOMATIQUEMENT, sans clic, via gls-create-shipment.
//
// Cron gls-auto-etiquette-5min (migration 015) : toutes les 5 min, 7h-21h55 Paris.
//
// Commande éligible :
//   transporteur = 'GLS', statut = 'en-attente', pas d'étiquette,
//   jamais tentée (gls_creation_statut NULL), hors #SAV,
//   créée depuis la mise en service (17/09/2026 00:00 Paris),
//   créée il y a plus de DELAI_MIN (30 min : le temps d'annuler / corriger)
//   et pas modifiée depuis 5 min (Borhen est peut-être en train de la corriger).
// Exclusions par la note (instr) : « SANS ETIQUETTE », « PAS D'ETIQUETTE », « YOURGLS »
//   → statut 'ignore' (plus jamais reconsidérée automatiquement).
// Adresse sans code postal à 5 chiffres → 'echec' sans appel GLS.
//
// Sécurité facturation :
//   - le verrou atomique est posé DANS gls-create-shipment (RPC gls_reserver_creation) ;
//   - aucune nouvelle tentative automatique : 'echec' / 'incertain' → SMS à Borhen ;
//   - verrou 'en_cours' de plus de 15 min → 'incertain' + SMS (vérifier YourGLS).
//
// Body (optionnel) : { dryRun?: true, delaiMin?: 30, max?: 5 }
// Secrets : SUPABASE_* (auto) + OVH_* (_shared/ovh-sms.ts)
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { envoyerSMSOVH } from '../_shared/ovh-sms.ts';

const SB_URL     = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const BORHEN_TEL = Deno.env.get('RAPPORT_TEL') || '+33744289321';

// 17/09/2026 00:00 heure de Paris (UTC+2) : les commandes plus anciennes restent manuelles
const MISE_EN_SERVICE_ISO = '2026-09-16T22:00:00Z';

const sb = createClient(SB_URL, SB_SR_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const JSON_H = { 'Content-Type': 'application/json' };

function sansAccents(s: string): string {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function noteExclut(instr: string): string | null {
  const t = sansAccents(instr).toUpperCase().replace(/[^A-Z0-9]+/g, ' ');
  if (/\b(SANS|PAS D|PAS DE|NO) ?ETIQUETTE/.test(t)) return 'note : sans etiquette';
  if (/\bYOUR ?GLS\b/.test(t)) return 'note : expediee sur YourGLS';
  return null;
}
function todayParis(): string {
  return new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
}
function heureParis(): string {
  return new Date().toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
}

Deno.serve(async (req: Request) => {
  let body: any = {};
  try { body = await req.json(); } catch { /* body vide */ }
  const dryRun = !!body.dryRun;
  const delaiMin = Math.max(5, Number(body.delaiMin) || 30);
  const max = Math.min(10, Math.max(1, Number(body.max) || 5));

  const maintenant = Date.now();
  const alertes: string[] = [];
  const rapport: any = { creees: [], ignorees: [], echecs: [], incertaines: [], en_attente_delai: [] };

  // ── 1. Verrous abandonnés (création interrompue) ──────────────────────
  const limiteVerrou = new Date(maintenant - 15 * 60000).toISOString();
  const { data: bloquees } = await sb.from('commandes')
    .select('id, client, gls_creation_at, gls_creation_source')
    .eq('gls_creation_statut', 'en_cours')
    .lt('gls_creation_at', limiteVerrou);
  for (const c of bloquees || []) {
    if (!dryRun) {
      await sb.from('commandes').update({
        gls_creation_statut: 'incertain',
        gls_creation_erreur: 'Création interrompue (plus de 15 min) — vérifiez YourGLS avant de recréer',
      }).eq('id', c.id).eq('gls_creation_statut', 'en_cours');
    }
    rapport.incertaines.push(c.id);
    alertes.push(`${c.id} interrompue (verifier YourGLS)`);
  }

  // ── 2. Candidates ─────────────────────────────────────────────────────
  const { data: cmds, error } = await sb.from('commandes')
    .select('id, client, adresse, instr, created_at, updated_at, statut, transporteur, tracking_transporteur')
    .eq('transporteur', 'GLS')
    .eq('statut', 'en-attente')
    .is('gls_creation_statut', null)
    .gte('created_at', MISE_EN_SERVICE_ISO)
    .order('created_at', { ascending: true })
    .limit(30);
  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: JSON_H });
  }

  const aCreer: any[] = [];
  for (const c of cmds || []) {
    if (String(c.tracking_transporteur || '').trim()) continue;
    if (String(c.id).startsWith('#SAV')) continue;
    const ageMin = (maintenant - new Date(c.created_at).getTime()) / 60000;
    const calmeMin = (maintenant - new Date(c.updated_at || c.created_at).getTime()) / 60000;
    if (ageMin < delaiMin || calmeMin < 5) {
      rapport.en_attente_delai.push({ id: c.id, dans_min: Math.max(Math.ceil(delaiMin - ageMin), Math.ceil(5 - calmeMin)) });
      continue;
    }
    const exclu = noteExclut(c.instr || '');
    if (exclu) {
      if (!dryRun) {
        await sb.from('commandes').update({ gls_creation_statut: 'ignore', gls_creation_erreur: exclu })
          .eq('id', c.id).is('gls_creation_statut', null);
      }
      rapport.ignorees.push({ id: c.id, motif: exclu });
      continue;
    }
    if (!/\b\d{5}\b/.test(String(c.adresse || '')) || !String(c.client || '').trim()) {
      const motif = 'adresse sans code postal ou client vide';
      if (!dryRun) {
        await sb.from('commandes').update({ gls_creation_statut: 'echec', gls_creation_erreur: motif })
          .eq('id', c.id).is('gls_creation_statut', null);
      }
      rapport.echecs.push({ id: c.id, motif });
      alertes.push(`${c.id} ${motif}`);
      continue;
    }
    aCreer.push(c);
  }

  if (dryRun) {
    return new Response(JSON.stringify({ ok: true, dryRun: true, a_creer: aCreer.map((c) => ({ id: c.id, client: c.client })), ...rapport }),
      { headers: JSON_H });
  }

  // ── 3. Création, une par une (jamais en parallèle, jamais de nouvel essai) ─
  for (const c of aCreer.slice(0, max)) {
    let res: any = {};
    let http = 0;
    try {
      const r = await fetch(`${SB_URL}/functions/v1/gls-create-shipment`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SB_SR_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmdId: c.id, auto: true }),
        signal: AbortSignal.timeout(140000),
      });
      http = r.status;
      res = await r.json().catch(() => ({}));
    } catch (e: any) {
      // Pas de réponse : gls-create-shipment continue peut-être → le verrou tranchera au prochain passage
      rapport.incertaines.push(c.id);
      console.warn('gls-auto-etiquette: pas de reponse pour', c.id, e?.message);
      continue;
    }
    if (res.ok) {
      rapport.creees.push({ id: c.id, client: c.client, colis: res.nbColis || 1, tracking: res.trackId });
    } else if (http === 409) {
      rapport.ignorees.push({ id: c.id, motif: res.error || 'verrou' });
    } else {
      const motif = res.code === 'incertain' ? 'coupure GLS (verifier YourGLS)' : `refus GLS: ${String(res.gls_response?.message || res.error || http).slice(0, 60)}`;
      (res.code === 'incertain' ? rapport.incertaines : rapport.echecs).push({ id: c.id, motif });
      alertes.push(`${c.id} ${motif}`);
    }
  }

  // ── 4. Alerte SMS à Borhen (seulement en cas de problème) ─────────────
  if (alertes.length) {
    const msg = sansAccents(`GLS AUTO: etiquette NON creee pour ${alertes.slice(0, 3).join(' ; ')}${alertes.length > 3 ? ` +${alertes.length - 3}` : ''}. A faire a la main dans l'app.`);
    const ok = await envoyerSMSOVH(BORHEN_TEL, msg);
    try {
      await sb.from('sms_historique').insert({
        id: 'sms_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        client: 'Borhen (gls-auto)', tel: BORHEN_TEL, type_sms: 'gls-auto',
        msg, statut: ok ? 'envoyé' : 'échec', date_sms: todayParis(), heure: heureParis(),
      });
    } catch (_e) { /* non bloquant */ }
    rapport.sms_alerte = { ok, msg };
  }

  return new Response(JSON.stringify({ ok: true, ...rapport }), { headers: JSON_H });
});
