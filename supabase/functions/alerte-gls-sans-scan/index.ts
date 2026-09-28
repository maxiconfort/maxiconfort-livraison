// ════════════════════════════════════════════════════════════════════
// Edge Function : alerte-gls-sans-scan (v1 — 28/09/2026)
// ════════════════════════════════════════════════════════════════════
// GARDIEN « étiquette créée mais colis jamais remis à GLS ».
// Colis par colis (pas commande par commande) : pour chaque commande GLS
// (non annulée, étiquette de moins de `jours` jours), chaque n° de
// tracking_transporteur est vérifié via ShipIT-FARM « parceldetails ».
// Un colis est EN ALERTE si, 24 h (heuresMin) après la création de son
// étiquette, il n'a AUCUN événement autre que DATA_RECEIVED (= « données
// saisies, colis pas encore remis à GLS »).
//
// Exclusions : commandes annulées ; colis livrés ou déjà pris en charge ;
//   note de commande contenant « SANS SCAN OK » (toute la commande) ou
//   « SANS SCAN OK 00L2QLV5 00L2QLV6 » (seulement ces colis).
// Cache : table gls_colis (colis déjà pris en charge = plus jamais
//   interrogé). Anti-doublon : table gls_alertes (type 'sans-scan', 1 ligne
//   par colis et par jour) → au plus UNE alerte par jour et par colis ;
//   rappel chaque jour tant que ce n'est pas réglé.
// Canal : SMS OVH à Borhen (comme alerte-gls, 8 colis max) + copie complète
//   sur Telegram (bot de tiktok-finance-watch) + journal sms_historique.
//
// Body :
//   { dryRun?: true }      → liste complète, n'envoie rien, n'écrit rien
//   { creneau?: true }     → (crons) ne s'exécute qu'à 18h Paris lun-ven
//                            et 10h Paris le samedi (heure d'été/hiver gérée)
//   { heuresMin?: 24, jours?: 45, force?: true (ignore l'anti-doublon) }
// Crons : alerte-gls-sans-scan-* (migration 021), via interne.appel_fonction
//   (en-tête x-cron-secret lu dans Vault).
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { envoyerSMSOVH } from '../_shared/ovh-sms.ts';
import { appelInterne, refus } from '../_shared/controle-appelant.ts';
import { suivreColisGLS } from '../_shared/gls-suivi.ts';
import { analyserColis, numerosColis, exclusionSansScan } from '../_shared/gls-analyse.ts';

const SB_URL = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const BORHEN_TEL = Deno.env.get('RAPPORT_TEL') || '+33744289321';
const TYPE_ALERTE = 'sans-scan';

const sb = createClient(SB_URL, SB_SR_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

function jourParis(d = new Date()): string {
  return d.toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
}
function heureParis(): { h: number; jour: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false, weekday: 'short' }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour')?.value || '0') % 24;
  const wd = parts.find((p) => p.type === 'weekday')?.value || '';
  const jour = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  return { h, jour };
}
// Minuit Paris d'une date YYYY-MM-DD (approx. : décalage courant) — repli si GLS ne donne pas la date de création.
function debutJourParisMs(ymd: string): number {
  const t = Date.parse(ymd + 'T00:00:00Z');
  if (isNaN(t)) return NaN;
  const dec = new Date(new Date(t).toLocaleString('en-US', { timeZone: 'Europe/Paris' })).getTime() - new Date(new Date(t).toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
  return t - dec;
}

// Copie COMPLETE de la liste sur Telegram (bot deja utilise par tiktok-finance-watch) : le SMS
// est limite a 8 colis. Echec Telegram non bloquant (le SMS reste le canal principal).
async function envoyerTelegram(texte: string): Promise<boolean> {
  const token = Deno.env.get('TELEGRAM_TOKEN') || '', chat = Deno.env.get('TELEGRAM_CHAT_ID') || '';
  if (!token || !chat) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: texte, disable_web_page_preview: true }),
    });
    return r.ok;
  } catch { return false; }
}

