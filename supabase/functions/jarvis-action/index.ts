// ════════════════════════════════════════════════════════════════════
// Edge Function : jarvis-action (v1 — 27/10/2026)
// ════════════════════════════════════════════════════════════════════
// Porte d'entrée RÉSERVÉE À JARVIS (MAXI BRAIN, mini-PC de Borhen) pour quelques actions, toujours en 2 temps :
//   1. { ..., confirme: false } → APERÇU : contrôle, lecture, aperçu de GLS (dryRun) — RIEN n'est écrit ;
//   2. { ..., confirme: true }  → exécution, seulement après le « Confirmer » de Borhen dans JARVIS.
// Actions (liste fermée, logique dans _shared/jarvis-action-logique.ts) :
//   gls_etiquette { cmdId }              → étiquette GLS (passe par gls-create-shipment : anti-doublon, règles colis)
//   gls_retour    { cmdId, poids? }      → retour GLS (gls-create-shipment action pickReturn)
//   planifier     { cmdId, date }        → date de livraison de la commande (rien d'autre)
//   sav           { cmdId, type, date, produit_a_livrer, produit_a_reprendre, motif } → nouvelle commande #SAV (échange,
//                                         reprise, oubli ; JAMAIS de remboursement : c'est de l'argent → appli, admin)
//   litige        { cmdId, litige_type?, litige_statut?, litige_num?, litige_description? } → dossier litige GLS
// Hors liste : suppression, paiement, prix, SMS, autres tables.
// Appelant : en-tête x-jarvis-secret = secret JARVIS_ACTION_SECRET (dédié, révocable en le changeant). Aucun autre accès.
// Réponses : jamais de nom, téléphone, e-mail ni adresse complète (code postal et ville seulement) ; PDF non renvoyé.
// Déploiement : npx supabase functions deploy jarvis-action --project-ref jmvfjtnmebstkzcfnlgp --no-verify-jwt --use-api
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { apercuCommande, avantLitige, champsLitige, construireSav, controlerCommande, controlerDemande, egal, type Demande } from '../_shared/jarvis-action-logique.ts';

