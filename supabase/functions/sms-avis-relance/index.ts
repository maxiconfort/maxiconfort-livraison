// ════════════════════════════════════════════════════════════════════
// Edge Function : sms-avis-relance (v2.0 — 16/09/2026)
// ════════════════════════════════════════════════════════════════════
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

function toLocalDateStr(d: Date): string {
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const paris = new Date(utc + 3600000);
  return paris.toISOString().split('T')[0];
}

function noteExclut(instr: string): boolean {
  const clean = String(instr || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  return /\b(noavis|no avis|sans avis|pas d avis|pas avis|pasdavis)\b/.test(clean);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const t0 = Date.now();
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }

  const dryRun = body.dryRun === true;

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

    const { data: cmds, error } = await sb.from('commandes')
      .select('id,client,tel,statut,transporteur,sms_envoyes,date_livraison,instr')
      .gte('date_livraison', dateMin)
      .lte('date_livraison', dateMax)
      .eq('statut', 'livré');

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
      if (estGls && String(c.date_livraison || '') < AVIS_GLS_DEPUIS) {
        skipped++; details.push({ ...base, action: 'skip_gls_avant_reprise' }); continue;
      }
      if (noteExclut(c.instr)) {
        skipped++; details.push({ ...base, action: 'skip_exclu_note', client: c.client }); continue;
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

      if (dryRun) {
        sent++;
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
        if (data.sent) { sent++; details.push({ ...base, action: 'sent', to: data.to }); }
        else if (data.skipped) { skipped++; details.push({ ...base, action: 'skip_send', reason: data.reason }); }
        else { failed++; details.push({ ...base, action: 'failed', error: data.error }); }
      } catch (e: any) {
        failed++; details.push({ ...base, action: 'exception', error: e.message });
      }
    }
  }

  return new Response(JSON.stringify({
    ok: true, dryRun, fenetres, scanned, sent, skipped, failed,
    duration_ms: Date.now() - t0, details,
  }), { headers: CORS });
});
