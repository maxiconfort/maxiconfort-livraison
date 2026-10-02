// ════════════════════════════════════════════════════════════════════
// Edge Function : sms-avis (v2.1 — 02/10/2026)
// ════════════════════════════════════════════════════════════════════
// Tourne en CRON 1x/jour (~11h Paris) : demande d'avis Google le LENDEMAIN
// de la livraison.
//
// Scan : commandes livrees HIER (date_livraison = J-1 Paris, fenetre J-3..J-1),
//        statut="livré", tel valide, hors #SAV, NON exclues (note), pas deja
//        sollicitee (dedupe sms_envoyes type "avis").
// Pour chaque : appelle send-cmd-sms { type:"avis" }.
//
// EXCLUSION "client a risque" (v1.1) : si la note de commande (instr) contient
//   "PAS D'AVIS" / "SANS AVIS" / "NO AVIS" -> pas de demande d'avis.
//
// v2.0 (28/09/2026) : SUSPENSION PENDANT LITIGE / SAV (_shared/avis-garde.ts)
//   - bloque : litige ouvert, SAV ouvert lie (note du SAV « cmd origine #... »),
//     livraison GLS partielle ou retour (gls_livraison_etat), note PAS D'AVIS.
//   - reprise : quand litige ET SAV lies sont clos, UNE seule demande a J+2
//     apres la cloture (fenetre 3 jours) ; sms-avis-relance ne relance jamais
//     ces commandes.
//
// v2.1 (02/10/2026) : ANTI-DOUBLON DURABLE + PAIEMENT + GLS
//   - sms_envoyes est par commande : un client a plusieurs commandes recevait
//     une demande par commande. On verifie aussi sms_historique : aucune
//     demande « avis » deja envoyee a ce NUMERO depuis 60 j (et arret apres
//     3 echecs OVH en 7 j). Dans un meme passage, un numero n'est servi qu'une fois.
//   - pas de demande si stpaie != « Payé », si un colis GLS n'a jamais ete
//     scanne / livraison partielle / GLS illisible sans « livre » en base.
//
// ⏸️ PAUSE PROVINCE/GLS (v1.2, demande Borhen 17/07/2026) — levee le 14/09
//   (v1.4) pour les livraisons GLS a partir de AVIS_GLS_DEPUIS.
//
// ⚠️ Demande d'avis HONNETE, sans condition ni recompense. 1 SMS = 1 credit OVH.
//
// Body : { dryRun?: boolean, dateCible?: "YYYY-MM-DD" }
//   ou   { cmdIds: [...], simulation?: true } (toujours dryRun) : simulation = ignore
//        la fenetre de date et les dedoublonnages (sms_envoyes, sms_historique)
//        pour verifier les autres gardes (paiement, litige, GLS en direct).
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { appelInterne, refus } from '../_shared/controle-appelant.ts';
import { livraisonGlsContestee } from '../_shared/avis-gls.ts';
import {
  ajouterJours, DELAI_ANTI_DOUBLON_JOURS, demandeDueAujourdhui, estSav, evaluerAvis, gardeHistorique, indexerSav, type LigneHisto,
} from '../_shared/avis-garde.ts';

const SB_URL    = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const PAUSE_AVIS_GLS = false;
const AVIS_GLS_DEPUIS = '2026-09-14';

const sb = createClient(SB_URL, SB_SR_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Content-Type': 'application/json',
};

const COLS = 'id,client,tel,statut,stpaie,transporteur,tracking_transporteur,sms_envoyes,date_livraison,instr,litige_statut,litige_clos_at,gls_livraison_etat,gls_livraison_detail';

