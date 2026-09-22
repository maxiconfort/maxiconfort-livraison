// ════════════════════════════════════════════════════════════════════
// Edge Function : tiktok-fulfill
// ════════════════════════════════════════════════════════════════════
// Transmet automatiquement le numéro de suivi GLS des commandes TikTok
// Shop à TikTok (« Ajouter des informations de suivi »), pour ne plus
// rien saisir à la main dans le Seller Center. Sans cette saisie avant la
// date limite, TikTok annule la commande et ne paie pas (leçon #1721).
//
// Éligible : commandes `origine = 'TikTok Shop'`, `ref_marketplace = TT<id>`,
// `tracking_transporteur` renseigné (posé par gls-create-shipment /
// gls-auto-etiquette), `tiktok_suivi_envoye_at` vide.
//
// Pour chaque commande :
//   1. Lit la commande TikTok (statut, colis, suivi déjà présent).
//   2. AWAITING_SHIPMENT  -> POST /fulfillment/202309/packages/{package}/ship
//                            { self_shipment: { tracking_number, shipping_provider_id: GLS } }
//      déjà expédiée      -> si TikTok a déjà notre n° (ou un autre) : marque « déjà saisi »
//      annulée            -> marque « annulée côté TikTok » (rien à faire)
//   3. Écrit tiktok_suivi_envoye_at / _note, ou tiktok_suivi_erreur (nouvel
//      essai au passage suivant).
//
// Body : { dryRun: true } -> montre ce qui serait fait, n'appelle pas TikTok en écriture.
// GLS = shipping_provider_id 7352739121363683088 (lu sur #1778/#1777, le 23/09/2026).
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { refreshAccessToken, signedRequest } from '../_shared/tiktok.ts';

const GLS_PROVIDER_ID = Deno.env.get('TIKTOK_GLS_PROVIDER_ID') || '7352739121363683088';

const sb = createClient(Deno.env.get('SUPABASE_URL') || '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '', {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function getParams(): Promise<Record<string, string>> {
  const { data } = await sb.from('parametres').select('cle,valeur').like('cle', 'tiktok_%');
  const out: Record<string, string> = {};
  for (const r of (data || [])) out[(r as any).cle] = (r as any).valeur;
  return out;
}
async function setParam(cle: string, valeur: string) {
  await sb.from('parametres').upsert({ cle, valeur }, { onConflict: 'cle' });
}
async function ensureAccessToken(p: Record<string, string>): Promise<string> {
  const exp = Date.parse(p.tiktok_access_token_expire_at || '') || 0;
  if (p.tiktok_access_token && exp - Date.now() > 24 * 3600 * 1000) return p.tiktok_access_token;
  if (!p.tiktok_refresh_token) throw new Error('Aucun jeton TikTok : refaire l\'autorisation de la boutique');
  const t = await refreshAccessToken(p.tiktok_refresh_token);
  await setParam('tiktok_access_token', t.access_token);
  await setParam('tiktok_access_token_expire_at', new Date(t.access_token_expire_in * 1000).toISOString());
  if (t.refresh_token) await setParam('tiktok_refresh_token', t.refresh_token);
  return t.access_token;
}

async function getOrder(token: string, cipher: string, id: string): Promise<any | null> {
  const j = await signedRequest('/order/202309/orders', token, { ids: id, shop_cipher: cipher });
  if (j.code !== 0) throw new Error('orders/get: ' + JSON.stringify(j).slice(0, 200));
  return j.data?.orders?.[0] || null;
}

async function shipPackage(token: string, cipher: string, packageId: string, tracking: string) {
  return await signedRequest(`/fulfillment/202309/packages/${packageId}/ship`, token, { shop_cipher: cipher }, 'POST', {
    self_shipment: { tracking_number: tracking, shipping_provider_id: GLS_PROVIDER_ID },
  });
}

async function marquer(id: string, champs: Record<string, unknown>) {
  await sb.from('commandes').update({ ...champs, updated_at: new Date().toISOString() }).eq('id', id);
}

