// ════════════════════════════════════════════════════════════════════
// Edge Function : lbc-action (v1 — 28/10/2026, lot LBC 2)
// ════════════════════════════════════════════════════════════════════
// Porte RÉSERVÉE À JARVIS pour piloter le PLANNING de l'outil Leboncoin (tables lbc_produits / lbc_annonces), en 2 temps :
//   1. { ..., confirme: false } → APERÇU : contrôle, lecture, liste exacte de ce qui changera ; l'aperçu est ENREGISTRÉ par la
//      base (migration 036 : cibles + empreinte de chaque ligne + paramètres) et un JETON à usage unique (10 min) est renvoyé ;
//   2. { ..., confirme: true, jeton } → la base vérifie le jeton, les paramètres, l'empreinte de chaque ligne, et écrit TOUT LE
//      LOT OU RIEN dans une seule transaction (public.lbc_action_appliquer), avec journal (lbc_actions_journal).
// La validation humaine a lieu dans JARVIS (« Appliquer » + « Confirmer » de Borhen) ; le jeton prouve que la confirmation
// porte exactement sur l'aperçu montré. Liste fermée : _shared/lbc-action-logique.ts. Rien n'est publié sur Leboncoin.
// Appelant : en-tête x-lbc-secret = secret LBC_ACTION_SECRET (dédié, révocable en le changeant). Aucun autre accès.
// Mise en service : migration 036 puis
//   npx supabase functions deploy lbc-action --project-ref jmvfjtnmebstkzcfnlgp --no-verify-jwt --use-api
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { ACTIONS_PRODUIT, MAX_ANNONCES, controlerDemande, dansFiltre, egal, parametres, refusAnnonce, trouverProduits, vueAnnonce, vueProduit, type AnnonceLbc, type DemandeLbc, type ProduitLbc } from '../_shared/lbc-action-logique.ts';