const SB_URL = Deno.env.get('SUPABASE_URL') || '';
const SECRET_JARVIS = Deno.env.get('JARVIS_ACTION_SECRET') || '';
function cleServeur(): string {
  const sr = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (sr.startsWith('sb_secret_')) return sr;
  try { for (const v of Object.values(JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'))) if (typeof v === 'string' && v.startsWith('sb_secret_')) return v; } catch { /* */ }
  return '';
}
const CLE = cleServeur();
const sb = createClient(SB_URL, CLE, { auth: { autoRefreshToken: false, persistSession: false } });
const H = { 'Content-Type': 'application/json' };
const rep = (code: number, o: unknown) => new Response(JSON.stringify(o), { status: code, headers: H });

/** Appel interne de gls-create-shipment (contrôle d'appelant : clé secrète du projet). */
async function gls(corps: Record<string, unknown>) {
  const r = await fetch(`${SB_URL}/functions/v1/gls-create-shipment`, { method: 'POST', headers: { ...H, Authorization: 'Bearer ' + CLE, apikey: CLE }, body: JSON.stringify(corps) });
  let j: any = null; try { j = await r.json(); } catch { /* */ }
  return { http: r.status, j };
}
/** Résumé d'une réponse GLS sans donnée client ni PDF. */
function resumeGls(j: any) {
  const p = j?.payload || {}; const s = p?.Shipment || p?.shipment || {};
  const unites = s?.ShipmentUnit || s?.shipmentUnit || [];
  return { colis: Array.isArray(unites) ? unites.length : null, poids: Array.isArray(unites) ? unites.map((u: any) => Number(u?.Weight ?? u?.weight) || null) : null,
    suivis: Array.isArray(j?.parcels) ? j.parcels.map((x: any) => x?.trackId || x?.parcelNumber).filter(Boolean) : j?.trackId ? [j.trackId] : [] };
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return rep(405, { ok: false, erreur: 'POST seulement' });
  if (!SECRET_JARVIS || !egal(req.headers.get('x-jarvis-secret') || '', SECRET_JARVIS)) return rep(401, { ok: false, erreur: 'refusé' });
  if (!CLE) return rep(503, { ok: false, erreur: 'clé serveur absente' });
  let d: Demande & { confirme?: boolean }; try { d = await req.json(); } catch { return rep(400, { ok: false, erreur: 'JSON invalide' }); }
  const confirme = d.confirme === true;
  const forme = controlerDemande(d); if (forme) return rep(422, { ok: false, erreur: forme });

  const { data: c } = await sb.from('commandes').select('*').eq('id', d.cmdId).maybeSingle();
  const fond = controlerCommande(d, c); if (fond) return rep(422, { ok: false, erreur: fond });
  const base = { ok: true, action: d.action, confirme, commande: apercuCommande(c as any) };

  try {
    if (d.action === 'gls_etiquette') {
      const r = await gls({ cmdId: d.cmdId, dryRun: !confirme });
      if (!r.j?.ok) return rep(r.http === 409 ? 409 : 502, { ok: false, erreur: 'GLS : ' + String(r.j?.error || r.j?.erreur || 'refus (HTTP ' + r.http + ')').slice(0, 200) });
      return rep(200, { ...base, gls: resumeGls(r.j), fait: confirme });
    }
    if (d.action === 'gls_retour') {
      const r = await gls({ action: 'pickReturn', cmdId: d.cmdId, poids: d.poids ?? 15, dryRun: !confirme });
      if (!r.j?.ok) return rep(502, { ok: false, erreur: 'GLS : ' + String(r.j?.error || 'refus (HTTP ' + r.http + ')').slice(0, 200) });
      return rep(200, { ...base, gls: resumeGls(r.j), poids: d.poids ?? 15, fait: confirme });
    }
    if (d.action === 'planifier') {
      if (!confirme) return rep(200, { ...base, avant: String((c as any).date_livraison || ''), apres: d.date });
      const { error } = await sb.from('commandes').update({ date_livraison: d.date, updated_at: new Date().toISOString() }).eq('id', d.cmdId);
      if (error) return rep(502, { ok: false, erreur: 'écriture refusée par la base' });
      return rep(200, { ...base, avant: String((c as any).date_livraison || ''), apres: d.date, fait: true });
    }
    if (d.action === 'sav') {
      const sav = construireSav(d, c as any);
      const visible = { id: sav.id, produit: sav.produit, origine: sav.origine, date_livraison: sav.date_livraison, instr: sav.instr };
      if (!confirme) return rep(200, { ...base, sav: visible });
      const { data: existe } = await sb.from('commandes').select('id').eq('id', sav.id).maybeSingle();
      if (existe) return rep(409, { ok: false, erreur: 'numéro de SAV déjà pris : recommence dans une seconde' });
      const { error } = await sb.from('commandes').insert(sav);
      if (error) return rep(502, { ok: false, erreur: 'création du SAV refusée par la base' });
      return rep(200, { ...base, sav: visible, fait: true });
    }
    if (d.action === 'litige') {
      const p = champsLitige(d);
      // Avant / après complet, description comprise (réserve Codex sur la PR JARVIS #214, 27/10) : Borhen voit ce qu'il remplace.
      const avant = avantLitige(c as any);
      if (!confirme) return rep(200, { ...base, litige: { avant, apres: p } });
      const { error } = await sb.from('commandes').update(p).eq('id', d.cmdId);
      if (error) return rep(502, { ok: false, erreur: 'écriture refusée par la base' });
      return rep(200, { ...base, litige: { avant, apres: p }, fait: true });
    }
  } catch (_e) { return rep(500, { ok: false, erreur: 'erreur interne' }); }
  return rep(422, { ok: false, erreur: 'action non autorisée' });
});
