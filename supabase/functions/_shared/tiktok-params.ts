// ════════════════════════════════════════════════════════════════════
// Paramètres TikTok Shop (incident clés Supabase, 27/09/2026)
// ════════════════════════════════════════════════════════════════════
// Les JETONS (access / refresh) sont désormais stockés dans la table
// `secrets_serveur` (RLS sans politique + REVOKE anon/authenticated →
// lisible uniquement côté serveur). Les autres réglages tiktok_* (dates
// d'expiration, shop id/cipher, état de la veille finance…) restent dans
// `parametres`.
// Lecture : `parametres` puis surcharge par `secrets_serveur` (source prioritaire).
// ════════════════════════════════════════════════════════════════════
// deno-lint-ignore-file no-explicit-any

export const CLES_SECRETES_TIKTOK = new Set(['tiktok_access_token', 'tiktok_refresh_token']);

export async function getParamsTiktok(sb: any): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const { data } = await sb.from('parametres').select('cle,valeur').like('cle', 'tiktok_%');
  // (bascule 27/09 : les anciens jetons de `parametres` servent de secours s'ils existent encore)
  for (const r of (data || [])) out[r.cle] = r.valeur;
  const { data: sec, error } = await sb.from('secrets_serveur').select('cle,valeur').like('cle', 'tiktok_%');
  if (error) throw new Error('secrets_serveur: ' + error.message);
  for (const r of (sec || [])) out[r.cle] = r.valeur;
  return out;
}

export async function setParamTiktok(sb: any, cle: string, valeur: string) {
  if (CLES_SECRETES_TIKTOK.has(cle)) {
    const { error } = await sb.from('secrets_serveur').upsert({ cle, valeur, updated_at: new Date().toISOString() }, { onConflict: 'cle' });
    if (error) throw new Error('secrets_serveur ' + cle + ': ' + error.message);
    return;
  }
  const { error } = await sb.from('parametres').upsert({ cle, valeur }, { onConflict: 'cle' });
  if (error) throw new Error('parametres ' + cle + ': ' + error.message);
}
