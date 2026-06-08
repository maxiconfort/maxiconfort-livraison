// ════════════════════════════════════════════════════════════════════
// Edge Function : gls-create-shipment (v5 — 08/06/2026)
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
// v5 (08/06/2026) — MULTI-COLIS pour sommiers :
//   Les sommiers se demontent en 2 demi-sommiers pour le transport routier.
//   Detection auto sur cmd.produit -> genere plusieurs ShipmentUnit
//   selon la table MULTICOLIS_RULES (sommier 140 = 2x7kg, 160 = 2x8kg, etc.)
//
// Retourne :
//   { ok: true, trackId, parcelNumber, parcels: [...], pdfBase64Full, ... }
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

// ── MULTI-COLIS : table des regles d'expedition par produit
// Les sommiers > 120 se demontent en 2 demi-sommiers pour le transport GLS.
// Format : { match: regex sur cmd.produit, nbColis, poidsParColis (kg) }
// Premier match gagne. Order from biggest to smallest.
const MULTICOLIS_RULES: { label: string; match: RegExp; nbColis: number; poidsParColis: number }[] = [
  { label: 'Sommier 180x200 (2x 90x200)',  match: /sommier[\s\S]*?180\s*[xX×]\s*200/i, nbColis: 2, poidsParColis: 9 },
  { label: 'Sommier 160x200 (2x 80x200)',  match: /sommier[\s\S]*?160\s*[xX×]\s*200/i, nbColis: 2, poidsParColis: 8 },
  { label: 'Sommier 140x200 (2x 70x200)',  match: /sommier[\s\S]*?140\s*[xX×]\s*200/i, nbColis: 2, poidsParColis: 7 },
  { label: 'Sommier 140x190 (2x 70x190)',  match: /sommier[\s\S]*?140\s*[xX×]\s*190/i, nbColis: 2, poidsParColis: 7 },
  { label: 'Sommier 120x190 (1 colis)',    match: /sommier[\s\S]*?120\s*[xX×]\s*190/i, nbColis: 1, poidsParColis: 10 },
  { label: 'Sommier 90x190 (1 colis)',     match: /sommier[\s\S]*?90\s*[xX×]\s*(190|200)/i, nbColis: 1, poidsParColis: 7 },
  // Ensembles literie (matelas + sommier) : on garde 1 colis par defaut + sommier multi-colis si applique
  // -> traite via une regle supplementaire si besoin
];

// Detecte la regle multi-colis applicable, ou retourne null
function detectMultiColis(produit: string): { label: string; nbColis: number; poidsParColis: number } | null {
  if (!produit) return null;
  for (const rule of MULTICOLIS_RULES) {
    if (rule.match.test(produit)) {
      return { label: rule.label, nbColis: rule.nbColis, poidsParColis: rule.poidsParColis };
    }
  }
  return null;
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
  // v5 : MULTI-COLIS — detecte si le produit (sommier) doit etre scinde en plusieurs colis
  const mc = detectMultiColis(cmd.produit || '');
  let shipmentUnits: any[];
  if (mc && mc.nbColis > 1) {
    shipmentUnits = [];
    for (let i = 1; i <= mc.nbColis; i++) {
      shipmentUnits.push({
        ShipmentUnitReference: [reference + '-' + i],
        Weight: mc.poidsParColis,
        Note1: ((cmd.produit || '').substring(0, 48) + ' (' + i + '/' + mc.nbColis + ')').substring(0, 60),
      });
    }
  } else {
    // 1 colis par defaut (matelas, lit, ensemble, etc.)
    const w = (mc && mc.nbColis === 1) ? mc.poidsParColis : weight;
    shipmentUnits = [{
      ShipmentUnitReference: [reference + '-1'],
      Weight: w,
      Note1: (cmd.produit || '').substring(0, 60),
    }];
  }

  const payload: any = {
    Shipment: {
      ShipmentReference: [reference],
      ShippingDate: today,
      Product: 'PARCEL',
      Consignee: consignee,
      Shipper: { ContactID: GLS_CONTACT_ID },
      ShipmentUnit: shipmentUnits,
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
  const parcelData = created.ParcelData || [];
  // v5 : retourne tous les colis (multi-colis sommiers)
  const allParcels = parcelData.map((p: any) => ({
    trackId: p?.TrackID || null,
    parcelNumber: p?.Barcodes?.Primary1D || null,
  }));
  const trackId = allParcels[0]?.trackId || null;
  const parcelNumber = allParcels[0]?.parcelNumber || null;
  // PrintData peut etre array {Data, LabelFormat} ou string base64 brut selon version GLS
  let pdfBase64: string | null = null;
  const printData = created.PrintData;
  if (typeof printData === 'string') {
    pdfBase64 = printData;
  } else if (Array.isArray(printData) && printData.length > 0) {
    pdfBase64 = printData[0]?.Data || null;
  }

  // Update commande Supabase avec le TrackID (si pas testMode)
  // v5 : concatene tous les trackIDs separes par virgule si multi-colis
  if (cmdId && trackId && !testMode) {
    try {
      const trackingValue = allParcels.map((p: any) => p.trackId).filter(Boolean).join(',');
      await sb.from('commandes').update({
        tracking_transporteur: trackingValue,
        transporteur: 'GLS',
      }).eq('id', cmdId);
    } catch (e: any) {
      console.warn('Update commande failed:', e.message);
    }
  }

  // v5 : multi-colis detection pour la reponse
  const mcInfo = cmd.produit ? detectMultiColis(cmd.produit) : null;

  return new Response(JSON.stringify({
    ok: true,
    trackId,            // premier track (pour retrocompat)
    parcelNumber,       // premier parcel number (pour retrocompat)
    parcels: allParcels, // tous les colis
    nbColis: allParcels.length,
    multiColisRule: mcInfo ? mcInfo.label : null,
    pdfBase64: pdfBase64 ? pdfBase64.substring(0, 50) + '...(tronque, longueur=' + pdfBase64.length + ')' : null,
    pdfBase64Full: pdfBase64, // Le PDF complet pour download/print cote client (toutes etiquettes incluses)
    gls_response: created,
    duration_ms: Date.now() - startTime,
  }), { headers: { 'Content-Type': 'application/json' } });
});
