// ════════════════════════════════════════════════════════════════════
// Edge Function : gls-create-shipment (v1 — 05/06/2026)
// ════════════════════════════════════════════════════════════════════
// Cree une etiquette GLS via l'API ShipIT-FARM PROD France.
//
// Endpoint : POST https://wbm-fr02.shipit.gls-group.com:443/backend/rs/shipments
// Auth : Basic Auth avec credentials Olivier (GLS_SHIPIT_USER/PASSWORD)
//
// Body (optionnel) :
//   { cmdId: "#1196" }    → recupere la commande Supabase et cree label
//   { dryRun: true }      → genere le payload sans appeler GLS
//   { testMode: true }    → utilise donnees test fixees (validation label)
//
// Retourne :
//   { ok: true, trackId, parcelNumber, pdfBase64, ... }
//
// Secrets requis :
//   - GLS_SHIPIT_USER      (login ShipIT, ex 25049710ST)
//   - GLS_SHIPIT_PASSWORD  (mot de passe ShipIT)
//   - GLS_SHIPIT_CONTACT_ID (ContactID, ex 250aaa3Qfm)
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto-provisionnes)
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GLS_USER       = Deno.env.get('GLS_SHIPIT_USER') || '';
const GLS_PASSWORD   = Deno.env.get('GLS_SHIPIT_PASSWORD') || '';
const GLS_CONTACT_ID = Deno.env.get('GLS_SHIPIT_CONTACT_ID') || '';
const SB_URL         = Deno.env.get('SUPABASE_URL') || '';
const SB_SR_KEY      = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const GLS_API_URL = 'https://wbm-fr02.shipit.gls-group.com:443/backend/rs/shipments';