const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method !== 'OPTIONS' && !appelInterne(req)) return refus();
  const t0 = Date.now();
  let body: any = {};
  try { body = await req.json(); } catch { /* vide */ }
  const dryRun = body.dryRun === true;
  const force = body.force === true;
  const heuresMin = Math.max(1, Number(body.heuresMin) || 24);
  const jours = Math.max(2, Math.min(90, Number(body.jours) || 45));

  // Créneau des crons : 18h Paris lun-ven, 10h Paris samedi (2 crons UTC par créneau
  // pour couvrir heure d'été ET d'hiver ; celui qui ne tombe pas à la bonne heure sort ici).
  if (body.creneau) {
    const { h, jour } = heureParis();
    const bon = (jour >= 1 && jour <= 5 && h === 18) || (jour === 6 && h === 10);
    if (!bon) return json({ ok: true, skipped: true, reason: `hors creneau (jour ${jour}, ${h}h Paris)` });
  }

  const limite = jourParis(new Date(Date.now() - jours * 86400000));
  const { data: cmds, error } = await sb.from('commandes')
    .select('id, statut, tracking_transporteur, gls_date_etiquette, gls_creation_at, instr')
    .eq('transporteur', 'GLS')
    .not('tracking_transporteur', 'is', null)
    .neq('statut', 'annulé')
    .or(`gls_date_etiquette.gte.${limite},gls_creation_at.gte.${limite}`);
  if (error) return json({ ok: false, error: error.message }, 500);

  // Colis déjà connus comme pris en charge (cache)
  const tous: { trackId: string; cmd: any }[] = [];
  for (const c of cmds || []) for (const t of numerosColis(c.tracking_transporteur)) tous.push({ trackId: t, cmd: c });
  const connus = new Set<string>();
  for (let i = 0; i < tous.length; i += 200) {
    const lot = tous.slice(i, i + 200).map((x) => x.trackId);
    const { data } = await sb.from('gls_colis').select('track_id').in('track_id', lot).not('prise_en_charge_at', 'is', null);
    for (const r of data || []) connus.add(r.track_id);
  }

  const enAlerte: any[] = [];
  const exclus: any[] = [];
  const erreurs: any[] = [];
  const pasEncore24h: any[] = [];
  const nouveauxPris: any[] = [];
  let dejaPris = 0;
  let verifies = 0;

  const file = tous.filter((x) => {
    if (connus.has(x.trackId)) { dejaPris++; return false; }
    return true;
  });
  const worker = async () => {
    while (file.length) {
      const { trackId, cmd } = file.shift()!;
      const excl = exclusionSansScan(cmd.instr);
      if (excl === 'tout' || (Array.isArray(excl) && excl.includes(trackId))) {
        exclus.push({ trackId, cmdId: cmd.id, raison: 'note SANS SCAN OK' });
        continue;
      }
      verifies++;
      const r = await suivreColisGLS(trackId);
      if (!r.ok) { erreurs.push({ trackId, cmdId: cmd.id, erreur: r.erreur }); continue; }
      const a = analyserColis(trackId, r.data);
      if (a.priseEnCharge) {
        nouveauxPris.push({ track_id: trackId, cmd_id: cmd.id, prise_en_charge_at: a.priseEnChargeAt, etat: a.etat, verifie_at: new Date().toISOString() });
        continue;
      }
      if (a.etat === 'livre') continue; // (impossible sans prise en charge, par sécurité)
      // Âge de l'étiquette : création chez GLS (1er DATA_RECEIVED), sinon verrou de création, sinon date d'étiquette
      let creeMs = Date.parse(a.creationAt || '');
      if (isNaN(creeMs)) creeMs = Date.parse(cmd.gls_creation_at || '');
      if (isNaN(creeMs)) creeMs = debutJourParisMs(cmd.gls_date_etiquette || '');
      const ageH = isNaN(creeMs) ? null : (Date.now() - creeMs) / 3600000;
      const ligne = {
        trackId, cmdId: cmd.id, statutCommande: cmd.statut,
        etiquetteCreee: isNaN(creeMs) ? null : new Date(creeMs).toISOString(),
        ageHeures: ageH === null ? null : Math.round(ageH), ageJours: ageH === null ? null : Math.floor(ageH / 24),
        evenements: a.nbEvenements, dernier: a.dernierLibelle,
      };
      if (ageH !== null && ageH < heuresMin) { pasEncore24h.push(ligne); continue; }
      enAlerte.push(ligne);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  enAlerte.sort((a, b) => (b.ageHeures ?? 0) - (a.ageHeures ?? 0) || a.trackId.localeCompare(b.trackId));

  // Anti-doublon : déjà alerté aujourd'hui ?
  const aujourdhui = jourParis();
  const dejaAlertes = new Set<string>();
  if (enAlerte.length && !force) {
    const { data } = await sb.from('gls_alertes').select('cle').eq('type', TYPE_ALERTE).eq('jour', aujourdhui).in('cle', enAlerte.map((x) => x.trackId));
    for (const r of data || []) dejaAlertes.add(r.cle);
  }
  const aEnvoyer = enAlerte.filter((x) => !dejaAlertes.has(x.trackId));

  // Message (sans accents ni données client)
  const liste = aEnvoyer.slice(0, 8).map((x) => `${x.trackId} (${x.cmdId}, ${x.ageJours ?? '?'}j)`).join(', ');
  const plus = aEnvoyer.length > 8 ? ` +${aEnvoyer.length - 8} autres` : '';
  const msg = aEnvoyer.length
    ? `ALERTE GLS: ${aEnvoyer.length} colis SANS prise en charge 24h apres l'etiquette: ${liste}${plus}. Verifier depot/chauffeur. Ignorer: note "SANS SCAN OK <n colis>".`
    : '';

  const texteComplet = aEnvoyer.length
    ? `ALERTE GLS - ${aEnvoyer.length} colis SANS prise en charge 24 h apres l'etiquette :\n` +
      aEnvoyer.map((x) => `- ${x.trackId} | ${x.cmdId} (${x.statutCommande}) | ${x.ageJours ?? '?'} j`).join('\n') +
      `\nVerifier le depot / le chauffeur. Pour ignorer un colis : note "SANS SCAN OK <n colis>".`
    : '';

  const resultat: any = {
    ok: true, dryRun, version: 'v1', jour: aujourdhui, heuresMin, jours,
    colis_total: tous.length, deja_pris_en_charge_cache: dejaPris, verifies_api: verifies,
    nb_en_alerte: enAlerte.length, nb_deja_alertes_aujourdhui: dejaAlertes.size, nb_a_envoyer: aEnvoyer.length,
    en_alerte: enAlerte, exclus, erreurs_api: erreurs, moins_de_24h: pasEncore24h,
    nouveaux_pris_en_charge: nouveauxPris.length, sms: msg || null, telegram_texte: texteComplet || null,
  };

  if (dryRun) { resultat.duration_ms = Date.now() - t0; return json(resultat); }

  // Cache des colis pris en charge (plus jamais interrogés)
  if (nouveauxPris.length) {
    try { await sb.from('gls_colis').upsert(nouveauxPris, { onConflict: 'track_id' }); } catch (_e) { /* non bloquant */ }
  }

  if (aEnvoyer.length) {
    // Réserver d'abord (anti-doublon même en cas d'appels simultanés), puis envoyer
    const lignes = aEnvoyer.map((x) => ({ type: TYPE_ALERTE, cle: x.trackId, jour: aujourdhui, cmd_id: x.cmdId, message: `${x.ageJours ?? '?'}j sans prise en charge` }));
    const { error: errRes } = force
      ? await sb.from('gls_alertes').upsert(lignes, { onConflict: 'type,cle,jour', ignoreDuplicates: true })
      : await sb.from('gls_alertes').insert(lignes);
    if (errRes && !force) {
      resultat.duration_ms = Date.now() - t0;
      return json({ ...resultat, ok: true, skipped: true, reason: 'alerte deja reservee par un autre passage : ' + errRes.message });
    }
    const ok = await envoyerSMSOVH(BORHEN_TEL, msg);
    resultat.envoye = ok;
    resultat.telegram = await envoyerTelegram(texteComplet);
    try {
      await sb.from('gls_alertes').update({ envoye: ok }).eq('type', TYPE_ALERTE).eq('jour', aujourdhui).in('cle', aEnvoyer.map((x) => x.trackId));
      await sb.from('sms_historique').insert({
        id: 'sms_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        client: 'Borhen (gardien)', tel: BORHEN_TEL, type_sms: 'alerte-gls-scan', msg,
        statut: ok ? 'envoyé' : 'échec', date_sms: aujourdhui,
        heure: new Date().toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }),
      });
    } catch (_e) { /* journal non bloquant */ }
  }
  resultat.duration_ms = Date.now() - t0;
  return json(resultat);
});
