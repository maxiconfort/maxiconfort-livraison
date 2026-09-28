// ════════════════════════════════════════════════════════════════════
// Edge Function : alerte-gls-sans-scan (v2 — 28/09/2026)
// ════════════════════════════════════════════════════════════════════
// GARDIEN GLS : 4 contrôles, 1 seule fonction (anti-doublon commun).
//
//  controle = 'sans-scan' (défaut, 18h Paris lun-ven, 10h samedi)
//    Colis dont l'étiquette a > 24 h (heuresMin) sans AUCUN événement autre
//    que DATA_RECEIVED (= étiquette créée, colis jamais remis à GLS).
//  controle = 'enlevement' (19h Paris lun-ven)
//    Étiquettes créées AUJOURD'HUI (il y a ≥ 2 h) toujours sans prise en charge
//    le soir = colis oubliés à l'enlèvement du jour.
//  controle = 'instance' (9h Paris lun-sam)
//    Colis pris en charge, non livrés, dont le dernier événement GLS est une
//    mise en instance (stocké au dépôt, adresse à compléter, non livré…) depuis
//    ≥ 24 h, ou SANS AUCUN nouvel événement depuis ≥ 48 h (96 h pour la Corse).
//    Rappel chaque jour tant que ce n'est pas réglé.
//  controle = 'remboursements' (8h30 Paris lun-sam)
//    Rappel Telegram des remboursements dus (table remboursements_suivi).
//    AUCUN paiement n'est déclenché : simple liste.
//
// Notes de commande (colonne instr) reconnues :
//   « SANS SCAN OK [n°…] »  étiquette en trop / colis volontairement gardé : ignoré.
//   « VERIF DEPOT [n°…] »   cas incertain : retiré du SMS, listé à part
//                            (Telegram, section « à vérifier au dépôt »).
//   « INSTANCE OK [n°…] »   instance connue et suivie : plus d'alerte instance/bloqué.
// Anti-doublon : table gls_alertes (1 ligne par type, colis et jour) ; un colis
//   déjà alerté aujourd'hui par un AUTRE contrôle n'est pas re-signalé le même jour.
// Canal : SMS OVH à Borhen (8 colis max) + copie complète Telegram + sms_historique.
//
// Body : { controle?, dryRun?: true, creneau?: true, heuresMin?: 24, jours?: 45, force?: true }
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { envoyerSMSOVH } from '../_shared/ovh-sms.ts';
import { appelInterne, refus } from '../_shared/controle-appelant.ts';
import { suivreColisGLS } from '../_shared/gls-suivi.ts';
import { analyserColis, numerosColis, exclusionSansScan, colisMarque, historiqueDe } from '../_shared/gls-analyse.ts';

const SB_URL = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const BORHEN_TEL = Deno.env.get('RAPPORT_TEL') || '+33744289321';

const sb = createClient(SB_URL, SB_SR_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// Libellés GLS d'une mise en instance (colis immobilisé en attente d'une action)
const RE_INSTANCE = /stored|address information|could not be delivered|not be delivered|not delivered|incident|refused|absent|instance|reportee|livraison report/i;

function jourParis(d = new Date()): string {
  return d.toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
}
function heureParis(): { h: number; m: number; jour: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour')?.value || '0') % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value || '0');
  const wd = parts.find((p) => p.type === 'weekday')?.value || '';
  const jour = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  return { h, m, jour };
}
// Minuit Paris d'une date YYYY-MM-DD (approx. : décalage courant) — repli si GLS ne donne pas la date de création.
function debutJourParisMs(ymd: string): number {
  const t = Date.parse(ymd + 'T00:00:00Z');
  if (isNaN(t)) return NaN;
  const dec = new Date(new Date(t).toLocaleString('en-US', { timeZone: 'Europe/Paris' })).getTime() - new Date(new Date(t).toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
  return t - dec;
}

async function envoyerTelegram(texte: string): Promise<boolean> {
  const token = Deno.env.get('TELEGRAM_TOKEN') || '', chat = Deno.env.get('TELEGRAM_CHAT_ID') || '';
  if (!token || !chat) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: texte.slice(0, 4000), disable_web_page_preview: true }),
    });
    return r.ok;
  } catch { return false; }
}

