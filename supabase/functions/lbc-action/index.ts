// ════════════════════════════════════════════════════════════════════
// Edge Function : lbc-action (v1 — 28/10/2026, lot LBC 2)
// ════════════════════════════════════════════════════════════════════
// Porte RÉSERVÉE À JARVIS pour piloter le PLANNING de l'outil Leboncoin (tables lbc_produits / lbc_annonces), en 2 temps :
//   1. { ..., confirme: false } → APERÇU : contrôle, lecture, liste exacte de ce qui changera — RIEN n'est écrit ;
//   2. { ..., confirme: true }  → exécution après le « Confirmer » de Borhen, puis RELECTURE (résultat vérifié).
// Liste fermée et règles : _shared/lbc-action-logique.ts. Rien n'est publié ni modifié sur Leboncoin ; aucune suppression,
// aucun prix, aucun titre, aucune annonce passée ou déjà publiée.
// Appelant : en-tête x-lbc-secret = secret LBC_ACTION_SECRET (dédié, révocable en le changeant). Aucun autre accès.
// Déploiement : npx supabase functions deploy lbc-action --project-ref jmvfjtnmebstkzcfnlgp --no-verify-jwt --use-api
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { ACTIONS_PRODUIT, MAX_ANNONCES, controlerDemande, dansFiltre, egal, patchAnnonce, patchProduit, refusAnnonce, trouverProduits, verifierAnnonces, verifierProduit, vueAnnonce, vueProduit, type AnnonceLbc, type DemandeLbc, type ProduitLbc } from '../_shared/lbc-action-logique.ts';

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

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return rep(405, { ok: false, erreur: 'POST seulement' });
  if (!SECRET || !egal(req.headers.get('x-lbc-secret') || '', SECRET)) return rep(401, { ok: false, erreur: 'refusé' });
  if (!CLE) return rep(503, { ok: false, erreur: 'clé serveur absente' });
  let d: DemandeLbc; try { d = await req.json(); } catch { return rep(400, { ok: false, erreur: 'JSON invalide' }); }
  const maintenant = Date.now(); const quand = new Date(maintenant).toISOString();
  const forme = controlerDemande(d, maintenant); if (forme) return rep(422, { ok: false, erreur: forme });
  const confirme = d.confirme === true;

  try {
    // ── Produit : boost, fin de boost, pression par zone ──
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
      const patch = patchProduit(d, maintenant, quand);
      const base = { ok: true, action: d.action, confirme, produit: vueProduit(p), apres: { ...vueProduit(p), ...Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'updated_at')) } };
      if (!confirme) return rep(200, base);
      const { error } = await sb.from('lbc_produits').update(patch).eq('id', p.id);
      if (error) return rep(502, { ok: false, erreur: 'écriture refusée par la base' });
      const { data: relu } = await sb.from('lbc_produits').select(COL_PROD).eq('id', p.id).maybeSingle();
      const ok = verifierProduit(relu as ProduitLbc, patch);
      return rep(ok ? 200 : 502, { ...base, ok, fait: ok, verifie: ok, relu: relu ? vueProduit(relu as ProduitLbc) : null, erreur: ok ? undefined : 'résultat non vérifié : à contrôler dans l’outil LBC' });
    }

    // ── Annonces du planning : bloquer, débloquer, décaler ──
    const f = d.filtre!;
    if (!confirme) {
      const { data } = await sb.from('lbc_annonces').select(COL_ANN).eq('date_pub', f.date).limit(2000);
      const dans = ((data || []) as AnnonceLbc[]).filter((a) => dansFiltre(a, f));
      const ok: AnnonceLbc[] = [], ecartees: Record<string, number> = {};
      for (const a of dans) { const r = refusAnnonce(a, d.action, maintenant); if (r) ecartees[r] = (ecartees[r] || 0) + 1; else ok.push(a); }
      return rep(200, { ok: true, action: d.action, confirme: false, filtre: f, nouvelleDate: d.nouvelleDate ?? null, trouvees: dans.length, ecartees,
        trop: ok.length > MAX_ANNONCES, annonces: ok.slice(0, MAX_ANNONCES).map(vueAnnonce), ids: ok.slice(0, MAX_ANNONCES).map((a) => a.id) });
    }
    const ids = d.ids!;
    const { data: avant } = await sb.from('lbc_annonces').select(COL_ANN).in('id', ids);
    const lues = (avant || []) as AnnonceLbc[];
    // Re-contrôle de CHAQUE annonce juste avant d'écrire : même liste que l'aperçu, toujours dans le filtre, toujours modifiable.
    const problemes = ids.map((id) => { const a = lues.find((x) => x.id === id); if (!a) return { id, motif: 'introuvable' }; if (!dansFiltre(a, f)) return { id, motif: 'a changé depuis l’aperçu' }; const r = refusAnnonce(a, d.action, maintenant); return r ? { id, motif: r } : null; }).filter(Boolean);
    if (problemes.length) return rep(409, { ok: false, erreur: 'le planning a changé depuis l’aperçu : rien n’a été modifié, refais l’aperçu', problemes: problemes.slice(0, 20) });
    const patch = patchAnnonce(d, quand);
    // Garde de concurrence côté base : seules les lignes encore non publiées et du bon jour sont modifiées.
    let q = sb.from('lbc_annonces').update(patch).in('id', ids).eq('date_pub', f.date).neq('validation', 'ON');
    q = d.action === 'debloquer' ? q.eq('statut', 'Bloqué') : q.neq('statut', 'Bloqué');
    const { error } = await q;
    if (error) return rep(502, { ok: false, erreur: 'écriture refusée par la base' });
    const { data: apres } = await sb.from('lbc_annonces').select(COL_ANN).in('id', ids);
    const verifie = verifierAnnonces((apres || []) as AnnonceLbc[], ids, patch);
    return rep(verifie ? 200 : 502, { ok: verifie, action: d.action, confirme: true, fait: verifie, verifie, modifiees: verifie ? ids.length : null,
      annonces: ((apres || []) as AnnonceLbc[]).map(vueAnnonce), erreur: verifie ? undefined : 'résultat incomplet : à contrôler dans l’outil LBC (INDÉTERMINÉ)' });
  } catch (_e) { return rep(500, { ok: false, erreur: 'erreur interne' }); }
});
