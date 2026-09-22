// Helpers TikTok Shop Open API (auth v2 + signature v202309).
// Secrets attendus : TIKTOK_APP_KEY, TIKTOK_APP_SECRET (Supabase Edge Function Secrets).

const AUTH_HOST = 'https://auth.tiktok-shops.com';
const API_HOST = 'https://open-api.tiktokglobalshop.com';

export function tiktokCreds() {
  const appKey = Deno.env.get('TIKTOK_APP_KEY') || '';
  const appSecret = Deno.env.get('TIKTOK_APP_SECRET') || '';
  if (!appKey || !appSecret) throw new Error('TIKTOK_APP_KEY / TIKTOK_APP_SECRET manquants');
  return { appKey, appSecret };
}

export async function exchangeAuthCode(authCode: string) {
  const { appKey, appSecret } = tiktokCreds();
  const u = new URL(AUTH_HOST + '/api/v2/token/get');
  u.searchParams.set('app_key', appKey);
  u.searchParams.set('app_secret', appSecret);
  u.searchParams.set('auth_code', authCode);
  u.searchParams.set('grant_type', 'authorized_code');
  const r = await fetch(u.toString());
  const j = await r.json();
  if (j.code !== 0 || !j.data?.access_token) throw new Error('token/get: ' + JSON.stringify(j).slice(0, 300));
  return j.data as {
    access_token: string; access_token_expire_in: number;
    refresh_token: string; refresh_token_expire_in: number;
    open_id: string; seller_name: string; seller_base_region: string; user_type: number;
  };
}

export async function refreshAccessToken(refreshToken: string) {
  const { appKey, appSecret } = tiktokCreds();
  const u = new URL(AUTH_HOST + '/api/v2/token/refresh');
  u.searchParams.set('app_key', appKey);
  u.searchParams.set('app_secret', appSecret);
  u.searchParams.set('refresh_token', refreshToken);
  u.searchParams.set('grant_type', 'refresh_token');
  const r = await fetch(u.toString());
  const j = await r.json();
  if (j.code !== 0 || !j.data?.access_token) throw new Error('token/refresh: ' + JSON.stringify(j).slice(0, 300));
  return j.data;
}

async function hmacSha256Hex(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Signature officielle : secret + path + (params triés, sauf sign/access_token) + body + secret → HMAC-SHA256(secret).
export async function signedRequest(
  path: string,
  accessToken: string,
  query: Record<string, string> = {},
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
) {
  const { appKey, appSecret } = tiktokCreds();
  const params: Record<string, string> = { ...query, app_key: appKey, timestamp: String(Math.floor(Date.now() / 1000)) };
  const sorted = Object.keys(params).filter((k) => k !== 'sign' && k !== 'access_token').sort();
  const bodyStr = body ? JSON.stringify(body) : '';
  const base = appSecret + path + sorted.map((k) => k + params[k]).join('') + bodyStr + appSecret;
  params.sign = await hmacSha256Hex(appSecret, base);
  const u = new URL(API_HOST + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u.toString(), {
    method,
    headers: { 'content-type': 'application/json', 'x-tts-access-token': accessToken },
    body: body ? bodyStr : undefined,
  });
  return await r.json();
}

export async function getAuthorizedShops(accessToken: string) {
  const j = await signedRequest('/authorization/202309/shops', accessToken);
  if (j.code !== 0) throw new Error('shops: ' + JSON.stringify(j).slice(0, 300));
  return (j.data?.shops || []) as { id: string; name: string; region: string; seller_type: string; cipher: string; code: string }[];
}
