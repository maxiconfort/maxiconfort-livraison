// ════════════════════════════════════════════════════════════════════
// Edge Function : gls-pick-return (v1 — 03/09/2026)
// ════════════════════════════════════════════════════════════════════
// Cree un enlevement Pick&Return GLS : GLS va chercher le(s) colis chez
// le client et les ramene a BMS (retour au chargeur).
// PAS d'etiquette a imprimer : le depot GLS l'imprime, le chauffeur l'apporte
// (source : doc ShipIT-FARM p.19 — "Pick&Return requests do not return a label").
//
// Body :
//   {
//     pickup: { name, name2?, street, zip, city, mobile?, email? },  // adresse d'enlevement (le client)
//     weights: [15, 15],          // 1 poids par colis a reprendre
//     reference: "RET-1588",      // reference visible cote GLS
//     pickupDate: "2026-09-04",   // date d'enlevement souhaitee (YYYY-MM-DD)
//     dryRun: true                // optionnel : montre le payload sans creer
//   }
// Reponse : { ok, trackIds, pickupLocation, gls_response }
// ════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any

const GLS_USER       = Deno.env.get('GLS_SHIPIT_USER') || '';
const GLS_PASSWORD   = Deno.env.get('GLS_SHIPIT_PASSWORD') || '';
const GLS_CONTACT_ID = Deno.env.get('GLS_SHIPIT_CONTACT_ID') || '';

const GLS_API_URL = 'https://wbm-fr02.shipit.gls-group.com:443/backend/rs/shipments';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };

function normalizeTel(tel: string): string {
  let t = (tel || '').replace(/[\s.()\-]/g, '');
  if (t.startsWith('+33')) t = '0033' + t.slice(3);
  else if (t.startsWith('0') && t.length === 10) t = '0033' + t.slice(1);
  return t;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: JSON_HEADERS });
  let body: any = {};
  try { body = await req.json(); } catch { /* silent */ }

  const p = body.pickup || {};
  const weights: number[] = Array.isArray(body.weights) && body.weights.length ? body.weights : [15];
  const reference: string = body.reference || 'RETOUR';
  const pickupDate: string = body.pickupDate || '';

  if (!p.name || !p.street || !p.zip || !p.city) {
    return new Response(JSON.stringify({ ok: false, error: 'pickup.name/street/zip/city requis' }), { status: 400, headers: JSON_HEADERS });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) {
    return new Response(JSON.stringify({ ok: false, error: 'pickupDate requis (YYYY-MM-DD)' }), { status: 400, headers: JSON_HEADERS });
  }
  if (!GLS_USER || !GLS_PASSWORD || !GLS_CONTACT_ID) {
    return new Response(JSON.stringify({ ok: false, error: 'Secrets GLS manquants' }), { status: 500, headers: JSON_HEADERS });
  }

  // Doc ShipIT p.19 : Consignee = adresse d'ENLEVEMENT (le client),
  // Shipper = livraison du retour → ContactID seul suffit (adresse du compte BMS)
  const address: any = {
    Name1: String(p.name).substring(0, 40),
    CountryCode: 'FR',
    ZIPCode: String(p.zip),
    City: String(p.city),
    Street: String(p.street).substring(0, 40),
  };
  if (p.name2) address.Name2 = String(p.name2).substring(0, 40);
  if (p.email) address.eMail = String(p.email);
  const mobile = normalizeTel(p.mobile || '');
  if (mobile) address.MobilePhoneNumber = mobile;

  const payload = {
    Shipment: {
      ShipmentReference: [reference],
      Product: 'PARCEL',
      Consignee: { Address: address },
      Shipper: { ContactID: GLS_CONTACT_ID },
      ShipmentUnit: weights.map((w) => ({ Weight: String(w) })),
      Service: [{ PickAndReturn: { ServiceName: 'service_pickandreturn', PickupDate: pickupDate } }],
    },
    PrintingOptions: { ReturnLabels: { TemplateSet: 'NONE', LabelFormat: 'PDF' } },
  };

  if (body.dryRun) {
    return new Response(JSON.stringify({ ok: true, dryRun: true, payload }), { headers: JSON_HEADERS });
  }

  const resp = await fetch(GLS_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(`${GLS_USER}:${GLS_PASSWORD}`),
      'Content-Type': 'application/glsVersion1+json',
      'Accept': 'application/glsVersion1+json, application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 800) }; }

  if (!resp.ok) {
    return new Response(JSON.stringify({ ok: false, error: 'GLS API error', status: resp.status, gls_response: data, payload_envoye: payload }), { status: 502, headers: JSON_HEADERS });
  }

  const created = data?.CreatedShipment || {};
  const trackIds = (created.ParcelData || []).map((x: any) => x?.TrackID || null).filter(Boolean);
  return new Response(JSON.stringify({
    ok: true,
    trackIds,
    pickupLocation: created.PickupLocation || null,
    pickupDate,
    gls_response: created,
  }), { headers: JSON_HEADERS });
});
