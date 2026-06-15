// ════════════════════════════════════════════════════════════════════
// Edge Function : gls-create-shipment (v5.11 — 15/06/2026)
// ════════════════════════════════════════════════════════════════════
// v5.11 : colis calcules sur TOUTES les lignes (cmd.lignes) et non le seul
//         resume cmd.produit. Un "matelas + sommier" (2 lignes) etait compte
//         comme "matelas" seul (1 colis) -> sommier absent de l'etiquette GLS.
//         buildColis() parcourt chaque ligne x quantite. Note1 = produit du colis.
// v5.10 (12/06/2026) — GROSSE CORRECTION FIABILITE :
//   1. try/catch GLOBAL : avant, toute exception non attrapee produisait un
//      500 brut SANS headers CORS -> le navigateur affichait "CORS blocked"
//      au lieu du vrai message d'erreur.
//   2. Appel GLS en HTTP/1.0 BRUT (Deno.connectTls) : le serveur GLS renvoie
//      ses erreurs de validation dans des EN-TETES HTTP malformes que le
//      parseur strict de Deno rejette (h2 : "unspecific protocol error",
//      h1 : "invalid HTTP header parsed") -> fetch inutilisable.
//   3. Note1 max 50 caracteres (et non 60) + glsSafe() : translitteration
//      ASCII de tous les champs texte (accents, ×, em-dash) — cause reelle
//      du blocage de #1227 ("Value is too long. Maximum is 50").
//   4. Message d'erreur GLS extrait des en-tetes -> visible dans l'app.
//   ⚠️ AUCUN retry apres envoi (risque de doublon d'expedition facturable).
// v5.9 : stocke gls_date_etiquette (date creation label) pour le rapport journalier
// v5.8 : auto-SMS expedition cote SERVER (plus de dependance front cache)
// v5.7 : sommier/ensemble 120x190 = 2 demi-sommiers 5kg
// v5.6 : correction regles 180x200
// v5.5 : tel client sur etiquette (Note2)
// v5.4 : stockage PDF + action getLabel
// v5.3 : merge PDFs multi-colis
// v5.2 : fix CORS preflight
// v5.1 : multi-colis matelas/lits/ensembles
// v5   : multi-colis sommiers
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
import { PDFDocument } from 'https://esm.sh/pdf-lib@1.17.1';

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

