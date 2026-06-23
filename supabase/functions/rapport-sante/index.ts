// ════════════════════════════════════════════════════════════════════
// Edge Function : rapport-sante (v1 — 23/06/2026)
// ════════════════════════════════════════════════════════════════════
// "Gardien automatique" : vérifie l'état de l'app et envoie à Borhen un
// SMS bilan détaillé, 2 fois par jour (déclenché par pg_cron) :
//   - phase "soir"  (~20h30 Paris) : bilan du jour + état de DEMAIN
//                    (tournée demain, SMS veille partis, créneaux détectés)
//   - phase "matin" (~7h30 Paris)  : check du JOUR avant/au départ
//                    (tournée du jour, SMS départ partis, impératifs horaires)
//
// Contrôles : rentabilité tournée, SMS veille/départ envoyés, créneaux
// horaires détectés, commandes prises sur 24h, SMS d'approche du jour,
// échecs SMS du jour, crédits OVH restants.
//
// Body : { phase: "soir" | "matin", force?: boolean, dryRun?: boolean }
//   - dryRun=true : ne renvoie que le message (n'envoie pas le SMS) — pour test
//   - force=true  : ignore la dédupe (renvoie même si déjà envoyé aujourd'hui)
//
// Secrets : OVH_* (voir _shared/ovh-sms.ts) + SUPABASE_URL/SERVICE_ROLE_KEY.
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { envoyerSMSOVH, creditsOVH, telIntl } from '../_shared/ovh-sms.ts';

const SB_URL    = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const TEL_BORHEN = Deno.env.get('RAPPORT_TEL') || '+33744289321';
const SEUIL_RENTABLE = 13;     // clients pour qu'une tournée soit "rentable"
const SEUIL_OVH_BAS  = 100;    // alerte si crédits OVH sous ce seuil

