// ════════════════════════════════════════════════════════════════════
// Edge Function : jarvis-action (v2 — 30/10/2026)
// ════════════════════════════════════════════════════════════════════
// Porte d'entrée RÉSERVÉE À JARVIS (MAXI BRAIN, mini-PC de Borhen). Décision de Borhen du 30/10 : « autorisation totale sur
// commandes et stock », confirmation vocale en deux temps, graduée par NIVEAU (logique dans _shared/jarvis-action-logique.ts) :
//   N1 lecture    : lire_commande, lister_commandes, lire_stock — exécutées directement ;
//   N2 réversible : creer_commande (depuis un mail), modifier_commande, planifier, deplacer, changer_statut, sav, gls_etiquette,
//                   gls_retour, litige, stock_entree, stock_chargement, stock_retour_depot — aperçu puis exécution ;
//   N3 critique   : creer_commande (dictée), annuler_commande, supprimer_commande, modifier_prix, envoyer_sms, marquer_livre,
//                   stock_correction — aperçu puis exécution, confirmation à chaque fois côté JARVIS.
// Toujours en 2 temps pour N2/N3 : { ..., confirme:false } → APERÇU (rien n'est écrit) ; { ..., confirme:true } → exécution.
// Hors liste, toujours : encaissement (marquer payé, montant encaissé, remboursement), Shopify, TikTok, tables secrètes.
// Appelant : en-tête x-jarvis-secret = secret JARVIS_ACTION_SECRET (dédié, révocable en le changeant). Aucun autre accès.
// Réponses : jamais de nom complet, téléphone, e-mail ni adresse complète (code postal et ville seulement) ; PDF non renvoyé.
// Les compteurs journaliers (150 / jour, 20 N3, 30 SMS) et le « oui, toujours » sont tenus côté JARVIS (livraison-actions-locaux.js).
// Déploiement : npx supabase functions deploy jarvis-action --project-ref jmvfjtnmebstkzcfnlgp --no-verify-jwt --use-api
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { VERSION, alerteCorrectionStock, apercuCommande, avantLitige, champsAnnulation, champsLitige, champsModification, champsPlanification, champsPrix, construireCommande, construireSav,
  controlerCommande, controlerDemande, egal, entreeStock, estimerStock, ficheCommande, lignesCommande, mouvementCamion, niveauDe, prochainNumero, telMasque, STATUTS_TERMINES, type Catalogue, type Demande } from '../_shared/jarvis-action-logique.ts';

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
const rep = (code: number, o: unknown) => new Response(JSON.stringify({ version: VERSION, ...(o as object) }), { status: code, headers: H });