const sb = createClient(SB_URL, SB_SR_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// ── Expediteur Maxiconfort ────────────────────────────────────────────
// Entrepot : 10 rue du Ballon, 93160 Noisy-le-Grand
const SHIPPER_ADDRESS = {
  Name1: 'MAXICONFORT',
  CountryCode: 'FR',
  ZIPCode: '93160',
  City: 'Noisy-le-Grand',
  Street: 'Rue du Ballon',
  StreetNumber: '10',
};

// ── Parse une adresse francaise type "11 rue Jacques Prevert 92240 Malakoff"
// Retourne {streetNumber, street, zipCode, city}
function parseAdresseFR(adresse: string): { streetNumber: string; street: string; zipCode: string; city: string } {
  const def = { streetNumber: '', street: adresse, zipCode: '', city: '' };
  if (!adresse) return def;
  // Trouve le code postal (5 chiffres)
  const zipMatch = adresse.match(/\b(\d{5})\b/);
  if (!zipMatch) return def;
  const zipCode = zipMatch[1];
  const idx = adresse.indexOf(zipCode);
  const beforeZip = adresse.substring(0, idx).trim().replace(/,\s*$/, '');
  const afterZip  = adresse.substring(idx + 5).trim();
  // Apres le ZIP = ville
  const city = afterZip.split(/[,\n]/)[0].trim().replace(/,?\s*France\s*$/i, '');
  // Avant le ZIP = numero + rue
  const numMatch = beforeZip.match(/^(\d+\s*(?:bis|ter)?)\s+(.+)$/i);
  if (numMatch) {
    return { streetNumber: numMatch[1].trim(), street: numMatch[2].trim(), zipCode, city };
  }
  return { streetNumber: '', street: beforeZip, zipCode, city };
}

// ── Normalise un telephone francais en format E.164 type 0033...
function normalizeTel(tel: string): string {
  if (!tel) return '';
  let t = tel.replace(/[^0-9+]/g, '');
  if (t.startsWith('+33')) t = '0033' + t.substring(3);
  else if (t.startsWith('0033')) {} // ok
  else if (t.startsWith('0')) t = '0033' + t.substring(1);
  return t;
}

// ── Construit le payload Shipment GLS depuis une commande Supabase
function buildShipmentPayload(cmd: any, testMode: boolean): any {
  const parsed = parseAdresseFR(cmd.adresse || '');
  const tel = normalizeTel(cmd.tel || '');
  const today = new Date().toISOString().split('T')[0];
  // v2 : Reference avec fallback testMode pour eviter strings vides
  const cmdRef = (cmd.id || '').replace(/^#/, 'CMD-');
  const reference = cmdRef || (testMode ? 'TEST-' + Date.now().toString().slice(-8) : 'CMD-AUTO');
  // Poids defaut 25kg (meubles)
  const weight = parseFloat(cmd.poids || '') || 25.0;
  // Nom client : split en Name1 (nom) + Name2 (prenom/complement)
  const clientName = (cmd.client || 'Client').trim();
  const consignee: any = {
    Address: {
      Name1: clientName.substring(0, 40),
      CountryCode: 'FR',
      ZIPCode: parsed.zipCode || '75001',
      City: (parsed.city || 'Paris').substring(0, 40),
      Street: (parsed.street || 'Rue').substring(0, 40),
      StreetNumber: parsed.streetNumber.substring(0, 10),
    },
  };
  if (tel) consignee.Address.MobilePhoneNumber = tel;
  if (cmd.email) consignee.Address.eMail = cmd.email;
  // Si test mode : adresse Maxiconfort comme destinataire (pour validation Olivier)
  if (testMode) {
    consignee.Address = {
      Name1: 'TEST MAXICONFORT',
      CountryCode: 'FR',
      ZIPCode: '93160',
      City: 'Noisy-le-Grand',
      Street: 'Rue du Ballon',
      StreetNumber: '10',
      MobilePhoneNumber: '0033744289321',
    };
  }
  const payload: any = {
    Shipment: {
      ShipmentReference: [reference],
      ShippingDate: today,
      Product: 'PARCEL',
      Consignee: consignee,
      Shipper: { ContactID: GLS_CONTACT_ID },
      ShipmentUnit: [
        {
          // v2 : ShipmentUnitReference DOIT etre un array (GLS error v1)
          ShipmentUnitReference: [reference + '-1'],
          Weight: weight,
          Note1: (cmd.produit || '').substring(0, 60),
        },
      ],
    },
    PrintingOptions: {
      ReturnLabels: {
        TemplateSet: 'NONE',
        LabelFormat: 'PDF',
      },
    },
  };
  return payload;
}

// ── Appel API GLS Create Shipment
async function createShipment(payload: any): Promise<any> {
  if (!GLS_USER || !GLS_PASSWORD) {
    throw new Error('GLS_SHIPIT_USER ou GLS_SHIPIT_PASSWORD manquant dans les secrets Supabase');
  }
  const basic = btoa(`${GLS_USER}:${GLS_PASSWORD}`);
  const resp = await fetch(GLS_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/glsVersion1+json',
      'Accept': 'application/glsVersion1+json, application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 1000) }; }
  return { ok: resp.ok, status: resp.status, data };
}

Deno.serve(async (req: Request) => {
  const startTime = Date.now();
  let body: any = {};
  if (req.method === 'POST') { try { body = await req.json(); } catch {} }
  const dryRun: boolean = !!body.dryRun;
  const testMode: boolean = !!body.testMode;
  const cmdId: string | null = body.cmdId || null;

  if (!cmdId && !testMode) {
    return new Response(JSON.stringify({ ok: false, error: 'cmdId requis (ou testMode:true)' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  // Recup commande Supabase (sauf si testMode pur)
  let cmd: any = {};
  if (cmdId) {
    const { data, error } = await sb.from('commandes').select('*').eq('id', cmdId).single();
    if (error || !data) {
      return new Response(JSON.stringify({ ok: false, error: 'Commande non trouvee: ' + (error?.message || cmdId) }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    cmd = data;
  }

  const payload = buildShipmentPayload(cmd, testMode);

  if (dryRun) {
    return new Response(JSON.stringify({ ok: true, dryRun: true, payload, duration_ms: Date.now() - startTime }), { headers: { 'Content-Type': 'application/json' } });
  }

  const result = await createShipment(payload);

  if (!result.ok) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'GLS API error',
      status: result.status,
      gls_response: result.data,
      payload_envoye: payload,
    }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  // Extraction TrackID + PDF
  const created = result.data?.CreatedShipment || {};
  const parcels = created.ParcelData || [];
  const trackId = parcels[0]?.TrackID || null;
  const parcelNumber = parcels[0]?.Barcodes?.Primary1D || null;
  const pdfBase64 = created.PrintData || null;

  // Update commande Supabase avec le TrackID (si pas testMode)
  if (cmdId && trackId && !testMode) {
    try {
      await sb.from('commandes').update({
        tracking_transporteur: trackId,
        transporteur: 'GLS',
      }).eq('id', cmdId);
    } catch (e: any) {
      console.warn('Update commande failed:', e.message);
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    trackId,
    parcelNumber,
    pdfBase64: pdfBase64 ? pdfBase64.substring(0, 50) + '...(tronque, longueur=' + pdfBase64.length + ')' : null,
    pdfBase64Full: pdfBase64, // Le PDF complet pour download/print cote client
    gls_response: created,
    duration_ms: Date.now() - startTime,
  }), { headers: { 'Content-Type': 'application/json' } });
});