const sb = createClient(SB_URL, SB_SR_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Date au format YYYY-MM-DD en heure de Paris (offset en jours)
function dateParis(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}
function jjmm(ymd: string): string {
  const p = ymd.split('-'); return p[2] + '/' + p[1];
}

// ── Détecteur de créneau horaire (porté de l'app, v7.5.91) ───────────
// Renvoie { due } en minutes (échéance = creneauFin) ou null si pas d'impératif.
function detecterCreneau(texte: string): { due: number | null; ready: number | null } | null {
  if (!texte) return null;
  const t = (' ' + texte + ' ').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const parseH = (s: string): number | null => {
    const m = s.match(/(\d{1,2})\s*[h:]\s*(\d{2})?/); if (!m) return null;
    const hh = parseInt(m[1], 10), mm = m[2] ? parseInt(m[2], 10) : 0;
    if (hh > 23 || mm > 59) return null; return hh * 60 + mm;
  };
  let mE = t.match(/(?:entre|de)\s*(\d{1,2}\s*[h:]\s*\d{0,2})\s*(?:et|a|au|-|\/)\s*(\d{1,2}\s*[h:]\s*\d{0,2})/);
  if (mE) { const d = parseH(mE[1]), f = parseH(mE[2]); if (d != null && f != null && f > d) return { ready: d, due: f }; }
  if (/avant\s+midi/.test(t)) return { ready: null, due: 720 };
  let mA = t.match(/avant\s+(\d{1,2}\s*[h:]\s*\d{0,2})/);
  if (mA) { const fa = parseH(mA[1]); if (fa != null) return { ready: null, due: fa }; }
  if (/apres\s+midi/.test(t)) return { ready: 720, due: null };
  let mP = t.match(/(?:apres|a\s*partir\s*de|des)\s+(\d{1,2}\s*[h:]\s*\d{0,2})/);
  if (mP) { const da = parseH(mP[1]); if (da != null) return { ready: da, due: null }; }
  if (/imperatif|creneau|rendez\s*-?\s*vous|\brdv\b/.test(t)) {
    const mh = t.match(/(\d{1,2}\s*[h:]\s*\d{0,2})/);
    if (mh) { const hd = parseH(mh[1]); if (hd != null) return { ready: null, due: hd }; }
  }
  let mR = t.match(/(\d{1,2}\s*[h:]\s*\d{0,2})\s*(?:-|\/|a|au|et)\s*(\d{1,2}\s*[h:]\s*\d{0,2})/);
  if (mR) { const dr = parseH(mR[1]), fr = parseH(mR[2]); if (dr != null && fr != null && fr > dr) return { ready: dr, due: fr }; }
  let mC = t.match(/(?:^|\s)(?:a|pour|vers|livr\w*)\s+(?:de\s+)?(\d{1,2}\s*[h:]\s*\d{0,2})/);
  if (mC) { const hc = parseH(mC[1]); if (hc != null) return { ready: null, due: hc }; }
  const allH = t.match(/\d{1,2}\s*[h:]\s*\d{0,2}/g) || [];
  if (allH.length === 1) { const hs = parseH(allH[0]); if (hs != null && hs >= 360 && hs <= 1260) return { ready: null, due: hs }; }
  return null;
}
function fmtMin(min: number): string {
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}
function prenomDe(c: string): string {
  return (c || '').replace(/^(M\.|Mme|Mr\.?|Monsieur|Madame|Mlle)\s*/i, '').split(' ')[0] || '?';
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let body: any; try { body = await req.json(); } catch { body = {}; }
  const phase = (body.phase === 'matin') ? 'matin' : 'soir';
  const dryRun = !!body.dryRun;
  const force  = !!body.force;

  const today = dateParis(0);
  const cibleDate = (phase === 'soir') ? dateParis(1) : dateParis(0);
  const typeAttendu = (phase === 'soir') ? 'veille' : 'depart';
  const typeRapport = 'rapport-' + phase;

  // Dédupe : un seul rapport par phase et par jour (sauf force)
  if (!force) {
    const { data: dejaR } = await sb.from('sms_historique')
      .select('id').eq('type_sms', typeRapport).eq('date_sms', today).limit(1);
    if (dejaR && dejaR.length) {
      return new Response(JSON.stringify({ skipped: true, reason: 'rapport déjà envoyé', phase, today }),
        { headers: { 'Content-Type': 'application/json' } });
    }
  }

  const warns: string[] = [];

  // 1) Tournée cible (commandes RANOU à livrer ce jour-là, non annulées)
  const { data: cmdsCible } = await sb.from('commandes')
    .select('id,client,statut,instr,sms_envoyes,tel,transporteur')
    .eq('date_livraison', cibleDate).eq('transporteur', 'RANOU');
  const aLivrer = (cmdsCible || []).filter((c: any) => c.statut !== 'annulé');
  const nbClients = aLivrer.length;

  // 2) SMS veille/départ : combien (parmi ceux avec tel valide) ont reçu le type attendu
  const aNotifier = aLivrer.filter((c: any) => telIntl(c.tel || '') !== '');
  const notifies = aNotifier.filter((c: any) =>
    Array.isArray(c.sms_envoyes) && c.sms_envoyes.some((e: any) => e && e.type === typeAttendu));
  const nbNotif = notifies.length, nbANotif = aNotifier.length;
  if (nbANotif > 0 && nbNotif < nbANotif) {
    warns.push(`${nbANotif - nbNotif} client(s) sans SMS ${typeAttendu}`);
  }

  // 3) Créneaux horaires détectés dans les notes de la tournée cible
  const creneaux: { client: string; due: number | null }[] = [];
  for (const c of aLivrer) {
    const det = detecterCreneau(c.instr || '');
    if (det) creneaux.push({ client: c.client, due: det.due });
  }
  const nbCreneaux = creneaux.length;
  // le plus serré (échéance la plus tôt)
  const avecDue = creneaux.filter(x => x.due != null).sort((a, b) => (a.due! - b.due!));
  const plusServe = avecDue.length ? `${prenomDe(avecDue[0].client)} ${fmtMin(avecDue[0].due!)}` : '';

  // 4) Commandes prises sur 24h (hors SAV)
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: cmds24 } = await sb.from('commandes')
    .select('id,origine').gte('created_at', since);
  const nbCmd24 = (cmds24 || []).filter((c: any) =>
    String(c.id).indexOf('#SAV') !== 0 && String(c.origine || '').indexOf('SAV') !== 0).length;

  // 5) SMS d'approche envoyés aujourd'hui
  const { data: proche } = await sb.from('sms_historique')
    .select('id').eq('type_sms', 'proche').eq('date_sms', today);
  const nbProche = (proche || []).length;

  // 6) Échecs SMS aujourd'hui (tous types)
  const { data: echecs } = await sb.from('sms_historique')
    .select('id,type_sms,statut').eq('date_sms', today).neq('statut', 'envoyé');
  const nbEchecs = (echecs || []).length;
  if (nbEchecs > 0) warns.push(`${nbEchecs} SMS en echec`);

  // 7) Crédits OVH
  const credits = await creditsOVH();
  if (credits != null && credits < SEUIL_OVH_BAS) warns.push(`OVH bas: ${credits} credits`);

  // ── Construire le message ─────────────────────────────────────────
  const lignes: string[] = [];
  if (phase === 'soir') {
    lignes.push(`Maxiconfort - Bilan soir ${jjmm(today)}`);
    if (nbClients > 0) {
      const rent = nbClients >= SEUIL_RENTABLE ? 'RENTABLE' : `seuil ${SEUIL_RENTABLE}`;
      lignes.push(`Demain ${jjmm(cibleDate)}: ${nbClients} clients (${rent})`);
      lignes.push(`Veille: ${nbNotif}/${nbANotif} SMS`);
      lignes.push(`Creneaux: ${nbCreneaux}${plusServe ? ' (1er ' + plusServe + ')' : ''}`);
    } else {
      lignes.push(`Demain ${jjmm(cibleDate)}: aucune tournee RANOU`);
    }
    lignes.push(`Cmd 24h: ${nbCmd24} | Approche: ${nbProche}`);
  } else {
    lignes.push(`Maxiconfort - Check matin ${jjmm(today)}`);
    if (nbClients > 0) {
      lignes.push(`Tournee du jour: ${nbClients} clients`);
      lignes.push(`Depart: ${nbNotif}/${nbANotif} SMS`);
      lignes.push(`Imperatifs: ${nbCreneaux}${plusServe ? ' (1er ' + plusServe + ')' : ''}`);
    } else {
      lignes.push(`Aujourd'hui: aucune tournee RANOU`);
    }
    lignes.push(`Approche hier/jour: ${nbProche}`);
  }
  lignes.push(`Echecs SMS: ${nbEchecs} | OVH: ${credits != null ? credits : '?'} cr.`);
  lignes.push(warns.length ? `=> A VOIR: ${warns.join(' ; ')}` : `=> TOUT OK`);
  const message = lignes.join('\n');

  if (dryRun) {
    return new Response(JSON.stringify({ dryRun: true, phase, message, warns, longueur: message.length }),
      { headers: { 'Content-Type': 'application/json' } });
  }

  // Envoi à Borhen (transactionnel, pas de clause STOP)
  const ok = await envoyerSMSOVH(TEL_BORHEN, message);
  // Log dans l'historique (sert aussi de dédupe)
  try {
    await sb.from('sms_historique').insert({
      id: 'sms_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      client: 'BORHEN (rapport)', tel: TEL_BORHEN, type_sms: typeRapport,
      msg: message, statut: ok ? 'envoyé' : 'échec',
      date_sms: today,
      heure: new Date().toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }),
    });
  } catch (_e) { /* silent */ }

  return new Response(JSON.stringify({ sent: ok, phase, message, warns, to: TEL_BORHEN }),
    { status: ok ? 200 : 502, headers: { 'Content-Type': 'application/json' } });
});