const SB_URL = Deno.env.get('SUPABASE_URL') || '';
const SECRET = Deno.env.get('LBC_ACTION_SECRET') || '';
function cleServeur(): string {
  const sr = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (sr.startsWith('sb_secret_')) return sr;
  try { for (const v of Object.values(JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'))) if (typeof v === 'string' && v.startsWith('sb_secret_')) return v; } catch { /* */ }
  return '';
}
const CLE = cleServeur();
const sb = createClient(SB_URL, CLE, { auth: { autoRefreshToken: false, persistSession: false } });
const rep = (code: number, o: unknown) => new Response(JSON.stringify(o), { status: code, headers: { 'Content-Type': 'application/json' } });
const COL_PROD = 'id,nom,dim,actif,boost_pct,boost_until,poids_idf,poids_prov';
const COL_ANN = 'id,date_pub,heure,ville,dept,collab_id,produit,dim,validation,statut,lien';

async function enregistrerApercu(d: DemandeLbc, ids: string[]): Promise<string | null> {
  const { data, error } = await sb.rpc('lbc_action_enregistrer_apercu', { p_action: d.action, p_demande: parametres(d), p_ids: ids });
  return error ? null : (data as any)?.jeton || null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return rep(405, { ok: false, erreur: 'POST seulement' });
  if (!SECRET || !egal(req.headers.get('x-lbc-secret') || '', SECRET)) return rep(401, { ok: false, erreur: 'refusé' });
  if (!CLE) return rep(503, { ok: false, erreur: 'clé serveur absente' });
  let d: DemandeLbc; try { d = await req.json(); } catch { return rep(400, { ok: false, erreur: 'JSON invalide' }); }
  const maintenant = Date.now();
  const forme = controlerDemande(d, maintenant); if (forme) return rep(422, { ok: false, erreur: forme });
  const confirme = d.confirme === true;

  try {
    // ── CONFIRMATION : tout est décidé par la base, dans une seule transaction ──
    if (confirme) {
      const { data, error } = await sb.rpc('lbc_action_appliquer', { p_jeton: d.jeton, p_action: d.action, p_demande: parametres(d) });
      if (error) return rep(500, { ok: false, erreur: 'écriture annulée par la base (rien n’a été modifié)' });
      const r = data as any;
      if (!r?.ok) return rep(409, { ok: false, code: r?.code || 'CHANGE', erreur: String(r?.motif || 'refusé').slice(0, 200), problemes: Array.isArray(r?.problemes) ? r.problemes.slice(0, 20) : undefined });
      if (ACTIONS_PRODUIT.includes(d.action)) {
        const { data: relu } = await sb.from('lbc_produits').select(COL_PROD).eq('id', d.produitId!).maybeSingle();
        return rep(200, { ok: true, action: d.action, confirme: true, fait: true, verifie: true, produit: relu ? vueProduit(relu as ProduitLbc) : null, modifiees: r.modifiees });
      }
      const { data: apres } = await sb.from('lbc_annonces').select(COL_ANN).in('id', d.ids!);
      return rep(200, { ok: true, action: d.action, confirme: true, fait: true, verifie: true, modifiees: r.modifiees, annonces: ((apres || []) as AnnonceLbc[]).map(vueAnnonce) });
    }

    // ── APERÇU : produit ──
    if (ACTIONS_PRODUIT.includes(d.action)) {
      let p: ProduitLbc | null = null;
      if (d.produitId) {
        const { data } = await sb.from('lbc_produits').select(COL_PROD).eq('id', d.produitId).maybeSingle();
        p = (data as ProduitLbc) || null;
        if (!p || p.actif === false) return rep(422, { ok: false, erreur: 'produit introuvable ou inactif' });
      } else {
        const { data } = await sb.from('lbc_produits').select(COL_PROD).limit(1000);
        const l = trouverProduits((data || []) as ProduitLbc[], String(d.produit));
        if (!l.length) return rep(422, { ok: false, erreur: 'aucun produit du catalogue Leboncoin ne correspond' });
        if (l.length > 1) return rep(200, { ok: true, action: d.action, confirme: false, ambigu: true, candidats: l.slice(0, 12).map(vueProduit) });
        p = l[0];
      }
      const jeton = await enregistrerApercu(d, [p.id]); if (!jeton) return rep(502, { ok: false, erreur: 'aperçu non enregistré par la base' });
      const apres: Record<string, unknown> = { ...vueProduit(p) };
      if (d.action === 'boost') { apres.boost_pct = Number(d.pct); apres.boost_until = new Date(Date.parse(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(maintenant)) + 'T12:00:00Z') + Number(d.jours) * 864e5).toISOString().slice(0, 10); }
      if (d.action === 'fin_boost') { apres.boost_pct = null; apres.boost_until = null; }
      if (d.action === 'poids_zone') apres[d.zone === 'idf' ? 'poids_idf' : 'poids_prov'] = d.poids;
      return rep(200, { ok: true, action: d.action, confirme: false, produit: vueProduit(p), apres, jeton });
    }

    // ── APERÇU : annonces ──
    const f = d.filtre!;
    const { data } = await sb.from('lbc_annonces').select(COL_ANN).eq('date_pub', f.date).limit(2000);
    const dans = ((data || []) as AnnonceLbc[]).filter((a) => dansFiltre(a, f));
    const ok: AnnonceLbc[] = [], ecartees: Record<string, number> = {};
    for (const a of dans) { const r = refusAnnonce(a, d.action, maintenant); if (r) ecartees[r] = (ecartees[r] || 0) + 1; else ok.push(a); }
    const retenues = ok.slice(0, MAX_ANNONCES);
    const jeton = retenues.length ? await enregistrerApercu(d, retenues.map((a) => a.id)) : null;
    if (retenues.length && !jeton) return rep(502, { ok: false, erreur: 'aperçu non enregistré par la base' });
    return rep(200, { ok: true, action: d.action, confirme: false, filtre: f, nouvelleDate: d.nouvelleDate ?? null, trouvees: dans.length, ecartees,
      trop: ok.length > MAX_ANNONCES, annonces: retenues.map(vueAnnonce), ids: retenues.map((a) => a.id), jeton });
  } catch (_e) { return rep(500, { ok: false, erreur: 'erreur interne' }); }
});