// v2.1 (02/10/2026) : journal durable des SMS d'avis (anti-doublon par NUMERO, 60 j)
async function chargerHistoAvis(aujourdhui: string): Promise<LigneHisto[]> {
  const { data, error } = await sb.from('sms_historique').select('tel,type_sms,statut,date_sms')
    .in('type_sms', ['avis', 'avis-relance', 'avis-relance2'])
    .gte('date_sms', ajouterJours(aujourdhui, -DELAI_ANTI_DOUBLON_JOURS)).limit(5000);
  if (error) throw new Error('select sms_historique failed: ' + error.message);
  return (data || []) as LigneHisto[];
}

function jourParis(): string {
  return new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
}

Deno.serve(async (req: Request) => {
  // 27/09/2026 : controle d'appelant (crons = x-cron-secret ; fonctions/scripts serveur = cle secrete sb_secret_)
  if (req.method !== 'OPTIONS' && !appelInterne(req)) return refus();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const t0 = Date.now();
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }

  // Mode test { cmdIds:[...] } : evalue ces commandes quelle que soit leur date (toujours dryRun)
  const testIds: string[] | null = Array.isArray(body.cmdIds) ? body.cmdIds.map(String) : null;
  const dryRun = body.dryRun === true || !!testIds;
  const simulation = !!testIds && body.simulation === true;
  const aujourdhui = jourParis();

  // v1.3 : fenetre de 3 jours (J-3..J-1) ; body.dateCible (jour unique) pour tests/rattrapages.
  const dateMin: string = body.dateCible || ajouterJours(aujourdhui, -3);
  const dateMax: string = body.dateCible || ajouterJours(aujourdhui, -1);
  const dateCible = dateMin === dateMax ? dateMin : `${dateMin}..${dateMax}`;

  // SAV (non annules) pour savoir quelles commandes ont un SAV ouvert / clos
  const { data: savs, error: errSav } = await sb.from('commandes')
    .select('id,statut,instr,date_livraison,updated_at').ilike('id', '%sav%').neq('statut', 'annulé');
  if (errSav) return new Response(JSON.stringify({ error: 'select SAV failed', details: errSav.message }), { status: 500, headers: CORS });
  const savIdx = indexerSav(savs || []);
  let histo: LigneHisto[];
  try { histo = await chargerHistoAvis(aujourdhui); } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }

  // 1) livraisons de la fenetre normale
  const { data: cmds, error } = testIds
    ? await sb.from('commandes').select(COLS).in('id', testIds)
    : await sb.from('commandes').select(COLS)
      .gte('date_livraison', dateMin)
      .lte('date_livraison', dateMax)
      .eq('statut', 'livré');
  if (error) {
    return new Response(JSON.stringify({ error: 'select commandes failed', details: error.message }),
      { status: 500, headers: CORS });
  }

  // 2) reprises : litige clos ou SAV lie livre dans les 6 derniers jours
  const candidats = new Map<string, any>();
  for (const c of cmds || []) candidats.set(c.id, { ...c, _source: 'livraison' });
  if (!body.dateCible && !testIds) {
    const depuis = ajouterJours(aujourdhui, -6);
    const idsReprise = new Set<string>();
    for (const [cible, l] of savIdx) if (l.some((s) => !s.ouvert && s.cloture && s.cloture >= depuis)) idsReprise.add(cible);
    const { data: clos } = await sb.from('commandes').select(COLS).eq('statut', 'livré').gte('litige_clos_at', depuis + 'T00:00:00Z');
    for (const c of clos || []) if (!candidats.has(c.id)) candidats.set(c.id, { ...c, _source: 'reprise' });
    const manquants = [...idsReprise].filter((id) => !candidats.has(id));
    if (manquants.length) {
      const { data: r2 } = await sb.from('commandes').select(COLS).in('id', manquants).eq('statut', 'livré');
      for (const c of r2 || []) candidats.set(c.id, { ...c, _source: 'reprise' });
    }
  }

  let scanned = 0, sent = 0, skipped = 0, failed = 0;
  const details: any[] = [];

  for (const c of candidats.values()) {
    scanned++;
    const base = { id: c.id, source: c._source };
    if (estSav(c.id)) { skipped++; details.push({ ...base, action: 'skip_sav' }); continue; }
    const estGls = /gls/i.test(String(c.transporteur || ''));
    if (PAUSE_AVIS_GLS && estGls) { skipped++; details.push({ ...base, action: 'skip_pause_gls', client: c.client }); continue; }
    // v2.0 : litige / SAV / note / livraison partielle
    const ev = evaluerAvis(c, savIdx);
    if (ev.bloque) {
      skipped++; details.push({ ...base, action: ev.bloque.startsWith('note') ? 'skip_exclu_note' : 'skip_suspendu', motif: ev.bloque, client: c.client }); continue;
    }
    if (estGls && String(c.date_livraison || '') < AVIS_GLS_DEPUIS) {
      skipped++; details.push({ ...base, action: 'skip_gls_avant_reprise', client: c.client }); continue;
    }
    if (!simulation && (ev.historique || testIds)) {
      const due = demandeDueAujourdhui(String(c.date_livraison || '').substring(0, 10), ev, aujourdhui);
      if (due !== 'oui') {
        skipped++; details.push({ ...base, action: due === 'trop_tot' ? 'skip_attente_reprise_J+2' : (ev.historique ? 'skip_reprise_expiree' : 'skip_hors_fenetre'), cloture: ev.cloture, client: c.client }); continue;
      }
    }
    const tel = (c.tel || '').replace(/[^0-9+]/g, '');
    if (!tel || tel.length < 8) { skipped++; details.push({ ...base, action: 'skip_no_tel' }); continue; }
    const dejaEnvoyes: any[] = Array.isArray(c.sms_envoyes) ? c.sms_envoyes : [];
    if (!simulation && dejaEnvoyes.some((e: any) => e.type === 'avis')) { skipped++; details.push({ ...base, action: 'skip_already_sent' }); continue; }
    // v2.1 : source durable sms_historique (meme numero < 60 j, autre commande comprise)
    const dejaNumero = simulation ? null : gardeHistorique('avis', tel, histo, aujourdhui);
    if (dejaNumero) { skipped++; details.push({ ...base, action: 'skip_doublon_numero', motif: dejaNumero, client: c.client }); continue; }
    // v2.0 : client GLS -> relecture des colis chez GLS (faux livre / partiel / retour)
    const contestee = await livraisonGlsContestee(c);
    if (contestee) { skipped++; details.push({ ...base, action: 'skip_suspendu', motif: contestee, client: c.client }); continue; }

    if (dryRun) {
      sent++;
      histo.push({ tel, type_sms: 'avis', statut: 'envoyé', date_sms: aujourdhui });
      details.push({ ...base, action: 'would_send', client: c.client, to: tel, reprise: ev.historique ? ev.cloture : undefined });
      continue;
    }
    try {
      const resp = await fetch(`${SB_URL}/functions/v1/send-cmd-sms`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SB_SR_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmdId: c.id, type: 'avis' }),
      });
      const data = await resp.json().catch(() => ({}));
      // v2.1 : memoriser l'essai pour la suite du passage (2e commande du meme client)
      if (!data.skipped) histo.push({ tel, type_sms: 'avis', statut: data.sent ? 'envoyé' : 'échec', date_sms: aujourdhui });
      if (data.sent) { sent++; details.push({ ...base, action: 'sent', to: data.to }); }
      else if (data.skipped) { skipped++; details.push({ ...base, action: 'skip_send', reason: data.reason }); }
      else { failed++; details.push({ ...base, action: 'failed', error: data.error }); }
    } catch (e: any) {
      failed++; details.push({ ...base, action: 'exception', error: e.message });
    }
  }

  return new Response(JSON.stringify({
    ok: true, version: 'v2.1', dryRun, simulation, dateCible, scanned, sent, skipped, failed,
    duration_ms: Date.now() - t0, details,
  }), { headers: CORS });
});
