// ════════════════════════════════════════════════════════════════════
// Edge Function : sms-avis-relance (v2.2 — 02/10/2026)
// ════════════════════════════════════════════════════════════════════
// v2.2 (02/10/2026) : meme garde que sms-avis v2.1 — une etape de relance
//   n'est jamais envoyee 2 fois au meme NUMERO en 60 j (sms_historique,
//   commandes multiples d'un client comprises), arret apres 3 echecs OVH ;
//   pas de relance si stpaie != « Payé » ou colis GLS jamais scanne / partiel.
//
// v2.1 (28/09/2026) : AUCUNE relance pour une commande qui a (ou a eu) un
//   litige ou un SAV lié, ou une livraison GLS partielle/retour
//   (_shared/avis-garde.ts). Après clôture : seule la demande unique de
//   sms-avis (J+2 après clôture) est envoyée, jamais de relance.
//
// RELANCES d'avis Google apres la premiere demande (sms-avis, J+1).
//
// v1.0 (02/09/2026) : relance unique a J+7. Constat : 204 SMS "avis" pour
//   ~12 avis (taux ~4%). Une relance double typiquement le taux de retour.
// v2.0 (16/09/2026, demande Borhen "plus de relances, que ca aille plus
//   vite") : DEUX relances, plus tot — J+4 ("avis-relance") puis J+10
//   ("avis-relance2"). Jamais de 3e. Textes differents (send-cmd-sms).
//
// Scan, pour chaque etape : commandes livrees il y a J jours (fenetre de
//   2 jours J..J+1 comme sms-avis), statut "livré", tel valide, hors #SAV,
//   non exclues (note "PAS D'AVIS"), AYANT DEJA recu la 1re demande (type
//   "avis" dans sms_envoyes) et PAS ENCORE recu cette etape (dedupe par type).
//   L'etape 2 ne depend pas de l'etape 1 (si elle a ete ratee, on n'envoie
//   quand meme qu'une seule relance 2).
//
// ⚠️ Chaque etape = 1 SMS max par commande (dedupe sms_envoyes).
// ⚠️ Meme regle province/GLS que sms-avis (reprise a partir du 14/09/2026).
// ⚠️ Demande HONNETE, sans condition ni recompense. 1 SMS = 1 credit OVH.
//
// Body : { dryRun?: boolean, dateCible?: "YYYY-MM-DD", jours?: number|number[],
//          etape?: 1|2 }
//   - jours : delais en jours des etapes (defaut [4, 10]) ; un nombre seul
//     = uniquement l'etape 1 a ce delai (compat v1).
//   - dateCible : force la date de livraison scannee (test/rattrapage) ;
//     s'applique a l'etape `etape` (defaut 1).
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { appelInterne, refus } from '../_shared/controle-appelant.ts';
import {
  ajouterJours, DELAI_ANTI_DOUBLON_JOURS, evaluerAvis, gardeHistorique, indexerSav, noteExclut, type LigneHisto,
} from '../_shared/avis-garde.ts';
import { livraisonGlsContestee } from '../_shared/avis-gls.ts';

const SB_URL    = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

// Meme regle que sms-avis : province reactivee le 14/09/2026 pour les
// livraisons GLS a partir de AVIS_GLS_DEPUIS (pas de rattrapage).
const PAUSE_AVIS_GLS = false;
const AVIS_GLS_DEPUIS = '2026-09-14';

// Etapes de relance : delai (jours apres la livraison) + type SMS.
const ETAPES_DEFAUT = [
  { jours: 4,  type: 'avis-relance'  },
  { jours: 10, type: 'avis-relance2' },
];

const sb = createClient(SB_URL, SB_SR_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Content-Type': 'application/json',
};

