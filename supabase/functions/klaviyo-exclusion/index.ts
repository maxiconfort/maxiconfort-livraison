// ════════════════════════════════════════════════════════════════════
// Edge Function : klaviyo-exclusion (v2 — 28/09/2026 soir)
// ════════════════════════════════════════════════════════════════════
// Tient à jour la liste Klaviyo « Maxiconfort - SAV ou litige en cours »
// (KLAVIYO_LISTE_LITIGES, défaut VDLBXr). Les automatisations « relance panier »
// et « J+30 » excluent cette liste ; Klaviyo revérifie les filtres d'une
// automatisation AVANT CHAQUE ENVOI, donc un ajout à la liste bloque le prochain e-mail.
//
// Modes (body) :
//   { cmdId }        appelé par le déclencheur de la base à chaque changement d'une
//                    commande (litige, note, statut, e-mail, téléphone, livraison GLS)
//                    ou d'un remboursement : traite tout le « client » (toutes ses
//                    commandes reliées par e-mail OU téléphone, donc ses 2 adresses).
//   { reconcile }    toutes les 15 min (cron) : réconciliation complète de la liste.
//   { test: {rows, remboursements} }  simulation sur des données fournies (rien écrit).
//   { dryRun }       calcule sans rien écrire.
//
// Dossier OUVERT (pour une commande) :
//   note « DOSSIER CLOS » → fermé (forçage manuel) ; note « DOSSIER OUVERT » → ouvert ;
//   litige non clos ; SAV (#SAV…) ni livré ni annulé ; remboursement à faire ou conditionnel ;
//   note « PAS D AVIS » ET (commande ni livrée ni annulée, ou livraison GLS partielle/retour).
// La note « PAS D AVIS » n'est JAMAIS modifiée ici (lecture seule) : elle reste définitive
// pour les demandes d'avis (sms-avis), indépendamment de la sortie de la liste Klaviyo.
//
// Sécurités : un client dont un dossier est ouvert reçoit un profil Klaviyo s'il n'en a pas
// (création sans abonnement), pour être exclu d'avance. Réconciliation : plus de 5 retraits
// d'un coup = anomalie → rien n'est retiré, alerte. 2 échecs consécutifs de réconciliation →
// les automatisations « panier » et « J+30 » passent en « manuel » (plus aucun envoi
// automatique) + UNE seule alerte (SMS + Telegram). v2 : AUCUNE remise en service automatique
// (le devenir des e-mails mis en file pendant le mode manuel n'est pas vérifiable par l'API) ;
// reprise uniquement par { reprendre: true, confirmeFileControlee: true } après contrôle de la file.
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { envoyerSMSOVH } from '../_shared/ovh-sms.ts';
import { appelInterne, refus } from '../_shared/controle-appelant.ts';

const SB_URL = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const KL_KEY = Deno.env.get('KLAVIYO_API_KEY') || '';
const LISTE = Deno.env.get('KLAVIYO_LISTE_LITIGES') || 'VDLBXr';
const BORHEN_TEL = Deno.env.get('RAPPORT_TEL') || '+33744289321';
const RE_FLOWS_PROTEGES = /panier|j\s*\+\s*30/i; // automatisations à suspendre en cas de panne
const MAX_RETRAITS = 5;