/** Appel interne d'une autre Edge Function (contrôle d'appelant : clé secrète du projet). */
async function interne(nom: string, corps: Record<string, unknown>) {
  const r = await fetch(`${SB_URL}/functions/v1/${nom}`, { method: 'POST', headers: { ...H, Authorization: 'Bearer ' + CLE, apikey: CLE }, body: JSON.stringify(corps) });
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
async function catalogue(): Promise<Catalogue> {
  const { data } = await sb.from('produits').select('id, nom, prix, actif, ancienne_offre');
  const m: Catalogue = new Map(); for (const p of data || []) m.set(String(p.id), { id: String(p.id), nom: String(p.nom || ''), prix: Number(p.prix) || 0, actif: p.actif !== false, ancienne_offre: !!p.ancienne_offre });
  return m;
}
const ecritureRefusee = (e: unknown) => rep(502, { ok: false, erreur: 'écriture refusée par la base' + (e && (e as any).code ? ' (' + (e as any).code + ')' : '') });

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return rep(405, { ok: false, erreur: 'POST seulement' });
  if (!SECRET_JARVIS || !egal(req.headers.get('x-jarvis-secret') || '', SECRET_JARVIS)) return rep(401, { ok: false, erreur: 'refusé' });
  if (!CLE) return rep(503, { ok: false, erreur: 'clé serveur absente' });
  let d: Demande & { confirme?: boolean }; try { d = await req.json(); } catch { return rep(400, { ok: false, erreur: 'JSON invalide' }); }
  const confirme = d.confirme === true;
  const forme = controlerDemande(d); if (forme) return rep(422, { ok: false, erreur: forme });
  const niveau = niveauDe(d);

  let c: Record<string, unknown> | null = null;
  if (d.cmdId) { const { data } = await sb.from('commandes').select('*').eq('id', d.cmdId).maybeSingle(); c = data as any; }
  const fond = controlerCommande(d, c); if (fond) return rep(422, { ok: false, erreur: fond });
  const base: Record<string, unknown> = { ok: true, action: d.action, niveau, confirme, ...(c ? { commande: apercuCommande(c) } : {}) };

  try {
    // ── N1 : lectures ──────────────────────────────────────────────────────────────────────────────────────────────
    if (d.action === 'lire_commande') return rep(200, { ...base, fiche: ficheCommande(c!) });
    if (d.action === 'lister_commandes') {
      let q = sb.from('commandes').select('id, produit, statut, transporteur, date_livraison, adresse, tracking_transporteur, livreur, created_at').limit(d.limite || 30);
      if (d.date) q = q.eq('date_livraison', d.date);
      if (d.statut) q = q.eq('statut', d.statut); else if (!d.date) q = q.not('statut', 'in', '(' + STATUTS_TERMINES.map((s) => '"' + s + '"').join(',') + ')');
      if (d.livreur) q = q.eq('transporteur', d.livreur);
      const { data, error } = await q.order('date_livraison', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false });
      if (error) return rep(502, { ok: false, erreur: 'lecture refusée par la base' });
      return rep(200, { ...base, total: (data || []).length, commandes: (data || []).map((x: any) => ({ ...apercuCommande(x), livreur: String(x.livreur || '') })) });
    }
    if (d.action === 'lire_stock') {
      const cat = await catalogue(); const voulu = d.produit ? String(d.produit).toLowerCase() : '';
      const produits = [...cat.values()].filter((p) => p.actif && !p.ancienne_offre && (!voulu || p.id.toLowerCase() === voulu || p.nom.toLowerCase().includes(voulu)));
      if (!produits.length) return rep(404, { ok: false, erreur: 'produit inconnu au catalogue' });
      const { data: cpt } = await sb.from('stock_comptage').select('id, fin').eq('statut', 'valide').order('fin', { ascending: false }).limit(1).maybeSingle();
      const lignes = cpt ? (await sb.from('stock_comptage_lignes').select('app_produit_id, quantite').eq('comptage_id', (cpt as any).id)).data || [] : [];
      const { data: cmds } = await sb.from('commandes').select('statut, created_at, lignes').not('statut', 'in', '(' + STATUTS_TERMINES.map((s) => '"' + s + '"').join(',') + ')');
      const { data: entrees } = cpt ? await sb.from('stock_entrees').select('app_produit_id, quantite, date_entree').gte('date_entree', (cpt as any).fin) : { data: [] };
      const stock = produits.slice(0, 60).map((p) => { const l = (lignes as any[]).find((x) => x.app_produit_id === p.id); return { nom: p.nom, ...estimerStock(p.id, l ? Number(l.quantite) : null, cpt ? String((cpt as any).fin) : null, (cmds as any[]) || [], (entrees as any[]) || []) }; });
      return rep(200, { ...base, estimation: true, dernier_comptage: cpt ? String((cpt as any).fin) : null, stock });
    }

    // ── N2 / N3 : aperçu puis exécution ───────────────────────────────────────────────────────────────────────────
    if (d.action === 'gls_etiquette') {
      const r = await interne('gls-create-shipment', { cmdId: d.cmdId, dryRun: !confirme });
      if (!r.j?.ok) return rep(r.http === 409 ? 409 : 502, { ok: false, erreur: 'GLS : ' + String(r.j?.error || r.j?.erreur || 'refus (HTTP ' + r.http + ')').slice(0, 200) });
      return rep(200, { ...base, gls: resumeGls(r.j), fait: confirme });
    }
    if (d.action === 'gls_retour') {
      const r = await interne('gls-create-shipment', { action: 'pickReturn', cmdId: d.cmdId, poids: d.poids ?? 15, dryRun: !confirme });
      if (!r.j?.ok) return rep(502, { ok: false, erreur: 'GLS : ' + String(r.j?.error || 'refus (HTTP ' + r.http + ')').slice(0, 200) });
      return rep(200, { ...base, gls: resumeGls(r.j), poids: d.poids ?? 15, fait: confirme });
    }
    if (d.action === 'planifier' || d.action === 'deplacer') {
      const p = champsPlanification(d, c!); const avant = { date: String(c!.date_livraison || ''), transporteur: String(c!.transporteur || ''), statut: String(c!.statut || '') };
      const apres = { date: d.date, transporteur: String(p.transporteur || avant.transporteur), statut: String(p.statut || avant.statut) };
      if (!confirme) return rep(200, { ...base, avant, apres });
      const { error } = await sb.from('commandes').update(p).eq('id', d.cmdId); if (error) return ecritureRefusee(error);
      return rep(200, { ...base, avant, apres, fait: true });
    }
    if (d.action === 'changer_statut') {
      const avant = String(c!.statut || '');
      if (!confirme) return rep(200, { ...base, avant, apres: d.statut });
      const { error } = await sb.from('commandes').update({ statut: d.statut, updated_at: new Date().toISOString() }).eq('id', d.cmdId); if (error) return ecritureRefusee(error);
      return rep(200, { ...base, avant, apres: d.statut, fait: true });
    }
    if (d.action === 'marquer_livre') {
      if (!confirme) return rep(200, { ...base, avant: String(c!.statut || ''), apres: 'livré', rappel: 'preuve de livraison RANOU : vérifier avec le livreur' });
      const { error } = await sb.from('commandes').update({ statut: 'livré', updated_at: new Date().toISOString() }).eq('id', d.cmdId); if (error) return ecritureRefusee(error);
      return rep(200, { ...base, avant: String(c!.statut || ''), apres: 'livré', fait: true });
    }
    if (d.action === 'modifier_commande') {
      const m = champsModification(d, c!);
      const visible = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'updated_at').map(([k, v]) => [k, k === 'tel' ? telMasque(String(v)) : k === 'adresse' ? String(v).replace(/^.*?(\b\d{5}\b)/, '… $1') : k === 'client' ? '(nom)' : v]));
      if (!confirme) return rep(200, { ...base, avant: visible(m.avant), apres: visible(m.apres), avertissements: m.avertissements });
      const { error } = await sb.from('commandes').update(m.apres).eq('id', d.cmdId); if (error) return ecritureRefusee(error);
      return rep(200, { ...base, avant: visible(m.avant), apres: visible(m.apres), avertissements: m.avertissements, fait: true });
    }
    if (d.action === 'modifier_prix') {
      const p = champsPrix(d, c!); const avant = Number(c!.prix) || 0;
      if (!confirme) return rep(200, { ...base, avant, apres: d.prix, motif: d.motif });
      const { error } = await sb.from('commandes').update(p).eq('id', d.cmdId); if (error) return ecritureRefusee(error);
      const { data: v } = await sb.from('commandes').select('prix').eq('id', d.cmdId).maybeSingle();
      if (!v || Number((v as any).prix) !== d.prix) return rep(409, { ok: false, erreur: 'la base a refusé le nouveau prix (verrou de paiement) : passer par l\'appli, administrateur' });
      return rep(200, { ...base, avant, apres: d.prix, motif: d.motif, fait: true });
    }
    if (d.action === 'annuler_commande') {
      const p = champsAnnulation(d); const apres = { statut: 'annulé', motif: p.annulation_motif, commentaire: p.annulation_commentaire };
      if (!confirme) return rep(200, { ...base, avant: String(c!.statut || ''), apres });
      const { error } = await sb.from('commandes').update(p).eq('id', d.cmdId); if (error) return ecritureRefusee(error);
      return rep(200, { ...base, avant: String(c!.statut || ''), apres, fait: true });
    }
    if (d.action === 'supprimer_commande') {
      if (!confirme) return rep(200, { ...base, suppression: { motif: d.motif, irreversible: true } });
      const { error } = await sb.from('commandes').delete().eq('id', d.cmdId); if (error) return ecritureRefusee(error);
      return rep(200, { ...base, suppression: { motif: d.motif, irreversible: true }, fait: true });
    }
    if (d.action === 'envoyer_sms') {
      const tel = String(c!.tel || '').trim(); const apercu = { destinataire: telMasque(tel), texte: String(d.texte).trim() };
      if (!confirme) return rep(200, { ...base, sms: apercu });
      const r = await interne('send-sms', { tel, message: apercu.texte, type: 'jarvis', client: String(c!.client || '') });
      if (!r.j?.success) return rep(502, { ok: false, erreur: 'SMS non envoyé (HTTP ' + r.http + ')' });
      return rep(200, { ...base, sms: apercu, fait: true });
    }
    if (d.action === 'sav') {
      const sav = construireSav(d, c!);
      const visible = { id: sav.id, produit: sav.produit, origine: sav.origine, date_livraison: sav.date_livraison, instr: sav.instr };
      if (!confirme) return rep(200, { ...base, sav: visible });
      const { data: existe } = await sb.from('commandes').select('id').eq('id', sav.id).maybeSingle();
      if (existe) return rep(409, { ok: false, erreur: 'numéro de SAV déjà pris : recommence dans une seconde' });
      const { error } = await sb.from('commandes').insert(sav); if (error) return rep(502, { ok: false, erreur: 'création du SAV refusée par la base' });
      return rep(200, { ...base, sav: visible, fait: true });
    }
    if (d.action === 'litige') {
      const p = champsLitige(d); const avant = avantLitige(c!);
      if (!confirme) return rep(200, { ...base, litige: { avant, apres: p } });
      const { error } = await sb.from('commandes').update(p).eq('id', d.cmdId); if (error) return ecritureRefusee(error);
      return rep(200, { ...base, litige: { avant, apres: p }, fait: true });
    }
    if (d.action === 'creer_commande') {
      const cat = await catalogue(); const l = lignesCommande(d.lignes!, cat); if (l.erreur) return rep(422, { ok: false, erreur: l.erreur });
      const { data: ids } = await sb.from('commandes').select('id').like('id', '#%').order('created_at', { ascending: false }).limit(300);
      let id = prochainNumero((ids || []).map((x: any) => String(x.id)));
      const cmd = construireCommande(d, id, l.lignes);
      const visible = { id, produit: cmd.produit, prix: cmd.prix, cp: d.cp, ville: d.ville, transporteur: cmd.transporteur, date_livraison: cmd.date_livraison, origine: cmd.origine, paiement: 'à la livraison', sans_prix: l.lignes.filter((x) => !x.produitId).map((x) => x.produit) };
      if (!confirme) return rep(200, { ...base, nouvelle: visible });
      let { error } = await sb.from('commandes').insert(cmd);
      if (error && String((error as any).code) === '23505') { id = '#' + (Number(id.slice(1)) + 1); ({ error } = await sb.from('commandes').insert({ ...cmd, id })); }
      if (error) return ecritureRefusee(error);
      return rep(200, { ...base, nouvelle: { ...visible, id }, fait: true });
    }
    if (d.action === 'stock_entree' || d.action === 'stock_correction') {
      const { data: p } = await sb.from('produits').select('id, nom').eq('id', d.produit).maybeSingle();
      if (!p) return rep(404, { ok: false, erreur: 'produit inconnu (identifiant de l\'appli attendu)' });
      if (d.action === 'stock_entree') {
        const e = entreeStock(d); const visible = { produit: (p as any).nom, quantite: d.qte, motif: e.motif };
        if (!confirme) return rep(200, { ...base, entree: visible });
        const { error } = await sb.from('stock_entrees').insert(e); if (error) return ecritureRefusee(error);
        return rep(200, { ...base, entree: visible, fait: true });
      }
      const a = alerteCorrectionStock(d); const visible = { produit: (p as any).nom, quantite: -d.qte!, motif: d.motif, traitement: 'alerte pour le prochain comptage (aucune écriture de stock silencieuse)' };
      if (!confirme) return rep(200, { ...base, correction: visible });
      const { error } = await sb.from('gls_alertes').insert(a); if (error) return ecritureRefusee(error);
      return rep(200, { ...base, correction: visible, fait: true });
    }
    if (d.action === 'stock_chargement' || d.action === 'stock_retour_depot') {
      const m = mouvementCamion(d); const visible = { type: m.type, produit: m.produit_libelle, quantite: m.quantite, livreur: d.livreur };
      if (!confirme) return rep(200, { ...base, mouvement: visible });
      const { error } = await sb.from('mouvements_stock').insert(m); if (error) return ecritureRefusee(error);
      return rep(200, { ...base, mouvement: visible, fait: true });
    }
  } catch (_e) { return rep(500, { ok: false, erreur: 'erreur interne' }); }
  return rep(422, { ok: false, erreur: 'action non autorisée' });
});