const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

// Créneaux des crons (2 crons UTC par créneau pour l'heure d'été ET d'hiver)
function dansCreneau(controle: string): boolean {
  const { h, jour } = heureParis();
  if (controle === 'sans-scan') return (jour >= 1 && jour <= 5 && h === 18) || (jour === 6 && h === 10);
  if (controle === 'enlevement') return jour >= 1 && jour <= 5 && h === 19;
  if (controle === 'instance') return jour >= 1 && jour <= 6 && h === 9;
  if (controle === 'remboursements') return jour >= 1 && jour <= 6 && h === 8;
  return false;
}

async function journaliser(type: string, msg: string, ok: boolean) {
  try {
    await sb.from('sms_historique').insert({
      id: 'sms_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      client: 'Borhen (gardien)', tel: BORHEN_TEL, type_sms: type, msg,
      statut: ok ? 'envoyé' : 'échec', date_sms: jourParis(),
      heure: new Date().toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }),
    });
  } catch (_e) { /* journal non bloquant */ }
}

// Réserve (anti-doublon), envoie SMS + Telegram, journalise.
async function alerter(type: string, lignesAlerte: any[], msg: string, texteComplet: string, force: boolean, resultat: any) {
  const aujourdhui = jourParis();
  const lignes = lignesAlerte.map((x) => ({ type, cle: x.trackId, jour: aujourdhui, cmd_id: x.cmdId, message: x.motif || null }));
  const { error: errRes } = force
    ? await sb.from('gls_alertes').upsert(lignes, { onConflict: 'type,cle,jour', ignoreDuplicates: true })
    : await sb.from('gls_alertes').insert(lignes);
  if (errRes && !force) { resultat.skipped = true; resultat.reason = 'alerte deja reservee : ' + errRes.message; return; }
  const ok = await envoyerSMSOVH(BORHEN_TEL, msg);
  resultat.envoye = ok;
  resultat.telegram = await envoyerTelegram(texteComplet);
  try { await sb.from('gls_alertes').update({ envoye: ok }).eq('type', type).eq('jour', aujourdhui).in('cle', lignesAlerte.map((x) => x.trackId)); } catch (_e) { /* */ }
  await journaliser(type === 'sans-scan' ? 'alerte-gls-scan' : 'alerte-gls-' + type, msg, ok);
}

// Colis déjà alertés aujourd'hui (tous contrôles confondus) → pas de doublon le même jour
async function dejaAlertesAujourdhui(cles: string[], typeCourant: string, force: boolean): Promise<Set<string>> {
  const s = new Set<string>();
  if (!cles.length) return s;
  const { data } = await sb.from('gls_alertes').select('cle, type').eq('jour', jourParis()).in('cle', cles);
  for (const r of data || []) if (!force || r.type !== typeCourant) s.add(r.cle);
  return s;
}