// v2.1 (02/10/2026) : journal durable des SMS d'avis (anti-doublon par NUMERO, 60 j)
async function chargerHistoAvis(aujourdhui: string): Promise<LigneHisto[]> {
  const { data, error } = await sb.from('sms_historique').select('tel,type_sms,statut,date_sms')
    .in('type_sms', ['avis', 'avis-relance', 'avis-relance2'])
    .gte('date_sms', ajouterJours(aujourdhui, -DELAI_ANTI_DOUBLON_JOURS)).limit(5000);
  if (error) throw new Error('select sms_historique failed: ' + error.message);
  return (data || []) as LigneHisto[];
}

function toLocalDateStr(d: Date): string {
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const paris = new Date(utc + 3600000);
  return paris.toISOString().split('T')[0];
}

Deno.serve(async (req: Request) => {
  // 27/09/2026 : controle d'appelant (crons = x-cron-secret ; fonctions/scripts serveur = cle secrete sb_secret_)
  if (req.method !== 'OPTIONS' && !appelInterne(req)) return refus();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const t0 = Date.now();
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }

  // Mode test { cmdIds:[...] } : evalue ces commandes pour chaque etape, sans filtre de date (toujours dryRun)
  const testIds: string[] | null = Array.isArray(body.cmdIds) ? body.cmdIds.map(String) : null;
  const dryRun = body.dryRun === true || !!testIds;

  // Etapes a traiter (jours = nombre -> etape 1 seule ; tableau -> 1 par valeur)
  let etapes = ETAPES_DEFAUT.map(e => ({ ...e }));
  if (Array.isArray(body.jours)) {
    etapes = body.jours.slice(0, 2).map((j: any, i: number) => ({
      jours: Number(j) > 0 ? Number(j) : ETAPES_DEFAUT[i].jours, type: ETAPES_DEFAUT[i].type,
    }));
  } else if (Number(body.jours) > 0) {
    etapes = [{ jours: Number(body.jours), type: ETAPES_DEFAUT[0].type }];
  }
  if (body.dateCible) {
    const idx = Number(body.etape) === 2 ? 1 : 0;
    etapes = [etapes[idx] || ETAPES_DEFAUT[idx]];
  }

  // SAV (non annulés) : index « commande d'origine -> SAV liés »
  const { data: savs, error: errSav } = await sb.from('commandes')
    .select('id,statut,instr,date_livraison,updated_at').ilike('id', '%sav%').neq('statut', 'annulé');
  if (errSav) return new Response(JSON.stringify({ error: 'select SAV failed', details: errSav.message }), { status: 500, headers: CORS });
  const savIdx = indexerSav(savs || []);
  const aujourdhui = new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
  let histo: LigneHisto[];
  try { histo = await chargerHistoAvis(aujourdhui); } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }

  let scanned = 0, sent = 0, skipped = 0, failed = 0;
  const details: any[] = [];
  const fenetres: any[] = [];

  for (const etape of etapes) {
    // Fenetre de 2 jours autour de J-jours (rattrape les commandes passees en
    // "livré" apres l'heure du cron).
    let dateMin: string, dateMax: string;
    if (body.dateCible) {
      dateMin = body.dateCible; dateMax = body.dateCible;
    } else {
      const d1 = new Date(); d1.setDate(d1.getDate() - etape.jours);
      const d2 = new Date(); d2.setDate(d2.getDate() - (etape.jours + 1));
      dateMax = toLocalDateStr(d1);
      dateMin = toLocalDateStr(d2);
    }
    fenetres.push({ type: etape.type, jours: etape.jours, dateMin, dateMax });

    const q0 = sb.from('commandes')
      .select('id,client,tel,statut,stpaie,transporteur,tracking_transporteur,sms_envoyes,date_livraison,instr,litige_statut,litige_clos_at,gls_livraison_etat,gls_livraison_detail')
      ;
    const { data: cmds, error } = testIds
      ? await q0.in('id', testIds)
      : await q0.gte('date_livraison', dateMin).lte('date_livraison', dateMax).eq('statut', 'livré');

    if (error) {
      return new Response(JSON.stringify({ error: 'select commandes failed', details: error.message }),
        { status: 500, headers: CORS });
    }

    for (const c of cmds || []) {
      scanned++;
      const base = { id: c.id, etape: etape.type };
      if (/sav/i.test(String(c.id))) {
        skipped++; details.push({ ...base, action: 'skip_sav' }); continue;
      }
      const estGls = /gls/i.test(String(c.transporteur || ''));
      if (PAUSE_AVIS_GLS && estGls) {
        skipped++; details.push({ ...base, action: 'skip_pause_gls' }); continue;
      }
      if (noteExclut(c.instr)) {
        skipped++; details.push({ ...base, action: 'skip_exclu_note', client: c.client }); continue;
      }
      // v2.1 : litige / SAV (ouvert OU clos) / livraison partielle -> jamais de relance
      const ev = evaluerAvis(c, savIdx);
      if (ev.bloque) {
        skipped++; details.push({ ...base, action: 'skip_suspendu', motif: ev.bloque, client: c.client }); continue;
      }
      if (ev.historique) {
        skipped++; details.push({ ...base, action: 'skip_litige_sav_sans_relance', savLies: ev.savLies, client: c.client }); continue;
      }
      if (estGls && String(c.date_livraison || '') < AVIS_GLS_DEPUIS) {
        skipped++; details.push({ ...base, action: 'skip_gls_avant_reprise' }); continue;
      }
      const tel = (c.tel || '').replace(/[^0-9+]/g, '');
      if (!tel || tel.length < 8) {
        skipped++; details.push({ ...base, action: 'skip_no_tel' }); continue;
      }

      const dejaEnvoyes: any[] = Array.isArray(c.sms_envoyes) ? c.sms_envoyes : [];
      // Il FAUT avoir recu la 1re demande (sinon c'est sms-avis qui doit agir).
      if (!dejaEnvoyes.some((e: any) => e.type === 'avis')) {
        skipped++; details.push({ ...base, action: 'skip_pas_de_1re_demande', client: c.client }); continue;
      }
      // Une seule fois par etape, jamais deux.
      if (dejaEnvoyes.some((e: any) => e.type === etape.type)) {
        skipped++; details.push({ ...base, action: 'skip_deja_envoye' }); continue;
      }
      // v2.2 : source durable sms_historique (meme etape deja envoyee a ce numero < 60 j)
      const dejaNumero = gardeHistorique(etape.type, tel, histo, aujourdhui);
      if (dejaNumero) {
        skipped++; details.push({ ...base, action: 'skip_doublon_numero', motif: dejaNumero, client: c.client }); continue;
      }
      // v2.1 : client GLS -> relecture des colis chez GLS (faux livre / partiel / retour)
      const contestee = await livraisonGlsContestee(c);
      if (contestee) {
        skipped++; details.push({ ...base, action: 'skip_suspendu', motif: contestee, client: c.client }); continue;
      }

      if (dryRun) {
        sent++;
        histo.push({ tel, type_sms: etape.type, statut: 'envoyé', date_sms: aujourdhui });
        details.push({ ...base, action: 'would_send', client: c.client, to: tel });
        continue;
      }

      try {
        const resp = await fetch(`${SB_URL}/functions/v1/send-cmd-sms`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${SB_SR_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ cmdId: c.id, type: etape.type }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!data.skipped) histo.push({ tel, type_sms: etape.type, statut: data.sent ? 'envoyé' : 'échec', date_sms: aujourdhui });
        if (data.sent) { sent++; details.push({ ...base, action: 'sent', to: data.to }); }
        else if (data.skipped) { skipped++; details.push({ ...base, action: 'skip_send', reason: data.reason }); }
        else { failed++; details.push({ ...base, action: 'failed', error: data.error }); }
      } catch (e: any) {
        failed++; details.push({ ...base, action: 'exception', error: e.message });
      }
    }
  }

  return new Response(JSON.stringify({
    ok: true, version: 'v2.2', dryRun, fenetres, scanned, sent, skipped, failed,
    duration_ms: Date.now() - t0, details,
  }), { headers: CORS });
});