Deno.serve(async (req: Request) => {
  const start = Date.now();
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const dryRun = !!body?.dryRun;
  const rapport = { transmis: [] as any[], deja: [] as any[], ignorees: [] as any[], erreurs: [] as any[], dryRun };
  try {
    const p = await getParams();
    if (!p.tiktok_shop_cipher) throw new Error('tiktok_shop_cipher manquant : refaire l\'autorisation TikTok');
    const token = await ensureAccessToken(p);
    const cipher = p.tiktok_shop_cipher;

    const { data: cmds, error } = await sb.from('commandes')
      .select('id, client, ref_marketplace, tracking_transporteur, statut')
      .eq('origine', 'TikTok Shop')
      .like('ref_marketplace', 'TT%')
      .is('tiktok_suivi_envoye_at', null)
      .not('tracking_transporteur', 'is', null)
      .order('created_at', { ascending: true })
      .limit(20);
    if (error) throw new Error('lecture commandes: ' + error.message);

    for (const c of (cmds || [])) {
      const tiktokId = String(c.ref_marketplace).slice(2);
      const tracking = String(c.tracking_transporteur || '').split(',')[0].trim();
      if (!tracking) { rapport.ignorees.push({ id: c.id, raison: 'pas de n° GLS' }); continue; }
      try {
        const o = await getOrder(token, cipher, tiktokId);
        if (!o) { rapport.ignorees.push({ id: c.id, raison: 'commande TikTok introuvable ' + tiktokId }); continue; }
        const st = String(o.status || '');
        const dejaTikTok = String(o.tracking_number || '').trim();

        if (st === 'CANCELLED') {
          if (!dryRun) await marquer(c.id, { tiktok_suivi_envoye_at: new Date().toISOString(), tiktok_suivi_note: 'Commande annulée côté TikTok, suivi non transmis', tiktok_suivi_erreur: null });
          rapport.ignorees.push({ id: c.id, raison: 'annulée côté TikTok' });
          continue;
        }
        if (st !== 'AWAITING_SHIPMENT' && st !== 'ON_HOLD') {
          // Déjà expédiée dans TikTok (saisie manuelle ou passage précédent)
          const note = dejaTikTok ? `Déjà présent dans TikTok (${dejaTikTok}${dejaTikTok !== tracking ? ' ≠ app ' + tracking : ''}), statut ${st}` : `Statut TikTok ${st}, rien à transmettre`;
          if (!dryRun) await marquer(c.id, { tiktok_suivi_envoye_at: new Date().toISOString(), tiktok_suivi_note: note, tiktok_suivi_erreur: null });
          rapport.deja.push({ id: c.id, tiktok: tiktokId, note });
          continue;
        }
        if (st === 'ON_HOLD') {
          rapport.ignorees.push({ id: c.id, raison: 'ON_HOLD (délai d\'annulation acheteur en cours), réessai plus tard' });
          continue;
        }
        const packageId = o.packages?.[0]?.id || o.line_items?.[0]?.package_id;
        if (!packageId) { rapport.erreurs.push({ id: c.id, erreur: 'aucun colis TikTok (package_id) sur la commande' }); continue; }
        if (dryRun) { rapport.transmis.push({ id: c.id, tiktok: tiktokId, package: packageId, tracking, simulation: true }); continue; }

        const r = await shipPackage(token, cipher, packageId, tracking);
        if (r.code !== 0) {
          const err = `ship ${r.code}: ${String(r.message || '').slice(0, 200)}`;
          await marquer(c.id, { tiktok_suivi_erreur: err });
          rapport.erreurs.push({ id: c.id, tiktok: tiktokId, erreur: err });
          continue;
        }
        await marquer(c.id, { tiktok_suivi_envoye_at: new Date().toISOString(), tiktok_suivi_note: `N° GLS ${tracking} transmis à TikTok via API (colis ${packageId})`, tiktok_suivi_erreur: null });
        rapport.transmis.push({ id: c.id, tiktok: tiktokId, package: packageId, tracking });
      } catch (e: any) {
        const err = String(e.message || e).slice(0, 250);
        if (!dryRun) await marquer(c.id, { tiktok_suivi_erreur: err });
        rapport.erreurs.push({ id: c.id, erreur: err });
      }
    }
    return json({ ...rapport, examinees: (cmds || []).length, duration_ms: Date.now() - start });
  } catch (e: any) {
    return json({ error: e.message, ...rapport, duration_ms: Date.now() - start }, 500);
  }
});

function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}