// ── v5.10 : champ texte sur pour GLS — translittere en ASCII pur
// (le backend GLS est en Latin-1 : l'UTF-8 donne des � sur l'etiquette et
// fausse le comptage de longueur ; em-dash etc. cassent leurs en-tetes d'erreur)
function glsSafe(s: string, max: number): string {
  if (!s) return '';
  let t = String(s).normalize("NFD").replace(/[̀-ͯ]/g, ''); // accents -> lettre nue
  t = t.replace(/×/g, 'x').replace(/[—–]/g, '-').replace(/’/g, "'").replace(/[«»“”]/g, '"');
  t = t.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.substring(0, max);
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
// Format : { label, match: regex sur cmd.produit, colis: [poids_kg, poids_kg, ...] }
// Premier match gagne. Ordre IMPORTANT (du plus specifique au plus generique).
// v5.1 (08/06) : refactor en array de poids pour gerer les colis de poids differents
// (ex : Lit Coffre = [tete 6kg, longueur 15kg, longueur 15kg])
const MULTICOLIS_RULES: { label: string; match: RegExp; colis: number[] }[] = [
  // ─── ENSEMBLES / PACKS LITERIE (matelas + sommier scinde) ───
  // Ordre : avant matelas/sommier pour matcher en premier
  { label: 'Ensemble/Pack 180x200 (mat. + sommier 1 colis)', match: /(ensemble|pack)[\s\S]*?180\s*[xX×]\s*200/i, colis: [15, 15] },
  { label: 'Ensemble/Pack 160x200 (mat. + 2 demi-som.)', match: /(ensemble|pack)[\s\S]*?160\s*[xX×]\s*200/i, colis: [15, 8, 8] },
  { label: 'Ensemble/Pack 140x200 (mat. + 2 demi-som.)', match: /(ensemble|pack)[\s\S]*?140\s*[xX×]\s*200/i, colis: [15, 7, 7] },
  { label: 'Ensemble/Pack 140x190 (mat. + 2 demi-som.)', match: /(ensemble|pack)[\s\S]*?140\s*[xX×]\s*190/i, colis: [15, 7, 7] },
  { label: 'Ensemble/Pack 120x190 (mat. + 2 demi-som.)',  match: /(ensemble|pack)[\s\S]*?120\s*[xX×]\s*190/i, colis: [15, 5, 5] },
  { label: 'Ensemble/Pack 90 (mat. + sommier)',          match: /(ensemble|pack)[\s\S]*?90\s*[xX×]\s*(190|200)/i, colis: [7, 7] },

  // ─── LITS ───
  // Lit Coffre : 3 colis (tete 6kg + 2 longueurs 15kg chacune)
  { label: 'Lit Coffre (tete + 2 longueurs)', match: /lit\s*coffre/i, colis: [6, 15, 15] },
  // Lit NICO : 2 colis (tete 6kg + 1 longueur 15kg)
  { label: 'Lit NICO (tete + 1 longueur)',    match: /lit\s*nico/i, colis: [6, 15] },

  // ─── SOMMIERS SEULS (sans matelas) ───
  // Les sommiers > 120 se demontent en 2 demi-sommiers pour le transport GLS
  { label: 'Sommier 180x200 (1 colis, 15kg)', match: /sommier[\s\S]*?180\s*[xX×]\s*200/i, colis: [15] },
  { label: 'Sommier 160x200 (2x 80x200, 8kg)', match: /sommier[\s\S]*?160\s*[xX×]\s*200/i, colis: [8, 8] },
  { label: 'Sommier 140x200 (2x 70x200, 7kg)', match: /sommier[\s\S]*?140\s*[xX×]\s*200/i, colis: [7, 7] },
  { label: 'Sommier 140x190 (2x 70x190, 7kg)', match: /sommier[\s\S]*?140\s*[xX×]\s*190/i, colis: [7, 7] },
  { label: 'Sommier 120x190 (2x 60x190, 5kg)',  match: /sommier[\s\S]*?120\s*[xX×]\s*190/i, colis: [5, 5] },
  { label: 'Sommier 90 (1 colis, 7kg)',        match: /sommier[\s\S]*?90\s*[xX×]\s*(190|200)/i, colis: [7] },

  // ─── MATELAS SEULS ───
  // Matelas 90x190 / 90x200 = meme poids que sommier 90 (7kg)
  { label: 'Matelas 90 (1 colis, 7kg)',        match: /matelas[\s\S]*?90\s*[xX×]\s*(190|200)/i, colis: [7] },
  // Tous les autres matelas = 15kg defaut
  { label: 'Matelas standard (1 colis, 15kg)', match: /matelas/i, colis: [15] },
];

// Detecte la regle multi-colis applicable, ou retourne null
function detectMultiColis(produit: string): { label: string; colis: number[] } | null {
  if (!produit) return null;
  for (const rule of MULTICOLIS_RULES) {
    if (rule.match.test(produit)) {
      return { label: rule.label, colis: rule.colis };
    }
  }
  return null;
}

// v5.11 : calcule TOUS les colis a partir des LIGNES de la commande (cmd.lignes),
// chaque ligne x sa quantite. Avant, on ne lisait que le resume cmd.produit qui
// n'affiche que le 1er article (ex "Matelas ... (+1 autre)") -> le sommier (ligne 2)
// etait IGNORE et l'etiquette GLS sous-comptait les colis. Repli sur cmd.produit
// si la commande n'a pas de lignes exploitables (anciennes commandes / saisie manuelle).
function buildColis(cmd: any): { poids: number; nom: string }[] {
  const out: { poids: number; nom: string }[] = [];
  const lignes = Array.isArray(cmd.lignes) ? cmd.lignes : [];
  for (const l of lignes) {
    const nom = (l?.produit || l?.nom || '').toString().trim();
    if (!nom) continue;
    const qte = Math.max(1, Math.round(Number(l?.qte) || 1));
    const mc = detectMultiColis(nom);
    const colisUnit = (mc && mc.colis.length > 0) ? mc.colis : [15]; // defaut 15kg/article
    for (let q = 0; q < qte; q++) {
      for (const poids of colisUnit) out.push({ poids, nom });
    }
  }
  // Repli : aucune ligne exploitable -> ancien comportement base sur cmd.produit
  if (out.length === 0) {
    const mc = detectMultiColis(cmd.produit || '');
    const weight = parseFloat(cmd.poids || '') || 25.0;
    const colis = (mc && mc.colis.length > 0) ? mc.colis : [weight];
    for (const poids of colis) out.push({ poids, nom: (cmd.produit || '').toString() });
  }
  return out;
}

// ── Construit le payload Shipment GLS depuis une commande Supabase
function buildShipmentPayload(cmd: any, testMode: boolean): any {
  const parsed = parseAdresseFR(cmd.adresse || '');
  const tel = normalizeTel(cmd.tel || '');
  const today = new Date().toISOString().split('T')[0];
  // v2 : Reference avec fallback testMode pour eviter strings vides
  const cmdRef = (cmd.id || '').replace(/^#/, 'CMD-');
  const reference = cmdRef || (testMode ? 'TEST-' + Date.now().toString().slice(-8) : 'CMD-AUTO');
  // Nom client : split en Name1 (nom) + Name2 (prenom/complement)
  const clientName = (cmd.client || 'Client').trim();
  // v5.10 : glsSafe partout (translitteration ASCII + longueurs sures)
  const consignee: any = {
    Address: {
      Name1: glsSafe(clientName, 40) || 'Client',
      CountryCode: 'FR',
      ZIPCode: parsed.zipCode || '75001',
      City: glsSafe(parsed.city || 'Paris', 40) || 'Paris',
      Street: glsSafe(parsed.street || 'Rue', 40) || 'Rue',
      StreetNumber: glsSafe(parsed.streetNumber, 10),
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
  // v5.5 : Note2 = tel client (pour qu'il apparaisse imprime sur l'etiquette)
  // GLS imprime Note1 et Note2 dans la zone Contact du label PDF
  // On formate le tel proprement (06 79 90 57 03 plutot que 0033...)
  function formatTelDisplay(t: string): string {
    if (!t) return '';
    const clean = t.replace(/[^0-9]/g, '');
    let local = clean;
    if (clean.startsWith('0033')) local = '0' + clean.substring(4);
    else if (clean.startsWith('33') && clean.length === 11) local = '0' + clean.substring(2);
    // 0679905703 -> 06 79 90 57 03
    return local.replace(/(\d{2})(?=\d)/g, '$1 ').trim();
  }
  const telDisplay = formatTelDisplay(cmd.tel || '');
  // v5.10 : limite GLS = 50 caracteres par Note (constate le 12/06 : 60 -> erreur INVALID_FIELD_VALUE)
  const note2 = telDisplay ? glsSafe('Tel: ' + telDisplay, 50) : '';

  // v5.11 : MULTI-COLIS calcule sur TOUTES les lignes (matelas + sommier + ...),
  // chaque ligne x quantite. Note1 = nom reel du produit de CE colis.
  const colisAll = buildColis(cmd);
  const nbColisTotal = colisAll.length;
  const shipmentUnits: any[] = colisAll.map((c, idx) => ({
    ShipmentUnitReference: [reference + '-' + (idx + 1)],
    Weight: c.poids,
    // max GLS = 50 (nom 40 + ' (xx/yy)' <= 50)
    Note1: glsSafe(c.nom, 40) + ' (' + (idx + 1) + '/' + nbColisTotal + ')',
    Note2: note2,
  }));

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
// v5.10 (12/06/2026) : requete HTTP/1.0 BRUTE via Deno.connectTls.
// Pourquoi : le serveur GLS (AWS, wbm-fr02) s'est mis a (1) couper les
// connexions HTTP/2 ("http2 error: unspecific protocol error") et (2) renvoyer
// des en-tetes HTTP malformes que le parseur strict de Deno rejette
// ("invalid HTTP header parsed") — fetch est donc inutilisable. curl tolere.
// On ecrit la requete a la main et on parse la reponse de maniere TOLERANTE
// (on ne lit que la ligne de statut + le body, les en-tetes pourris sont ignores).
// ⚠️ AUCUN retry apres envoi de la requete : si GLS a deja cree l'expedition,
// un retry creerait un DOUBLON (etiquette fantome facturable).
const GLS_HOST = 'wbm-fr02.shipit.gls-group.com';
const GLS_PATH = '/backend/rs/shipments';

function dechunkBody(body: string): string {
  // Decode un body en Transfer-Encoding: chunked (taille hex CRLF data CRLF ...)
  let out = '';
  let rest = body;
  while (rest.length > 0) {
    const nl = rest.indexOf('\r\n');
    if (nl < 0) break;
    const size = parseInt(rest.substring(0, nl).trim(), 16);
    if (!size || isNaN(size)) break;
    out += rest.substr(nl + 2, size);
    rest = rest.substring(nl + 2 + size + 2);
  }
  return out || body;
}

async function glsRawRequest(bodyStr: string, basic: string, timeoutMs = 60000): Promise<{ status: number; text: string; errHeader?: string | null }> {
  const conn = await Deno.connectTls({ hostname: GLS_HOST, port: 443 });
  const enc = new TextEncoder();
  const bodyBytes = enc.encode(bodyStr);
  const timeout = setTimeout(() => { try { conn.close(); } catch (_e) {} }, timeoutMs);
  try {
    const head =
      'POST ' + GLS_PATH + ' HTTP/1.0\r\n' +
      'Host: ' + GLS_HOST + '\r\n' +
      'Authorization: Basic ' + basic + '\r\n' +
      'Content-Type: application/glsVersion1+json\r\n' +
      'Accept: application/glsVersion1+json, application/json\r\n' +
      'Content-Length: ' + bodyBytes.length + '\r\n' +
      'Connection: close\r\n\r\n';
    await conn.write(enc.encode(head));
    await conn.write(bodyBytes);
    // Lire TOUTE la reponse jusqu'a fermeture de la connexion
    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(65536);
    while (true) {
      let n: number | null = null;
      try { n = await conn.read(buf); } catch (_e) { break; }
      if (n === null) break;
      chunks.push(buf.slice(0, n));
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    const all = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }
    const raw = new TextDecoder().decode(all);
    // debug v5.10 : trace de la reponse brute (statut + en-tetes) dans les logs
    console.warn('GLS raw response (' + total + ' octets):', raw.substring(0, 600).replace(/\r\n/g, ' | '));
    const sep = raw.indexOf('\r\n\r\n');
    const headers = sep >= 0 ? raw.substring(0, sep) : raw;
    let body = sep >= 0 ? raw.substring(sep + 4) : '';
    const statusMatch = headers.match(/^HTTP\/[\d.]+\s+(\d{3})/);
    const status = statusMatch ? parseInt(statusMatch[1]) : 0;
    if (/transfer-encoding:\s*chunked/i.test(headers)) body = dechunkBody(body);
    // GLS met ses messages d'erreur de validation dans des EN-TETES (message:/error:/args:)
    const msgMatch = headers.match(/\r\nmessage:\s*([^\r\n]+)/i);
    const errMatch = headers.match(/\r\nerror:\s*([^\r\n]+)/i);
    const errHeader = [errMatch?.[1], msgMatch?.[1]].filter(Boolean).join(' — ') || null;
    return { status, text: body, errHeader };
  } finally {
    clearTimeout(timeout);
    try { conn.close(); } catch (_e) { /* deja fermee */ }
  }
}

async function createShipment(payload: any): Promise<any> {
  if (!GLS_USER || !GLS_PASSWORD) {
    throw new Error('GLS_SHIPIT_USER ou GLS_SHIPIT_PASSWORD manquant dans les secrets Supabase');
  }
  const basic = btoa(`${GLS_USER}:${GLS_PASSWORD}`);
  let resp: { status: number; text: string };
  try {
    resp = await glsRawRequest(JSON.stringify(payload), basic);
  } catch (e: any) {
    throw new Error('Appel API GLS impossible (' + (e?.message || e) + ')');
  }
  if (!resp.status) {
    throw new Error('Reponse GLS illisible ou vide (connexion interrompue) — verifier dans YourGLS si l\'expedition a quand meme ete creee avant de re-essayer');
  }
  let data: any = null;
  try { data = JSON.parse(resp.text); } catch { data = { raw: resp.text.substring(0, 1000) }; }
  // Si GLS a repondu une erreur via ses en-tetes, la rendre visible dans la reponse
  if ((resp as any).errHeader && data && typeof data === 'object' && !data.message) {
    data.message = (resp as any).errHeader;
  }
  return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, data };
}

// v5.2 : Headers CORS (sinon le navigateur bloque le preflight OPTIONS)
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Max-Age': '86400',
};
const JSON_HEADERS = { 'Content-Type': 'application/json', ...CORS_HEADERS };

Deno.serve(async (req: Request) => {
  // v5.2 : CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  // v5.10 : try/catch GLOBAL — toute exception renvoie un JSON + CORS
  // (sinon le runtime repond 500 sans CORS et le front ne voit qu'une erreur CORS)
  try {
    return await handleRequest(req);
  } catch (e: any) {
    console.error('gls-create-shipment exception non attrapee:', e?.message || e, e?.stack || '');
    return new Response(JSON.stringify({
      ok: false,
      error: 'Erreur interne: ' + (e?.message || String(e)),
    }), { status: 500, headers: JSON_HEADERS });
  }
});

async function handleRequest(req: Request): Promise<Response> {
  const startTime = Date.now();
  let body: any = {};
  if (req.method === 'POST') { try { body = await req.json(); } catch {} }
  const dryRun: boolean = !!body.dryRun;
  const testMode: boolean = !!body.testMode;
  const cmdId: string | null = body.cmdId || null;
  const action: string = body.action || 'create';

  // v5.4 : action=getLabel — recupere le PDF stocke en BD (pour reimpression)
  if (action === 'getLabel') {
    if (!cmdId) {
      return new Response(JSON.stringify({ ok: false, error: 'cmdId requis pour getLabel' }), { status: 400, headers: JSON_HEADERS });
    }
    try {
      const { data, error } = await sb.from('commandes')
        .select('id, tracking_transporteur, gls_pdf_base64, produit')
        .eq('id', cmdId)
        .single();
      if (error || !data) {
        return new Response(JSON.stringify({ ok: false, error: 'Commande introuvable' }), { status: 404, headers: JSON_HEADERS });
      }
      if (!data.gls_pdf_base64) {
        return new Response(JSON.stringify({ ok: false, error: 'Aucune etiquette stockee pour cette commande. Cree-la d\'abord.' }), { status: 404, headers: JSON_HEADERS });
      }
      return new Response(JSON.stringify({
        ok: true,
        trackId: (data.tracking_transporteur || '').split(',')[0] || null,
        tracking_transporteur: data.tracking_transporteur,
        pdfBase64Full: data.gls_pdf_base64,
        produit: data.produit,
        cached: true,
      }), { headers: JSON_HEADERS });
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: JSON_HEADERS });
    }
  }

  if (!cmdId && !testMode) {
    return new Response(JSON.stringify({ ok: false, error: 'cmdId requis (ou testMode:true)' }), { status: 400, headers: JSON_HEADERS });
  }

  // Recup commande Supabase (sauf si testMode pur)
  let cmd: any = {};
  if (cmdId) {
    const { data, error } = await sb.from('commandes').select('*').eq('id', cmdId).single();
    if (error || !data) {
      return new Response(JSON.stringify({ ok: false, error: 'Commande non trouvee: ' + (error?.message || cmdId) }), { status: 404, headers: JSON_HEADERS });
    }
    cmd = data;
  }

  const payload = buildShipmentPayload(cmd, testMode);

  if (dryRun) {
    return new Response(JSON.stringify({ ok: true, dryRun: true, payload, duration_ms: Date.now() - startTime }), { headers: JSON_HEADERS });
  }

  const result = await createShipment(payload);

  if (!result.ok) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'GLS API error',
      status: result.status,
      gls_response: result.data,
      payload_envoye: payload,
    }), { status: 502, headers: JSON_HEADERS });
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
  // v5.3 : GLS retourne PrintData = array (1 entree par colis quand multi-colis).
  // On extrait tous les PDF base64 et on les MERGE en 1 seul PDF multi-pages.
  let pdfBase64: string | null = null;
  const printData = created.PrintData;
  const pdfsBase64: string[] = [];
  if (typeof printData === 'string') {
    pdfsBase64.push(printData);
  } else if (Array.isArray(printData)) {
    for (const pd of printData) {
      if (pd?.Data) pdfsBase64.push(pd.Data);
    }
  }
  if (pdfsBase64.length === 1) {
    pdfBase64 = pdfsBase64[0];
  } else if (pdfsBase64.length > 1) {
    // Merge des N PDFs en 1 multi-pages
    try {
      const merged = await PDFDocument.create();
      for (const b64 of pdfsBase64) {
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const pdf = await PDFDocument.load(bytes);
        const pages = await merged.copyPages(pdf, pdf.getPageIndices());
        pages.forEach((p: any) => merged.addPage(p));
      }
      const mergedBytes = await merged.save();
      // bytes -> base64 (chunked pour eviter call-stack overflow sur gros PDFs)
      let bin = '';
      const chunk = 0x8000;
      for (let i = 0; i < mergedBytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, Array.from(mergedBytes.subarray(i, i + chunk)));
      }
      pdfBase64 = btoa(bin);
    } catch (e: any) {
      console.warn('PDF merge failed, fallback to first PDF:', e.message);
      pdfBase64 = pdfsBase64[0];
    }
  }

  // Update commande Supabase avec le TrackID (si pas testMode)
  // v5 : concatene tous les trackIDs separes par virgule si multi-colis
  let smsSent: any = null;
  if (cmdId && trackId && !testMode) {
    try {
      const trackingValue = allParcels.map((p: any) => p.trackId).filter(Boolean).join(',');
      // v5.4 : stocke aussi le PDF base64 (pour reimpression depuis l'app)
      await sb.from('commandes').update({
        tracking_transporteur: trackingValue,
        transporteur: 'GLS',
        gls_pdf_base64: pdfBase64,
        // v5.9 : date de creation de l'etiquette (heure Paris) pour le rapport journalier
        gls_date_etiquette: new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' }),
      }).eq('id', cmdId);

      // v5.8 : envoi SMS expedition cote server (independant du cache navigateur)
      // Plus robuste que l'appel front, qui dependait que le HTML ait bien v7.5.35.
      try {
        const smsResp = await fetch(`${SB_URL}/functions/v1/send-cmd-sms`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${SB_SR_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ cmdId, type: 'expedition' }),
        });
        const smsData = await smsResp.json().catch(() => ({}));
        smsSent = smsData;
      } catch (e: any) {
        console.warn('Auto-SMS expedition failed:', e.message);
        smsSent = { error: e.message };
      }
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
    smsSent,                  // v5.8 : retour de l'envoi auto SMS expedition
    duration_ms: Date.now() - startTime,
  }), { headers: JSON_HEADERS });
}
