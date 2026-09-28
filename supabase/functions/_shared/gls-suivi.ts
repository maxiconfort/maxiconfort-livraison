// ════════════════════════════════════════════════════════════════════
// Suivi d'UN colis GLS via ShipIT-FARM « parceldetails » (lecture seule)
// ════════════════════════════════════════════════════════════════════
// Même endpoint et mêmes identifiants que gls-sync (trackShipITFarm) :
// POST https://wbm-fr02.shipit.gls-group.com/backend/rs/tracking/parceldetails
// Authentification Basic GLS_SHIPIT_USER:GLS_SHIPIT_PASSWORD (secrets Supabase).
// ⚠️ GLS ne conserve l'historique qu'environ 60-70 jours (au-delà : HTTP 400).
// Aucune valeur secrète dans ce fichier (dépôt public).
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any

const USER = Deno.env.get('GLS_SHIPIT_USER') || '';
const PASS = Deno.env.get('GLS_SHIPIT_PASSWORD') || '';
const CONTACT_ID = Deno.env.get('GLS_CONTACT_ID') || '';
const URL_PARCELDETAILS = 'https://wbm-fr02.shipit.gls-group.com:443/backend/rs/tracking/parceldetails';

export async function suivreColisGLS(trackId: string): Promise<{ ok: boolean; status?: number; data?: any; erreur?: string }> {
  if (!USER || !PASS) return { ok: false, erreur: 'GLS_SHIPIT_USER/PASSWORD manquant' };
  try {
    const headers: Record<string, string> = {
      'Authorization': `Basic ${btoa(`${USER}:${PASS}`)}`,
      'Content-Type': 'application/glsVersion1+json',
      'Accept': 'application/glsVersion1+json, application/json',
    };
    if (CONTACT_ID) headers['Contact-Id'] = CONTACT_ID; // identique à gls-sync (tryAuthShipIT)
    const resp = await fetch(URL_PARCELDETAILS, {
      method: 'POST',
      headers,
      body: JSON.stringify({ TrackID: trackId, ShipmentReference: '' }),
    });
    const txt = await resp.text();
    if (!resp.ok) return { ok: false, status: resp.status, erreur: `HTTP ${resp.status}` };
    try { return { ok: true, status: resp.status, data: JSON.parse(txt) }; }
    catch { return { ok: false, status: resp.status, erreur: 'reponse non JSON' }; }
  } catch (e: any) {
    return { ok: false, erreur: e?.message || String(e) };
  }
}
