// ════════════════════════════════════════════════════════════════════
// Edge Function : tiktok-oauth-callback
// ════════════════════════════════════════════════════════════════════
// URL de redirection déclarée dans le Partner Center TikTok Shop
// (app « Maxiconfort Livraison », service 7650459414735030023).
// TikTok appelle cette URL avec ?code=<auth_code> après que Borhen a
// cliqué sur le lien d'autorisation de la boutique. On échange le code
// contre access/refresh tokens, on récupère le shop cipher, et on stocke
// le tout dans la table `parametres` (clés tiktok_*).
//
// Secrets requis : TIKTOK_APP_KEY, TIKTOK_APP_SECRET,
//                  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto).
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { exchangeAuthCode, getAuthorizedShops } from '../_shared/tiktok.ts';

const sb = createClient(Deno.env.get('SUPABASE_URL') || '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '', {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function setParam(cle: string, valeur: string) {
  const { error } = await sb.from('parametres').upsert({ cle, valeur }, { onConflict: 'cle' });
  if (error) throw new Error('parametres ' + cle + ': ' + error.message);
}

function html(title: string, body: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="fr"><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font-family:system-ui;max-width:640px;margin:60px auto;padding:0 16px">` +
      `<h1>${title}</h1>${body}</body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code') || url.searchParams.get('auth_code') || '';
  if (!code) return html('Autorisation TikTok Shop', '<p>Paramètre <code>code</code> absent.</p>', 400);

  try {
    const tok = await exchangeAuthCode(code);
    const now = Date.now();
    await setParam('tiktok_access_token', tok.access_token);
    await setParam('tiktok_access_token_expire_at', new Date(tok.access_token_expire_in * 1000).toISOString());
    await setParam('tiktok_refresh_token', tok.refresh_token);
    await setParam('tiktok_refresh_token_expire_at', new Date(tok.refresh_token_expire_in * 1000).toISOString());
    await setParam('tiktok_seller_name', tok.seller_name || '');
    await setParam('tiktok_open_id', tok.open_id || '');
    await setParam('tiktok_authorized_at', new Date(now).toISOString());

    let shopsInfo = '';
    try {
      const shops = await getAuthorizedShops(tok.access_token);
      const shop = shops.find((s) => s.region === 'FR') || shops[0];
      if (shop) {
        await setParam('tiktok_shop_id', shop.id);
        await setParam('tiktok_shop_cipher', shop.cipher);
        await setParam('tiktok_shop_name', shop.name);
        shopsInfo = `<p>Boutique : <b>${shop.name}</b> (${shop.region}, id ${shop.id})</p>`;
      }
    } catch (e) {
      shopsInfo = `<p style="color:#b00">Tokens enregistrés mais boutique non récupérée : ${String(e).slice(0, 200)}</p>`;
    }

    return html(
      'TikTok Shop connecté ✅',
      `<p>Vendeur : <b>${tok.seller_name || '—'}</b></p>${shopsInfo}` +
        `<p>Jeton valable jusqu'au ${new Date(tok.access_token_expire_in * 1000).toLocaleString('fr-FR')}.</p>` +
        `<p>Tu peux fermer cette page.</p>`,
    );
  } catch (e) {
    console.error('tiktok-oauth-callback', e);
    return html('Erreur de connexion TikTok Shop', `<p>${String(e).slice(0, 300)}</p>`, 500);
  }
});