// ─── Contrôle 'remboursements' : liste simple, AUCUN paiement ─────────────
async function controleRemboursements(dryRun: boolean, resultat: any) {
  const { data, error } = await sb.from('remboursements_suivi').select('*').eq('statut', 'a_faire').order('echeance', { ascending: true });
  if (error) { resultat.ok = false; resultat.error = error.message; return; }
  const auj = jourParis();
  const lignes = (data || []).map((r: any) => ({ ...r, en_retard: r.echeance && r.echeance < auj }));
  const total = lignes.reduce((t: number, r: any) => t + Number(r.montant || 0), 0);
  const retard = lignes.filter((r: any) => r.en_retard);
  resultat.nb = lignes.length; resultat.total = Math.round(total * 100) / 100; resultat.nb_retard = retard.length; resultat.lignes = lignes;
  if (!lignes.length) return;
  const texte = `REMBOURSEMENTS A FAIRE (${lignes.length}, ${resultat.total} EUR, dont ${retard.length} en retard) :\n` +
    lignes.map((r: any) => `- ${r.cmd_id} ${r.client_initiales || ''} : ${r.montant} EUR, echeance ${r.echeance || '?'}${r.en_retard ? ' (RETARD)' : ''} | ${r.moyen || ''} | preuve : ${r.preuve || '-'}`).join('\n') +
    `\nAucun paiement automatique. Une fois fait : statut 'fait' + reference dans remboursements_suivi.`;
  resultat.telegram_texte = texte;
  if (dryRun) return;
  const { error: e2 } = await sb.from('gls_alertes').insert({ type: 'remboursements', cle: 'liste', jour: auj, message: `${lignes.length} a faire` });
  if (e2) { resultat.skipped = true; resultat.reason = 'deja envoye aujourd\'hui'; return; }
  resultat.telegram = await envoyerTelegram(texte);
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'OPTIONS' && !appelInterne(req)) return refus();
  const t0 = Date.now();
  let body: any = {};
  try { body = await req.json(); } catch { /* vide */ }
  const controle: string = ['enlevement', 'instance', 'remboursements'].includes(body.controle) ? body.controle : 'sans-scan';
  const dryRun = body.dryRun === true;
  const force = body.force === true;
  const heuresMin = Math.max(1, Number(body.heuresMin) || 24);
  const jours = Math.max(2, Math.min(90, Number(body.jours) || (controle === 'instance' ? 30 : 45)));

  if (body.creneau && !dansCreneau(controle)) {
    const { h, jour } = heureParis();
    return json({ ok: true, skipped: true, controle, reason: `hors creneau (jour ${jour}, ${h}h Paris)` });
  }

  const resultat: any = { ok: true, version: 'v2', controle, dryRun, jour: jourParis() };

  if (controle === 'remboursements') {
    await controleRemboursements(dryRun, resultat);
    resultat.duration_ms = Date.now() - t0;
    return json(resultat);
  }

  const limite = jourParis(new Date(Date.now() - jours * 86400000));
  let requete = sb.from('commandes')
    .select('id, statut, adresse, tracking_transporteur, gls_date_etiquette, gls_creation_at, instr')
    .eq('transporteur', 'GLS')
    .not('tracking_transporteur', 'is', null)
    .neq('statut', 'annulé');
  if (controle === 'enlevement') {
    const auj = jourParis();
    requete = requete.or(`gls_date_etiquette.eq.${auj},gls_creation_at.gte.${new Date(debutJourParisMs(auj)).toISOString()}`);
  } else {
    requete = requete.or(`gls_date_etiquette.gte.${limite},gls_creation_at.gte.${limite}`);
  }
  const { data: cmds, error } = await requete;
  if (error) return json({ ok: false, error: error.message }, 500);

  const tous: { trackId: string; cmd: any }[] = [];
  for (const c of cmds || []) for (const t of numerosColis(c.tracking_transporteur)) tous.push({ trackId: t, cmd: c });

  // Cache gls_colis : pris en charge (sans-scan / enlèvement) ou livrés (instance)
  const cache = new Map<string, any>();
  for (let i = 0; i < tous.length; i += 200) {
    const lot = tous.slice(i, i + 200).map((x) => x.trackId);
    const { data } = await sb.from('gls_colis').select('track_id, prise_en_charge_at, etat').in('track_id', lot);
    for (const r of data || []) cache.set(r.track_id, r);
  }

  const enAlerte: any[] = [];
  const aVerifier: any[] = [];
  const exclus: any[] = [];
  const erreurs: any[] = [];
  const pasEncore: any[] = [];
  const majCache: any[] = [];
  let ignoresCache = 0, verifies = 0;

  const file = tous.filter((x) => {
    const c = cache.get(x.trackId);
    if (controle === 'instance') { if (c && c.etat === 'livre') { ignoresCache++; return false; } return true; }
    if (c && c.prise_en_charge_at) { ignoresCache++; return false; }
    return true;
  });

  const worker = async () => {
    while (file.length) {
      const { trackId, cmd } = file.shift()!;
      if (controle !== 'instance') {
        const excl = exclusionSansScan(cmd.instr);
        if (excl === 'tout' || (Array.isArray(excl) && excl.includes(trackId))) { exclus.push({ trackId, cmdId: cmd.id, raison: 'SANS SCAN OK' }); continue; }
      } else if (colisMarque(cmd.instr, 'INSTANCE OK', trackId)) { exclus.push({ trackId, cmdId: cmd.id, raison: 'INSTANCE OK' }); continue; }
      verifies++;
      const r = await suivreColisGLS(trackId);
      if (!r.ok) { erreurs.push({ trackId, cmdId: cmd.id, erreur: r.erreur }); continue; }
      const a = analyserColis(trackId, r.data);
      if (a.priseEnCharge) majCache.push({ track_id: trackId, cmd_id: cmd.id, prise_en_charge_at: a.priseEnChargeAt, etat: a.etat, verifie_at: new Date().toISOString() });

      if (controle === 'instance') {
        if (!a.priseEnCharge || a.etat === 'livre' || a.livreExpediteurAt || a.etat === 'erreur') continue;
        const derMs = Date.parse(a.dernierEvenementAt || '');
        const ageH = isNaN(derMs) ? null : (Date.now() - derMs) / 3600000;
        const corse = /\b20\d{3}\b|\b2[AB]\d{3}\b/i.test(String(cmd.adresse || ''));
        const seuilBloque = corse ? 96 : 48;
        const instance = RE_INSTANCE.test(a.dernierLibelle || '');
        // Immobile : GLS re-scanne parfois chaque jour un colis stocké au même dépôt (le dernier
        // scan est récent, mais le colis n'avance pas). Durée depuis l'arrivée à ce dépôt.
        const hist = historiqueDe(r.data)
          .filter((ev: any) => String(ev?.StatusCode || ev?.Code || '').toUpperCase() !== 'DATA_RECEIVED') // la création d'étiquette n'est pas un séjour au dépôt
          .map((ev: any) => ({ lieu: String(ev?.LocationCode || ev?.Location || ''), t: Date.parse(ev?.Date || '') }))
          .filter((e: any) => !isNaN(e.t)).sort((x: any, y: any) => x.t - y.t);
        let immobileH: number | null = null;
        if (hist.length) {
          const lieuFin = hist[hist.length - 1].lieu;
          let k = hist.length - 1;
          while (k > 0 && hist[k - 1].lieu === lieuFin) k--;
          immobileH = (Date.now() - hist[k].t) / 3600000;
        }
        const ligne = { trackId, cmdId: cmd.id, statutCommande: cmd.statut, etatColis: a.etat, dernier: a.dernierLibelle, dernierAt: a.dernierEvenementAt, ageHeures: ageH === null ? null : Math.round(ageH), motif: '' };
        if (ageH !== null && instance && ageH >= 24) { ligne.motif = `en instance depuis ${Math.floor(Math.max(ageH, immobileH ?? 0) / 24)} j`; enAlerte.push(ligne); }
        else if (ageH !== null && ageH >= seuilBloque) { ligne.motif = `aucun scan depuis ${Math.floor(ageH / 24)} j`; enAlerte.push(ligne); }
        else if (immobileH !== null && immobileH >= seuilBloque && a.etat !== 'point_relais') { ligne.motif = `immobile au meme depot depuis ${Math.floor(immobileH / 24)} j`; enAlerte.push(ligne); }
        else pasEncore.push(ligne);
        continue;
      }

      if (a.priseEnCharge || a.etat === 'livre') continue;
      let creeMs = Date.parse(a.creationAt || '');
      if (isNaN(creeMs)) creeMs = Date.parse(cmd.gls_creation_at || '');
      if (isNaN(creeMs)) creeMs = debutJourParisMs(cmd.gls_date_etiquette || '');
      const ageH = isNaN(creeMs) ? null : (Date.now() - creeMs) / 3600000;
      const ligne = {
        trackId, cmdId: cmd.id, statutCommande: cmd.statut,
        etiquetteCreee: isNaN(creeMs) ? null : new Date(creeMs).toISOString(),
        ageHeures: ageH === null ? null : Math.round(ageH), ageJours: ageH === null ? null : Math.floor(ageH / 24),
        evenements: a.nbEvenements, dernier: a.dernierLibelle, motif: '',
      };
      const seuil = controle === 'enlevement' ? 2 : heuresMin;
      if (ageH !== null && ageH < seuil) { pasEncore.push(ligne); continue; }
      if (colisMarque(cmd.instr, 'VERIF DEPOT', trackId)) { aVerifier.push(ligne); continue; }
      ligne.motif = controle === 'enlevement' ? 'etiquette du jour non enlevee' : `${ligne.ageJours ?? '?'}j sans prise en charge`;
      enAlerte.push(ligne);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  enAlerte.sort((a, b) => (b.ageHeures ?? 0) - (a.ageHeures ?? 0) || a.trackId.localeCompare(b.trackId));

  const deja = await dejaAlertesAujourdhui(enAlerte.map((x) => x.trackId), controle, force);
  const aEnvoyer = enAlerte.filter((x) => !deja.has(x.trackId));

  const titre = controle === 'enlevement' ? 'ENLEVEMENT GLS: ' + aEnvoyer.length + ' colis etiquetes aujourd\'hui NON remis au chauffeur'
    : controle === 'instance' ? 'GLS BLOQUE: ' + aEnvoyer.length + ' colis en instance ou sans scan (48h)'
    : 'ALERTE GLS: ' + aEnvoyer.length + ' colis SANS prise en charge 24h apres l\'etiquette';
  const court = (x: any) => controle === 'instance' ? `${x.trackId} (${x.cmdId}, ${x.motif})` : `${x.trackId} (${x.cmdId}, ${controle === 'enlevement' ? 'auj.' : (x.ageJours ?? '?') + 'j'})`;
  const conseil = controle === 'instance' ? 'Appeler GLS/client. Ignorer: note "INSTANCE OK <n colis>".' : 'Verifier depot/chauffeur. Ignorer: note "SANS SCAN OK <n colis>".';
  const msg = aEnvoyer.length
    ? `${titre}: ${aEnvoyer.slice(0, 8).map(court).join(', ')}${aEnvoyer.length > 8 ? ` +${aEnvoyer.length - 8} autres` : ''}. ${conseil}`
    : '';
  const texteComplet = aEnvoyer.length
    ? `${titre} :\n` + aEnvoyer.map((x) => `- ${court(x)} | ${x.statutCommande}${controle === 'instance' ? ' | ' + (x.dernier || '') : ''}`).join('\n') +
      (aVerifier.length ? `\n\nA verifier au depot (hors SMS, note VERIF DEPOT) : ${aVerifier.length} colis : ${aVerifier.map((x) => x.trackId + ' (' + x.cmdId + ')').join(', ')}` : '') +
      `\n${conseil}`
    : '';

  Object.assign(resultat, {
    heuresMin, jours, colis_total: tous.length, ignores_cache: ignoresCache, verifies_api: verifies,
    nb_en_alerte: enAlerte.length, nb_deja_alertes_aujourdhui: deja.size, nb_a_envoyer: aEnvoyer.length,
    en_alerte: enAlerte, a_verifier_depot: aVerifier, exclus, erreurs_api: erreurs, pas_encore: pasEncore,
    sms: msg || null, telegram_texte: texteComplet || null,
  });
  if (dryRun) { resultat.duration_ms = Date.now() - t0; return json(resultat); }

  if (majCache.length) { try { await sb.from('gls_colis').upsert(majCache, { onConflict: 'track_id' }); } catch (_e) { /* non bloquant */ } }
  if (aEnvoyer.length) await alerter(controle, aEnvoyer, msg, texteComplet, force, resultat);
  resultat.duration_ms = Date.now() - t0;
  return json(resultat);
});