const sb = createClient(SB_URL, SB_SR_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

const LITIGE_FERMES = ['indemnise', 'refuse', 'clos', 'close', 'cloture', 'resolu', 'termine', 'ferme', 'gagne', 'perdu'];
const norm = (s: any) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const tel9 = (s: any) => { const d = String(s || '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; };
const email = (s: any) => { const e = String(s || '').trim().toLowerCase(); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : ''; };

export function dossierOuvert(r: any, rembOuverts: Set<string>, structure = false): string | null {
  const note = norm(r.instr);
  if (/dossier\s+clos/.test(note)) return null;
  if (/dossier\s+ouvert/.test(note)) return 'note DOSSIER OUVERT';
  const ls = norm(r.litige_statut).trim();
  if ((r.litige_type || ls) && ls !== '' && !LITIGE_FERMES.some((f) => ls.startsWith(f))) return 'litige ' + (r.litige_type || '') + ' (' + ls + ')';
  if (r.litige_type && ls === '') return 'litige ' + r.litige_type;
  if (/^#?sav/i.test(String(r.id || '')) && r.statut !== 'livré' && r.statut !== 'annulé') return 'SAV ' + r.statut;
  if (rembOuverts.has(String(r.id || '').toUpperCase())) return 'remboursement a faire';
  const pasAvis = /\b(pas d ?avis|pas avis|sans avis|no avis)\b/.test(note.replace(/[^a-z0-9]+/g, ' '));
  if (pasAvis && (r.gls_livraison_etat === 'partiel' || r.gls_livraison_etat === 'retour')) return 'PAS D AVIS + livraison GLS ' + r.gls_livraison_etat;
  // Dossier signalé UNIQUEMENT par la note (ni litige, ni SAV, ni remboursement suivi) : « livré » n'est
  // pas une preuve de clôture (faux « livré » d'avant gls-sync v15, ex. #1690) → reste ouvert jusqu'à
  // la note « DOSSIER CLOS ». Les dossiers structurés (litige, SAV, remboursement) se ferment seuls.
  if (pasAvis && !structure && r.statut !== 'annulé') return 'PAS D AVIS (fermer avec la note DOSSIER CLOS)';
  return null;
}

// Regroupe les commandes en « clients » : même e-mail OU même téléphone (union-find)
export function grouperClients(rows: any[]): Map<string, any[]> {
  const parent = new Map<string, string>();
  const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
  const add = (x: string) => { if (!parent.has(x)) parent.set(x, x); };
  const union = (a: string, b: string) => { add(a); add(b); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const r of rows) {
    const k = 'c:' + r.id; add(k);
    const e = email(r.email), t = tel9(r.tel);
    if (e) union(k, 'e:' + e);
    if (t) union(k, 't:' + t);
  }
  const g = new Map<string, any[]>();
  for (const r of rows) { const root = find('c:' + r.id); (g.get(root) || g.set(root, []).get(root)!).push(r); }
  return g;
}

async function kl(path: string, method = 'GET', body?: any): Promise<{ status: number; j: any }> {
  const r = await fetch('https://a.klaviyo.com/api/' + path, {
    method, headers: { Authorization: 'Klaviyo-API-Key ' + KL_KEY, revision: '2025-07-15', accept: 'application/vnd.api+json', 'content-type': 'application/vnd.api+json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { /* vide */ }
  if (r.status >= 500 || r.status === 401 || r.status === 403 || r.status === 429) throw new Error(`Klaviyo ${method} ${path.split('?')[0]} -> HTTP ${r.status}`);
  return { status: r.status, j };
}

async function profilsDe(emails: string[], tels: string[], creer: boolean): Promise<{ ids: Set<string>; crees: number }> {
  const ids = new Set<string>(); let crees = 0;
  for (const e of emails) {
    const p = await kl('profiles/?filter=' + encodeURIComponent(`equals(email,"${e}")`));
    let id = p.j?.data?.[0]?.id;
    if (!id && creer) {
      const c = await kl('profiles/', 'POST', { data: { type: 'profile', attributes: { email: e, properties: { source_creation: 'exclusion SAV/litige (aucun abonnement)' } } } });
      id = c.j?.data?.id || c.j?.errors?.[0]?.meta?.duplicate_profile_id;
      if (id) crees++;
    }
    if (id) ids.add(id);
  }
  for (const t of tels) {
    const p = await kl('profiles/?filter=' + encodeURIComponent(`equals(phone_number,"+33${t}")`));
    const id = p.j?.data?.[0]?.id; if (id) ids.add(id);
  }
  return { ids, crees };
}

async function membresListe(): Promise<Set<string>> {
  const s = new Set<string>(); let url: string | null = `lists/${LISTE}/profiles/?page[size]=100`;
  while (url) { const r = await kl(url); for (const p of r.j?.data || []) s.add(p.id); url = r.j?.links?.next ? String(r.j.links.next).replace('https://a.klaviyo.com/api/', '') : null; }
  return s;
}

async function modifierListe(ajouts: string[], retraits: string[]) {
  if (ajouts.length) { const r = await kl(`lists/${LISTE}/relationships/profiles/`, 'POST', { data: ajouts.map((id) => ({ type: 'profile', id })) }); if (r.status >= 300) throw new Error('ajout liste HTTP ' + r.status); }
  if (retraits.length) { const r = await kl(`lists/${LISTE}/relationships/profiles/`, 'DELETE', { data: retraits.map((id) => ({ type: 'profile', id })) }); if (r.status >= 300) throw new Error('retrait liste HTTP ' + r.status); }
}

let PREFIXE = ''; // « [TEST] » pendant les tests de panne simulée
async function alerter(texte0: string, sms: boolean) {
  const texte = PREFIXE + texte0;
  const token = Deno.env.get('TELEGRAM_TOKEN') || '', chat = Deno.env.get('TELEGRAM_CHAT_ID') || '';
  if (token && chat) { try { await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: texte }) }); } catch { /* */ } }
  if (sms) {
    const ok = await envoyerSMSOVH(BORHEN_TEL, texte.slice(0, 300));
    try { await sb.from('sms_historique').insert({ id: 'sms_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), client: 'Borhen (gardien)', tel: BORHEN_TEL, type_sms: 'alerte-klaviyo', msg: texte.slice(0, 300), statut: ok ? 'envoyé' : 'échec', date_sms: new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' }) }); } catch { /* */ }
  }
}

async function chargerDonnees(test: any) {
  if (test) {
    const rt = new Set<string>((test.remboursements || []).map((x: string) => x.toUpperCase()));
    return { rows: test.rows || [], remb: rt, rembTous: new Set<string>([...rt, ...(test.remboursementsClos || []).map((x: string) => x.toUpperCase())]) };
  }
  const rows: any[] = []; let from = 0;
  while (true) {
    const { data, error } = await sb.from('commandes').select('id, email, tel, statut, litige_type, litige_statut, instr, gls_livraison_etat').range(from, from + 999);
    if (error) throw new Error('lecture commandes : ' + error.message);
    rows.push(...(data || [])); if (!data || data.length < 1000) break; from += 1000;
  }
  const { data: rb, error: e2 } = await sb.from('remboursements_suivi').select('cmd_id, statut');
  if (e2) throw new Error('lecture remboursements : ' + e2.message);
  const remb = new Set<string>(), rembTous = new Set<string>();
  for (const r of rb || []) for (const m of String(r.cmd_id).matchAll(/#\s?(SAV\d+|\d{3,6})\b/gi)) {
    const avant = String(r.cmd_id).substring(Math.max(0, (m.index || 0) - 6), m.index).toLowerCase();
    if (/site\s*$/.test(avant)) continue;
    rembTous.add('#' + m[1].toUpperCase());
    if (r.statut === 'a_faire' || r.statut === 'conditionnel') remb.add('#' + m[1].toUpperCase());
  }
  return { rows, remb, rembTous };
}

function analyser(rows: any[], remb: Set<string>, rembTous: Set<string>) {
  const clients: any[] = [];
  for (const [, cmds] of grouperClients(rows)) {
    // « structuré » = le client a un litige, un SAV ou un remboursement suivi : ces signaux se ferment seuls
    const structure = cmds.some((r) => r.litige_type || /^#?sav/i.test(String(r.id || '')) || rembTous.has(String(r.id || '').toUpperCase()));
    const raisons = cmds.map((r) => ({ id: r.id, raison: dossierOuvert(r, remb, structure) })).filter((x) => x.raison);
    clients.push({
      cmds: cmds.map((r) => r.id), ouvert: raisons.length > 0, raisons,
      emails: [...new Set(cmds.map((r) => email(r.email)).filter(Boolean))], tels: [...new Set(cmds.map((r) => tel9(r.tel)).filter(Boolean))],
    });
  }
  return clients;
}

async function etat(): Promise<any> {
  const { data } = await sb.from('klaviyo_sync_etat').select('*').eq('id', 1).maybeSingle();
  return data || { id: 1, echecs_consecutifs: 0, flows_suspendus: [] };
}
async function majEtat(p: any) { await sb.from('klaviyo_sync_etat').upsert({ id: 1, ...p, maj_at: new Date().toISOString() }); }

async function flowsProteges(filtre?: string): Promise<any[]> {
  const r = await kl('flows/?fields[flow]=name,status&page[size]=50');
  // filtre : réservé aux tests (automatisation de test dédiée) ; sinon relance panier + J+30
  const re = filtre ? new RegExp(filtre, 'i') : RE_FLOWS_PROTEGES;
  return (r.j?.data || []).filter((f: any) => re.test(f.attributes.name) && (filtre ? true : !/^test/i.test(f.attributes.name)));
}
async function statutFlow(id: string, status: string) { return (await kl(`flows/${id}/`, 'PATCH', { data: { type: 'flow', id, attributes: { status } } })).status; }

Deno.serve(async (req: Request) => {
  if (req.method !== 'OPTIONS' && !appelInterne(req)) return refus();
  const t0 = Date.now();
  let body: any = {}; try { body = await req.json(); } catch { /* vide */ }
  const dryRun = body.dryRun === true || !!body.test;
  PREFIXE = body.simulerEchec || body.filtreFlowsTest ? '[TEST] ' : '';
  const res: any = { ok: true, version: 'v2', mode: body.reconcile ? 'reconcile' : body.cmdId ? 'commande' : body.test ? 'test' : '?', dryRun };
  try {
    if (!KL_KEY && !body.test) throw new Error('secret KLAVIYO_API_KEY absent');
    if (body.simulerEchec) throw new Error('echec simule (test)');
    const { rows, remb, rembTous } = await chargerDonnees(body.test);
    const clients = analyser(rows, remb, rembTous);

    // Vérification SERVEUR qu'un contrôle programmé (tâche Claude, qui ne tourne que si l'app est
    // ouverte) a bien laissé sa trace dans gls_alertes (type 'klaviyo-controle', cle '<jour>-<etape>').
    // Sinon : SMS + Telegram avec la procédure manuelle. Ne fait rien un autre jour que <jour>.
    if (body.verifControle) {
      const { jour, etape } = body.verifControle;
      const auj = new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
      if (auj !== jour) return json({ ...res, mode: 'verif', info: 'autre jour, rien a faire' });
      const { data } = await sb.from('gls_alertes').select('cle').eq('type', 'klaviyo-controle').eq('cle', `${jour}-${etape}`).limit(1);
      if (data && data.length) return json({ ...res, mode: 'verif', trace: true });
      const court = etape === 'demarre'
        ? "KLAVIYO : le controle de 9h n'a PAS tourne (app Claude fermee ?). Ouvre l'app Claude et ecris : controle Klaviyo. Les 4 relances restent en manuel, rien ne part."
        : "KLAVIYO : le controle de 9h n'est PAS termine. Ouvre l'app Claude et ecris : controle Klaviyo. Les relances restent en manuel.";
      await alerter(court, true);
      await alerter("PROCEDURE MANUELLE KLAVIYO (si l'app Claude ne peut pas tourner) :\n1. Klaviyo > Parametres > Facturation : le compteur d'e-mails doit etre a 0 sur 500.\n2. Klaviyo > Flux : Panier, Bienvenue, J+30 et J+2 doivent etre en « Manuel ». Si l'un est « Actif », le remettre en Manuel.\n3. NE RIEN remettre en « Actif » et n'envoyer aucun message de la file.\n4. Rouvrir l'app Claude des que possible pour les tests.", false);
      return json({ ...res, mode: 'verif', trace: false, alerte: true });
    }

    // Reprise EXPLICITE après contrôle de la file d'attente (jamais automatique)
    if (body.reprendre) {
      const e = await etat();
      const suspendus: string[] = e.flows_suspendus || [];
      if (e.derniere_erreur) return json({ ...res, ok: false, error: 'synchronisation toujours en echec : reprise refusee' });
      if (body.confirmeFileControlee !== true) return json({ ...res, ok: false, error: 'confirmeFileControlee:true requis (file d\'attente controlee)' });
      const fait: any[] = [];
      for (const id of suspendus) fait.push({ id, http: await statutFlow(id, 'live') });
      await majEtat({ flows_suspendus: [], echecs_consecutifs: 0 });
      await alerter(`KLAVIYO : ${fait.length} relance(s) remise(s) en service apres controle de la file d'attente.`, false);
      return json({ ...res, mode: 'reprise', repris: fait });
    }

    if (body.test) {
      res.clients = clients.map((c) => ({ cmds: c.cmds, ouvert: c.ouvert, raisons: c.raisons, nb_emails: c.emails.length, nb_tels: c.tels.length }));
      return json(res);
    }

    if (body.cmdId) {
      const c = clients.find((x) => x.cmds.includes(body.cmdId));
      if (!c) return json({ ...res, info: 'commande introuvable' });
      res.ouvert = c.ouvert; res.raisons = c.raisons; res.nb_commandes_client = c.cmds.length;
      if (!c.emails.length && !c.tels.length) return json({ ...res, info: 'ni e-mail ni telephone : rien a exclure dans Klaviyo' });
      const { ids, crees } = await profilsDe(c.emails, c.tels, c.ouvert && !dryRun);
      const membres = await membresListe();
      const ajouts = c.ouvert ? [...ids].filter((id) => !membres.has(id)) : [];
      const retraits = c.ouvert ? [] : [...ids].filter((id) => membres.has(id));
      res.profils = ids.size; res.crees = crees; res.ajouts = ajouts.length; res.retraits = retraits.length;
      if (!dryRun) await modifierListe(ajouts, retraits);
      res.duration_ms = Date.now() - t0;
      return json(res);
    }

    if (body.reconcile) {
      const voulus = new Set<string>(); let crees = 0;
      for (const c of clients.filter((x) => x.ouvert)) { const p = await profilsDe(c.emails, c.tels, !dryRun); p.ids.forEach((i) => voulus.add(i)); crees += p.crees; }
      const membres = await membresListe();
      const ajouts = [...voulus].filter((id) => !membres.has(id));
      const retraits = [...membres].filter((id) => !voulus.has(id));
      Object.assign(res, { clients_ouverts: clients.filter((x) => x.ouvert).length, profils_voulus: voulus.size, membres: membres.size, ajouts: ajouts.length, retraits: retraits.length, crees });
      if (retraits.length > MAX_RETRAITS) {
        res.anomalie = `${retraits.length} retraits d'un coup (> ${MAX_RETRAITS}) : rien retire`;
        if (!dryRun) { await modifierListe(ajouts, []); await alerter(`KLAVIYO : anomalie, ${retraits.length} clients sortiraient d'un coup de la liste SAV/litige. Rien retire, a verifier.`, false); }
      } else if (!dryRun) await modifierListe(ajouts, retraits);
      if (!dryRun) {
        const e = await etat();
        const suspendus: string[] = e.flows_suspendus || [];
        // v2 (28/09 soir) : PAS de remise en service automatique. Test du 28/09 : le devenir des
        // e-mails mis en file pendant le mode « manuel » n'est pas vérifiable par l'API → on laisse
        // les relances suspendues jusqu'à un contrôle de la file et une reprise explicite ({reprendre}).
        if (suspendus.length && e.derniere_erreur) {
          await alerter(`KLAVIYO : synchronisation SAV/litige retablie. Les ${suspendus.length} relance(s) RESTENT SUSPENDUES jusqu'au controle de la file d'attente (aucune reprise automatique).`, false);
        }
        res.flows_suspendus = suspendus;
        await majEtat({ echecs_consecutifs: 0, flows_suspendus: suspendus, dernier_ok: new Date().toISOString(), derniere_erreur: null });
      }
      res.duration_ms = Date.now() - t0;
      return json(res);
    }
    return json({ ok: false, error: 'mode inconnu' }, 400);
  } catch (err) {
    const msg = String((err as any)?.message || err);
    res.ok = false; res.error = msg;
    if (body.reconcile && !body.dryRun) {
      try {
        const e = await etat();
        const n = (e.echecs_consecutifs || 0) + 1;
        const suspendus: string[] = e.flows_suspendus || [];
        if (n >= 2 && !suspendus.length && !body.simulerSansSuspension) {
          try {
            const fl = (await flowsProteges(body.filtreFlowsTest)).filter((f: any) => f.attributes.status === 'live');
            for (const f of fl) if ((await statutFlow(f.id, 'manual')) < 300) suspendus.push(f.id);
            res.flows_suspendus = suspendus;
            await alerter(`KLAVIYO : relances panier et J+30 SUSPENDUES (mode manuel) : la liste des clients en SAV/litige ne se met plus a jour (${msg.slice(0, 60)}). Aucune reprise automatique. Avant de les relancer : controler dans Klaviyo les e-mails en attente de revue (annuler ceux des clients en litige), puis demander la reprise.`, true);
          } catch (e2) {
            await alerter(`KLAVIYO : synchronisation SAV/litige en echec (${n} fois) ET suspension impossible (${String((e2 as any)?.message || e2).slice(0, 60)}). Suspendre les relances a la main.`, true);
          }
        }
        // 1er échec : silencieux (nouvel essai dans 15 min) ; une seule alerte, au moment de la suspension.
        await majEtat({ echecs_consecutifs: n, flows_suspendus: suspendus, derniere_erreur: msg.slice(0, 300) });
      } catch { /* */ }
    }
    // échec d'une exclusion immédiate ({cmdId}) : pas d'alerte (la réconciliation de 15 min la rattrape
    // et c'est elle qui suspend les relances si la panne dure).
    res.duration_ms = Date.now() - t0;
    return json(res, 200);
  }
});
