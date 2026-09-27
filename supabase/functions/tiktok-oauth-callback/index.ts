// ════════════════════════════════════════════════════════════════════
// Edge Function : tiktok-oauth-callback (v2 — 27/09/2026, incident clés)
// ════════════════════════════════════════════════════════════════════
// URL de redirection déclarée dans le Partner Center TikTok Shop
// (app « Maxiconfort Livraison », service 7650459414735030023).
//
// v2 : protection OAuth « state » (anti-CSRF / anti-injection de jetons).
//  1) PRÉPARER (appel serveur uniquement : x-cron-secret ou clé secrète) :
//       POST { action: 'preparer' }  →  { url }  (lien d'autorisation à ouvrir,
//       valable 30 min, usage unique). Script local : outils/tiktok-lien-autorisation.js
//  2) RETOUR TikTok : GET ?code=…&state=…  → l'état doit exister, ne pas être
//     expiré ni déjà utilisé ; il est consommé (usage unique) AVANT l'échange du code.
//     Sans state valide : refus, aucun jeton n'est enregistré.
//  Jetons stockés dans `secrets_serveur` (plus jamais dans `parametres`).
//
// Secrets requis : TIKTOK_APP_KEY, TIKTOK_APP_SECRET, INTERNAL_CRON_SECRET,
//                  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto = clé secrète).
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { exchangeAuthCode, getAuthorizedShops } from '../_shared/tiktok.ts';
import { setParamTiktok } from '../_shared/tiktok-params.ts';
import { appelInterne, refus } from '../_shared/controle-appelant.ts';

const SERVICE_ID = Deno.env.get('TIKTOK_SERVICE_ID') || '7650459414735030023';
const AUTH_URL = Deno.env.get('TIKTOK_AUTHORIZE_URL') || 'https://services.tiktokshop.com/open/authorize';
const DUREE_ETAT_MIN = 30;

const sb = createClient(Deno.env.get('SUPABASE_URL') || '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '', {
  auth: { autoRefreshToken: false, persistSession: false },
});

function echapper(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function html(title: string, body: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="fr"><meta charset="utf-8"><title>${echapper(title)}</title>` +
      `<body style="font-family:system-ui;max-width:640px;margin:60px auto;padding:0 16px">` +
      `<h1>${echapper(title)}</h1>${body}</body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );
}

function etatAleatoire(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// Consomme l'état (usage unique) : renvoie true seulement si valide, non expiré, non utilisé.
async function consommerEtat(etat: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(etat)) return false;
  const { data, error } = await sb
    .from('oauth_etats')
    .update({ utilise_at: new Date().toISOString() })
    .eq('etat', etat)
    .eq('fournisseur', 'tiktok')
    .is('utilise_at', null)
    .gt('expire_at', new Date().toISOString())
    .select('etat');
  if (error) throw new Error('oauth_etats: ' + error.message);
  return (data || []).length === 1;
}

Deno.serve(async (req: Request) => {
  // ── 1) Préparation du lien (serveur uniquement) ─────────────────────
  if (req.method === 'POST') {
    if (!appelInterne(req)) return refus();
    let body: any = {};
    try { body = await req.json(); } catch { /* vide */ }
    if (body.action !== 'preparer') return new Response(JSON.stringify({ ok: false, error: 'action inconnue' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    const etat = etatAleatoire();
    const expire = new Date(Date.now() + DUREE_ETAT_MIN * 60 * 1000).toISOString();
    // ménage des états expirés
    await sb.from('oauth_etats').delete().lt('expire_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString());
    const { error } = await sb.from('oauth_etats').insert({ etat, fournisseur: 'tiktok', expire_at: expire });
    if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(AUTH_URL);
    u.searchParams.set('service_id', SERVICE_ID);
    u.searchParams.set('state', etat);
    return new Response(JSON.stringify({ ok: true, url: u.toString(), expire_at: expire }), { headers: { 'Content-Type': 'application/json' } });
  }

  // ── 2) Retour de TikTok ─────────────────────────────────────────────
  const url = new URL(req.url);
  const code = url.searchParams.get('code') || url.searchParams.get('auth_code') || '';
  const etat = url.searchParams.get('state') || '';
  if (!code) return html('Autorisation TikTok Shop', '<p>Paramètre <code>code</code> absent.</p>', 400);

  try {
    if (!(await consommerEtat(etat))) {
      console.warn('tiktok-oauth-callback : state absent, invalide, expire ou deja utilise — refus');
      return html('Autorisation refusée',
        '<p>Ce lien d\'autorisation n\'est pas valide (état de sécurité absent, expiré ou déjà utilisé).</p>' +
        '<p>Demandez un nouveau lien (valable 30 minutes, usage unique) puis recommencez.</p>', 400);
    }

    const tok = await exchangeAuthCode(code);
    const now = Date.now();
    await setParamTiktok(sb, 'tiktok_access_token', tok.access_token);
    await setParamTiktok(sb, 'tiktok_access_token_expire_at', new Date(tok.access_token_expire_in * 1000).toISOString());
    await setParamTiktok(sb, 'tiktok_refresh_token', tok.refresh_token);
    await setParamTiktok(sb, 'tiktok_refresh_token_expire_at', new Date(tok.refresh_token_expire_in * 1000).toISOString());
    await setParamTiktok(sb, 'tiktok_seller_name', tok.seller_name || '');
    await setParamTiktok(sb, 'tiktok_open_id', tok.open_id || '');
    await setParamTiktok(sb, 'tiktok_authorized_at', new Date(now).toISOString());

    let shopsInfo = '';
    try {
      const shops = await getAuthorizedShops(tok.access_token);
      const shop = shops.find((s) => s.region === 'FR') || shops[0];
      if (shop) {
        await setParamTiktok(sb, 'tiktok_shop_id', shop.id);
        await setParamTiktok(sb, 'tiktok_shop_cipher', shop.cipher);
        await setParamTiktok(sb, 'tiktok_shop_name', shop.name);
        shopsInfo = `<p>Boutique : <b>${echapper(shop.name)}</b> (${echapper(shop.region)})</p>`;
      }
    } catch (e) {
      shopsInfo = `<p style="color:#b00">Jetons enregistrés mais boutique non récupérée : ${echapper(String(e).slice(0, 200))}</p>`;
    }

    return html(
      'TikTok Shop connecté ✅',
      `<p>Vendeur : <b>${echapper(tok.seller_name || '—')}</b></p>${shopsInfo}` +
        `<p>Jeton valable jusqu'au ${new Date(tok.access_token_expire_in * 1000).toLocaleString('fr-FR')}.</p>` +
        `<p>Tu peux fermer cette page.</p>`,
    );
  } catch (e) {
    console.error('tiktok-oauth-callback', e);
    return html('Erreur de connexion TikTok Shop', `<p>${echapper(String(e).slice(0, 300))}</p>`, 500);
  }
});
